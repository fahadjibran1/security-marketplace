#!/usr/bin/env node
/**
 * Phase 4A.3 — the operations rail and the lower summaries.
 *
 * Next Up, Upcoming Handovers and Today So Far are pure functions of the board's own filtered rows, so
 * every rule below is executed rather than eyeballed: ordering, the five-item cap, the near-term horizon,
 * and — the one that matters most — that a replacement is never invented.
 */
const assert = require('node:assert/strict');
const { loadTs } = require('./load-ts.cjs');

const outlook = loadTs('src/components/company/operationsOutlook.ts');
const summary = loadTs('src/components/company/operationsSummary.ts');
const timeline = loadTs('src/components/company/operationsTimeline.ts');

const { buildNextUp, buildHandovers, NEXT_UP_MAX, HANDOVER_PAIRING_MINUTES } = outlook;
const { buildTodaySoFar } = summary;

const LONDON = 'Europe/London';
const MIN = 60_000;
const HOUR = 60 * MIN;
/** 20:50 Europe/London on Wednesday 30 September 2026 — the same instant the preview fixture uses. */
const NOW = Date.parse('2026-09-30T19:50:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

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

/** A row in the shape the board hands every one of these functions. */
const row = (o) => ({
  shift: {
    id: o.id,
    start: o.start,
    end: o.end,
    status: o.status ?? 'ready',
    site: { id: o.siteId ?? 1, name: o.siteName ?? 'TEST SITE', timezone: o.tz ?? LONDON },
    guard: o.guard === null ? null : { fullName: o.guard ?? 'A Guard' },
  },
  attendance: o.attendance ?? undefined,
  operations: o.windows ? { welfare: { intervalMinutes: o.interval ?? 15, windows: o.windows } } : null,
  logs: o.logs ?? [],
  incidents: o.incidents ?? [],
  alerts: o.alerts ?? [],
});

const win = (state, startMs, minutes, i = 0) => ({
  index: i,
  start: iso(startMs),
  end: iso(startMs + minutes * MIN),
  state,
  applicable: state !== 'not_applicable',
  completedAt: state === 'completed' ? iso(startMs + 2 * MIN) : null,
});

// ═══════════════════ Next Up ═══════════════════

test('NEXTUP-01-ORDERED-BY-INSTANT-NOT-BY-ROW-ORDER', () => {
  // The rail is read top to bottom as a sequence of moments. Input order is arbitrary; output is not.
  const events = buildNextUp([
    row({ id: 3, start: iso(NOW + 3 * HOUR), end: iso(NOW + 8 * HOUR), guard: 'Third' }),
    row({ id: 1, start: iso(NOW + 30 * MIN), end: iso(NOW + 9 * HOUR), guard: 'First' }),
    row({ id: 2, start: iso(NOW + 90 * MIN), end: iso(NOW + 9 * HOUR), guard: 'Second' }),
  ], NOW);

  assert.deepEqual(events.map((e) => e.guardName), ['First', 'Second', 'Third']);
  const times = events.map((e) => e.atMs);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'strictly chronological');
});

test('NEXTUP-02-NEVER-MORE-THAN-FIVE', () => {
  // A rail that lists everything is a second schedule table, which is the thing Next 60 Min failed at.
  const many = Array.from({ length: 12 }, (_, i) =>
    row({ id: 100 + i, start: iso(NOW + (i + 1) * 10 * MIN), end: iso(NOW + 9 * HOUR), guard: `G${i}` }));

  assert.equal(NEXT_UP_MAX, 5);
  assert.equal(buildNextUp(many, NOW).length, 5);
  assert.equal(buildNextUp(many, NOW, { limit: 3 }).length, 3, 'and the cap is configurable');
});

