#!/usr/bin/env node
/**
 * S4-UX-01.1 and UX-01.2 — Adaptive Guard Home: the model, the responsive layout rules, the Guard-only header and the
 * persistent on-duty Emergency bar. Executed against the real code: the pure modules directly, the components and the
 * real App + GuardDashboardScreen on react-native-web through react-test-renderer, with the API replaced.
 *
 *   UX-T1   the model: a mode for every phase, upcoming shifts are accepted work only, and no priority ordering
 *   UX-T2   Book Off: the same label in every on-duty phase, the same handler and confirmation, never in the bar
 *   UX-T4   Emergency: outside the ScrollView, on every tab, opens the existing SOS form; absent when it cannot be raised
 *   UX-T6   the Guard header: one top bar, Log out signs out through App, Notifications unchanged, UAT label kept
 *   UX-T7   non-Guard surfaces keep App's top bar with Log out and the product label
 *   UX-T8   the layout matrix: 360x640, 375x667, 393x852, 430x932 at text scale 1.0, 1.3 and 2.0
 *   UX-T9   every header and bar control has a role, a label and a 44pt target (Emergency 48pt); nothing is clipped
 *   UX-T10  every file under src/components/guard/patrol is byte-identical to the verified build 22 release commit
 *
 * What this cannot prove: how a phone actually draws it. Rendered screenshots are a separate checkpoint.
 */
const Module = require('node:module');
const originalLoad = Module._load;
const RNW = require('react-native-web');
const React = require('react');

