#!/usr/bin/env node
/**
 * Live welfare monitoring (S4 Welfare & Reporting Remediation, Phase 2).
 *
 * Production, 17-18 October 2026: pilot shift 32 (21:00-07:00 BST) lost every welfare marker at midnight,
 * shift 33 lost them when it was booked off, a historical day showed none, and a missed-window history row
 * read "Missed Checkcall (Closed)" though nobody had closed anything. This suite executes the real modules
 * that fix each of those, and checks in the source that the board and the drawer use them.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const wm = loadTs('src/components/company/welfareMonitoring.ts');
const timeline = loadTs('src/components/company/operationsTimeline.ts');

const LONDON = 'Europe/London';
const MIN = 60_000;
const HOUR = 60 * MIN;
const Z = (s) => new Date(s).toISOString();

// Pilot shift 32 as published by GET /coverage/operations at 03:10 BST on 18-10-2026 (02:10Z).
const NOW = Date.parse('2026-10-18T02:10:00Z');
const S32_START = Date.parse('2026-10-17T20:00:00Z');
const win = (i, state, extra = {}) => ({
  index: i, start: Z(S32_START + i * HOUR), end: Z(S32_START + (i + 1) * HOUR), state,
  applicable: state !== 'not_applicable', completedAt: null, completionCount: 0, ...extra,
});
const S32_OPS = {
  bookOnAt: '2026-10-17T18:26:09Z', bookOffAt: null, timezone: LONDON,
  welfare: {
    enabled: true, intervalMinutes: 60, status: 'missed', currentWindow: null, lastWelfareAt: null, nextDueAt: null,
    overdueByMinutes: null, requiredCount: 10, completedCount: 5, missedCount: 1, consecutiveMissed: 1,
    windows: [
      win(0, 'completed', { completedAt: '2026-10-17T20:26:48Z', completionCount: 1 }),
      win(1, 'completed', { completedAt: '2026-10-17T21:01:16Z', completionCount: 1 }),
      win(2, 'completed', { completedAt: '2026-10-17T22:05:15Z', completionCount: 1 }),
      win(3, 'completed', { completedAt: '2026-10-17T22:57:00Z', completionCount: 1 }),
      win(4, 'completed', { completedAt: '2026-10-18T00:04:44Z', completionCount: 1 }),
      win(5, 'missed', { missRecordedAt: '2026-10-18T02:08:15Z', alert: { id: 28799, status: 'open', acknowledged: false, closedAt: null, closedBySystem: false, resolutionReason: null } }),
      win(6, 'due'),
      win(7, 'due'),
    ],
  },
  logBook: { required: false, intervalMinutes: null, currentWindow: null, currentWindowSubmitted: false, windows: [], requiredCount: 0, submittedCount: 0, missingCount: 0, lastEntryAt: null },
  welfareSummary: null, welfareEvidenceCount: 1, missingBookOff: false,
};

test('WMON-01-EACH-WINDOW-READS-AS-ONE-OF-THE-SEVEN-STATES', () => {
  const rows = wm.welfareWindowRows(S32_OPS, { nowMs: NOW, timeZone: LONDON });
  assert.deepEqual(rows.map((r) => r.stateWord), [
    'Completed', 'Completed', 'Completed', 'Completed', 'Completed', 'Missed', 'Due', 'Upcoming',
  ]);
  assert.deepEqual(Object.keys(wm.WELFARE_DISPLAY_WORD).sort(),
    ['completed', 'due', 'ended_at_book_off', 'missed', 'not_applicable', 'overdue', 'upcoming']);
});

test('WMON-02-OVERNIGHT-ROWS-CARRY-SITE-TIMES-AND-UK-DATES-EITHER-SIDE-OF-MIDNIGHT', () => {
  const rows = wm.welfareWindowRows(S32_OPS, { nowMs: NOW, timeZone: LONDON });
  assert.equal(rows[0].window, '21:00–22:00');
  assert.equal(rows[0].date, '17-10-2026');
  assert.equal(rows[3].window, '00:00–01:00');
  assert.equal(rows[3].date, '18-10-2026', 'DD-MM-YYYY, the site date the window starts on');
  assert.equal(rows[3].checkedAt, '23:57', 'the real check time, three minutes before the window');
  assert.equal(rows[5].missRecordedAt, '03:08');
  assert.equal(rows[5].alert, 'Alert #28799 · Open');
  assert.equal(rows[6].alert, null, 'nothing invented for a window not missed');
});

test('WMON-03-ALERT-WORDING-SAYS-WHO-CLOSED-IT', () => {
  const base = { id: 7, acknowledged: false, closedAt: null, resolutionReason: null, closedBySystem: false };
  assert.equal(wm.welfareAlertWord({ ...base, status: 'acknowledged', acknowledged: true }), 'Alert #7 · Acknowledged');
  assert.equal(wm.welfareAlertWord({ ...base, status: 'closed', resolutionReason: 'guard_confirmed_safe' }), 'Alert #7 · Resolved (Guard confirmed safe)');
  assert.equal(wm.welfareAlertWord({ ...base, status: 'closed', closedBySystem: true }), 'Alert #7 · Closed automatically (previous rule)');
  assert.equal(wm.welfareAlertWord(null), null);
  const unalerted = wm.welfareWindowRows({ ...S32_OPS, welfare: { ...S32_OPS.welfare, windows: [win(6, 'missed', { missRecordedAt: '2026-10-18T03:08:16Z', alert: null })] } }, { nowMs: NOW, timeZone: LONDON });
  assert.equal(unalerted[0].alert, 'No alert raised', 'a recorded miss no alert carried says so');
});

test('WMON-04-THE-DRAWER-NEVER-CALLS-A-HISTORY-RECORD-CLOSED', () => {
  const evidence = { type: 'missed_checkcall', status: 'closed', welfareWindowIndex: 3, closedByUserId: null, resolutionReason: null, message: 'Welfare Check missed - 00:00-01:00' };
  assert.equal(wm.safetyAlertDrawerLabel(evidence), 'Welfare Check missed - 00:00-01:00 · history record');
  assert.doesNotMatch(wm.safetyAlertDrawerLabel(evidence), /Closed/);
  const summary = { type: 'missed_checkcall', welfareWindowIndex: null, message: 'Welfare overdue - 1 consecutive check missed' };
  assert.equal(wm.safetyAlertDrawerLabel({ ...summary, status: 'open' }), 'Missed Welfare Check alert · Open');
  assert.equal(wm.safetyAlertDrawerLabel({ ...summary, status: 'closed', closedByUserId: 32, resolutionReason: 'app_technical_issue' }), 'Missed Welfare Check alert · Resolved (App technical issue)');
  assert.equal(wm.safetyAlertDrawerLabel({ ...summary, status: 'closed', closedByUserId: null }), 'Missed Welfare Check alert · Closed automatically (previous rule)');
  assert.equal(wm.safetyAlertDrawerLabel({ type: 'panic', status: 'acknowledged', welfareWindowIndex: null }), 'Panic · Acknowledged');
});

test('WMON-05-THE-INTERVAL-IS-THE-ONE-THE-BACKEND-APPLIED', () => {
  assert.equal(wm.welfareIntervalLabel({ welfare: { intervalMinutes: 30 } }, { checkCallIntervalMinutes: null }), 'Welfare Check every 30 min');
  assert.equal(wm.welfareIntervalLabel(null, { checkCallIntervalMinutes: 45 }), 'Welfare Check every 45 min');
  assert.equal(wm.welfareIntervalLabel(null, {}), 'Welfare Check every 60 min');
});

test('WMON-06-THE-BOARD-ASKS-FOR-EVERY-SHIFT-IT-CAN-SHOW', () => {
  const day = { dayStartMs: Date.parse('2026-10-17T23:00:00Z'), dayEndMs: Date.parse('2026-10-18T23:00:00Z') }; // 18-10 London
  const shifts = [
    { id: 32, start: '2026-10-17T20:00:00Z', end: '2026-10-18T06:00:00Z', status: 'in_progress' }, // overnight, started yesterday
    { id: 33, start: '2026-10-17T20:00:00Z', end: '2026-10-18T06:00:00Z', status: 'completed' }, // early Book Off
    { id: 26, start: '2026-10-13T20:00:00Z', end: '2026-10-14T06:00:00Z', status: 'completed' }, // reconciled, days ago
    { id: 19, start: '2026-10-13T19:00:00Z', end: '2026-10-14T05:00:00Z', status: 'in_progress' }, // awaiting reconciliation
    { id: 40, start: '2026-10-18T19:00:00Z', end: '2026-10-19T05:00:00Z', status: 'ready' }, // tonight
    { id: 41, start: '2026-10-25T19:00:00Z', end: '2026-10-26T05:00:00Z', status: 'ready' }, // next week
    { id: 42, start: '2026-10-18T09:00:00Z', end: '2026-10-18T17:00:00Z', status: 'cancelled' },
  ];
  assert.deepEqual(wm.operationsShiftIds(shifts, day), [19, 32, 33, 40]);
  // A historical day: the reconciled shift of 13-10 is included when that day is selected.
  const d13 = { dayStartMs: Date.parse('2026-10-12T23:00:00Z'), dayEndMs: Date.parse('2026-10-13T23:00:00Z') };
  assert.ok(wm.operationsShiftIds(shifts, d13).includes(26));
});

test('WMON-07-THE-REQUEST-IS-CAPPED-NEAREST-FIRST', () => {
  const day = { dayStartMs: Date.parse('2026-10-18T00:00:00Z'), dayEndMs: Date.parse('2026-10-19T00:00:00Z') };
  const many = Array.from({ length: 260 }, (_, i) => ({
    id: i + 1, start: Z(Date.parse('2026-10-18T00:00:00Z') - i * MIN), end: Z(Date.parse('2026-10-18T08:00:00Z')), status: 'in_progress',
  }));
  const ids = wm.operationsShiftIds(many, day);
  assert.equal(ids.length, wm.OPERATIONS_MAX_SHIFT_IDS);
  assert.ok(ids.includes(1) && !ids.includes(260), 'the nearest are kept');
});

test('WMON-08-TIMELINE-MARKERS-USE-THE-SAME-STATES-AND-SAY-WHAT-HAPPENED', () => {
  const axis = timeline.resolveTimelineWindow(NOW, 12, LONDON);
  const markers = timeline.resolveWelfareMarkers(S32_OPS.welfare.windows, axis, { guardName: 'Guard', timeZone: LONDON, nowMs: NOW });
  const byIndex = new Map(markers.map((m) => [m.index, m]));
  assert.equal(byIndex.get(5).state, 'missed');
  assert.match(byIndex.get(5).accessibleLabel, /Welfare Check 02:00–03:00, Missed, recorded 03:08, Alert #28799 · Open/);
  assert.equal(byIndex.get(6).state, 'due', '03:00-04:00 is running at 03:10');
  assert.equal(byIndex.get(7).state, 'upcoming', '04:00-05:00 has not started');
  assert.match(byIndex.get(3).accessibleLabel, /00:00–01:00, Completed at 23:57/);
  const partial = timeline.resolveWelfareMarkers([win(5, 'ended_at_book_off')], axis, { guardName: 'Guard', timeZone: LONDON, nowMs: NOW });
  assert.equal(partial[0].glyph, '◐');
  assert.match(partial[0].accessibleLabel, /Ended at Book Off/);
});

test('WMON-10-A-SHIFT-NOT-YET-BOOKED-ON-READS-AS-UPCOMING-NOT-NOT-REQUIRED', () => {
  const tonight = { ...S32_OPS, bookOnAt: null, welfare: { ...S32_OPS.welfare, windows: [
    { ...win(0, 'not_applicable'), start: Z(NOW + HOUR), end: Z(NOW + 2 * HOUR) },
    { ...win(1, 'not_applicable'), start: Z(NOW - 2 * HOUR), end: Z(NOW - HOUR) },
  ] } };
  const ready = wm.welfareWindowRows(tonight, { nowMs: NOW, timeZone: LONDON, shiftStatus: 'ready' });
  assert.equal(ready[0].stateWord, 'Upcoming', 'a future window of a shift still to be worked');
  assert.equal(ready[1].stateWord, 'Not required', 'a past window with no Book On is an attendance matter, never a welfare miss');
  const cancelled = wm.welfareWindowRows(tonight, { nowMs: NOW, timeZone: LONDON, shiftStatus: 'cancelled' });
  assert.equal(cancelled[0].stateWord, 'Not required', 'a cancelled shift owes nothing');
  const axis = timeline.resolveTimelineWindow(NOW, 12, LONDON);
  const markers = timeline.resolveWelfareMarkers(tonight.welfare.windows, axis, { guardName: 'G', timeZone: LONDON, nowMs: NOW, awaitingBookOn: true });
  assert.equal(markers.find((m) => m.index === 0).state, 'upcoming');
});

test('WMON-09-THE-BOARD-AND-DRAWER-USE-THE-NEW-PATHS', () => {
  const screen = codeOf('src/screens/CompanyDashboardScreen.tsx');
  assert.match(screen, /listShiftOperations\(ids\)/, 'monitoring is requested by shift id');
  assert.doesNotMatch(screen, /listCoverageShifts\(\{ from: todayIsoDate\(\), to: todayIsoDate\(\) \}\)/, 'not from the coverage list for today');
  const drawer = codeOf('src/components/company/CompanyLiveOperationsWorkspace.tsx');
  assert.match(drawer, /safetyAlertDrawerLabel\(a\)/);
  assert.doesNotMatch(drawer, /fmtStatus\(a\.type\)\} \(\{fmtStatus\(a\.status\)\}\)/, 'no raw "(Closed)" for history rows');
  assert.match(drawer, /welfareIntervalLabel\(operations, shift\)/);
  assert.match(drawer, /welfareWindowRows\(operations/);
  const api = codeOf('src/services/api.ts');
  assert.match(api, /\/coverage\/operations\?shiftIds=/);
});

console.log(JSON.stringify({ event: 'welfare_monitoring_presentation_certified', tests: passed }));
