#!/usr/bin/env node
/**
 * The Guard sees the backend's welfare verdict, not its own. (Phase 3D, closing TECH-DEBT-OPS-02.)
 *
 * WHAT WAS WRONG
 * `GET /shifts/my` returned bare shifts, so the app worked out Welfare timing itself: last evidence plus
 * the shift's interval, anchored on whatever log arrived last. The backend's engine uses a fixed
 * half-open window grid from the scheduled start, with a grace period, and an interval resolved when the
 * shift was written. Those are different answers to the same question, and the Guard — the one who has to
 * act — had the weaker one.
 *
 * WHAT THIS SUITE EXECUTES
 * The real presentation module, against projections shaped exactly as the backend sends them. The point
 * of every assertion below is that the module REPORTS and never DECIDES: give it `overdue` and it says
 * OVERDUE, whatever the device clock says.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const presentation = loadTs('src/components/guard/guardWelfarePresentation.ts');
const { guardWelfareCard, guardLogBookCard, guardWelfarePhase } = presentation;

const SCREEN = 'src/screens/GuardDashboardScreen.tsx';

/** A projection shaped as the backend sends it, for the 11:10–12:10 London shift at 15 minutes. */
const projection = (welfare = {}, logBook = {}) => ({
  timezone: 'Europe/London',
  welfare: {
    enabled: true,
    intervalMinutes: 15,
    status: 'due',
    currentWindow: { index: 0, start: '2026-09-30T10:10:00.000Z', end: '2026-09-30T10:25:00.000Z' },
    lastWelfareAt: null,
    nextDueAt: '2026-09-30T10:25:00.000Z',
    overdueByMinutes: null,
    requiredCount: 4,
    completedCount: 0,
    missedCount: 0,
    consecutiveMissed: 0,
    ...welfare,
  },
  logBook: {
    required: false,
    intervalMinutes: null,
    currentWindow: null,
    currentWindowSubmitted: false,
    lastEntryAt: null,
    ...logBook,
  },
});

// ─── The four statuses the instruction names ─────────────────────────────────

test('WELFARE-01-DUE-COMPLETED-OVERDUE-MISSED', () => {
  assert.equal(guardWelfareCard(projection({ status: 'due' })).label, 'DUE');
  // The engine calls a satisfied open window `current`; to the Guard that is COMPLETED.
  assert.equal(guardWelfareCard(projection({ status: 'current' })).label, 'COMPLETED');
  assert.equal(guardWelfareCard(projection({ status: 'overdue' })).label, 'OVERDUE');
  assert.equal(guardWelfareCard(projection({ status: 'missed' })).label, 'MISSED');
});

test('WELFARE-02-THE-ENGINES-EDGE-CASES-ARE-NOT-DRESSED-UP', () => {
  // Neither a lapse nor a completion. A shift with no obligation must not read as satisfied, and a
  // missing Book On is an attendance exception, not a welfare breach.
  assert.equal(guardWelfareCard(projection({ status: 'no_book_on' })).label, 'NOT BOOKED ON');
  assert.equal(guardWelfareCard(projection({ status: 'no_book_on' })).tone, 'warning');
  assert.equal(guardWelfareCard(projection({ status: 'shift_complete' })).label, 'SHIFT COMPLETE');
  assert.equal(guardWelfareCard(projection({ status: 'not_applicable' })).label, 'NOT REQUIRED');
});

test('WELFARE-03-TONES-ESCALATE-WITH-THE-ENGINES-STATUS', () => {
  assert.equal(guardWelfareCard(projection({ status: 'current' })).tone, 'good');
  assert.equal(guardWelfareCard(projection({ status: 'due' })).tone, 'neutral');
  assert.equal(guardWelfareCard(projection({ status: 'overdue' })).tone, 'warning');
  assert.equal(guardWelfareCard(projection({ status: 'missed' })).tone, 'danger');
});

// ─── Next due, on the site's clock ───────────────────────────────────────────

test('WELFARE-04-NEXT-DUE-IS-THE-SITES-WALL-CLOCK', () => {
  // 10:25Z is 11:25 in London during BST — the second boundary of the owner's 15-minute grid. Printing
  // the stored digits would have said 10:25 and sent the Guard out an hour early.
  const card = guardWelfareCard(projection());
  assert.equal(card.nextDue, '11:25');

  // Winter, when London is UTC: the same conversion must not add an hour unconditionally.
  const january = guardWelfareCard(projection({ nextDueAt: '2026-01-15T18:00:00.000Z' }));
  assert.equal(january.nextDue, '18:00');

  // A site in another zone reads its own clock.
  const newYork = guardWelfareCard({ ...projection(), timezone: 'America/New_York' });
  assert.equal(newYork.nextDue, '06:25');
});

