#!/usr/bin/env node
/**
 * The control-room Operations Timeline. (Phase 4A.)
 *
 * WHAT IT REPLACES
 * A flat Current Operations table: one row per shift, read one shift at a time. It could not answer "who
 * is on at 21:00 across my sites", and it showed no Welfare history at all — only the current window's
 * status word. A controller had to open each shift card to reconstruct what had happened.
 *
 * WHAT THIS SUITE EXECUTES
 * The real layout module. Every rule the instruction locked is arithmetic here — axis ranges, bar
 * clipping, marker placement, the NOW line, site grouping, attendance labels — so it is proven rather
 * than eyeballed in a browser.
 *
 * The load-bearing constraint is negative: the timeline must NEVER compute a Welfare window. It positions
 * the grid the backend engine published and passes the engine's state through. TIMELINE-NOCALC asserts
 * that in the source, and the marker tests feed engine states in and require them out unchanged.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const t = loadTs('src/components/company/operationsTimeline.ts');
const {
  TIMELINE_RANGES, DEFAULT_TIMELINE_RANGE, NOW_OFFSET_FRACTION,
  resolveTimelineWindow, panTimelineWindow, timelineHourTicks, axisFraction,
  resolveTimelineSpan, resolveWelfareMarkers, welfareMarkerLabel,
  WELFARE_MARKER_GLYPH, WELFARE_MARKER_WORD,
  resolveAttendanceLabels, resolveTimelineStatus, buildTimeline, timelineRowCount, siteZoneOf,
} = t;

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';
const MIN = 60_000;
const HOUR = 60 * MIN;

/** The UAT evening: 30 September 2026, BST. 20:35 London = 19:35Z. */
const NOW = Date.parse('2026-09-30T19:50:00.000Z'); // 20:50 London

const iso = (ms) => new Date(ms).toISOString();

// ═══════════════════ the time axis ═══════════════════

test('AXIS-01-THE-FOUR-RANGES-AND-THE-DEFAULT', () => {
  assert.deepEqual([...TIMELINE_RANGES], [4, 8, 12, 24]);
  assert.equal(DEFAULT_TIMELINE_RANGE, 8, 'eight hours is the working view');

  for (const hours of TIMELINE_RANGES) {
    const w = resolveTimelineWindow(NOW, hours, LONDON);
    assert.equal((w.endMs - w.startMs) / HOUR, hours, `${hours}h axis spans ${hours} hours`);
    assert.equal(w.rangeHours, hours);
    // NOW must be inside every range, or the default view would open somewhere useless.
    assert.ok(w.startMs <= NOW && NOW < w.endMs, `now is inside the ${hours}h axis`);
  }
});

test('AXIS-02-NOW-SITS-A-THIRD-IN-SO-THE-FUTURE-GETS-MORE-ROOM', () => {
  // A control room needs more of what is coming than of what has gone — but not none of the past,
  // because the reason a Guard is late is always just behind.
  assert.equal(NOW_OFFSET_FRACTION, 1 / 3);
  const w = resolveTimelineWindow(NOW, 12, LONDON);
  const fraction = axisFraction(NOW, w);
  // Snapping to the hour moves it a little; it must stay in the first half.
  assert.ok(fraction > 0.2 && fraction < 0.45, `now sits early on the axis, got ${fraction}`);
});

test('AXIS-03-THE-AXIS-SNAPS-TO-THE-SITES-HOUR-NOT-THE-UTC-HOUR', () => {
  const w = resolveTimelineWindow(NOW, 8, LONDON);
  const label = timelineHourTicks(w, LONDON)[0].label;
  assert.match(label, /^\d{2}:00$/, `the first tick is a whole site hour, got ${label}`);

  // India is +05:30. A UTC floor would land its ticks on :30.
  const india = resolveTimelineWindow(NOW, 8, 'Asia/Kolkata');
  const indiaLabel = timelineHourTicks(india, 'Asia/Kolkata')[0].label;
  assert.match(indiaLabel, /^\d{2}:00$/, `a half-hour-offset zone still lands on :00, got ${indiaLabel}`);
});

