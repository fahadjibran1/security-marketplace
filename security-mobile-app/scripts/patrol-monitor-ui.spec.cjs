#!/usr/bin/env node
/**
 * Patrol Monitor — the compact PatrolSafe-style Monitor on the company dashboard (S4 Patrol Monitor S2, owner-approved
 * 3 Nov 2026). Executes the REAL page (react-test-renderer on react-native-web) with the API stubbed, plus the pure rules.
 *
 * WHAT IS CERTIFIED (PMUI-01…17)
 *   - Colours and labels: green ONLY for an on-time, server-verified patrol; red ONLY for a sweep-confirmed missed patrol;
 *     late · verified, awaiting verification, incomplete, needs review (flagged / not verified), overdue and awaiting
 *     check amber with distinct plain-English labels; every state carries a text label and a symbol.
 *   - Navigation: Monitor first and the default section; Setup, Today, Evidence and Advanced unchanged and reachable.
 *   - Cards: one per site; collapsed shows site, client, verified / due, missed, needs review, next window; sites needing
 *     attention first, then on track, then no patrols due; client and status filters (no extra request).
 *   - Loading: opening the page reads the summary ONCE and no site; a site's hours are read only when expanded, refreshed
 *     only while expanded, on screen and on today; collapsing stops the refresh; a past day is never refreshed.
 *   - The grid: a shared Site Patrol row (site-wide), one row per guard / shift (per guard), overnight shifts marked,
 *     multiple windows per hour as "1/2", the 25- and 23-hour clock-change days, the lane names outside the scrolling
 *     hours, 44 px cells at 375 px and 1280 px.
 *   - A cell opens times, state, Guard, QR checkpoint and photo COUNTS from the data on screen — no request, no evidence
 *     link, no image — and links to the existing audited patrol record (the photos) and Live Operations.
 *   - Empty, forbidden and switched-off states; read-only (every request a GET), no NFC, no Guard app code touched.
 *   - The release-gate wiring.
 */
const Module = require('node:module');
const originalLoad = Module._load;
const RNW = require('react-native-web');
const React = require('react');

function TestModal({ visible, children }) {
  return visible ? React.createElement('test-modal', null, children) : null;
}
const RN_SHIM = { ...RNW, Modal: TestModal, useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }) };
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
// Browser storage that records every write: no patrol link may ever be written to it.
const storageWrites = [];
const fakeStorage = { getItem: () => null, setItem: (k, v) => storageWrites.push([k, v]), removeItem() {}, clear() {} };
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { activeElement: null, getElementById: () => null, querySelector: () => null, body: null };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener() {}, removeEventListener() {}, scrollTo() {}, location: { href: '', search: '', hash: '' } };
}
// react-native-web's Image asks the browser to load the source; here it never loads (no network in this spec).
globalThis.window.Image = class { set src(_v) {} };
globalThis.window.localStorage = fakeStorage;
globalThis.window.sessionStorage = fakeStorage;
globalThis.localStorage = fakeStorage;
globalThis.sessionStorage = fakeStorage;

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TestRenderer = require('react-test-renderer');
const ts = require('typescript');
const { ROOT } = require('./load-ts.cjs');

const { act } = TestRenderer;
const h = React.createElement;

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

// ─── console capture: nothing patrol may log a link ──────────────────────────────────────────────────────────────

const logged = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' '));
    if (level === 'log' && typeof args[0] === 'string' && /^(PASS|FAIL) |checks passed/.test(args[0])) original(...args);
    if (level === 'error' && typeof args[0] === 'string' && /^FAIL|^ {6}/.test(args[0])) original(...args);
  };
}

// ─── the stubbed API: every patrol call is recorded; answers come from `answers` ─────────────────────────────────

const api = loadSource('src/services/api.ts');
const calls = [];
let answers = {};
for (const key of Object.keys(api)) {
  if (typeof api[key] !== 'function' || /^[A-Z]/.test(key)) continue;
  api[key] = async (...args) => {
    calls.push([key, args]);
    const answer = answers[key];
    if (typeof answer === 'function') return answer(...args);
    if (answer !== undefined) return answer;
    return [];
  };
}
globalThis.fetch = async () => { throw new Error('no network in this spec'); };
const patrolCalls = () => calls.filter(([k]) => /Patrol/.test(k));

const settle = async (n = 6) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const textOf = (node) => {
  const words = [];
  const walk = (n) => { if (typeof n === 'string') { words.push(n); return; } if (n && n.children) n.children.forEach(walk); };
  walk(node);
  return words.join('');
};
const pressables = (root, text) => root.findAll((n) => n.props && typeof n.props.onPress === 'function' && (textOf(n).trim() === text || n.props.accessibilityLabel === text));
const pressByText = async (root, text) => {
  const nodes = pressables(root, text);
  assert.ok(nodes.length > 0, `a "${text}" control`);
  await act(async () => { await nodes[0].props.onPress({ stopPropagation() {} }); });
  await settle();
};
const has = (root, text) => pressables(root, text).length > 0;

// ─── intervals: the page's 30 s refreshes, recorded so a test can see which are running and fire them ─────────────
const intervals = new Map();
let nextInterval = 1;
globalThis.setInterval = (fn, ms) => { const id = nextInterval++; intervals.set(id, { fn, ms }); return id; };
globalThis.clearInterval = (id) => { intervals.delete(id); };
const polling = () => [...intervals.values()].filter((i) => i.ms === 30_000);
const firePolls = async () => { for (const i of polling()) i.fn(); await settle(); };

const access = loadSource('src/components/patrols/patrolAccess.ts');
const M = loadSource('src/components/patrols/patrolMonitorPresentation.ts');
const { CompanyPatrolsWorkspace } = loadSource('src/components/patrols/CompanyPatrolsWorkspace.tsx');

// ─── fixtures (fictional) ─────────────────────────────────────────────────────────────────────────────────────

const ROLE_SESSIONS = {
  owner: ['patrols.view', 'patrols.manage', 'patrols.evidence', 'patrols.holds', 'alerts.manage'],
  control_room: ['patrols.view', 'patrols.evidence', 'alerts.manage'],
  viewer: ['patrols.view', 'shifts.view'],
  guard: [],
};
const perms = (role) => access.resolvePatrolPermissions(ROLE_SESSIONS[role], role === 'guard' ? 'guard' : 'company_staff');