test('WELFARE-05-NOTHING-OWED-MEANS-NO-NEXT-DUE', () => {
  assert.equal(guardWelfareCard(projection({ nextDueAt: null })).nextDue, null);
});

// ─── The supporting line and the lapse summary ───────────────────────────────

test('WELFARE-06-OVERDUE-SHOWS-HOW-LATE-IT-IS', () => {
  const card = guardWelfareCard(projection({ status: 'overdue', overdueByMinutes: 1 }));
  assert.equal(card.detail, '1 min over');
  assert.equal(card.actionUrgent, true, 'recording one is the priority');
});

test('WELFARE-07-COMPLETED-SHOWS-WHEN', () => {
  const card = guardWelfareCard(projection({
    status: 'current', lastWelfareAt: '2026-09-30T10:21:00.000Z', completedCount: 1,
  }));
  assert.equal(card.detail, 'Last 11:21', 'site clock again');
  assert.equal(card.actionUrgent, false);
});

test('WELFARE-08-THE-INTERVAL-IS-SHOWN-WHEN-THERE-IS-NOTHING-MORE-USEFUL', () => {
  assert.equal(guardWelfareCard(projection({ status: 'due' })).detail, 'Every 15 min');
});

test('WELFARE-09-A-STANDING-LAPSE-IS-WHAT-A-GUARD-ACTS-ON', () => {
  // Consecutive misses are the number to act on; the shift total is context.
  assert.equal(
    guardWelfareCard(projection({ status: 'missed', missedCount: 3, consecutiveMissed: 2 })).missedSummary,
    '2 missed in a row',
  );
  assert.equal(
    guardWelfareCard(projection({ status: 'due', missedCount: 1, consecutiveMissed: 0 })).missedSummary,
    '1 missed this shift',
  );
  assert.equal(guardWelfareCard(projection()).missedSummary, null, 'and silent when there is none');
});

test('WELFARE-10-ONLY-A-LAPSE-MAKES-THE-ACTION-URGENT', () => {
  for (const status of ['due', 'current', 'not_applicable', 'no_book_on', 'shift_complete']) {
    assert.equal(guardWelfareCard(projection({ status })).actionUrgent, false, status);
  }
  for (const status of ['overdue', 'missed']) {
    assert.equal(guardWelfareCard(projection({ status })).actionUrgent, true, status);
  }
});

// ─── Absent obligation, absent projection ────────────────────────────────────

test('WELFARE-11-NO-PROJECTION-AND-NO-OBLIGATION-BOTH-SHOW-NOTHING', () => {
  // Null means the shift is outside the operational window: nothing owed here. Showing "0 of 4
  // completed" would invent an obligation.
  assert.equal(guardWelfareCard(null), null);
  assert.equal(guardWelfareCard(undefined), null);
  assert.equal(guardWelfareCard(projection({ enabled: false })), null, 'no Welfare on this shift at all');
});

// ─── The phase, from the engine ──────────────────────────────────────────────

test('WELFARE-12-THE-SHIFT-PHASE-COMES-FROM-THE-ENGINES-STATUS', () => {
  assert.equal(guardWelfarePhase(projection({ status: 'due' })), 'welfare_due');
  assert.equal(guardWelfarePhase(projection({ status: 'overdue' })), 'welfare_overdue');
  assert.equal(guardWelfarePhase(projection({ status: 'missed' })), 'welfare_overdue', 'a lapse is urgent');
  // Nothing to say: the caller keeps whatever phase it had.
  assert.equal(guardWelfarePhase(projection({ status: 'current' })), null);
  assert.equal(guardWelfarePhase(projection({ status: 'shift_complete' })), null);
  assert.equal(guardWelfarePhase(projection({ enabled: false })), null);
  assert.equal(guardWelfarePhase(null), null);
});

// ─── Log Book, from the same projection ──────────────────────────────────────

test('LOGBOOK-01-AS-REQUIRED-MEANS-NOTHING-IS-EVER-MISSING', () => {
  const card = guardLogBookCard(projection());
  assert.equal(card.label, 'AS REQUIRED');
  assert.equal(card.tone, 'neutral');
  assert.equal(card.detail, null, 'no deadline to state');
});

test('LOGBOOK-02-THE-CURRENT-PERIOD-READS-DUE-OR-UP-TO-DATE', () => {
  const window = { index: 1, start: '2026-09-30T10:10:00.000Z', end: '2026-09-30T11:10:00.000Z' };

  const due = guardLogBookCard(projection({}, {
    required: true, intervalMinutes: 60, currentWindow: window, currentWindowSubmitted: false,
  }));
  assert.equal(due.label, 'ENTRY DUE');
  assert.equal(due.detail, 'By 12:10', 'the site clock, again');

  const done = guardLogBookCard(projection({}, {
    required: true, intervalMinutes: 60, currentWindow: window, currentWindowSubmitted: true,
    lastEntryAt: '2026-09-30T10:25:00.000Z',
  }));
  assert.equal(done.label, 'UP TO DATE');
  assert.equal(done.tone, 'good');
  assert.equal(done.detail, 'Last 11:25');
});

