#!/usr/bin/env node
/**
 * The company dashboard never changes a shift by itself. (Production defect, 27 Oct 2026.)
 *
 * WHY THIS EXISTS
 * An effect in CompanyDashboardScreen marked every Ready shift 15 minutes past its start with no Book On as MISSED,
 * from whichever browser had Live Operations open and under that operator's identity. On 27 Oct shift 70 was replaced
 * at 14:36:09, the new Guard accepted at 14:36:39 (Ready, already past start + 15), and an open Live Operations tab
 * marked it missed at 14:36:50. `missed` cannot return to `ready` and Book On needs `ready`, so the Guard could not
 * Book On. Six shifts were auto-marked this way.
 *
 * WHAT IS CERTIFIED
 *   - The REAL CompanyDashboardScreen, mounted with react-test-renderer on react-native-web, every effect running,
 *     with an overdue Ready shift in the data: zero mutating API calls across mounts, re-renders, refreshes, polling
 *     ticks, leaving and re-entering Live Operations, and three dashboards mounted at once ("three tabs").
 *   - A late acceptance (Ready hours after start) stays Ready and shows "No Book On — Overdue"; a late Book On
 *     clears the warning; a replaced-then-accepted shift is never written.
 *   - Mark Missed needs a press, a reason and a confirmation, and then sends exactly ONE updateShift with
 *     { status: 'missed', reason } (the typed reason, trimmed, and no other field), which the backend audits as
 *     `shift.marked_missed`. Cancel / Back / an empty reason send nothing. Without shifts.manage it is not offered.
 *   - Statically: no effect, interval or listener anywhere in src/ calls a mutating API function, except the
 *     reviewed non-operational ones listed in ALLOWED_AUTOMATIC below.
 *
 * Mutating = an api.ts export whose body sends POST/PATCH/PUT/DELETE, read from the source, so a new mutator is
 * covered automatically. global fetch is also replaced, so a raw non-GET fetch would be caught too.
 */
const Module = require('node:module');
const originalLoad = Module._load;
const RNW = require('react-native-web');
const React = require('react');

/** The Modal primitive only (react-native-web's renders through a portal the test renderer cannot mount). */
function TestModal({ visible, children }) {
  return visible ? React.createElement('test-modal', null, children) : null;
}
// A desktop control-room window: the permanent sidebar layout the company dashboard is used in.
const RN_SHIM = { ...RNW, Modal: TestModal, useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }) };

/** Device and platform packages are inert: what is under test is the screen's own behaviour. */
const STUB_PREFIXES = [
  'expo', '@expo/', '@react-navigation/', '@react-native-async-storage/', 'react-native-screens',
  'react-native-gesture-handler', 'react-native-reanimated', 'react-native-svg',
];
function inertModule() {
  const passthrough = (name) => {
    const Component = ({ children }) => React.createElement(React.Fragment, null, children);
    Component.displayName = `Stub(${name})`;
    return Component;
  };
  const cache = new Map();
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === '__esModule') return true;
      if (prop === 'default') return inertModule();
      if (!cache.has(prop)) cache.set(prop, /^[A-Z]/.test(prop) ? passthrough(prop) : () => undefined);
      return cache.get(prop);
    },
    apply: () => undefined,
  });
}
Module._load = function (request, ...rest) {
  if (request === 'react-native') return RN_SHIM;
  if (request === 'react-native-safe-area-context') {
    return {
      useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
      SafeAreaView: ({ children }) => React.createElement(React.Fragment, null, children),
      SafeAreaProvider: ({ children }) => React.createElement(React.Fragment, null, children),
    };
  }
  if (STUB_PREFIXES.some((prefix) => request === prefix || request.startsWith(prefix))) return inertModule();
  return originalLoad.call(this, request, ...rest);
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// The company dashboard ships on the WEB (IS_WEB is `typeof document !== 'undefined'`).
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { activeElement: null, getElementById: () => null, querySelector: () => null, body: null };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener() {}, removeEventListener() {}, scrollTo() {}, location: { href: '', search: '', hash: '' } };
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TestRenderer = require('react-test-renderer');
const ts = require('typescript');
const { ROOT } = require('./load-ts.cjs');