const DAY = '2026-11-03'; // a GMT day at a London site: site time = UTC
const Z = (hhmm, day = DAY) => `${day}T${hhmm}:00.000Z`;
const pad = (n) => String(n).padStart(2, '0');

function counts(over = {}) {
  return { windows: 0, owed: 0, verified: 0, verifiedOnTime: 0, lateVerified: 0, inProgress: 0, awaitingVerification: 0, missed: 0, missedOpen: 0,
    incomplete: 0, flagged: 0, notVerified: 0, overdue: 0, due: 0, awaitingCheck: 0, future: 0, verificationOverdue: 0, openExceptions: 0, openAlerts: 0, ...over };
}
function summarySite(id, name, status, over = {}) {
  return { siteId: id, siteName: name, clientId: 1, clientName: 'Northwind Estates', timeZone: 'Europe/London', date: DAY,
    dayStart: Z('00:00'), dayEnd: Z('00:00', '2026-11-04'), status, counts: counts(), lanes: 1, nextWindowStart: null, ...over };
}
const SUMMARY_SITES = [
  // Deliberately out of priority order: the page orders them.
  summarySite(40, 'Charlie Yard', 'no_patrols', { lanes: 0 }),
  summarySite(20, 'Bravo Depot', 'on_track', { clientId: 2, clientName: 'Contoso Retail', counts: counts({ windows: 12, owed: 6, verified: 6, verifiedOnTime: 6, future: 6 }), nextWindowStart: Z('15:00') }),
  summarySite(50, 'Echo Park', 'not_started', { counts: counts({ windows: 4, future: 4 }), nextWindowStart: Z('18:00') }),
  summarySite(30, 'Delta Works', 'watch', { clientId: 2, clientName: 'Contoso Retail', counts: counts({ windows: 10, owed: 5, verified: 4, lateVerified: 1, verifiedOnTime: 3, notVerified: 1 }), nextWindowStart: Z('15:00') }),
  summarySite(10, 'Alpha Site', 'attention', { counts: counts({ windows: 12, owed: 5, verified: 3, verifiedOnTime: 2, lateVerified: 1, missed: 1, missedOpen: 1, flagged: 1, notVerified: 1, overdue: 1 }), nextWindowStart: Z('14:00') }),
];
function summary(over = {}) {
  return { generatedAt: Z('13:20'), dateBasis: 'site_local', date: DAY, sweep: { judgedThrough: Z('13:00') },
    totals: { ...counts(), sites: SUMMARY_SITES.length, byStatus: { attention: 1, watch: 1, on_track: 1, not_started: 1, no_patrols: 1 } },
    liveOps: { openPatrolAlerts: 2, missedToday: 1, missedTodayOpen: 1 }, sites: SUMMARY_SITES, ...over };
}

/** Site hours: `spec` is a list of [label, offset, startIso]; ends chain, the last ends at `end`. */
function hoursFrom(spec, end, currentIndex = -1) {
  return spec.map(([label, offset, start], i) => ({ index: i, start, end: spec[i + 1] ? spec[i + 1][2] : end, label, offset,
    repeated: spec.slice(0, i).some((s) => s[0] === label), current: i === currentIndex }));
}
const GMT_DAY_HOURS = hoursFrom(Array.from({ length: 24 }, (_, i) => [pad(i), 'GMT', Z(`${pad(i)}:00`)]), Z('00:00', '2026-11-04'), 13);

function win(key, startHH, state, over = {}) {
  return { key, scheduleId: 7, windowKey: key, scopeKey: 'site', anchor: 'clock', start: Z(startHH), end: Z(startHH.replace(':00', ':30')),
    startDeadline: Z(startHH.replace(':00', ':15')), state, runId: null, runGuardId: null, lateStart: state === 'late_verified', verificationOverdue: false,
    exceptionId: null, exceptionStatus: null, exceptionIds: [], alertId: null, alertStatus: null, ...over };
}
function cellsFor(windows, hours, fill = 'none', worst) {
  return hours.map((h) => {
    const ws = windows.filter((w) => w.start >= h.start && w.start < h.end);
    if (!ws.length) return { hour: h.index, state: fill, total: 0, owed: 0, verified: 0, windowKeys: [] };
    const state = worst?.[h.index] ?? ws[0].state;
    return { hour: h.index, state, total: ws.length, owed: ws.length, verified: ws.filter((w) => ['verified', 'late_verified'].includes(w.state)).length, windowKeys: ws.map((w) => w.key) };
  });
}
const SITE_WINDOWS = [
  win('w08', '08:00', 'verified', { runId: 501, runGuardId: 11 }),
  win('w09', '09:00', 'missed', { exceptionId: 61, exceptionStatus: 'open', exceptionIds: [61], alertId: 71, alertStatus: 'open' }),
  win('w10a', '10:00', 'verified', { runId: 502, runGuardId: 12 }),
  { ...win('w10b', '10:30', 'flagged', { runId: 503, runGuardId: 11 }), end: Z('11:00') },
  win('w11', '11:00', 'late_verified', { runId: 504, runGuardId: 12 }),
  win('w12', '12:00', 'overdue'),
  win('w13', '13:00', 'awaiting_check'),
  win('w14', '14:00', 'future'),
];
const RUN = (id, guardId, guardName, over = {}) => ({ id, guardId, guardName, shiftId: 81, status: 'completed', verificationStatus: 'verified', lateStart: false,
  windowStart: null, windowEnd: null, startedAtServer: Z('08:03'), startedAtDevice: Z('08:03'), completedAtServer: Z('08:21'),
  checkpoints: { required: 4, verified: 4, scans: 4, repeatScans: 0, flaggedScans: 0, qrRuleMissing: false }, photos: { taken: 2, verified: 2, missing: 0 }, ...over });
