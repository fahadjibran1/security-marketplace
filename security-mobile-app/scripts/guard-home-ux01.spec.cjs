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
 *   UX-T21  Stage 4A: both badges grow with the text scale (never a fixed height), sit outside their control's layout,
 *           and so never change the Notifications control, move Log out, or shorten the Offers label
 *   UX-T22  Stage 4B-S1: the record tiles share one row of 48pt tiles (S3A; was 64) when every label's longest word fits,
 *           then reflow to 2 + 1 or one column; no word broken, no text shrunk, every label and handler kept
 *   UX-T23  Stage 4B-S2: the Welfare status and its full-label action share a row only at normal text when everything
 *           fits; otherwise stacked as before. DUE / OVERDUE / MISSED / COMPLETED all keep every line, colour and handler
 *   UX-T24  Stage 4B-S3: Shift Operations groups Welfare, Patrol, records and Book Off (no heading since S3B); the group
 *           is always mounted, so
 *           Book On, Book Off and No Shift never remount the Patrol panel; Emergency stays outside the scroll area
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
        // A plain view that keeps the style, testID and edges App gives it, so UX-T11 can inspect the safe areas.
        const SafeAreaView = ({ children, edges, style, testID }) => h(RNW.View, { style, testID: testID || 'safe-area', nativeID: (edges || []).join(',') }, children);
        return { SafeAreaProvider: Pass, SafeAreaView, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
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

async function mountApp({ role = 'guard', shifts = [], attendance = [], appVariant, notifications, fontScale, apiOverrides = {}, moduleOverrides = {} } = {}) {
  FakeAppState.currentState = 'active';
  const fake = fakeApi({
    fetchCurrentUser: async () => userOf(role),
    listMyShifts: async () => shifts,
    listMyAttendance: async () => attendance,
    ...(notifications ? { listMyNotifications: async () => notifications } : {}),
    ...apiOverrides,
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
    ...moduleOverrides,
  };
  // react-native-web always reports a text scale of 1; a test that needs another one supplies the layout directly.
  if (fontScale !== undefined) {
    overrides['src/components/guard/home/useGuardHomeLayout'] = {
      useGuardHomeLayout: () => layoutRules.guardHomeLayout({ width: 360, height: 640, fontScale }),
    };
  }
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
  // [width, height, scale, barStacks, tileColumns]. The header is not here: since S4-UX-01.2a it wraps by content
  // (UX-T9), not by a width breakpoint, so there is no headerWraps rule left to tabulate.
  const expected = [
    [360, 640, 1.0, false, 2], [360, 640, 1.3, true, 1], [360, 640, 2.0, true, 1],
    [375, 667, 1.0, false, 2], [375, 667, 1.3, true, 1], [375, 667, 2.0, true, 1],
    [393, 852, 1.0, false, 2], [393, 852, 1.3, true, 2], [393, 852, 2.0, true, 1],
    [430, 932, 1.0, false, 2], [430, 932, 1.3, false, 2], [430, 932, 2.0, true, 1],
  ];
  for (const [width, height, fontScale, barStacks, tiles] of expected) {
    const l = layoutRules.guardHomeLayout({ width, height, fontScale });
    const at = `${width}x${height} @${fontScale}`;
    assert.ok(!('headerWraps' in l), `${at}: no width breakpoint decides the header`);
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
  const { nextHeaderWrapped } = loadWith('src/components/guard/home/GuardHeader.tsx');
  // S4-UX-01.2a content-driven wrapping, with the widths measured on the CP-A emulator: mark 26pt, "Current Shift"
  // 114pt on one line, Notifications + Log out 189pt; the content box is the screen width minus 32pt.
  const fit = (wrapped, lines, rowWidth) => nextHeaderWrapped({ wrapped, lines, textWidth: 114, rowWidth, markWidth: 26, actionsWidth: 189 });
  assert.equal(fit(false, 1, 328), false, 'a title on one line keeps the actions beside it');
  assert.equal(fit(false, 2, 328), true, '360dp: the title would need two lines, so the actions wrap');
  assert.equal(fit(true, 1, 343), true, '375dp: 26+12+114+12+189 = 353 > 343, so they stay on their own row (CP-A shot 2)');
  assert.equal(fit(true, 1, 361), false, '393dp: 353 fits in 361, so they come back beside the title (CP-A shot 3)');
  assert.equal(fit(true, 2, 1000), true, 'a title that needs two lines even alone keeps the actions on their own row');
  assert.equal(fit(true, 1, 0), true, 'nothing moves before the row is measured');
  for (const title of ['Current Shift', 'A deliberately long screen title that cannot share a row']) {
    let r;
    await act(async () => {
      r = TestRenderer.create(h(GuardHeader, { title, productLabel: 'S4', productIsUat: false, onLogout: noop, notifications: h(RNW.Text, null, 'N') }));
    });
    const controls = pressables(r.root, () => true);
    assert.equal(controls.length, 1, 'Log out is the header\'s own control (Notifications is passed in)');
    for (const c of controls) {
      assert.equal(c.props.accessibilityRole, 'button');
      assert.ok(c.props.accessibilityLabel, 'labelled');
      assert.ok(flat(c.props.style).minHeight >= 44, 'at least 44pt');
    }
    assert.ok(r.root.findAll((n) => n.props?.accessibilityRole === 'header').length >= 1, 'the title is announced as a heading');
    // Before any measurement the actions sit beside the title, in the header's first row.
    const parts = () => {
      const [header] = byTestId(r.root, 'guard-header');
      const [row] = byTestId(header, 'guard-header-row');
      const [identity] = byTestId(header, 'guard-header-title-row');
      const [actions] = byTestId(header, 'guard-header-actions');
      return { header, row, identity, actions };
    };
    let p = parts();
    assert.ok(texts(p.identity).includes(title) && texts(p.actions).includes('Log out'));
    assert.ok(isInside(p.actions, p.row) && !isInside(p.actions, p.identity), 'actions beside the title');
    // Drive the real handlers with device measurements: the title needs two lines at 360dp, so the actions move to
    // their own row; at 430dp the one-line title fits beside them again, so they come back.
    const titleNode = r.root.findAll((n) => typeof n.props?.onTextLayout === 'function' && n.props.accessibilityRole === 'header')[0];
    const markNode = r.root.findAll((n) => typeof n.props?.onLayout === 'function' && n.props.children === 'S4')[0];
    const layout = (node, width) => node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 40 } } });
    const textLayout = (widths) => titleNode.props.onTextLayout({ nativeEvent: { lines: widths.map((width) => ({ width, text: '' })) } });
    await act(async () => { layout(p.row, 328); layout(markNode, 26); layout(p.actions, 189); textLayout([90, 60]); });
    p = parts();
    assert.ok(!isInside(p.actions, p.row) && isInside(p.actions, p.header), 'wrapped: the actions are the header\'s second row');
    assert.equal(flat(p.actions.props.style).alignSelf, 'flex-end', 'right-aligned on their own row');
    await act(async () => { layout(parts().row, 398); textLayout([114]); });
    assert.ok(isInside(parts().actions, parts().row), 'room again: the actions return beside the title');
    await act(async () => r.unmount());
  }
  assert.doesNotMatch(codeOf('src/components/guard/home/GuardHeader.tsx'), /headerWraps|NARROW_WIDTH|useWindowDimensions|useGuardHomeLayout/, 'no width breakpoint in the header');
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
    assert.equal(flat(emergency.props.style).backgroundColor, '#B42332', 'Emergency is danger red');
    // S4-UX-01.2a (CP-A shots 5 and 6): `flex: 1` gave the status a zero basis, so in the stacked column it had no
    // height and "On duty" and the site disappeared. Both containers now size from their content in either layout.
    const [status] = r.root.findAll((n) => n.props && /^On duty at /.test(String(n.props.accessibilityLabel || '')) && n.props.style);
    assert.ok(status, 'the status is announced with the site');
    assert.ok(texts(status).includes('On duty'), `On duty is rendered (stacked: ${onDutyBarStacks})`);
    const statusText = status.findAll((n) => n.props && n.props.style && texts(n).includes('On duty') && n !== status && flat(n.props.style).minWidth === 0)[0];
    for (const [name, node] of [['status', status], ['status text', statusText]]) {
      const s = flat(node.props.style);
      assert.equal(s.flex, undefined, `${name} does not use flex: 1 (a zero basis)`);
      assert.equal(s.flexBasis, 'auto', `${name} is sized from its content`);
    }
  }
  for (const rel of ['src/components/guard/home/GuardHeader.tsx', 'src/components/guard/home/GuardOnDutyBar.tsx']) {
    const src = codeOf(rel);
    assert.doesNotMatch(src, /numberOfLines|ellipsizeMode|adjustsFontSizeToFit|allowFontScaling=\{false\}/, `${rel} never truncates or blocks text scaling`);
    assert.doesNotMatch(src, /\bheight: \d/, `${rel} has no fixed heights that large text would overflow`);
  }
  // The Notifications control the dashboard passes in keeps its 44pt target.
  assert.match(read(SCREEN), /inboxButton: \{[^}]*minHeight: 44,/);
});

