#!/usr/bin/env node
/**
 * PRODUCTION UAT FIX 01 — entering Live Operations, and the live carry-over shift.
 *
 * Two defects found on the real production board minutes after the Phase 4A deployment:
 *
 *   1. Navigating Dashboard → Live Operations opened the Shift Operations drawer by itself, over the
 *      board, for a shift the operator had not chosen — and reopened it a few seconds after they closed
 *      it.
 *
 *   2. The same screen disagreed with itself: LIVE SHIFTS = 1, Today So Far = 1 shift, the drawer said
 *      "Shift #19 · Live", and the timeline behind it said "0 shifts · No live or scheduled operations".
 *
 * The production shift is reproduced exactly: 30 Sep 20:35–21:35 London, Book On 20:33, no Book Off,
 * read at 10:55 on 1 Oct.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

const timeline = loadTs('src/components/company/operationsTimeline.ts');
const policy = loadTs('src/components/company/liveOperationsPolicy.ts');
const summary = loadTs('src/components/company/operationsSummary.ts');
const outlook = loadTs('src/components/company/operationsOutlook.ts');

const LONDON = 'Europe/London';
const MIN = 60_000;
const HOUR = 60 * MIN;
/** 10:55 Europe/London on 1 October 2026 — the browser clock in the production evidence. */
const NOW = Date.parse('2026-10-01T09:55:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const screenSource = fs.readFileSync(path.join(ROOT, 'src/screens/CompanyDashboardScreen.tsx'), 'utf8');
const workspaceSource = fs.readFileSync(
  path.join(ROOT, 'src/components/company/CompanyLiveOperationsWorkspace.tsx'), 'utf8',
);

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log('PASS ', name);
  } catch (error) {
    console.error('FAIL ', name);
    console.error(error.message);
    process.exitCode = 1;
  }
};

/** The production shift, as the board carries it. */
const SHIFT_19 = {
  shift: {
    id: 19,
    start: '2026-09-30T19:35:00.000Z',
    end: '2026-09-30T20:35:00.000Z',
    status: 'in_progress',
    site: { id: 7, name: 'test site', timezone: LONDON },
    guard: { fullName: 'Fahad test' },
  },
  attendance: { checkInAt: '2026-09-30T19:33:00.000Z', checkOutAt: null },
  operations: null,
  logs: [], incidents: [], alerts: [],
};

/**
 * The body of `loadData`, which is the callback the 15-second refresh re-runs.
 *
 * Isolated by paren-matching from its opening line so an assertion about "the loader" really is about
 * the loader and not about the whole 6,700-line screen.
 */
function loaderBody() {
  const start = screenSource.indexOf('const loadData = React.useMemo(');
  assert.ok(start >= 0, 'the company data loader must be findable');
  let depth = 0;
  for (let i = start; i < screenSource.length; i += 1) {
    const ch = screenSource[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      // Comments are stripped: these assertions are about what the loader DOES, and a comment
      // explaining the removed behaviour must not read as the behaviour itself.
      if (depth === 0) return stripComments(screenSource.slice(start, i + 1));
    }
  }
  throw new Error('the loader callback is unterminated');
}

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ═══════════════════ 1-4 · entering, opening and closing the drawer ═══════════════════

