#!/usr/bin/env node
/**
 * Live Operations stays operationally current. (Phase 3B.)
 *
 * THE REPORTED DEFECT
 * Live Operations showed every shift the company had ever created. Monday's uncovered shift, Tuesday's
 * completed ones and a shift three weeks out all sat on the board beside the one shift actually being
 * worked, and "Re-cover required" stayed in Attention Now indefinitely because it is derived from the
 * uncovered list with no time bound and nothing to acknowledge. The board had no inclusion policy at all:
 * it was `shifts` passed through the user's own client/site/guard/date/status filters.
 *
 * WHAT THIS SUITE EXECUTES
 * The REAL policy module the screen calls — not a description of it. Every boundary is asserted on both
 * sides, and the final block reconstructs the production scenario from the UAT report and asserts the
 * exact set of shifts the board shows and the exact set it does not.
 *
 * The policy is instant-only by construction: no calendar day is involved in any inclusion decision, so
 * there is nothing here for a timezone to get wrong. INSTANT-01 proves that behaviourally rather than
 * taking the comment's word for it.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const policy = loadTs('src/components/company/liveOperationsPolicy.ts');
const {
  UPCOMING_HORIZON_MINUTES,
  POST_END_ATTENTION_MINUTES,
  SETTLED_CLOSE_OUT_MINUTES,
  DERIVED_ATTENTION_CATEGORIES,
  PERSISTED_ATTENTION_CATEGORIES,
  classifyLiveOperation,
  isCurrentOperation,
  selectCurrentOperations,
  isDerivedAttentionCategory,
  isDerivedAttentionCurrent,
  selectCurrentAttention,
  isActionableWelfareAlert,
} = policy;

/** A fixed "now" so every boundary below is exact rather than approximately right. */
const NOW = new Date('2026-09-30T14:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

let nextId = 1;
/** A shift whose start/end are expressed as offsets from NOW, in minutes. */
const shiftAt = (status, startMin, endMin) => ({
  id: nextId++,
  status,
  start: new Date(NOW.getTime() + startMin * MIN).toISOString(),
  end: new Date(NOW.getTime() + endMin * MIN).toISOString(),
});

const classify = (shift, bookedOn = false) => classifyLiveOperation(shift, { now: NOW, bookedOn });
const reasonOf = (shift, bookedOn = false) => classify(shift, bookedOn).reason;

// ─── Locked constants ─────────────────────────────────────────────────────────

test('CONST-01-LOCKED-POLICY-VALUES', () => {
  assert.equal(UPCOMING_HORIZON_MINUTES, 240, 'the upcoming horizon is locked at NOW to +4 hours');
  assert.equal(POST_END_ATTENTION_MINUTES, 1440, 'post-end attention is locked at a 24 hour maximum');
  assert.ok(
    SETTLED_CLOSE_OUT_MINUTES < POST_END_ATTENTION_MINUTES,
    'finished work must leave the board before an unresolved exception on it stops being current',
  );
});

// ─── A. In progress ───────────────────────────────────────────────────────────

test('POLICY-01-IN-PROGRESS-IS-ALWAYS-CURRENT', () => {
  assert.equal(reasonOf(shiftAt('in_progress', -60, 300)), 'in_progress');
  // Deliberately unbounded. A shift still marked in progress three days after its scheduled end is
  // itself the exception a control room has to see, so it must not age off the board.
  assert.equal(reasonOf(shiftAt('in_progress', -4400, -4100)), 'in_progress');
});

// ─── B. Upcoming, and the +4h boundary on both sides ──────────────────────────

test('POLICY-02-UPCOMING-INSIDE-THE-HORIZON', () => {
  assert.equal(reasonOf(shiftAt('ready', 120, 600)), 'upcoming');
  assert.equal(reasonOf(shiftAt('offered', 30, 500)), 'upcoming');
});

test('POLICY-03-PLUS-4H-BOUNDARY-IS-INCLUSIVE', () => {
  assert.equal(reasonOf(shiftAt('ready', 240, 720)), 'upcoming', 'exactly +4h is inside the horizon');
});

test('POLICY-04-ONE-MINUTE-BEYOND-4H-IS-EXCLUDED', () => {
  assert.equal(reasonOf(shiftAt('ready', 241, 720)), 'beyond_horizon');
  assert.equal(reasonOf(shiftAt('offered', 60 * 24 * 21, 60 * 24 * 21 + 480)), 'beyond_horizon');
});

// ─── C. Late / not booked on ──────────────────────────────────────────────────

test('POLICY-05-START-PASSED-WITH-NO-BOOK-ON-IS-LATE', () => {
  assert.equal(reasonOf(shiftAt('ready', -20, 460), false), 'late_not_booked_on');
});

test('POLICY-06-A-BOOK-ON-MAKES-IT-LIVE-WHATEVER-THE-STATUS-SAYS', () => {
  // Attendance evidence, not the status column. A shift with a Book On is being worked, and reading it
  // as "not booked on" would put a working guard in the exception queue.
  assert.equal(reasonOf(shiftAt('ready', -20, 460), true), 'in_progress');
});

test('POLICY-07-LATE-SHIFT-AGES-OUT-AFTER-THE-POST-END-WINDOW', () => {
  assert.equal(reasonOf(shiftAt('ready', -1600, -1441), false), 'outside_relevance');
});

test('POLICY-08-POST-END-BOUNDARY-IS-EXACT-ON-BOTH-SIDES', () => {
  // Ended exactly 24h ago: still current. One minute more: history.
  assert.equal(reasonOf(shiftAt('ready', -1900, -1440), false), 'late_not_booked_on');
  assert.equal(reasonOf(shiftAt('ready', -1900, -1441), false), 'outside_relevance');
  assert.equal(reasonOf(shiftAt('unfilled', -1900, -1440)), 'current_coverage_gap');
  assert.equal(reasonOf(shiftAt('unfilled', -1900, -1441)), 'outside_relevance');
});

// ─── D. Coverage gaps ─────────────────────────────────────────────────────────

test('POLICY-09-CURRENT-COVERAGE-GAP', () => {
  assert.equal(reasonOf(shiftAt('unfilled', -30, 420)), 'current_coverage_gap');
  assert.equal(reasonOf(shiftAt('rejected', 60, 540)), 'current_coverage_gap');
  assert.equal(reasonOf(shiftAt('missed', -90, 390)), 'current_coverage_gap');
});

test('POLICY-10-A-COVERAGE-GAP-WEEKS-AWAY-IS-PLANNING-NOT-OPERATIONS', () => {
  assert.equal(reasonOf(shiftAt('unfilled', 60 * 24 * 14, 60 * 24 * 14 + 480)), 'beyond_horizon');
  assert.equal(reasonOf(shiftAt('rejected', 300, 780)), 'beyond_horizon');
});

test('POLICY-11-HISTORICAL-UNFILLED-AND-MISSED-ARE-EXCLUDED', () => {
  // The Monday rows from the UAT report, two days on.
  assert.equal(reasonOf(shiftAt('unfilled', -2880, -2400)), 'outside_relevance');
  assert.equal(reasonOf(shiftAt('missed', -2880, -2400)), 'outside_relevance');
});

// ─── Settled work and the close-out tail ──────────────────────────────────────

test('POLICY-12-JUST-FINISHED-WORK-IS-STILL-CLOSING-OUT', () => {
  assert.equal(reasonOf(shiftAt('completed', -500, -30)), 'closing_out');
  assert.equal(reasonOf(shiftAt('completed', -600, -120)), 'closing_out', 'exactly the tail boundary');
});

test('POLICY-13-YESTERDAYS-COMPLETED-AND-CANCELLED-ARE-HISTORY', () => {
  assert.equal(reasonOf(shiftAt('completed', -600, -121)), 'settled_historical');
  assert.equal(reasonOf(shiftAt('completed', -1500, -1000)), 'settled_historical');
  assert.equal(reasonOf(shiftAt('cancelled', -1500, -1000)), 'settled_historical');
});

test('POLICY-14-A-CANCELLATION-NEXT-WEEK-IS-NOT-CLOSING-OUT', () => {
  // The close-out tail needs a lower bound as well as an upper one: a shift cancelled for next week has
  // no end behind it, and without the lower bound it would qualify by default.
  assert.equal(reasonOf(shiftAt('cancelled', 60 * 24 * 7, 60 * 24 * 7 + 480)), 'settled_historical');
  // Cancelled inside the horizon is worth seeing: the next shift at that site is not going ahead.
  assert.equal(reasonOf(shiftAt('cancelled', 60, 540)), 'closing_out');
});

// ─── Degenerate input ─────────────────────────────────────────────────────────

test('POLICY-15-UNUSABLE-SCHEDULE-IS-NOT-GUESSED-AT', () => {
  assert.equal(classify({ id: 1, status: 'ready', start: 'not a date', end: 'x' }).reason, 'unknown_schedule');
  assert.equal(classify({ id: 1, status: 'ready', start: '', end: '' }).include, false);
});

test('POLICY-16-AN-UNRECOGNISED-STATUS-STAYS-VISIBLE-WHILE-CURRENT', () => {
  // Erring towards showing operational work: hiding a shift whose status this policy does not know is
  // the dangerous direction for a control room. It still ages out like everything else.
  assert.equal(reasonOf(shiftAt('some_future_status', -30, 420)), 'current_coverage_gap');
  assert.equal(reasonOf(shiftAt('some_future_status', 600, 1080)), 'beyond_horizon');
  assert.equal(reasonOf(shiftAt('some_future_status', -2880, -2400)), 'outside_relevance');
});

// ─── Instants, not calendar days ──────────────────────────────────────────────

test('INSTANT-01-THE-SAME-INSTANT-CLASSIFIES-THE-SAME-HOWEVER-IT-IS-WRITTEN', () => {
  // 23:30Z is 00:30 the next day in BST. A policy that reasoned about the date digits would put these two
  // shifts on different days; a policy that reasons about instants cannot tell them apart, which is the
  // point. Both describe one instant 30 minutes from NOW.
  const asUtc = { id: 90, status: 'ready', start: '2026-09-30T14:30:00.000Z', end: '2026-09-30T22:30:00.000Z' };
  const asOffset = { id: 91, status: 'ready', start: '2026-09-30T15:30:00.000+01:00', end: '2026-09-30T23:30:00.000+01:00' };
  assert.deepEqual(classify(asUtc), classify(asOffset));
  assert.equal(reasonOf(asOffset), 'upcoming');

  // And a shift whose UTC date is "yesterday" while its site date is "today" is judged by the clock, not
  // by which side of midnight the digits fall on.
  const acrossUtcMidnight = { id: 92, status: 'in_progress', start: '2026-09-29T23:00:00.000Z', end: '2026-09-30T07:00:00.000Z' };
  assert.equal(reasonOf(acrossUtcMidnight), 'in_progress');
});

test('INSTANT-02-NO-STRING-SLICING-OR-DEVICE-CLOCK-IN-THE-POLICY', () => {
  const src = stripComments(codeOf('src/components/company/liveOperationsPolicy.ts'));
  for (const banned of ['slice(0, 10)', 'slice(0,10)', 'toISOString', 'getHours', 'getMonth', 'getDate', 'toLocale']) {
    assert.ok(!src.includes(banned), `inclusion policy must not use ${banned}`);
  }
  assert.ok(src.includes('Date.parse'), 'the policy compares parsed instants');
});

// ─── selectCurrentOperations ──────────────────────────────────────────────────

test('SELECT-01-RETURNS-ONLY-CURRENT-ROWS-WITH-THEIR-REASON-ATTACHED', () => {
  const live = shiftAt('in_progress', -120, 360);
  const soon = shiftAt('ready', 90, 570);
  const far = shiftAt('ready', 900, 1380);
  const old = shiftAt('completed', -2000, -1600);

  const rows = [live, soon, far, old].map((shift) => ({ shift, bookedOn: false }));
  const selected = selectCurrentOperations(rows, (row) => row, NOW);

  assert.deepEqual(
    selected.map((entry) => [entry.row.shift.id, entry.reason]),
    [[live.id, 'in_progress'], [soon.id, 'upcoming']],
  );
  // Order is preserved: the screen sorts by risk afterwards and must not be reordered underneath it.
  assert.equal(selected[0].row.shift.id, live.id);
});

test('SELECT-02-COUNTS-CANNOT-DISAGREE-WITH-THE-ROWS', () => {
  // The whole point of returning the reason: a count is a count OF the selected rows, derived from the
  // same array the board renders, so "Current Operations = 1" beside a card reading 5 is unreachable.
  const rows = [
    shiftAt('in_progress', -60, 420),
    shiftAt('in_progress', -30, 450),
    shiftAt('ready', -15, 465),
    shiftAt('ready', 120, 600),
    shiftAt('unfilled', -2880, -2400),
  ].map((shift) => ({ shift, bookedOn: false }));

  const selected = selectCurrentOperations(rows, (row) => row, NOW);
  const byReason = (reason) => selected.filter((entry) => entry.reason === reason).length;

  assert.equal(selected.length, 4, 'the historical unfilled row is gone');
  assert.equal(byReason('in_progress'), 2);
  assert.equal(byReason('late_not_booked_on'), 1);
  assert.equal(byReason('upcoming'), 1);
  assert.equal(byReason('in_progress') + byReason('late_not_booked_on') + byReason('upcoming'), selected.length);
});

// ─── Attention Now ────────────────────────────────────────────────────────────

test('ATTN-01-DERIVED-AND-PERSISTED-CATEGORIES-ARE-DISJOINT-AND-COMPLETE', () => {
  const overlap = DERIVED_ATTENTION_CATEGORIES.filter((c) => PERSISTED_ATTENTION_CATEGORIES.includes(c));
  assert.deepEqual(overlap, [], 'a category is either derived or persisted, never both');

  // Every category the workspace can render must be classified, or an item would silently fall into the
  // wrong half of the expiry rule.
  const workspace = codeOf('src/components/company/CompanyLiveOperationsWorkspace.tsx');
  const union = workspace.slice(workspace.indexOf('type UrgentCategory ='));
  const declared = union.slice(0, union.indexOf(';'))
    .match(/'[a-z_]+'/g)
    .map((quoted) => quoted.slice(1, -1));

  const known = [...DERIVED_ATTENTION_CATEGORIES, ...PERSISTED_ATTENTION_CATEGORIES];
  for (const category of declared) {
    assert.ok(known.includes(category), `UrgentCategory '${category}' is not classified by the policy`);
  }
  for (const category of known) {
    assert.ok(declared.includes(category), `policy classifies '${category}', which is not an UrgentCategory`);
  }
});

test('ATTN-02-MONDAYS-RE-COVER-IS-NOT-IN-WEDNESDAYS-QUEUE', () => {
  // The reported defect, exactly: a derived "Re-cover required" from a shift that ended two days ago.
  const monday = shiftAt('missed', -2880, -2400);
  const item = { id: 'missed-1', category: 'missed_shift', shiftId: monday.id };
  assert.equal(isDerivedAttentionCurrent(item, monday, NOW), false);

  const uncovered = { id: 'uncovered-1', category: 'uncovered_shift', shiftId: monday.id };
  assert.equal(isDerivedAttentionCurrent(uncovered, monday, NOW), false);
});

test('ATTN-03-A-CURRENT-COVERAGE-GAP-STAYS-IN-THE-QUEUE', () => {
  const live = shiftAt('unfilled', -60, 60);
  assert.equal(isDerivedAttentionCurrent({ category: 'uncovered_shift', shiftId: live.id }, live, NOW), true);

  // Boundary: 24h after the end it is still current, a minute later it is not.
  const atBoundary = shiftAt('unfilled', -1900, -1440);
  const pastBoundary = shiftAt('unfilled', -1900, -1441);
  assert.equal(isDerivedAttentionCurrent({ category: 'missed_shift' }, atBoundary, NOW), true);
  assert.equal(isDerivedAttentionCurrent({ category: 'missed_shift' }, pastBoundary, NOW), false);
});

test('ATTN-04-A-GAP-WEEKS-AWAY-IS-NOT-ATTENTION-NOW', () => {
  const future = shiftAt('unfilled', 60 * 24 * 10, 60 * 24 * 10 + 480);
  assert.equal(isDerivedAttentionCurrent({ category: 'uncovered_shift' }, future, NOW), false);
});

test('ATTN-05-PERSISTED-ALERTS-ARE-NEVER-EXPIRED-BY-THIS-POLICY', () => {
  // A panic alert on a shift that ended last week is still unresolved. Its open/acknowledged/closed
  // lifecycle is the only thing that clears it, and nothing here touches that.
  const ancient = shiftAt('completed', -20000, -19500);
  for (const category of PERSISTED_ATTENTION_CATEGORIES) {
    assert.equal(
      isDerivedAttentionCurrent({ category, shiftId: ancient.id }, ancient, NOW),
      true,
      `${category} must not be expired by schedule`,
    );
    assert.equal(isDerivedAttentionCategory(category), false);
  }
});

test('ATTN-06-AN-ITEM-THAT-CANNOT-BE-DATED-IS-KEPT', () => {
  // Only ever removes what it can positively date. A derived item with no shift behind it, or with an
  // unusable schedule, stays: dropping it would hide operational work on the strength of missing data.
  assert.equal(isDerivedAttentionCurrent({ category: 'uncovered_shift' }, null, NOW), true);
  assert.equal(isDerivedAttentionCurrent({ category: 'missed_shift' }, undefined, NOW), true);
  assert.equal(
    isDerivedAttentionCurrent({ category: 'missed_shift' }, { id: 1, status: 'missed', start: 'x', end: 'y' }, NOW),
    true,
  );
});

test('ATTN-07-SELECT-CURRENT-ATTENTION-FILTERS-ONLY-THE-STALE-DERIVED-ITEMS', () => {
  const monday = shiftAt('missed', -2880, -2400);
  const live = shiftAt('in_progress', -60, 420);

  const items = [
    { id: 'panic-1', category: 'panic', shiftId: live.id },
    { id: 'incident-1', category: 'incident', shiftId: monday.id },
    { id: 'missed-1', category: 'missed_shift', shiftId: monday.id },
    { id: 'uncovered-1', category: 'uncovered_shift', shiftId: monday.id },
    { id: 'late-1', category: 'late_start', shiftId: live.id },
    { id: 'checkcall-1', category: 'missed_check_call', shiftId: live.id },
  ];
  const byId = new Map([[monday.id, monday], [live.id, live]]);

  const current = selectCurrentAttention(items, (item) => byId.get(item.shiftId) ?? null, NOW);
  assert.deepEqual(
    current.map((item) => item.id),
    ['panic-1', 'incident-1', 'late-1', 'checkcall-1'],
    'the two stale derived items go; the incident on the same old shift stays because it is persisted',
  );
});

test('ATTN-08-ACKNOWLEDGED-IS-STILL-CURRENT', () => {
  // Acknowledging is not resolving. The lifecycle belongs to the alert, and this policy has no opinion
  // about it beyond refusing to expire it.
  const old = shiftAt('completed', -5000, -4500);
  const acknowledged = { id: 'panic-9', category: 'panic', shiftId: old.id, status: 'acknowledged' };
  assert.equal(isDerivedAttentionCurrent(acknowledged, old, NOW), true);
  assert.deepEqual(selectCurrentAttention([acknowledged], () => old, NOW), [acknowledged]);
});

test('ATTN-09-TWENTY-FOUR-MISSED-WINDOWS-ARE-ONE-THING-TO-ACT-ON', () => {
  // Per-window evidence rows carry the window index; the actionable shift-level summary has none. The
  // company alert list returns both, so the queue and the "Missed Check Calls" count were multiplying by
  // the number of missed windows.
  const evidence = Array.from({ length: 24 }, (_, index) => ({ id: index + 1, welfareWindowIndex: index }));
  const summary = { id: 99, welfareWindowIndex: null };
  const all = [...evidence, summary, { id: 100 }];

  assert.equal(all.filter(isActionableWelfareAlert).length, 2, 'the summary and a legacy rolling alert');
  assert.equal(isActionableWelfareAlert(summary), true);
  assert.equal(isActionableWelfareAlert(evidence[0]), false);
  assert.equal(isActionableWelfareAlert(evidence[23]), false);
});

// ─── The production scenario from the UAT report ──────────────────────────────

test('UAT-01-THE-REAL-BOARD-FOR-THE-REAL-DATA', () => {
  // Reconstructed from the reported state, as one set, judged at one instant.
  const mondayUnfilled   = { ...shiftAt('unfilled', -2880, -2400),  label: 'Monday unfilled' };
  const mondayMissed     = { ...shiftAt('missed', -2820, -2340),    label: 'Monday missed' };
  const tuesdayCompleted = { ...shiftAt('completed', -1440, -960),  label: 'Tuesday completed' };
  const tuesdayCancelled = { ...shiftAt('cancelled', -1380, -900),  label: 'Tuesday cancelled' };
  const activeNow        = { ...shiftAt('in_progress', -120, 360),  label: 'Wednesday active' };
  const upcomingSoon     = { ...shiftAt('ready', 150, 630),         label: 'Wednesday upcoming <=4h' };
  const beyondHorizon    = { ...shiftAt('ready', 600, 1080),        label: 'future >4h' };

  const all = [mondayUnfilled, mondayMissed, tuesdayCompleted, tuesdayCancelled, activeNow, upcomingSoon, beyondHorizon];
  const board = selectCurrentOperations(all.map((shift) => ({ shift, bookedOn: false })), (row) => row, NOW);

  assert.deepEqual(
    board.map((entry) => entry.row.shift.label),
    ['Wednesday active', 'Wednesday upcoming <=4h'],
    'the board shows the two current shifts and nothing else',
  );
  for (const excluded of [mondayUnfilled, mondayMissed, tuesdayCompleted, tuesdayCancelled, beyondHorizon]) {
    assert.equal(isCurrentOperation(excluded, { now: NOW, bookedOn: false }), false, excluded.label);
  }

  // Attention Now over the same instant: the old derived re-cover expires, the current alerts remain.
  const attention = [
    { id: 'uncovered-old', category: 'uncovered_shift', shiftId: mondayUnfilled.id },
    { id: 'missed-old', category: 'missed_shift', shiftId: mondayMissed.id },
    { id: 'welfare-now', category: 'missed_check_call', shiftId: activeNow.id },
    { id: 'incident-now', category: 'incident', shiftId: activeNow.id },
    { id: 'panic-now', category: 'panic', shiftId: activeNow.id },
  ];
  const byId = new Map(all.map((shift) => [shift.id, shift]));
  const queue = selectCurrentAttention(attention, (item) => byId.get(item.shiftId) ?? null, NOW);

  assert.deepEqual(
    queue.map((item) => item.id),
    ['welfare-now', 'incident-now', 'panic-now'],
    'the current unresolved alerts, with the stale derived re-cover items expired',
  );

  // And nothing was deleted: every shift is still in the source list, available to Rota and Coverage.
  assert.equal(all.length, 7);
});

test('UAT-02-AN-EMPTY-BOARD-IS-A-LEGITIMATE-ANSWER', () => {
  // Every shift historical. The board is empty, and the policy does not reach back for history to fill
  // it: "nothing is happening" is the correct control-room answer and must be representable.
  const historical = [
    shiftAt('completed', -2880, -2400),
    shiftAt('cancelled', -2820, -2340),
    shiftAt('missed', -2760, -2280),
    shiftAt('unfilled', -2700, -2220),
  ];
  const board = selectCurrentOperations(historical.map((shift) => ({ shift, bookedOn: false })), (row) => row, NOW);
  assert.deepEqual(board, []);
});

// ─── Production wiring ───────────────────────────────────────────────────────
//
// The policy above is executed. These check that production calls THAT policy and nothing else, which is
// all a source assertion can honestly establish: CompanyDashboardScreen imports react-native and cannot
// be executed here. Every rule worth testing was extracted into the module precisely so it would not have
// to be asserted as text.

const SCREEN = 'src/screens/CompanyDashboardScreen.tsx';
const WORKSPACE = 'src/components/company/CompanyLiveOperationsWorkspace.tsx';
const screenSrc = stripComments(codeOf(SCREEN));
const workspaceSrc = stripComments(codeOf(WORKSPACE));

/** The body of a named useMemo, so an assertion cannot accidentally match a different block. */
const memoBody = (src, declaration) => {
  const start = src.indexOf(declaration);
  assert.ok(start >= 0, `could not find ${declaration}`);
  const end = src.indexOf('\n  }, [', start);
  assert.ok(end > start, `could not find the end of ${declaration}`);
  return src.slice(start, end);
};

test('WIRE-01-THE-BOARD-IS-FILTERED-BY-THE-POLICY-THAT-WAS-TESTED', () => {
  assert.ok(
    screenSrc.includes("} from '../components/company/liveOperationsPolicy';"),
    'the screen imports the policy module',
  );
  const rows = memoBody(screenSrc, 'const liveOperationRows = React.useMemo');
  assert.ok(rows.includes('classifyLiveOperation('), 'inclusion is decided by the shared policy');
  assert.ok(rows.includes('if (!decision.include) return false;'), 'an excluded shift does not reach the board');
  assert.ok(rows.includes('now: operationalNow'), 'the policy is given the operational clock');
  assert.ok(
    rows.includes("bookedOn: Boolean(attendanceByShiftId.get(shift.id)?.checkInAt)"),
    'Book On comes from attendance evidence',
  );
  // No second copy of the rules in the screen: the horizon exists in one place only.
  for (const literal of ['4 * 60 * 60', '240', '14400000']) {
    assert.ok(!rows.includes(literal), `the screen must not restate the horizon (${literal})`);
  }
});

test('WIRE-02-ATTENTION-NOW-EXPIRES-DERIVED-ITEMS-THROUGH-THE-POLICY', () => {
  const queue = memoBody(screenSrc, 'const urgentOperationalItems = React.useMemo');
  assert.ok(queue.includes('selectCurrentAttention('), 'the queue is filtered by the shared policy');
  assert.ok(queue.includes('const now = operationalNow;'), 'the queue and the board share one clock');
  // Nothing in the screen may expire a persisted alert, so no category list is restated here.
  assert.ok(!queue.includes("=== 'panic' ?"), 'the screen must not re-classify categories');
});

test('WIRE-03-MISSED-WELFARE-IS-COUNTED-ONCE', () => {
  const alerts = memoBody(screenSrc, 'const missedCheckCalls = React.useMemo');
  assert.ok(alerts.includes('isActionableWelfareAlert(alert)'), 'per-window evidence rows are excluded');
});

test('WIRE-04-EXACTLY-ONE-POLLING-LOOP', () => {
  // The locked requirement: extend the existing cycle, never add a second one.
  const timers = screenSrc.match(/setInterval\(/g) || [];
  assert.equal(timers.length, 1, `expected one setInterval in the company screen, found ${timers.length}`);
  assert.ok(!screenSrc.includes('WebSocket'), 'no sockets in this phase');
  assert.ok(screenSrc.includes('clearInterval(intervalId)'), 'the one timer is cleaned up');
});

test('WIRE-05-THE-ONE-CYCLE-COVERS-THE-SURFACES-THAT-GO-STALE', () => {
  // UAT: a Guard accepted and started a shift while Company Rota still read Awaiting, because the poll
  // ran only on Live Operations. Each of these depends on offer acceptance, assignment or attendance.
  const table = screenSrc.slice(
    screenSrc.indexOf('const OPERATIONAL_REFRESH_TICKS'),
    screenSrc.indexOf('};', screenSrc.indexOf('const OPERATIONAL_REFRESH_TICKS')),
  );
  for (const section of ['live-operations', 'shift-offers', 'coverage', 'rota-planner', 'dashboard']) {
    assert.ok(table.includes(section), `${section} must be refreshed by the shared cycle`);
  }
  assert.equal(table.match(/'live-operations': 1/) !== null, true, 'the control room refreshes every tick');
  assert.ok(
    screenSrc.includes('const everyTicks = OPERATIONAL_REFRESH_TICKS[activeSection];'),
    'the single timer is gated by the table rather than by one hard-coded section',
  );
});

test('WIRE-06-THE-STATUS-BAR-COUNTS-THE-SETS-THE-WORKSPACE-RENDERS', () => {
  const counts = memoBody(screenSrc, 'const liveOperationsCounts = React.useMemo');
  assert.ok(counts.includes('liveOperationEnrichedRows.filter'), 'shift counts come from the board rows');
  assert.ok(counts.includes('urgentOperationalItems.filter'), 'alert counts come from the queue');
  // The company-wide lists are exactly what made a card disagree with the board.
  for (const wide of ['liveShifts.length', 'openIncidents.length', 'activePanicAlerts.length']) {
    assert.ok(!counts.includes(wide), `${wide} is company-wide and must not feed the Live Operations bar`);
  }
  for (const prop of [
    'liveShiftsCount={liveOperationsCounts.liveShifts}',
    'guardsNotBookedOnCount={liveOperationsCounts.guardsNotBookedOn}',
    'activePanicAlertsCount={liveOperationsCounts.activePanicAlerts}',
    'openIncidentsCount={liveOperationsCounts.openIncidents}',
    'missedCheckCallsCount={liveOperationsCounts.missedCheckCalls}',
  ]) {
    assert.ok(screenSrc.includes(prop), `the workspace must be given ${prop}`);
  }
});

test('WIRE-07-THE-METRIC-FILTERS-READ-THE-SAME-REASON-THE-COUNTS-DID', () => {
  assert.ok(
    workspaceSrc.includes("liveOperationEnrichedRows.filter((r) => r.inclusion === 'in_progress')"),
    'the live filter reads the inclusion reason',
  );
  assert.ok(
    workspaceSrc.includes("liveOperationEnrichedRows.filter((r) => r.inclusion === 'late_not_booked_on')"),
    'the not-booked-on filter reads the inclusion reason',
  );
  // The old mismatch: counted `ready`, filtered `in_progress` with no check-in.
  assert.ok(
    !workspaceSrc.includes("r.lifecycleStatus === 'in_progress' && !r.attendance?.checkInAt"),
    'the superseded lifecycle-and-attendance filter must be gone',
  );
});

test('WIRE-08-A-CONTROL-ROOM-EMPTY-STATE', () => {
  assert.ok(
    workspaceSrc.includes('No live or upcoming operations requiring attention.'),
    'an empty board says what it means',
  );
  assert.ok(
    workspaceSrc.includes('No current operations match these filters'),
    'a filtered empty board is distinguished from a genuinely quiet one',
  );
  assert.ok(
    workspaceSrc.includes('Rota Planner and Coverage'),
    'the empty state points at where the history is',
  );
  assert.ok(
    !workspaceSrc.includes('No shifts match these filters'),
    'the old wording described a shift list, not a control room',
  );
});

test('WIRE-09-HISTORY-IS-NEITHER-DELETED-NOR-UNREACHABLE', () => {
  // The policy filters a view. Nothing removes a shift from state, and the surfaces that own history
  // still read the full list.
  const rows = memoBody(screenSrc, 'const liveOperationRows = React.useMemo');
  assert.ok(rows.includes('return shifts'), 'the board filters `shifts`; it does not replace it');
  for (const mutation of ['setShifts(shifts.filter', 'splice(', 'delete ']) {
    assert.ok(!rows.includes(mutation), `the board must not mutate the shift list (${mutation})`);
  }
  const legacy = memoBody(screenSrc, 'const legacyShiftsByDate = React.useMemo');
  assert.ok(
    legacy.includes('shifts') && !legacy.includes('classifyLiveOperation'),
    'Rota Planner still sees every shift for the week it is showing',
  );
});

console.log(`\n${passed} checks passed`);
