#!/usr/bin/env node
/**
 * Early Book Off on the board (S4 Welfare Phase 4).
 *
 * Pilot shift 33: 21:00-07:00 BST, booked off at 02:09. The board called it "Completed" and the drawer
 * "Closed cleanly". This suite executes the real modules — the 15-minute rule, the timeline status and Book
 * Off label, the Today So Far count and the coverage wording — and checks the drawer source no longer says
 * "Closed cleanly" for an early Book Off.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ebo = loadTs('src/components/company/earlyBookOff.ts');
const tl = loadTs('src/components/company/operationsTimeline.ts');
const sum = loadTs('src/components/company/operationsSummary.ts');

const LONDON = 'Europe/London';
const END = '2026-10-18T06:00:00.000Z'; // 07:00 BST
const at = (minutesBefore) => new Date(Date.parse(END) - minutesBefore * 60_000).toISOString();
const NOW = Date.parse('2026-10-18T11:00:00.000Z');
const S33 = { start: '2026-10-17T20:00:00.000Z', end: END, status: 'completed' };

test('EBOW-01-THE-THRESHOLD-MATCHES-THE-BACKEND', () => {
  assert.equal(ebo.EARLY_BOOK_OFF_MINUTES, 15);
  assert.equal(ebo.earlyBookOffMinutes(END, at(15)), null, 'exactly 15 minutes is not early');
  assert.equal(ebo.earlyBookOffMinutes(END, at(14)), null, '14 minutes is not early');
  assert.equal(ebo.earlyBookOffMinutes(END, at(16)), 16, '16 minutes is');
  assert.equal(ebo.earlyBookOffMinutes(END, '2026-10-18T01:09:36.000Z'), 290, 'pilot shift 33');
  assert.equal(ebo.earlyBookOffMinutes(END, null), null);
  assert.equal(ebo.formatDuration(290), '4h 50m');
  assert.equal(ebo.formatDuration(45), '45m');
  assert.equal(ebo.formatDuration(120), '2h');
});

test('EBOW-02-THE-TIMELINE-SAYS-BOOKED-OFF-EARLY-AND-SHOWS-THE-RECORDED-TIME', () => {
  const att = { checkInAt: '2026-10-17T18:29:00.000Z', checkOutAt: '2026-10-18T01:09:36.000Z' };
  assert.equal(tl.resolveTimelineStatus(S33, att, NOW), 'Booked Off Early');
  const labels = tl.resolveAttendanceLabels(S33, att, NOW, LONDON);
  assert.equal(labels.bookOff, 'OFF 02:09 · 4h 50m early', 'the recorded Book Off on the site clock, overnight');
  // On time, or within 15 minutes, it is simply Completed.
  const onTime = { checkInAt: att.checkInAt, checkOutAt: at(10) };
  assert.equal(tl.resolveTimelineStatus(S33, onTime, NOW), 'Completed');
  assert.equal(tl.resolveAttendanceLabels(S33, onTime, NOW, LONDON).bookOff, 'OFF 06:50');
  // A shift still marked in progress with an early Book Off reads the same.
  assert.equal(tl.resolveTimelineStatus({ ...S33, status: 'in_progress' }, att, NOW), 'Booked Off Early');
  // No Book Off is never early: closed by Control stays closed by Control.
  assert.equal(tl.resolveTimelineStatus(S33, { checkInAt: att.checkInAt, checkOutAt: null }, NOW, true), 'Closed by Control');
});

test('EBOW-03-THE-AUTUMN-CLOCK-CHANGE', () => {
  // 25-10-2026: scheduled end 07:00 GMT; booked off 00:30 BST (23:30Z the day before): 7h 30m of real time.
  const shift = { start: '2026-10-24T20:00:00.000Z', end: '2026-10-25T07:00:00.000Z', status: 'completed' };
  const att = { checkInAt: '2026-10-24T20:00:00.000Z', checkOutAt: '2026-10-24T23:30:00.000Z' };
  assert.equal(tl.resolveAttendanceLabels(shift, att, NOW, LONDON).bookOff, 'OFF 00:30 · 7h 30m early');
});

test('EBOW-04-TODAY-SO-FAR-COUNTS-EARLY-BOOK-OFFS', () => {
  const input = (checkOutAt) => ({ shift: S33, attendance: { checkInAt: '2026-10-17T18:29:00.000Z', checkOutAt }, operations: null, incidents: [], alerts: [] });
  const t = sum.buildTodaySoFar([input('2026-10-18T01:09:36.000Z'), input(at(5)), input(null)], NOW);
  assert.equal(t.attendance.bookedOff, 2);
  assert.equal(t.attendance.bookedOffEarly, 1);
});

test('EBOW-05-COVERAGE-WORDING-CLAIMS-NO-MORE-THAN-THE-EVIDENCE', () => {
  const view = (status, extra = {}) => ({
    bookOffAt: '2026-10-18T01:09:36.000Z', scheduledEnd: END, minutesEarly: 290, remainingMinutes: 290,
    coverage: { status, coveredMinutes: 0, uncoveredMinutes: 0, unknownMinutes: 0, reliesOnSchedule: false, coveringShiftIds: [], segments: [], ...extra },
  });
  assert.equal(ebo.COVERAGE_WORD.maintained, 'Coverage maintained');
  assert.equal(ebo.COVERAGE_WORD.partial, 'Partial coverage gap');
  assert.equal(ebo.COVERAGE_WORD.uncovered, 'Uncovered period');
  assert.equal(ebo.COVERAGE_WORD.undetermined, 'Coverage undetermined');
  assert.equal(ebo.coverageSentence(view('maintained', { coveringShiftIds: [32], coveredMinutes: 290 })), 'Another Guard covered the rest of the shift (shift #32).');
  assert.equal(ebo.coverageSentence(view('partial', { coveringShiftIds: [41], coveredMinutes: 240, uncoveredMinutes: 50 })),
    'Another Guard covered 4h (shift #41); 50m had no other Guard recorded in S4 on duty.');
  assert.match(ebo.coverageSentence(view('uncovered')), /^No other Guard recorded in S4 was on duty or scheduled at this site for the remaining 4h 50m\.$/);
  assert.match(ebo.coverageSentence(view('undetermined')), /cannot be confirmed/);
  assert.match(ebo.coverageSentence(view('maintained', { reliesOnSchedule: true, coveringShiftIds: [50] })), /from the schedule/);
});

test('EBOW-06-THE-DRAWER-NO-LONGER-SAYS-CLOSED-CLEANLY-FOR-AN-EARLY-BOOK-OFF', () => {
  const drawer = codeOf('src/components/company/CompanyLiveOperationsWorkspace.tsx');
  assert.match(drawer, /minutesEarly !== null\s*\?\s*`Booked off early/);
  assert.match(drawer, /closedCleanly && !isCompletedWithoutBookOff\(shift, attendance\) && minutesEarly === null/);
  assert.match(drawer, /<Text style=\{styles\.detailCardTitle\}>Booked Off Early<\/Text>/);
  assert.match(drawer, /Remaining scheduled time: \{formatDuration\(minutesEarly\)\}/);
  assert.match(drawer, /coverageSentence\(early\)/);
  assert.match(drawer, /label="Booked off early"/);
  const timeline = codeOf('src/components/company/CompanyOperationsTimeline.tsx');
  assert.match(timeline, /'Booked Off Early': \{/);
});

console.log(JSON.stringify({ event: 'early_book_off_presentation_certified', tests: passed }));
