#!/usr/bin/env node
/**
 * Two production defects in the Guard app (25 October 2026), executed against the real code.
 *
 * 1. PUSH REGISTRATION LOOP. Fetching the device push token makes expo-notifications report that same token to every
 *    push token listener (Android PushTokenModule: resolve, then onNewToken; iOS didRegister: resolve, then sendEvent).
 *    The app re-registered on every report, and each registration fetched the token again: one Android phone sent
 *    POST /push-devices about four times a second while S4 was open. Here expo-notifications is replaced by a fake
 *    that behaves exactly that way (the echo is emitted on EVERY device-token fetch, after or before the fetch
 *    resolves), and the REAL pushNotifications.ts runs, both on its own and inside the REAL App.
 *
 * 2. "ACCEPTING…" THAT NEVER ENDS. After the server accepted the offer the screen awaited a full dashboard re-read
 *    before clearing the button and confirming. Here the REAL App and GuardDashboardScreen are rendered on
 *    react-native-web through react-test-renderer, with the API replaced, and the re-read made to fail or hang.
 *
 *   PUSH-01  the echo of S4's own fetch never registers again (Android and iOS, echo after or before the fetch resolves)
 *   PUSH-02  concurrent registrations share one request
 *   PUSH-03  a genuinely rotated token registers exactly once, without fetching again; the same token again sends nothing
 *   PUSH-04  a failed registration says 'unavailable', is not retried in a loop, and a later call registers
 *   PUSH-05  sign-out unregisters the registered token; the next sign-in (another Guard) registers again
 *   PUSH-06  a token the server revoked is registered again normally on the next app start
 *   PUSH-07  a registration still running at sign-out records nothing for the next Guard
 *   PUSH-08  the real App: start-up, re-renders, tab navigation and AppState background/active cycles send one POST
 *   PUSH-09  the real App: sign-out unregisters, and signing in as another Guard registers once more
 *   ACCEPT-01  accept succeeds but the re-read hangs: the button leaves "Accepting…" and the success is shown
 *   ACCEPT-02  accept succeeds but the re-read fails: success shown, then the "saved, could not refresh" note
 *   ACCEPT-03  accept fails while the re-read hangs: busy cleared and an actionable error shown
 *   ACCEPT-04  expired and withdrawn answers are still shown as before, without waiting on the re-read
 */
const Module = require('node:module');
const originalLoad = Module._load;
const RNW = require('react-native-web');
const React = require('react');