test('LOGBOOK-03-NO-PROJECTION-SHOWS-NOTHING', () => {
  assert.equal(guardLogBookCard(null), null);
  assert.equal(guardLogBookCard(undefined), null);
});

// ─── The client decides nothing ──────────────────────────────────────────────

test('SOURCE-01-THE-PRESENTATION-MODULE-NEVER-READS-A-CLOCK', () => {
  // The load-bearing property. If this module could read the time, it could disagree with the engine.
  const src = stripComments(codeOf('src/components/guard/guardWelfarePresentation.ts'));
  for (const banned of ['Date.now', 'new Date()', 'getTime()', 'setInterval', 'liveNow']) {
    assert.ok(!src.includes(banned), `presentation must not use ${banned}`);
  }
  // Nor may it do window arithmetic.
  for (const banned of ['intervalMinutes *', '* 60000', '* 60 * 1000', 'GRACE', 'Math.floor', 'Math.ceil']) {
    assert.ok(!src.includes(banned), `presentation must not compute windows (${banned})`);
  }
});

test('SOURCE-02-THE-ROLLING-ANCHOR-IS-GONE-FROM-THE-GUARD-SCREEN', () => {
  // The old engine: "last evidence + interval", which disagreed with the backend about the grid, the
  // grace period and the resolved interval.
  const screen = codeOf(SCREEN);
  assert.ok(!screen.includes('getNextWelfareDueMs'), 'the rolling anchor must be deleted');
  assert.ok(!screen.includes('WELFARE_DUE_SOON_MINUTES'), 'and its threshold with it');
  assert.ok(
    !screen.includes('lastWelfareEvidence'),
    'the client no longer needs its own evidence recogniser for timing',
  );

  // And the replacement is wired.
  assert.ok(screen.includes('guardWelfarePhase(shift.operations)'), 'the phase comes from the projection');
  assert.ok(screen.includes('guardWelfareCard(currentHomeShift?.operations)'), 'and so does the card');
  assert.ok(screen.includes('guardLogBookCard(currentHomeShift?.operations)'));
});

test('SOURCE-03-THE-SCREEN-DOES-NOT-RECOMPUTE-WHAT-IT-WAS-SENT', () => {
  const screen = codeOf(SCREEN);
  // The status line quotes the engine's own values rather than deriving them.
  assert.ok(
    screen.includes('shift.operations?.welfare.nextDueAt'),
    'the due time must be the engine value',
  );
  assert.ok(
    screen.includes('shift.operations?.welfare.overdueByMinutes'),
    'and so must how late it is',
  );
  // The welfare branch of the phase is now two lines: ask the engine, use the answer. It does no
  // arithmetic of its own. (The surrounding function still measures "shift ending soon" from the
  // scheduled end, which is attendance, not welfare, and is deliberately left alone.)
  const phaseBlock = screen.slice(
    screen.indexOf('function deriveGuardShiftPhase'),
    screen.indexOf('function getGuardPhaseStatusLine'),
  );
  assert.ok(phaseBlock.length > 0, 'the phase function must be findable');
  assert.ok(
    phaseBlock.includes('const welfarePhase = guardWelfarePhase(shift.operations);'),
    'the welfare phase must be asked for, not derived',
  );
  assert.ok(
    !phaseBlock.includes('checkCallIntervalMinutes'),
    'the phase must not read a shift interval any more',
  );
  // Deliberately NOT a proximity ban on millisecond arithmetic: the shift-ending-soon check sits on the
  // next line and legitimately measures from the scheduled end. SOURCE-01 bans clocks and arithmetic in
  // the presentation module, which is where a client-side welfare decision could actually hide.
});

test('SOURCE-04-A-SUCCESSFUL-SUBMISSION-REFRESHES-THE-PROJECTION', () => {
  // Phase 3D requires the current window to flip to COMPLETED without a restart. The dispatcher's
  // reload is the screen's own loadData, which re-fetches /shifts/my — and the shift spread preserves
  // `operations`, so the new status arrives with it.
  const screen = codeOf(SCREEN);
  assert.ok(screen.includes('reload: () => loadData(),'), 'the dispatcher reloads on success');
  assert.ok(screen.includes('listMyShifts()'), 'and loadData re-fetches the guard shift list');
  assert.ok(
    screen.includes('setShifts(shiftRows.map((shift) => ({ ...shift, status: normalizeShiftLifecycleStatus(shift.status) })))'),
    'the spread must preserve operations rather than rebuilding the shift',
  );
});

console.log(`\n${passed} guard welfare status checks passed`);
