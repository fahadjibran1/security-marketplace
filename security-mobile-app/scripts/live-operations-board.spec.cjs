#!/usr/bin/env node
/**
 * S4 Live Operations Phase 2: live / overdue / reconciliation, the selected date, and Today.
 *
 * THE PRODUCTION DEFECTS
 *   - Shifts 26 and 27 (13 Oct 19:00 – 14 Oct 05:00, booked on, never booked off) were LIVE on 16 Oct:
 *     the policy held every in_progress shift with no time bound.
 *   - "Today" cleared the date, which was already the default, so it did nothing; and picking another day
 *     only narrowed today's live set, so it usually showed nothing.
 *   - The web date control was a plain text box: React Native Web's TextInput drops `type="date"`.
 *
 * Executes the real policy, board and timeline modules (no copies), plus source checks for the wiring
 * that cannot be executed without a DOM.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const policy = loadTs('src/components/company/liveOperationsPolicy.ts');
const board = loadTs('src/components/company/liveOperationsBoard.ts');
const timeline = loadTs('src/components/company/operationsTimeline.ts');
const overview = loadTs('src/components/company/dashboardOverview.ts');

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();

let nextId = 1;
const shift = (status, startIso, endIso, extra = {}) => ({ id: nextId++, status, start: startIso, end: endIso, ...extra });
const classify = (s, now, bookedOn = true) => policy.classifyLiveOperation(s, { now: new Date(now), bookedOn });
/** A shift whose scheduled end was `minutesAgo` minutes before `now` (8-hour shift). */
const endedAgo = (status, now, minutesAgo) =>
  shift(status, iso(now - minutesAgo * MIN - 8 * HOUR), iso(now - minutesAgo * MIN));

const select = (rows, { now, date = '', zone = LONDON, bookedOn = () => true, zoneOf = () => zone }) =>
  board.selectLiveBoard(
    rows,
    (row) => ({ shift: row, bookedOn: bookedOn(row), timeZone: zoneOf(row) }),
    { now: new Date(now), date, referenceZone: zone },
  );
const reasons = (selection) => Object.fromEntries(selection.board.map(({ row, inclusion }) => [row.id, inclusion]));

/** 16 Oct 2026 22:11 UTC — 23:11 BST — when production showed Tuesday's shifts as live. */
const FRI = Date.parse('2026-10-16T22:11:00.000Z');

// ═══════════════════ 1. classification and its boundaries ═══════════════════

test('CLASS-01-THE-PRODUCTION-SHIFTS-ARE-NOT-LIVE-ON-FRIDAY', () => {
  // Shifts 26 and 27: 13 Oct 19:00 – 14 Oct 05:00 UTC, booked on, never booked off, status in_progress.
  const s26 = shift('in_progress', '2026-10-13T19:00:00.000Z', '2026-10-14T05:00:00.000Z');
  const decision = classify(s26, FRI);
  assert.equal(decision.include, false, 'off the live board');
  assert.equal(decision.reason, 'needs_reconciliation');
  const selection = select([s26], { now: FRI });
  assert.equal(selection.board.length, 0, 'not on the board, not in any live count');
  assert.deepEqual(selection.reconciliation.map((r) => r.id), [s26.id], 'listed for reconciliation');
  assert.equal(s26.status, 'in_progress', 'the stored status is untouched');
});

test('CLASS-02-LIVE-NOW-UNTIL-END-PLUS-15-MINUTES-INCLUSIVE', () => {
  assert.equal(policy.BOOK_OFF_GRACE_MINUTES, 15, 'the documented grace, matching the backend alert');
  const running = shift('in_progress', iso(FRI - HOUR), iso(FRI + 3 * HOUR));
  assert.equal(classify(running, FRI).reason, 'in_progress');
  assert.equal(classify(endedAgo('in_progress', FRI, 15), FRI).reason, 'in_progress', 'end + 15:00 is still live');
  assert.equal(classify(endedAgo('in_progress', FRI, 15.02), FRI).reason, 'overdue_book_off', 'one second later it is not');
  assert.equal(classify(endedAgo('in_progress', FRI, 16), FRI).reason, 'overdue_book_off');
});