const { act } = TestRenderer;
const h = React.createElement;

// ─── module loading: one cache, so the api module the screen imports is the one stubbed here ──────────────────

const cache = new Map();
function loadSource(rel) {
  const load = (abs) => {
    if (cache.has(abs)) return cache.get(abs).exports;
    const out = ts.transpileModule(fs.readFileSync(abs, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const mod = { exports: {} };
    cache.set(abs, mod);
    const req = (request) => {
      if (request.startsWith('.')) {
        const base = path.resolve(path.dirname(abs), request);
        for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
          if (fs.existsSync(c) && fs.statSync(c).isFile()) {
            if (c.endsWith('.json')) return require(c);
            return load(c);
          }
        }
      }
      return require(request);
    };
    new Function('module', 'exports', 'require', out)(mod, mod.exports, req);
    return mod.exports;
  };
  return load(path.join(ROOT, rel));
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Every api.ts export whose own body sends a non-GET method. */
function mutatingApiNames() {
  const src = read('src/services/api.ts');
  const names = new Set();
  const re = /^export (?:async )?function (\w+)\s*[(<]/gm;
  const starts = [...src.matchAll(re)];
  starts.forEach((m, i) => {
    // The function's own body only: a one-liner is its line; otherwise up to the closing brace at column 0.
    // (Never the next export, which would pull a private helper such as the token refresh into the one above it.)
    const lineEnd = src.indexOf('\n', m.index);
    const line = src.slice(m.index, lineEnd);
    const opens = (line.match(/\{/g) || []).length;
    const closeAt = src.indexOf('\n}\n', m.index);
    const nextExport = i + 1 < starts.length ? starts[i + 1].index : src.length;
    const body = opens > 0 && opens === (line.match(/\}/g) || []).length
      ? line
      : src.slice(m.index, Math.min(closeAt < 0 ? src.length : closeAt + 2, nextExport));
    if (/method:\s*[^,\n]*['"`](POST|PATCH|PUT|DELETE)['"`]/.test(body)) names.add(m[1]);
  });
  return names;
}
const MUTATING = mutatingApiNames();

// ─── fixtures and the recording API ───────────────────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const SITE = { id: 10, name: 'Merchant Fields', timezone: 'Europe/London', status: 'active', client: { id: 3, name: 'Client' } };

function shift(id, status, startOffsetMs, guard = { id: 1, fullName: 'Ava Guard' }, extra = {}) {
  const now = Date.now();
  return {
    id, status, siteId: SITE.id, siteName: SITE.name, site: SITE,
    start: iso(now + startOffsetMs), end: iso(now + startOffsetMs + 8 * HOUR),
    guardId: guard ? guard.id : null, guard, assignment: null, jobApplication: null, checkCallIntervalMinutes: 60,
    ...extra,
  };
}

const world = { shifts: [], attendance: [] };
const calls = { mutations: [], reads: 0 };

const api = loadSource('src/services/api.ts');
for (const key of Object.keys(api)) {
  if (typeof api[key] !== 'function') continue;
  if (MUTATING.has(key)) {
    api[key] = async (...args) => {
      calls.mutations.push([key, JSON.parse(JSON.stringify(args))]);
      return {};
    };
  } else {
    api[key] = async () => {
      calls.reads += 1;
      if (key === 'listShifts') return JSON.parse(JSON.stringify(world.shifts));
      if (key === 'listCompanyAttendance') return JSON.parse(JSON.stringify(world.attendance));
      if (key === 'listSites') return [SITE];
      return [];
    };
  }
}
// Belt and braces: a raw fetch that is not a GET is a mutation too.
globalThis.fetch = async (url, init = {}) => {
  const method = String(init.method || 'GET').toUpperCase();
  if (method !== 'GET') calls.mutations.push([`fetch ${method}`, [String(url)]]);
  return { ok: true, status: 200, json: async () => [], text: async () => '[]', headers: { get: () => null } };
};

// ─── fake polling clock: setInterval is captured and fired on demand; setTimeout stays real ─────────────────────

const intervals = new Map();
let nextIntervalId = 1;
globalThis.setInterval = (fn) => { const id = nextIntervalId++; intervals.set(id, fn); return id; };
globalThis.clearInterval = (id) => { intervals.delete(id); };

const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
};
async function tickPolling(times) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { for (const fn of [...intervals.values()]) fn(); });
    await settle();
  }
}

const { CompanyDashboardScreen } = loadSource('src/screens/CompanyDashboardScreen.tsx');
const { CompanyLiveOperationsWorkspace } = loadSource('src/components/company/CompanyLiveOperationsWorkspace.tsx');
const overdue = loadSource('src/components/company/noBookOnOverdue.ts');

const ADMIN = { id: 1, email: 'control@example.invalid', role: 'company_admin', firstName: 'Control', lastName: 'Room', status: 'active' };

async function mountDashboard(user = ADMIN) {
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(CompanyDashboardScreen, { user, onLogout: () => {} })); });
  await settle();
  return renderer;
}
function navigate(renderer, section) {
  const nav = renderer.root.findAll((n) => n.props && typeof n.props.onNavigate === 'function')[0];
  assert.ok(nav, 'the dashboard navigation is rendered');
  return act(async () => { nav.props.onNavigate(section); });
}
async function openLiveOperations(renderer) {
  await navigate(renderer, 'live-operations');
  await settle();
  assert.ok(renderer.root.findAll((n) => n.type === CompanyLiveOperationsWorkspace).length === 1, 'Live Operations is open');
}
function workspace(renderer) {
  return renderer.root.findAll((n) => n.type === CompanyLiveOperationsWorkspace)[0];
}
const textOf = (node) => {
  const words = [];
  const walk = (n) => {
    if (typeof n === 'string') { words.push(n); return; }
    if (!n || !n.children) return;
    n.children.forEach(walk);
  };
  walk(node);
  return words.join(' ');
};
const screenText = (renderer) => textOf(renderer.root);
const isInside = (node, ancestor) => { for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true; return false; };
const outermost = (nodes) => nodes.filter((n) => !nodes.some((o) => o !== n && isInside(n, o)));
const pressables = (root, label) => outermost(root.findAll((n) => n.props && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function'));
const press = async (node) => { await act(async () => { await node.props.onPress({ stopPropagation() {} }); }); await settle(); };
const modal = (renderer) => renderer.root.findAll((n) => n.type === 'test-modal').find((m) => textOf(m).includes('Before you mark this shift missed')) ?? null;

function reset(shifts, attendance = []) {
  world.shifts = shifts;
  world.attendance = attendance;
  calls.mutations.length = 0;
  intervals.clear();
}

/** Mount, enter Live Operations, re-render, refresh, poll, leave and come back: the full set of passive paths. */
async function exerciseEveryPassivePath(renderer) {
  await openLiveOperations(renderer);
  await tickPolling(12); // three minutes of 15-second ticks
  await act(async () => { renderer.update(h(CompanyDashboardScreen, { user: { ...ADMIN }, onLogout: () => {} })); });
  await settle();
  await act(async () => { await workspace(renderer).props.onToday(); }); // the Today / refresh read
  await settle();
  await navigate(renderer, 'dashboard');
  await settle();
  await tickPolling(4);
  await openLiveOperations(renderer);
  await tickPolling(8);
}

// ─── runner ───────────────────────────────────────────────────────────────────────────────────────────────────

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

// ═══ pure rules ═══

test('NBO-01-THE-OVERDUE-RULE-IS-READY-NO-BOOK-ON-AND-START-PLUS-15', () => {
  const now = Date.parse('2026-10-27T14:36:50.000Z');
  const at = (offsetMin, status = 'ready') => ({ status, start: iso(now - offsetMin * MIN) });
  assert.equal(overdue.NO_BOOK_ON_GRACE_MINUTES, 15);
  assert.equal(overdue.noBookOnOverdueMinutes(at(14.99), null, now), null, 'inside the grace: nothing');
  assert.equal(overdue.noBookOnOverdueMinutes(at(15), null, now), 15, 'start + 15 exactly: overdue');
  assert.equal(overdue.noBookOnOverdueMinutes(at(40), null, now), 40);
  assert.equal(overdue.noBookOnOverdueMinutes(at(40, 'accepted'), null, now), 40, 'legacy accepted is ready');
  assert.equal(overdue.noBookOnOverdueMinutes(at(40), { checkInAt: iso(now - MIN) }, now), null, 'booked on: never');
  for (const status of ['offered', 'in_progress', 'missed', 'completed', 'cancelled', 'unfilled']) {
    assert.equal(overdue.noBookOnOverdueMinutes(at(40, status), null, now), null, `${status}: never`);
  }
  assert.equal(overdue.formatOverdueMinutes(22), '22 min');
  assert.equal(overdue.formatOverdueMinutes(125), '2h 05m');
  assert.equal(overdue.validateMarkMissedReason('').ok, false, 'a reason is required');
  assert.equal(overdue.validateMarkMissedReason('   ').ok, false);
  assert.equal(overdue.validateMarkMissedReason('Guard unreachable, client confirmed nobody on site').ok, true);
  assert.equal(overdue.validateMarkMissedReason('x'.repeat(overdue.MARK_MISSED_REASON_MAX + 1)).ok, false);
  assert.match(overdue.MARK_MISSED_CONSEQUENCES.join(' '), /no longer be able to Book On/);
  assert.match(overdue.MARK_MISSED_CONSEQUENCES.join(' '), /Replace Guard/);
  assert.match(overdue.MARK_MISSED_CONSEQUENCES.join(' '), /Book On late/);
});

// ═══ the real dashboard, every effect running ═══

test('NBO-02-LIVE-OPERATIONS-WITH-AN-OVERDUE-READY-SHIFT-WRITES-NOTHING', async () => {
  reset([shift(70, 'ready', -40 * MIN)]);
  const renderer = await mountDashboard();
  await exerciseEveryPassivePath(renderer);
  assert.ok(calls.reads > 0, 'the dashboard did load (the test is not vacuous)');
  assert.ok(intervals.size >= 1, 'the polling timer is running');
  assert.deepEqual(calls.mutations, [], 'no mutating API call from opening, refreshing, polling, re-rendering or leaving');
  assert.ok(screenText(renderer).includes('No Book On — Overdue'), 'the overdue warning is shown instead');
  await act(async () => { renderer.unmount(); });
  assert.deepEqual(calls.mutations, [], 'nor on unmount');
});

test('NBO-03-THREE-DASHBOARDS-OPEN-AT-ONCE-WRITE-NOTHING', async () => {
  reset([shift(70, 'ready', -40 * MIN), shift(71, 'ready', -90 * MIN, { id: 2, fullName: 'Bea Guard' })]);
  const tabs = [await mountDashboard(), await mountDashboard(), await mountDashboard()];
  for (const tab of tabs) await openLiveOperations(tab);
  assert.ok(intervals.size >= 3, 'each tab runs its own poll');
  await tickPolling(20);
  for (const tab of tabs) {
    await act(async () => { await workspace(tab).props.onToday(); });
  }
  await settle();
  await tickPolling(4);
  assert.deepEqual(calls.mutations, [], 'three tabs on Live Operations never write');
  for (const tab of tabs) assert.ok(screenText(tab).includes('No Book On — Overdue'));
  for (const tab of tabs) await act(async () => { tab.unmount(); });
});

test('NBO-04-A-LATE-ACCEPTANCE-STAYS-READY-AND-SHOWS-OVERDUE', async () => {
  // Accepted three hours after its start: Ready, past start + 15 the moment it exists.
  reset([shift(72, 'ready', -3 * HOUR)]);
  const renderer = await mountDashboard();
  await exerciseEveryPassivePath(renderer);
  assert.deepEqual(calls.mutations, [], 'nothing marks it missed');
  const text = screenText(renderer);
  assert.ok(text.includes('No Book On — Overdue'), 'it is shown as overdue');
  assert.ok(/3h 00m since the scheduled start|180 min|3h 0\dm/.test(text), `with how long: ${text.match(/\d+h \d+m since the scheduled start|\d+ min since/)}`);
  assert.ok(!text.includes('automatically marked'), 'and no automation message');
  await act(async () => { renderer.unmount(); });
});

test('NBO-05-A-LATE-BOOK-ON-IS-UNAFFECTED', async () => {
  // Ready and overdue for many polls; then the Guard books on late. The shift was Ready the whole time, so the
  // Book On (which requires Ready) is possible, and the warning clears on the next read.
  reset([shift(73, 'ready', -50 * MIN)]);
  const renderer = await mountDashboard();
  await openLiveOperations(renderer);
  await tickPolling(10);
  assert.deepEqual(calls.mutations, []);
  assert.ok(screenText(renderer).includes('No Book On — Overdue'));
  world.shifts = [shift(73, 'in_progress', -50 * MIN)];
  world.attendance = [{ id: 1, type: 'check-in', occurredAt: iso(Date.now() - MIN), shift: { id: 73 } }];
  await tickPolling(2);
  assert.ok(!screenText(renderer).includes('No Book On — Overdue'), 'booked on: no warning');
  assert.deepEqual(calls.mutations, [], 'the dashboard wrote nothing at any point');
  await act(async () => { renderer.unmount(); });
});

test('NBO-06-A-REPLACED-THEN-ACCEPTED-SHIFT-IS-NOT-MUTATED', async () => {
  // Shift 70 on 27 Oct: replaced (offered to a new Guard) after start + 15, accepted 30 seconds later.
  reset([shift(70, 'offered', -36 * MIN, { id: 1, fullName: 'Ava Guard' })]);
  const renderer = await mountDashboard();
  await openLiveOperations(renderer);
  await tickPolling(2);
  world.shifts = [shift(70, 'offered', -36 * MIN, { id: 2, fullName: 'Bea Replacement' })]; // Replace Guard
  await tickPolling(2);
  world.shifts = [shift(70, 'ready', -37 * MIN, { id: 2, fullName: 'Bea Replacement' })]; // accepted
  await tickPolling(12);
  assert.deepEqual(calls.mutations, [], 'the accepted shift is left Ready for the new Guard to Book On');
  assert.ok(screenText(renderer).includes('No Book On — Overdue'));
  await act(async () => { renderer.unmount(); });
});

// ═══ the explicit action ═══

async function openMarkMissed(renderer) {
  const buttons = pressables(renderer.root, 'Mark Missed');
  assert.ok(buttons.length >= 1, 'Mark Missed is offered on the overdue warning');
  await press(buttons[0]);
  const dialog = modal(renderer);
  assert.ok(dialog, 'the Mark Missed dialog opens');
  return dialog;
}

test('NBO-07-MARK-MISSED-NEEDS-A-REASON-AND-CONFIRMATION-AND-SENDS-EXACTLY-ONE-UPDATE', async () => {
  reset([shift(74, 'ready', -40 * MIN)]);
  const renderer = await mountDashboard();
  await openLiveOperations(renderer);
  let dialog = await openMarkMissed(renderer);
  const text = textOf(dialog);
  assert.ok(text.includes('no longer be able to Book On'), 'the consequence is stated');
  assert.ok(text.includes('Replace Guard'), 'and the alternative');
  assert.deepEqual(calls.mutations, [], 'opening the dialog sends nothing');

  await press(pressables(dialog, 'Continue')[0]);
  dialog = modal(renderer);
  assert.ok(textOf(dialog).includes('Enter the reason'), 'an empty reason is refused');
  assert.ok(pressables(dialog, 'Confirm — mark missed').length === 0, 'and no confirm is offered');
  assert.deepEqual(calls.mutations, []);

  const input = dialog.find((n) => n.props && n.props.accessibilityLabel === 'Reason' && typeof n.props.onChangeText === 'function');
  // Padded on purpose: what is sent is the trimmed reason.
  await act(async () => { input.props.onChangeText('  Guard unreachable; client confirmed nobody on site  '); });
  await press(pressables(modal(renderer), 'Continue')[0]);
  dialog = modal(renderer);
  assert.ok(/Reason:\s+Guard unreachable; client confirmed nobody on site/.test(textOf(dialog)), 'the reason is restated');
  assert.deepEqual(calls.mutations, [], 'still nothing before Confirm');

  await press(pressables(dialog, 'Confirm — mark missed')[0]);
  assert.deepEqual(
    calls.mutations,
    [['updateShift', [74, { status: 'missed', reason: 'Guard unreachable; client confirmed nobody on site' }]]],
    'exactly one status change, carrying the typed reason (trimmed) for the shift.marked_missed audit',
  );
  assert.deepEqual(Object.keys(calls.mutations[0][1][1]).sort(), ['reason', 'status'], 'and no other field is sent');
  assert.equal(modal(renderer), null, 'the dialog closes');
  await tickPolling(6);
  assert.equal(calls.mutations.length, 1, 'and nothing follows it');
  await act(async () => { renderer.unmount(); });
});

test('NBO-08-CANCEL-AND-BACK-SEND-NOTHING', async () => {
  reset([shift(75, 'ready', -40 * MIN)]);
  const renderer = await mountDashboard();
  await openLiveOperations(renderer);

  let dialog = await openMarkMissed(renderer);
  await press(pressables(dialog, 'Cancel')[0]);
  assert.equal(modal(renderer), null, 'Cancel closes the dialog');

  dialog = await openMarkMissed(renderer);
  const input = dialog.find((n) => n.props && n.props.accessibilityLabel === 'Reason' && typeof n.props.onChangeText === 'function');
  await act(async () => { input.props.onChangeText('Guard phoned in sick'); });
  await press(pressables(modal(renderer), 'Continue')[0]);
  await press(pressables(modal(renderer), 'Back')[0]);
  await press(pressables(modal(renderer), 'Cancel')[0]);
  assert.equal(modal(renderer), null);
  await tickPolling(4);
  assert.deepEqual(calls.mutations, [], 'cancelling at any step sends nothing');
  await act(async () => { renderer.unmount(); });
});

test('NBO-09-WITHOUT-SHIFTS-MANAGE-THE-WARNING-SHOWS-BUT-MARK-MISSED-IS-NOT-OFFERED', async () => {
  reset([shift(76, 'ready', -40 * MIN)]);
  const renderer = await mountDashboard({ ...ADMIN, role: 'company_admin', companyPermissions: ['shifts.view', 'shifts.reconcile'] });
  await openLiveOperations(renderer);
  await tickPolling(3);
  assert.ok(screenText(renderer).includes('No Book On — Overdue'), 'everyone sees the warning');
  assert.equal(pressables(renderer.root, 'Mark Missed').length, 0, 'only shift managers get the action');
  assert.deepEqual(calls.mutations, []);
  await act(async () => { renderer.unmount(); });
});

// ═══ source: nothing automatic writes ═══

/** The argument text of every `<callee>(` call, by paren matching, comments stripped. */
function callBodies(src, callee) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(callee, from);
    if (at < 0) return out;
    let depth = 0;
    let i = at + callee.length - 1;
    for (; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') { depth -= 1; if (depth === 0) break; }
    }
    out.push({ at, body: src.slice(at, i + 1) });
    from = at + callee.length;
  }
}