test('AXIS-04-TICKS-ARE-ONE-PER-HOUR-EVENLY-SPACED-AND-ON-THE-SITE-CLOCK', () => {
  const w = resolveTimelineWindow(NOW, 8, LONDON);
  const ticks = timelineHourTicks(w, LONDON);
  assert.equal(ticks.length, 8, 'one tick per hour');
  assert.equal(ticks[0].fraction, 0);
  ticks.forEach((tick, i) => {
    assert.ok(Math.abs(tick.fraction - i / 8) < 1e-9, `tick ${i} is evenly spaced`);
  });
  // 24h must not try to squeeze 24 columns into the viewport — it still emits 24 ticks and the UI
  // scrolls horizontally.
  assert.equal(timelineHourTicks(resolveTimelineWindow(NOW, 24, LONDON), LONDON).length, 24);
});

test('AXIS-05-EARLIER-AND-LATER-PAN-BY-WHOLE-HOURS', () => {
  const w = resolveTimelineWindow(NOW, 8, LONDON);
  const later = panTimelineWindow(w, 4);
  const earlier = panTimelineWindow(w, -4);

  assert.equal(later.startMs - w.startMs, 4 * HOUR);
  assert.equal(w.startMs - earlier.startMs, 4 * HOUR);
  for (const panned of [later, earlier]) {
    assert.equal(panned.endMs - panned.startMs, 8 * HOUR, 'panning never changes the range');
    assert.equal(panned.rangeHours, 8);
  }
  // Panned far enough and NOW leaves the axis, which the marker must then refuse to draw.
  assert.equal(axisFraction(NOW, panTimelineWindow(w, 48)), null);
});

test('AXIS-06-AN-OFF-AXIS-INSTANT-IS-NULL-NOT-CLAMPED', () => {
  // A clamped NOW line pinned to an edge would claim now is somewhere it is not.
  const w = resolveTimelineWindow(NOW, 8, LONDON);
  assert.equal(axisFraction(w.startMs - 1, w), null);
  assert.equal(axisFraction(w.endMs + 1, w), null);
  assert.equal(axisFraction(Number.NaN, w), null);
  assert.equal(axisFraction(w.startMs, w), 0);
  assert.equal(axisFraction(w.endMs, w), 1);
});

// ═══════════════════ bars ═══════════════════

test('BAR-01-A-SHIFT-INSIDE-THE-AXIS-SPANS-START-TO-END', () => {
  const w = resolveTimelineWindow(NOW, 8, LONDON);
  const start = w.startMs + 2 * HOUR;
  const end = start + 3 * HOUR;
  const span = resolveTimelineSpan(start, end, w);

  assert.ok(Math.abs(span.startFraction - 2 / 8) < 1e-9);
  assert.ok(Math.abs(span.widthFraction - 3 / 8) < 1e-9);
  assert.equal(span.clippedStart, false);
  assert.equal(span.clippedEnd, false);
});

test('BAR-02-AN-OVERNIGHT-SHIFT-IS-CLIPPED-AT-BOTH-ENDS-NOT-MISREPRESENTED', () => {
  // 20:00–08:00 viewed around 02:00: the bar starts before the screen and ends after it. The flags let
  // the UI say so instead of pretending the shift begins when the axis does.
  const twoAm = Date.parse('2026-10-01T01:00:00.000Z'); // 02:00 London
  const w = resolveTimelineWindow(twoAm, 8, LONDON);
  const start = Date.parse('2026-09-30T19:00:00.000Z'); // 20:00 London
  const end = Date.parse('2026-10-01T07:00:00.000Z'); // 08:00 London

  const span = resolveTimelineSpan(start, end, w);
  assert.ok(span, 'the shift is visible');
  assert.equal(span.clippedStart, true, 'it began before the axis');
  assert.equal(span.clippedEnd, true, 'and continues past it');
  assert.equal(span.startFraction, 0);
  assert.equal(span.widthFraction, 1, 'it fills the whole visible axis');
});