function siteDetail(over = {}) {
  const hours = over.hours ?? GMT_DAY_HOURS;
  const nightShift = { start: '2026-11-02T22:00:00.000Z', end: Z('06:00') };
  const guardWindows = [win('g01', '01:00', 'verified', { scopeKey: 'shift:81', runId: 505, runGuardId: 11 })];
  return {
    generatedAt: Z('13:20'), siteId: 10, siteName: 'Alpha Site', clientId: 1, clientName: 'Northwind Estates', timeZone: 'Europe/London',
    range: { from: hours[0].start, to: hours[hours.length - 1].end, date: DAY }, sweep: { judgedThrough: Z('13:00') },
    policy: { requirementScope: 'site', methods: ['qr', 'photo'], startGraceMinutes: 15, photoRequired: true }, setup: { active: true, mode: 'scheduled' },
    status: 'attention', counts: SUMMARY_SITES[4].counts, nextWindowStart: Z('14:00'), hours,
    lanes: [
      { key: 'site', kind: 'site', shiftId: null, guardId: null, guardName: null, shiftStart: null, shiftEnd: null, shiftStatus: null, requirement: null,
        windows: SITE_WINDOWS, cells: cellsFor(SITE_WINDOWS, hours, 'none', { 10: 'flagged' }) },
      { key: 'shift:81', kind: 'shift', shiftId: 81, guardId: 11, guardName: 'Ava Guard', shiftStart: nightShift.start, shiftEnd: nightShift.end, shiftStatus: 'completed',
        requirement: { effectiveRequired: true, value: 'required', source: 'site', summary: 'Patrols required' }, windows: guardWindows,
        cells: cellsFor(guardWindows, hours, 'not_required').map((c) => (c.total || hours[c.hour].start < nightShift.end ? c : { ...c, state: 'off_duty' })) },
    ],
    runs: {
      501: RUN(501, 11, 'Ava Guard'),
      502: RUN(502, 12, 'Ben Guard', { startedAtServer: Z('10:02'), completedAtServer: Z('10:20') }),
      503: RUN(503, 11, 'Ava Guard', { verificationStatus: 'flagged', startedAtServer: Z('10:31'), completedAtServer: Z('10:50'),
        checkpoints: { required: 4, verified: 3, scans: 5, repeatScans: 1, flaggedScans: 1, qrRuleMissing: false }, photos: { taken: 1, verified: 1, missing: 1 } }),
      504: RUN(504, 12, 'Ben Guard', { lateStart: true, startedAtServer: Z('11:22') }),
      505: RUN(505, 11, 'Ava Guard', { startedAtServer: Z('01:04') }),
    },
    otherRuns: [{ runId: 599, reason: 'unscheduled', exceptionIds: [] }],
    exceptions: { 61: { id: 61, type: 'patrol_missed', status: 'open', runId: null, alertId: 71, alertStatus: 'open' } },
    ...over,
  };
}
function answersWith(over = {}) {
  return {
    getPatrolPolicies: { defaults: {}, companyDefault: {}, sites: [{ siteId: 10, siteName: 'Alpha Site', timezone: 'Europe/London', policy: {} }], locationVerificationAvailable: false, extendedRetentionAllowed: true },
    listPatrolRoutes: [],
    listPatrolHolds: [],
    getPatrolMonitorSummary: () => summary(),
    getPatrolMonitorSite: (id) => (id === 10 ? siteDetail() : siteDetail({ siteId: id, siteName: `Site ${id}`, lanes: [], otherRuns: [] })),
    ...over,
  };
}
const refused = (status, code) => () => { const e = new Error('refused'); e.status = status; e.body = code ? { code, message: 'x' } : { message: 'Forbidden' }; throw e; };

async function open(props = {}) {
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(CompanyPatrolsWorkspace, { companyKey: 'co-1', layoutWidth: 1280, permissions: perms('owner'), ...props })); });
  await settle();
  return renderer;
}
const callsOf = (name) => calls.filter(([k]) => k === name);
const cardOrder = (root) => root.findAll((n) => typeof n.props?.testID === 'string' && /^patrol-monitor-site-\d+$/.test(n.props.testID) && typeof n.type !== 'string')
  .map((n) => Number(n.props.testID.split('-').pop()))
  .filter((id, i, all) => all.indexOf(id) === i);
const byTestId = (root, id) => root.findAll((n) => n.props && n.props.testID === id);
const flatStyle = (style) => (Array.isArray(style) ? Object.assign({}, ...style.flat(5).filter(Boolean)) : style || {});
const cellLabels = (root) => root.findAll((n) => typeof n.props?.accessibilityLabel === 'string' && /^(Site Patrol|Ava Guard|Ben Guard), \d\d:00( \(second time, [^)]*\))?: /.test(n.props.accessibilityLabel) && typeof n.type !== 'string')
  .map((n) => n.props.accessibilityLabel).filter((l, i, all) => all.indexOf(l) === i);
const allCalls = [];
function reset(over) { allCalls.push(...calls.map(([k]) => k)); answers = answersWith(over); calls.length = 0; intervals.clear(); }

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

// ═══ colours, labels and symbols ═══

test('PMUI-01-GREEN-ONLY-VERIFIED-ON-TIME-RED-ONLY-MISSED-EVERY-STATE-LABELLED', () => {
  const states = Object.keys(M.MONITOR_STATE_INFO);
  assert.deepEqual(states.filter((s) => M.monitorStateTone(s) === 'success'), ['verified'], 'green: on-time, server-verified only');
  assert.deepEqual(states.filter((s) => M.monitorStateTone(s) === 'danger'), ['missed'], 'red: sweep-confirmed missed only');
  const amber = ['late_verified', 'awaiting_verification', 'incomplete', 'flagged', 'not_verified', 'overdue', 'awaiting_check'];
  assert.deepEqual(states.filter((s) => M.monitorStateTone(s) === 'warning').sort(), [...amber].sort());
  assert.deepEqual(states.filter((s) => M.monitorStateTone(s) === 'info').sort(), ['due', 'in_progress']);
  assert.deepEqual(states.filter((s) => M.monitorStateTone(s) === 'blank').sort(), ['none', 'not_required', 'off_duty']);
  // Every window state: a text label AND a symbol.
  for (const s of states.filter((x) => M.monitorStateTone(x) !== 'blank')) {
    const info = M.monitorStateInfo(s);
    assert.ok(info.label && info.symbol && info.description, `${s}: label, symbol and description`);
  }
  for (const s of ['none', 'off_duty', 'not_required']) assert.ok(M.monitorStateInfo(s).label, `${s}: still labelled for screen readers`);
  // Owner decisions 1 and 2.
  assert.equal(M.monitorStateInfo('flagged').label, 'Needs review');
  assert.equal(M.monitorStateInfo('not_verified').label, 'Needs review');
  assert.notEqual(M.monitorStateInfo('flagged').description, M.monitorStateInfo('not_verified').description, 'the detail says which');
  assert.equal(M.monitorStateInfo('overdue').label, 'Overdue');
  assert.equal(M.monitorStateInfo('awaiting_check').label, 'Awaiting check');
  assert.equal(M.monitorStateInfo('late_verified').label, 'Late · Verified');
  // Distinct labels and symbols, except the two that share "Needs review".
  const labelled = states.filter((x) => M.monitorStateTone(x) !== 'blank' && x !== 'not_verified');
  assert.equal(new Set(labelled.map((s) => M.monitorStateInfo(s).label)).size, labelled.length, 'distinct labels');
  assert.equal(new Set(labelled.map((s) => M.monitorStateInfo(s).symbol)).size, labelled.length, 'distinct symbols');
  assert.equal(M.monitorStateInfo('verified').symbol === M.monitorStateInfo('late_verified').symbol, false, 'late is not drawn as on-time');
  assert.equal(M.monitorStateInfo('something_new').tone, 'blank', 'an unknown state is never drawn green or red');
});