test('NEXTUP-03-NEAR-TERM-ONLY-AND-NEVER-THE-PAST', () => {
  const events = buildNextUp([
    row({ id: 1, start: iso(NOW - 2 * HOUR), end: iso(NOW - HOUR), status: 'completed', guard: 'Gone' }),
    row({ id: 2, start: iso(NOW + 20 * HOUR), end: iso(NOW + 28 * HOUR), guard: 'Tomorrow' }),
    row({ id: 3, start: iso(NOW + 45 * MIN), end: iso(NOW + 9 * HOUR), guard: 'Soon' }),
  ], NOW);

  assert.deepEqual([...new Set(events.map((e) => e.guardName))], ['Soon']);
  assert.ok(events.every((e) => e.atMs > NOW), 'nothing already past is something to prepare for');
});

test('NEXTUP-04-THE-FOUR-EVENT-KINDS-EACH-SAY-WHAT-THEY-ARE', () => {
  const assigned = row({
    id: 1, start: iso(NOW + 40 * MIN), end: iso(NOW + 9 * HOUR), guard: 'Tom Whelan',
  });
  const ending = row({
    id: 2, start: iso(NOW - HOUR), end: iso(NOW + 45 * MIN), status: 'in_progress', guard: 'Fahad test',
    attendance: { checkInAt: iso(NOW - 62 * MIN), checkOutAt: null },
    interval: 15,
    windows: [win('completed', NOW - HOUR, 15, 0), win('due', NOW + 20 * MIN, 15, 1)],
  });
  const unassigned = row({ id: 3, start: iso(NOW + 2 * HOUR), end: iso(NOW + 9 * HOUR), guard: null, status: 'unfilled' });

  const byKind = Object.fromEntries(
    buildNextUp([assigned, ending, unassigned], NOW, { limit: 20 }).map((e) => [e.kind, e]),
  );

  assert.equal(byKind.book_on_due.label, 'Tom Whelan — due to Book On');
  assert.equal(byKind.shift_end.label, 'Fahad test — shift ending');
  assert.equal(byKind.welfare_due.label, 'Fahad test — Welfare Check due');
  assert.equal(byKind.shift_start.label, 'Starts with no guard assigned');
  assert.equal(byKind.welfare_due.atMs, NOW + 35 * MIN, 'the deadline is the window END');
});

test('NEXTUP-05-A-GUARD-ALREADY-BOOKED-ON-IS-NOT-STILL-DUE-TO', () => {
  const bookedOn = row({
    id: 1, start: iso(NOW + 30 * MIN), end: iso(NOW + 9 * HOUR), status: 'in_progress', guard: 'Early Bird',
    attendance: { checkInAt: iso(NOW - 5 * MIN), checkOutAt: null },
  });
  assert.equal(
    buildNextUp([bookedOn], NOW).filter((e) => e.kind === 'book_on_due').length, 0,
  );
});

test('NEXTUP-06-OVERDUE-AND-MISSED-WELFARE-ARE-NOT-THINGS-TO-PREPARE-FOR', () => {
  // They are things to act on, and Attention Now already holds them. Listing a missed check as
  // "upcoming" would tell a controller to wait for something that has already gone wrong.
  const shift = row({
    id: 1, start: iso(NOW - HOUR), end: iso(NOW + 3 * HOUR), status: 'in_progress', guard: 'G',
    attendance: { checkInAt: iso(NOW - HOUR), checkOutAt: null },
    windows: [
      win('missed', NOW - 60 * MIN, 15, 0),
      win('overdue', NOW - 20 * MIN, 15, 1),
      win('due', NOW + 10 * MIN, 15, 2),
    ],
  });
  const welfare = buildNextUp([shift], NOW).filter((e) => e.kind === 'welfare_due');
  assert.equal(welfare.length, 1);
  assert.equal(welfare[0].atMs, NOW + 25 * MIN, 'the first window still winnable');
});

test('NEXTUP-07-SETTLED-SHIFTS-CONTRIBUTE-NOTHING', () => {
  const settled = ['completed', 'cancelled', 'missed', 'rejected'].map((status, i) =>
    row({ id: i + 1, start: iso(NOW + 30 * MIN), end: iso(NOW + 2 * HOUR), status, guard: `G${i}` }));
  assert.deepEqual(buildNextUp(settled, NOW), []);
});