test('BAR-03-A-SHIFT-OFF-THE-AXIS-IS-DROPPED', () => {
  const w = resolveTimelineWindow(NOW, 8, LONDON);
  assert.equal(resolveTimelineSpan(w.startMs - 5 * HOUR, w.startMs - HOUR, w), null, 'entirely before');
  assert.equal(resolveTimelineSpan(w.endMs + HOUR, w.endMs + 5 * HOUR, w), null, 'entirely after');
  // Touching the edge exactly is not an overlap: half-open, like the window engine.
  assert.equal(resolveTimelineSpan(w.startMs - HOUR, w.startMs, w), null);
  assert.equal(resolveTimelineSpan(w.endMs, w.endMs + HOUR, w), null);
  assert.equal(resolveTimelineSpan(Number.NaN, w.endMs, w), null, 'unusable schedule is not guessed at');
});

// ═══════════════════ welfare markers ═══════════════════

const windowsAt = (states, firstMs, intervalMin = 15) =>
  states.map((state, i) => ({
    index: i,
    start: iso(firstMs + i * intervalMin * MIN),
    end: iso(firstMs + (i + 1) * intervalMin * MIN),
    state,
    applicable: state !== 'not_applicable',
    completedAt: state === 'completed' ? iso(firstMs + i * intervalMin * MIN + 3 * MIN) : null,
    completionCount: state === 'completed' ? 1 : 0,
  }));

test('MARKER-01-THE-FIVE-CANONICAL-STATES-EACH-HAVE-A-GLYPH-AND-A-WORD', () => {
  assert.deepEqual(Object.keys(WELFARE_MARKER_GLYPH).sort(), [
    'completed', 'due', 'missed', 'not_applicable', 'overdue',
  ]);
  assert.equal(WELFARE_MARKER_GLYPH.completed, '✓');
  assert.equal(WELFARE_MARKER_GLYPH.due, '●');
  assert.equal(WELFARE_MARKER_GLYPH.overdue, '!');
  assert.equal(WELFARE_MARKER_GLYPH.missed, '✕');
  assert.equal(WELFARE_MARKER_GLYPH.not_applicable, '—');
  // Never colour alone: every state also has a word, and no two share a glyph.
  assert.equal(new Set(Object.values(WELFARE_MARKER_GLYPH)).size, 5, 'glyphs are distinguishable');
  assert.equal(new Set(Object.values(WELFARE_MARKER_WORD)).size, 5, 'and so is the wording');
});

test('MARKER-02-FOUR-MARKERS-PER-HOUR-AT-A-FIFTEEN-MINUTE-INTERVAL', () => {
  // The instruction's own example: 21:00 reads ✓ ✓ ! ✕
  const w = resolveTimelineWindow(NOW, 8, LONDON);
  const hourStart = w.startMs + 2 * HOUR;
  const windows = windowsAt(['completed', 'completed', 'overdue', 'missed'], hourStart);

  const markers = resolveWelfareMarkers(windows, w, { guardName: 'Fahad test', timeZone: LONDON });
  assert.equal(markers.length, 4, 'an hour holds four 15-minute windows');
  assert.deepEqual(markers.map((m) => m.glyph), ['✓', '✓', '!', '✕']);

  // Each sits a quarter-hour apart and is a quarter-hour wide, in order.
  markers.forEach((m, i) => {
    assert.equal(m.index, i);
    assert.ok(Math.abs(m.span.widthFraction - (15 * MIN) / (8 * HOUR)) < 1e-9, `marker ${i} width`);
    assert.ok(
      Math.abs(m.span.startFraction - (2 * HOUR + i * 15 * MIN) / (8 * HOUR)) < 1e-9,
      `marker ${i} position`,
    );
  });
});

test('MARKER-03-THE-ENGINES-STATE-IS-PASSED-THROUGH-NOT-RE-DECIDED', () => {
  const w = resolveTimelineWindow(NOW, 8, LONDON);
  const states = ['completed', 'due', 'overdue', 'missed', 'not_applicable'];
  const markers = resolveWelfareMarkers(windowsAt(states, w.startMs + HOUR), w, {
    guardName: 'G', timeZone: LONDON,
  });
  assert.deepEqual(markers.map((m) => m.state), states, 'state in === state out');
});