// ═══ navigation ═══

test('PMUI-02-MONITOR-IS-FIRST-AND-THE-DEFAULT-AND-OPENING-READS-THE-SUMMARY-ONCE', async () => {
  assert.deepEqual(access.PATROL_SECTIONS.map((s) => s.label), ['Monitor', 'Setup', 'Today', 'Evidence', 'Advanced']);
  assert.equal(access.DEFAULT_PATROL_SECTION, 'monitor');
  assert.deepEqual(access.visiblePatrolSections(perms('viewer')), ['monitor', 'setup', 'today', 'evidence', 'advanced']);
  for (const role of ['owner', 'viewer']) {
    reset();
    const r = await open({ permissions: perms(role) });
    const monitorChip = pressables(r.root, 'Monitor')[0];
    assert.equal(monitorChip.props.accessibilityState.selected, true, `${role}: opens on Monitor`);
    assert.equal(byTestId(r.root, 'patrol-monitor').length > 0, true);
    assert.equal(has(r.root, 'Site: All sites'), false, 'the cards are the site list: no separate site picker');
    assert.equal(callsOf('getPatrolMonitorSummary').length, 1, 'one summary read');
    assert.deepEqual(callsOf('getPatrolMonitorSummary')[0][1], [{ date: null }], 'today at each site');
    assert.equal(callsOf('getPatrolMonitorSite').length, 0, 'no site is read until expanded');
    assert.equal(callsOf('getPatrolRun').length + calls.filter(([k]) => /Evidence|Thumbnail|Signed/.test(k)).length, 0, 'no patrol record or evidence read');
    act(() => r.unmount());
  }
});

test('PMUI-03-SETUP-TODAY-EVIDENCE-AND-ADVANCED-ARE-PRESERVED', async () => {
  reset({
    getPatrolOverview: { date: DAY, dateBasis: 'site_local', timeZone: null, siteId: null, runsStarted: 1, runsByStatus: { in_progress: 0, completed: 1, incomplete: 0, closed_by_system: 0 },
      inProgressNow: 0, flaggedScans: 0, openExceptions: 0, activeCheckpoints: 0, activeSchedules: 0, activeRoutes: 0 },
    getPatrolWindowsDay: { date: DAY, dateBasis: 'site_local', siteId: null, generatedAt: Z('13:20'), windowsDue: 0, windowsCompleted: 0, windowsOutstanding: 0, completionBasis: 'window_with_a_completed_run', sites: [] },
    listPatrolRuns: { items: [], total: 0, page: 1, pageSize: 25 },
    // Setup's own read, refused here: the section still mounts and asks for its site.
    getPatrolSiteSetup: refused(403),
  });
  const r = await open();
  await pressByText(r.root, 'Today');
  assert.ok(textOf(r.root).includes('Live patrols'), 'Today: the overview and live patrols');
  assert.ok(has(r.root, 'Site: All sites'), 'Today keeps the page\'s site picker');
  assert.equal(byTestId(r.root, 'patrol-monitor').length, 0, 'Monitor unmounted');
  await pressByText(r.root, 'Setup');
  assert.ok(callsOf('getPatrolSiteSetup').length > 0, 'Setup reads the site setup');
  await pressByText(r.root, 'Evidence');
  assert.ok(calls.some(([k]) => /^getPatrolEvidence/.test(k)), 'Evidence opens the evidence browser');
  await pressByText(r.root, 'Advanced');
  for (const tab of access.PATROL_TABS) assert.ok(has(r.root, tab.label), `Advanced → ${tab.label}`);
  await pressByText(r.root, 'Monitor');
  assert.ok(byTestId(r.root, 'patrol-monitor').length > 0);
  act(() => r.unmount());
  // A record opened from Live Operations still lands on its tab.
  reset({ getPatrolRun: { run: { id: 5, siteId: 10, guardId: 11, status: 'completed', verificationStatus: 'verified', syncFlags: [] }, visits: [], exceptions: [], evidenceCount: 0, evidenceRestricted: false, evidence: [] } });
  const t = await open({ target: { requestId: 1, kind: 'run', runId: 5 } });
  assert.ok(textOf(t.root).includes('Patrol #5') && has(t.root, 'History'));
  act(() => t.unmount());
});

// ═══ the cards ═══

test('PMUI-04-ATTENTION-FIRST-THEN-ON-TRACK-THEN-NO-PATROLS-DUE', async () => {
  const pure = M.sortMonitorSites(SUMMARY_SITES).map((s) => s.siteId);
  assert.deepEqual(pure, [10, 30, 20, 50, 40], 'attention, watch, on track, not started, no patrols');
  assert.deepEqual(SUMMARY_SITES.map((s) => s.siteId), [40, 20, 50, 30, 10], 'input not mutated');
  // Within a status: more missed first, then more needing review.
  const twins = [summarySite(1, 'A', 'attention'), summarySite(2, 'B', 'attention', { counts: counts({ missed: 2 }) }), summarySite(3, 'C', 'attention', { counts: counts({ flagged: 1 }) })];
  assert.deepEqual(M.sortMonitorSites(twins).map((s) => s.siteId), [2, 3, 1]);
  reset();
  const r = await open();
  assert.deepEqual(cardOrder(r.root), [10, 30, 20, 50, 40], 'rendered in priority order');
  const text = textOf(r.root);
  assert.ok(text.indexOf('Needs attention (2)') < text.indexOf('On track (1)') && text.indexOf('On track (1)') < text.indexOf('No patrols due (2)'), 'grouped with headings');
  act(() => r.unmount());
});