test('CLASS-03-OVERDUE-UNTIL-24-HOURS-THEN-RECONCILIATION', () => {
  assert.equal(policy.RECONCILIATION_AFTER_END_MINUTES, 24 * 60);
  const at24h = classify(endedAgo('in_progress', FRI, 24 * 60), FRI);
  assert.deepEqual(at24h, { include: true, reason: 'overdue_book_off' }, 'exactly 24 h past the end: still overdue');
  const past24h = classify(endedAgo('in_progress', FRI, 24 * 60 + 1), FRI);
  assert.deepEqual(past24h, { include: false, reason: 'needs_reconciliation' }, 'one minute more: reconciliation');
});

test('CLASS-04-A-BOOK-ON-WITH-A-STALE-STATUS-FOLLOWS-THE-SAME-RULE', () => {
  // A Book On makes a `ready` shift worked, so it is placed by the same end-based rule.
  assert.equal(classify(endedAgo('ready', FRI, 10), FRI, true).reason, 'in_progress');
  assert.equal(classify(endedAgo('ready', FRI, 60), FRI, true).reason, 'overdue_book_off');
  assert.equal(classify(endedAgo('ready', FRI, 25 * 60), FRI, true).reason, 'needs_reconciliation');
  // Never booked on: unchanged — late, then out of relevance, and never "reconciliation".
  assert.equal(classify(endedAgo('ready', FRI, 60), FRI, false).reason, 'late_not_booked_on');
  assert.equal(classify(endedAgo('ready', FRI, 25 * 60), FRI, false).reason, 'outside_relevance');
});

test('CLASS-05-AN-EARLY-BOOK-ON-IS-LIVE', () => {
  const early = shift('in_progress', iso(FRI + 20 * MIN), iso(FRI + 8 * HOUR));
  assert.equal(classify(early, FRI).reason, 'in_progress', 'the Guard is on site');
});

test('CLASS-06-SETTLED-AND-COVERAGE-RULES-ARE-UNCHANGED', () => {
  assert.equal(classify(endedAgo('completed', FRI, 30), FRI).reason, 'closing_out');
  assert.equal(classify(endedAgo('completed', FRI, 3 * 60), FRI).reason, 'settled_historical');
  assert.equal(classify(endedAgo('missed', FRI, 60), FRI, false).reason, 'current_coverage_gap');
  assert.equal(classify(shift('ready', iso(FRI + HOUR), iso(FRI + 9 * HOUR)), FRI, false).reason, 'upcoming');
});

test('CLASS-07-THE-TIMELINE-BAR-AGREES-WITH-THE-POLICY-AT-EVERY-BOUNDARY', () => {
  const on = { checkInAt: 'x', checkOutAt: null };
  for (const minutesAgo of [-60, 0, 14, 15, 15.02, 16, 60, 24 * 60, 24 * 60 + 1, 72 * 60]) {
    const s = endedAgo('in_progress', FRI, minutesAgo);
    const reason = classify(s, FRI).reason;
    const bar = timeline.resolveTimelineStatus(s, on, FRI);
    // Phase 3 names the reconciliation case on the bar: Missing Book Off.
    const expected = { in_progress: 'Live', overdue_book_off: 'No Book Off', needs_reconciliation: 'Missing Book Off' }[reason];
    assert.equal(bar, expected, `ended ${minutesAgo} min ago`);
  }
  // A Book Off still reads Completed; one never made still reads Late before the start.
  assert.equal(timeline.resolveTimelineStatus(endedAgo('in_progress', FRI, 60), { checkInAt: 'x', checkOutAt: 'y' }, FRI), 'Completed');
});

test('CLASS-08-THE-DASHBOARD-LIVE-COUNT-USES-THE-SAME-RULE', () => {
  const live = { ...shift('in_progress', iso(FRI - HOUR), iso(FRI + HOUR)) };
  const overdue = { ...endedAgo('in_progress', FRI, 60) };
  const stale = { ...endedAgo('in_progress', FRI, 72 * 60) };
  const attendance = new Map([live, overdue, stale].map((s) => [s.id, { checkInAt: s.start, checkOutAt: null }]));
  const counted = overview.selectLiveShifts([live, overdue, stale], attendance, new Date(FRI));
  assert.deepEqual(counted.map((s) => s.id), [live.id], 'the Dashboard counts only the genuinely live shift');
});

// ═══════════════════ 2. cross-midnight and BST/GMT ═══════════════════