test('NEXTUP-08-TIMES-ARE-ON-THE-SITE-CLOCK', () => {
  const newYork = row({
    id: 1, start: iso(NOW + 30 * MIN), end: iso(NOW + 9 * HOUR), guard: 'NY Guard',
    siteId: 2, siteName: 'MANHATTAN', tz: 'America/New_York',
  });
  const [event] = buildNextUp([newYork], NOW);
  assert.equal(event.timeZone, 'America/New_York');
  // 20:50 London + 30 min = 21:20 London = 16:20 New York.
  assert.equal(event.at, '16:20');
});

// ═══════════════════ Handovers ═══════════════════

test('HANDOVER-01-ONE-CANDIDATE-IS-A-REPLACEMENT', () => {
  const ending = row({
    id: 1, start: iso(NOW - HOUR), end: iso(NOW + 45 * MIN), status: 'in_progress', guard: 'Fahad test',
    attendance: { checkInAt: iso(NOW - 62 * MIN), checkOutAt: null },
  });
  const relief = row({ id: 2, start: iso(NOW + 10 * MIN), end: iso(NOW + 9 * HOUR), guard: 'Ahmed Khan' });

  const [handover] = buildHandovers([ending, relief], NOW);
  assert.equal(handover.replacement, 'assigned');
  assert.equal(handover.ending.guardName, 'Fahad test');
  assert.equal(handover.starting.guardName, 'Ahmed Khan');
  assert.match(handover.note, /^Replacement: Ahmed Khan \d\d:\d\d$/);
});

test('HANDOVER-02-NO-CANDIDATE-SAYS-SO-OUT-LOUD', () => {
  // The entire reason this panel exists: a site changing hands with nobody arranged.
  const ending = row({
    id: 1, start: iso(NOW - HOUR), end: iso(NOW + 30 * MIN), status: 'in_progress', guard: 'Marta',
    attendance: { checkInAt: iso(NOW - HOUR), checkOutAt: null },
  });
  const tooLate = row({ id: 2, start: iso(NOW + 30 * MIN + HOUR + MIN), end: iso(NOW + 9 * HOUR), guard: 'Much Later' });

  const handovers = buildHandovers([ending, tooLate], NOW);
  const forEnding = handovers.find((h) => h.ending?.shiftId === 1);
  assert.equal(forEnding.replacement, 'none');
  assert.equal(forEnding.note, 'No replacement assigned');
  assert.equal(forEnding.starting, null);
});

test('HANDOVER-03-TWO-CANDIDATES-ARE-NEVER-GUESSED-BETWEEN', () => {
  const ending = row({
    id: 1, start: iso(NOW - HOUR), end: iso(NOW + 40 * MIN), status: 'in_progress', guard: 'Outgoing',
    attendance: { checkInAt: iso(NOW - HOUR), checkOutAt: null },
  });
  const a = row({ id: 2, start: iso(NOW + 35 * MIN), end: iso(NOW + 9 * HOUR), guard: 'Candidate A' });
  const b = row({ id: 3, start: iso(NOW + 45 * MIN), end: iso(NOW + 9 * HOUR), guard: 'Candidate B' });

  const handovers = buildHandovers([ending, a, b], NOW);
  const forEnding = handovers.find((h) => h.ending?.shiftId === 1);

  assert.equal(forEnding.replacement, 'unresolved');
  assert.equal(forEnding.starting, null, 'neither candidate may be named as THE relief');
  assert.match(forEnding.note, /relief not identified/);

  // Both are still shown, in their own right, so nothing is hidden by the refusal to choose.
  const startIds = handovers.filter((h) => h.replacement === 'starting_only').map((h) => h.starting.shiftId);
  assert.deepEqual(startIds.sort(), [2, 3]);
});