test('MARKER-04-AN-UNKNOWN-STATE-DEGRADES-TO-NOT-APPLICABLE-NOT-TO-COMPLETED', () => {
  // A future engine state must never read as a satisfied obligation.
  const w = resolveTimelineWindow(NOW, 8, LONDON);
  const markers = resolveWelfareMarkers(
    [{ index: 0, start: iso(w.startMs + HOUR), end: iso(w.startMs + HOUR + 15 * MIN), state: 'brand_new' }],
    w, { guardName: 'G', timeZone: LONDON },
  );
  assert.equal(markers[0].state, 'not_applicable');
  assert.notEqual(markers[0].state, 'completed');
});

test('MARKER-05-A-WINDOW-OFF-THE-AXIS-IS-DROPPED-NOT-CLAMPED', () => {
  // A clamped marker would appear at a time its window never covered.
  const w = resolveTimelineWindow(NOW, 8, LONDON);
  const windows = [
    ...windowsAt(['completed'], w.startMs - 2 * HOUR),
    ...windowsAt(['due'], w.startMs + HOUR),
    ...windowsAt(['due'], w.endMs + HOUR),
  ].map((win, i) => ({ ...win, index: i }));

  const markers = resolveWelfareMarkers(windows, w, { guardName: 'G', timeZone: LONDON });
  assert.equal(markers.length, 1, 'only the on-axis window is drawn');
  assert.equal(markers[0].index, 1);
});

test('MARKER-06-NO-OBLIGATION-DRAWS-NOTHING', () => {
  const w = resolveTimelineWindow(NOW, 8, LONDON);
  assert.deepEqual(resolveWelfareMarkers([], w, { guardName: 'G', timeZone: LONDON }), []);
  assert.deepEqual(resolveWelfareMarkers(undefined, w, { guardName: 'G', timeZone: LONDON }), []);
});

test('MARKER-07-EVERY-MARKER-CARRIES-AN-ACCESSIBLE-LABEL-WITH-GUARD-WINDOW-AND-STATE', () => {
  const w = resolveTimelineWindow(NOW, 8, LONDON);
  const hourStart = Date.parse('2026-09-30T19:45:00.000Z'); // 20:45 London
  const windows = windowsAt(['completed'], hourStart);
  const [marker] = resolveWelfareMarkers(windows, w, { guardName: 'Fahad test', timeZone: LONDON });

  assert.match(marker.accessibleLabel, /Fahad test/, 'names the guard');
  assert.match(marker.accessibleLabel, /20:45–21:00/, 'states the window on the site clock');
  assert.match(marker.accessibleLabel, /Completed/, 'and the state in words');
  assert.match(marker.accessibleLabel, /at 20:48/, 'and when it was completed');

  // An unmet window states no completion time.
  const [missed] = resolveWelfareMarkers(windowsAt(['missed'], hourStart), w, {
    guardName: 'Fahad test', timeZone: LONDON,
  });
  assert.match(missed.accessibleLabel, /Missed/);
  assert.ok(!/ at /.test(missed.accessibleLabel), 'and no completion time');
});

test('MARKER-08-LABELS-RENDER-ON-THE-SITES-CLOCK-NOT-UTC', () => {
  const w = resolveTimelineWindow(NOW, 24, LONDON);
  const at = Date.parse('2026-09-30T19:45:00.000Z');
  const windows = windowsAt(['due'], at);

  const london = resolveWelfareMarkers(windows, w, { guardName: 'G', timeZone: LONDON })[0];
  assert.match(london.accessibleLabel, /20:45–21:00/, 'BST is UTC+1');

  const ny = resolveWelfareMarkers(windows, resolveTimelineWindow(NOW, 24, NEW_YORK), {
    guardName: 'G', timeZone: NEW_YORK,
  })[0];
  assert.match(ny.accessibleLabel, /15:45–16:00/, 'the same instant on New York time');
});

// ═══════════════════ attendance ═══════════════════