test('MIDNIGHT-01-AN-OVERNIGHT-SHIFT-IS-LIVE-THEN-OVERDUE-THEN-RECONCILIATION', () => {
  // 22:00–06:00 London (GMT, December): 22:00Z – 06:00Z.
  const night = shift('in_progress', '2026-12-01T22:00:00.000Z', '2026-12-02T06:00:00.000Z');
  assert.equal(classify(night, Date.parse('2026-12-02T00:30:00.000Z')).reason, 'in_progress', 'after midnight');
  assert.equal(classify(night, Date.parse('2026-12-02T06:15:00.000Z')).reason, 'in_progress', 'end + 15');
  assert.equal(classify(night, Date.parse('2026-12-02T06:16:00.000Z')).reason, 'overdue_book_off');
  assert.equal(classify(night, Date.parse('2026-12-03T06:01:00.000Z')).reason, 'needs_reconciliation');
});

test('MIDNIGHT-02-AN-OVERNIGHT-SHIFT-BELONGS-TO-THE-DAY-IT-STARTS-AS-IN-ROTA', () => {
  const night = shift('completed', '2026-12-01T22:00:00.000Z', '2026-12-02T06:00:00.000Z');
  const later = Date.parse('2026-12-10T12:00:00.000Z');
  assert.deepEqual(select([night], { now: later, date: '2026-12-01' }).board.map((r) => r.row.id), [night.id]);
  assert.deepEqual(select([night], { now: later, date: '2026-12-02' }).board, [], 'not duplicated onto the next day');
});

test('MIDNIGHT-03-YESTERDAYS-OVERNIGHT-SHIFT-STAYS-ON-TODAY-WHILE-IT-IS-WORKED', () => {
  const night = shift('in_progress', '2026-12-01T22:00:00.000Z', '2026-12-02T06:00:00.000Z');
  const now = Date.parse('2026-12-02T03:00:00.000Z');
  const today = select([night], { now, date: '2026-12-02' });
  assert.equal(today.mode, 'today');
  assert.deepEqual(reasons(today), { [night.id]: 'in_progress' }, 'on today\'s board because it is live now');
});

test('BST-01-A-0030-BST-START-IS-ON-THE-SITE-DAY-NOT-THE-UTC-DAY', () => {
  // 30 Sep 00:30 BST = 29 Sep 23:30Z.
  const s = shift('completed', '2026-09-29T23:30:00.000Z', '2026-09-30T07:30:00.000Z');
  const later = Date.parse('2026-10-05T12:00:00.000Z');
  assert.equal(select([s], { now: later, date: '2026-09-30' }).board.length, 1, 'the site day');
  assert.equal(select([s], { now: later, date: '2026-09-29' }).board.length, 0, 'not the UTC day');
});

test('BST-02-THE-CLOCKS-GO-BACK-NIGHT', () => {
  // 25 Oct 2026, 02:00 BST -> 01:00 GMT. A 00:00–08:00 local shift is 23:00Z (24th) – 08:00Z: nine hours.
  const s = shift('in_progress', '2026-10-24T23:00:00.000Z', '2026-10-25T08:00:00.000Z');
  assert.equal(classify(s, Date.parse('2026-10-25T01:30:00.000Z')).reason, 'in_progress', 'inside the repeated hour');
  assert.equal(classify(s, Date.parse('2026-10-25T08:15:00.000Z')).reason, 'in_progress', 'end + 15 by the clock');
  assert.equal(classify(s, Date.parse('2026-10-25T08:16:00.000Z')).reason, 'overdue_book_off');
  const later = Date.parse('2026-10-30T12:00:00.000Z');
  assert.equal(select([{ ...s, status: 'completed' }], { now: later, date: '2026-10-25' }).board.length, 1);
  assert.equal(select([{ ...s, status: 'completed' }], { now: later, date: '2026-10-24' }).board.length, 0);
});

test('BST-03-THE-CLOCKS-GO-FORWARD-NIGHT', () => {
  // 29 Mar 2026, 01:00 GMT -> 02:00 BST. 23:30Z on the 28th is still GMT (the 28th); 23:30Z on the 29th
  // is 00:30 BST on the 30th.
  const before = shift('completed', '2026-03-28T23:30:00.000Z', '2026-03-29T06:30:00.000Z');
  const after = shift('completed', '2026-03-29T23:30:00.000Z', '2026-03-30T07:30:00.000Z');
  const later = Date.parse('2026-04-05T12:00:00.000Z');
  assert.deepEqual(select([before, after], { now: later, date: '2026-03-28' }).board.map((r) => r.row.id), [before.id]);
  assert.deepEqual(select([before, after], { now: later, date: '2026-03-30' }).board.map((r) => r.row.id), [after.id]);
  assert.deepEqual(select([before, after], { now: later, date: '2026-03-29' }).board, []);
});