test('PMUI-05-A-COLLAPSED-CARD-SHOWS-SITE-CLIENT-VERIFIED-MISSED-REVIEW-AND-NEXT-WINDOW', async () => {
  reset();
  const r = await open();
  const card = byTestId(r.root, 'patrol-monitor-site-10')[0];
  const text = textOf(card);
  for (const part of ['Alpha Site', 'Northwind Estates', '! Needs attention', '✓ Verified 3/5', '12 today', '✕ Missed 1', '⚑ Needs review 2', '○ Next 14:00']) {
    assert.ok(text.includes(part), `collapsed card: ${part}`);
  }
  assert.equal(/Overdue|Incomplete|Late \d/.test(text), false, 'compact: only verified, missed, needs review and the next window');
  assert.ok(textOf(byTestId(r.root, 'patrol-monitor-site-40')[0]).includes('No more patrols due'));
  assert.ok(textOf(byTestId(r.root, 'patrol-monitor-site-20')[0]).includes('Missed 0'), 'a zero is shown, not hidden');
  // Live Operations counts on today.
  assert.ok(textOf(r.root).includes('Open patrol alerts: 2') && textOf(r.root).includes('Missed today: 1 (1 open)'));
  // The missed chip is the only red on a collapsed card, and only when something was missed.
  const P = loadSource('src/components/patrols/PatrolMonitorMarks.tsx');
  const red = P.monitorPalette('danger').bg;
  const reds = (id) => byTestId(r.root, `patrol-monitor-site-${id}`)[0].findAll((n) => typeof n.type !== 'string' && flatStyle(n.props.style).backgroundColor === red);
  assert.ok(reds(10).length >= 1 && reds(20).length === 0, 'red only where a patrol was missed');
  act(() => r.unmount());
});

test('PMUI-06-CLIENT-AND-STATUS-FILTERS-NEED-NO-EXTRA-REQUEST', async () => {
  assert.deepEqual(M.monitorClients(SUMMARY_SITES), [{ id: 2, name: 'Contoso Retail' }, { id: 1, name: 'Northwind Estates' }]);
  reset();
  const r = await open();
  await pressByText(r.root, 'Client: Contoso Retail');
  assert.deepEqual(cardOrder(r.root), [30, 20]);
  await pressByText(r.root, 'Show: Needs attention');
  assert.deepEqual(cardOrder(r.root), [30]);
  await pressByText(r.root, 'Client: All clients');
  await pressByText(r.root, 'Show: No patrols due');
  assert.deepEqual(cardOrder(r.root), [50, 40]);
  await pressByText(r.root, 'Client: Contoso Retail');
  assert.ok(textOf(r.root).includes('No site matches these filters.'));
  assert.equal(callsOf('getPatrolMonitorSummary').length, 1, 'filters read nothing');
  // Another company: nothing carried over (filters, day, open cards), and its own summary is read.
  await pressByText(r.root, 'Show: All sites');
  await pressByText(r.root, 'Expand Delta Works');
  await act(async () => { r.update(h(CompanyPatrolsWorkspace, { companyKey: 'co-2', layoutWidth: 1280, permissions: perms('owner') })); });
  await settle();
  assert.deepEqual(cardOrder(r.root), [10, 30, 20, 50, 40], 'all sites again');
  assert.equal(has(r.root, 'Collapse Delta Works'), false, 'no card left open');
  assert.equal(callsOf('getPatrolMonitorSummary').length, 2, 'the new company\'s own summary');
  act(() => r.unmount());
});

// ═══ loading and refresh ═══

test('PMUI-07-SITE-DETAIL-ONLY-WHEN-EXPANDED-AND-REFRESHED-ONLY-WHILE-EXPANDED-AND-VISIBLE', async () => {
  reset();
  const r = await open();
  assert.equal(polling().length, 1, 'today: the summary refreshes');
  await firePolls();
  assert.equal(callsOf('getPatrolMonitorSummary').length, 2);
  assert.equal(callsOf('getPatrolMonitorSite').length, 0, 'a refresh reads no site');
  await pressByText(r.root, 'Expand Alpha Site');
  assert.deepEqual(callsOf('getPatrolMonitorSite').map(([, a]) => a), [[10, { date: DAY }]], 'the expanded site, on its own day');
  assert.equal(pressables(r.root, 'Collapse Alpha Site')[0].props.accessibilityState.expanded, true);
  assert.equal(polling().length, 2, 'summary + the expanded site');
  await firePolls();
  assert.equal(callsOf('getPatrolMonitorSite').length, 2);
  await pressByText(r.root, 'Collapse Alpha Site');
  assert.equal(polling().length, 1, 'collapsing stops the site refresh');
  assert.equal(byTestId(r.root, 'patrol-monitor-detail-10').length, 0);
  await firePolls();
  assert.equal(callsOf('getPatrolMonitorSite').length, 2, 'nothing read for a collapsed site');
  act(() => r.unmount());
  assert.equal(polling().length, 0, 'unmount clears every refresh');
  // A hidden page refreshes nothing.
  reset();
  globalThis.document.visibilityState = 'hidden';
  try {
    const hidden = await open();
    await pressByText(hidden.root, 'Expand Alpha Site');
    assert.equal(polling().length, 0, 'hidden: no refresh at all');
    act(() => hidden.unmount());
  } finally { delete globalThis.document.visibilityState; }
});