test('HANDOVER-04-A-DIFFERENT-SITE-IS-NEVER-A-REPLACEMENT', () => {
  const ending = row({
    id: 1, siteId: 1, siteName: 'SITE ONE', start: iso(NOW - HOUR), end: iso(NOW + 30 * MIN),
    status: 'in_progress', guard: 'Outgoing', attendance: { checkInAt: iso(NOW - HOUR), checkOutAt: null },
  });
  const elsewhere = row({
    id: 2, siteId: 2, siteName: 'SITE TWO', start: iso(NOW + 32 * MIN), end: iso(NOW + 9 * HOUR), guard: 'Other Site',
  });

  const forEnding = buildHandovers([ending, elsewhere], NOW).find((h) => h.ending?.shiftId === 1);
  assert.equal(forEnding.replacement, 'none');
});

test('HANDOVER-05-THE-PAIRING-WINDOW-IS-AN-HOUR-EITHER-SIDE', () => {
  assert.equal(HANDOVER_PAIRING_MINUTES, 60);
  const endMs = NOW + 90 * MIN;
  const ending = row({
    id: 1, start: iso(NOW - HOUR), end: iso(endMs), status: 'in_progress', guard: 'Outgoing',
    attendance: { checkInAt: iso(NOW - HOUR), checkOutAt: null },
  });

  const inside = row({ id: 2, start: iso(endMs + 60 * MIN), end: iso(NOW + 12 * HOUR), guard: 'Just Inside' });
  const outside = row({ id: 3, start: iso(endMs + 61 * MIN), end: iso(NOW + 12 * HOUR), guard: 'Just Outside' });

  assert.equal(
    buildHandovers([ending, inside], NOW, { horizonMinutes: 600 }).find((h) => h.ending?.shiftId === 1).replacement,
    'assigned',
  );
  assert.equal(
    buildHandovers([ending, outside], NOW, { horizonMinutes: 600 }).find((h) => h.ending?.shiftId === 1).replacement,
    'none',
  );
});

test('HANDOVER-06-A-START-WITH-NO-ENDING-IS-STILL-A-TRANSITION', () => {
  const starting = row({ id: 1, start: iso(NOW + 70 * MIN), end: iso(NOW + 9 * HOUR), guard: 'Tom Whelan' });
  const unassigned = row({
    id: 2, siteId: 2, siteName: 'RIVERSIDE DEPOT', start: iso(NOW + 2 * HOUR), end: iso(NOW + 10 * HOUR),
    guard: null, status: 'unfilled',
  });

  const handovers = buildHandovers([starting, unassigned], NOW);
  assert.equal(handovers[0].note, 'Due to start');
  assert.equal(handovers[1].note, 'No guard assigned');
  assert.ok(handovers.every((h) => h.ending === null));
});