test('BST-04-TODAY-IS-THE-SITE-TODAY', () => {
  // 00:30 BST on 30 Sep is still 29 Sep in UTC and in New York.
  const now = Date.parse('2026-09-29T23:30:00.000Z');
  assert.equal(board.boardDateMode('2026-09-30', LONDON, new Date(now)), 'today');
  assert.equal(board.boardDateMode('2026-09-29', LONDON, new Date(now)), 'day');
  assert.equal(board.boardDateMode('2026-09-29', NEW_YORK, new Date(now)), 'today');
});

// ═══════════════════ 3. the selected date and Today ═══════════════════

const TUE = '2026-10-13';
const FRI_DATE = '2026-10-16';
const fleet = () => {
  const tuesdayStale = shift('in_progress', '2026-10-13T19:00:00.000Z', '2026-10-14T05:00:00.000Z');
  const tuesdayDone = shift('completed', '2026-10-13T08:00:00.000Z', '2026-10-13T16:00:00.000Z');
  const tuesdayMissed = shift('missed', '2026-10-13T09:00:00.000Z', '2026-10-13T17:00:00.000Z');
  const fridayLive = shift('in_progress', '2026-10-16T18:00:00.000Z', '2026-10-17T02:00:00.000Z');
  const fridayMorningDone = shift('completed', '2026-10-16T06:00:00.000Z', '2026-10-16T14:00:00.000Z');
  const saturdayLater = shift('ready', '2026-10-17T12:00:00.000Z', '2026-10-17T20:00:00.000Z');
  return { tuesdayStale, tuesdayDone, tuesdayMissed, fridayLive, fridayMorningDone, saturdayLater };
};
const bookedOnOf = (f) => (row) => row === f.tuesdayStale || row === f.fridayLive;

test('DATE-01-THE-DEFAULT-LIVE-VIEW-IS-UNCHANGED-APART-FROM-THE-STALE-SHIFT', () => {
  const f = fleet();
  const live = select(Object.values(f), { now: FRI, bookedOn: bookedOnOf(f) });
  assert.equal(live.mode, 'live');
  assert.deepEqual(reasons(live), { [f.fridayLive.id]: 'in_progress' });
  assert.deepEqual(live.reconciliation.map((r) => r.id), [f.tuesdayStale.id]);
});

test('DATE-02-A-PAST-DAY-SHOWS-THAT-DAYS-SCHEDULED-SHIFTS', () => {
  const f = fleet();
  const tue = select(Object.values(f), { now: FRI, date: TUE, bookedOn: bookedOnOf(f) });
  assert.equal(tue.mode, 'day');
  assert.deepEqual(reasons(tue), {
    [f.tuesdayStale.id]: 'needs_reconciliation',
    [f.tuesdayDone.id]: 'scheduled_on_day',
    [f.tuesdayMissed.id]: 'scheduled_on_day',
  }, 'Tuesday\'s actual schedule, not a filter of Friday\'s live set');
  assert.equal(tue.board.filter((r) => r.inclusion === 'in_progress').length, 0, 'nothing on Tuesday is live now');
  assert.deepEqual(tue.reconciliation.map((r) => r.id), [f.tuesdayStale.id], 'the queue ignores the date');
});

test('DATE-03-TODAY-IS-THE-LIVE-SET-PLUS-TODAYS-SCHEDULE', () => {
  const f = fleet();
  const today = select(Object.values(f), { now: FRI, date: FRI_DATE, bookedOn: bookedOnOf(f) });
  assert.equal(today.mode, 'today');
  assert.deepEqual(reasons(today), {
    [f.fridayLive.id]: 'in_progress',
    [f.fridayMorningDone.id]: 'scheduled_on_day',
  });
  assert.equal(today.board.filter((r) => r.inclusion === 'in_progress').length, 1, 'live count unchanged by Today');
});

test('DATE-04-A-FUTURE-DAY-SHOWS-ITS-SCHEDULE', () => {
  const f = fleet();
  const sat = select(Object.values(f), { now: FRI, date: '2026-10-17', bookedOn: bookedOnOf(f) });
  assert.deepEqual(reasons(sat), { [f.saturdayLater.id]: 'scheduled_on_day' }, 'a shift beyond the 4 h horizon is shown');
});

test('DATE-05-AN-UNUSABLE-DATE-FALLS-BACK-TO-THE-LIVE-VIEW', () => {
  const f = fleet();
  for (const date of ['', '2026-13-45', '2026-10', 'not a date']) {
    assert.equal(select(Object.values(f), { now: FRI, date, bookedOn: bookedOnOf(f) }).mode, 'live', JSON.stringify(date));
  }
});