test('ENTRY-01-A-DATA-LOAD-NEVER-SELECTS-A-SHIFT', () => {
  // ROOT CAUSE. The loader used to run `if (!selectedShiftId && latestShifts[0]) setSelectedShiftId(...)`.
  // Harmless while the shift detail was an inline card; Phase 4A made that state a modal drawer, so a
  // plain navigation into Live Operations opened one over the board.
  const body = loaderBody();
  assert.ok(
    !/setSelectedShiftId\s*\(/.test(body),
    'the data loader must not select a shift — a shift is opened by the operator, never by a load',
  );
  assert.ok(
    !/latestShifts\[0\]/.test(body),
    'and must not reach for the first shift in the list',
  );
});

test('ENTRY-02-THE-SELECTION-STARTS-EMPTY', () => {
  assert.ok(
    /const \[selectedShiftId, setSelectedShiftId\] = React\.useState<number \| null>\(null\);/.test(screenSource),
    'nothing is selected until the operator selects it',
  );
});

test('ENTRY-03-THE-REFRESH-CANNOT-REOPEN-A-CLOSED-DRAWER', () => {
  // The second half of the defect: the loader also runs on every 15-second refresh, so a drawer the
  // operator closed came back a few seconds later. It cannot now, for two independent reasons.
  const body = loaderBody();
  assert.ok(!/setSelectedShiftId\s*\(/.test(body), 'the refresh does not select');
  assert.ok(
    !/selectedShiftId/.test(body.slice(body.lastIndexOf('['))),
    'and selectedShiftId is no longer a dependency, so opening or closing a shift does not re-run the load',
  );
});

test('ENTRY-04-EVERY-REMAINING-SELECTION-IS-AN-EXPLICIT-OPERATOR-ACTION', () => {
  // The fix must not destroy legitimate selection. These are the paths that open a shift on purpose.
  for (const handler of [
    'const focusShiftInLiveBoard',      // timeline row / shift bar
    'const focusShiftDetail',           // shift detail action
    'const handleOpenUrgentDetail',     // Attention item
    'const handleLiveBoardPrimaryAction', // Open Shift
  ]) {
    assert.ok(screenSource.includes(handler), `${handler} still exists`);
  }
  assert.ok(
    /onSelectShift=\{setSelectedShiftId\}/.test(workspaceSource),
    'a timeline row selects the shift it belongs to',
  );
  assert.ok(
    /onClose=\{\(\) => setSelectedShiftId\(null\)\}/.test(workspaceSource),
    'and closing the drawer clears the selection',
  );
  assert.ok(
    /visible=\{!!effectiveSelectedShiftContext\}/.test(workspaceSource),
    'the drawer is open exactly when a shift is selected — there is no separate open flag to drift',
  );
});

// ═══════════════════ 5-6 · the live carry-over shift ═══════════════════

test('CARRYOVER-01-A-LIVE-SHIFT-FROM-YESTERDAY-IS-ON-TODAYS-TIMELINE', () => {
  // The production case. At 10:55 the next morning the guard is still on site, so the board must show
  // them — at every range, not just the wide ones.
  for (const hours of [4, 8, 12, 24]) {
    const window = timeline.resolveTimelineWindow(NOW, hours, LONDON);
    const groups = timeline.buildTimeline([SHIFT_19], window, NOW);
    assert.equal(timeline.timelineRowCount(groups), 1, `${hours}h view shows the live shift`);

    const [row] = groups[0].rows;
    assert.equal(row.status, 'Live');
    assert.equal(row.scheduled, '20:35–21:35', 'the identity column still states the SCHEDULE truthfully');
    assert.equal(row.attendance.bookOn, 'ON 20:33');
    assert.equal(row.attendance.bookOff, 'OFF —');
    assert.ok(row.span.clippedStart, 'and the bar says it began before this view');
  }
});

test('CARRYOVER-02-THE-BAR-RUNS-TO-NOW-BECAUSE-THE-SHIFT-HAS-NOT-ENDED', () => {
  const end = timeline.effectiveShiftEndMs(SHIFT_19.shift, SHIFT_19.attendance, NOW);
  assert.equal(end, NOW, 'a Book On with no Book Off is an open-ended occupancy');

  // And it keeps running: ten minutes later the bar is ten minutes longer.
  const later = NOW + 10 * MIN;
  assert.equal(timeline.effectiveShiftEndMs(SHIFT_19.shift, SHIFT_19.attendance, later), later);
});

test('CARRYOVER-03-NOTHING-ELSE-FROM-YESTERDAY-COMES-BACK', () => {
  // The distinction the fix must preserve. Only an unsettled, booked-on, not-booked-off shift carries
  // over; every other previous-day row keeps its scheduled end and stays off today's axis.
  const window = timeline.resolveTimelineWindow(NOW, 8, LONDON);
  const drawn = (row) => timeline.timelineRowCount(timeline.buildTimeline([row], window, NOW));

  const completed = {
    ...SHIFT_19,
    shift: { ...SHIFT_19.shift, status: 'completed' },
    attendance: { checkInAt: '2026-09-30T19:33:00.000Z', checkOutAt: '2026-09-30T20:36:00.000Z' },
  };
  const bookedOffButNotSettled = {
    ...SHIFT_19,
    attendance: { checkInAt: '2026-09-30T19:33:00.000Z', checkOutAt: '2026-09-30T20:36:00.000Z' },
  };
  const neverBookedOn = { ...SHIFT_19, shift: { ...SHIFT_19.shift, status: 'missed' }, attendance: undefined };
  const unfilled = { ...SHIFT_19, shift: { ...SHIFT_19.shift, status: 'unfilled' }, attendance: undefined };
  const ordinaryReady = { ...SHIFT_19, shift: { ...SHIFT_19.shift, status: 'ready' }, attendance: undefined };

  assert.equal(drawn(completed), 0, 'a completed shift is history');
  assert.equal(drawn(bookedOffButNotSettled), 0, 'so is one the guard booked off from');
  assert.equal(drawn(neverBookedOn), 0, 'a missed shift is not a carry-over');
  assert.equal(drawn(unfilled), 0, 'nor is an unfilled one');
  assert.equal(drawn(ordinaryReady), 0, 'nor an ordinary previous-day shift nobody booked on to');

  for (const row of [completed, bookedOffButNotSettled, neverBookedOn, unfilled, ordinaryReady]) {
    assert.equal(
      timeline.effectiveShiftEndMs(row.shift, row.attendance, NOW),
      Date.parse(row.shift.end),
      'each keeps its scheduled end',
    );
  }
});

test('CARRYOVER-05-THE-CARRY-OVER-IS-NOT-TIME-BOUNDED-BECAUSE-THE-POLICY-IS-NOT', () => {
  // A deliberate decision, recorded here because it is the one place the rule could reasonably have
  // gone the other way. The relevance policy holds `in_progress` with NO time bound — "a shift someone
  // is standing on is the control room's first responsibility whatever the clock says, and an
  // in_progress shift whose end passed long ago is itself the exception Control needs to see". The
  // LIVE SHIFTS metric counts it on that basis. If the timeline capped the carry-over at, say, 24
  // hours, the board would go empty while the metric still said 1 — which is the exact defect this fix
  // exists to remove, reintroduced one day later.
  const tenDaysAgo = {
    ...SHIFT_19,
    shift: { ...SHIFT_19.shift, id: 998, start: '2026-09-20T08:00:00.000Z', end: '2026-09-20T16:00:00.000Z' },
    attendance: { checkInAt: '2026-09-20T07:58:00.000Z', checkOutAt: null },
  };

  const decision = policy.classifyLiveOperation(
    { ...tenDaysAgo.shift, attendance: tenDaysAgo.attendance },
    { now: new Date(NOW), attendance: tenDaysAgo.attendance },
  );
  assert.equal(decision.include, true, 'the policy still calls it live');
  assert.equal(decision.reason, 'in_progress');

  const window = timeline.resolveTimelineWindow(NOW, 8, LONDON);
  assert.equal(
    timeline.timelineRowCount(timeline.buildTimeline([tenDaysAgo], window, NOW)), 1,
    'so the board shows it, and cannot disagree with the metric',
  );
});

test('CARRYOVER-04-AN-ORDINARY-LIVE-SHIFT-IS-UNTOUCHED', () => {
  // The rule must do nothing at all to a shift that is simply running on time.
  const running = {
    ...SHIFT_19,
    shift: { ...SHIFT_19.shift, id: 30, start: iso(NOW - HOUR), end: iso(NOW + 3 * HOUR) },
    attendance: { checkInAt: iso(NOW - 62 * MIN), checkOutAt: null },
  };
  assert.equal(
    timeline.effectiveShiftEndMs(running.shift, running.attendance, NOW),
    Date.parse(running.shift.end),
    'a shift still inside its scheduled window ends when it was scheduled to',
  );

  const upcoming = { ...SHIFT_19, shift: { ...SHIFT_19.shift, id: 31, start: iso(NOW + HOUR), end: iso(NOW + 9 * HOUR) }, attendance: undefined };
  assert.equal(timeline.effectiveShiftEndMs(upcoming.shift, upcoming.attendance, NOW), Date.parse(upcoming.shift.end));
});

// ═══════════════════ 7 · the screen stops contradicting itself ═══════════════════

test('AGREE-01-METRIC-TIMELINE-AND-TODAY-SO-FAR-TELL-THE-SAME-STORY', () => {
  // The production screenshot: metric 1, Today So Far 1, drawer "Live", timeline 0. Four readings of
  // one dataset, one of them different.
  const decision = policy.classifyLiveOperation(
    { ...SHIFT_19.shift, attendance: SHIFT_19.attendance },
    { now: new Date(NOW), attendance: SHIFT_19.attendance },
  );
  assert.equal(decision.include, true);
  assert.equal(decision.reason, 'in_progress');

  const rows = [SHIFT_19];
  const liveMetric = rows.filter((r) => r.shift.status === 'in_progress').length;
  const today = summary.buildTodaySoFar(rows, NOW);
  const window = timeline.resolveTimelineWindow(NOW, 8, LONDON);
  const drawn = timeline.timelineRowCount(timeline.buildTimeline(rows, window, NOW));

  assert.equal(liveMetric, 1, 'LIVE SHIFTS');
  assert.equal(drawn, 1, 'timeline rows');
  assert.equal(today.shiftCount, 1, 'Today So Far scope');
  assert.equal(today.attendance.bookedOn, 1, 'Today So Far attendance');
  assert.equal(liveMetric, drawn, 'the metric and the board agree');
  assert.equal(drawn, today.shiftCount, 'the board and the summary agree');
});

test('AGREE-02-THE-RAIL-DOES-NOT-INVENT-WORK-FOR-IT', () => {
  // Agreement means agreeing about what EXISTS, not every panel listing it. The shift's scheduled end
  // is thirteen hours past, so there is nothing upcoming and no handover to anticipate — and claiming
  // one would be the same disagreement in the other direction.
  const rows = [SHIFT_19];
  assert.deepEqual(outlook.buildNextUp(rows, NOW), [], 'nothing about it is upcoming');
  assert.deepEqual(outlook.buildHandovers(rows, NOW), [], 'and no replacement is implied');
});

// ═══════════════════ 8 · the filters still mean what they meant ═══════════════════

test('FILTER-01-AN-EXPLICIT-DATE-STILL-SCOPES-THE-BOARD', () => {
  // Selecting yesterday anchors the axis on yesterday at noon on the site clock, and the shift is drawn
  // at its real scheduled time there — the carry-over rule does not override a chosen date.
  const yesterdayNoon = Date.parse('2026-09-30T11:00:00.000Z');
  const window = timeline.resolveTimelineWindow(yesterdayNoon, 24, LONDON);
  const [group] = timeline.buildTimeline([SHIFT_19], window, NOW);
  assert.equal(group.rows.length, 1);
  assert.equal(group.rows[0].scheduled, '20:35–21:35');
  assert.ok(!group.rows[0].span.clippedStart, 'drawn at its own scheduled start, not clipped to an edge');
});

test('FILTER-02-SITE-GROUPING-AND-ZONES-ARE-UNCHANGED', () => {
  const other = {
    ...SHIFT_19,
    shift: {
      ...SHIFT_19.shift, id: 20, siteId: 9,
      site: { id: 9, name: 'MERCHANT FIELDS', timezone: 'America/New_York' },
      start: iso(NOW - 30 * MIN), end: iso(NOW + 4 * HOUR),
    },
    attendance: { checkInAt: iso(NOW - 31 * MIN), checkOutAt: null },
  };
  const window = timeline.resolveTimelineWindow(NOW, 8, LONDON);
  const groups = timeline.buildTimeline([SHIFT_19, other], window, NOW);

  assert.equal(groups.length, 2, 'two sites, two groups');
  assert.deepEqual(groups.map((g) => g.siteName), ['MERCHANT FIELDS', 'test site'], 'ordered by name');
  assert.equal(groups[0].timeZone, 'America/New_York', 'each group keeps its own site zone');
  assert.equal(groups[1].timeZone, LONDON);
});

// ═══════════════════ 9-10 · nothing else moved ═══════════════════

test('UNCHANGED-01-STILL-EXACTLY-ONE-POLLING-LOOP', () => {
  const files = [
    'src/screens/CompanyDashboardScreen.tsx',
    'src/components/company/CompanyLiveOperationsWorkspace.tsx',
    'src/components/company/CompanyOperationsTimeline.tsx',
    'src/components/company/operationsTimeline.ts',
  ];
  let intervals = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    intervals += (source.match(/setInterval\(/g) || []).length;
    assert.ok(!/new WebSocket|io\(/.test(source), `${file} opens no socket`);
  }
  assert.equal(intervals, 1, 'one operational refresh cycle, as before');
});

test('UNCHANGED-02-THE-ENGINE-AND-THE-POLICY-WERE-NOT-TOUCHED', () => {
  // The fix is in how a bar is drawn, not in what a shift IS. No Welfare window is computed here, no
  // attendance semantics are reinterpreted, and the relevance policy already had this case right.
  const source = fs.readFileSync(path.join(ROOT, 'src/components/company/operationsTimeline.ts'), 'utf8');
  assert.ok(!/welfare.*interval|grace|WELFARE_GRACE/i.test(source.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')),
    'the timeline still computes no Welfare window');
  assert.equal(policy.UPCOMING_HORIZON_MINUTES, 4 * 60, 'the +4h horizon is unchanged');
  assert.equal(policy.POST_END_ATTENTION_MINUTES, 24 * 60, 'the 24h derived-attention window is unchanged');
});

test('UNCHANGED-03-THE-EXPORT-STILL-REPORTS-THE-SCHEDULE', () => {
  // The export is a record of the shift, so it keeps reporting the scheduled end. Only the BAR extends.
  const report = loadTs('src/components/company/operationsReport.ts');
  const built = report.buildOperationsReport([SHIFT_19], { date: '2026-09-30', siteName: null });
  const row = built.summary[0];
  assert.equal(row[report.SUMMARY_COLUMNS.indexOf('Scheduled End')], '21:35', 'the scheduled end, unchanged');
  assert.equal(row[report.SUMMARY_COLUMNS.indexOf('Actual Book On')], '20:33');
  assert.equal(row[report.SUMMARY_COLUMNS.indexOf('Actual Book Off')], '', 'and no Book Off is invented');
});

console.log(`\n${passed} live operations entry checks passed`);