// ── react-native: react-native-web, a native Platform, a controllable AppState, and a Modal that renders children ──
const appStateListeners = new Set();
const FakeAppState = {
  currentState: 'active',
  addEventListener: (_event, fn) => { appStateListeners.add(fn); return { remove: () => appStateListeners.delete(fn) }; },
};
function TestModal({ visible, children }) {
  return visible ? React.createElement('test-modal', null, children) : null;
}
let platformOS = 'android';
// react-native-web's TextInput reaches for the DOM document, which the test renderer does not have.
const TestTextInput = (props) => React.createElement('test-text-input', props);
const RN_SHIM = new Proxy({ ...RNW, Modal: TestModal, TextInput: TestTextInput, AppState: FakeAppState, Alert: { alert: () => undefined } }, {
  get(target, key) {
    if (key === 'Platform') return { ...RNW.Platform, OS: platformOS, select: (o) => (platformOS in o ? o[platformOS] : o.default) };
    return target[key];
  },
});
Module._load = function (request, ...rest) {
  if (request === 'react-native') return RN_SHIM;
  return originalLoad.call(this, request, ...rest);
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const TestRenderer = require('react-test-renderer');
const { ROOT } = require('./load-ts.cjs');

const { act } = TestRenderer;
const h = React.createElement;
const noop = () => undefined;
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(rounds = 60) { for (let i = 0; i < rounds; i += 1) await tick(); }

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

// ── expo-notifications, behaving like the native module ──────────────────────────────────────────────────────────
function fakeNotifications() {
  const listeners = new Set();
  const n = {
    deviceToken: 'device-1',
    echo: 'after', // when the self-report reaches the listeners: 'after' or 'before' the fetch resolves
    deviceFetches: 0,
    expoCalls: [],
    emit(data) { for (const fn of [...listeners]) fn({ type: platformOS, data }); },
    getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
    requestPermissionsAsync: async () => ({ granted: true }),
    async getDevicePushTokenAsync() {
      n.deviceFetches += 1;
      const token = { type: platformOS, data: n.deviceToken };
      // Native: the promise resolves and the token is sent to every listener as if it were new.
      if (n.echo === 'before') n.emit(token.data);
      else setImmediate(() => n.emit(token.data));
      return token;
    },
    async getExpoPushTokenAsync(options = {}) {
      n.expoCalls.push(options);
      // As in expo-notifications 0.32: without a devicePushToken it fetches one (and so echoes again).
      const device = options.devicePushToken || (await n.getDevicePushTokenAsync());
      return { type: 'expo', data: `ExponentPushToken[${device.data}]` };
    },
    addPushTokenListener: (fn) => { listeners.add(fn); return { remove: () => listeners.delete(fn) }; },
    listenerCount: () => listeners.size,
    setNotificationHandler: noop,
    setNotificationChannelAsync: async () => undefined,
    setNotificationCategoryAsync: async () => undefined,
    addNotificationResponseReceivedListener: () => ({ remove: noop }),
    addNotificationReceivedListener: () => ({ remove: noop }),
    getLastNotificationResponseAsync: async () => null,
    dismissNotificationAsync: async () => undefined,
    clearLastNotificationResponseAsync: async () => undefined,
    AndroidImportance: { MAX: 5, DEFAULT: 3 },
    AndroidNotificationVisibility: { PUBLIC: 1 },
  };
  return n;
}

// ── the API: every call recorded; the push and shift calls scripted per test ─────────────────────────────────────
function fakeApi(overrides = {}) {
  class ApiError extends Error {
    constructor(status, statusText, body) { super(statusText); this.status = status; this.body = body; }
  }
  class NetworkError extends Error { constructor(m) { super(m); this.name = 'NetworkError'; } }
  const calls = { pushDevices: [], unregister: [], respond: [], reads: 0 };
  const base = {
    ApiError,
    NetworkError,
    formatApiErrorMessage: (error, fallback) => (error instanceof NetworkError
      ? 'The live backend is unreachable right now. Check internet access and server health, then retry.'
      : (error && error.body && typeof error.body.message === 'string' ? error.body.message : fallback)),
    registerPushDevice: async (payload) => { calls.pushDevices.push(payload); return { registered: true }; },
    unregisterPushDevice: async (token) => { calls.unregister.push(token); return { unregistered: true }; },
    getMyGuard: async () => ({ fullName: 'Test Guard', phone: '', siaLicenseNumber: '' }),
    listMyShifts: async () => [],
    getMyEmployments: async () => [],
    getMyPayrollAdmin: async () => [],
    fetchCurrentUser: async () => null,
    getRefreshToken: () => 'r1',
    logout: async () => undefined,
    clearLocalSession: noop,
    restoreSession: noop,
    setRefreshPersister: noop,
    setUnauthorizedHandler: noop,
    ...overrides,
  };
  const api = new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== 'string' || key === '__esModule' || key === 'then') return undefined;
      // Lists are empty; any other read the dashboard makes (personnel details and the like) is simply not there.
      if (key.startsWith('list')) return async () => [];
      return async () => { throw new ApiError(404, 'Not Found', { message: 'Not found' }); };
    },
  });
  return { api, calls, ApiError, NetworkError };
}

