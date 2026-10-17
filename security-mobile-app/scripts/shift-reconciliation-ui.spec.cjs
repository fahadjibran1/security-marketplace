#!/usr/bin/env node
/**
 * S4 Live Operations Phase 4: Close without Book Off (client), and the overdue timeline.
 *
 * Executes the real reconciliation, policy, board and timeline modules, checks the client's reasons and
 * request against the API's own source, and checks the wiring that needs a DOM by reading the source:
 * the action is only offered to shift managers, always needs confirmation, and is never automatic.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const backendOf = (rel) => fs.readFileSync(path.join(ROOT, '..', 'security-backend-nest', rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const recon = loadTs('src/components/company/shiftReconciliation.ts');
const timeline = loadTs('src/components/company/operationsTimeline.ts');
const board = loadTs('src/components/company/liveOperationsBoard.ts');

const LONDON = 'Europe/London';
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-16T22:11:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const siteDay = (instant) => loadTs('src/services/siteTime.ts').formatSiteDateInput(instant, LONDON);
const worked = (endedMinsAgo, status = 'in_progress') => ({
  id: 70, status, start: iso(NOW - endedMinsAgo * MIN - 8 * HOUR), end: iso(NOW - endedMinsAgo * MIN),
  siteName: 'Site', site: { id: 1, name: 'Site', timezone: LONDON }, guard: { fullName: 'Guard' },
});
const on = (shift) => ({ checkInAt: iso(Date.parse(shift.start) + 2 * MIN), checkOutAt: null });

// ═══════════════════ the form and the API agree ═══════════════════

test('UI-01-THE-REASONS-ARE-EXACTLY-THE-APIS', () => {
  const api = backendOf('src/shift/shift-reconciliation.ts');
  const block = api.slice(api.indexOf('export const SHIFT_RECONCILIATION_REASONS = ['), api.indexOf('] as const;'));
  const apiValues = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(recon.SHIFT_RECONCILIATION_OPTIONS.map((o) => o.value), apiValues);
  assert.deepEqual(recon.SHIFT_RECONCILIATION_OPTIONS.map((o) => o.label), [
    'Guard forgot to Book Off', 'Application/connectivity failure', 'Control-room confirmed departure', 'Other',
  ]);
  assert.ok(api.includes(`SHIFT_RECONCILIATION_NOTE_MAX = ${recon.SHIFT_RECONCILIATION_NOTE_MAX};`), 'same note limit');
});

test('UI-02-THE-REQUEST-MATCHES-THE-ROUTE-AND-THE-DTO', () => {
  const client = codeOf('src/services/api.ts');
  assert.ok(client.includes("`/shifts/${id}/reconcile-without-book-off`"), 'path');
  assert.match(client.slice(client.indexOf('export function reconcileShiftWithoutBookOff')), /method: 'POST', body: JSON\.stringify\(payload\)/);
  const controller = backendOf('src/shift/shift.controller.ts');
  assert.ok(controller.includes("@Post(':id/reconcile-without-book-off')"), 'the API route');
  const dto = backendOf('src/shift/dto/reconcile-shift.dto.ts');
  assert.ok(/reason!: ShiftReconciliationReason/.test(dto) && /note\?: string \| null/.test(dto), 'reason and note, as sent');
});

test('UI-03-A-REASON-IS-MANDATORY-AND-OTHER-NEEDS-AN-EXPLANATION', () => {
  assert.equal(recon.validateShiftReconciliation({ reason: null, note: '' }).ok, false);
  assert.equal(recon.validateShiftReconciliation({ reason: 'made_up', note: '' }).ok, false);
  assert.equal(recon.validateShiftReconciliation({ reason: 'other', note: '   ' }).ok, false);
  assert.match(recon.validateShiftReconciliation({ reason: 'other', note: '' }).message, /Explain/);
  assert.equal(recon.validateShiftReconciliation({ reason: 'other', note: 'x'.repeat(1001) }).ok, false);
  for (const option of recon.SHIFT_RECONCILIATION_OPTIONS) {
    assert.equal(recon.validateShiftReconciliation({ reason: option.value, note: 'seen leaving' }).ok, true, option.value);
  }
  assert.equal(recon.validateShiftReconciliation({ reason: 'guard_forgot_book_off', note: '' }).ok, true, 'a note is optional otherwise');
});

// ═══════════════════ eligibility ═══════════════════

test('UI-04-OFFERED-ONLY-FOR-AN-OVERDUE-SHIFT-WITH-A-BOOK-ON-AND-NO-BOOK-OFF', () => {
  const eligible = (shift, attendance) => recon.isEligibleForReconciliation(shift, attendance, NOW);
  const s16 = worked(16);
  assert.equal(eligible(s16, on(s16)), true, 'end + 16 minutes');
  const s15 = worked(15);
  assert.equal(eligible(s15, on(s15)), false, 'end + 15 minutes is still grace');
  const active = worked(-120);
  assert.equal(eligible(active, on(active)), false, 'a genuinely active shift is never offered it');
  assert.equal(eligible(s16, null), false, 'no Book On');
  assert.equal(eligible(s16, { checkInAt: 'x', checkOutAt: 'y' }), false, 'already booked off');
  for (const status of ['completed', 'ready', 'missed', 'cancelled']) {
    assert.equal(eligible(worked(120, status), on(s16)), false, status);
  }
  const stale = worked(72 * 60);
  assert.equal(eligible(stale, on(stale)), true, 'and awaiting reconciliation');
});

// ═══════════════════ the overdue timeline ═══════════════════

test('UI-05-AN-OVERDUE-BAR-STOPS-AT-THE-SCHEDULED-END-WITH-THE-OVERDUE-TIME-SEPARATE', () => {
  const s = worked(135); // ended 2h 15m ago
  const a = on(s);
  assert.equal(timeline.effectiveShiftEndMs(s, a, NOW), Date.parse(s.end), 'bar stops at the scheduled end');
  const groups = timeline.buildTimeline([{ shift: s, attendance: a }], timeline.resolveTimelineWindow(NOW, 12, LONDON), NOW);
  const [row] = groups[0].rows;
  assert.equal(row.status, 'No Book Off');
  assert.equal(row.attendance.bookOff, 'OFF overdue 2h 15m', 'elapsed overdue time, as its own figure');
  assert.match(row.attendance.bookOn, /^ON \d\d:\d\d$/, 'the actual Book On is kept');
  assert.equal(row.span.clippedEnd, false, 'the bar ends at its own end, inside the view');
  assert.ok(row.span.startFraction + row.span.widthFraction < 0.6, 'and well before now (the middle of the view)');
});

test('UI-06-AN-OVERDUE-BAR-THAT-ENDED-BEFORE-THE-VIEW-KEEPS-ITS-ROW', () => {
  const s = worked(13 * 60);
  const groups = timeline.buildTimeline([{ shift: s, attendance: on(s) }], timeline.resolveTimelineWindow(NOW, 8, LONDON), NOW);
  assert.equal(timeline.timelineRowCount(groups), 1, 'the board and the timeline agree');
  assert.equal(groups[0].rows[0].span.endedBeforeWindow, true, 'drawn as an edge marker, not a bar to now');
  // But a shift awaiting reconciliation belongs to its queue, not today's axis.
  const stale = worked(30 * 60);
  assert.equal(timeline.timelineRowCount(timeline.buildTimeline([{ shift: stale, attendance: on(stale) }], timeline.resolveTimelineWindow(NOW, 8, LONDON), NOW)), 0);
  assert.equal(timeline.formatElapsedSinceEnd(iso(NOW - 45 * MIN), NOW), '45m');
  assert.equal(timeline.formatElapsedSinceEnd(iso(NOW - 26 * HOUR - 5 * MIN), NOW), '26h');
  assert.equal(timeline.formatElapsedSinceEnd(iso(NOW + HOUR), NOW), '0m');
});

test('UI-07-INSIDE-THE-GRACE-THE-SHIFT-IS-STILL-LIVE', () => {
  const s = worked(10);
  const a = on(s);
  assert.equal(timeline.resolveTimelineStatus(s, a, NOW), 'Live');
  assert.equal(timeline.effectiveShiftEndMs(s, a, NOW), NOW, 'a live bar still runs to now');
  assert.equal(timeline.resolveAttendanceLabels(s, a, NOW, LONDON).bookOff, 'OFF —');
});

// ═══════════════════ after reconciliation: history ═══════════════════

test('UI-08-A-RECONCILED-SHIFT-READS-CLOSED-BY-CONTROL-NO-BOOK-OFF', () => {
  const s = worked(30 * 60, 'completed');
  const a = on(s);
  assert.equal(recon.isClosedWithoutBookOff(s, a), true);
  assert.equal(recon.isClosedWithoutBookOff(s, { checkInAt: 'x', checkOutAt: 'y' }), false, 'a Guard Book Off is not');
  assert.equal(recon.CLOSED_BY_CONTROL_LABEL, 'Closed by Control — No Book Off');
  // It leaves the reconciliation queue and Live counts...
  const live = board.selectLiveBoard([s], () => ({ shift: s, bookedOn: true, timeZone: LONDON }), { now: new Date(NOW), date: '', referenceZone: LONDON });
  assert.deepEqual(live.reconciliation, [], 'removed from the queue');
  assert.equal(live.board.length, 0);
  // ...and stays visible on its own day, marked as closed by Control with no Book Off time.
  const day = board.selectLiveBoard([s], () => ({ shift: s, bookedOn: true, timeZone: LONDON }), { now: new Date(NOW), date: siteDay(s.start), referenceZone: LONDON });
  assert.equal(day.board.length, 1, 'visible in the historical day view');
  const window = timeline.resolveTimelineWindow(Date.parse(s.start) + 4 * HOUR, 24, LONDON);
  const [row] = timeline.buildTimeline([{ shift: s, attendance: a }], window, NOW)[0].rows;
  assert.equal(row.status, 'Closed by Control');
  assert.equal(row.attendance.bookOff, 'No Book Off', 'no Book Off time shown or invented');
  assert.equal(timeline.effectiveShiftEndMs(s, a, NOW), Date.parse(s.end), 'the bar is the schedule');
  const tl = codeOf('src/components/company/CompanyOperationsTimeline.tsx');
  assert.ok(tl.includes("row.status === 'Closed by Control' ? 'Closed by Control — No Book Off'"), 'screen readers hear the full phrase');
  const ws = codeOf('src/components/company/CompanyLiveOperationsWorkspace.tsx');
  assert.ok(ws.includes('${CLOSED_BY_CONTROL_LABEL}. No Book Off time was recorded.'), 'the shift drawer says it in full');
  assert.ok(ws.includes('closeOutSummary.closedCleanly && !isClosedWithoutBookOff(shift, attendance)'), 'and its close-out never says Closed cleanly');
  const screen = codeOf('src/screens/CompanyDashboardScreen.tsx');
  assert.ok(screen.includes('{ icon: \'⚠️\', label: CLOSED_BY_CONTROL_LABEL, color: colors.warning }'), 'and so does its badge');
});

// ═══════════════════ wiring: who, confirmation, never automatic ═══════════════════

test('UI-09-ONLY-SHIFT-MANAGERS-ARE-OFFERED-IT', () => {
  const screen = codeOf('src/screens/CompanyDashboardScreen.tsx');
  assert.ok(screen.includes('onReconcileShift={canManageShifts ? handleOpenReconcile : undefined}'));
  assert.ok(screen.includes('user.companyPermissions.includes("shifts.manage")'), 'canManageShifts is the shifts.manage permission');
  const ws = codeOf('src/components/company/CompanyLiveOperationsWorkspace.tsx');
  assert.ok(ws.includes('{onReconcileShift ? ('), 'the queue button only exists when offered');
  assert.ok(ws.includes('onReconcileShift && isEligibleForReconciliation(shift, attendance, nowMs)'), 'the drawer button only for an eligible shift');
});

test('UI-10-SUBMISSION-ALWAYS-NEEDS-CONFIRMATION', () => {
  const drawer = stripComments(codeOf('src/components/company/CompanyReconcileShiftDrawer.tsx'));
  assert.ok(!/services\/api/.test(drawer), 'the dialog reaches no endpoint of its own');
  assert.equal((drawer.match(/onSubmit\(/g) || []).length, 1, 'one submit path');
  const confirmFn = drawer.slice(drawer.indexOf('const confirm = () => {'), drawer.indexOf('return (', drawer.indexOf('const confirm = () => {')));
  assert.ok(confirmFn.includes('onSubmit('), 'and it is the confirm step');
  const reviewFn = drawer.slice(drawer.indexOf('const review = () => {'), drawer.indexOf('const confirm = () => {'));
  assert.ok(!reviewFn.includes('onSubmit'), 'the first press only asks for confirmation');
  assert.ok(drawer.includes("onPress={confirming ? confirm : review}"));
  assert.ok(drawer.includes('No Book Off time will be recorded'), 'the confirmation says what will not happen');
});

test('UI-11-NOTHING-RECONCILES-AUTOMATICALLY', () => {
  const screen = stripComments(codeOf('src/screens/CompanyDashboardScreen.tsx'));
  const calls = screen.match(/reconcileShiftWithoutBookOff\(/g) || [];
  assert.equal(calls.length, 1, 'one call site');
  const handler = screen.slice(screen.indexOf('const handleSubmitReconcile'), screen.indexOf('}, [reconcileTarget, loadData]);'));
  assert.ok(handler.includes('reconcileShiftWithoutBookOff('), 'which is the confirmed submit handler');
  assert.ok(handler.includes('await loadData(true);'), 'then reloads so the shift leaves the queue');
  for (const file of ['liveOperationsBoard.ts', 'liveOperationsPolicy.ts', 'operationsTimeline.ts', 'shiftReconciliation.ts']) {
    assert.ok(!/reconcileShiftWithoutBookOff|services\/api/.test(stripComments(codeOf(`src/components/company/${file}`))), `${file} never calls it`);
  }
  // No effect anywhere starts it.
  const effects = screen.split('React.useEffect(').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf('}, [')));
  assert.ok(!effects.some((body) => /handleSubmitReconcile|reconcileShiftWithoutBookOff/.test(body)), 'no effect reconciles');
});

console.log(`\n${passed} shift reconciliation UI checks passed`);