test('ATTEND-01-BOOK-ON-AND-BOOK-OFF-ARE-READABLE-WITHOUT-OPENING-THE-SHIFT', () => {
  const shift = { start: '2026-09-30T19:35:00.000Z', status: 'in_progress' }; // 20:35 London
  const labels = resolveAttendanceLabels(
    shift, { checkInAt: '2026-09-30T19:33:00.000Z', checkOutAt: null }, NOW, LONDON,
  );
  assert.equal(labels.bookOn, 'ON 20:33', 'the actual Book On, on the site clock');
  assert.equal(labels.bookOff, 'OFF —', 'and an em dash for what has not happened');
  assert.equal(labels.late, false);
});

test('ATTEND-02-NO-BOOK-ON-AFTER-THE-SCHEDULED-START-IS-LATE', () => {
  const shift = { start: '2026-09-30T19:35:00.000Z', status: 'ready' };
  const late = resolveAttendanceLabels(shift, undefined, NOW, LONDON);
  assert.equal(late.bookOn, 'ON —');
  assert.equal(late.late, true, 'start passed with nothing recorded');

  // Before the start it is simply not due yet.
  const early = resolveAttendanceLabels(shift, undefined, Date.parse('2026-09-30T19:00:00.000Z'), LONDON);
  assert.equal(early.late, false);

  // And a settled shift is not "late" — it is over.
  const settled = resolveAttendanceLabels({ ...shift, status: 'cancelled' }, undefined, NOW, LONDON);
  assert.equal(settled.late, false);
});

test('ATTEND-03-A-BOOKED-OFF-SHIFT-SHOWS-BOTH-TIMES', () => {
  const labels = resolveAttendanceLabels(
    { start: '2026-09-30T19:35:00.000Z', status: 'completed' },
    { checkInAt: '2026-09-30T19:33:00.000Z', checkOutAt: '2026-10-01T04:35:00.000Z' },
    NOW, LONDON,
  );
  assert.equal(labels.bookOn, 'ON 20:33');
  assert.equal(labels.bookOff, 'OFF 05:35', 'across midnight, on the site clock');
});

// ═══════════════════ status ═══════════════════

test('STATUS-01-THE-FIVE-COMPACT-WORDS', () => {
  const start = '2026-09-30T19:35:00.000Z';
  const on = { checkInAt: '2026-09-30T19:33:00.000Z', checkOutAt: null };

  assert.equal(resolveTimelineStatus({ start, status: 'in_progress' }, on, NOW), 'Live');
  assert.equal(resolveTimelineStatus({ start, status: 'ready' }, on, NOW), 'Live', 'a Book On means live');
  assert.equal(resolveTimelineStatus({ start, status: 'ready' }, undefined, NOW), 'Late');
  assert.equal(
    resolveTimelineStatus({ start: '2026-09-30T21:00:00.000Z', status: 'ready' }, undefined, NOW),
    'Upcoming',
  );
  assert.equal(resolveTimelineStatus({ start, status: 'completed' }, on, NOW), 'Completed');
  assert.equal(
    resolveTimelineStatus({ start, status: 'in_progress' }, { checkInAt: 'x', checkOutAt: 'y' }, NOW),
    'Completed', 'a Book Off ends it',
  );
  for (const gap of ['unfilled', 'rejected', 'missed', 'cancelled']) {
    assert.equal(resolveTimelineStatus({ start, status: gap }, undefined, NOW), 'Coverage Gap', gap);
  }
});

// ═══════════════════ grouping ═══════════════════

const shiftInput = (over) => ({
  shift: {
    id: over.id,
    start: over.start,
    end: over.end,
    status: over.status ?? 'in_progress',
    site: { id: over.siteId, name: over.siteName, timezone: over.timeZone ?? LONDON },
    guard: { fullName: over.guardName },
  },
  attendance: over.attendance,
  operations: over.windows ? { welfare: { windows: over.windows } } : null,
});