test('HANDOVER-07-CHRONOLOGICAL-AND-CAPPED', () => {
  const many = Array.from({ length: 9 }, (_, i) =>
    row({ id: 200 + i, siteId: 50 + i, siteName: `SITE ${i}`, start: iso(NOW + (i + 1) * 12 * MIN), end: iso(NOW + 9 * HOUR), guard: `G${i}` }));
  const handovers = buildHandovers(many, NOW);
  assert.equal(handovers.length, 5);
  const times = handovers.map((h) => h.atMs);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

// ═══════════════════ Today So Far ═══════════════════

const SUMMARY_FIXTURE = [
  row({
    id: 1, start: iso(NOW - 15 * MIN), end: iso(NOW + 3 * HOUR), status: 'in_progress', guard: 'Booked On',
    attendance: { checkInAt: iso(NOW - 17 * MIN), checkOutAt: null },
    windows: [win('completed', NOW - 15 * MIN, 15, 0), win('overdue', NOW - 30 * MIN, 15, 1), win('missed', NOW - 45 * MIN, 15, 2)],
    incidents: [{ status: 'open' }, { status: 'resolved' }],
    alerts: [{ type: 'site_request', status: 'open' }, { type: 'panic', status: 'closed' }],
  }),
  row({
    id: 2, start: iso(NOW - 40 * MIN), end: iso(NOW + 5 * HOUR), status: 'ready', guard: 'Late One',
  }),
  row({
    id: 3, start: iso(NOW - 6 * HOUR), end: iso(NOW - 30 * MIN), status: 'completed', guard: 'Finished',
    attendance: { checkInAt: iso(NOW - 6 * HOUR), checkOutAt: iso(NOW - 28 * MIN) },
    windows: [win('completed', NOW - 6 * HOUR, 60, 0)],
    alerts: [{ type: 'panic', status: 'open' }],
  }),
];

test('SUMMARY-01-ATTENDANCE-COUNTS-WHAT-HAPPENED', () => {
  const t = buildTodaySoFar(SUMMARY_FIXTURE, NOW);
  assert.equal(t.attendance.bookedOn, 2);
  assert.equal(t.attendance.bookedOff, 1);
  assert.equal(t.attendance.lateNotBookedOn, 1, 'started, nothing recorded, not settled');
  assert.equal(t.shiftCount, 3);
});

test('SUMMARY-02-WELFARE-COUNTS-ARE-THE-MARKERS-COUNTED', () => {
  // The same engine verdicts the bars draw. Nothing is recomputed, so the panel and the board cannot
  // disagree about how many windows were missed.
  const t = buildTodaySoFar(SUMMARY_FIXTURE, NOW);
  assert.equal(t.welfare.completed, 2);
  assert.equal(t.welfare.overdue, 1);
  assert.equal(t.welfare.missed, 1);

  const window = timeline.resolveTimelineWindow(NOW, 24, LONDON);
  const drawn = timeline.buildTimeline(SUMMARY_FIXTURE, window, NOW).flatMap((g) => g.rows).flatMap((r) => r.welfare);
  const tally = (state) => drawn.filter((m) => m.state === state).length;
  assert.equal(tally('completed'), t.welfare.completed);
  assert.equal(tally('overdue'), t.welfare.overdue);
  assert.equal(tally('missed'), t.welfare.missed);
});

test('SUMMARY-03-ONLY-UNRESOLVED-OPERATIONS-COUNT', () => {
  const t = buildTodaySoFar(SUMMARY_FIXTURE, NOW);
  assert.equal(t.operations.openIncidents, 1, 'resolved incidents are not open');
  assert.equal(t.operations.siteRequests, 1);
  assert.equal(t.operations.emergencyAlerts, 1, 'the closed panic does not count, the open one does');
});

test('SUMMARY-04-IT-COUNTS-THE-ROWS-IT-IS-GIVEN-AND-NOTHING-ELSE', () => {
  // This is rule §15 in executable form: hand it the filtered set and the summary describes exactly the
  // scope on screen. It cannot reach past its argument, because there is nothing else to reach for.
  const filtered = SUMMARY_FIXTURE.slice(0, 1);
  const t = buildTodaySoFar(filtered, NOW);
  assert.equal(t.shiftCount, 1);
  assert.equal(t.attendance.bookedOn, 1);
  assert.equal(t.welfare.missed, 1);
  assert.deepEqual(buildTodaySoFar([], NOW), {
    attendance: { bookedOn: 0, lateNotBookedOn: 0, bookedOff: 0 },
    welfare: { completed: 0, overdue: 0, missed: 0 },
    operations: { openIncidents: 0, siteRequests: 0, emergencyAlerts: 0 },
    shiftCount: 0,
  });
});

test('SUMMARY-05-ONE-PASS-OVER-THE-ROWS-NO-REQUEST-PER-METRIC', () => {
  // Nine numbers, one traversal. A counter on the array proves there is no hidden second sweep — and a
  // pure function cannot issue a request, which is the N+1 guarantee stated structurally.
  let reads = 0;
  const counted = new Proxy(SUMMARY_FIXTURE, {
    get(target, prop, receiver) {
      if (prop === Symbol.iterator) reads += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  buildTodaySoFar(counted, NOW);
  assert.equal(reads, 1, 'the row array is iterated exactly once');
  assert.equal(typeof buildTodaySoFar, 'function');
  assert.equal(buildTodaySoFar.length, 2, 'rows and an instant — no client, no fetch');
});

// ═══════════════════ one dataset, three surfaces ═══════════════════

test('SCOPE-01-RAIL-PANELS-AND-BOARD-READ-THE-SAME-ARRAY', () => {
  // Hand all four the identical filtered rows and no surface may describe a shift the board does not
  // draw. This is what stops "screen says 2 missed, summary says 4".
  const window = timeline.resolveTimelineWindow(NOW, 24, LONDON);
  const drawnIds = new Set(
    timeline.buildTimeline(SUMMARY_FIXTURE, window, NOW).flatMap((g) => g.rows).map((r) => r.shiftId),
  );

  for (const event of buildNextUp(SUMMARY_FIXTURE, NOW, { limit: 20 })) {
    assert.ok(drawnIds.has(event.shiftId), `Next Up ${event.id} is a row on the board`);
  }
  for (const h of buildHandovers(SUMMARY_FIXTURE, NOW, { limit: 20 })) {
    const id = h.ending?.shiftId ?? h.starting?.shiftId;
    assert.ok(drawnIds.has(id), `handover ${h.id} is a row on the board`);
  }
  assert.equal(buildTodaySoFar(SUMMARY_FIXTURE, NOW).shiftCount, SUMMARY_FIXTURE.length);
});

// ═══════════════════ the 24h viewport ═══════════════════

test('SCROLL-01-24H-OPENS-WITH-NOW-IN-SHOT', () => {
  // The defect: at 24h the axis is wider than any screen, and opening it scrolled to the left showed
  // lunchtime while the work was at 21:00 — an apparently empty board.
  const content = 24 * 132;   // 3168, the axis at its minimum hour width
  const viewport = 900;
  const window = timeline.resolveTimelineWindow(NOW, 24, LONDON);
  const nowFraction = timeline.axisFraction(NOW, window);

  const offset = timeline.nowScrollOffset(nowFraction, content, viewport);
  const nowX = nowFraction * content;

  assert.ok(offset > 0, 'the viewport does not open at the far left');
  assert.ok(nowX >= offset && nowX <= offset + viewport, 'NOW is inside the visible viewport');
  assert.ok(Math.abs((nowX - offset) - viewport / 3) < 1, 'and a third of the way across it');
});

test('SCROLL-02-IT-CANNOT-SCROLL-PAST-EITHER-END', () => {
  assert.equal(timeline.nowScrollOffset(0.01, 3000, 900), 0, 'clamped at the left');
  assert.equal(timeline.nowScrollOffset(0.99, 3000, 900), 2100, 'clamped at the right');
  assert.equal(timeline.nowScrollOffset(0.5, 800, 900), 0, 'nothing to scroll when it all fits');
  assert.equal(timeline.nowScrollOffset(null, 3000, 900), 0, 'panned away from now: leave it alone');
  assert.equal(timeline.nowScrollOffset(0.5, 3000, 0), 0, 'before the viewport has been measured');
});

test('SCROLL-03-IT-MOVES-THE-VIEWPORT-NOT-THE-WINDOW', () => {
  // Time state stays time state. The same window comes back whatever the scroll offset is, which is why
  // the NOW line and the markers cannot drift away from the clock.
  const before = timeline.resolveTimelineWindow(NOW, 24, LONDON);
  timeline.nowScrollOffset(0.33, 3168, 900);
  const after = timeline.resolveTimelineWindow(NOW, 24, LONDON);
  assert.deepEqual(after, before);
});

console.log(`\n${passed} operations outlook checks passed`);