test('PMUI-08-THE-DATE-SELECTOR-DEFAULTS-TO-TODAY-AND-A-PAST-DAY-IS-NOT-REFRESHED', async () => {
  assert.equal(M.shiftMonitorDate('2026-03-01', -1), '2026-02-28');
  assert.equal(M.shiftMonitorDate('2026-12-31', 1), '2027-01-01');
  assert.equal(M.monitorDateLabel('2026-11-03'), 'Tue 03/11/2026');
  reset({ getPatrolMonitorSummary: (q) => summary({ date: q.date ?? DAY, sites: SUMMARY_SITES.map((s) => ({ ...s, date: q.date ?? DAY })) }) });
  const r = await open();
  assert.ok(textOf(r.root).includes('Today') && textOf(r.root).includes('Tue 03/11/2026'));
  const next = pressables(r.root, 'Next day')[0];
  assert.ok(next.props.disabled === true || next.props.accessibilityState?.disabled === true, 'no day after today');
  await pressByText(r.root, 'Previous day');
  assert.deepEqual(callsOf('getPatrolMonitorSummary').map(([, a]) => a[0].date), [null, '2026-11-02']);
  assert.ok(textOf(r.root).includes('Mon 02/11/2026') && textOf(r.root).includes('not refreshed'));
  assert.equal(textOf(r.root).includes('Open patrol alerts'), false, 'the live counts are for today only');
  assert.equal(polling().length, 0, 'a past day is not refreshed');
  await pressByText(r.root, 'Expand Alpha Site');
  assert.deepEqual(callsOf('getPatrolMonitorSite').map(([, a]) => a), [[10, { date: '2026-11-02' }]]);
  assert.equal(polling().length, 0, 'nor is an expanded site on a past day');
  await pressByText(r.root, 'Next day');
  assert.equal(callsOf('getPatrolMonitorSummary').at(-1)[1][0].date, null, 'stepping forward to today is today');
  await pressByText(r.root, 'Previous day');
  await pressByText(r.root, 'Back to today');
  assert.equal(callsOf('getPatrolMonitorSummary').at(-1)[1][0].date, null);
  assert.ok(polling().length >= 1, 'today refreshes again');
  act(() => r.unmount());
});

// ═══ the grid ═══

test('PMUI-09-SITE-PATROL-ROW-GUARD-ROWS-AND-OVERNIGHT-SHIFTS', async () => {
  reset();
  const r = await open();
  await pressByText(r.root, 'Expand Alpha Site');
  const names = byTestId(r.root, 'patrol-monitor-lane-names')[0];
  const t = textOf(names);
  assert.ok(t.includes('Site Patrol') && t.includes('Any Guard on duty'), 'one shared Site Patrol row');
  assert.ok(t.includes('Ava Guard') && t.includes('22:00 (−1 day) – 06:00'), 'the guard row with its overnight shift');
  assert.ok(textOf(r.root).includes('Site-wide patrols: any Guard on duty can complete them.'));
  assert.ok(textOf(r.root).includes('1 other patrol (unscheduled'), 'extra patrols are said, never counted');
  assert.ok(textOf(r.root).includes('Missed patrols checked by S4 up to 13:00'));
  const labels = cellLabels(r.root);
  assert.ok(labels.includes('Site Patrol, 08:00: Verified') && labels.includes('Site Patrol, 09:00: Missed'));
  assert.ok(labels.includes('Ava Guard, 01:00: Verified'), 'the guard\'s own patrol on its row');
  assert.ok(labels.includes('Ava Guard, 12:00: Off duty') && labels.includes('Ava Guard, 03:00: No patrol required'));
  act(() => r.unmount());
  // A per-guard site has no Site Patrol row.
  reset({ getPatrolMonitorSite: () => { const d = siteDetail(); return { ...d, policy: { ...d.policy, requirementScope: 'per_guard' }, lanes: d.lanes.filter((l) => l.kind === 'shift') }; } });
  const g = await open();
  await pressByText(g.root, 'Expand Alpha Site');
  const gt = textOf(byTestId(g.root, 'patrol-monitor-lane-names')[0]);
  assert.ok(!gt.includes('Site Patrol') && gt.includes('Ava Guard'));
  assert.ok(textOf(g.root).includes('Each Guard on duty owes their own patrols.'));
  act(() => g.unmount());
});

test('PMUI-10-SEVERAL-PATROLS-IN-AN-HOUR-READ-1-OF-2', async () => {
  assert.equal(M.monitorCellCount({ total: 2, verified: 1 }), '1/2');
  assert.equal(M.monitorCellCount({ total: 1, verified: 1 }), null, 'one window: the symbol alone');
  reset();
  const r = await open();
  await pressByText(r.root, 'Expand Alpha Site');
  assert.ok(cellLabels(r.root).includes('Site Patrol, 10:00: Needs review, 1 of 2 verified'));
  const cell = pressables(r.root, 'Site Patrol, 10:00: Needs review, 1 of 2 verified')[0];
  assert.equal(textOf(cell), '⚑1/2', 'symbol and count, never colour alone');
  act(() => r.unmount());
});