test('GROUP-01-ROWS-GROUP-BY-SITE-WITH-SEVERAL-GUARDS-EACH', () => {
  const w = resolveTimelineWindow(NOW, 12, LONDON);
  const base = w.startMs + 2 * HOUR;

  const groups = buildTimeline([
    shiftInput({ id: 1, siteId: 7, siteName: 'TEST SITE', guardName: 'Fahad test', start: iso(base), end: iso(base + 9 * HOUR) }),
    shiftInput({ id: 2, siteId: 7, siteName: 'TEST SITE', guardName: 'Ahmed', start: iso(base + 25 * MIN), end: iso(base + 9 * HOUR) }),
    shiftInput({ id: 3, siteId: 9, siteName: 'MERCHANT FIELDS', guardName: 'Guard A', start: iso(base), end: iso(base + 8 * HOUR) }),
    shiftInput({ id: 4, siteId: 9, siteName: 'MERCHANT FIELDS', guardName: 'Guard B', start: iso(base), end: iso(base + 8 * HOUR) }),
  ], w, NOW);

  assert.equal(groups.length, 2, 'two site groups');
  assert.deepEqual(groups.map((g) => g.siteName), ['MERCHANT FIELDS', 'TEST SITE'], 'stable, name-ordered');
  assert.deepEqual(groups[1].rows.map((r) => r.guardName), ['Fahad test', 'Ahmed'], 'by scheduled start');
  assert.equal(groups[0].rows.length, 2, 'two guards at the other site');
  assert.equal(timelineRowCount(groups), 4, 'the count cannot disagree with the rows');
});

test('GROUP-02-OVERLAPPING-SHIFTS-ARE-SEPARATE-ROWS-NEVER-MERGED', () => {
  // Two guards on at once is the normal case for a staffed site; a controller must see both.
  const w = resolveTimelineWindow(NOW, 12, LONDON);
  const base = w.startMs + HOUR;
  const groups = buildTimeline([
    shiftInput({ id: 1, siteId: 7, siteName: 'TEST SITE', guardName: 'A', start: iso(base), end: iso(base + 4 * HOUR) }),
    shiftInput({ id: 2, siteId: 7, siteName: 'TEST SITE', guardName: 'B', start: iso(base + HOUR), end: iso(base + 5 * HOUR) }),
  ], w, NOW);

  assert.equal(groups[0].rows.length, 2, 'two rows, not one merged bar');
  const [a, b] = groups[0].rows;
  assert.ok(b.span.startFraction > a.span.startFraction, 'and they are positioned independently');
  assert.ok(a.span.startFraction + a.span.widthFraction > b.span.startFraction, 'genuinely overlapping');
});

test('GROUP-03-A-SITE-IN-ANOTHER-TIMEZONE-KEEPS-ITS-OWN-CLOCK', () => {
  const w = resolveTimelineWindow(NOW, 24, LONDON);
  const at = Date.parse('2026-09-30T19:35:00.000Z');
  const groups = buildTimeline([
    shiftInput({ id: 1, siteId: 7, siteName: 'LONDON SITE', guardName: 'A', start: iso(at), end: iso(at + 8 * HOUR) }),
    shiftInput({ id: 2, siteId: 8, siteName: 'NY SITE', guardName: 'B', start: iso(at), end: iso(at + 8 * HOUR), timeZone: NEW_YORK }),
  ], w, NOW);

  const london = groups.find((g) => g.siteName === 'LONDON SITE');
  const ny = groups.find((g) => g.siteName === 'NY SITE');
  assert.equal(london.timeZone, LONDON);
  assert.equal(ny.timeZone, NEW_YORK);
  assert.match(london.rows[0].scheduled, /^20:35–/, 'the same instant, two local clocks');
  assert.match(ny.rows[0].scheduled, /^15:35–/);
  // Position is instant-based, so both bars sit in the same place on the axis.
  assert.equal(london.rows[0].span.startFraction, ny.rows[0].span.startFraction);
});