test('DATE-06-RECONCILIATION-IS-OLDEST-FIRST-WITH-HOURS-OVERDUE', () => {
  const newer = endedAgo('in_progress', FRI, 30 * 60);
  const older = endedAgo('in_progress', FRI, 80 * 60);
  const sel = select([newer, older], { now: FRI });
  assert.deepEqual(sel.reconciliation.map((r) => r.id), [older.id, newer.id]);
  assert.equal(board.hoursPastEnd(older.end, FRI), 80);
  assert.equal(board.hoursPastEnd(iso(FRI + HOUR), FRI), 0, 'never negative');
});

test('DATE-07-EACH-SHIFT-IS-JUDGED-ON-ITS-OWN-SITE-DAY', () => {
  // 03:30Z on 17 Oct is 04:30 BST on the 17th in London but 23:30 on the 16th in New York.
  const london = shift('completed', '2026-10-17T03:30:00.000Z', '2026-10-17T05:00:00.000Z');
  const newYork = shift('completed', '2026-10-17T03:30:00.000Z', '2026-10-17T05:00:00.000Z');
  const zoneOf = (row) => (row === newYork ? NEW_YORK : LONDON);
  const later = Date.parse('2026-10-25T12:00:00.000Z');
  assert.deepEqual(select([london, newYork], { now: later, date: '2026-10-16', zoneOf }).board.map((r) => r.row.id), [newYork.id]);
  assert.deepEqual(select([london, newYork], { now: later, date: '2026-10-17', zoneOf }).board.map((r) => r.row.id), [london.id]);
});

// ═══════════════════ 4. tenant isolation and no writes ═══════════════════