// ═══════════════════ UX-T21 Stage 4A badges ═══════════════════

test('UX-T21-BADGES-SCALE-WITH-TEXT-AND-NEVER-MOVE-THE-HEADER-OR-THE-OFFERS-LABEL', async () => {
  const screen = loadWith(SCREEN, { overrides: { 'src/services/api': fakeApi().api } });
  const { unreadBadge } = loadWith('src/components/guard/guardInbox.ts');
  // Sizes measured against the scaled badge text: 18dp at 1.0x (unchanged), 23dp at 1.3x, 32dp at 2.0x.
  assert.deepEqual([1, 1.3, 2].map(screen.guardBadgeSize), [18, 23, 32]);
  for (const bad of [0, -1, NaN, Infinity]) assert.equal(screen.guardBadgeSize(bad), 18, `${bad} falls back to 1.0x`);
  assert.deepEqual(screen.guardBadgeBox(23), { minWidth: 23, minHeight: 23, borderRadius: 11.5 });
  // The header badge overhangs the control by 4dp (the actions keep a 12dp gap, so Log out stays 8dp clear) and at
  // 1.0x rises no further than the header's 8dp top padding.
  assert.deepEqual([18, 23, 32].map((s) => screen.guardHeaderBadgeOffset(s)), [{ top: -8, right: -4 }, { top: -11, right: -4 }, { top: -17, right: -4 }]);
  assert.deepEqual(screen.guardOffersBadgeOffset(32), { bottom: '100%', right: -8 });
  const headerSrc = codeOf('src/components/guard/home/GuardHeader.tsx');
  assert.match(headerSrc, /header: \{[^}]*paddingTop: spacing\.sm,/, 'the header keeps 8dp above the actions');
  assert.match(headerSrc, /actions: \{[^}]*columnGap: spacing\.md, rowGap: spacing\.sm,/, '12dp between the controls, 8dp between wrapped rows');
  // No fixed badge height anywhere: the box can always grow to fit its scaled number.
  const styleBlock = (name) => { const s = codeOf(SCREEN); const i = s.indexOf(`  ${name}: {`); return s.slice(i, s.indexOf('}', i) + 1); };
  assert.doesNotMatch(styleBlock('navBadge'), /\bheight:/);
  assert.match(styleBlock('navBadgeOnHeader'), /position: 'absolute', borderWidth: 1, borderColor: '#FFFFFF'/, 'the Stage 1B outline is kept');
  assert.match(styleBlock('navBadgeOnNav'), /position: 'absolute'/);
  assert.doesNotMatch(codeOf(SCREEN), /allowFontScaling=\{false\}|maxFontSizeMultiplier/, 'badge text is never excluded from or capped in scaling');

  const offered = (n) => Array.from({ length: n }, (_, i) => ({ ...liveShift(900 + i), siteName: `Offer ${i}`, status: 'offered',
    start: new Date(NOW + (30 + i) * 3_600_000).toISOString(), end: new Date(NOW + (38 + i) * 3_600_000).toISOString() }));
  const unread = (n) => Array.from({ length: n }, (_, i) => ({ id: 500 + i, type: 'shift_offered', title: `N${i}`, message: 'm', status: 'unread',
    createdAt: new Date(NOW - i * 60_000).toISOString(), readAt: null }));
  const notificationsControl = (root) => pressables(root, (p) => /^Notifications(, .+ unread)?$/.test(String(p.accessibilityLabel || '')))[0];
  const offersTab = (root) => pressables(root, (p) => p.accessibilityRole === 'tab' && /^Offers/.test(String(p.accessibilityLabel)))[0];

  for (const fontScale of [1, 1.3, 2]) {
    const size = screen.guardBadgeSize(fontScale);
    let baseline = null;
    for (const [count, offers] of [[0, 0], [3, 3], [12, 12], [250, 12]]) {
      const at = `@${fontScale}x, ${count} unread, ${offers} offers`;
      const app = await mountApp({ shifts: [liveShift(), ...offered(offers)], notifications: unread(count), fontScale });
      const root = app.renderer.root;
      const control = notificationsControl(root);
      assert.ok(control, `${at}: the Notifications control`);
      const badges = byTestId(root, 'guard-header-unread-badge');
      const label = unreadBadge(count);
      assert.equal(control.props.accessibilityLabel, label ? `Notifications, ${label} unread` : 'Notifications', `${at}: label unchanged`);
      assert.equal(badges.length, label ? 1 : 0, `${at}: a badge only when something is unread`);
      // The control is styled identically with and without a badge: the badge never changes its width.
      const controlStyle = JSON.stringify(flat(control.props.style));
      if (baseline === null) baseline = controlStyle;
      assert.equal(controlStyle, baseline, `${at}: the Notifications control is unchanged by the badge`);
      if (label) {
        const [badge] = badges;
        assert.ok(isInside(badge, control), `${at}: the badge belongs to the Notifications control`);
        assert.ok(texts(badge).includes(label), `${at}: shows ${label}`);
        const s = flat(badge.props.style);
        assert.equal(s.position, 'absolute', `${at}: outside the control's layout`);
        assert.equal(s.height, undefined, `${at}: no fixed height`);
        assert.equal(s.minHeight, size, `${at}: ${size}dp minimum`);
        assert.equal(s.minWidth, size, `${at}: a circle at one digit, wider as needed`);
        assert.deepEqual({ top: s.top, right: s.right }, screen.guardHeaderBadgeOffset(size), `${at}: on the upper-right corner`);
        assert.equal(s.borderColor, '#FFFFFF');
      }
      const tab = offersTab(root);
      assert.equal(tab.props.accessibilityLabel, offers ? `Offers, ${offers} pending` : 'Offers', `${at}: Offers label unchanged`);
      const [offerBadge] = byTestId(tab, 'guard-offers-badge');
      assert.equal(Boolean(offerBadge), offers > 0, `${at}: an Offers badge only with pending offers`);
      // The label keeps its own one-line, shrink-no-further-than-60% rule and now the row's whole width: the badge is
      // positioned above it, outside the row's layout, so it can never be what shortens or truncates "Offers".
      const offersLabel = tab.findAll((n) => n.props?.children === 'Offers' && n.props.numberOfLines === 1)[0];
      assert.ok(offersLabel && offersLabel.props.adjustsFontSizeToFit === true && offersLabel.props.minimumFontScale === 0.6, `${at}: label rule unchanged`);
      if (offerBadge) {
        const s = flat(offerBadge.props.style);
        assert.equal(s.position, 'absolute', `${at}: the Offers badge is outside the label row's layout`);
        assert.equal(s.bottom, '100%', `${at}: it sits above the label, not beside it`);
        assert.equal(s.minHeight, size, `${at}: Offers badge ${size}dp minimum`);
        assert.equal(s.height, undefined);
        // The count is rendered as a number, exactly as before.
        assert.ok(offerBadge.findAll((n) => n.props?.children === offers).length > 0, `${at}: shows ${offers}`);
      }
      await act(async () => app.renderer.unmount());
    }
  }
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
  // S4-UX-01.3 (deliberate retarget): eligibility is computed once and shared by both Emergency presentations.
  assert.match(screen, /const emergencyEligible = showOnDutyBar\(currentShiftActionTarget\);/, 'eligibility is the Emergency form\'s own target');
  assert.match(screen.slice(barAt - 200, barAt), /\{emergencyEligible && emergencyPresentation === 'bar' \? \(\s*$/, 'shown exactly when the Emergency form can submit (Variant A)');
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

// ═══════════════════ UX-T11 status bar, safe areas and tab labels (S4-UX-01.2a) ═══════════════════

const edgesOf = (n) => (n.props.edges ? n.props.edges.join(',') : n.props.nativeID);

test('UX-T11-GUARD-STATUS-BAR-SITS-ON-NAVY-AND-THE-TAB-BAR-OWNS-THE-BOTTOM-INSET', async () => {
  const { renderer, run } = await mountApp({ shifts: [liveShift()] });
  const root = renderer.root;
  // Top: a navy backdrop exactly the height of the top inset, then the navy Guard header (CP-A: white status-bar
  // content had been drawn over the light page background).
  const [backdrop] = byTestId(root, 'guard-status-bar-backdrop');
  assert.ok(backdrop, 'a status-bar backdrop is drawn for a Guard');
  assert.equal(edgesOf(backdrop), 'top', 'it insets the top edge only');
  assert.equal(flat(backdrop.props.style).backgroundColor, '#14263D', 'navy, matching the Guard header');
  const [outer] = byTestId(root, 'safe-area');
  assert.equal(edgesOf(outer), 'right,left', 'the Guard screen is not inset again at the top or the bottom');
  // Bottom: the tab bar keeps padding itself by insets.bottom, so its labels stay above the gesture indicator.
  const screen = codeOf(SCREEN);
  assert.match(screen, /styles\.bottomNav, homeLayout\.compact && styles\.bottomNavCompact, \{ paddingBottom: Math\.max\(18, insets\.bottom \+ 8\) \}/);
  // Tabs: all five destinations stay, each announced by name, each label on one line that shrinks rather than breaks.
  const tabs = pressables(root, (p) => p.accessibilityRole === 'tab');
  assert.deepEqual(tabs.map((t) => t.props.accessibilityLabel), ['Home', 'Offers', 'Jobs', 'History', 'Profile']);
  for (const tab of tabs) {
    const labels = tab.findAll((n) => n.props && n.props.numberOfLines === 1 && n.props.adjustsFontSizeToFit === true);
    assert.ok(labels.length >= 1, `${tab.props.accessibilityLabel}: one line, shrink to fit, never broken mid-word`);
    assert.ok(labels[0].props.minimumFontScale >= 0.5, 'shrinks only so far');
    assert.notEqual(labels[0].props.allowFontScaling, false, 'still follows the system text size');
  }
  await run(() => renderer.unmount());
});

test('UX-T11-NON-GUARD-SURFACES-KEEP-ALL-FOUR-SAFE-AREA-EDGES', async () => {
  const { renderer, run } = await mountApp({ role: 'client_admin' });
  assert.equal(byTestId(renderer.root, 'guard-status-bar-backdrop').length, 0, 'no Guard backdrop');
  const [outer] = byTestId(renderer.root, 'safe-area');
  assert.equal(edgesOf(outer), 'top,right,bottom,left', 'unchanged for every other surface');
  await run(() => renderer.unmount());
  assert.match(codeOf('App.tsx'), /const GUARD_SAFE_AREA_EDGES: Array<'top' \| 'right' \| 'bottom' \| 'left'> = \['right', 'left'\];/);
});

// ═══════════════════ UX-T12 … UX-T16 the On Duty Home (S4-UX-01.3) ═══════════════════

const opsOf = (welfareStatus, start) => ({
  timezone: 'Europe/London',
  welfare: {
    enabled: true, intervalMinutes: 60, status: welfareStatus,
    currentWindow: { index: 2, start: new Date(NOW - 10 * 60_000).toISOString(), end: new Date(NOW + 20 * 60_000).toISOString() },
    lastWelfareAt: new Date(NOW - 70 * 60_000).toISOString(), nextDueAt: new Date(NOW + 20 * 60_000).toISOString(),
    overdueByMinutes: welfareStatus === 'overdue' ? 12 : null, requiredCount: 2, completedCount: 1, missedCount: 0, consecutiveMissed: 0,
  },
  logBook: { required: true, intervalMinutes: 120, currentWindow: { index: 1, start, end: new Date(NOW + 90 * 60_000).toISOString() }, currentWindowSubmitted: false, lastEntryAt: null },
});
const bookedOn = (shift) => [{ id: 1, type: 'check-in', occurredAt: shift.start, shift: { id: shift.id } }];
const order = (root, ids) => {
  const all = root.findAll((n) => typeof n.props?.testID === 'string' && ids.includes(n.props.testID));
  const seen = [];
  for (const n of all) if (!seen.includes(n.props.testID)) seen.push(n.props.testID);
  return seen;
};

test('UX-T12-ON-DUTY-HOME-IS-SUMMARY-WELFARE-PATROL-RECORDS-BOOK-OFF-ACTIVITY', async () => {
  const shift = { ...liveShift(), operations: opsOf('due', new Date(NOW - 30 * 60_000).toISOString()) };
  const { renderer, run } = await mountApp({ shifts: [shift], attendance: bookedOn(shift) });
  const root = renderer.root;
  const [scroll] = scrollViews(root);
  assert.deepEqual(
    order(scroll, ['guard-shift-summary', 'guard-welfare-summary', 'guard-shift-records', 'guard-book-off', 'guard-recent-activity']),
    ['guard-shift-summary', 'guard-welfare-summary', 'guard-shift-records', 'guard-book-off', 'guard-recent-activity'],
    'the fixed On Duty order; Welfare directly above the Patrol slot',
  );
  const body = texts(scroll);
  for (const gone of ['Current Shift', 'The single most important shift on your device right now.', 'Shift details', 'Live clock', 'Main action', 'Status',
    'Background log only — use Current Shift actions above first when something needs doing.', 'Recorded against this shift.']) {
    assert.ok(!body.includes(gone), `no "${gone}" in the On Duty body`);
  }
  assert.equal(body.filter((t) => t === 'Harbour Gate').length, 0, 'Variant A: the bar names the site, the body does not repeat it');
  assert.equal(texts(byTestId(root, 'guard-on-duty-bar')[0]).filter((t) => t === 'Harbour Gate').length > 0, true);
  // Welfare: the backend's projection, unchanged, with its own launcher.
  const [welfare] = byTestId(root, 'guard-welfare-summary');
  assert.ok(texts(welfare).includes('DUE') && texts(welfare).some((t) => /^Next due /.test(t)), 'status word and next due');
  // S4-UX-01.3b (deliberate retarget): the Log Book line moved out of the Welfare card to sit beside the Log Book tile.
  assert.ok(!texts(welfare).some((t) => /^Log Book · /.test(t)), 'the Welfare card carries only Welfare');
  assert.equal(byLabel(welfare, 'Record Welfare Check').length, 1);
  // Records: Log Book, Site Request and Incident, at least 44pt (48), each its own launcher.
  const [records] = byTestId(root, 'guard-shift-records');
  assert.ok(texts(records).some((t) => /^Log Book · /.test(t)), 'the Log Book line, beside its tile');
  assert.ok(!texts(records).includes('Shift records'), 'no heading repeating what the tiles say');
  const tiles = pressables(records, (p) => p.accessibilityRole === 'button');
  assert.deepEqual(tiles.map((t) => texts(t)[0]), ['Log Book', 'Site Request', 'Incident'], 'Welfare Check is not repeated as a tile');
  for (const tile of tiles) assert.ok(flat(tile.props.style).minHeight >= 44, 'records are at least 44pt');
  await run(() => tiles[0].props.onPress());
  assert.ok(texts(root).includes('Save Log Book Entry'), 'a tile opens its existing form');
  await run(() => renderer.unmount());
});

test('UX-T13-BOOK-OFF-IS-PRESENT-IN-EVERY-ON-DUTY-PHASE-AND-CONFIRMS-FIRST', async () => {
  const start = new Date(NOW - 2 * 3_600_000).toISOString();
  const cases = [
    ['on_shift', { ...liveShift() }],
    ['welfare_due', { ...liveShift(), operations: opsOf('due', start) }],
    ['welfare_overdue', { ...liveShift(), operations: opsOf('overdue', start) }],
    ['shift_ending_soon', { ...liveShift(), end: new Date(NOW + 10 * 60_000).toISOString() }],
  ];
  for (const [phase, shift] of cases) {
    const { renderer, run, calls } = await mountApp({ shifts: [shift], attendance: bookedOn(shift) });
    const root = renderer.root;
    const [bookOff] = byTestId(root, 'guard-book-off');
    assert.ok(bookOff, `${phase}: Book Off is on the On Duty Home`);
    assert.equal(bookOff.props.accessibilityLabel, 'Book Off', `${phase}: the same label`);
    assert.ok(flat(bookOff.props.style).minHeight >= 44, `${phase}: at least 44pt`);
    const [summary] = byTestId(root, 'guard-shift-summary');
    if (phase === 'shift_ending_soon') assert.ok(texts(summary).some((t) => /end/i.test(t) && t !== 'LIVE'), 'ending soon is said once, in the summary');
    if (phase === 'on_shift') assert.ok(!texts(summary).includes('You are on shift.'), 'no line that repeats the on-duty bar');
    await run(() => bookOff.props.onPress());
    assert.ok(texts(root).some((t) => /^Book Off (early|now)\?$/.test(t)), `${phase}: the existing confirmation opens`);
    assert.equal(calls.checkOut || 0, 0, `${phase}: nothing is sent before confirming`);
    await run(() => renderer.unmount());
  }
  // Source: the same handler as the Current Shift card's Main action, never a new one.
  const screen = codeOf(SCREEN);
  const use = screen.slice(screen.indexOf('<GuardBookOff'), screen.indexOf('/>', screen.indexOf('<GuardBookOff')));
  assert.match(use, /onPress=\{handleCurrentShiftPrimaryPress\}/);
  assert.match(use, /label=\{getGuardPhasePrimaryLabel\(guardShiftPhase, currentHomeShift\) as string\}/);
});

test('UX-T14-THE-PATROL-PANEL-HAS-ONE-STABLE-SLOT-FOR-EVERY-HOME-STATE', () => {
  const screen = codeOf(SCREEN);
  const slotAt = screen.indexOf('<View style={styles.homePatrolSlot}>');
  assert.ok(slotAt > 0, 'the slot exists');
  // Unconditional: the slot follows a closed conditional ({… : null}) and is not itself inside one, so its position
  // among the Home children never changes with the phase — Book On, phase changes and Book Off never remount it.
  const before = screen.slice(screen.lastIndexOf('{welfareCard ? (', slotAt), slotAt);
  // (codeOf strips the JSX comment between them to `{}`.)
  assert.match(before, /\) : null\}\s*(\{\}\s*)?$/, 'the Welfare block before it is a closed conditional');
  assert.ok(screen.slice(slotAt, screen.indexOf('</View>', screen.indexOf('</View>', slotAt) + 1)).includes('<GuardPatrolPanel'), 'the panel is in the slot');
  assert.equal((screen.match(/<GuardPatrolPanel\b/g) || []).length, 1, 'mounted once');
  // The panel sits between Welfare and the routine records, so both obligations are adjacent near the top.
  assert.ok(screen.indexOf('<GuardWelfareSummary') < slotAt && slotAt < screen.indexOf('{homeShiftLive ? renderHomeQuickActions() : null}'));
});

test('UX-T15-ON-DUTY-HOME-TEXT-WRAPS-NATURALLY-AT-ANY-TEXT-SCALE', async () => {
  const src = codeOf('src/components/guard/home/GuardOnDutyHome.tsx');
  assert.doesNotMatch(src, /numberOfLines|ellipsizeMode|adjustsFontSizeToFit|allowFontScaling=\{false\}/, 'no truncation, no shrinking, no opting out of the text scale');
  assert.doesNotMatch(src.replace(/liveDot: \{[^}]*\}/, ''), /\b(width|height): \d/, 'no fixed sizes around text (the live dot excepted)');
  assert.doesNotMatch(src, /\bflex: 1\b/, 'nothing sized from a zero basis');
  const { GuardShiftRecords, RECORD_TILE_MIN_WIDTH } = loadWith('src/components/guard/home/GuardOnDutyHome.tsx');
  for (const fontScale of [1, 1.3, 2]) {
    let r;
    await act(async () => {
      r = TestRenderer.create(h(GuardShiftRecords, { items: [{ key: 'logBook', title: 'Log Book', accessibilityLabel: 'Log Book' }], fontScale, onOpen: noop }));
    });
    const [tile] = pressables(r.root, () => true);
    assert.equal(flat(tile.props.style).flexBasis, RECORD_TILE_MIN_WIDTH * fontScale, `@${fontScale}: tiles widen with the text, then wrap`);
    await act(async () => r.unmount());
  }
});

// S4-UX-04B-S1: word widths are the Inter Bold 15 label words as laid out on Android 16 (S4_UX01_CPA, Stage 4A dumps;
// single words derived from the measured labels), at 1.0x, 1.3x and 2.0x. Row widths are the records card's content
// width on each phone (width − 2 × 16 page − 2 × 12 card).
const RECORD_WORDS = {
  1: { Log: 26, Book: 38, Site: 30, Request: 58, Incident: 59, Welfare: 55, Check: 44 },
  1.3: { Log: 35, Book: 51, Site: 40, Request: 78, Incident: 79, Welfare: 74, Check: 59 },
  2: { Log: 47, Book: 70, Site: 54, Request: 104, Incident: 107, Welfare: 100, Check: 80 },
};
const RECORD_ROWS = { 360: 304, 375: 319, 393: 337, 430: 374 };
const RECORD_ITEMS = [
  { key: 'logBook', title: 'Log Book', accessibilityLabel: 'Add Log Book entry' },
  { key: 'siteRequest', title: 'Site Request', accessibilityLabel: 'Raise Site Request' },
  { key: 'incident', title: 'Incident', accessibilityLabel: 'Report Incident' },
];

test('UX-T22-RECORD-TILES-SHARE-ONE-ROW-WHEN-EVERY-WORD-FITS-THEN-REFLOW', async () => {
  const { recordTileColumns, recordLabelWords, GuardShiftRecords, RECORD_TILE_MIN_WIDTH, RECORD_TILE_MIN_HEIGHT, RECORD_TILE_COMPACT_MIN_HEIGHT } =
    loadWith('src/components/guard/home/GuardOnDutyHome.tsx');
  // S4-UX-04B-S3A: one-row tiles are no taller than the others (48, at least 44pt); a label that needs two lines grows its tile.
  assert.equal(RECORD_TILE_COMPACT_MIN_HEIGHT, 48);
  assert.equal(RECORD_TILE_COMPACT_MIN_HEIGHT, RECORD_TILE_MIN_HEIGHT);
  assert.deepEqual(recordLabelWords('Site Request'), ['Site', 'Request']);
  const longest = (scale, titles) => titles.map((t) => Math.max(...recordLabelWords(t).map((w) => RECORD_WORDS[scale][w])));
  const three = ['Log Book', 'Site Request', 'Incident'];
  // The matrix: one row at 1.0x and 1.3x on every phone; at 2.0x, 2 + 1 except on the 430dp phone.
  const expected = { 1: { 360: 3, 375: 3, 393: 3, 430: 3 }, 1.3: { 360: 3, 375: 3, 393: 3, 430: 3 }, 2: { 360: 2, 375: 2, 393: 2, 430: 3 } };
  for (const scale of [1, 1.3, 2]) {
    for (const [phone, rowWidth] of Object.entries(RECORD_ROWS)) {
      assert.equal(recordTileColumns({ rowWidth, longestWords: longest(scale, three) }), expected[scale][phone], `${phone}dp @${scale}x`);
    }
  }
  // Four tiles (no Welfare card: Welfare Check is a tile) go 2 + 2, never 3 + 1.
  assert.equal(recordTileColumns({ rowWidth: 304, longestWords: longest(1, ['Welfare Check', ...three]) }), 2);
  // Nothing fits two abreast: one column. Not measured yet: null (the previous rule applies).
  assert.equal(recordTileColumns({ rowWidth: 304, longestWords: [200, 60, 60] }), 1);
  assert.equal(recordTileColumns({ rowWidth: 0, longestWords: [60, 60, 60] }), null);
  assert.equal(recordTileColumns({ rowWidth: 304, longestWords: [60, 0, 60] }), null);

  // The component, measured as a phone would: the row's width and each hidden word's laid-out width.
  for (const [scale, phone, columns] of [[1, 360, 3], [1.3, 360, 3], [2, 360, 2], [2, 430, 3]]) {
    let r;
    const opened = [];
    await act(async () => {
      r = TestRenderer.create(h(GuardShiftRecords, { items: RECORD_ITEMS, note: 'Log Book · ENTRY DUE · By 19:17', fontScale: scale, onOpen: (k) => opened.push(k) }));
    });
    const tileRow = r.root.find((n) => n.props?.testID === 'guard-shift-records-tiles' && typeof n.props.onLayout === 'function');
    const measure = r.root.find((n) => n.props?.testID === 'guard-shift-records-measure' && n.props.importantForAccessibility);
    // Before measuring: the previous wrapping rule, unchanged.
    let tiles = pressables(r.root, (p) => p.accessibilityRole === 'button');
    assert.equal(flat(tiles[0].props.style).flexBasis, RECORD_TILE_MIN_WIDTH * scale);
    // The measuring words are hidden from touch and from screen readers, and take no space in the card.
    assert.equal(measure.props.pointerEvents, 'none');
    assert.equal(measure.props.importantForAccessibility, 'no-hide-descendants');
    assert.equal(measure.props.accessibilityElementsHidden, true);
    assert.equal(flat(measure.props.style).position, 'absolute');
    await act(async () => {
      tileRow.props.onLayout({ nativeEvent: { layout: { width: RECORD_ROWS[phone] } } });
      for (const word of measure.findAll((n) => typeof n.props?.onLayout === 'function' && typeof n.props.children === 'string')) {
        word.props.onLayout({ nativeEvent: { layout: { width: RECORD_WORDS[scale][word.props.children] } } });
      }
    });
    tiles = pressables(r.root, (p) => p.accessibilityRole === 'button');
    assert.deepEqual(tiles.map((t) => texts(t)[0]), ['Log Book', 'Site Request', 'Incident'], 'complete labels, in order');
    assert.deepEqual(tiles.map((t) => t.props.accessibilityLabel), ['Add Log Book entry', 'Raise Site Request', 'Report Incident']);
    const basis = (RECORD_ROWS[phone] - 8 * (columns - 1)) / columns - 0.5;
    const widestWord = Math.max(...longest(scale, three));
    for (const t of tiles) {
      const s = flat(t.props.style);
      assert.equal(s.flexBasis, basis, `${phone}dp @${scale}x: ${columns} per row`);
      assert.equal(s.minHeight, columns === 3 ? RECORD_TILE_COMPACT_MIN_HEIGHT : RECORD_TILE_MIN_HEIGHT);
      assert.ok(s.minHeight >= 44, 'at least a 44pt target');
      assert.ok(widestWord <= basis - s.paddingHorizontal * 2, 'the longest word fits inside the padding: no word is broken');
    }
    assert.ok(columns * basis + 8 * (columns - 1) <= RECORD_ROWS[phone], 'the row never overflows its card');
    assert.ok(texts(r.root).some((t) => /^Log Book · /.test(t)), 'the Log Book status line is kept');
    for (const t of tiles) await act(async () => t.props.onPress());
    assert.deepEqual(opened, ['logBook', 'siteRequest', 'incident'], 'every tile keeps its handler');
    await act(async () => r.unmount());
  }
  // Text is never shrunk, truncated or opted out of the system text scale.
  assert.doesNotMatch(codeOf('src/components/guard/home/GuardOnDutyHome.tsx'), /maxFontSizeMultiplier|allowFontScaling|adjustsFontSizeToFit|numberOfLines/);
});

// S4-UX-04B-S2: Inter widths at 1.0x as laid out on Android 16 (Stage 4A dumps; single words derived), and the Welfare
// card's content width on each phone (width − 2 × 16 page − 2 × 16 card).
const WELFARE_WIDTHS = {
  'Welfare Check': 111, DUE: 30, OVERDUE: 62, MISSED: 50, COMPLETED: 76, 'Next due 18:07': 101,
  Every: 38, 60: 17, min: 26, 12: 17, over: 30, 1: 8, 2: 9, missed: 48, in: 12, a: 8, row: 27, this: 26, shift: 31, Last: 30, '17:07': 36,
  'Every 60 min': 87, '12 min over': 80, '1 missed this shift': 125, '2 missed in a row': 117, 'Last 17:07': 70,
  'Record Welfare Check': 174,
};
// One-line heights: the section label is 16/16, the status lines 20, the action's label 22.
const welfareHeight = (text) => (text === 'Welfare Check' ? 16 : text === 'Record Welfare Check' ? 22 : 20);
const WELFARE_ROWS = { 360: 296, 375: 311, 393: 329, 430: 366 };
const WELFARE_CARDS = {
  due: { label: 'DUE', tone: 'neutral', nextDue: '18:07', detail: 'Every 60 min', missedSummary: null, actionUrgent: false },
  overdue: { label: 'OVERDUE', tone: 'warning', nextDue: '18:07', detail: '12 min over', missedSummary: '1 missed this shift', actionUrgent: true },
  missed: { label: 'MISSED', tone: 'danger', nextDue: '18:07', detail: 'Every 60 min', missedSummary: '2 missed in a row', actionUrgent: true },
  routine: { label: 'COMPLETED', tone: 'good', nextDue: '18:07', detail: 'Last 17:07', missedSummary: null, actionUrgent: false },
};

test('UX-T23-WELFARE-STATUS-AND-ACTION-SHARE-A-ROW-ONLY-AT-NORMAL-TEXT-WHEN-EVERYTHING-FITS', async () => {
  const base = loadWith('src/components/guard/home/GuardOnDutyHome.tsx');
  const { welfareSideBySide, WELFARE_ACTION_LABEL } = base;
  assert.equal(WELFARE_ACTION_LABEL, 'Record Welfare Check', 'the label stays in full');
  const sz = (text, scale = 1) => ({ width: WELFARE_WIDTHS[text] * scale, height: welfareHeight(text) * scale });
  const ln = (text, scale = 1) => (text ? { ...sz(text, scale), longestWord: Math.max(...text.split(' ').map((w) => WELFARE_WIDTHS[w])) * scale } : null);
  const input = (card, rowWidth, fontScale = 1) => ({
    fontScale, rowWidth, action: sz('Record Welfare Check', fontScale), name: sz('Welfare Check', fontScale), status: sz(card.label, fontScale),
    next: sz(`Next due ${card.nextDue}`, fontScale), detail: ln(card.detail, fontScale), missed: ln(card.missedSummary, fontScale),
  });
  // At 1.0x the full action (174 + 2 × 16) and a column for "WELFARE CHECK" (111) need 333dp: only the 430dp phone has
  // room. There, DUE and COMPLETED are shorter side by side; OVERDUE and MISSED carry two more facts and are not, so they
  // stay stacked.
  const sideStates = ['DUE', 'COMPLETED'];
  for (const [phone, rowWidth] of Object.entries(WELFARE_ROWS)) {
    for (const card of Object.values(WELFARE_CARDS)) {
      assert.equal(welfareSideBySide(input(card, rowWidth)), phone === '430' && sideStates.includes(card.label), `${phone}dp ${card.label}`);
      // Larger text: always stacked, however wide the phone.
      for (const fontScale of [1.3, 2]) assert.equal(welfareSideBySide(input(card, 1000, fontScale)), false, `${card.label} @${fontScale}x`);
    }
  }
  // Not measured yet: stacked.
  const due = WELFARE_CARDS.due;
  assert.equal(welfareSideBySide({ ...input(due, 0) }), false);
  assert.equal(welfareSideBySide({ ...input(due, 366), action: { width: 0, height: 0 } }), false);
  assert.equal(welfareSideBySide({ ...input(due, 366), detail: { width: 87, height: 20, longestWord: 0 } }), false);

  // The component, measured as a phone would, in every state: 430 @1.0 (DUE and COMPLETED side by side), 360 @1.0 and
  // 430 @1.3 (all stacked).
  for (const [phone, fontScale, sideFor] of [[430, 1, sideStates], [360, 1, []], [430, 1.3, []]]) {
    const { GuardWelfareSummary } = loadWith('src/components/guard/home/GuardOnDutyHome.tsx', {
      overrides: { 'src/components/guard/home/useGuardHomeLayout': { useGuardHomeLayout: () => layoutRules.guardHomeLayout({ width: phone, height: 800, fontScale }) } },
    });
    for (const [name, card] of Object.entries(WELFARE_CARDS)) {
      let r;
      let recorded = 0;
      await act(async () => { r = TestRenderer.create(h(GuardWelfareSummary, { card, onRecord: () => { recorded += 1; } })); });
      const measure = r.root.find((n) => n.props?.testID === 'guard-welfare-measure' && n.props.importantForAccessibility);
      assert.equal(measure.props.importantForAccessibility, 'no-hide-descendants');
      assert.equal(measure.props.accessibilityElementsHidden, true);
      assert.equal(measure.props.pointerEvents, 'none');
      assert.equal(flat(measure.props.style).position, 'absolute', 'it takes no space');
      const layoutNode = () => r.root.find((n) => n.props?.testID === 'guard-welfare-layout' && typeof n.props.onLayout === 'function');
      assert.notEqual(flat(layoutNode().props.style).flexDirection, 'row', `${name}: stacked until measured`);
      await act(async () => {
        layoutNode().props.onLayout({ nativeEvent: { layout: { width: WELFARE_ROWS[phone], height: 100 } } });
        for (const t of measure.findAll((n) => typeof n.props?.onLayout === 'function' && typeof n.props.children === 'string')) {
          const text = t.props.children;
          t.props.onLayout({ nativeEvent: { layout: { width: WELFARE_WIDTHS[text] * fontScale, height: welfareHeight(text) * fontScale } } });
        }
      });
      const layout = layoutNode();
      const side = sideFor.includes(card.label);
      assert.equal(flat(layout.props.style).flexDirection === 'row', side, `${phone}dp @${fontScale}x ${name}: ${side ? 'side by side' : 'stacked'}`);
      // Every status, warning and the action, visible (outside the hidden measuring words).
      const shown = texts(layout);
      for (const t of ['Welfare Check', card.label, `Next due ${card.nextDue}`, card.detail, card.missedSummary].filter(Boolean)) assert.ok(shown.includes(t), `${name}: "${t}" shown`);
      const [action] = byLabel(layout, 'Record Welfare Check');
      assert.ok(action, `${name}: one action`);
      assert.equal(texts(action)[0], 'Record Welfare Check', 'the full label');
      const s = flat(action.props.style);
      assert.ok(s.minHeight >= 44, 'at least a 44pt target');
      assert.equal(s.backgroundColor, card.actionUrgent ? '#B42332' : '#087F8C', `${name}: ${card.actionUrgent ? 'red, the priority' : 'teal'}`);
      if (side) assert.equal(s.flexShrink, 0, 'beside the status it is never squeezed');
      const cardStyle = flat(r.root.find((n) => n.props?.testID === 'guard-welfare-summary' && n.props.style).props.style);
      assert.equal(cardStyle.borderColor, card.tone === 'danger' ? '#B42332' : '#D7E0E8', `${name}: the red outline only when MISSED`);
      if (card.missedSummary) {
        const missed = layout.findAll((n) => n.props?.children === card.missedSummary)[0];
        assert.equal(flat(missed.props.style).color, '#B42332', 'the missed count stays red');
      }
      await act(async () => action.props.onPress());
      assert.equal(recorded, 1, 'the same handler');
      await act(async () => r.unmount());
    }
  }
  assert.doesNotMatch(codeOf('src/components/guard/home/GuardOnDutyHome.tsx'), /maxFontSizeMultiplier|allowFontScaling|adjustsFontSizeToFit|numberOfLines/);
});

test('UX-T16-EMERGENCY-VARIANT-B-IS-REVIEW-ONLY-AND-USES-THE-SAME-HANDLER', async () => {
  const { guardEmergencyPresentation, DEFAULT_GUARD_EMERGENCY_PRESENTATION } = loadWith('src/components/guard/home/guardEmergencyPresentation.ts');
  assert.equal(DEFAULT_GUARD_EMERGENCY_PRESENTATION, 'bar', 'Variant A ships');
  assert.equal(guardEmergencyPresentation(undefined, false), 'bar');
  assert.equal(guardEmergencyPresentation('header', false), 'bar', 'a release build ignores the preview flag');
  assert.equal(guardEmergencyPresentation('header', true), 'header', 'only a development bundle can preview Variant B');
  assert.equal(guardEmergencyPresentation('bar', true), 'bar');
  // Render Variant B through the real App.
  const prevDev = global.__DEV__;
  const prevEnv = process.env.EXPO_PUBLIC_S4_SOS_PREVIEW;
  global.__DEV__ = true;
  process.env.EXPO_PUBLIC_S4_SOS_PREVIEW = 'header';
  try {
    const shift = liveShift();
    const { renderer, run, calls } = await mountApp({ shifts: [shift], attendance: bookedOn(shift) });
    const root = renderer.root;
    assert.equal(byTestId(root, 'guard-on-duty-bar').length, 0, 'never both presentations');
    const check = (where) => {
      const [header] = byTestId(root, 'guard-header');
      const [sos] = byTestId(header, 'guard-header-sos');
      assert.ok(sos, `${where}: SOS is in the header`);
      for (const sv of scrollViews(root)) assert.ok(!isInside(sos, sv), `${where}: outside every ScrollView`);
      const s = flat(sos.props.style);
      assert.ok(s.minHeight >= 48 && s.minWidth >= 48, `${where}: at least 48pt`);
      assert.equal(s.backgroundColor, '#B42332', 'danger red');
      assert.match(sos.props.accessibilityLabel, /emergency/i, 'announced as Emergency');
      assert.match(sos.props.accessibilityHint, /needs a connection/i);
      return sos;
    };
    check('Home');
    // Variant B shows no bar, so the summary names the site instead.
    assert.ok(texts(byTestId(root, 'guard-shift-summary')[0]).includes('Harbour Gate'), 'the summary names the site');
    for (const tab of ['Offers', 'Jobs', 'History', 'Profile', 'Home']) {
      await run(() => byLabel(root, tab)[0].props.onPress());
      check(tab);
    }
    const allEmergency = pressables(root, (p) => /emergency/i.test(String(p.accessibilityLabel || '')));
    assert.equal(allEmergency.length, 1, 'one Emergency launcher on the whole screen');
    await run(() => check('Home').props.onPress());
    assert.ok(texts(root).includes('You need immediate help. Type SOS to confirm.'), 'the existing Emergency form, with its SOS confirmation');
    assert.equal(calls.safetyAlerts.length, 0, 'opening it sends nothing');
    await run(() => renderer.unmount());
    // Not eligible (before Book On): no SOS either.
    const ready = { ...liveShift(), status: 'accepted', start: new Date(NOW + 3_600_000).toISOString() };
    const off = await mountApp({ shifts: [ready] });
    assert.equal(byTestId(off.renderer.root, 'guard-header-sos').length, 0, 'no SOS when an Emergency cannot be raised');
    await off.run(() => off.renderer.unmount());
  } finally {
    if (prevDev === undefined) delete global.__DEV__; else global.__DEV__ = prevDev;
    if (prevEnv === undefined) delete process.env.EXPO_PUBLIC_S4_SOS_PREVIEW; else process.env.EXPO_PUBLIC_S4_SOS_PREVIEW = prevEnv;
  }
});

// ═══════════════════ UX-T17 … UX-T20 the Off Duty Home (S4-UX-01.4) ═══════════════════

const HOUR = 3_600_000;
const readyShift = (id, startInHours, siteName, extra = {}) => ({
  id,
  siteName,
  start: new Date(NOW + startInHours * HOUR).toISOString(),
  end: new Date(NOW + (startInHours + 8) * HOUR).toISOString(),
  status: 'accepted',
  companyId: 3,
  checkCallIntervalMinutes: 60,
  instructions: null,
  site: { timezone: 'Europe/London' },
  ...extra,
});

test('UX-T17-OFF-DUTY-HOME-SHOWS-THE-NEXT-SHIFT-ITS-BOOK-ON-AND-THREE-UPCOMING', async () => {
  const shifts = [
    readyShift(61, 30, 'Delta Yard'),
    readyShift(60, 3, 'North Gate', { instructions: '  Use the north gate. Radio channel 4.  ' }),
    readyShift(62, 54, 'Echo Quay'),
    readyShift(63, 78, 'Foxtrot Mill'),
    readyShift(64, 102, 'Golf Tower'),
  ];
  const { renderer, run } = await mountApp({ shifts });
  const root = renderer.root;
  const [card] = byTestId(root, 'guard-shift-card');
  assert.ok(card, 'the shift card');
  const cardText = texts(card);
  assert.ok(cardText.includes('Next shift') && cardText.includes('North Gate'), 'the soonest accepted shift, named');
  assert.ok(cardText.some((t) => / – /.test(t)), 'its time range');
  assert.equal(byTestId(root, 'guard-on-duty-bar').length, 0, 'off duty: no on-duty bar');
  assert.equal(byTestId(root, 'guard-welfare-summary').length, 0);
  // The filler and the duplicated headings are gone.
  const body = texts(scrollViews(root)[0]);
  for (const gone of ['What to do now', 'Quick links', 'Shift details', 'Main action', 'Status', 'Upcoming shift — get on site, then Book On.']) {
    assert.ok(!body.includes(gone), `no "${gone}"`);
  }
  assert.ok(!body.some((t) => /Book On is available now/.test(t)), 'no status line repeating the date and time');
  // Instructions: exactly the API's text, behind a 44pt control, only on request.
  assert.equal(byTestId(root, 'guard-shift-instructions').length, 0, 'collapsed at first');
  const [toggle] = byLabel(card, 'Show shift instructions');
  assert.ok(toggle && flat(toggle.props.style).minHeight >= 44, 'a 44pt control');
  await run(() => toggle.props.onPress());
  assert.deepEqual([...new Set(texts(byTestId(root, 'guard-shift-instructions')[0]))], ['Use the north gate. Radio channel 4.'], 'the API text, trimmed, nothing invented');
  assert.equal(byLabel(root, 'Hide shift instructions').length, 1);
  // Upcoming: the next three accepted shifts after the card's, soonest first, never the card's again.
  const [upcoming] = byTestId(root, 'guard-upcoming-shifts');
  const listed = [...new Set(texts(upcoming).filter((t) => / · /.test(t)))];
  assert.deepEqual(listed.map((t) => t.split(' · ').pop()), ['Delta Yard', 'Echo Quay', 'Foxtrot Mill'], 'three, in order, without North Gate');
  // Book On: the existing label and handler, so the early confirmation still asks first.
  const [bookOn] = byLabel(card, 'Book On early');
  assert.ok(bookOn && flat(bookOn.props.style).minHeight >= 44, 'Book On early, at least 44pt');
  assert.ok(texts(card).some((t) => /You can Book On before your scheduled start/.test(t)), 'the early Book On rule');
  await run(() => bookOn.props.onPress());
  assert.ok(texts(root).includes('Book on early?'), 'the existing early Book On confirmation opens');
  await run(() => renderer.unmount());
});

test('UX-T18-NO-INSTRUCTIONS-CONTROL-WITHOUT-INSTRUCTIONS-AND-A-COMPACT-NO-SHIFT-STATE', async () => {
  for (const instructions of [null, '', '   ']) {
    const { renderer, run } = await mountApp({ shifts: [readyShift(70, 3, 'North Gate', { instructions })] });
    assert.equal(byTestId(renderer.root, 'guard-shift-instructions-toggle').length, 0, `no control for ${JSON.stringify(instructions)}`);
    assert.equal(byTestId(renderer.root, 'guard-upcoming-shifts').length, 0, 'no Upcoming card for a single shift');
    await run(() => renderer.unmount());
  }
  const { renderer, run } = await mountApp({ shifts: [] });
  const [none] = byTestId(renderer.root, 'guard-no-shift');
  assert.ok(none, 'between shifts');
  assert.ok(texts(none).includes('No shifts booked'));
  const links = pressables(none, (p) => p.accessibilityRole === 'button');
  assert.deepEqual(links.map((l) => l.props.accessibilityLabel), ['Review shift offers', 'Past shifts & timesheets', 'Browse jobs'], 'the same three destinations');
  for (const link of links) assert.ok(flat(link.props.style).minHeight >= 44, 'at least 44pt');
  assert.ok(!texts(renderer.root).some((t) => /same tabs as before/.test(t)), 'no explanatory filler');
  await run(() => renderer.unmount());
});

test('UX-T19-AN-OFFER-AND-A-FINISHED-SHIFT-KEEP-THEIR-EXISTING-ACTIONS', async () => {
  const offer = readyShift(80, 20, 'Offer Site', { status: 'assigned' });
  const a = await mountApp({ shifts: [offer] });
  const [offerCard] = byTestId(a.renderer.root, 'guard-shift-card');
  assert.ok(texts(offerCard).includes('Shift offer'));
  assert.equal(byLabel(offerCard, 'Review Offer').length, 1, 'Review Offer, as before');
  await a.run(() => a.renderer.unmount());

  const done = { ...readyShift(81, -10, 'Done Site'), status: 'completed' };
  const b = await mountApp({ shifts: [done] });
  const [lastCard] = byTestId(b.renderer.root, 'guard-shift-card');
  assert.ok(texts(lastCard).includes('Last shift'));
  assert.equal(byLabel(lastCard, 'View Summary').length, 1, 'the read-only summary action, as before');
  assert.equal(byTestId(b.renderer.root, 'guard-recent-activity').length, 1, 'its recap, in the compact list');
  await b.run(() => b.renderer.unmount());
});

test('UX-T20-OFF-DUTY-ORDER-KEEPS-THE-PATROL-SLOT-AND-ONE-PRIMARY-HANDLER', () => {
  const screen = codeOf(SCREEN);
  const slotAt = screen.indexOf('<View style={styles.homePatrolSlot}>');
  assert.ok(screen.indexOf('<GuardShiftCard') < slotAt && screen.indexOf('<GuardNoShift') < slotAt, 'the shift card comes before the Patrol slot');
  assert.ok(slotAt < screen.indexOf('<GuardUpcomingShifts'), 'Upcoming comes after it, so the slot never moves');
  const card = screen.slice(screen.indexOf('<GuardShiftCard'), screen.indexOf('/>', screen.indexOf('<GuardShiftCard')));
  assert.match(card, /onPress: handleCurrentShiftPrimaryPress/, 'Book On, Review Offer and View Summary keep their one handler');
  assert.match(card, /disabled: primaryDisabled/, 'disabled only while a request is in flight');
  assert.doesNotMatch(codeOf('src/components/guard/home/GuardOffDutyHome.tsx'), /checkIn|checkOut|bookOnDecision|setPendingBookOff|api\./, 'the components decide nothing');
});

// ═══════════════════ UX-T24 Shift Operations grouping (S4-UX-04B-S3) ═══════════════════

test('UX-T24-SHIFT-OPERATIONS-GROUPS-HOME-WITHOUT-EVER-REMOUNTING-THE-PATROL-PANEL', async () => {
  // Source: one group, always mounted, holding Welfare → the Patrol slot → the records → a rule and Book Off.
  const screen = codeOf(SCREEN);
  const groupAt = screen.indexOf('<View style={styles.homeOperations} testID="guard-shift-operations">');
  assert.ok(groupAt > 0, 'the group exists');
  assert.match(screen.slice(groupAt - 300, groupAt), /\)\}\s*(\{\}\s*)?$/, 'it follows the closed shift-summary conditional and is not itself conditional');
  const seq = ['<GuardWelfareSummary', '<View style={styles.homePatrolSlot}>', '{homeShiftLive ? renderHomeQuickActions() : null}', 'styles.homeOperationsSeparator', '<GuardBookOff'].map((m) => screen.indexOf(m));
  assert.ok(seq.every((at, i) => at > groupAt && (i === 0 || at > seq[i - 1])), 'Welfare, Patrol, records, the rule, then Book Off, all inside the group');
  assert.ok(screen.indexOf('<GuardUpcomingShifts') > seq[4], 'Upcoming and Recent activity stay after the group');
  assert.equal((screen.match(/<GuardBookOff\b/g) || []).length, 1, 'one Book Off');
  assert.equal((screen.match(/<GuardOnDutyBar\b/g) || []).length, 1, 'one Emergency launcher, unchanged');

  // Runtime: a probe in place of the Patrol panel counts mounts through Book On, Book Off and No Shift.
  const probe = { mounts: 0, unmounts: 0, shifts: [] };
  const PatrolProbe = ({ shift }) => {
    React.useEffect(() => { probe.mounts += 1; return () => { probe.unmounts += 1; }; }, []);
    probe.shifts.push(shift ? shift.status : null);
    return h(RNW.Text, { testID: 'patrol-probe' }, 'patrol');
  };
  const moduleOverrides = { 'src/components/guard/patrol/GuardPatrolPanel': { GuardPatrolPanel: PatrolProbe } };
  const ids = ['guard-welfare-summary', 'patrol-probe', 'guard-shift-records', 'guard-shift-operations-separator', 'guard-book-off'];
  const shift = readyShift(90, -0.1, 'Probe Gate', { operations: opsOf('due', new Date(NOW - 6 * 60_000).toISOString()) });
  const shifts = [shift];
  const attendance = [];
  const lifecycle = {
    checkInShift: async ({ shiftId }) => { shift.status = 'in_progress'; attendance.push({ id: 1, type: 'check-in', occurredAt: new Date().toISOString(), shift: { id: shiftId } }); return { id: 1 }; },
    checkOutShift: async ({ shiftId }) => { shift.status = 'completed'; attendance.push({ id: 2, type: 'check-out', occurredAt: new Date().toISOString(), shift: { id: shiftId } }); return { id: 2 }; },
  };
  const confirm = (root) => root.findAll((n) => n.props?.visible === true && typeof n.props.onConfirm === 'function')[0];
  const a = await mountApp({ shifts, attendance, apiOverrides: lifecycle, moduleOverrides });
  const root = a.renderer.root;
  const group = () => byTestId(root, 'guard-shift-operations')[0];
  // Off Duty (before Book On): the group is there, holding only the Patrol slot; no heading.
  assert.ok(group() && byTestId(group(), 'patrol-probe').length === 1, 'off duty: the Patrol slot is in the group');
  assert.ok(!texts(group()).includes('Shift operations'), 'off duty: no heading');
  const [bookOn] = byLabel(byTestId(root, 'guard-shift-card')[0], 'Book On now');
  assert.ok(bookOn, 'the existing Book On');
  await a.run(() => bookOn.props.onPress());
  // On Duty: the existing parts in order, Book Off last and set apart by a rule. S4-UX-04B-S3B: no heading of its own.
  assert.equal(byTestId(root, 'guard-shift-summary').length, 1, 'on duty after Book On');
  assert.ok(!texts(group()).some((t) => /^shift operations$/i.test(t)), 'no Shift operations heading');
  assert.equal(group().findAll((n) => n.props?.accessibilityRole === 'header').length, 0, 'the group adds no header of its own');
  assert.deepEqual(order(group(), ids), ids, 'Welfare, Patrol, records, rule, Book Off');
  assert.equal(isInside(byTestId(root, 'guard-shift-summary')[0], group()), false, 'the compact summary stays above, outside the group');
  const [scroll] = scrollViews(root);
  const [bar] = byTestId(root, 'guard-on-duty-bar');
  assert.ok(bar && !isInside(bar, scroll), 'Emergency stays outside the scroll area');
  assert.ok(byTestId(group(), 'guard-shift-operations-separator')[0].props.accessibilityElementsHidden, 'the rule is hidden from screen readers');
  // S4-UX-04B-S3A: 8dp inside the group (the cards' borders separate them), no frame or padding of its own.
  const groupStyle = flat(group().props.style);
  assert.equal(groupStyle.gap, 8);
  for (const k of ['padding', 'paddingVertical', 'paddingTop', 'borderWidth', 'backgroundColor']) assert.equal(groupStyle[k], undefined, `the group adds no ${k}`);
  assert.equal(byLabel(group(), 'Record Welfare Check').length, 1);
  assert.deepEqual(pressables(byTestId(group(), 'guard-shift-records')[0], (p) => p.accessibilityRole === 'button').map((t) => texts(t)[0]), ['Log Book', 'Site Request', 'Incident']);
  // Book Off through the existing confirmation, then Off Duty with the last shift.
  await a.run(() => byTestId(root, 'guard-book-off')[0].props.onPress());
  const dialog = confirm(root);
  assert.ok(dialog, 'the existing Book Off confirmation');
  await a.run(() => dialog.props.onConfirm());
  assert.equal(byTestId(root, 'guard-shift-summary').length, 0, 'off duty after Book Off');
  assert.ok(texts(byTestId(root, 'guard-shift-card')[0]).includes('Last shift'));
  assert.ok(group() && byTestId(group(), 'patrol-probe').length === 1 && !texts(group()).includes('Shift operations'), 'the group and its Patrol slot remain; no heading');
  assert.deepEqual([probe.mounts, probe.unmounts], [1, 0], 'Book On and Book Off never remounted the Patrol panel');
  assert.deepEqual([...new Set(probe.shifts)], ['ready', 'in_progress', 'completed'], 'it saw every state of the same shift (normalised)');
  await a.run(() => a.renderer.unmount());

  // On Duty → No Shift (the shift leaves the list after Book Off): still the same mount.
  probe.mounts = 0; probe.unmounts = 0;
  const live = { ...liveShift(91), operations: opsOf('due', new Date(NOW - 2 * 3_600_000).toISOString()) };
  const list = [live];
  const b = await mountApp({ shifts: list, attendance: bookedOn(live), apiOverrides: { checkOutShift: async () => { list.length = 0; return { id: 3 }; } }, moduleOverrides });
  await b.run(() => byTestId(b.renderer.root, 'guard-book-off')[0].props.onPress());
  await b.run(() => confirm(b.renderer.root).props.onConfirm());
  assert.equal(byTestId(b.renderer.root, 'guard-no-shift').length, 1, 'No Shift');
  assert.equal(byTestId(byTestId(b.renderer.root, 'guard-shift-operations')[0], 'patrol-probe').length, 1, 'the group and the Patrol slot are still mounted');
  assert.deepEqual([probe.mounts, probe.unmounts], [1, 0], 'On Duty → No Shift never remounted the Patrol panel');
  await b.run(() => b.renderer.unmount());
  assert.equal(probe.unmounts, 1, 'unmounted once, with the app');
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
