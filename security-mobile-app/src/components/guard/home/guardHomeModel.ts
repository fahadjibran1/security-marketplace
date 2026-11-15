// S4-UX-01 — the Adaptive Guard Home model. Pure: no React, no API, no clock of its own.
//
// It only CLASSIFIES what the screen already decided. The shift phase still comes from the screen's
// `deriveGuardShiftPhase` (backend Welfare status, shift status, times); the "can an action be raised"
// answer still comes from `currentShiftActionShift` (status + attendance). Nothing here orders Welfare
// against patrols or any other obligation: both are shown by the screen exactly as the backend and the
// patrol panel report them.

/** The phases `deriveGuardShiftPhase` returns. Kept in step with the screen's own union. */
export type GuardHomePhase =
  | 'no_shift'
  | 'offer_pending'
  | 'before_shift'
  | 'shift_window_check_in'
  | 'on_shift'
  | 'welfare_due'
  | 'welfare_overdue'
  | 'shift_ending_soon'
  | 'timesheet_pending'
  | 'shift_ended';

export type GuardHomeMode = 'on_duty' | 'off_duty';

/** Every phase in which the Guard is booked on. Book Off is offered in all of them, with the same prominence. */
export const ON_DUTY_PHASES: readonly GuardHomePhase[] = ['on_shift', 'welfare_due', 'welfare_overdue', 'shift_ending_soon'];

export const OFF_DUTY_PHASES: readonly GuardHomePhase[] = [
  'no_shift',
  'offer_pending',
  'before_shift',
  'shift_window_check_in',
  'timesheet_pending',
  'shift_ended',
];

/** Which Home the Guard sees. Total over every phase: an unknown value is treated as off duty. */
export function guardHomeMode(phase: GuardHomePhase): GuardHomeMode {
  return ON_DUTY_PHASES.includes(phase) ? 'on_duty' : 'off_duty';
}

/**
 * Whether the persistent on-duty bar (and its Emergency launcher) shows.
 *
 * Driven by the same action target the Emergency form submits against, so the bar is shown exactly when an
 * Emergency can be raised, on every Guard tab, and is never shown when the dispatcher would refuse it.
 */
export function showOnDutyBar(actionTarget: { id: number } | null | undefined): boolean {
  return Boolean(actionTarget);
}

export interface GuardHomeShiftLike {
  id: number;
  start: string;
  end: string;
  status?: string | null;
}

/**
 * Accepted (`ready`) shifts that have not ended, soonest first, at most `limit`.
 *
 * `normalize` is the screen's own status normaliser, passed in so this module never re-decides what a status
 * means. Offers, cancelled, rejected, live and finished shifts are never upcoming work.
 */
export function upcomingShifts<T extends GuardHomeShiftLike>(
  shifts: readonly T[],
  nowMs: number,
  normalize: (status?: string | null) => string,
  limit = 3,
): T[] {
  return shifts
    .filter((shift) => {
      if (normalize(shift.status) !== 'ready') return false;
      const endMs = new Date(shift.end).getTime();
      return Number.isFinite(endMs) && endMs > nowMs;
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, Math.max(0, limit));
}