test('GROUP-04-AN-OVERNIGHT-SHIFT-IS-FLAGGED-ON-THE-SITE-DAY', () => {
  const w = resolveTimelineWindow(Date.parse('2026-09-30T22:00:00.000Z'), 24, LONDON);
  const groups = buildTimeline([
    shiftInput({ id: 1, siteId: 7, siteName: 'S', guardName: 'A',
      start: '2026-09-30T19:35:00.000Z', end: '2026-10-01T04:35:00.000Z' }),
  ], w, NOW);
  assert.equal(groups[0].rows[0].overnight, true, '20:35 to 05:35 crosses the site midnight');
  assert.equal(groups[0].rows[0].scheduled, '20:35–05:35');

  const sameDay = buildTimeline([
    shiftInput({ id: 2, siteId: 7, siteName: 'S', guardName: 'B',
      start: '2026-09-30T07:00:00.000Z', end: '2026-09-30T15:00:00.000Z' }),
  ], w, NOW);
  assert.equal(sameDay[0].rows[0].overnight, false);
});

test('GROUP-05-HISTORICAL-SHIFTS-OFF-THE-AXIS-ARE-EXCLUDED-WITH-THEIR-SITE', () => {
  const w = resolveTimelineWindow(NOW, 8, LONDON);
  const groups = buildTimeline([
    shiftInput({ id: 1, siteId: 7, siteName: 'TODAY', guardName: 'A',
      start: iso(w.startMs + HOUR), end: iso(w.startMs + 5 * HOUR) }),
    shiftInput({ id: 2, siteId: 8, siteName: 'LAST MONDAY', guardName: 'B', status: 'completed',
      start: iso(w.startMs - 72 * HOUR), end: iso(w.startMs - 64 * HOUR) }),
  ], w, NOW);

  assert.equal(groups.length, 1, 'the site whose only shift is off-axis is dropped too');
  assert.equal(groups[0].siteName, 'TODAY');
  assert.equal(timelineRowCount(groups), 1);
});

test('GROUP-06-SHIFTS-WITH-NO-SITE-ID-STILL-GROUP-BY-NAME', () => {
  const w = resolveTimelineWindow(NOW, 12, LONDON);
  const base = w.startMs + HOUR;
  const groups = buildTimeline([
    { shift: { id: 1, start: iso(base), end: iso(base + 4 * HOUR), status: 'in_progress', siteName: 'ORPHAN', guard: { fullName: 'A' } } },
    { shift: { id: 2, start: iso(base), end: iso(base + 4 * HOUR), status: 'in_progress', siteName: 'ORPHAN', guard: { fullName: 'B' } } },
  ], w, NOW);
  assert.equal(groups.length, 1, 'one group, matched by name');
  assert.equal(groups[0].rows.length, 2);
  assert.equal(groups[0].siteId, null);
});

test('GROUP-07-AN-UNASSIGNED-SHIFT-IS-A-ROW-A-CONTROLLER-CAN-SEE', () => {
  const w = resolveTimelineWindow(NOW, 8, LONDON);
  const groups = buildTimeline([
    { shift: { id: 1, start: iso(w.startMs + HOUR), end: iso(w.startMs + 5 * HOUR), status: 'unfilled', site: { id: 7, name: 'S', timezone: LONDON } } },
  ], w, NOW);
  assert.equal(groups[0].rows[0].guardName, 'Unassigned');
  assert.equal(groups[0].rows[0].status, 'Coverage Gap');
});

test('ZONE-01-A-SITE-WITHOUT-A-ZONE-FALLS-BACK-RATHER-THAN-USING-THE-DEVICE', () => {
  assert.equal(siteZoneOf({ shift: { site: { timezone: NEW_YORK } } }), NEW_YORK);
  assert.equal(siteZoneOf({ shift: { site: { timezone: null } } }), LONDON);
  assert.equal(siteZoneOf({ shift: {} }), LONDON);
});

// ═══════════════════ the proven UAT scenario ═══════════════════

