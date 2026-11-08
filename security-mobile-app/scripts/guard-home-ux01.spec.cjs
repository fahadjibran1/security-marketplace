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
    assert.equal(flat(emergency.props.style).backgroundColor, '#B42318', 'Emergency is danger red');
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
  assert.equal(flat(backdrop.props.style).backgroundColor, '#0B1F33', 'navy, matching the Guard header');
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
      assert.equal(s.backgroundColor, '#B42318', 'danger red');
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
