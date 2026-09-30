// Which shift a Current Shift action is raised against. (Build 12 P0.)
//
// THE DEFECT THIS EXISTS TO FIX
// Build 12 on a real device showed, at the same moment:
//
//   SHIFT DETAILS  test site, Wed 30 Sep 2026, 19:10-20:10, In Progress, LIVE
//   LIVE CLOCK     Checked in 18:53, duration ~20 min
//   WELFARE CHECK  DUE, next due 19:25, every 15 min
//
// and yet every action form refused with "... is only available during an active shift."
//
// The screen carried TWO shift identities. The Current Shift card, the LIVE badge, the live clock, the
// Welfare projection and Book On / Book Off all read `currentHomeShift` — the first in_progress shift.
// The action dispatcher instead read `selectedShift`:
//
//   selectedShift = sortedShifts.find((s) => s.id === selectedShiftId) || currentHomeShift || null
//
// and `selectedShiftId` was only ever re-pointed at the current shift when it was null or when its shift
// had vanished from the list entirely. A stale id that still EXISTED — yesterday's completed shift, a row
// opened from History, or the shift that was current when the app last resolved it — stuck indefinitely.
// So `selectedShift` was a completed shift while `currentHomeShift` was live, and the dispatcher
// correctly refused a shift that genuinely was not active. It was refusing the wrong shift.
//
// That is why Phase 3A-iii could not reproduce it: every code path READS correctly, and the divergence
// depends on what `selectedShiftId` happened to be earlier in the session.
//
// ONE RULE, ONE SOURCE OF TRUTH
// Actions launched from Current Shift resolve their target here, from the same `currentHomeShift` the
// card displays. `selectedShift` keeps its job everywhere it is legitimate — Offers, History, the shift
// detail panel — and is no longer consulted for current-shift action eligibility.
//
// ELIGIBILITY USES ATTENDANCE, NOT JUST THE STATUS STRING
// If the Guard has booked on and not booked off, they are working, whatever the status column currently
// says. That is the same decision the backend makes in `classifyLiveOperation` and
// `needsGuardOperations`, and it means a lagging status string cannot lock a working Guard out of
// raising an incident.

/** The lifecycle statuses that mean the work is over. No action is raised against these. */
const SETTLED_STATUSES = new Set(['completed', 'cancelled', 'missed', 'rejected']);

export type ActionTargetShift = { id: number; status?: string | null } | null | undefined;

export type ActionTargetAttendance =
  | { checkInAt?: string | null; checkOutAt?: string | null }
  | null
  | undefined;

export type CurrentShiftActionTarget =
  /** Raise the action against this shift. `id` is what the request will carry. */
  | { eligible: true; shift: { id: number; status: string } }
  /** Nothing to raise an action against, and why. */
  | { eligible: false; reason: 'no_shift' | 'not_started' | 'settled' };

function lifecycle(status: string | null | undefined): string {
  return (status || '').trim().toLowerCase();
}

/**
 * The shift a Current Shift action must target, or the reason there is none.
 *
 * `shift` is the authoritative current shift — the same value the Current Shift card renders.
 * `attendance` is that shift's own attendance, which is what proves the Guard is actually on post.
 */
export function resolveCurrentShiftActionTarget(
  shift: ActionTargetShift,
  attendance: ActionTargetAttendance,
): CurrentShiftActionTarget {
  if (!shift) return { eligible: false, reason: 'no_shift' };

  const status = lifecycle(shift.status);
  const bookedOn = Boolean(attendance?.checkInAt);
  const bookedOff = Boolean(attendance?.checkOutAt);

  // Booked off ends it even if the status has not caught up yet.
  if (bookedOff) return { eligible: false, reason: 'settled' };
  if (SETTLED_STATUSES.has(status)) return { eligible: false, reason: 'settled' };

  // The normal live case, and the one the device showed.
  if (status === 'in_progress') {
    return { eligible: true, shift: { id: shift.id, status: 'in_progress' } };
  }

  // Attendance beats a lagging status string: a Guard who has booked on is working. The dispatcher is
  // told `in_progress` because that is what this state IS, and because its own precondition reads the
  // status — telling it anything else would reintroduce the divergence this module removes.
  if (bookedOn) {
    return { eligible: true, shift: { id: shift.id, status: 'in_progress' } };
  }

  // Assigned or offered but not on post yet.
  return { eligible: false, reason: 'not_started' };
}

/** Whether a Current Shift action can be raised at all. */
export function isCurrentShiftActionable(
  shift: ActionTargetShift,
  attendance: ActionTargetAttendance,
): boolean {
  return resolveCurrentShiftActionTarget(shift, attendance).eligible;
}

/**
 * The shift to hand to `dispatchGuardAction`, or null.
 *
 * Returning null rather than a non-live shift is deliberate: the dispatcher's own `no_active_shift`
 * precondition then reports the refusal, so there is exactly one place that decides an action is not
 * allowed and exactly one message for it.
 */
export function currentShiftActionShift(
  shift: ActionTargetShift,
  attendance: ActionTargetAttendance,
): { id: number; status: string } | null {
  const target = resolveCurrentShiftActionTarget(shift, attendance);
  return target.eligible ? target.shift : null;
}