test('UAT19-THE-SHIFT-19-EVENING-IS-READABLE-AT-A-GLANCE', () => {
  // test site, Fahad test, scheduled 20:35–21:35 London, Book On 20:33, 15-minute Welfare,
  // Welfare recorded 20:48, a later window overdue, a later one missed.
  const start = Date.parse('2026-09-30T19:35:00.000Z'); // 20:35 London
  const w = resolveTimelineWindow(NOW, 4, LONDON);

  const windows = [
    { index: 0, start: iso(start), end: iso(start + 15 * MIN), state: 'completed',
      applicable: true, completedAt: '2026-09-30T19:48:00.000Z', completionCount: 1 },
    { index: 1, start: iso(start + 15 * MIN), end: iso(start + 30 * MIN), state: 'overdue',
      applicable: true, completedAt: null, completionCount: 0 },
    { index: 2, start: iso(start + 30 * MIN), end: iso(start + 45 * MIN), state: 'missed',
      applicable: true, completedAt: null, completionCount: 0 },
    { index: 3, start: iso(start + 45 * MIN), end: iso(start + 60 * MIN), state: 'due',
      applicable: true, completedAt: null, completionCount: 0 },
  ];

  const groups = buildTimeline([
    shiftInput({
      id: 19, siteId: 7, siteName: 'test site', guardName: 'Fahad test',
      start: iso(start), end: iso(start + HOUR), status: 'in_progress',
      attendance: { checkInAt: '2026-09-30T19:33:00.000Z', checkOutAt: null },
      windows,
    }),
  ], w, NOW);

  assert.equal(groups.length, 1);
  const row = groups[0].rows[0];

  // Everything the controller previously had to open cards to assemble, on one row:
  assert.equal(groups[0].siteName, 'test site');
  assert.equal(row.guardName, 'Fahad test');
  assert.equal(row.scheduled, '20:35–21:35');
  assert.equal(row.attendance.bookOn, 'ON 20:33');
  assert.equal(row.attendance.bookOff, 'OFF —');
  assert.equal(row.status, 'Live');
  assert.equal(row.overnight, false);

  // And the Welfare history as a readable strip: ✓ ! ✕ ●
  assert.deepEqual(row.welfare.map((m) => m.glyph), ['✓', '!', '✕', '●']);
  assert.match(row.welfare[0].accessibleLabel, /Completed at 20:48/);
  assert.match(row.welfare[2].accessibleLabel, /Fahad test, Welfare Check 21:05–21:20, Missed/);

  // Markers advance left to right, each a quarter of an hour on a 4-hour axis.
  row.welfare.forEach((m, i) => {
    assert.equal(m.index, i);
    assert.ok(Math.abs(m.span.widthFraction - (15 * MIN) / (4 * HOUR)) < 1e-9);
    if (i > 0) assert.ok(m.span.startFraction > row.welfare[i - 1].span.startFraction);
  });

  // NOW is on the axis, so the controller can see what has happened versus what is coming.
  assert.ok(axisFraction(NOW, w) !== null, 'the now line is drawable');
});

// ═══════════════════ the negative constraint ═══════════════════

test('TIMELINE-NOCALC-THE-TIMELINE-NEVER-COMPUTES-A-WELFARE-WINDOW', () => {
  // The load-bearing rule. The engine owns the grid; this module positions it. A second grid on the
  // client is exactly how a controller and a Guard start disagreeing.
  const src = stripComments(codeOf('src/components/company/operationsTimeline.ts'));

  for (const banned of ['intervalMinutes *', 'GRACE', 'grace', 'requiredCount', 'WELFARE_DEFAULT']) {
    assert.ok(!src.includes(banned), `the timeline must not reason about ${banned}`);
  }
  // It must not invent window boundaries from an interval.
  assert.ok(!/windows\s*\.\s*push\(/.test(src), 'it never builds a window list');
  assert.ok(!/for\s*\(.*interval/i.test(src), 'and never iterates an interval to make one');

  // Nor read a clock of its own: `now` is always passed in.
  for (const banned of ['Date.now', 'new Date()']) {
    assert.ok(!src.includes(banned), `the timeline must not read a clock (${banned})`);
  }
  // Nor slice dates or use the device zone.
  for (const banned of ['slice(0, 10)', 'slice(0,10)', 'toLocale', 'getHours', 'getTimezoneOffset']) {
    assert.ok(!src.includes(banned), `no ${banned}`);
  }
  assert.ok(src.includes('formatInstantTime'), 'labels go through the shared site-time module');
});

console.log(`\n${passed} operations timeline checks passed`);