test('SAFE-01-THE-BOARD-ONLY-EVER-RETURNS-WHAT-IT-WAS-GIVEN', () => {
  // The rows are the company's own GET /shifts result (scoped server-side). The selector can only
  // narrow that list: it has no request, no global and no second source to widen it with.
  const f = fleet();
  const input = Object.values(f);
  for (const date of ['', TUE, FRI_DATE, '2026-10-17']) {
    const sel = select(input, { now: FRI, date, bookedOn: bookedOnOf(f) });
    for (const { row } of sel.board) assert.ok(input.includes(row));
    for (const row of sel.reconciliation) assert.ok(input.includes(row));
  }
  const src = stripComments(codeOf('src/components/company/liveOperationsBoard.ts'));
  assert.ok(!/from '\.\.\/\.\.\/services\/api'|fetch\(|request\(/.test(src), 'the board module makes no request');
});

test('SAFE-02-SELECTING-A-DATE-OR-TODAY-WRITES-NOTHING', () => {
  const screen = codeOf('src/screens/CompanyDashboardScreen.tsx');
  const start = screen.indexOf('const handleLiveOperationsToday = React.useCallback');
  assert.ok(start > 0, 'the Today handler exists');
  const body = screen.slice(start, screen.indexOf('}, [liveOperationsZone]);', start));
  assert.ok(body.includes("date: siteToday(liveOperationsZone)"), 'Today selects the site\'s today');
  assert.ok(body.includes('setTimelineRecentreSignal('), 'Today re-centres the timeline');
  assert.ok(body.includes('loadData(true)'), 'Today refreshes the data (the same read the Refresh button does)');
  for (const write of ['updateShift', 'createShift', 'deleteShift', 'resolveAlert', 'acknowledge', 'closeAlert', 'checkOut']) {
    assert.ok(!body.includes(write), `Today performs no write (${write})`);
  }
});

test('SAFE-03-AUTO-MARK-MISSED-DOES-NOT-DEPEND-ON-THE-SELECTED-DATE', () => {
  // The one automatic write on this page marks a `ready` shift missed after 15 minutes without a Book On.
  // It reads the full `shifts` list, never the board, so choosing a date can neither widen nor narrow it.
  const screen = codeOf('src/screens/CompanyDashboardScreen.tsx');
  const start = screen.indexOf('const overdueReadyShifts = shifts.filter(');
  assert.ok(start > 0, 'the automation still reads `shifts`');
  const effect = screen.slice(screen.lastIndexOf('React.useEffect(() => {', start), screen.indexOf('}, [', start));
  for (const dateSource of ['liveFilters', 'liveBoardSelection', 'liveOperationRows', 'timelineAnchorMs']) {
    assert.ok(!effect.includes(dateSource), `auto-mark is independent of ${dateSource}`);
  }
});

test('SAFE-04-THE-RECONCILIATION-QUEUE-IS-READ-ONLY', () => {
  const ws = codeOf('src/components/company/CompanyLiveOperationsWorkspace.tsx');
  const start = ws.indexOf('function LiveOpsReconciliationQueue(');
  const body = ws.slice(start, ws.indexOf('// ─── DetailPanelContent', start));
  assert.ok(body.includes('onPress={() => onOpenShift(shift.id)}'), 'a row only opens the shift');
  for (const write of ['onUrgentAlertFollowUp', 'onOpenIncidentResolution', 'updateShift', "'close'", "'acknowledge'", 'checkOut']) {
    assert.ok(!body.includes(write), `no ${write}`);
  }
  // Its only callback is the selection setter.
  assert.ok(ws.includes('onOpenShift={setSelectedShiftId}'), 'wired to selection only');
});

// ═══════════════════ 5. wiring ═══════════════════

test('WIRE-01-TODAY-BUTTON-CALLS-THE-HANDLER-AND-THE-TIMELINE-RECENTRES', () => {
  const ws = codeOf('src/components/company/CompanyLiveOperationsWorkspace.tsx');
  assert.ok(ws.includes('onPress={onToday}'), 'the Today button runs the page handler');
  assert.ok(!ws.includes("setLiveFilters((f) => ({ ...f, date: '' }))"), 'it no longer just clears the date');
  assert.ok(ws.includes('recentreSignal={timelineRecentreSignal}'), 'and passes the re-centre signal');
  const tl = codeOf('src/components/company/CompanyOperationsTimeline.tsx');
  assert.ok(/if \(recentreSignal > 0\) recentreOnNow\(\);/.test(tl), 'the timeline re-centres on the signal');
  assert.ok(tl.includes('label="Now"') && tl.includes('onPress={recentreOnNow}'), 'exactly as its own Now button');
});

test('WIRE-02-THE-WEB-DATE-CONTROL-IS-A-REAL-DATE-INPUT', () => {
  const ws = codeOf('src/components/company/CompanyLiveOperationsWorkspace.tsx');
  assert.ok(ws.includes('<NativeDateInput'), 'Live Operations uses the shared date input');
  assert.ok(!ws.includes("{ type: 'date' }"), 'not a TextInput with a dropped type attribute');
  const input = codeOf('src/components/company/NativeDateInput.tsx');
  // Phase 3: a DD-MM-YYYY text field, with the browser's own picker behind a calendar button on web.
  assert.ok(/<PickerTag[\s\S]*?type="date"/.test(input), 'the web calendar is the browser\'s <input type="date">');
  assert.ok(input.includes('placeholder={UK_OPERATIONAL_DATE_PLACEHOLDER}'), 'and the field reads DD-MM-YYYY');
  const rota = codeOf('src/components/company/CompanyRotaPlannerWorkspace.tsx');
  assert.ok(rota.includes("from './NativeDateInput'") && !rota.includes('function NativeDateInput('),
    'the Rota Planner uses the same component: one date control, not two');
});

test('WIRE-03-COUNTS-READ-THE-SAME-REASONS-AS-THE-ROWS', () => {
  const screen = codeOf('src/screens/CompanyDashboardScreen.tsx');
  assert.ok(screen.includes("liveShifts: withReason('in_progress'),"), 'live shifts: live now only');
  assert.ok(screen.includes("overdueBookOff: withReason('overdue_book_off'),"), 'overdue counted separately');
  const ws = codeOf('src/components/company/CompanyLiveOperationsWorkspace.tsx');
  assert.ok(ws.includes("if (metricFocus === 'no-book-off') return liveOperationEnrichedRows.filter((r) => r.inclusion === 'overdue_book_off');"));
});

test('WIRE-04-PERSISTED-ALERTS-ARE-STILL-NEVER-EXPIRED', () => {
  for (const category of ['panic', 'incident', 'missed_check_call', 'missing_book_off', 'compliance_lapse', 'site_request']) {
    assert.ok(policy.PERSISTED_ATTENTION_CATEGORIES.includes(category), category);
    assert.equal(policy.isDerivedAttentionCurrent({ category, shiftId: 1 }, endedAgo('in_progress', FRI, 72 * 60), new Date(FRI)), true);
  }
});

console.log(`\n${passed} live operations board checks passed`);
