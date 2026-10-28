#!/usr/bin/env node
/**
 * Timesheet review UX (owner-approved, 28 Oct 2026): hours as hours and minutes, a required return / reject reason
 * shown to the Guard with the reviewer and time, the review history, and explicit payable-hours approval.
 *
 * Live pilot finding (timesheet 40): the Guard claimed 9.50 (9 h 30 min), the company read 9 h 50 min and returned it
 * with the web's generic default reason, so the Guard saw a status, not a reason.
 *
 * WHAT IS CERTIFIED
 *   - The pure modules, executed: the one hours formatter ("9h 30m (9.50 h)", minutes = round(hours × 60) like the
 *     backend, every whole minute survives the 2-decimal column), the Guard's Hours / Minutes parsing and validation,
 *     the reason rule (5–500 characters), the history lines (the Guard reads "You", reviewers by name), the Guard's
 *     decision banner, and the approval plan (a reason whenever the payable minutes differ from verified attendance —
 *     including the Guard's own claim — or from the claim; always for other hours).
 *   - The REAL Guard card (react-test-renderer on react-native-web): the reason, reviewer and time at the top with
 *     what to do, the history list, separate Hours / Minutes inputs with the live result, a decimal refused, and a
 *     resubmission sending the existing decimal hoursWorked.
 *   - The REAL company review panel: Return / Reject send nothing without a reason (no generic default), send the
 *     typed reason; "Approve claimed hours" asks for the reason up front when the claim differs from verified;
 *     "Approve other hours" needs hours and a reason; the row's quick Approve never sends an approval that needs a
 *     reason; the history shows the earlier return reason after resubmission.
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
const pressables = (root, text) => root.findAll((n) => n.props && typeof n.props.onPress === 'function' && textOf(n).trim() === text);
const pressByText = async (root, text) => {
  const nodes = pressables(root, text);
  assert.ok(nodes.length > 0, `a "${text}" control`);
  await act(async () => { await nodes[0].props.onPress({ stopPropagation() {} }); });
  await settle();
};
const typeInto = async (root, label, value) => {
  const nodes = root.findAll((n) => n.props && n.props.accessibilityLabel === label && typeof n.props.onChangeText === 'function');
  assert.ok(nodes.length > 0, `an input "${label}"`);
  await act(async () => { nodes[0].props.onChangeText(value); });
  await settle();
};

const hours = loadSource('src/services/timesheetHours.ts');
const review = loadSource('src/services/timesheetReview.ts');
const { CompanyTimesheetsWorkspace } = loadSource('src/components/company/CompanyTimesheetsWorkspace.tsx');
const { GuardTimesheetsScreen } = loadSource('src/screens/GuardTimesheetsScreen.tsx');

let historyAnswer = { items: [] };
api.getTimesheetHistory = async (id) => { writes.push(['readHistory', [id]]); return historyAnswer; };

// ─── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const SITE = { id: 10, name: 'Merchant Fields', timezone: 'Europe/London', client: { id: 3, name: 'Client' } };
const START = Math.floor(Date.now() / MIN) * MIN;

function timesheet(over = {}) {
  return {
    id: 40, shiftId: 71, guardId: 11, companyId: 9, hoursWorked: 8.5, approvalStatus: 'submitted', createdAt: iso(START),
    submittedAt: iso(START + 9 * HOUR), scheduledStartAt: iso(START), scheduledEndAt: iso(START + 8 * HOUR),
    actualCheckInAt: iso(START), actualCheckOutAt: iso(START + 8 * HOUR + 30 * MIN),
    verifiedSource: 'guard_app', guardNote: 'Site finished early', companyNote: null, approvedHours: null, workedMinutes: 510,
    verifiedMinutes: 455, payrollStatus: 'unpaid', billingStatus: 'uninvoiced', rejectionReason: null, reviewedAt: null,
    verifiedCheckInAt: iso(START), verifiedCheckOutAt: iso(START + 455 * MIN), verifiedAttendanceMinutes: 455,
    attendanceDiscrepancy: null,
    shift: { id: 71, start: iso(START), end: iso(START + 8 * HOUR), siteId: SITE.id, siteName: SITE.name, site: SITE },
    guard: { id: 11, fullName: 'Ava Guard' },
    company: { id: 9, name: 'Acme Security' },
    ...over,
  };
}
const REASON = 'Your Book Off was 09:03, so 9h 30m looks too high. Check your hours.';
const item = (over) => ({ at: iso(START + 10 * HOUR), actorRole: 'company', actorName: 'Sam Reviewer', claimedMinutesBefore: null,
  claimedMinutesAfter: null, approvedMinutes: null, reason: null, note: null, ...over });
const GUARD_HISTORY = [
  item({ action: 'submitted', actorRole: 'guard', actorName: 'You', claimedMinutesAfter: 570, note: 'Site finished early', at: iso(START + 9 * HOUR) }),
  item({ action: 'returned', claimedMinutesAfter: 570, reason: REASON }),
];

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

// ═══ the pure modules ═══

test('TR-01-HOURS-ARE-SHOWN-AS-HOURS-AND-MINUTES', () => {
  assert.equal(hours.formatMinutesHM(570), '9h 30m');
  assert.equal(hours.formatMinutesHM(514), '8h 34m', 'timesheet 40: verified 514 minutes');
  assert.equal(hours.formatMinutesHM(480), '8h');
  assert.equal(hours.formatMinutesHM(45), '45m');
  assert.equal(hours.formatMinutesHM(null), '—');
  assert.equal(hours.formatHoursHM(9.5), '9h 30m', '9.50 is nine and a half hours, never 9h 50m');
  assert.equal(hours.formatHoursHM('9.50', { withDecimal: true }), '9h 30m (9.50 h)', 'numeric columns arrive as strings');
  assert.equal(hours.formatMinutesWithDecimal(514), '8h 34m (8.57 h)');
  // The backend's rule (workedMinutes = round(hoursWorked × 60)) and the 2-decimal column keep every whole minute.
  for (let m = 0; m <= 24 * 60; m += 1) {
    assert.equal(hours.hoursToMinutes(hours.minutesToDecimalHours(m)), m, `${m} minutes survive storage`);
  }
  assert.equal(hours.hoursToMinutes(8.33), 500);
});

test('TR-02-THE-GUARD-ENTERS-HOURS-AND-MINUTES-SEPARATELY', () => {
  const ok = hours.parseHoursMinutes('9', '30');
  assert.deepEqual(ok, { ok: true, minutes: 570, label: '9h 30m (9.50 h)' });
  assert.deepEqual(hours.parseHoursMinutes('8', ''), { ok: true, minutes: 480, label: '8h (8.00 h)' });
  assert.deepEqual(hours.parseHoursMinutes('', '45'), { ok: true, minutes: 45, label: '45m (0.75 h)' });
  assert.deepEqual(hours.parseHoursMinutes('24', '0').ok, true);
  for (const [h, m, words] of [
    ['9.5', '', /whole numbers/], ['9,5', '', /whole numbers/], ['9:30', '', /whole numbers/], ['9', '60', /0 and 59/],
    ['0', '0', /more than 0/], ['', '', /Enter the hours/], ['25', '', /24 or fewer/], ['24', '1', /24 hours or less/],
    ['-1', '', /whole numbers/], ['abc', '', /whole numbers/],
  ]) {
    const r = hours.parseHoursMinutes(h, m);
    assert.equal(r.ok, false, `"${h}" / "${m}" is refused`);
    assert.match(r.error, words);
  }
  assert.deepEqual(hours.splitMinutes(570), { hours: '9', minutes: '30' });
  assert.deepEqual(hours.splitMinutes(0), { hours: '', minutes: '' }, 'an empty draft starts empty');
});

test('TR-03-A-RETURN-OR-REJECT-REASON-IS-REQUIRED', () => {
  for (const bad of ['', '   ', 'ok', 'a b c d', '....', null, undefined]) {
    assert.match(review.reviewReasonProblem(bad), /at least 5 characters/, JSON.stringify(bad));
  }
  assert.equal(review.reviewReasonProblem('Hours too high'), null);
  assert.equal(review.reviewReasonProblem('x'.repeat(500)), null);
  assert.match(review.reviewReasonProblem('x'.repeat(501)), /500 characters or fewer/);
});

test('TR-04-HISTORY-LINES-KEEP-THE-REASON-AND-THE-PREVIOUS-CLAIM', () => {
  const when = (v) => `@${v.slice(11, 16)}`;
  const items = [...GUARD_HISTORY,
    item({ action: 'resubmitted', actorRole: 'guard', actorName: 'You', claimedMinutesBefore: 570, claimedMinutesAfter: 514, at: iso(START + 11 * HOUR) }),
    item({ action: 'approved', claimedMinutesAfter: 514, approvedMinutes: 514, at: iso(START + 12 * HOUR) }),
    item({ action: 'something_new' }),
  ];
  const lines = review.historyLines(items, 'guard', when);
  assert.deepEqual(lines.map((l) => l.title), [
    'Submitted by You', 'Returned for correction by Sam Reviewer', 'Corrected and resubmitted by You', 'Approved by Sam Reviewer',
  ], 'an unknown action from a newer server is skipped');
  assert.deepEqual(lines[0].details, ['Claimed 9h 30m (9.50 h)', 'Your note: Site finished early']);
  assert.deepEqual(lines[1].details, ['Claim returned: 9h 30m', `Reason: ${REASON}`], 'the reason stays after resubmission');
  assert.deepEqual(lines[2].details, ['Claim changed from 9h 30m to 8h 34m (8.57 h)']);
  assert.deepEqual(lines[3].details, ['Approved 8h 34m (8.57 h)']);
  const company = review.historyLines([item({ action: 'submitted', actorRole: 'guard', actorName: 'Ava Guard', claimedMinutesAfter: 570, note: 'x y z' })], 'company', when);
  assert.equal(company[0].title, 'Submitted by Ava Guard');
  assert.deepEqual(company[0].details, ['Claimed 9h 30m (9.50 h)', "Guard's note: x y z"]);
  const anonymous = review.historyLines([item({ action: 'returned', actorName: null, reason: REASON })], 'guard', when);
  assert.equal(anonymous[0].title, 'Returned for correction by Your company');
  for (const line of lines) assert.doesNotMatch(JSON.stringify(line), /undefined|NaN|null/);
});

test('TR-05-THE-GUARD-BANNER-NAMES-THE-REVIEWER-THE-TIME-AND-THE-REASON', () => {
  const when = (v) => `@${v.slice(11, 16)}`;
  const returned = timesheet({ approvalStatus: 'returned', rejectionReason: REASON, reviewedAt: iso(START + 10 * HOUR) });
  const b = review.guardDecisionBanner(returned, GUARD_HISTORY, when);
  assert.equal(b.title, `Returned by Sam Reviewer (Acme Security) on ${when(iso(START + 10 * HOUR))}`);
  assert.equal(b.reason, REASON);
  assert.equal(b.whatToDo, 'What to do: correct your hours or note and submit again.');
  assert.equal(b.tone, 'warning');
  const before = review.guardDecisionBanner(returned, null, when);
  assert.equal(before.title, `Returned by Acme Security on ${when(iso(START + 10 * HOUR))}`, 'until the history loads: the company and reviewedAt');
  assert.equal(before.reason, REASON);
  const rejected = review.guardDecisionBanner({ ...returned, approvalStatus: 'rejected' }, [item({ action: 'rejected', reason: 'Duplicate of shift 70.' })], when);
  assert.equal(rejected.tone, 'danger');
  assert.equal(rejected.reason, 'Duplicate of shift 70.');
  assert.equal(review.guardDecisionBanner(timesheet(), GUARD_HISTORY, when), null, 'no banner unless returned / rejected');
});

test('TR-06-APPROVAL-PLAN-FOLLOWS-THE-SERVER-OVERRIDE-RULE', () => {
  const base = { claimedHours: 8.5, verifiedMinutes: 455 };
  const claimNoReason = review.planApproval({ ...base, choice: 'claimed' });
  assert.equal(claimNoReason.ok, false, "approving the Guard's claim when it differs from verified needs a reason");
  assert.match(claimNoReason.error, /8h 30m differs from the verified 7h 35m/);
  const claim = review.planApproval({ ...base, choice: 'claimed', reason: 'Site confirmed late relief.' });
  assert.deepEqual(claim.payload, { approvalStatus: 'approved', approvedMinutes: 510, overrideReason: 'Site confirmed late relief.', companyNote: null, rejectionReason: null });
  const verifiedNoReason = review.planApproval({ ...base, choice: 'verified' });
  assert.equal(verifiedNoReason.ok, false, 'paying less than the claim tells the Guard why');
  assert.match(verifiedNoReason.error, /differs from the Guard's claim of 8h 30m/);
  const verified = review.planApproval({ ...base, choice: 'verified', reason: 'Paid to Book Off.', companyNote: 'Thanks' });
  assert.deepEqual(verified.payload, { approvalStatus: 'approved', approvedMinutes: 455, overrideReason: null, companyNote: 'Thanks\nApproved hours: Paid to Book Off.', rejectionReason: null },
    'approved = verified keeps no override reason on the server, so the reason goes in the company note');
  const same = review.planApproval({ claimedHours: 8.5, verifiedMinutes: 510, choice: 'claimed' });
  assert.deepEqual([same.ok, same.reasonRequired, same.payload.overrideReason, same.payload.approvedMinutes], [true, false, null, 510], 'claim = verified: no reason');
  const otherNone = review.planApproval({ ...base, choice: 'other' });
  assert.match(otherNone.error, /Enter the hours and minutes/);
  const otherNoReason = review.planApproval({ claimedHours: 8.5, verifiedMinutes: 455, choice: 'other', otherMinutes: 455 });
  assert.equal(otherNoReason.ok, false, 'other hours always need a reason');
  const other = review.planApproval({ ...base, choice: 'other', otherMinutes: 480, reason: 'Agreed 8h with the client.' });
  assert.deepEqual([other.payload.approvedMinutes, other.payload.overrideReason], [480, 'Agreed 8h with the client.']);
  const noVerified = review.planApproval({ claimedHours: 8.5, verifiedMinutes: null, choice: 'claimed' });
  assert.match(noVerified.error, /no verified attendance/);
  assert.match(review.planApproval({ claimedHours: 8.5, verifiedMinutes: null, choice: 'verified' }).error, /no verified attendance/);
});

// ═══ the real Guard card ═══

async function mountGuard(timesheets) {
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(h(GuardTimesheetsScreen, { timesheets, attendance: [], onReload: async () => {} }));
  });
  await settle();
  return renderer;
}

test('TR-07-THE-GUARD-SEES-WHO-RETURNED-IT-WHEN-AND-WHY-AT-THE-TOP', async () => {
  writes.length = 0;
  historyAnswer = { items: GUARD_HISTORY };
  const renderer = await mountGuard([timesheet({ approvalStatus: 'returned', hoursWorked: 9.5, rejectionReason: REASON, reviewedAt: iso(START + 10 * HOUR) })]);
  const text = textOf(renderer.root);
  const top = text.indexOf('Returned by Sam Reviewer (Acme Security) on ');
  assert.ok(top >= 0, 'reviewer, company and time');
  assert.ok(top < text.indexOf('Booked on'), 'at the top of the card, above the times');
  assert.ok(text.includes(REASON), 'the real reason, not a status');
  assert.ok(text.includes('What to do: correct your hours or note and submit again.'));
  assert.ok(!text.includes('Returned for correction by company reviewer'), 'no generic default');
  assert.ok(text.includes('History') && text.includes('Submitted by You') && text.includes('Returned for correction by Sam Reviewer'), 'the history list');
  assert.deepEqual(writes.filter(([k]) => k !== 'readHistory'), [], 'reading wrote nothing');
  act(() => renderer.unmount());
});

test('TR-08-THE-GUARD-CORRECTS-WITH-HOURS-AND-MINUTES-AND-RESUBMITS', async () => {
  writes.length = 0;
  historyAnswer = { items: GUARD_HISTORY };
  const renderer = await mountGuard([timesheet({ approvalStatus: 'returned', hoursWorked: 9.5, rejectionReason: REASON })]);
  const value = (label) => renderer.root.findAll((n) => n.props && n.props.accessibilityLabel === label && typeof n.props.onChangeText === 'function')[0].props.value;
  assert.deepEqual([value('Hours worked'), value('Minutes worked')], ['9', '30'], '9.50 is shown as 9 hours 30 minutes');
  assert.ok(textOf(renderer.root).includes('= 9h 30m (9.50 h)'), 'the parsed result, live');
  await typeInto(renderer.root, 'Hours worked', '8.5');
  assert.ok(textOf(renderer.root).includes('Use whole numbers'), 'a decimal is refused with a hint');
  await pressByText(renderer.root, 'Submit timesheet');
  assert.deepEqual(writes.filter(([k]) => k === 'submitTimesheet'), [], 'nothing sent while invalid');
  await typeInto(renderer.root, 'Hours worked', '8');
  await typeInto(renderer.root, 'Minutes worked', '34');
  assert.ok(textOf(renderer.root).includes('= 8h 34m (8.57 h)'));
  await pressByText(renderer.root, 'Submit timesheet');
  const sent = writes.filter(([k]) => k === 'submitTimesheet');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1], [40, { hoursWorked: 8.57, guardNote: 'Site finished early' }], 'the existing decimal hoursWorked (the server derives 514 minutes)');
  assert.equal(Math.round(sent[0][1][1].hoursWorked * 60), 514);
  act(() => renderer.unmount());
});

test('TR-09-A-GUARD-CARD-OPENS-ITS-HISTORY-ON-REQUEST', async () => {
  writes.length = 0;
  historyAnswer = { items: [GUARD_HISTORY[0]] };
  const renderer = await mountGuard([timesheet({ approvalStatus: 'submitted' })]);
  assert.deepEqual(writes, [], 'a submitted card reads no history until asked');
  assert.ok(textOf(renderer.root).includes('Claimed hours8h 30m (8.50 h)'), 'claimed hours read as hours and minutes');
  await pressByText(renderer.root, 'Show history');
  assert.deepEqual(writes, [['readHistory', [40]]]);
  assert.ok(textOf(renderer.root).includes('Submitted by You'));
  historyAnswer = [];
  act(() => renderer.unmount());
  // An older server (no history route / an unexpected answer) shows "no history", never an error.
  const old = await mountGuard([timesheet({ approvalStatus: 'returned', rejectionReason: REASON, reviewedAt: iso(START) })]);
  const oldText = textOf(old.root);
  assert.ok(oldText.includes('Returned by Acme Security on ') && oldText.includes(REASON) && oldText.includes('No history recorded yet.'));
  act(() => old.unmount());
});

// ═══ the real company review panel ═══

async function mountWorkspace(timesheets) {
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(h(CompanyTimesheetsWorkspace, { timesheets, refreshing: false, onRefresh: async () => {} }));
  });
  await settle();
  await pressByText(renderer.root, 'Review Site');
  return renderer;
}
const decisions = () => writes.filter(([k]) => k === 'updateTimesheet');

test('TR-10-RETURN-AND-REJECT-NEED-A-REASON-AND-SEND-IT', async () => {
  writes.length = 0;
  historyAnswer = { items: [] };
  const renderer = await mountWorkspace([timesheet()]);
  // The row's quick Return opens the panel and asks for the reason; nothing is sent.
  await pressByText(renderer.root, 'Return');
  assert.deepEqual(decisions(), []);
  assert.ok(textOf(renderer.root).includes('Reason required'));
  assert.ok(textOf(renderer.root).includes('Reason for return or rejection'), 'the panel is open');
  await pressByText(renderer.root, 'Return for correction');
  await pressByText(renderer.root, 'Reject');
  assert.deepEqual(decisions(), [], 'no reason: nothing sent, no generic default');
  await typeInto(renderer.root, 'Reason for return or rejection', '  ok  ');
  await pressByText(renderer.root, 'Return for correction');
  assert.deepEqual(decisions(), [], 'a token reason is refused');
  assert.ok(textOf(renderer.root).includes('at least 5 characters'));
  await typeInto(renderer.root, 'Reason for return or rejection', `  ${REASON}  `);
  await pressByText(renderer.root, 'Return for correction');
  assert.deepEqual(decisions(), [['updateTimesheet', [40, { approvalStatus: 'returned', rejectionReason: REASON }]]]);
  await pressByText(renderer.root, 'Reject');
  assert.deepEqual(decisions()[1], ['updateTimesheet', [40, { approvalStatus: 'rejected', rejectionReason: REASON }]]);
  act(() => renderer.unmount());
});

test('TR-11-APPROVAL-SAYS-WHICH-HOURS-AND-ASKS-FOR-THE-REASON-UP-FRONT', async () => {
  writes.length = 0;
  const renderer = await mountWorkspace([timesheet()]);
  // Quick Approve on the row: the claim (8h 30m) differs from verified (7h 35m), so it opens the panel instead.
  await pressByText(renderer.root, 'Approve');
  assert.deepEqual(decisions(), []);
  const panel = textOf(renderer.root);
  for (const words of ['Claimed: 8h 30m (8.50 h) · Verified attendance: 7h 35m (7.58 h)',
    'The claim differs from the verified attendance by 55m: approving the claimed or other hours needs a reason.',
    'Approve claimed hours (8h 30m)', 'Approve verified hours (7h 35m)', 'Approve other hours']) {
    assert.ok(panel.includes(words), `the panel shows "${words}"`);
  }
  await pressByText(renderer.root, 'Approve claimed hours (8h 30m)');
  assert.deepEqual(decisions(), [], 'approving the claim without a reason sends nothing');
  assert.ok(textOf(renderer.root).includes('8h 30m differs from the verified 7h 35m, so a reason is required.'));
  await pressByText(renderer.root, 'Approve other hours');
  assert.deepEqual(decisions(), []);
  await typeInto(renderer.root, 'Other hours: hours', '8');
  await typeInto(renderer.root, 'Other hours: minutes', '0');
  await pressByText(renderer.root, 'Approve other hours (8h)');
  assert.deepEqual(decisions(), [], 'other hours without a reason send nothing');
  await typeInto(renderer.root, 'Reason for the approved hours', 'Site confirmed relief at 08:30.');
  await pressByText(renderer.root, 'Approve claimed hours (8h 30m)');
  assert.deepEqual(decisions(), [['updateTimesheet', [40, { approvalStatus: 'approved', approvedMinutes: 510, overrideReason: 'Site confirmed relief at 08:30.', companyNote: null, rejectionReason: null }]]]);
  await pressByText(renderer.root, 'Approve other hours (8h)');
  assert.deepEqual(decisions()[1][1][1].approvedMinutes, 480);
  for (const [, [, body]] of decisions()) {
    for (const forbidden of ['hoursWorked', 'workedMinutes', 'actualCheckInAt', 'actualCheckOutAt', 'verifiedMinutes']) {
      assert.ok(!(forbidden in body), `approval never rewrites ${forbidden}`);
    }
  }
  act(() => renderer.unmount());

  // Claim = verified: the row's quick Approve approves the claim with no reason, as before.
  writes.length = 0;
  const same = await mountWorkspace([timesheet({ hoursWorked: 7.58, verifiedMinutes: 455 })]);
  await pressByText(same.root, 'Approve');
  assert.deepEqual(decisions(), [['updateTimesheet', [40, { approvalStatus: 'approved', approvedMinutes: 455, overrideReason: null, companyNote: null, rejectionReason: null }]]]);
  act(() => same.unmount());
});

test('TR-12-THE-COMPANY-SEES-THE-REVIEW-HISTORY-AFTER-RESUBMISSION', async () => {
  writes.length = 0;
  historyAnswer = { items: [
    item({ action: 'submitted', actorRole: 'guard', actorName: 'Ava Guard', claimedMinutesAfter: 570, at: iso(START + 9 * HOUR) }),
    item({ action: 'returned', claimedMinutesAfter: 570, reason: REASON }),
    item({ action: 'resubmitted', actorRole: 'guard', actorName: 'Ava Guard', claimedMinutesBefore: 570, claimedMinutesAfter: 510, at: iso(START + 11 * HOUR) }),
  ] };
  const renderer = await mountWorkspace([timesheet()]);
  await pressByText(renderer.root, 'Review');
  const text = textOf(renderer.root);
  for (const words of ['REVIEW HISTORY', 'Submitted by Ava Guard', 'Returned for correction by Sam Reviewer', `Reason: ${REASON}`,
    'Corrected and resubmitted by Ava Guard', 'Claim changed from 9h 30m to 8h 30m (8.50 h)']) {
    assert.ok(text.includes(words), `history shows "${words}"`);
  }
  assert.ok(writes.some(([k, a]) => k === 'readHistory' && a[0] === 40));
  assert.ok(text.includes('8h 30m'), 'the row claim in hours and minutes');
  assert.ok(!/\b8\.50 h\b(?! ?\))/.test(text.replace(/\(8\.50 h\)/g, '')), 'no bare decimal hours left in the review');
  act(() => renderer.unmount());
});

// ═══ wiring ═══

test('TR-13-WIRING-AND-THE-RELEASE-GATE', () => {
  const ws = stripComments(read('src/components/company/CompanyTimesheetsWorkspace.tsx'));
  assert.ok(!ws.includes('Returned for correction by company reviewer.') && !ws.includes('Rejected by company reviewer.'), 'no generic default reason');
  assert.ok(!ws.includes("keyboardType=\"decimal-pad\""), 'no decimal hours input in the review panel');
  const guard = stripComments(read('src/screens/GuardTimesheetsScreen.tsx'));
  assert.ok(!guard.includes('decimal-pad') && !guard.includes('e.g. 8 or 7.5'), 'no decimal claim input');
  assert.ok(!/toFixed\(2\)\} h/.test(guard), 'no decimal-only hours on the Guard card');
  for (const rel of ['src/services/timesheetHours.ts', 'src/services/timesheetReview.ts']) {
    assert.doesNotMatch(read(rel), /from '\.\/api'|fetch\(/, `${rel} is pure`);
  }
  const apiSrc = read('src/services/api.ts');
  assert.ok(apiSrc.includes('`/timesheets/${id}/history`'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:timesheet-review-ux'], 'node scripts/timesheet-review-ux.spec.cjs');
  const workflow = fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 's4-mobile-release-gate.yml'), 'utf8');
  assert.ok(workflow.includes('run: npm run test:timesheet-review-ux'));
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
  console.log(`\n${passed}/${pending.length} timesheet review UX checks passed`);
  process.exit(process.exitCode || 0);
})();
