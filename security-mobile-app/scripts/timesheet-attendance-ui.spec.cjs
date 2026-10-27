#!/usr/bin/env node
/**
 * Verified attendance beside the Guard's timesheet (owner-approved, 27 Oct 2026), in the company web and the Guard app.
 *
 * WHAT IS CERTIFIED
 *   - The pure presentation (src/components/company/timesheetAttendance.ts), executed: durations in words, an older
 *     backend (no verified fields) shows nothing new, a difference within the tolerance is not flagged, start / finish /
 *     total differences over it are worded for the company and for the Guard, an approved timesheet is compared with the
 *     approved figures, and a zero difference never produces a line.
 *   - The REAL CompanyTimesheetsWorkspace mounted with react-test-renderer on react-native-web: the review table row
 *     carries the "Differs" badge, and the review panel shows the verified Book On / Book Off and time ALONGSIDE the
 *     Guard's claimed start / finish / hours (never instead of them), the flag in words, and still offers Approve and
 *     Return — the flag gates nothing. Against an older backend the panel is exactly as before.
 *   - The REAL Guard timesheet card: the verified Book On / Book Off are shown and the difference is flagged in the
 *     Guard's words; the claimed hours stay editable.
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

// ─── the stubbed API: reads return nothing, every write is recorded ─────────────────────────────────────────────

const api = loadSource('src/services/api.ts');
const writes = [];
for (const key of Object.keys(api)) {
  if (typeof api[key] !== 'function' || /^[A-Z]/.test(key)) continue;
  if (/^(update|submit|create|delete|approve|reject|send|set|record|correct|manual|reconcile)/.test(key)) {
    api[key] = async (...args) => { writes.push([key, args]); return {}; };
  } else {
    api[key] = async () => [];
  }
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [], text: async () => '[]', headers: { get: () => null } });

const settle = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const textOf = (node) => {
  const words = [];
  const walk = (n) => { if (typeof n === 'string') { words.push(n); return; } if (n && n.children) n.children.forEach(walk); };
  walk(node);
  return words.join('');
};
const pressByText = async (root, text) => {
  const nodes = root.findAll((n) => n.props && typeof n.props.onPress === 'function' && textOf(n).trim() === text);
  assert.ok(nodes.length > 0, `a "${text}" control`);
  await act(async () => { await nodes[0].props.onPress({ stopPropagation() {} }); });
  await settle();
};

const ta = loadSource('src/components/company/timesheetAttendance.ts');
const { CompanyTimesheetsWorkspace } = loadSource('src/components/company/CompanyTimesheetsWorkspace.tsx');
const { GuardTimesheetsScreen } = loadSource('src/screens/GuardTimesheetsScreen.tsx');

// ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const SITE = { id: 10, name: 'Merchant Fields', timezone: 'Europe/London', client: { id: 3, name: 'Client' } };
// Now (to the minute): always inside the workspace's current week, whatever day the gate runs.
const START = Math.floor(Date.now() / MIN) * MIN;
const fmt = (v) => (v ? `T${new Date(v).toISOString().slice(11, 16)}` : '—');

function timesheet(over = {}) {
  return {
    id: 501, shiftId: 77, guardId: 9, companyId: 1, hoursWorked: 8.5, approvalStatus: 'submitted', createdAt: iso(START),
    submittedAt: iso(START + 9 * HOUR), scheduledStartAt: iso(START), scheduledEndAt: iso(START + 8 * HOUR),
    actualCheckInAt: iso(START + 5 * MIN), actualCheckOutAt: iso(START + 8 * HOUR + 30 * MIN),
    verifiedSource: 'manual', guardNote: null, companyNote: null, approvedHours: null, workedMinutes: 510,
    payrollStatus: 'unpaid', billingStatus: 'uninvoiced',
    verifiedCheckInAt: iso(START + 5 * MIN), verifiedCheckOutAt: iso(START + 8 * HOUR - 20 * MIN), verifiedAttendanceMinutes: 455,
    attendanceDiscrepancy: {
      comparedWith: 'guard_claim', toleranceMinutes: 10, startDifferenceMinutes: 0, endDifferenceMinutes: 50,
      totalDifferenceMinutes: 55, fields: ['end', 'total'], exceedsTolerance: true,
    },
    shift: { id: 77, start: iso(START), end: iso(START + 8 * HOUR), siteId: SITE.id, siteName: SITE.name, site: SITE },
    guard: { id: 9, fullName: 'Ava Guard' },
    ...over,
  };
}
const OLD_BACKEND = (() => {
  const t = timesheet();
  for (const k of ['verifiedCheckInAt', 'verifiedCheckOutAt', 'verifiedAttendanceMinutes', 'attendanceDiscrepancy']) delete t[k];
  return t;
})();

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

// ═══ pure presentation ═══

test('TA-01-DURATIONS-IN-WORDS', () => {
  assert.equal(ta.formatDurationMinutes(455), '7 h 35 min');
  assert.equal(ta.formatDurationMinutes(480), '8 h');
  assert.equal(ta.formatDurationMinutes(45), '45 min');
  assert.equal(ta.formatDurationMinutes(-25), '25 min', 'the sign is in the words, not the number');
  assert.equal(ta.formatDurationMinutes(null), '—');
});

test('TA-02-AN-OLDER-BACKEND-SHOWS-NOTHING-NEW', () => {
  const v = ta.verifiedAttendanceView(OLD_BACKEND, fmt);
  assert.deepEqual([v.supported, v.flagged, v.badge, v.flagTitle, v.flagLines], [false, false, null, null, []]);
});

test('TA-03-WITHIN-TOLERANCE-IS-NOT-FLAGGED', () => {
  const v = ta.verifiedAttendanceView(timesheet({ attendanceDiscrepancy: {
    comparedWith: 'guard_claim', toleranceMinutes: 10, startDifferenceMinutes: 4, endDifferenceMinutes: -10, totalDifferenceMinutes: -6, fields: [], exceedsTolerance: false,
  } }), fmt);
  assert.deepEqual([v.supported, v.flagged, v.badge, v.flagLines], [true, false, null, []]);
  assert.equal(v.bookOnLabel, fmt(iso(START + 5 * MIN)));
  assert.equal(v.durationLabel, '7 h 35 min');
  const none = ta.verifiedAttendanceView(timesheet({ verifiedCheckInAt: null, verifiedCheckOutAt: null, verifiedAttendanceMinutes: null, attendanceDiscrepancy: null }), fmt);
  assert.deepEqual([none.supported, none.bookOnLabel, none.bookOffLabel, none.durationLabel, none.flagged], [true, 'Not recorded', 'Not recorded', '—', false]);
});

test('TA-04-DIFFERENCES-ARE-WORDED-FOR-THE-COMPANY-AND-THE-GUARD', () => {
  const company = ta.verifiedAttendanceView(timesheet(), fmt);
  assert.equal(company.flagged, true);
  assert.equal(company.badge, 'Differs from verified');
  assert.equal(company.flagTitle, "Verified attendance differs from the Guard's timesheet");
  assert.deepEqual(company.flagLines, [
    "Guard's finish is 50 min after the verified Book Off",
    "Guard's total is 55 min more than the verified attendance",
  ]);
  assert.match(company.toleranceNote, /more than 10 minutes.*approval workflow is unchanged/);
  const guard = ta.verifiedAttendanceView(timesheet(), fmt, 'guard');
  assert.equal(guard.flagTitle, 'Your timesheet differs from your recorded Book On / Book Off');
  assert.deepEqual(guard.flagLines, ['Your finish is 50 min after the verified Book Off', 'Your total is 55 min more than the verified attendance']);
  const early = ta.verifiedAttendanceView(timesheet({ attendanceDiscrepancy: {
    comparedWith: 'guard_claim', toleranceMinutes: 10, startDifferenceMinutes: -25, endDifferenceMinutes: 0, totalDifferenceMinutes: 0, fields: ['start', 'end'], exceedsTolerance: true,
  } }), fmt);
  assert.deepEqual(early.flagLines, ["Guard's start is 25 min before the verified Book On"], 'a zero difference never produces a line');
  for (const v of [company, guard, early]) for (const line of v.flagLines) assert.doesNotMatch(line, /check[ -]?(in|out)|undefined|null|NaN/i);
});

test('TA-05-AN-APPROVED-TIMESHEET-IS-COMPARED-WITH-THE-APPROVAL', () => {
  const v = ta.verifiedAttendanceView(timesheet({ approvalStatus: 'approved', attendanceDiscrepancy: {
    comparedWith: 'approved', toleranceMinutes: 10, startDifferenceMinutes: null, endDifferenceMinutes: null, totalDifferenceMinutes: 120, fields: ['total'], exceedsTolerance: true,
  } }), fmt);
  assert.equal(v.badge, 'Differs from approved');
  assert.equal(v.flagTitle, 'Verified attendance differs from the approved timesheet');
  assert.deepEqual(v.flagLines, ['Approved total is 2 h more than the verified attendance']);
});

// ═══ the real company review workspace ═══

async function mountWorkspace(timesheets) {
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(h(CompanyTimesheetsWorkspace, { timesheets, refreshing: false, onRefresh: async () => {} }));
  });
  await settle();
  await pressByText(renderer.root, 'Review Site');
  return renderer;
}

test('TA-06-THE-REVIEW-ROW-CARRIES-THE-BADGE-AND-THE-PANEL-SHOWS-BOTH-SIDES', async () => {
  writes.length = 0;
  const renderer = await mountWorkspace([timesheet()]);
  const text = () => textOf(renderer.root);
  assert.ok(text().includes('Differs from verified'), 'the row badge');
  await pressByText(renderer.root, 'Review');
  const panel = text();
  for (const words of ['Verified Book On:', 'Verified Book Off:', 'Verified time: 7 h 35 min',
    "Verified attendance differs from the Guard's timesheet", "Guard's finish is 50 min after the verified Book Off",
    "Guard's total is 55 min more than the verified attendance", 'Claimed start:', 'Claimed finish:', 'Claimed hours: 8.50 h']) {
    assert.ok(panel.includes(words), `the panel shows "${words}"`);
  }
  assert.ok(panel.includes('Manual attendance'), 'the Part B source label is still shown');
  // The flag gates nothing: the submitted timesheet still offers Approve and Return, and nothing was written.
  assert.ok(renderer.root.findAll((n) => n.props && typeof n.props.onPress === 'function' && textOf(n).trim() === 'Approve').length > 0, 'Approve offered');
  assert.ok(renderer.root.findAll((n) => n.props && typeof n.props.onPress === 'function' && textOf(n).trim() === 'Return').length > 0, 'Return offered');
  assert.deepEqual(writes, [], 'rendering wrote nothing');
  act(() => renderer.unmount());
});

test('TA-07-AN-OLDER-BACKEND-SEES-THE-PANEL-AS-BEFORE', async () => {
  const renderer = await mountWorkspace([OLD_BACKEND]);
  assert.ok(!textOf(renderer.root).includes('Differs'), 'no badge');
  await pressByText(renderer.root, 'Review');
  const panel = textOf(renderer.root);
  assert.ok(panel.includes('Check-in:') && panel.includes('Check-out:') && panel.includes('Recorded: 510 min'), 'the old lines');
  assert.ok(!panel.includes('Verified Book On'), 'no verified lines');
  act(() => renderer.unmount());
});

// ═══ the real Guard timesheet card ═══

test('TA-08-THE-GUARD-SEES-THE-VERIFIED-TIMES-AND-THE-DIFFERENCE', async () => {
  let renderer;
  const own = timesheet({ approvalStatus: 'draft', submittedAt: null });
  await act(async () => {
    renderer = TestRenderer.create(h(GuardTimesheetsScreen, { timesheets: [own], attendance: [], onReload: async () => {} }));
  });
  await settle();
  const text = textOf(renderer.root);
  assert.ok(text.includes('Your timesheet differs from your recorded Book On / Book Off'));
  assert.ok(text.includes('Your total is 55 min more than the verified attendance'));
  assert.ok(text.includes('Your company will review it.'));
  const hours = renderer.root.findAll((n) => n.props && typeof n.props.onChangeText === 'function' && n.props.keyboardType === 'decimal-pad');
  assert.equal(hours.length, 1, 'the claimed hours stay editable');
  assert.equal(hours[0].props.value, '8.5', "the Guard's own claim, not the verified hours");
  act(() => renderer.unmount());
});

test('TA-10-A-BOOK-OFF-ON-AN-APPROVED-TIMESHEET-SAYS-IT-WAS-LEFT-UNCHANGED', () => {
  const ma = loadSource('src/components/company/manualAttendance.ts');
  const base = { kind: 'book_off', shiftId: 77, guardName: 'Ava Guard', occurredAt: iso(START), timeZone: 'Europe/London' };
  const plain = ma.manualAttendanceSuccessMessage(base);
  assert.match(plain, /^Shift #77: Book Off recorded for Ava Guard at .+ \(manual\)\.$/, 'unchanged for an open timesheet / older backend');
  assert.equal(ma.manualAttendanceSuccessMessage({ ...base, timesheetLeftUnchanged: false }), plain);
  assert.equal(
    ma.manualAttendanceSuccessMessage({ ...base, timesheetLeftUnchanged: true }),
    `${plain} The timesheet was already approved, so it was left unchanged; any difference is flagged in Timesheets for review.`,
  );
  const dash = stripComments(read('src/screens/CompanyDashboardScreen.tsx'));
  assert.ok(dash.includes('timesheetLeftUnchanged = result?.timesheet?.leftUnchanged ?? null;'), 'read from the Book Off answer');
});

// ═══ wiring ═══

test('TA-09-WIRING-AND-THE-RELEASE-GATE', () => {
  const ws = stripComments(read('src/components/company/CompanyTimesheetsWorkspace.tsx'));
  assert.ok(ws.includes("import { verifiedAttendanceView } from './timesheetAttendance';"));
  assert.ok(!/selectedVerified[^\n]*(disabled|handleApprove|handleReturn|handleReject)/.test(ws), 'the flag never gates an action');
  const pure = read('src/components/company/timesheetAttendance.ts');
  assert.doesNotMatch(pure, /from '\.\.\/\.\.\/services\/api'|fetch\(/, 'pure: no I/O');
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:timesheet-attendance-ui'], 'node scripts/timesheet-attendance-ui.spec.cjs');
  const workflow = fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 's4-mobile-release-gate.yml'), 'utf8');
  assert.ok(workflow.includes('run: npm run test:timesheet-attendance-ui'));
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      passed += 1;
      console.log('PASS ', name);
    } catch (error) {
      console.error('FAIL ', name);
      console.error('      ' + (error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n      ') : error));
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${pending.length} timesheet attendance UI checks passed`);
  process.exit(process.exitCode || 0);
})();
