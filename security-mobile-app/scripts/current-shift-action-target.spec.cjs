#!/usr/bin/env node
/**
 * Current Shift actions target the live shift. (Build 12 P0.)
 *
 * THE DEVICE EVIDENCE
 * Build 12 on a real Android device showed, simultaneously:
 *
 *   SHIFT DETAILS  test site, Wed 30 Sep 2026, 19:10-20:10, In Progress, LIVE
 *   STATUS         You are on shift.
 *   LIVE CLOCK     Checked in 18:53, duration ~20 min
 *   WELFARE CHECK  DUE, next due 19:25, every 15 min
 *
 * and every action form refused with "... is only available during an active shift." The Emergency form
 * even accepted SOS and enabled its button, then refused — because the button state reads the typed word
 * while the dispatcher reads the shift.
 *
 * THE CAUSE
 * The screen carried two shift identities. Everything the Guard could SEE read `currentHomeShift`. The
 * action dispatcher read `selectedShift`:
 *
 *   selectedShift = sortedShifts.find((s) => s.id === selectedShiftId) || currentHomeShift || null
 *
 * and `selectedShiftId` was re-pointed at the current shift only when it was null or when its shift had
 * disappeared from the list. A stale id that still existed stuck forever, so the dispatcher was handed a
 * completed shift and correctly refused it. It was refusing the wrong shift.
 *
 * WHAT THIS SUITE DOES
 * BUILD12-01 reimplements that exact expression and proves it produces the refusal while the current
 * shift is live — the reproduction, executed. Everything after it proves the fix resolves the target from
 * the authoritative current shift instead, and that all five actions then reach the API with the LIVE
 * shift's id.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = async (id, fn) => { await fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const target = loadTs('src/components/guard/currentShiftActionTarget.ts');
const dispatch = loadTs('src/components/guard/guardActionDispatch.ts');
const { resolveCurrentShiftActionTarget, currentShiftActionShift, isCurrentShiftActionable } = target;
const { dispatchGuardAction, guardActionBlockedReason } = dispatch;

const SCREEN = 'src/screens/GuardDashboardScreen.tsx';

// ─── The device's state, as fixtures ─────────────────────────────────────────

/** Shift 16: the fresh UAT shift the Guard is actually working. 19:10-20:10 London, booked on 18:53. */
const LIVE_SHIFT = { id: 16, status: 'in_progress', start: '2026-09-30T18:10:00.000Z', end: '2026-09-30T19:10:00.000Z' };
const LIVE_ATTENDANCE = { checkInAt: '2026-09-30T17:53:00.000Z', checkOutAt: null };

/** Shift 15: an older completed shift that `selectedShiftId` was still pointing at. */
const STALE_COMPLETED = { id: 15, status: 'completed', start: '2026-09-29T18:10:00.000Z', end: '2026-09-29T19:10:00.000Z' };

/** The shift list, start-ascending, exactly as `sortedShifts` builds it. */
const SORTED_SHIFTS = [STALE_COMPLETED, LIVE_SHIFT];

/** `currentHomeShift`: first in_progress, then ready, then offered, then most recent completed. */
const currentHomeShift = (shifts) =>
  shifts.find((s) => s.status === 'in_progress')
  || shifts.find((s) => s.status === 'ready')
  || shifts.find((s) => s.status === 'offered')
  || [...shifts].filter((s) => s.status === 'completed').sort((a, b) => new Date(b.end) - new Date(a.end))[0]
  || null;

/** The pre-fix expression, verbatim in behaviour. This is what the dispatcher used to be handed. */
const build12SelectedShift = (shifts, selectedShiftId) =>
  shifts.find((s) => s.id === selectedShiftId) || currentHomeShift(shifts) || null;

