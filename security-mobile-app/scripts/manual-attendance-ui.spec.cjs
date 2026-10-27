#!/usr/bin/env node
/**
 * Manual attendance in the company web (S4 Part B): Book On / Book Off for Guard, Correct time, attendance history,
 * the Control Room grant, and feature detection against a backend that does not have it yet.
 *
 * WHAT IS CERTIFIED
 *   - The pure rules (src/components/company/manualAttendance.ts), executed: which actions a shift offers by status,
 *     the session permission, feature detection (a route-missing 404 = older server), form validation in the API's
 *     order (future, window start − 12 h .. end + 12 h, Book Off after Book On, unchanged correction, > 24 h needs an
 *     Owner/Admin, reason, method, note for "other"), every refusal code in words, the history chain with its badges
 *     and "Correct time" only on the chain tip, the Live Operations badges and the informational timesheet label.
 *   - The REAL CompanyDashboardScreen mounted with react-test-renderer on react-native-web, every effect running, the
 *     API module stubbed: against an OLD backend (capabilities 404) no manual action, form or history is shown and
 *     the short note is; against a NEW backend each action opens a form, needs a reason, a method and a confirmation,
 *     and then sends exactly ONE request with the body the API expects; a refusal is shown in words; a user without
 *     attendance.manage sees the history but no action; passive paths (polling, refresh) send nothing.
 *   - The client's routes and bodies, and the release-gate wiring.
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

// ─── fixtures, and the stubbed API ────────────────────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const LONDON = 'Europe/London';
const iso = (ms) => new Date(ms).toISOString();
const SITE = { id: 10, name: 'Merchant Fields', timezone: LONDON, status: 'active', client: { id: 3, name: 'Client' } };

function shift(id, status, startOffsetMs, guard = { id: 1, fullName: 'Ava Guard' }, lengthMs = 8 * HOUR) {
  const now = Date.now();
  return {
    id, status, siteId: SITE.id, siteName: SITE.name, site: SITE,
    start: iso(now + startOffsetMs), end: iso(now + startOffsetMs + lengthMs),
    guardId: guard ? guard.id : null, guard, assignment: null, jobApplication: null, checkCallIntervalMinutes: 60,
  };
}
const CAPABILITIES = {
  manualAttendance: true,
  verificationMethods: ['phone_call', 'supervisor_on_site', 'cctv', 'client_confirmation', 'radio', 'other'],
  windowBeforeStartHours: 12, windowAfterEndHours: 12, ownerAdminOnlyOlderThanHours: 24,
  canManage: true, canRecordOlderThan24h: true,
};
const view = (over) => ({
  id: 1, shiftId: 80, guardId: 1, type: 'check-in', occurredAt: iso(Date.now() - HOUR), recordedAt: iso(Date.now() - HOUR),
  source: 'guard_app', recordedByUserId: null, recordedByName: null, reason: null, verificationMethod: null, verificationNote: null,
  correctionOfEventId: null, correctedByEventId: null, isCorrection: false, effective: true, gpsVerified: true, nfcVerified: false,
  ...over,
});

const api = loadSource('src/services/api.ts');
const ApiError = api.ApiError;
const world = { shifts: [], attendance: [], capabilities: CAPABILITIES, history: null, refuse: null };
const calls = { mutations: [], capabilityReads: 0, historyReads: 0 };
const MUTATING = new Set(['manualBookOn', 'manualBookOff', 'correctAttendanceEvent', 'setControlRoomAttendanceAuthorisation', 'updateShift', 'reconcileShiftWithoutBookOff']);
for (const key of Object.keys(api)) {
  if (typeof api[key] !== 'function' || key === 'ApiError' || key === 'NetworkError' || /^[A-Z]/.test(key)) continue;
  if (MUTATING.has(key)) {
    api[key] = async (...args) => {
      calls.mutations.push([key, JSON.parse(JSON.stringify(args))]);
      if (world.refuse) throw world.refuse;
      if (key === 'correctAttendanceEvent') return { event: view({ id: 99 }), correctedEventId: args[0], timesheet: { restamped: true, approvalStatus: 'submitted' } };
      return { event: view({ id: 98, source: 'manual' }), shift: { id: args[0], status: 'in_progress' } };
    };
  } else {
    api[key] = async () => {
      if (key === 'getManualAttendanceCapabilities') {
        calls.capabilityReads += 1;
        if (world.capabilities instanceof Error) throw world.capabilities;
        return JSON.parse(JSON.stringify(world.capabilities));
      }
      if (key === 'getAttendanceHistory') {
        calls.historyReads += 1;
        return JSON.parse(JSON.stringify(world.history));
      }
      if (key === 'listShifts') return JSON.parse(JSON.stringify(world.shifts));
      if (key === 'listCompanyAttendance') return JSON.parse(JSON.stringify(world.attendance));
      if (key === 'listSites') return [SITE];
      return [];
    };
  }
}
globalThis.fetch = async (url, init = {}) => {
  const method = String(init.method || 'GET').toUpperCase();
  if (method !== 'GET') calls.mutations.push([`fetch ${method}`, [String(url)]]);
  return { ok: true, status: 200, json: async () => [], text: async () => '[]', headers: { get: () => null } };
};

const intervals = new Map();
let nextIntervalId = 1;
globalThis.setInterval = (fn) => { const id = nextIntervalId++; intervals.set(id, fn); return id; };
globalThis.clearInterval = (id) => { intervals.delete(id); };
const settle = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function tickPolling(times) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { for (const fn of [...intervals.values()]) fn(); });
    await settle();
  }
}

const { CompanyDashboardScreen } = loadSource('src/screens/CompanyDashboardScreen.tsx');
const { CompanyLiveOperationsWorkspace } = loadSource('src/components/company/CompanyLiveOperationsWorkspace.tsx');
const ma = loadSource('src/components/company/manualAttendance.ts');

const OWNER = { id: 1, email: 'owner@example.invalid', role: 'company_admin', firstName: 'Olive', lastName: 'Owner', status: 'active' };
const VIEWER = { ...OWNER, id: 2, companyPermissions: ['shifts.view', 'attendance.view'] };

async function mountDashboard(user = OWNER) {
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(CompanyDashboardScreen, { user, onLogout: () => {} })); });
  await settle();
  return renderer;
}
async function openShift(renderer, shiftId) {
  const nav = renderer.root.findAll((n) => n.props && typeof n.props.onNavigate === 'function')[0];
  await act(async () => { nav.props.onNavigate('live-operations'); });
  await settle();
  const ws = renderer.root.findAll((n) => n.type === CompanyLiveOperationsWorkspace)[0];
  assert.ok(ws, 'Live Operations is open');
  await act(async () => { ws.props.setSelectedShiftId(shiftId); });
  await settle();
}
const textOf = (node) => {
  const words = [];
  const walk = (n) => { if (typeof n === 'string') { words.push(n); return; } if (n && n.children) n.children.forEach(walk); };
  walk(node);
  return words.join(' ');
};
const screenText = (renderer) => textOf(renderer.root);
const isInside = (node, ancestor) => { for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true; return false; };
const outermost = (nodes) => nodes.filter((n) => !nodes.some((o) => o !== n && isInside(n, o)));
const pressables = (root, label) => outermost(root.findAll((n) => n.props && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function'));
const press = async (node) => { await act(async () => { await node.props.onPress({ stopPropagation() {} }); }); await settle(); };
const input = (root, label) => root.find((n) => n.props && n.props.accessibilityLabel === label && typeof n.props.onChangeText === 'function');
const type = async (root, label, value) => { await act(async () => { input(root, label).props.onChangeText(value); }); await settle(); };
const formModal = (renderer, title) => renderer.root.findAll((n) => n.type === 'test-modal').find((m) => textOf(m).includes(title) && textOf(m).includes('Actual time') || (textOf(m).includes(title) && textOf(m).includes('Verified by:'))) ?? null;

function reset({ shifts = [], attendance = [], capabilities = CAPABILITIES, history = null } = {}) {
  Object.assign(world, { shifts, attendance, capabilities, history, refuse: null });
  calls.mutations.length = 0;
  calls.capabilityReads = 0;
  calls.historyReads = 0;
  intervals.clear();
}
const OLD_BACKEND_404 = () => new ApiError(404, 'Not Found', { message: 'Cannot GET /attendance/manual/capabilities', error: 'Not Found', statusCode: 404 });

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

// ═══ pure rules ═══

const NOW = Date.parse('2026-10-27T15:00:00.000Z');
const pureShift = (status, startOffset, guard = { id: 1, fullName: 'Ava' }) => ({ status, start: iso(NOW + startOffset), end: iso(NOW + startOffset + 8 * HOUR), guard });

test('MA-01-ACTIONS-BY-STATUS', () => {
  const labels = (s, a) => ma.manualAttendanceActions(s, a, NOW, CAPABILITIES).map((x) => x.label);
  assert.deepEqual(labels(pureShift('ready', -40 * MIN), null), ['Book On for Guard']);
  assert.deepEqual(labels(pureShift('ready', 11 * HOUR), null), ['Book On for Guard'], 'within start − 12 h');
  assert.deepEqual(labels(pureShift('ready', 13 * HOUR), null), [], 'not before start − 12 h');
  assert.deepEqual(labels(pureShift('missed', -3 * HOUR), null), ['Book On for Guard (late arrival)']);
  assert.deepEqual(labels(pureShift('in_progress', -HOUR), { checkInAt: iso(NOW - HOUR), checkOutAt: null }), ['Book Off for Guard']);
  assert.deepEqual(labels(pureShift('completed', -20 * HOUR), { checkInAt: iso(NOW - 20 * HOUR), checkOutAt: null }), ['Book Off for Guard'], 'closed without Book Off');
  assert.deepEqual(labels(pureShift('completed', -20 * HOUR), { checkInAt: iso(NOW - 20 * HOUR), checkOutAt: iso(NOW - 12 * HOUR) }), []);
  for (const status of ['offered', 'cancelled', 'unfilled', 'rejected']) assert.deepEqual(labels(pureShift(status, -HOUR), null), [], status);
  assert.deepEqual(labels(pureShift('ready', -HOUR, null), null), [], 'no Guard: nothing to record');
  assert.deepEqual(labels(pureShift('ready', -HOUR), { checkInAt: iso(NOW - MIN), checkOutAt: null }), [], 'already booked on');
});

test('MA-02-PERMISSION-AND-FEATURE-DETECTION', () => {
  assert.equal(ma.canManageAttendanceFromSession(['attendance.manage'], 'company_staff'), true);
  assert.equal(ma.canManageAttendanceFromSession(['attendance.view', 'shifts.reconcile'], 'company_staff'), false, 'control room without the grant');
  assert.equal(ma.canManageAttendanceFromSession(undefined, 'company_admin'), true, 'legacy owner session');
  assert.equal(ma.canManageAttendanceFromSession(['attendance.manage'], 'guard'), false, 'never a Guard');
  assert.equal(ma.canManageAttendanceFromSession(['attendance.manage'], 'admin'), false, 'never a platform admin');
  assert.equal(ma.classifyCapabilitiesFailure(OLD_BACKEND_404()), 'unavailable', 'route-missing 404 = older server');
  assert.equal(ma.classifyCapabilitiesFailure(new ApiError(404, 'Not Found', { code: 'MANUAL_ATTENDANCE_NOT_FOUND', message: 'x' })), 'error', 'a coded 404 is not "old server"');
  assert.equal(ma.classifyCapabilitiesFailure(new ApiError(503, 'x', {})), 'error');
  assert.equal(ma.classifyCapabilitiesFailure(new Error('network')), 'error');
  assert.equal(ma.manualActionsOffered(true, { state: 'available', capabilities: CAPABILITIES }), true);
  for (const state of ['loading', 'unavailable', 'error']) assert.equal(ma.manualActionsOffered(true, { state }), false, state);
  assert.equal(ma.manualActionsOffered(false, { state: 'available', capabilities: CAPABILITIES }), false);
  assert.equal(ma.MANUAL_ATTENDANCE_UNAVAILABLE_NOTE, "Manual Book On/Off isn't available on this server yet.");
});

test('MA-03-FORM-VALIDATION-MIRRORS-THE-API', () => {
  const s = pureShift('ready', -2 * HOUR);
  const base = {
    kind: 'book_on', date: '2026-10-27', time: '14:00', timeZone: 'UTC', reason: 'Phone dead, called Control', method: 'phone_call', note: '',
    scheduledStart: s.start, scheduledEnd: s.end, nowMs: NOW, capabilities: CAPABILITIES,
  };
  const ok = ma.validateManualAttendance(base);
  assert.equal(ok.ok, true);
  assert.equal(ok.occurredAt, '2026-10-27T14:00:00.000Z', 'site-local converted to a UTC instant');
  assert.match(ma.validateManualAttendance({ ...base, time: '15:30' }).message, /cannot be in the future/);
  assert.match(ma.validateManualAttendance({ ...base, date: '2026-10-26', time: '00:00' }).message, /must be between/, 'before start − 12 h');
  const old = { ...base, scheduledStart: iso(NOW - 40 * HOUR), scheduledEnd: iso(NOW - 32 * HOUR), date: '2026-10-25', time: '23:30' };
  assert.equal(ma.validateManualAttendance(old).ok, true, 'Owner/Admin may record > 24 h old');
  assert.match(ma.validateManualAttendance({ ...old, capabilities: { ...CAPABILITIES, canRecordOlderThan24h: false } }).message, /Only an Owner or Admin/);
  const off = { ...base, kind: 'book_off', bookOnAt: '2026-10-27T14:30:00.000Z' };
  assert.match(ma.validateManualAttendance(off).message, /must be after the Book On/);
  assert.equal(ma.validateManualAttendance({ ...off, time: '14:45' }).ok, true);
  const corr = { ...base, kind: 'correct', eventType: 'check-in', currentOccurredAt: '2026-10-27T14:00:20.000Z' };
  assert.match(ma.validateManualAttendance(corr).message, /already recorded/);
  assert.match(ma.validateManualAttendance({ ...corr, time: '13:00', bookOffAt: '2026-10-27T12:30:00.000Z' }).message, /must be before the Book Off/);
  assert.match(ma.validateManualAttendance({ ...base, reason: '  ' }).message, /reason/);
  assert.match(ma.validateManualAttendance({ ...base, reason: 'x'.repeat(501) }).message, /500/);
  assert.match(ma.validateManualAttendance({ ...base, method: null }).message, /how the time was verified/);
  assert.match(ma.validateManualAttendance({ ...base, method: 'other', note: ' ' }).message, /Explain how/);
  assert.equal(ma.validateManualAttendance({ ...base, method: 'other', note: 'Neighbour saw him arrive' }).ok, true);
  assert.match(ma.validateManualAttendance({ ...base, time: '25:00' }).message, /valid date/);
  assert.deepEqual(ma.manualAttendancePayload({ occurredAt: 'T' }, { reason: ' r ', method: 'cctv', note: '' }), { occurredAt: 'T', reason: 'r', verificationMethod: 'cctv' });
  assert.deepEqual(ma.manualAttendancePayload({ occurredAt: 'T' }, { reason: 'r', method: 'other', note: ' n ' }), { occurredAt: 'T', reason: 'r', verificationMethod: 'other', verificationNote: 'n' });
  assert.deepEqual(ma.VERIFICATION_METHOD_OPTIONS.map((o) => o.value), CAPABILITIES.verificationMethods, 'the API\'s methods, in order');
});

const CONTRACT_CODES = [
  'MANUAL_ATTENDANCE_FORBIDDEN', 'MANUAL_ATTENDANCE_NOT_FOUND', 'ATTENDANCE_VALIDATION', 'ATTENDANCE_TIME_IN_FUTURE',
  'ATTENDANCE_TIME_OUTSIDE_WINDOW', 'ATTENDANCE_OLD_ENTRY_REQUIRES_OWNER_OR_ADMIN', 'ATTENDANCE_BOOK_OFF_BEFORE_BOOK_ON',
  'MANUAL_BOOK_ON_STATUS', 'MANUAL_BOOK_OFF_STATUS', 'ATTENDANCE_NO_GUARD', 'ATTENDANCE_ALREADY_BOOKED_ON',
  'ATTENDANCE_NOT_BOOKED_ON', 'ATTENDANCE_ALREADY_BOOKED_OFF', 'ATTENDANCE_OVERLAP', 'ATTENDANCE_GUARD_INELIGIBLE',
  'ATTENDANCE_CORRECTION_NOT_TIP', 'ATTENDANCE_CORRECTION_UNCHANGED', 'ATTENDANCE_TIMESHEET_LOCKED', 'ATTENDANCE_CONFLICT',
];

test('MA-04-EVERY-REFUSAL-CODE-IS-WORDED', () => {
  assert.deepEqual(Object.keys(ma.MANUAL_ATTENDANCE_ERROR_MESSAGES).sort(), [...CONTRACT_CODES].sort(), 'exactly the contract codes');
  for (const code of CONTRACT_CODES) {
    const g = ma.manualAttendanceErrorGuidance(new ApiError(409, 'x', { code, message: 'server words' }));
    assert.ok(g.message.startsWith(ma.MANUAL_ATTENDANCE_ERROR_MESSAGES[code]), code);
    assert.ok(!/undefined|null/.test(g.message), code);
  }
  assert.match(ma.manualAttendanceErrorGuidance(new ApiError(409, 'x', { code: 'ATTENDANCE_OVERLAP', message: 'Overlaps shift #12' })).message, /Overlaps shift #12/, 'specifics kept');
  assert.equal(ma.manualAttendanceErrorGuidance(new ApiError(409, 'x', { code: 'ATTENDANCE_CORRECTION_NOT_TIP' })).reload, true);
  assert.equal(ma.manualAttendanceErrorGuidance(new ApiError(422, 'x', { code: 'ATTENDANCE_TIME_IN_FUTURE' })).reload, false);
  assert.equal(ma.manualAttendanceErrorGuidance(OLD_BACKEND_404()).message, ma.MANUAL_ATTENDANCE_UNAVAILABLE_NOTE);
  assert.match(ma.manualAttendanceErrorGuidance(new ApiError(403, 'Forbidden', { message: 'Forbidden resource' })).message, /not authorised/);
  assert.match(ma.manualAttendanceErrorGuidance(new ApiError(500, 'x', {})).message, /Nothing was recorded/);
  assert.match(ma.manualAttendanceErrorGuidance(new Error('offline')).message, /could not be reached/);
  assert.match(ma.MANUAL_ATTENDANCE_ERROR_MESSAGES.ATTENDANCE_TIMESHEET_LOCKED, /approved, rejected or in a payroll batch/);
  assert.match(ma.MANUAL_ATTENDANCE_ERROR_MESSAGES.ATTENDANCE_OLD_ENTRY_REQUIRES_OWNER_OR_ADMIN, /Owner or Admin/);
});

const CHAIN = {
  shiftId: 80, status: 'in_progress', guardId: 1, scheduledStart: iso(Date.now() - 2 * HOUR), scheduledEnd: iso(Date.now() + 6 * HOUR),
  effective: { bookOn: null, bookOff: null, monitoredFrom: null },
  events: [
    view({ id: 1, occurredAt: iso(Date.now() - 2 * HOUR), recordedAt: iso(Date.now() - 2 * HOUR), effective: false, correctedByEventId: 2 }),
    view({ id: 2, occurredAt: iso(Date.now() - 150 * MIN), recordedAt: iso(Date.now() - 100 * MIN), source: 'manual', recordedByUserId: 1,
      recordedByName: 'Olive Owner', reason: 'Guard arrived earlier per CCTV', verificationMethod: 'cctv', verificationNote: 'Gate camera 2',
      correctionOfEventId: 1, isCorrection: true, effective: true, gpsVerified: false }),
  ],
};
CHAIN.effective.bookOn = CHAIN.events[1];

test('MA-05-HISTORY-SHOWS-THE-WHOLE-CHAIN-AND-ONLY-THE-TIP-IS-CORRECTABLE', () => {
  const rows = ma.attendanceHistoryRows(CHAIN, LONDON);
  assert.equal(rows.length, 2, 'the superseded original is kept');
  assert.deepEqual(rows[0].badges, ['Guard app', 'Superseded']);
  assert.deepEqual(rows[1].badges, ['Manual', 'Correction', 'Corrected', 'Effective']);
  assert.equal(rows[0].correctable, false);
  assert.equal(rows[1].correctable, true);
  assert.equal(rows[1].title, 'Book On (correction)');
  assert.ok(rows[1].detail.some((d) => d.startsWith('Recorded by Olive Owner')));
  assert.ok(rows[1].detail.includes('Verified by: CCTV — Gate camera 2'));
  assert.ok(rows[1].detail.includes('Reason: Guard arrived earlier per CCTV'));
  assert.ok(rows[0].detail[0].startsWith('Recorded by the Guard in the S4 app · GPS verified'));
  assert.ok(rows[0].detail.includes('Superseded by entry #2'));
  assert.ok(rows[1].detail.includes('Corrects entry #1'));
  const manualOnly = ma.attendanceHistoryRows({ ...CHAIN, events: [view({ id: 5, source: 'manual', recordedByName: 'Ops', reason: 'r', verificationMethod: 'radio' })] }, LONDON);
  assert.deepEqual(manualOnly[0].badges, ['Manual', 'Effective']);
  assert.deepEqual(ma.attendanceHistoryRows(null, LONDON), []);
  assert.deepEqual(ma.attendanceHistoryRows([], LONDON), [], 'a non-history answer shows nothing');
});

test('MA-06-LIVE-OPS-BADGES-TIMESHEET-LABEL-AND-EFFECTIVE-ROWS', () => {
  assert.deepEqual(ma.operationsAttendanceBadges(undefined), { bookOn: null, bookOff: null }, 'old backend: no block, no badge');
  assert.deepEqual(ma.operationsAttendanceBadges({ bookOnSource: 'guard_app', bookOffSource: null, bookOnCorrected: false, bookOffCorrected: false, monitoredFrom: null }), { bookOn: null, bookOff: null });
  assert.deepEqual(ma.operationsAttendanceBadges({ bookOnSource: 'manual', bookOffSource: 'guard_app', bookOnCorrected: false, bookOffCorrected: true, monitoredFrom: null }), { bookOn: 'Manual', bookOff: 'Corrected' });
  assert.equal(ma.timesheetSourceLabel('manual'), 'Manual attendance');
  assert.equal(ma.timesheetSourceLabel('corrected'), 'Corrected attendance');
  assert.equal(ma.timesheetSourceLabel('guard_app'), null);
  assert.equal(ma.timesheetSourceLabel(undefined), null);
  assert.deepEqual(ma.effectiveAttendanceEvents([{ id: 1 }, { id: 2, effective: false }, { id: 3, effective: true }]).map((e) => e.id), [1, 3]);
  // No new approval rule anywhere in the timesheet workspace.
  const tsws = stripComments(read('src/components/company/CompanyTimesheetsWorkspace.tsx'));
  assert.ok(tsws.includes('timesheetSourceLabel(activeSelected.verifiedSource)'), 'the label is shown');
  assert.ok(!/verifiedSource[^\n]*(disabled|approve|return\b)/i.test(tsws), 'and never gates an action');
  assert.ok(!/attendanceReviewNote/.test(tsws), 'no review-note rule');
});

test('MA-07-CONFIRMATION-AND-SUCCESS-WORDS', () => {
  const lines = ma.confirmationLines({ kind: 'book_on', occurredAt: '2026-10-27T14:00:00.000Z', timeZone: 'UTC', guardName: 'Ava', method: 'phone_call', note: '', reason: 'Phone dead' });
  assert.match(lines[0], /Ava will be booked on at 27-10-2026 · 14:00, recorded by you on their behalf/);
  assert.ok(lines.some((l) => /manual Book On, not a Guard app Book On/.test(l)));
  assert.ok(lines.includes('Verified by: Phone call with the Guard'));
  assert.ok(lines.includes('Reason: Phone dead'));
  const corr = ma.confirmationLines({ kind: 'correct', eventType: 'check-out', occurredAt: '2026-10-27T14:00:00.000Z', timeZone: 'UTC', guardName: 'Ava', method: 'other', note: 'Client log', reason: 'r', currentOccurredAt: '2026-10-27T13:00:00.000Z' });
  assert.match(corr[0], /Book Off will be corrected from 27-10-2026 · 13:00 to 27-10-2026 · 14:00/);
  assert.match(corr[1], /original entry is kept unchanged/);
  assert.equal(ma.manualAttendanceSuccessMessage({ kind: 'correct', eventType: 'check-in', shiftId: 9, guardName: 'Ava', occurredAt: '2026-10-27T14:00:00.000Z', timeZone: 'UTC', timesheetRestamped: true }),
    'Shift #9: Book On corrected to 27-10-2026 · 14:00. The timesheet now shows the corrected time.');
  assert.equal(ma.manualAttendanceSuccessMessage({ kind: 'book_off', shiftId: 9, guardName: 'Ava', occurredAt: '2026-10-27T14:00:00.000Z', timeZone: 'UTC' }),
    'Shift #9: Book Off recorded for Ava at 27-10-2026 · 14:00 (manual).');
});

// ═══ the real dashboard ═══

test('MA-08-OLD-BACKEND-HIDES-EVERY-MANUAL-ACTION-AND-SAYS-SO', async () => {
  reset({ shifts: [shift(80, 'missed', -3 * HOUR)], capabilities: OLD_BACKEND_404() });
  const renderer = await mountDashboard();
  await openShift(renderer, 80);
  await tickPolling(4);
  const text = screenText(renderer);
  assert.ok(text.includes("Manual Book On/Off isn't available on this server yet."), 'the short note');
  for (const label of ['Book On for Guard', 'Book On for Guard (late arrival)', 'Book Off for Guard']) {
    assert.equal(pressables(renderer.root, label).length, 0, `${label} is hidden`);
  }
  assert.ok(!text.includes('Attendance history'), 'no history panel against an old backend');
  assert.equal(calls.historyReads, 0, 'and its route is never called');
  assert.equal(calls.capabilityReads, 1, 'feature detection reads once per session, not per poll');
  assert.deepEqual(calls.mutations, []);
  await act(async () => { renderer.unmount(); });
});

test('MA-09-BOOK-ON-FOR-GUARD-NEEDS-A-FORM-AND-CONFIRMATION-AND-SENDS-ONE-REQUEST', async () => {
  reset({ shifts: [shift(81, 'ready', -40 * MIN)], history: { ...CHAIN, shiftId: 81, events: [], effective: { bookOn: null, bookOff: null, monitoredFrom: null } } });
  const renderer = await mountDashboard();
  await openShift(renderer, 81);
  const buttons = pressables(renderer.root, 'Book On for Guard');
  assert.equal(buttons.length, 1, 'offered on a Ready shift');
  assert.ok(screenText(renderer).includes('Mark Missed'), 'Mark Missed is still offered beside it');
  await press(buttons[0]);
  let form = formModal(renderer, 'Book On for Guard');
  assert.ok(form, 'the form opens');
  assert.deepEqual(calls.mutations, [], 'opening sends nothing');
  await press(pressables(form, 'Review')[0]);
  assert.ok(textOf(formModal(renderer, 'Book On for Guard')).includes('Choose how the time was verified') || textOf(formModal(renderer, 'Book On for Guard')).includes('Give the reason'), 'an incomplete form is refused');
  assert.deepEqual(calls.mutations, []);
  await press(pressables(formModal(renderer, 'Book On for Guard'), 'Phone call with the Guard')[0]);
  await type(formModal(renderer, 'Book On for Guard'), 'Reason', 'Phone battery dead; Guard called Control from site');
  await press(pressables(formModal(renderer, 'Book On for Guard'), 'Review')[0]);
  form = formModal(renderer, 'Book On for Guard');
  const confirmText = textOf(form);
  assert.ok(confirmText.includes('will be booked on at'), 'the confirmation says what will be recorded');
  assert.ok(confirmText.includes('manual Book On, not a Guard app Book On'));
  assert.ok(confirmText.includes('Reason: Phone battery dead; Guard called Control from site'));
  assert.deepEqual(calls.mutations, [], 'still nothing before Confirm');
  await press(pressables(form, 'Confirm — Book On for Guard')[0]);
  assert.equal(calls.mutations.length, 1, 'exactly one request');
  const [name, [shiftId, body]] = calls.mutations[0];
  assert.equal(name, 'manualBookOn');
  assert.equal(shiftId, 81);
  assert.deepEqual(Object.keys(body).sort(), ['occurredAt', 'reason', 'verificationMethod']);
  assert.equal(body.verificationMethod, 'phone_call');
  assert.ok(Date.parse(body.occurredAt) <= Date.now() && /Z$/.test(body.occurredAt), 'a UTC instant, not in the future');
  assert.ok(screenText(renderer).includes('Shift #81: Book On recorded for Ava Guard at'), 'success is said');
  await tickPolling(4);
  assert.equal(calls.mutations.length, 1, 'and nothing follows it');
  await act(async () => { renderer.unmount(); });
});

test('MA-10-MISSED-OFFERS-A-LATE-ARRIVAL-BOOK-ON', async () => {
  reset({ shifts: [shift(82, 'missed', -3 * HOUR)], history: { ...CHAIN, shiftId: 82, events: [] } });
  const renderer = await mountDashboard();
  await openShift(renderer, 82);
  const late = pressables(renderer.root, 'Book On for Guard (late arrival)');
  assert.equal(late.length, 1);
  await press(late[0]);
  assert.ok(formModal(renderer, 'Book On for Guard (late arrival)'), 'the late-arrival form');
  await press(pressables(formModal(renderer, 'Book On for Guard (late arrival)'), 'Cancel')[0]);
  assert.equal(formModal(renderer, 'Book On for Guard (late arrival)'), null, 'Cancel closes it');
  assert.deepEqual(calls.mutations, [], 'and sends nothing');
  await act(async () => { renderer.unmount(); });
});

test('MA-11-BOOK-OFF-REFUSAL-IS-SHOWN-IN-WORDS', async () => {
  const s = shift(83, 'in_progress', -2 * HOUR);
  reset({ shifts: [s], attendance: [{ id: 1, type: 'check-in', occurredAt: iso(Date.now() - 2 * HOUR), shift: { id: 83 }, source: 'guard_app', effective: true }],
    history: { ...CHAIN, shiftId: 83, events: [] } });
  world.refuse = new ApiError(409, 'Conflict', { code: 'ATTENDANCE_OVERLAP', message: "Overlaps the Guard's shift #12" });
  const renderer = await mountDashboard();
  await openShift(renderer, 83);
  await press(pressables(renderer.root, 'Book Off for Guard')[0]);
  const title = 'Book Off for Guard';
  await press(pressables(formModal(renderer, title), 'Radio')[0]);
  await type(formModal(renderer, title), 'Reason', 'Guard radioed Control on leaving');
  await press(pressables(formModal(renderer, title), 'Review')[0]);
  await press(pressables(formModal(renderer, title), `Confirm — ${title}`)[0]);
  assert.equal(calls.mutations.length, 1);
  assert.equal(calls.mutations[0][0], 'manualBookOff');
  const text = textOf(formModal(renderer, title));
  assert.ok(text.includes("overlaps the Guard's attendance on another shift"), 'the refusal in words');
  assert.ok(text.includes("Overlaps the Guard's shift #12"), 'with the server specifics');
  await act(async () => { renderer.unmount(); });
});

test('MA-12-HISTORY-BADGES-AND-CORRECT-TIME-ON-THE-TIP', async () => {
  const s = shift(80, 'in_progress', -2 * HOUR);
  reset({ shifts: [s], attendance: [
    { id: 1, type: 'check-in', occurredAt: CHAIN.events[0].occurredAt, shift: { id: 80 }, source: 'guard_app', effective: false },
    { id: 2, type: 'check-in', occurredAt: CHAIN.events[1].occurredAt, shift: { id: 80 }, source: 'manual', effective: true, correctionOfEventId: 1 },
  ], history: CHAIN });
  const renderer = await mountDashboard();
  await openShift(renderer, 80);
  const text = screenText(renderer);
  assert.ok(text.includes('Attendance history'));
  for (const badge of ['Guard app', 'Superseded', 'Manual', 'Correction', 'Corrected', 'Effective']) assert.ok(text.includes(badge), badge);
  assert.ok(text.includes('Verified by: CCTV — Gate camera 2'));
  const correct = pressables(renderer.root, 'Correct Book On time');
  assert.equal(correct.length, 1, 'only the effective entry offers Correct time');
  await press(correct[0]);
  const title = 'Correct Book On time';
  assert.ok(formModal(renderer, title));
  // The superseded row is never the board's Book On time.
  const form = formModal(renderer, title);
  const dateInput = input(form, 'Actual date');
  const timeInput = input(form, 'Actual time');
  const prefilled = `${dateInput.props.value} ${timeInput.props.value}`;
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(prefilled), 'opens on the recorded time');
  const earlier = new Date(Date.parse(CHAIN.events[1].occurredAt) - 10 * MIN);
  const site = loadSource('src/services/siteTime.ts');
  await type(formModal(renderer, title), 'Actual date', site.formatSiteDateInput(earlier.toISOString(), LONDON));
  await type(formModal(renderer, title), 'Actual time', site.formatSiteTime(earlier.toISOString(), LONDON));
  await press(pressables(formModal(renderer, title), 'Supervisor on site')[0]);
  await type(formModal(renderer, title), 'Reason', 'Supervisor log shows an earlier arrival');
  await press(pressables(formModal(renderer, title), 'Review')[0]);
  assert.ok(textOf(formModal(renderer, title)).includes('original entry is kept unchanged'));
  await press(pressables(formModal(renderer, title), `Confirm — ${title}`)[0]);
  assert.equal(calls.mutations.length, 1);
  const [name, [eventId, body]] = calls.mutations[0];
  assert.equal(name, 'correctAttendanceEvent');
  assert.equal(eventId, 2, 'the tip, never the superseded original');
  assert.equal(body.verificationMethod, 'supervisor_on_site');
  assert.equal(Date.parse(body.occurredAt), Math.floor(earlier.getTime() / MIN) * MIN);
  assert.ok(screenText(renderer).includes('The timesheet now shows the corrected time.'));
  await act(async () => { renderer.unmount(); });
});

test('MA-13-WITHOUT-ATTENDANCE-MANAGE-HISTORY-IS-READ-ONLY', async () => {
  reset({ shifts: [shift(80, 'missed', -3 * HOUR)], history: CHAIN });
  const renderer = await mountDashboard(VIEWER);
  await openShift(renderer, 80);
  const text = screenText(renderer);
  assert.ok(text.includes('Attendance history'), 'the history is visible');
  assert.equal(pressables(renderer.root, 'Book On for Guard (late arrival)').length, 0, 'no action');
  assert.equal(pressables(renderer.root, 'Correct Book On time').length, 0, 'no Correct time');
  assert.ok(!text.includes("isn't available on this server"), 'and no old-server note for someone who could not use it');
  await act(async () => { renderer.unmount(); });
});

test('MA-14-PASSIVE-PATHS-SEND-NOTHING', async () => {
  reset({ shifts: [shift(84, 'ready', -40 * MIN), shift(85, 'missed', -5 * HOUR)], history: CHAIN });
  const renderer = await mountDashboard();
  await openShift(renderer, 84);
  await tickPolling(12);
  await openShift(renderer, 85);
  await tickPolling(6);
  assert.deepEqual(calls.mutations, [], 'polling, refresh and opening shifts write nothing');
  await act(async () => { renderer.unmount(); });
});

// ═══ source: routes, wiring, the grant, the gate ═══

test('MA-15-THE-CLIENT-SENDS-THE-CONTRACT-ROUTES-AND-BODIES', () => {
  const client = read('src/services/api.ts');
  const body = (fn) => client.slice(client.indexOf(`export function ${fn}(`), client.indexOf('\n}\n', client.indexOf(`export function ${fn}(`)));
  assert.ok(body('getManualAttendanceCapabilities').includes("'/attendance/manual/capabilities'"));
  assert.ok(body('manualBookOn').includes("'/attendance/manual/book-on'") && body('manualBookOn').includes("method: 'POST'") && body('manualBookOn').includes('JSON.stringify({ shiftId, ...payload })'));
  assert.ok(body('manualBookOff').includes("'/attendance/manual/book-off'") && body('manualBookOff').includes("method: 'POST'"));
  assert.ok(body('correctAttendanceEvent').includes('`/attendance/events/${eventId}/corrections`') && body('correctAttendanceEvent').includes("method: 'POST'"));
  assert.ok(body('getAttendanceHistory').includes('`/attendance/shifts/${shiftId}/history`'));
  assert.ok(body('setControlRoomAttendanceAuthorisation').includes('`/attendance/control-room/${userId}`') && body('setControlRoomAttendanceAuthorisation').includes("method: 'PUT'")
    && body('setControlRoomAttendanceAuthorisation').includes('JSON.stringify({ canManageAttendance })'));
});

test('MA-16-ONLY-THE-CONFIRMED-SUBMIT-WRITES', () => {
  const screen = stripComments(read('src/screens/CompanyDashboardScreen.tsx'));
  for (const fn of ['manualBookOn(', 'manualBookOff(', 'correctAttendanceEvent(']) {
    assert.equal(screen.split(fn).length - 1, 1, `${fn} has one call site`);
  }
  const submit = screen.slice(screen.indexOf('const handleSubmitManualAttendance'), screen.indexOf('}, [manualAttendanceTarget, recordingAttendance, loadData]);'));
  for (const fn of ['manualBookOn(', 'manualBookOff(', 'correctAttendanceEvent(']) assert.ok(submit.includes(fn), `${fn} is inside the confirmed submit`);
  const effects = screen.split('React.useEffect(').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf('}, [')));
  assert.ok(!effects.some((b) => /manualBookOn|manualBookOff|correctAttendanceEvent|setControlRoomAttendanceAuthorisation/.test(b)), 'no effect writes attendance');
  const drawer = stripComments(read('src/components/company/CompanyManualAttendanceDrawer.tsx'));
  assert.ok(!/services\/api/.test(drawer), 'the form reaches no endpoint of its own');
  assert.ok(drawer.includes('onPress={confirming ? confirm : review}'), 'the first press only reviews');
  const reviewFn = drawer.slice(drawer.indexOf('const review = () => {'), drawer.indexOf('const confirm = () => {'));
  assert.ok(!reviewFn.includes('onSubmit'), 'review never submits');
  const panel = stripComments(read('src/components/company/CompanyAttendanceHistoryPanel.tsx'));
  assert.ok(!/manualBookOn|manualBookOff|correctAttendanceEvent/.test(panel), 'the history panel only reads');
  // The workspace and panel stay free of the API module (it pulls in expo, which the visual and incident specs, and
  // anything else loading the workspace under plain node, cannot load). The history read is injected.
  assert.ok(!/services\/api/.test(panel), 'the panel imports no API module');
  assert.ok(!/services\/api/.test(stripComments(read('src/components/company/CompanyLiveOperationsWorkspace.tsx'))), 'nor does the workspace');
  assert.ok(screen.includes('loadHistory: getAttendanceHistory,'), 'the dashboard injects the read');
  // The board reads effective attendance only.
  assert.ok(screen.includes('effectiveAttendanceEvents(attendanceEvents).forEach((event) => {'), 'superseded rows never set the board time');
  // Close without Book Off and Mark Missed are untouched.
  assert.ok(screen.includes('onReconcileShift={canReconcileShifts ? handleOpenReconcile : undefined}'));
  assert.ok(screen.includes('onMarkMissed={canManageShifts ? handleOpenMarkMissed : undefined}'));
  assert.ok(screen.includes("updateShift(target.shiftId, { status: 'missed' })"), 'Mark Missed sends what it sent before (reason is PR #49 / backend follow-up)');
});

test('MA-17-CONTROL-ROOM-GRANT-TOGGLE-ONLY-WHEN-THE-BACKEND-REPORTS-IT', () => {
  const drawer = stripComments(read('src/components/company/CompanyShiftAmendmentDrawer.tsx'));
  assert.ok(drawer.includes("staffDir.staff.some((m) => m.role === 'control_room' && typeof m.canManageAttendance === 'boolean')"), 'feature-detected from the staff rows');
  assert.ok(drawer.includes('setControlRoomAttendanceAuthorisation(m.userId, !m.canManageAttendance)'), 'toggles the grant');
  assert.ok(drawer.includes('staffDir?.canManageControlRoom &&'), 'Owner/Admin only, as the amendment grant');
  assert.ok(drawer.includes('— can manage attendance'), 'labelled');
});

test('MA-18-THE-SPEC-IS-IN-THE-RELEASE-GATE', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:manual-attendance-ui'], 'node scripts/manual-attendance-ui.spec.cjs');
  const workflow = fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 's4-mobile-release-gate.yml'), 'utf8');
  assert.ok(workflow.includes('run: npm run test:manual-attendance-ui'));
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      passed += 1;
      console.log('PASS ', name);
    } catch (error) {
      console.error('FAIL ', name);
      console.error('      ' + (error && error.stack ? error.stack.split('\n').slice(0, 5).join('\n      ') : error));
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${pending.length} manual attendance UI checks passed`);
  process.exit(process.exitCode || 0);
})();