test('PMUI-11-CLOCK-CHANGE-DAYS-25-AND-23-HOURS', async () => {
  // 25 Oct 2026, London: 01:00 happens twice (BST then GMT).
  const autumn = hoursFrom([
    ['00', 'GMT+1', '2026-10-24T23:00:00.000Z'], ['01', 'GMT+1', '2026-10-25T00:00:00.000Z'], ['01', 'GMT', '2026-10-25T01:00:00.000Z'],
    ...Array.from({ length: 22 }, (_, i) => [pad(i + 2), 'GMT', `2026-10-25T${pad(i + 2)}:00:00.000Z`]),
  ], '2026-10-26T00:00:00.000Z');
  assert.equal(autumn.length, 25);
  assert.deepEqual(autumn.map((h, i) => M.monitorHourLabel(h)).slice(0, 4), ['00', '01', '01 (2nd)', '02']);
  assert.deepEqual(autumn.map((_, i) => M.monitorHourOffsetShown(autumn, i)).slice(0, 4), [true, false, true, false], 'the offset where it changes');
  // 29 Mar 2026: 01:00 does not happen.
  const spring = hoursFrom([['00', 'GMT', '2026-03-29T00:00:00.000Z'], ...Array.from({ length: 22 }, (_, i) => [pad(i + 2), 'GMT+1', `2026-03-29T${pad(i + 1)}:00:00.000Z`])], '2026-03-29T23:00:00.000Z');
  assert.equal(spring.length, 23);
  for (const [hours, n] of [[autumn, 25], [spring, 23]]) {
    reset({ getPatrolMonitorSite: () => { const d = siteDetail({ hours }); return { ...d, lanes: d.lanes.slice(0, 1).map((l) => ({ ...l, windows: [], cells: cellsFor([], hours) })) }; } });
    const r = await open();
    await pressByText(r.root, 'Expand Alpha Site');
    const header = byTestId(r.root, 'patrol-monitor-hours')[0];
    const heads = header.findAll((n) => typeof n.type !== 'string' && typeof n.props.accessibilityLabel === 'string' && /^\d\d:00/.test(n.props.accessibilityLabel)).map((n) => n.props.accessibilityLabel).filter((l, i, a) => a.indexOf(l) === i);
    assert.equal(heads.length, n, `${n} hour columns`);
    if (n === 25) {
      assert.ok(heads.includes('01:00') && heads.includes('01:00 second time, GMT'), 'the repeated hour is marked');
      assert.ok(textOf(header).includes('01 (2nd)'));
    } else {
      assert.ok(!heads.includes('01:00'), 'the skipped hour is absent');
    }
    assert.equal(cellLabels(r.root).length, n, 'one cell per hour');
    act(() => r.unmount());
  }
  // Site-local clock and day marks.
  assert.equal(M.monitorClockOnDay('2026-07-01T21:30:00.000Z', 'Europe/London', '2026-07-01'), '22:30', 'BST');
  assert.equal(M.monitorClockOnDay('2026-07-01T23:30:00.000Z', 'Europe/London', '2026-07-01'), '00:30 (+1 day)');
  assert.equal(M.monitorClockOnDay('2026-07-01T23:30:00.000Z', 'Asia/Kolkata', '2026-07-02'), '05:00');
});

test('PMUI-12-A-CELL-OPENS-COUNTS-WITH-NO-REQUEST-AND-LINKS-TO-THE-AUDITED-RECORD', async () => {
  const opened = [];
  reset({ getPatrolRun: (id) => { opened.push(id); return { run: { id, siteId: 10, guardId: 11, status: 'completed', verificationStatus: 'flagged', syncFlags: [] }, visits: [], exceptions: [], evidenceCount: 1, evidenceRestricted: false, evidence: [] }; } });
  const liveOps = [];
  const r = await open({ onOpenLiveOperationsAlert: (t) => liveOps.push(t) });
  await pressByText(r.root, 'Expand Alpha Site');
  const before = calls.length;
  await pressByText(r.root, 'Site Patrol, 10:00: Needs review, 1 of 2 verified');
  assert.equal(calls.length, before, 'opening a cell requests nothing');
  const detail = byTestId(r.root, 'patrol-monitor-cell-detail')[0];
  const text = textOf(detail);
  assert.ok(textOf(r.root).includes('Site Patrol · 10:00 – 11:00'), 'the hour');
  assert.ok(text.includes('1 of 2 patrols in this hour verified.'));
  for (const part of ['10:00 – 10:30', 'Verified', 'Ben Guard', '10:30 – 11:00', 'Needs review', 'flagged scan', 'Ava Guard',
    '3 of 4 verified · 5 scans · 1 repeat · 1 flagged', '1 taken · 1 verified · 1 missing', 'Started (received by S4)10:31']) {
    assert.ok(text.includes(part), `cell detail: ${part}`);
  }
  assert.equal(/https?:|X-Amz|signature|thumbnail/i.test(text), false, 'no link in the detail');
  assert.equal(calls.filter(([k]) => /Evidence|Thumbnail|Signed/.test(k)).length, 0, 'no evidence request');
  // The photos stay behind the existing audited patrol record.
  await pressByText(r.root, 'Open patrol record and photos');
  assert.deepEqual(opened, [502], 'the first window\'s patrol, through the existing record');
  assert.equal(byTestId(r.root, 'patrol-monitor-cell-detail').length, 0, 'the cell closes');
  // A missed window: the exception and Live Operations.
  await pressByText(r.root, 'Site Patrol, 09:00: Missed');
  const missed = textOf(byTestId(r.root, 'patrol-monitor-cell-detail')[0]);
  assert.ok(missed.includes('Confirmed missed by S4.') && missed.includes('No patrol recorded') && missed.includes('ExceptionOpen'));
  await pressByText(r.root, 'Open in Live Operations');
  assert.deepEqual(liveOps, [{ alertId: 71, shiftId: null }]);
  act(() => r.unmount());
  // A Viewer: the record without the word photos.
  reset();
  const v = await open({ permissions: perms('viewer') });
  await pressByText(v.root, 'Expand Alpha Site');
  await pressByText(v.root, 'Site Patrol, 08:00: Verified');
  assert.ok(has(v.root, 'Open patrol record') && !has(v.root, 'Open patrol record and photos'));
  act(() => v.unmount());
});

test('PMUI-13-EVERY-CELL-HAS-A-TEXT-LABEL-AND-COLOUR-IS-NEVER-ALONE', async () => {
  reset();
  const r = await open();
  await pressByText(r.root, 'Expand Alpha Site');
  const labels = cellLabels(r.root);
  assert.equal(labels.length, 48, '24 hours × 2 rows, each labelled');
  for (const l of labels) assert.match(l, /: (Verified|Late · Verified|Missed|Needs review|Overdue|Awaiting check|Upcoming|No patrol window|Off duty|No patrol required)/);
  // Every coloured cell draws a symbol.
  const cells = r.root.findAll((n) => typeof n.props?.accessibilityLabel === 'string' && /^(Site Patrol|Ava Guard), \d\d:00: (?!No patrol window|Off duty|No patrol required)/.test(n.props.accessibilityLabel) && typeof n.type !== 'string');
  for (const c of cells) assert.ok(/[✓◷✕⚑!?○●▶…◐–·]/.test(textOf(c)), `${c.props.accessibilityLabel}: a symbol`);
  assert.ok(r.root.findAll((n) => n.props?.accessibilityLabel === 'Key to the patrol cells').length > 0, 'a key');
  act(() => r.unmount());
});

// ═══ layouts ═══

