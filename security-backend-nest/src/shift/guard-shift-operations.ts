// What a Guard is told about their own operational obligations. (Phase 3D, closing TECH-DEBT-OPS-02.)
//
// WHY THIS EXISTS
// The Guard app had its own Welfare timing: "last evidence + interval", anchored on whatever arrived
// last. The backend's engine uses a FIXED half-open window grid from the scheduled start, with a grace
// period, and the interval resolved as shift ?? site ?? 60. Those are different answers to the same
// question, so a Guard and their control room could disagree about whether a check was due — and the
// Guard, who is the one who has to act, had the weaker version.
//
// There is now one source of truth. `OperationsProjectionService` already computes this for the company
// board; the same projection, for the Guard's own shifts, is narrowed here and sent to the app. NO window
// arithmetic happens in this file and none happens on the client: this is a projection of a projection.
//
// WHY IT IS NARROWED RATHER THAN PASSED THROUGH
// The company view carries control-room material a Guard has no business receiving: the actionable
// Welfare ALERT raised against them (`welfareSummary`, including its acknowledgement state), the count of
// durable missed-window evidence rows (`welfareEvidenceCount`), and the missing-Book-Off exception
// (`missingBookOff`). Those exist for the company to act on. Sending a Guard a field saying an alert
// about them has been acknowledged is both outside what they need and a change in what the app is for.
//
// The Guard gets what they need to do the job: is a check owed, when is the next one, how are they doing,
// and the same for the Log Book.

import type { ShiftOperationsView } from '../coverage/operations-projection.service';

/** One window, as the engine resolved it. Instants; the client renders them in the site's zone. */
export type GuardOperationalWindowView = {
  index: number;
  start: string;
  end: string;
};

export type GuardWelfareView = {
  /** False when the shift has no Welfare obligation at all, so the app shows nothing rather than zero. */
  enabled: boolean;
  intervalMinutes: number | null;
  /**
   * The engine's own presentation status, unchanged: not_applicable, no_book_on, current, due, overdue,
   * missed, shift_complete. Passed through verbatim so the Guard and the board cannot diverge — mapping
   * it to a shorter set here is exactly how two surfaces start disagreeing.
   */
  status: ShiftOperationsView['welfare']['status'];
  currentWindow: GuardOperationalWindowView | null;
  lastWelfareAt: string | null;
  nextDueAt: string | null;
  overdueByMinutes: number | null;
  requiredCount: number;
  completedCount: number;
  missedCount: number;
  consecutiveMissed: number;
};

export type GuardLogBookView = {
  required: boolean;
  intervalMinutes: number | null;
  currentWindow: GuardOperationalWindowView | null;
  currentWindowSubmitted: boolean;
  lastEntryAt: string | null;
};

export type GuardShiftOperationsView = {
  /** The site's zone, so the app renders every instant above on the clock the Guard works to. */
  timezone: string;
  welfare: GuardWelfareView;
  logBook: GuardLogBookView;
};

/**
 * How far either side of now a Guard's shift still has operational information worth computing.
 *
 * Their shift list is every shift they have ever worked, and projecting a window grid for all of it would
 * be work nobody reads. 24 hours matches the post-end relevance the control room uses, so the two
 * surfaces stop caring about a shift at the same time.
 */
export const GUARD_OPERATIONS_WINDOW_HOURS = 24;

/**
 * Whether this shift is worth projecting.
 *
 * An in_progress shift ALWAYS is, whatever its scheduled end says: a shift still marked in progress long
 * after it should have finished is the exception the Guard most needs to see, and ageing it out would
 * hide it.
 */
export function needsGuardOperations(
  shift: { status?: string | null; start: Date | string; end: Date | string },
  now: Date,
): boolean {
  if ((shift.status || '').trim().toLowerCase() === 'in_progress') return true;

  const start = new Date(shift.start).getTime();
  const end = new Date(shift.end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;

  const reach = GUARD_OPERATIONS_WINDOW_HOURS * 3_600_000;
  const nowMs = now.getTime();
  return nowMs >= start - reach && nowMs <= end + reach;
}

/**
 * Narrow the company projection to what the Guard receives.
 *
 * Every value is copied across unchanged. Nothing is recomputed, rounded or re-derived, so a difference
 * between what a Guard sees and what their control room sees can only come from a different `now`.
 */
export function toGuardShiftOperations(
  operations: ShiftOperationsView | null | undefined,
): GuardShiftOperationsView | null {
  if (!operations) return null;

  return {
    timezone: operations.timezone,
    welfare: {
      enabled: operations.welfare.enabled,
      intervalMinutes: operations.welfare.intervalMinutes,
      status: operations.welfare.status,
      currentWindow: operations.welfare.currentWindow,
      lastWelfareAt: operations.welfare.lastWelfareAt,
      nextDueAt: operations.welfare.nextDueAt,
      overdueByMinutes: operations.welfare.overdueByMinutes,
      requiredCount: operations.welfare.requiredCount,
      completedCount: operations.welfare.completedCount,
      missedCount: operations.welfare.missedCount,
      consecutiveMissed: operations.welfare.consecutiveMissed,
    },
    logBook: {
      required: operations.logBook.required,
      intervalMinutes: operations.logBook.intervalMinutes,
      currentWindow: operations.logBook.currentWindow,
      currentWindowSubmitted: operations.logBook.currentWindowSubmitted,
      lastEntryAt: operations.logBook.lastEntryAt,
    },
  };
}

/** The control-room-only fields a Guard must never receive, named so a test can assert their absence. */
export const COMPANY_ONLY_OPERATIONS_FIELDS: readonly string[] = [
  'welfareSummary',
  'welfareEvidenceCount',
  'missingBookOff',
  'bookOnAt',
  'bookOffAt',
];