/**
 * Automatic writes that were reviewed and are acceptable: none changes an operational record on a timer, a load
 * or a refresh. Key: file, value: { api name: why }.
 */
const ALLOWED_AUTOMATIC = {
  'App.tsx': {
    // Not api.register (sign-up): a local closure of the same name around registerWelfarePush().
    register: 'push-device registration for the signed-in Guard (POST /push-devices): idempotent, non-operational',
  },
  'src/screens/AccountLinkScreen.tsx': {
    verifyEmailAddress: 'opening the emailed verification link IS the user action; the token is single-use and idempotent',
  },
  'src/components/company/CompanyShiftAmendmentDrawer.tsx': {
    assessShiftAmendment: 'a POST dry run while the operator types a proposed end; the backend writes no row, notification or audit',
  },
};

test('NBO-10-NO-EFFECT-INTERVAL-OR-LISTENER-IN-THE-APP-CALLS-A-MUTATING-API', () => {
  assert.ok(MUTATING.has('updateShift') && MUTATING.has('createShift') && MUTATING.has('closeSafetyAlert'), 'the classifier finds mutators');
  assert.ok(!MUTATING.has('listShifts'), 'and not readers');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) files.push(rel);
    }
  };
  walk('src');
  files.push('App.tsx');
  const offenders = [];
  for (const rel of files) {
    const src = stripComments(read(rel));
    for (const callee of ['useEffect(', 'useLayoutEffect(', 'setInterval(', 'addEventListener(', 'AppState.addEventListener(']) {
      for (const { at, body } of callBodies(src, callee)) {
        for (const name of MUTATING) {
          if (new RegExp(`\\b${name}\\s*\\(`).test(body) && !(ALLOWED_AUTOMATIC[rel] || {})[name]) {
            offenders.push(`${rel}:${src.slice(0, at).split('\n').length} ${callee} → ${name}`);
          }
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `automatic mutating calls:\n${offenders.join('\n')}`);
});

test('NBO-11-THE-AUTOMATION-AND-ITS-STATE-ARE-GONE-AND-THE-ONLY-MISSED-WRITE-IS-THE-DIALOG', () => {
  const screen = stripComments(read('src/screens/CompanyDashboardScreen.tsx'));
  for (const gone of ['autoMarkingMissedShiftIds', 'isShiftPastMissedGracePeriod', 'runAutomation', 'Shift automation', 'automatically marked']) {
    assert.ok(!screen.includes(gone), `${gone} is removed`);
  }
  const missedWrites = screen.match(/status: 'missed'/g) || [];
  assert.equal(missedWrites.length, 1, 'one place sends status missed');
  const submit = callBodies(screen, 'const handleSubmitMarkMissed = React.useCallback(')[0];
  assert.ok(submit && submit.body.includes("updateShift(target.shiftId, { status: 'missed', reason })"), 'inside the Mark Missed submit, with the reason');
  assert.ok(submit.body.includes('validateMarkMissedReason(reason)'), 'the reason is re-validated (5–500 trimmed) before it is sent');
  assert.ok(submit.body.includes('recordManagementAction('), 'which logs the reason in the management action log');
  assert.ok(/onMarkMissed=\{canManageShifts \? handleOpenMarkMissed : undefined\}/.test(screen), 'gated on shifts.manage');
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      passed += 1;
      console.log('PASS ', name);
    } catch (error) {
      console.error('FAIL ', name);
      console.error('      ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n      ') : error));
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${pending.length} no-browser-status-mutation checks passed`);
  // The captured intervals keep nothing alive, but a stray real timer from a stub must not hang CI.
  process.exit(process.exitCode || 0);
})();