test('PMUI-14-MOBILE-375-AND-DESKTOP-1280-LAYOUTS', async () => {
  assert.deepEqual(M.monitorGridLayout({ mode: 'mobile' }), { nameWidth: 112, cellSize: 44 });
  assert.deepEqual(M.monitorGridLayout({ mode: 'desktop' }), { nameWidth: 200, cellSize: 44 });
  for (const [width, nameWidth] of [[375, 112], [1280, 200]]) {
    reset();
    const r = await open({ layoutWidth: width });
    await pressByText(r.root, 'Expand Alpha Site');
    const names = byTestId(r.root, 'patrol-monitor-lane-names').find((n) => typeof n.type !== 'string');
    assert.equal(flatStyle(names.props.style).width, nameWidth, `${width}px: the fixed name column`);
    const scroller = byTestId(r.root, 'patrol-monitor-hours')[0];
    assert.equal(scroller.props.horizontal, true, `${width}px: the hours scroll sideways`);
    assert.ok(!scroller.findAll((n) => n.props && n.props.testID === 'patrol-monitor-lane-names').length, 'the names are outside the scrolling hours');
    const cell = pressables(r.root, 'Site Patrol, 08:00: Verified')[0];
    const s = flatStyle(typeof cell.props.style === 'function' ? cell.props.style({ pressed: false }) : cell.props.style);
    assert.ok(s.width >= 44 && s.height >= 44, `${width}px: a 44 px touch target`);
    await pressByText(r.root, 'Site Patrol, 08:00: Verified');
    const drawerWidth = r.root.findAll((n) => n.props && n.props.title === 'Site Patrol · 08:00 – 09:00' && typeof n.props.width === 'number')[0].props.width;
    assert.equal(drawerWidth > 1000, width < 768, `${width}px: the cell detail is full screen only on mobile`);
    act(() => r.unmount());
  }
});

// ═══ states ═══

test('PMUI-15-EMPTY-FORBIDDEN-AND-SWITCHED-OFF', async () => {
  reset({ getPatrolMonitorSummary: () => summary({ sites: [] }) });
  let r = await open();
  assert.ok(textOf(r.root).includes('No site has patrols set up.'));
  act(() => r.unmount());
  reset({ getPatrolMonitorSummary: refused(403) });
  r = await open({ permissions: perms('viewer') });
  assert.ok(textOf(r.root).includes('Not available to your role'));
  assert.equal(polling().length, 0, 'a refusal is not retried');
  act(() => r.unmount());
  reset({ getPatrolMonitorSummary: refused(404, 'PATROLS_NOT_ENABLED') });
  r = await open();
  assert.ok(textOf(r.root).includes('Patrol Management is not enabled'));
  assert.equal(polling().length, 0);
  act(() => r.unmount());
  // A site read refused while the card is open: shown in the card, the rest of the page stays.
  reset({ getPatrolMonitorSite: refused(403) });
  r = await open();
  await pressByText(r.root, 'Expand Alpha Site');
  assert.ok(textOf(byTestId(r.root, 'patrol-monitor-detail-10')[0]).includes('Not available to your role'));
  assert.equal(cardOrder(r.root).length, 5);
  act(() => r.unmount());
  // Without patrols.view (the switch off, or a Guard): nothing mounts and nothing is requested.
  reset();
  r = await open({ permissions: perms('guard') });
  assert.equal(calls.length, 0);
  assert.equal(byTestId(r.root, 'patrol-monitor').length, 0);
  act(() => r.unmount());
});

// ═══ read-only, no NFC, no Guard app ═══

test('PMUI-16-READ-ONLY-NO-NFC-NO-GUARD-APP', () => {
  assert.ok(calls.length >= 0);
  const files = ['patrolMonitorPresentation.ts', 'PatrolMonitorTab.tsx', 'PatrolMonitorSiteCard.tsx', 'PatrolMonitorCellDetail.tsx', 'PatrolMonitorMarks.tsx']
    .map((f) => [f, stripComments(read(`src/components/patrols/${f}`))]);
  for (const [f, src] of files) {
    assert.equal(/nfc/i.test(src), false, `${f}: no NFC`);
    const apiImports = [...src.matchAll(/import \{([^}]*)\} from '..\/..\/services\/api'/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
    for (const name of apiImports) assert.match(name, /^getPatrolMonitor(Summary|Site)$/, `${f}: reads only the Monitor endpoints`);
    assert.equal(/fetch\(|method:|localStorage|sessionStorage|AsyncStorage/.test(src), false, `${f}: no direct request or storage`);
    assert.equal(/screens\/Guard|components\/guard|guardPatrol/i.test(src), false, `${f}: nothing from the Guard app`);
  }
  const api = stripComments(read('src/services/api.ts'));
  for (const fn of ['getPatrolMonitorSummary', 'getPatrolMonitorSite']) {
    const body = api.slice(api.indexOf(`export function ${fn}`), api.indexOf('}\n', api.indexOf(`export function ${fn}`)));
    assert.ok(body.includes('/patrols/monitor/') && !/method/.test(body), `${fn}: a GET of the Monitor API`);
  }
  // Across this whole spec, every request the page made was a read.
  const names = [...new Set(allCalls)];
  assert.ok(names.includes('getPatrolMonitorSummary') && names.includes('getPatrolMonitorSite'));
  for (const n of names) assert.match(n, /^(get|list)/, `${n}: a read`);
  assert.equal(storageWrites.length, 0, 'nothing kept in browser storage');
  assert.equal(logged.some((l) => /https?:\/\/(?!react\.dev\/)/.test(l)), false, 'no link logged (React\'s own deprecation notice aside)');
});

test('PMUI-17-RELEASE-GATE-WIRING', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:patrol-monitor-ui'], 'node scripts/patrol-monitor-ui.spec.cjs');
  const gate = read('../.github/workflows/s4-mobile-release-gate.yml');
  assert.ok(/- name: Verify the Patrol Monitor \(company dashboard\)\n\s+run: npm run test:patrol-monitor-ui/.test(gate), 'the mobile release gate runs it');
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      passed += 1;
      console.log('PASS ', name);
    } catch (error) {
      console.error('FAIL ', name);
      console.error('      ' + (error && error.stack ? error.stack.split('\n').slice(0, 8).join('\n      ') : error));
      process.exitCode = 1;
    }
    allCalls.push(...calls.map(([k]) => k));
    calls.length = 0;
  }
  console.log(`\n${passed}/${pending.length} patrol monitor checks passed`);
  process.exit(process.exitCode || 0);
})();