/** Records every API call, so a test can assert which shift id actually went out. */
function harness() {
  const calls = { createDailyLog: [], createIncident: [], createSafetyAlert: [] };
  const fx = { closed: 0, reloaded: 0, feedback: [] };
  const record = (name) => async (payload) => { calls[name].push(payload); return { id: 999 }; };
  return {
    calls,
    fx,
    api: {
      createDailyLog: record('createDailyLog'),
      createIncident: record('createIncident'),
      createSafetyAlert: record('createSafetyAlert'),
    },
    effects: {
      setBusy: () => {},
      clearValue: () => {},
      closeForm: () => { fx.closed += 1; },
      reload: async () => { fx.reloaded += 1; },
      timeline: () => {},
      feedback: (tone, title, message) => fx.feedback.push([tone, title, message]),
    },
    total: () => calls.createDailyLog.length + calls.createIncident.length + calls.createSafetyAlert.length,
  };
}

async function main() {
  // ═══════════════════ the reproduction ═══════════════════

  await test('BUILD12-01-THE-DEFECT-REPRODUCED-LIVE-CARD-REFUSED-ACTIONS', async () => {
    const home = currentHomeShift(SORTED_SHIFTS);
    // What the Guard saw: the card is the live shift.
    assert.equal(home.id, 16);
    assert.equal(home.status, 'in_progress');

    // What the dispatcher was handed: shift 15, still selected, still present in the list, so never
    // re-pointed. This is the whole bug in one line.
    const stale = build12SelectedShift(SORTED_SHIFTS, 15);
    assert.equal(stale.id, 15, 'selectedShift stuck on the completed shift');
    assert.equal(stale.status, 'completed');
    assert.notEqual(stale.id, home.id, 'the two identities disagree — the divergence');

    // And every action refuses, with the exact message from the device.
    for (const key of ['welfareCheck', 'logBook', 'siteRequest', 'incident', 'emergency']) {
      const value = key === 'emergency' ? 'SOS' : 'note';
      const blocked = guardActionBlockedReason(key, { shift: stale, value, busy: false });
      assert.ok(blocked, `${key} must be blocked in the Build 12 state`);
      assert.equal(blocked.reason, 'no_active_shift');
      assert.match(blocked.message, /only available during an active shift/);
    }

    // Zero requests, which is why Render's log showed nothing.
    const h = harness();
    await dispatchGuardAction('logBook', { shift: stale, value: 'note', busy: false }, h.api, h.effects);
    assert.equal(h.total(), 0, 'no request was emitted — matching the Render request log');
  });

  await test('BUILD12-02-THE-EMERGENCY-BUTTON-ENABLED-THEN-REFUSED', async () => {
    // The device detail that looked contradictory: SOS enabled the button, and submitting still refused.
    // The button state reads only the typed word; the dispatcher reads the shift. Both were behaving.
    const forms = loadTs('src/components/guard/guardActionForms.ts');
    const emergency = forms.guardActionForm('emergency');
    const submit = forms.resolveActionSubmitState(emergency, { value: 'SOS', busy: false });
    assert.equal(submit.disabled, false, 'SOS enables the button');

    const stale = build12SelectedShift(SORTED_SHIFTS, 15);
    const blocked = guardActionBlockedReason('emergency', { shift: stale, value: 'SOS', busy: false });
    assert.equal(blocked.reason, 'no_active_shift', 'and the dispatcher still refuses the wrong shift');
  });

  // ═══════════════════ the fix ═══════════════════

  await test('TARGET-01-THE-FIX-RESOLVES-THE-LIVE-SHIFT-FROM-THE-CARDS-OWN-SOURCE', async () => {
    const home = currentHomeShift(SORTED_SHIFTS);
    const resolved = resolveCurrentShiftActionTarget(home, LIVE_ATTENDANCE);
    assert.equal(resolved.eligible, true);
    assert.equal(resolved.shift.id, 16, 'the LIVE shift, not the stale selection');
    assert.equal(resolved.shift.status, 'in_progress');

    // Whatever selectedShiftId happens to be is now irrelevant to actions.
    for (const staleId of [15, 99, null, undefined]) {
      const ignored = build12SelectedShift(SORTED_SHIFTS, staleId);
      assert.ok(ignored, 'the old expression still resolves something');
      assert.equal(
        currentShiftActionShift(home, LIVE_ATTENDANCE).id, 16,
        `selectedShiftId=${staleId} must not affect the action target`,
      );
    }
  });

  await test('TARGET-02-ALL-FIVE-ACTIONS-REACH-THE-API-WITH-THE-LIVE-SHIFT-ID', async () => {
    const home = currentHomeShift(SORTED_SHIFTS);
    const shift = currentShiftActionShift(home, LIVE_ATTENDANCE);
    assert.equal(shift.id, 16);

    const cases = [
      ['welfareCheck', 'All well at the gate', 'createDailyLog', { logType: 'welfare_check' }],
      ['logBook', 'UAT Log Book — all secure', 'createDailyLog', { logType: 'log_book' }],
      ['siteRequest', 'UAT Site Request — log books required', 'createSafetyAlert', { type: 'site_request', priority: 'medium' }],
      ['incident', 'UAT incident — broken window', 'createIncident', { severity: 'medium' }],
      ['emergency', 'SOS', 'createSafetyAlert', { type: 'panic', priority: 'critical' }],
    ];

    for (const [key, value, endpoint, expected] of cases) {
      const h = harness();
      const outcome = await dispatchGuardAction(key, { shift, value, busy: false }, h.api, h.effects);
      assert.deepEqual(outcome, { kind: 'success' }, `${key} must succeed`);
      assert.equal(h.total(), 1, `${key} must make exactly one request`);

      const sent = h.calls[endpoint][0];
      assert.equal(sent.shiftId, 16, `${key} must carry the LIVE shift id, got ${sent.shiftId}`);
      assert.notEqual(sent.shiftId, 15, `${key} must never carry the stale selection`);
      for (const [field, want] of Object.entries(expected)) {
        assert.equal(sent[field], want, `${key} ${field}`);
      }
      assert.equal(h.fx.closed, 1, `${key} closes the form on success`);
      assert.equal(h.fx.reloaded, 1, `${key} reloads once`);
    }
  });

  await test('TARGET-03-ATTENDANCE-BEATS-A-LAGGING-STATUS-STRING', async () => {
    // A Guard who has booked on is working. If the status column has not caught up, an incident must
    // still be raisable — the same call the backend makes in classifyLiveOperation.
    const ready = { id: 20, status: 'ready' };
    assert.equal(isCurrentShiftActionable(ready, { checkInAt: '2026-09-30T17:53:00.000Z', checkOutAt: null }), true);
    const resolved = resolveCurrentShiftActionTarget(ready, { checkInAt: '2026-09-30T17:53:00.000Z', checkOutAt: null });
    assert.equal(resolved.shift.id, 20);
    assert.equal(resolved.shift.status, 'in_progress', 'reported as live, so the dispatcher agrees');
  });

  // ═══════════════════ negative cases ═══════════════════

  await test('NEG-01-NO-CURRENT-SHIFT-BLOCKS-EVERY-ACTION', async () => {
    for (const absent of [null, undefined]) {
      const resolved = resolveCurrentShiftActionTarget(absent, undefined);
      assert.equal(resolved.eligible, false);
      assert.equal(resolved.reason, 'no_shift');
      assert.equal(currentShiftActionShift(absent, undefined), null);
    }

    // And the dispatcher refuses, with zero calls.
    const h = harness();
    const outcome = await dispatchGuardAction(
      'logBook', { shift: currentShiftActionShift(null, undefined), value: 'note', busy: false }, h.api, h.effects,
    );
    assert.equal(outcome.kind, 'blocked');
    assert.equal(outcome.reason, 'no_active_shift');
    assert.equal(h.total(), 0);
  });

  await test('NEG-02-READY-BUT-NOT-BOOKED-ON-BLOCKS-EVERY-ACTION', async () => {
    const ready = { id: 21, status: 'ready' };
    for (const attendance of [undefined, null, {}, { checkInAt: null, checkOutAt: null }]) {
      const resolved = resolveCurrentShiftActionTarget(ready, attendance);
      assert.equal(resolved.eligible, false, 'not on post yet');
      assert.equal(resolved.reason, 'not_started');
    }
    const h = harness();
    await dispatchGuardAction(
      'welfareCheck', { shift: currentShiftActionShift(ready, undefined), value: 'note', busy: false }, h.api, h.effects,
    );
    assert.equal(h.total(), 0, 'a shift not started owes no welfare check');
  });

  await test('NEG-03-A-COMPLETED-OR-BOOKED-OFF-SHIFT-BLOCKS-EVERY-ACTION', async () => {
    for (const status of ['completed', 'cancelled', 'missed', 'rejected']) {
      const resolved = resolveCurrentShiftActionTarget({ id: 22, status }, { checkInAt: 'x', checkOutAt: null });
      assert.equal(resolved.eligible, false, `${status} is over`);
      assert.equal(resolved.reason, 'settled');
    }
    // Booked off ends it even if the status has not caught up.
    const bookedOff = resolveCurrentShiftActionTarget(
      { id: 23, status: 'in_progress' },
      { checkInAt: '2026-09-30T17:53:00.000Z', checkOutAt: '2026-09-30T19:10:00.000Z' },
    );
    assert.equal(bookedOff.eligible, false);
    assert.equal(bookedOff.reason, 'settled');
  });

  await test('NEG-04-A-HISTORICAL-SELECTION-NEVER-STEALS-A-LIVE-ACTION', async () => {
    // The case the instruction called out as especially important, and the one the device hit. The
    // Guard has a historical shift selected while another shift is genuinely live. Actions must target
    // the live shift.
    const shifts = [
      { id: 10, status: 'completed', start: '2026-09-27T08:00:00.000Z', end: '2026-09-27T16:00:00.000Z' },
      { id: 12, status: 'missed', start: '2026-09-28T08:00:00.000Z', end: '2026-09-28T16:00:00.000Z' },
      STALE_COMPLETED,
      LIVE_SHIFT,
    ];
    const home = currentHomeShift(shifts);
    assert.equal(home.id, 16, 'the live shift is the current one');

    for (const historicalId of [10, 12, 15]) {
      // Pre-fix: the dispatcher would have been handed the historical shift.
      const wrong = build12SelectedShift(shifts, historicalId);
      assert.equal(wrong.id, historicalId, 'the old expression picks the historical shift');
      assert.equal(guardActionBlockedReason('logBook', { shift: wrong, value: 'n', busy: false }).reason, 'no_active_shift');

      // Post-fix: the target is the live shift regardless, and the request carries its id.
      const h = harness();
      await dispatchGuardAction(
        'logBook',
        { shift: currentShiftActionShift(home, LIVE_ATTENDANCE), value: 'n', busy: false },
        h.api, h.effects,
      );
      assert.equal(h.calls.createDailyLog[0].shiftId, 16, `selection ${historicalId} must not be targeted`);
    }
  });

  // ═══════════════════ production really uses it ═══════════════════

  await test('WIRE-01-THE-SCREEN-DISPATCHES-AGAINST-THE-RESOLVED-TARGET', async () => {
    const screen = codeOf(SCREEN);
    assert.ok(
      screen.includes("from '../components/guard/currentShiftActionTarget'"),
      'the screen imports the shared resolver',
    );
    assert.ok(
      screen.includes('const currentShiftActionTarget = currentShiftActionShift('),
      'and resolves the target once',
    );
    assert.ok(
      screen.includes('{ shift: currentShiftActionTarget, value: actionFormValue(key), busy: actionFormBusy(key) }'),
      'the dispatcher is given the resolved target',
    );
    // The line that caused the defect must not feed an action any more.
    assert.ok(
      !screen.includes('{ shift: selectedShift, value: actionFormValue(key)'),
      'selectedShift must no longer be dispatched against',
    );
    assert.ok(
      !screen.includes('guardActionBlockedReason(form.key, { shift: selectedShift'),
      'nor drive the inline refusal',
    );
  });

  await test('WIRE-02-THE-TARGET-COMES-FROM-THE-SAME-SOURCE-AS-THE-CARD', async () => {
    const screen = codeOf(SCREEN);
    assert.ok(
      screen.includes('currentShiftActionShift(currentHomeShift, currentHomeShiftAttendance)'),
      'resolved from currentHomeShift and its own attendance — the card\'s own values',
    );
    // selectedShift still exists for the surfaces that legitimately own it.
    assert.ok(screen.includes('const selectedShift ='), 'selectedShift is not removed');
    assert.ok(screen.includes('selectedShiftTimeline'), 'and still drives the detail panel');
  });

  console.log(`\n${passed} current shift action target checks passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