/** Loads a source file with its relative imports, substituting the named repo modules and device packages. */
function loadWith(relativePath, { overrides = {}, notifications }) {
  const cache = new Map();
  const resolveRelative = (fromFile, request) => {
    const b = path.resolve(path.dirname(fromFile), request);
    for (const c of [b, `${b}.ts`, `${b}.tsx`, path.join(b, 'index.ts'), path.join(b, 'index.tsx')]) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
  };
  const load = (abs) => {
    const key = path.relative(ROOT, abs).replace(/\\/g, '/').replace(/\.tsx?$/, '');
    if (overrides[key]) return overrides[key];
    if (cache.has(abs)) return cache.get(abs).exports;
    const out = ts.transpileModule(fs.readFileSync(abs, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const mod = { exports: {} };
    cache.set(abs, mod);
    const req = (request) => {
      if (request.startsWith('.')) {
        const resolved = resolveRelative(abs, request);
        if (resolved) return load(resolved);
      }
      if (request === 'expo-notifications') return notifications;
      // Device modules the dashboard imports (document upload, location); never used by these tests.
      if (request === 'expo-document-picker') return { getDocumentAsync: async () => ({ canceled: true }) };
      if (request === 'expo-location') return { requestForegroundPermissionsAsync: async () => ({ granted: false }), getCurrentPositionAsync: async () => null };
      // Patrols (S4 1.2.0): the dashboard's patrol panel reaches the camera / SQLite / file-system / image / crypto
      // modules; never used by these tests (scripts/guard-patrols.spec.cjs executes the patrol code).
      if (['expo-camera', 'expo-sqlite', 'expo-file-system', 'expo-file-system/legacy', 'expo-image-manipulator', 'expo-crypto'].includes(request)) {
        const Unused = () => null;
        class StubPath { constructor(...parts) { this.uri = 'file:///stub/' + parts.map((p) => (typeof p === 'string' ? p : p.uri.slice(13))).join('/'); this.exists = false; } list() { return []; } }
        return { CameraView: Unused, useCameraPermissions: () => [null, async () => null], openDatabaseAsync: async () => ({ execAsync: async () => undefined, runAsync: async () => undefined, getAllAsync: async () => [] }), Directory: StubPath, File: StubPath, Paths: { document: new StubPath('document'), cache: new StubPath('cache') }, ImageManipulator: {}, SaveFormat: {}, CryptoDigestAlgorithm: {}, FileSystemSessionType: {}, FileSystemUploadType: {}, uploadAsync: async () => ({ status: 0 }), randomUUID: () => 'unused', digest: async () => new ArrayBuffer(0) };
      }
      if (request === 'expo-constants') return { __esModule: true, default: { expoConfig: { version: '1.2.0', extra: { eas: { projectId: 'project-1' } } } } };
      if (request === 'react-native-safe-area-context') {
        const Pass = ({ children }) => h(React.Fragment, null, children);
        return { SafeAreaProvider: Pass, SafeAreaView: Pass, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
      }
      return require(request);
    };
    new Function('module', 'exports', 'require', out)(mod, mod.exports, req);
    return mod.exports;
  };
  return load(path.join(ROOT, relativePath));
}

function loadPush(os = 'android', apiOverrides = {}) {
  platformOS = os;
  const notifications = fakeNotifications();
  const { api, calls, NetworkError } = fakeApi(apiOverrides);
  const push = loadWith('src/services/pushNotifications.ts', { notifications, overrides: { 'src/services/api': api } });
  return { push, notifications, calls, NetworkError };
}

/** App.tsx's wiring, exactly: register once, and register again when the token listener reports a token. */
function wireLikeApp(push) {
  const register = (rotated) => push.registerWelfarePush(rotated);
  void register();
  return push.subscribeTokenChanges((token) => { void register(token); });
}

// ═══════════════════ PUSH: the module ═══════════════════

for (const os of ['android', 'ios']) {
  for (const echo of ['after', 'before']) {
    test(`PUSH-01-THE-ECHO-OF-THE-OWN-FETCH-NEVER-REGISTERS-AGAIN (${os}, echo ${echo} the fetch resolves)`, async () => {
      const { push, notifications, calls } = loadPush(os);
      notifications.echo = echo;
      const unsubscribe = wireLikeApp(push);
      await settle(200);
      assert.equal(calls.pushDevices.length, 1, `exactly one POST /push-devices, got ${calls.pushDevices.length}`);
      assert.deepEqual(calls.pushDevices[0], { token: 'ExponentPushToken[device-1]', platform: os, appVersion: '1.2.0' });
      assert.equal(notifications.deviceFetches, 1, 'the device token is fetched once');
      assert.equal(notifications.expoCalls.length, 1);
      assert.deepEqual(notifications.expoCalls[0].devicePushToken, { type: os, data: 'device-1' }, 'the Expo token is made from the fetched device token, without a second fetch');
      assert.equal(notifications.expoCalls[0].projectId, 'project-1');
      unsubscribe();
      assert.equal(notifications.listenerCount(), 0);
    });
  }
}

test('PUSH-02-CONCURRENT-REGISTRATIONS-SHARE-ONE-REQUEST', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { push, notifications, calls } = loadPush('android', {
    registerPushDevice: async (payload) => { calls.pushDevices.push(payload); await gate; return { registered: true }; },
  });
  const all = Promise.all([push.registerWelfarePush(), push.registerWelfarePush(), push.registerWelfarePush()]);
  await settle();
  release();
  assert.deepEqual(await all, ['registered', 'registered', 'registered']);
  assert.equal(calls.pushDevices.length, 1, 'one POST for three callers');
  assert.equal(notifications.deviceFetches, 1);
  // Once it has finished, a new call is a new registration (a new session start).
  assert.equal(await push.registerWelfarePush(), 'registered');
  assert.equal(calls.pushDevices.length, 2);
});

test('PUSH-03-A-ROTATED-TOKEN-REGISTERS-EXACTLY-ONCE-AND-THE-SAME-TOKEN-AGAIN-NOTHING', async () => {
  const { push, notifications, calls } = loadPush('android');
  wireLikeApp(push);
  await settle();
  assert.equal(calls.pushDevices.length, 1);
  // FCM rotates the token: the operating system reports the new one.
  notifications.deviceToken = 'device-2';
  notifications.emit('device-2');
  await settle();
  assert.equal(calls.pushDevices.length, 2, 'the new token is registered once');
  assert.equal(calls.pushDevices[1].token, 'ExponentPushToken[device-2]');
  assert.equal(notifications.deviceFetches, 1, 'the reported token is used as is, not fetched again (no new echo)');
  notifications.emit('device-2');
  notifications.emit('device-2');
  await settle();
  assert.equal(calls.pushDevices.length, 2, 'the same token reported again sends nothing');
  // A rotation reported while a registration is still running is registered once that one finishes.
  let release;
  const slow = loadPush('android', {
    registerPushDevice: async (payload) => { slow.calls.pushDevices.push(payload); if (slow.calls.pushDevices.length === 1) await new Promise((r) => { release = r; }); return { registered: true }; },
  });
  wireLikeApp(slow.push);
  await settle();
  slow.notifications.emit('device-9');
  await settle();
  release();
  await settle();
  assert.deepEqual(slow.calls.pushDevices.map((p) => p.token), ['ExponentPushToken[device-1]', 'ExponentPushToken[device-9]']);
});

test('PUSH-04-A-FAILED-REGISTRATION-IS-UNAVAILABLE-NOT-A-LOOP-AND-A-LATER-CALL-REGISTERS', async () => {
  let online = false;
  let attempts = 0;
  const { push, notifications, calls, NetworkError } = loadPush('android', {
    registerPushDevice: async (payload) => {
      attempts += 1;
      if (!online) throw new NetworkError('Network request failed');
      calls.pushDevices.push(payload);
      return { registered: true };
    },
  });
  const states = [];
  push.subscribeTokenChanges((token) => { push.registerWelfarePush(token).then((s) => states.push(s)); });
  assert.equal(await push.registerWelfarePush(), 'unavailable', 'never throws; says unavailable');
  await settle(200);
  assert.equal(attempts, 1, 'the echo of the failed attempt does not retry it');
  assert.deepEqual(states, []);
  online = true;
  assert.equal(await push.registerWelfarePush(), 'registered', 'the next session start registers');
  await settle();
  assert.equal(calls.pushDevices.length, 1);
  assert.equal(notifications.deviceFetches, 2);
  // The Expo service failing is the same: unavailable, once.
  const expoDown = loadPush('ios');
  expoDown.notifications.getExpoPushTokenAsync = async () => { throw new Error('ERR_NOTIFICATIONS_NETWORK_ERROR'); };
  wireLikeApp(expoDown.push);
  await settle(200);
  assert.equal(expoDown.notifications.deviceFetches, 1);
  assert.equal(expoDown.calls.pushDevices.length, 0);
});

test('PUSH-05-SIGN-OUT-UNREGISTERS-AND-THE-NEXT-SIGN-IN-REGISTERS-AGAIN', async () => {
  const { push, notifications, calls } = loadPush('android');
  let unsubscribe = wireLikeApp(push);
  await settle();
  assert.equal(calls.pushDevices.length, 1);
  // Sign-out: App unsubscribes (the Guard effect is cleaned up) and unregisters while the session still works.
  await push.unregisterWelfarePush();
  unsubscribe();
  assert.deepEqual(calls.unregister, ['ExponentPushToken[device-1]'], 'the registered token is unregistered');
  await push.unregisterWelfarePush();
  assert.equal(calls.unregister.length, 1, 'nothing left to unregister');
  // Another Guard signs in on the same phone: same device token, registered for them.
  unsubscribe = wireLikeApp(push);
  await settle(200);
  assert.equal(calls.pushDevices.length, 2, 'the next Guard registers');
  assert.equal(notifications.deviceFetches, 2);
  unsubscribe();
});

test('PUSH-06-A-TOKEN-THE-SERVER-REVOKED-IS-REGISTERED-AGAIN-ON-THE-NEXT-START', async () => {
  // The server drops a token the push provider reports as unregistered; the phone is not told. The next app start is
  // a fresh process with the same device token, and registers it again as normal (an upsert on the server).
  const first = loadPush('android');
  wireLikeApp(first.push);
  await settle();
  const second = loadPush('android');
  wireLikeApp(second.push);
  await settle(200);
  assert.equal(second.calls.pushDevices.length, 1);
  assert.equal(second.calls.pushDevices[0].token, first.calls.pushDevices[0].token);
});

test('PUSH-07-A-REGISTRATION-RUNNING-AT-SIGN-OUT-RECORDS-NOTHING-FOR-THE-NEXT-GUARD', async () => {
  let release;
  const { push, calls } = loadPush('android', {
    registerPushDevice: async (payload) => { calls.pushDevices.push(payload); if (calls.pushDevices.length === 1) await new Promise((r) => { release = r; }); return { registered: true }; },
  });
  const firstGuard = push.registerWelfarePush();
  await settle();
  await push.unregisterWelfarePush();
  const nextGuard = push.registerWelfarePush();
  await settle();
  assert.equal(calls.pushDevices.length, 2, 'the next Guard does not share the previous Guard\'s registration');
  release();
  assert.equal(await firstGuard, 'registered');
  assert.equal(await nextGuard, 'registered');
  await push.unregisterWelfarePush();
  assert.deepEqual(calls.unregister, ['ExponentPushToken[device-1]'], 'only the next Guard\'s registration is unregistered at their sign-out');
});

// ═══════════════════ the real App and Guard dashboard ═══════════════════

const NOW = Date.now();
const offer = (id) => ({
  id,
  siteName: `Site ${id}`,
  start: new Date(NOW + 26 * 3_600_000).toISOString(),
  end: new Date(NOW + 38 * 3_600_000).toISOString(),
  status: 'offered',
  checkCallIntervalMinutes: 60,
  instructions: null,
  site: { timezone: 'Europe/London' },
});
const guardUser = (id) => ({ id, guardId: 100 + id, email: `guard${id}@example.invalid`, role: 'guard', fullName: `Guard ${id}` });

/**
 * Mounts the real App with a stored Guard session. The API, the session store and the sign-in screen are replaced;
 * the dashboard, App's push wiring and pushNotifications.ts are the real ones.
 */
async function mountApp({ apiOverrides = {}, os = 'android' } = {}) {
  platformOS = os;
  appStateListeners.clear();
  const notifications = fakeNotifications();
  // Start-up re-reads the signed-in user from the server (a fresh object for the same Guard), as App does.
  const fake = fakeApi({ fetchCurrentUser: async () => guardUser(7), ...apiOverrides });
  let signIn = null;
  const overrides = {
    'src/services/api': fake.api,
    'src/services/session': {
      loadStoredSession: async () => ({ user: guardUser(7), refreshToken: 'r1' }),
      persistSession: async () => undefined,
      clearStoredSession: async () => undefined,
    },
    'src/services/attendanceTransport': { installAttendanceLocationTransport: () => noop },
    'src/screens/AuthScreen': {
      AuthScreen: ({ onLoggedIn }) => { signIn = onLoggedIn; return h(RNW.Text, null, 'Sign in'); },
    },
    'src/screens/CompanyDashboardScreen': { CompanyDashboardScreen: () => null },
    'src/screens/AdminDashboardScreen': { AdminDashboardScreen: () => null },
    'src/screens/ClientPortalScreen': { ClientPortalScreen: () => null },
  };
  // pushNotifications is loaded once with the fake API and shared by App and the dashboard, as in the app.
  overrides['src/services/pushNotifications'] = loadWith('src/services/pushNotifications.ts', { notifications, overrides });
  const App = loadWith('App.tsx', { overrides, notifications }).default;
  let renderer;
  await quiet(async () => {
    await act(async () => { renderer = TestRenderer.create(h(App)); });
    await act(async () => { await settle(); });
  });
  const run = async (fn) => quiet(async () => { await act(async () => { await fn(); await settle(); }); });
  return { renderer, notifications, calls: fake.calls, ApiError: fake.ApiError, NetworkError: fake.NetworkError, run, signIn: () => signIn };
}

async function quiet(fn) {
  const original = console.error;
  console.error = (...args) => { if (!/act\(|not wrapped|unmounted component/.test(String(args[0]))) original(...args); };
  try { return await fn(); } finally { console.error = original; }
}

const isInside = (node, ancestor) => { for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true; return false; };
const outermost = (nodes) => nodes.filter((n) => !nodes.some((o) => o !== n && isInside(n, o)));
const pressables = (renderer, test) => outermost(renderer.root.findAll((n) => n.props && typeof n.props.onPress === 'function' && test(n.props)));
const byLabel = (renderer, label) => pressables(renderer, (p) => p.accessibilityLabel === label);
const byLabelStart = (renderer, prefix) => pressables(renderer, (p) => typeof p.accessibilityLabel === 'string' && p.accessibilityLabel.startsWith(prefix));
const texts = (renderer) => renderer.root.findAll((n) => typeof n.props?.children === 'string').map((n) => n.props.children);
const hasText = (renderer, text) => texts(renderer).some((t) => t === text);
const hasTextMatching = (renderer, re) => texts(renderer).some((t) => re.test(t));

test('PUSH-08-THE-REAL-APP-REGISTERS-ONCE-ACROSS-RENDERS-NAVIGATION-AND-APPSTATE-CYCLES', async () => {
  for (const os of ['android', 'ios']) {
    const { renderer, notifications, calls, run } = await mountApp({ os });
    assert.ok(byLabel(renderer, 'Home').length && byLabel(renderer, 'Offers').length, 'the Guard dashboard is showing');
    assert.equal(calls.pushDevices.length, 1, `${os}: start-up registers once`);
    // Navigation between tabs, background/foreground cycles, and the dashboard re-reading on return.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      for (const label of ['Jobs', 'History', 'Profile', 'Home']) {
        const [tab] = byLabel(renderer, label);
        if (tab) await run(() => tab.props.onPress());
      }
      await run(() => { FakeAppState.currentState = 'background'; for (const fn of [...appStateListeners]) fn('background'); });
      await run(() => { FakeAppState.currentState = 'active'; for (const fn of [...appStateListeners]) fn('active'); });
    }
    await settle(200);
    assert.ok(byLabel(renderer, 'Home').length && !hasText(renderer, 'Something went wrong'), 'still the Guard dashboard, never the error screen');
    assert.ok(appStateListeners.size > 0, 'AppState listeners were really driven');
    assert.equal(calls.pushDevices.length, 1, `${os}: no extra POST /push-devices, got ${calls.pushDevices.length}`);
    assert.equal(notifications.deviceFetches, 1);
    await run(() => renderer.unmount());
  }
});

test('PUSH-09-THE-REAL-APP-SIGN-OUT-UNREGISTERS-AND-ANOTHER-GUARD-REGISTERS', async () => {
  const { renderer, calls, run, signIn } = await mountApp();
  assert.equal(calls.pushDevices.length, 1);
  const logOut = pressables(renderer, (p) => p.accessibilityRole === 'button').find((n) => n.findAll((c) => c.props?.children === 'Log out').length);
  assert.ok(logOut, 'the Log out control');
  await run(() => logOut.props.onPress());
  assert.deepEqual(calls.unregister, ['ExponentPushToken[device-1]'], 'the phone is unregistered at sign-out');
  assert.ok(signIn(), 'the sign-in screen is showing');
  await run(() => signIn()({ accessToken: 'a2', refreshToken: 'r2', user: guardUser(8) }));
  await settle(200);
  assert.equal(calls.pushDevices.length, 2, 'the next Guard registers once');
  await run(() => renderer.unmount());
});

// ═══════════════════ ACCEPT ═══════════════════

/** Mounts the app with one open offer, opens it, and returns what is needed to press Accept. */
async function openOffer(apiOverrides) {
  let reads = 0;
  let firstRead = true;
  const control = { afterRespond: null };
  const app = await mountApp({
    apiOverrides: {
      listMyShifts: async () => {
        reads += 1;
        if (firstRead) { firstRead = false; return [offer(5)]; }
        return control.afterRespond ? control.afterRespond() : [];
      },
      ...apiOverrides,
    },
  });
  const [offersTab] = byLabelStart(app.renderer, 'Offers');
  await app.run(() => offersTab.props.onPress());
  const [review] = byLabelStart(app.renderer, 'Review offer for');
  assert.ok(review, 'the offer is listed');
  await app.run(() => review.props.onPress());
  return { ...app, control, reads: () => reads };
}

const acceptButton = (renderer) => byLabel(renderer, 'Accept this shift')[0];
const acceptingShown = (renderer) => hasText(renderer, 'Accepting…');

test('ACCEPT-01-THE-REFRESH-HANGS-THE-BUTTON-LEAVES-ACCEPTING-AND-SUCCESS-IS-SHOWN', async () => {
  let release;
  const responded = [];
  const app = await openOffer({ respondToShift: async (id, payload) => { responded.push([id, payload.response]); await new Promise((r) => { release = r; }); return {}; } });
  app.control.afterRespond = () => new Promise(() => undefined); // the re-read never answers
  await app.run(() => acceptButton(app.renderer).props.onPress());
  assert.ok(acceptingShown(app.renderer), 'Accepting… while the server is answering');
  // A second tap while in flight sends nothing.
  const again = acceptButton(app.renderer);
  if (again) await app.run(() => again.props.onPress());
  await app.run(() => release());
  assert.deepEqual(responded, [[5, 'accepted']], 'one response');
  assert.ok(!acceptingShown(app.renderer), 'the button no longer says Accepting…');
  assert.ok(hasText(app.renderer, 'Shift accepted'), 'the success title');
  assert.ok(hasText(app.renderer, 'Your shift is ready.'), 'the success message');
  assert.ok(app.reads() >= 2, 'the dashboard re-read was started (and is still hanging)');
  await app.run(() => app.renderer.unmount());
});

test('ACCEPT-02-THE-REFRESH-FAILS-SUCCESS-THEN-THE-SAVED-BUT-NOT-REFRESHED-NOTE', async () => {
  let failRead;
  const app = await openOffer({ respondToShift: async () => ({}) });
  app.control.afterRespond = () => new Promise((_, reject) => { failRead = () => reject(new Error('read failed')); });
  await app.run(() => acceptButton(app.renderer).props.onPress());
  assert.ok(!acceptingShown(app.renderer), 'not Accepting…');
  assert.ok(hasText(app.renderer, 'Your shift is ready.'), 'success shown before the re-read finishes');
  await app.run(() => failRead());
  assert.ok(hasText(app.renderer, 'Shift accepted'));
  assert.ok(hasText(app.renderer, 'Your shift is ready. Your response was saved, but the screen could not refresh. Pull down to refresh.'), 'the note');
  await app.run(() => app.renderer.unmount());
});

test('ACCEPT-03-A-FAILED-ACCEPT-CLEARS-BUSY-AND-SAYS-WHAT-TO-DO-EVEN-IF-THE-REFRESH-HANGS', async () => {
  for (const kind of ['network', 'server']) {
    let fail;
    const app = await openOffer({ respondToShift: () => new Promise((_, reject) => { fail = reject; }) });
    app.control.afterRespond = () => new Promise(() => undefined);
    await app.run(() => acceptButton(app.renderer).props.onPress());
    assert.ok(acceptingShown(app.renderer));
    await app.run(() => fail(kind === 'network' ? new app.NetworkError('Request timed out.') : new app.ApiError(503, 'Service Unavailable', { message: 'S4 is temporarily unavailable.' })));
    assert.ok(!acceptingShown(app.renderer), `${kind}: busy cleared without waiting on the re-read`);
    assert.ok(hasText(app.renderer, 'Accept failed'), `${kind}: the error title`);
    assert.ok(hasTextMatching(app.renderer, /Check your connection\. Your response may already have been saved: pull down on Offers or open Home to check before trying again, or contact your control room\./), `${kind}: what to do`);
    assert.ok(acceptButton(app.renderer) && acceptButton(app.renderer).props.disabled !== true, `${kind}: Accept can be pressed again`);
    await app.run(() => app.renderer.unmount());
  }
});

test('ACCEPT-04-EXPIRED-AND-WITHDRAWN-ANSWERS-UNCHANGED-AND-NOT-WAITING-ON-THE-REFRESH', async () => {
  const cases = [
    [{ status: 409, body: { code: 'SHIFT_OFFER_EXPIRED', message: 'x' } }, 'Offer expired'],
    [{ status: 409, body: { message: 'Shift is already ready' } }, 'Offer no longer available'],
    [{ status: 400, body: { message: 'Only offered shifts can be responded to' } }, 'Offer no longer available'],
  ];
  for (const [error, title] of cases) {
    const app = await mountWithFailingRespond(error);
    assert.ok(!acceptingShown(app.renderer), `${title}: busy cleared`);
    assert.ok(hasText(app.renderer, title), `${title}: shown`);
    assert.ok(!hasTextMatching(app.renderer, /may already have been saved/), `${title}: a definite answer is not called uncertain`);
    await app.run(() => app.renderer.unmount());
  }
});

async function mountWithFailingRespond(error) {
  let ApiErrorClass;
  const app = await openOffer({ respondToShift: async () => { throw new ApiErrorClass(error.status, 'Conflict', error.body); } });
  ApiErrorClass = app.ApiError;
  app.control.afterRespond = () => new Promise(() => undefined);
  await app.run(() => acceptButton(app.renderer).props.onPress());
  return app;
}

(async () => {
  for (const [name, fn] of pending) {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