function TestModal({ visible, children }) {
  return visible ? React.createElement('test-modal', null, children) : null;
}
const TestTextInput = (props) => React.createElement('test-text-input', props);
const FakeAppState = { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) };
const RN_SHIM = { ...RNW, Modal: TestModal, TextInput: TestTextInput, AppState: FakeAppState, Alert: { alert: () => undefined } };
Module._load = function (request, ...rest) {
  if (request === 'react-native') return RN_SHIM;
  return originalLoad.call(this, request, ...rest);
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const TestRenderer = require('react-test-renderer');
const { loadTs, ROOT } = require('./load-ts.cjs');

const { act } = TestRenderer;
const h = React.createElement;
const noop = () => undefined;
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(rounds = 60) { for (let i = 0; i < rounds; i += 1) await tick(); }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const codeOf = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

const model = loadTs('src/components/guard/home/guardHomeModel.ts');
const layoutRules = loadTs('src/components/guard/home/guardHomeLayout.ts');
const SCREEN = 'src/screens/GuardDashboardScreen.tsx';

// ── module loading with replaced repo modules and device packages (as push-registration-and-accept.spec.cjs) ──
function loadWith(relativePath, { overrides = {}, appVariant } = {}) {
  const cache = new Map();
  const resolveRelative = (fromFile, request) => {
    const b = path.resolve(path.dirname(fromFile), request);
    for (const c of [b, `${b}.ts`, `${b}.tsx`, path.join(b, 'index.ts'), path.join(b, 'index.tsx')]) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
  };
  const notifications = {
    getPermissionsAsync: async () => ({ granted: false, canAskAgain: false }),
    requestPermissionsAsync: async () => ({ granted: false }),
    getDevicePushTokenAsync: async () => ({ type: 'android', data: 'device-1' }),
    getExpoPushTokenAsync: async () => ({ type: 'expo', data: 'ExponentPushToken[device-1]' }),
    addPushTokenListener: () => ({ remove: noop }),
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
      if (request === 'expo-document-picker') return { getDocumentAsync: async () => ({ canceled: true }) };
      if (request === 'expo-location') return { requestForegroundPermissionsAsync: async () => ({ granted: false }), getCurrentPositionAsync: async () => null };
      if (['expo-camera', 'expo-sqlite', 'expo-file-system', 'expo-file-system/legacy', 'expo-image-manipulator', 'expo-crypto'].includes(request)) {
        const Unused = () => null;
        class StubPath { constructor(...parts) { this.uri = 'file:///stub/' + parts.map((p) => (typeof p === 'string' ? p : p.uri.slice(13))).join('/'); this.exists = false; } list() { return []; } }
        return { CameraView: Unused, useCameraPermissions: () => [null, async () => null], openDatabaseAsync: async () => ({ execAsync: async () => undefined, runAsync: async () => undefined, getAllAsync: async () => [] }), Directory: StubPath, File: StubPath, Paths: { document: new StubPath('document'), cache: new StubPath('cache') }, ImageManipulator: {}, SaveFormat: {}, CryptoDigestAlgorithm: {}, FileSystemSessionType: {}, FileSystemUploadType: {}, uploadAsync: async () => ({ status: 0 }), randomUUID: () => 'unused', digest: async () => new ArrayBuffer(0) };
      }
      if (request === 'expo-constants') {
        return { __esModule: true, default: { expoConfig: { version: '1.2.1', extra: { eas: { projectId: 'project-1' }, ...(appVariant ? { appVariant } : {}) } } } };
      }
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

function fakeApi(overrides = {}) {
  class ApiError extends Error { constructor(status, statusText, body) { super(statusText); this.status = status; this.body = body; } }
  class NetworkError extends Error { constructor(m) { super(m); this.name = 'NetworkError'; } }
  const calls = { logout: 0, unregister: [], safetyAlerts: [] };
  const base = {
    ApiError,
    NetworkError,
    formatApiErrorMessage: (_e, fallback) => fallback,
    registerPushDevice: async () => ({ registered: true }),
    unregisterPushDevice: async (token) => { calls.unregister.push(token); return { unregistered: true }; },
    getMyGuard: async () => ({ fullName: 'Test Guard', phone: '', siaLicenseNumber: '' }),
    listMyShifts: async () => [],
    getMyEmployments: async () => [],
    getMyPayrollAdmin: async () => [],
    createSafetyAlert: async (payload) => { calls.safetyAlerts.push(payload); return { id: 1 }; },
    fetchCurrentUser: async () => null,
    getRefreshToken: () => 'r1',
    logout: async () => { calls.logout += 1; },
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
      if (key.startsWith('list')) return async () => [];
      return async () => { throw new ApiError(404, 'Not Found', { message: 'Not found' }); };
    },
  });
  return { api, calls };
}

const NOW = Date.now();
const liveShift = (id = 41) => ({
  id,
  siteName: 'Harbour Gate',
  start: new Date(NOW - 2 * 3_600_000).toISOString(),
  end: new Date(NOW + 6 * 3_600_000).toISOString(),
  status: 'in_progress',
  companyId: 3,
  checkCallIntervalMinutes: 60,
  instructions: null,
  site: { timezone: 'Europe/London' },
});
const userOf = (role, id = 7) => ({ id, guardId: 100 + id, email: `user${id}@example.invalid`, role, fullName: `User ${id}` });

async function quiet(fn) {
  const original = console.error;
  console.error = (...args) => { if (!/act\(|not wrapped|unmounted component/.test(String(args[0]))) original(...args); };
  try { return await fn(); } finally { console.error = original; }
}

async function mountApp({ role = 'guard', shifts = [], attendance = [], appVariant } = {}) {
  FakeAppState.currentState = 'active';
  const fake = fakeApi({
    fetchCurrentUser: async () => userOf(role),
    listMyShifts: async () => shifts,
    listMyAttendance: async () => attendance,
  });
  const overrides = {
    'src/services/api': fake.api,
    'src/services/session': {
      loadStoredSession: async () => ({ user: userOf(role), refreshToken: 'r1' }),
      persistSession: async () => undefined,
      clearStoredSession: async () => undefined,
    },
    'src/services/attendanceTransport': { installAttendanceLocationTransport: () => noop },
    'src/screens/AuthScreen': { AuthScreen: () => h(RNW.Text, null, 'Sign in') },
    'src/screens/CompanyDashboardScreen': { CompanyDashboardScreen: () => null },
    'src/screens/AdminDashboardScreen': { AdminDashboardScreen: () => null },
    'src/screens/ClientPortalScreen': { ClientPortalScreen: () => h(RNW.Text, null, 'Client portal') },
  };
  overrides['src/services/pushNotifications'] = loadWith('src/services/pushNotifications.ts', { overrides });
  const App = loadWith('App.tsx', { overrides, appVariant }).default;
  let renderer;
  await quiet(async () => {
    await act(async () => { renderer = TestRenderer.create(h(App)); });
    await act(async () => { await settle(); });
  });
  const run = async (fn) => quiet(async () => { await act(async () => { await fn(); await settle(); }); });
  return { renderer, calls: fake.calls, run };
}

const isInside = (node, ancestor) => { for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true; return false; };
const outermost = (nodes) => nodes.filter((n) => !nodes.some((o) => o !== n && isInside(n, o)));
const pressables = (root, pred) => outermost(root.findAll((n) => n.props && typeof n.props.onPress === 'function' && pred(n.props)));
const byLabel = (root, label) => pressables(root, (p) => p.accessibilityLabel === label);
const texts = (root) => root.findAll((n) => typeof n.props?.children === 'string').map((n) => n.props.children);
const byTestId = (root, id) => outermost(root.findAll((n) => n.props?.testID === id));
const scrollViews = (root) => root.findAll((n) => n.type === RNW.ScrollView);

// ═══════════════════ UX-T1 the model ═══════════════════

test('UX-T1-A-MODE-FOR-EVERY-PHASE-AND-NO-PRIORITY-ORDERING', () => {
  const all = ['no_shift', 'offer_pending', 'before_shift', 'shift_window_check_in', 'on_shift', 'welfare_due', 'welfare_overdue', 'shift_ending_soon', 'timesheet_pending', 'shift_ended'];
  assert.deepEqual([...model.ON_DUTY_PHASES, ...model.OFF_DUTY_PHASES].sort(), [...all].sort(), 'every phase is classified exactly once');
  for (const phase of all) {
    assert.equal(model.guardHomeMode(phase), ['on_shift', 'welfare_due', 'welfare_overdue', 'shift_ending_soon'].includes(phase) ? 'on_duty' : 'off_duty', phase);
  }
  // The screen's phase union and the model's stay identical.
  const screen = read(SCREEN);
  const union = screen.slice(screen.indexOf('type GuardShiftPhase'), screen.indexOf(';', screen.indexOf('type GuardShiftPhase')));
  for (const phase of all) assert.ok(union.includes(`'${phase}'`), `${phase} is a screen phase`);
  assert.equal((union.match(/'[a-z_]+'/g) || []).length, all.length, 'no phase the model does not know');
  // No ordering is invented between obligations.
  // Phase names are string literals ('welfare_due'); outside them the model must not mention either obligation.
  const src = codeOf('src/components/guard/home/guardHomeModel.ts').replace(/'[^'\n]*'/g, "''");
  assert.doesNotMatch(src, /priorit|patrol|welfare|sort\(\(a, b\) => .*(welfare|patrol)/i, 'the model knows nothing about Welfare or patrol, so it cannot rank them');
  assert.equal(model.showOnDutyBar(null), false);
  assert.equal(model.showOnDutyBar(undefined), false);
  assert.equal(model.showOnDutyBar({ id: 4 }), true);
});

test('UX-T1-UPCOMING-SHIFTS-ARE-ACCEPTED-WORK-ONLY', () => {
  const normalize = (s) => ({ accepted: 'ready', assigned: 'offered' }[(s || '').toLowerCase()] || (s || '').toLowerCase());
  const at = (h0) => new Date(NOW + h0 * 3_600_000).toISOString();
  const shifts = [
    { id: 1, start: at(30), end: at(38), status: 'ready' },
    { id: 2, start: at(5), end: at(13), status: 'accepted' },
    { id: 3, start: at(2), end: at(10), status: 'offered' },
    { id: 4, start: at(3), end: at(11), status: 'assigned' },
    { id: 5, start: at(4), end: at(12), status: 'cancelled' },
    { id: 6, start: at(6), end: at(14), status: 'rejected' },
    { id: 7, start: at(-3), end: at(5), status: 'in_progress' },
    { id: 8, start: at(-10), end: at(-2), status: 'ready' },
    { id: 9, start: at(50), end: at(58), status: 'ready' },
    { id: 10, start: at(70), end: at(78), status: 'ready' },
  ];
  assert.deepEqual(model.upcomingShifts(shifts, NOW, normalize).map((s) => s.id), [2, 1, 9], 'soonest three, offers and ended work excluded');
  assert.deepEqual(model.upcomingShifts(shifts, NOW, normalize, 1).map((s) => s.id), [2]);
  assert.deepEqual(model.upcomingShifts(shifts, NOW, normalize, 0), []);
  assert.deepEqual(model.upcomingShifts([{ id: 1, start: 'x', end: 'not a date', status: 'ready' }], NOW, normalize), [], 'an unreadable end is not upcoming');
});

// ═══════════════════ UX-T8 the layout matrix ═══════════════════

test('UX-T8-LAYOUT-MATRIX-FOUR-VIEWPORTS-THREE-TEXT-SCALES', () => {
  // [width, height, scale, headerWraps, barStacks, tileColumns]
  const expected = [
    [360, 640, 1.0, true, false, 2], [360, 640, 1.3, true, true, 1], [360, 640, 2.0, true, true, 1],
    [375, 667, 1.0, false, false, 2], [375, 667, 1.3, true, true, 1], [375, 667, 2.0, true, true, 1],
    [393, 852, 1.0, false, false, 2], [393, 852, 1.3, true, true, 2], [393, 852, 2.0, true, true, 1],
    [430, 932, 1.0, false, false, 2], [430, 932, 1.3, true, false, 2], [430, 932, 2.0, true, true, 1],
  ];
  for (const [width, height, fontScale, headerWraps, barStacks, tiles] of expected) {
    const l = layoutRules.guardHomeLayout({ width, height, fontScale });
    const at = `${width}x${height} @${fontScale}`;
    assert.equal(l.headerWraps, headerWraps, `${at} header wraps`);
    assert.equal(l.onDutyBarStacks, barStacks, `${at} bar stacks`);
    assert.equal(l.tileColumns, tiles, `${at} tile columns`);
    assert.equal(l.compact, width < 375 || fontScale >= 1.3, `${at} compact`);
  }
  // A larger text scale never needs more horizontal room than a smaller one.
  for (const width of [360, 375, 393, 430]) {
    const [a, b, c] = [1, 1.3, 2].map((fontScale) => layoutRules.guardHomeLayout({ width, height: 800, fontScale }));
    assert.ok(a.tileColumns >= b.tileColumns && b.tileColumns >= c.tileColumns, `${width}: columns never grow with text`);
    assert.ok(!a.onDutyBarStacks || b.onDutyBarStacks, `${width}: stacking is monotonic`);
  }
  // Garbage from the platform falls back safely rather than producing NaN layouts.
  for (const bad of [{ width: 0, height: 0, fontScale: 0 }, { width: NaN, height: NaN, fontScale: NaN }]) {
    const l = layoutRules.guardHomeLayout(bad);
    assert.equal(l.fontScale, 1);
    assert.ok([1, 2].includes(l.tileColumns));
  }
  // The hook only reads the window: no scaling of the whole UI anywhere in the new components.
  for (const rel of ['src/components/guard/home/useGuardHomeLayout.ts', 'src/components/guard/home/GuardHeader.tsx', 'src/components/guard/home/GuardOnDutyBar.tsx']) {
    assert.doesNotMatch(codeOf(rel), /transform|scale\(|PixelRatio/, `${rel} does not scale the UI`);
  }
  assert.match(codeOf('src/components/guard/home/useGuardHomeLayout.ts'), /useWindowDimensions\(\)/);
});

// ═══════════════════ UX-T9 header and bar controls ═══════════════════

function flat(style) {
  const s = typeof style === 'function' ? style({ pressed: false }) : style;
  return RNW.StyleSheet.flatten(s) || {};
}

test('UX-T9-HEADER-AND-BAR-CONTROLS-ARE-LABELLED-44PT-AND-NEVER-CLIPPED', async () => {
  const { GuardHeader } = loadWith('src/components/guard/home/GuardHeader.tsx');
  const { GuardOnDutyBar, EMERGENCY_MIN_HEIGHT } = loadWith('src/components/guard/home/GuardOnDutyBar.tsx');
  assert.ok(EMERGENCY_MIN_HEIGHT >= 48);
  for (const headerWraps of [false, true]) {
    let r;
    await act(async () => {
      r = TestRenderer.create(h(GuardHeader, { title: 'Current Shift', productLabel: 'S4', productIsUat: false, layout: { headerWraps }, onLogout: noop, notifications: h(RNW.Text, null, 'N') }));
    });
    const controls = pressables(r.root, () => true);
    assert.equal(controls.length, 1, 'Log out is the header\'s own control (Notifications is passed in)');
    for (const c of controls) {
      assert.equal(c.props.accessibilityRole, 'button');
      assert.ok(c.props.accessibilityLabel, 'labelled');
      assert.ok(flat(c.props.style).minHeight >= 44, 'at least 44pt');
    }
    assert.ok(r.root.findAll((n) => n.props?.accessibilityRole === 'header').length >= 1, 'the title is announced as a heading');
    // Wrapped: the actions become the header's second row instead of sharing the title row.
    const [header] = byTestId(r.root, 'guard-header');
    const [titleRow] = byTestId(header, 'guard-header-title-row');
    const [actions] = byTestId(header, 'guard-header-actions');
    assert.ok(texts(titleRow).includes('Current Shift') && texts(actions).includes('Log out'));
    assert.equal(isInside(actions, titleRow), !headerWraps, headerWraps ? 'actions on their own row' : 'actions beside the title');
  }
  for (const onDutyBarStacks of [false, true]) {
    let r;
    await act(async () => {
      r = TestRenderer.create(h(GuardOnDutyBar, { siteName: 'A very long site name that has to wrap onto another line at large text', emergencyLabel: 'Emergency', emergencyAccessibilityLabel: 'Emergency', layout: { onDutyBarStacks }, onEmergency: noop }));
    });
    const [emergency] = pressables(r.root, () => true);
    assert.equal(emergency.props.accessibilityRole, 'button');
    assert.equal(emergency.props.accessibilityLabel, 'Emergency');
    assert.match(emergency.props.accessibilityHint, /needs a connection/i, 'Emergency is announced as online-only');
    assert.ok(flat(emergency.props.style).minHeight >= 48, 'Emergency is at least 48pt');
    assert.equal(flat(emergency.props.style).backgroundColor, '#B42318', 'Emergency is danger red');
  }
  for (const rel of ['src/components/guard/home/GuardHeader.tsx', 'src/components/guard/home/GuardOnDutyBar.tsx']) {
    const src = codeOf(rel);
    assert.doesNotMatch(src, /numberOfLines|ellipsizeMode|adjustsFontSizeToFit|allowFontScaling=\{false\}/, `${rel} never truncates or blocks text scaling`);
    assert.doesNotMatch(src, /\bheight: \d/, `${rel} has no fixed heights that large text would overflow`);
  }
  // The Notifications control the dashboard passes in keeps its 44pt target.
  assert.match(read(SCREEN), /inboxButton: \{[^}]*minHeight: 44,/);
});

// ═══════════════════ UX-T2 Book Off ═══════════════════

test('UX-T2-BOOK-OFF-UNCHANGED-IN-EVERY-ON-DUTY-PHASE', () => {
  const screen = codeOf(SCREEN);
  const primary = screen.slice(screen.indexOf('function getGuardPhasePrimaryLabel'), screen.indexOf('function getPrimaryActionGuidance'));
  assert.match(primary, /case 'on_shift':\s*case 'welfare_due':\s*case 'welfare_overdue':\s*case 'shift_ending_soon':\s*return getPrimaryActionLabel\('in_progress'\);/,
    'one label for every on-duty phase: no end-time dependent Book Off');
  const handler = screen.slice(screen.indexOf('function handlePrimaryHomeAction'), screen.indexOf('const historySummaryShift'));
  assert.match(handler, /if \(status === 'in_progress'\) \{[\s\S]*?setPendingBookOff\(\{[\s\S]*?decision: bookOffDecision\(/, 'every Book Off still goes through the confirmation');
  for (const rel of ['src/components/guard/home/GuardOnDutyBar.tsx', 'src/components/guard/home/GuardHeader.tsx', 'src/components/guard/home/guardHomeModel.ts', 'src/components/guard/home/guardHomeLayout.ts']) {
    assert.doesNotMatch(codeOf(rel), /Book Off|handleCheckOut|checkOutShift|setPendingBookOff/, `${rel} has no Book Off path`);
  }
});

// ═══════════════════ UX-T4 Emergency ═══════════════════

test('UX-T4-EMERGENCY-IS-OUTSIDE-THE-SCROLLVIEW-ON-EVERY-TAB-AND-OPENS-THE-EXISTING-FORM', async () => {
  const shift = liveShift();
  const { renderer, run, calls } = await mountApp({ shifts: [shift], attendance: [{ id: 1, type: 'check-in', occurredAt: shift.start, shift: { id: shift.id } }] });
  const root = renderer.root;
  const checkBar = (where) => {
    const bars = byTestId(root, 'guard-on-duty-bar');
    assert.equal(bars.length, 1, `${where}: exactly one on-duty bar`);
    for (const sv of scrollViews(root)) assert.ok(!isInside(bars[0], sv), `${where}: the bar is not inside a ScrollView`);
    assert.equal(pressables(bars[0], (p) => p.accessibilityRole === 'button').length, 1, `${where}: Emergency is in the bar`);
    assert.ok(texts(bars[0]).includes('Harbour Gate'), `${where}: the bar names the live site`);
    return bars[0];
  };
  checkBar('Home');
  for (const tab of ['Offers', 'Jobs', 'History', 'Profile', 'Home']) {
    const [button] = byLabel(root, tab);
    assert.ok(button, `${tab} tab`);
    await run(() => button.props.onPress());
    checkBar(tab);
  }
  const [inbox] = byLabel(root, 'Notifications');
  await run(() => inbox.props.onPress());
  checkBar('Notifications');
  // Exactly one Emergency launcher on screen, and it opens the existing SOS form; nothing is sent by opening it.
  const emergencies = pressables(byTestId(root, 'guard-on-duty-bar')[0], (p) => p.accessibilityRole === 'button');
  assert.equal(emergencies.length, 1);
  const allEmergency = pressables(root, (p) => /emergency/i.test(String(p.accessibilityLabel || '')));
  assert.equal(allEmergency.length, 1, 'one Emergency launcher on the whole screen');
  assert.ok(!texts(root).includes('You need immediate help. Type SOS to confirm.'), 'the form is closed before the press');
  await run(() => emergencies[0].props.onPress());
  assert.ok(texts(root).includes('You need immediate help. Type SOS to confirm.'), 'the existing Emergency form opens');
  assert.ok(texts(root).includes('Send Emergency Alert'), 'with its own submit');
  assert.equal(calls.safetyAlerts.length, 0, 'opening the form sends nothing');
  await run(() => renderer.unmount());
});

test('UX-T4-NO-BAR-WHEN-AN-EMERGENCY-CANNOT-BE-RAISED', async () => {
  for (const [why, shifts, attendance] of [
    ['no shift', [], []],
    ['accepted, not booked on', [{ ...liveShift(), status: 'ready', start: new Date(NOW + 3_600_000).toISOString() }], []],
    ['booked off', [liveShift()], [{ id: 1, type: 'check-in', occurredAt: liveShift().start, shift: { id: 41 } }, { id: 2, type: 'check-out', occurredAt: new Date(NOW).toISOString(), shift: { id: 41 } }]],
  ]) {
    const { renderer, run } = await mountApp({ shifts, attendance });
    assert.equal(byTestId(renderer.root, 'guard-on-duty-bar').length, 0, `${why}: no on-duty bar`);
    assert.equal(pressables(renderer.root, (p) => /emergency/i.test(String(p.accessibilityLabel || ''))).length, 0, `${why}: no Emergency launcher`);
    await run(() => renderer.unmount());
  }
});

test('UX-T4-THE-BAR-IS-MOUNTED-OUTSIDE-EVERY-TAB-CONDITIONAL', () => {
  const screen = codeOf(SCREEN);
  const barAt = screen.indexOf('<GuardOnDutyBar');
  const mainAt = screen.indexOf('<View style={styles.mainArea}>');
  const headerAt = screen.indexOf('<GuardHeader');
  assert.ok(headerAt > 0 && headerAt < barAt && barAt < mainAt, 'header, then the bar, then the tab content');
  const between = screen.slice(screen.indexOf('/>', screen.indexOf('notifications={(() => {')), barAt);
  assert.doesNotMatch(between, /activeTab ===/, 'the bar does not depend on the tab');
  assert.match(screen.slice(barAt - 200, barAt), /\{showOnDutyBar\(currentShiftActionTarget\) \? \(\s*$/, 'shown exactly when the Emergency form can submit');
  // One Emergency launcher, and the dispatch path is the existing one.
  assert.equal((screen.match(/setQuickActionModal\('emergency'\)/g) || []).length, 1);
  assert.match(screen, /guardActionBlockedReason\(form\.key, \{ shift: currentShiftActionTarget, value, busy \}\)/);
});

// ═══════════════════ UX-T6 / UX-T7 the header ═══════════════════

test('UX-T6-ONE-GUARD-HEADER-LOG-OUT-SIGNS-OUT-THROUGH-APP', async () => {
  const { renderer, run, calls } = await mountApp({ shifts: [liveShift()] });
  const root = renderer.root;
  const headers = byTestId(root, 'guard-header');
  assert.equal(headers.length, 1, 'one Guard header');
  const logOuts = pressables(root, (p) => p.accessibilityRole === 'button').filter((n) => n.findAll((c) => c.props?.children === 'Log out').length);
  assert.equal(logOuts.length, 1, 'App does not draw a second top bar for a Guard');
  assert.ok(isInside(logOuts[0], headers[0]), 'the one Log out is in the Guard header');
  assert.ok(!texts(root).includes('Guard'), 'App\'s "Guard" surface label is not drawn');
  assert.ok(texts(headers[0]).includes('Current Shift'), 'the Home title is in the header');
  assert.ok(!texts(root).includes('S4 UAT · STAGING'), 'the store app shows no UAT label');
  assert.ok(byLabel(headers[0], 'Notifications').length === 1, 'Notifications is in the header');
  const [logOut] = byLabel(headers[0], 'Log out');
  await run(() => logOut.props.onPress());
  assert.equal(calls.logout, 1, 'App\'s handleLogout ran: the session is signed out');
  assert.ok(texts(root).includes('Sign in'), 'back to the sign-in screen');
  await run(() => renderer.unmount());
});

test('UX-T6-THE-UAT-APP-KEEPS-ITS-LABEL-IN-THE-GUARD-HEADER', async () => {
  const { renderer, run } = await mountApp({ appVariant: 'uat' });
  const [header] = byTestId(renderer.root, 'guard-header');
  assert.ok(texts(header).includes('S4 UAT · STAGING'), 'a tester can never mistake the UAT app for the real S4');
  await run(() => renderer.unmount());
  const app = codeOf('App.tsx');
  assert.match(app, /productLabel=\{PRODUCT_LABEL\} productIsUat=\{APP_VARIANT === 'uat'\}/);
});

test('UX-T7-NON-GUARD-SURFACES-KEEP-APPS-TOP-BAR', async () => {
  const { renderer, run } = await mountApp({ role: 'client_admin' });
  const root = renderer.root;
  assert.ok(texts(root).includes('Client'), 'the surface label');
  assert.ok(texts(root).includes('S4'), 'the product label');
  assert.equal(byTestId(root, 'guard-header').length, 0);
  const logOut = pressables(root, (p) => p.accessibilityRole === 'button').find((n) => n.findAll((c) => c.props?.children === 'Log out').length);
  assert.ok(logOut, 'Log out stays in App\'s top bar');
  await run(() => renderer.unmount());
  const app = codeOf('App.tsx');
  assert.match(app, /\{surface !== 'company' && surface !== 'guard' \? <View style=\{styles\.topBar\}>/, 'only Guards lose App\'s top bar');
  assert.match(app, /\{PRODUCT_LABEL\}<\/Text>/);
});

// ═══════════════════ UX-T10 the patrol freeze ═══════════════════

// Recorded from release/s4-pilot-rc1 at 1251a8e (iOS 1.2.1 (22), the verified Photo Patrol camera fix c82c442).
const PATROL_FREEZE = {
  'src/components/guard/patrol/GuardPatrolCamera.tsx': '3a4bca4d8c4de0e8a859f411a20b3d822ceedb61a2c6060b1073d1cfb4ef271c',
  'src/components/guard/patrol/GuardPatrolPanel.tsx': '681b12abc6c2be3db8e924b7dce485527a34e139e68f1c2c8e2e0d10ad57ff53',
  'src/components/guard/patrol/GuardPatrolPanel.web.tsx': '6f65a834f039d10e8d80b925ea6a45006af33d064c995c5d9ee134370967ff7b',
  'src/components/guard/patrol/patrolCamera.ts': '3d075f66cf2a91a3d7cce5bdb979ebf9da3c32e96eb357f4b92c410308217bd1',
  'src/components/guard/patrol/patrolImage.ts': 'a92ffc48796886eaf3fdf14d71a235c4693f4a38c3d92c7a9025116104f7ee03',
  'src/components/guard/patrol/patrolOutbox.ts': 'a5acc4789c5b85f67317d8b7e40df876254a7d21d1a8fe3c613a08684ec10566',
  'src/components/guard/patrol/patrolOutboxSql.ts': 'b86fb0c409dbafc7a4ed2de825f31d560ba35fee0a55b729bb3704f1f6394542',
  'src/components/guard/patrol/patrolPlanRefresh.ts': 'e9b1529e0a3c505a6537f16a3d3c3e1d987c41c0682c7b6a4b226aa95e7d3fbb',
  'src/components/guard/patrol/patrolQrScan.ts': 'c8b10755b5ccf2c25932f3e3fbb1e31c842ec56a02bba0e9e06a4cc9dce7e77c',
  'src/components/guard/patrol/patrolState.ts': '133bbc083408aa9e9b71793b0fd9ac7f7eb2656b9e0c2e3a7fb40b3f792765d1',
  'src/components/guard/patrol/patrolTempCleanup.ts': 'a34e023a0c4689eb270b41cad85a349ae5bf648c1d824de58783ad0956ad5be6',
};

test('UX-T10-THE-PATROL-CODE-IS-BYTE-IDENTICAL-TO-BUILD-22', () => {
  const dir = path.join(ROOT, 'src/components/guard/patrol');
  const present = fs.readdirSync(dir).map((f) => `src/components/guard/patrol/${f}`).sort();
  assert.deepEqual(present, Object.keys(PATROL_FREEZE).sort(), 'no patrol file added or removed');
  for (const [rel, sha] of Object.entries(PATROL_FREEZE)) {
    // Git may check text out with CRLF on Windows; the committed bytes are LF.
    const bytes = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(crypto.createHash('sha256').update(bytes, 'utf8').digest('hex'), sha, `${rel} is unchanged`);
  }
  // And the dashboard still mounts the panel exactly as before: same props, no new ones.
  const screen = read(SCREEN);
  assert.match(screen, /<GuardPatrolPanel\s+userId=\{user\.id\}\s+shift=\{currentHomeShift \? \{ id: currentHomeShift\.id, status: normalizeShiftLifecycleStatus\(currentHomeShift\.status\), companyId: currentHomeShift\.companyId \?\? null, siteName: currentHomeShift\.siteName \} : null\}\s+\/>/);
  assert.equal((screen.match(/<GuardPatrolPanel\b/g) || []).length, 1, 'mounted once');
});

(async () => {
  for (const [name, fn] of pending) {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  }
  console.log(`\n${passed} Guard Home UX-01 checks passed`);
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
