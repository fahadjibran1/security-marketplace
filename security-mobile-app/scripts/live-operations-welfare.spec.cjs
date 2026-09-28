/**
 * W3 Live Operations welfare + Log Book presentation.
 *
 * Two kinds of check, deliberately:
 *   - the pure presentation module is transpiled and EXECUTED, so the wording, tone and site-local
 *     formatting are tested as behaviour rather than as source text;
 *   - the board and drawer wiring is asserted against source, which is how the other mobile specs
 *     verify that a component renders what it was given.
 *
 * The board must never recompute a window, a count or a due time: the backend decides those, and a
 * second implementation here would eventually disagree with it.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── load the pure presentation module for real ─────────────────────────────────────────────────────
function loadModule(rel) {
  const source = read(rel);
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const m = new Module(rel, null);
  m.filename = path.join(ROOT, rel);
  m.paths = Module._nodeModulePaths(path.dirname(m.filename));
  m._compile(js, m.filename);
  return m.exports;
}

const ops = loadModule('src/components/company/operationsPresentation.ts');

const board = read('src/components/company/CompanyLiveOperationsWorkspace.tsx');
const dashboard = read('src/screens/CompanyDashboardScreen.tsx');
const models = read('src/types/models.ts');

const TZ = 'Europe/London';
const iso = (h, m = 0, day = 15) => new Date(Date.UTC(2026, 5, day, h, m)).toISOString();

const welfare = (over = {}) => ({
  enabled: true, intervalMinutes: 60, status: 'due',
  currentWindow: { index: 3, start: iso(20), end: iso(21) },
  lastWelfareAt: null, nextDueAt: iso(21), overdueByMinutes: null,
  requiredCount: 4, completedCount: 0, missedCount: 0, consecutiveMissed: 0, ...over,
});
const logBook = (over = {}) => ({
  required: false, intervalMinutes: null, currentWindow: null, currentWindowSubmitted: false,
  requiredCount: 0, submittedCount: 0, missingCount: 0, lastEntryAt: null, ...over,
});
const view = (over = {}) => ({
  bookOnAt: iso(18), bookOffAt: null, timezone: TZ,
  welfare: welfare(), logBook: logBook(), welfareSummary: null,
  welfareEvidenceCount: 0, missingBookOff: false, ...over,
});

// ═══════════════════ 27–28 the screen still renders, and CURRENT reads correctly ═══════════════════

test('W3F-27-LIVE-OPERATIONS-BOARD-STILL-RENDERS-ITS-EXISTING-COLUMNS', () => {
  for (const header of ['Site / Guard', 'Scheduled', 'Attendance', 'Status', 'Risk', 'Alerts', 'Action']) {
    assert.ok(board.includes(`'${header}'`), `the existing ${header} column must remain`);
  }
  assert.ok(board.includes("'Welfare / Log Book'"), 'and one new stacked column is added');
  // One column, not two: the board already carried seven.
  const headerLine = board.split('\n').find((l) => l.includes('BOARD_COL_HDR ='));
  assert.equal((headerLine.match(/'/g) || []).length / 2, 8, 'exactly eight columns');
});

test('W3F-28-WELFARE-CURRENT-RENDERS-AS-CURRENT', () => {
  const cell = ops.welfareCell(welfare({ status: 'current', completedCount: 1 }), TZ);
  assert.equal(cell.label, 'CURRENT');
  assert.equal(cell.tone, 'good');
  assert.equal(cell.missedSummary, null, 'nothing missed, so no missed line');
});

test('W3F-29-WELFARE-DUE-RENDERS-THE-NEXT-DUE-TIME', () => {
  const cell = ops.welfareCell(welfare({ status: 'due' }), TZ);
  assert.equal(cell.label, 'DUE');
  // 21:00 UTC in June is 22:00 in London: the board reads in site-local time.
  assert.equal(cell.detail, 'Next 22:00');
});

test('W3F-30-WELFARE-OVERDUE-RENDERS-CLEARLY', () => {
  const cell = ops.welfareCell(
    welfare({ status: 'overdue', overdueByMinutes: 3, nextDueAt: iso(21) }), TZ);
  assert.equal(cell.label, 'OVERDUE');
  assert.equal(cell.tone, 'warning');
  assert.match(cell.detail, /Due 22:00/);
  assert.match(cell.detail, /3 min over/);
});

test('W3F-31-MISSED-COUNT-RENDERS', () => {
  const cell = ops.welfareCell(welfare({ status: 'missed', missedCount: 5, consecutiveMissed: 0 }), TZ);
  assert.equal(cell.label, 'MISSED');
  assert.equal(cell.tone, 'danger');
  assert.equal(cell.missedSummary, '5 missed');
});

test('W3F-32-CONSECUTIVE-MISSES-RENDER-WHEN-ABOVE-ZERO', () => {
  const none = ops.welfareCell(welfare({ missedCount: 0, consecutiveMissed: 0 }), TZ);
  assert.equal(none.missedSummary, null);
  const run = ops.welfareCell(welfare({ status: 'missed', missedCount: 5, consecutiveMissed: 2 }), TZ);
  assert.equal(run.missedSummary, '2 consecutive missed', 'the number a control room acts on');
});

// ═══════════════════ 33–34 Log Book ═══════════════════

test('W3F-33-LOG-BOOK-AS-REQUIRED-RENDERS-NEUTRALLY', () => {
  const cell = ops.logBookCell(logBook({ required: false }), TZ);
  assert.equal(cell.label, 'As required');
  assert.equal(cell.tone, 'neutral', 'no obligation, so no warning colour');
  assert.equal(cell.detail, null);
});

test('W3F-34-LOG-BOOK-MISSING-IS-AMBER-NOT-URGENT-RED', () => {
  const cell = ops.logBookCell(
    logBook({ required: true, intervalMinutes: 60, missingCount: 1, submittedCount: 3 }), TZ);
  assert.equal(cell.label, '1 missing');
  assert.equal(cell.tone, 'warning', 'incomplete paperwork is amber');
  assert.notEqual(cell.tone, 'danger', 'it is not a possible harm to a person');
});

// ═══════════════════ 35–37 exceptions ═══════════════════

test('W3F-35-MISSING-BOOK-OFF-APPEARS-AS-AN-OPERATIONAL-EXCEPTION', () => {
  const items = ops.operationalExceptions(view({ missingBookOff: true }));
  const bookOff = items.find((i) => i.key === 'missing-book-off');
  assert.ok(bookOff, 'it is surfaced');
  assert.equal(bookOff.label, 'BOOK OFF MISSING');
  assert.equal(bookOff.tone, 'warning', 'an operational exception, not a welfare breach or a panic');
});

test('W3F-36-TWENTYFOUR-MISSED-WINDOWS-PRODUCE-ONE-ITEM-NOT-TWENTYFOUR', () => {
  // The measured W2 case. Evidence is a count, never a list, so the queue cannot be flooded.
  const items = ops.operationalExceptions(view({
    welfare: welfare({ status: 'missed', missedCount: 24, consecutiveMissed: 24 }),
    welfareEvidenceCount: 24,
  }));
  const welfareItems = items.filter((i) => i.key.startsWith('welfare'));
  assert.equal(welfareItems.length, 1, `exactly one welfare item, got ${welfareItems.length}`);
  assert.match(welfareItems[0].detail, /24 consecutive Welfare Checks missed/);
});

test('W3F-37-ONE-SUMMARY-PRODUCES-ONE-ACTIONABLE-ITEM-AND-ACK-IS-SHOWN', () => {
  const open = ops.operationalExceptions(view({
    welfare: welfare({ status: 'missed', missedCount: 3, consecutiveMissed: 3 }),
    welfareSummary: { id: 1, status: 'open', message: 'Welfare overdue - 3 consecutive checks missed', acknowledged: false, createdAt: iso(21) },
  }));
  const items = open.filter((i) => i.key.startsWith('welfare'));
  assert.equal(items.length, 1, 'the summary replaces the derived item rather than adding to it');
  assert.equal(items[0].label, 'WELFARE OVERDUE');

  const acked = ops.operationalExceptions(view({
    welfare: welfare({ status: 'missed', missedCount: 3, consecutiveMissed: 3 }),
    welfareSummary: { id: 1, status: 'acknowledged', message: 'Welfare overdue - 3 consecutive checks missed', acknowledged: true, createdAt: iso(21) },
  })).filter((i) => i.key.startsWith('welfare'));
  assert.equal(acked.length, 1);
  assert.match(acked[0].label, /ACKNOWLEDGED/, 'shown as in progress');
  assert.match(acked[0].detail, /3 consecutive checks missed/, 'without hiding how bad it is');
});

// ═══════════════════ 38–40 filters, drawer, refresh ═══════════════════

test('W3F-38-EXISTING-FILTERS-AND-METRIC-FOCUS-ARE-UNTOUCHED', () => {
  for (const marker of ['LiveFilters', 'metricFocus', 'onMetricPress', "'not-booked'", "'missed-checks'"]) {
    assert.ok(board.includes(marker), `${marker} must still exist`);
  }
});

test('W3F-39-DRAWER-SHOWS-BOOK-ON-WELFARE-LOG-BOOK-AND-BOOK-OFF', () => {
  assert.ok(board.includes('Operational monitoring'), 'the drawer gains a monitoring card');
  assert.ok(board.includes('operationsDetailLines'), 'built from the shared presentation module');
  const sections = ops.operationsDetailLines(view({
    welfare: welfare({ status: 'missed', lastWelfareAt: iso(19, 41), completedCount: 3, missedCount: 1, consecutiveMissed: 1 }),
    logBook: logBook({ required: true, intervalMinutes: 60, submittedCount: 3, missingCount: 1 }),
  }));
  assert.deepEqual(sections.map((s) => s.heading), ['Book On', 'Welfare Check', 'Log Book', 'Book Off']);
  const lines = sections.flatMap((s) => s.lines).join(' | ');
  assert.match(lines, /Last: 20:41/, 'site-local last welfare');
  assert.match(lines, /Completed: 3/);
  assert.match(lines, /Missed: 1/);
  assert.match(lines, /Consecutive missed: 1/);
  assert.match(lines, /Required: Hourly/);
  assert.match(lines, /Current: Entry due/);
  assert.equal(sections[3].lines[0], '—', 'no Book Off yet reads as a dash, not "Invalid Date"');
});

test('W3F-40-THE-PROJECTION-RIDES-THE-EXISTING-15-SECOND-REFRESH', () => {
  // One polling loop, not two.
  const intervals = dashboard.split('setInterval').length - 1;
  assert.equal(intervals, 1, `exactly one polling loop, found ${intervals}`);
  assert.ok(dashboard.includes('}, 15000);'), 'still fifteen seconds');
  assert.ok(
    dashboard.includes("label: 'live operations monitoring'"),
    'the projection is a loader in the existing set, so it refreshes on that same cycle',
  );
  // Board state lives outside the fetched data, so a refresh cannot reset the selection or filters.
  assert.ok(dashboard.includes('setOperationsByShiftId'), 'refresh replaces only the projection map');
  assert.ok(
    /selectedShiftId/.test(dashboard) && !/setSelectedShiftId\(null\)[^\n]*\n[^\n]*loadData/.test(dashboard),
    'a background refresh does not clear the selected shift',
  );
});

// ═══════════════════ supporting guarantees ═══════════════════

test('W3F-41-THE-BOARD-PRESENTS-AND-NEVER-RECOMPUTES', () => {
  // No window arithmetic in the frontend: these are the shapes that would betray a second engine.
  for (const banned of ['intervalMinutes *', 'welfareWindowIndex ===', 'Math.floor((now', 'GRACE_MINUTES']) {
    assert.ok(!board.includes(banned), `the board must not recompute windows (${banned})`);
  }
  assert.ok(models.includes('WelfarePresentationStatus'), 'the status is a backend-decided value');
});

test('W3F-42-MISSING-PROJECTION-DEGRADES-QUIETLY', () => {
  // A shift with no projection yet, or whose obligation is over, must not break a cell.
  const cell = ops.welfareCell(undefined, TZ);
  assert.equal(cell.label, '—');
  assert.equal(cell.tone, 'neutral');
  assert.deepEqual(ops.operationalExceptions(null), [], 'and contributes no exceptions');
  assert.deepEqual(ops.operationsDetailLines(null), []);
  assert.equal(ops.formatSiteTime(null, TZ), '—');
  assert.equal(ops.formatSiteTime('not-a-date', TZ), '—');
});

test('W3F-43-SITE-LOCAL-DISPLAY-SURVIVES-A-DST-CHANGE', () => {
  // The same UTC instant reads as GMT in January and BST in June, from one unchanged stored value.
  const winter = ops.formatSiteTime(new Date(Date.UTC(2026, 0, 15, 21, 0)).toISOString(), TZ);
  const summer = ops.formatSiteTime(new Date(Date.UTC(2026, 5, 15, 21, 0)).toISOString(), TZ);
  assert.equal(winter, '21:00', 'GMT');
  assert.equal(summer, '22:00', 'BST');
  assert.equal(ops.formatSiteWindow({ start: iso(20), end: iso(21) }, TZ), '21:00–22:00');
});

console.log(`\n${passed} live operations welfare presentation checks passed`);
