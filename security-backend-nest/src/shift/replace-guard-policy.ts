import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Replace Guard (owner-approved, 25 Oct 2026). A company moves a shift that has not started being worked from the
 * Guard who holds it to another Guard, as one atomic operation: the shift becomes a fresh offer to the replacement
 * (never accepted on their behalf), the outgoing Guard is told it is no longer theirs, and one audit entry records
 * who changed it, from whom, to whom, and why. Pure rules only: no I/O here.
 *
 *   offered   → may be replaced until the shift's scheduled end (an offer may be accepted late; see
 *               offer-acceptance-window.ts)
 *   ready     → may be replaced until the shift's scheduled start (an accepted shift, before it is due to be worked)
 *   in_progress → refused: live attendance and Welfare Check evidence belong to the Guard who booked on. The safe
 *               route is Book Off (or Close without Book Off) and a new shift for the replacement.
 *   anything else (unfilled, rejected, missed, cancelled, completed) → refused: there is no Guard to replace, or the
 *               shift is part of the record. Unfilled and declined positions are filled through assignment.
 *
 * Eligibility of the replacement is exactly what every other assignment path checks (no new rules): an ACTIVE
 * relationship with the company, a Guard account that is active, the company's compliance assessment, no approved
 * leave, not marked unavailable, and no overlapping committed shift (repeated under the Guard's assignment lock).
 */
export const REPLACEABLE_STATUSES: ReadonlySet<string> = new Set(['offered', 'ready']);

export const REPLACE_GUARD_AUDIT_ACTION = 'shift.guard_replaced';
/** The voidedReason written on an open Live Shift Amendment of the outgoing Guard. */
export const REPLACE_GUARD_VOID_REASON = 'guard_replaced';
export const REPLACE_GUARD_REASON_MAX_LENGTH = 500;

export const REPLACE_GUARD_ERROR_CODES = {
  /** The replacement is the Guard who already holds the shift. */
  SAME_GUARD: 'REPLACE_GUARD_SAME_GUARD',
  /** No ACTIVE relationship with this company (also any Guard id the company cannot see). */
  NOT_LINKED: 'REPLACE_GUARD_NOT_LINKED',
  /** The company has blocked this Guard. */
  BLOCKED: 'REPLACE_GUARD_BLOCKED',
  /** The profile does not belong to a Guard account. */
  NOT_A_GUARD: 'REPLACE_GUARD_NOT_A_GUARD',
  ACCOUNT_INACTIVE: 'REPLACE_GUARD_ACCOUNT_INACTIVE',
  COMPLIANCE: 'REPLACE_GUARD_COMPLIANCE_BLOCKED',
  ON_LEAVE: 'REPLACE_GUARD_ON_LEAVE',
  UNAVAILABLE: 'REPLACE_GUARD_UNAVAILABLE',
  OVERLAP: 'REPLACE_GUARD_OVERLAPPING_SHIFT',
  IN_PROGRESS: 'REPLACE_GUARD_SHIFT_IN_PROGRESS',
  STARTED: 'REPLACE_GUARD_SHIFT_STARTED',
  ENDED: 'REPLACE_GUARD_SHIFT_ENDED',
  NOT_REPLACEABLE: 'REPLACE_GUARD_STATUS_NOT_REPLACEABLE',
  ATTENDANCE_RECORDED: 'REPLACE_GUARD_ATTENDANCE_RECORDED',
  TIMESHEET_LOCKED: 'REPLACE_GUARD_TIMESHEET_LOCKED',
  /** The shift changed (accepted, edited, replaced) between being read and being locked. Reload and try again. */
  CHANGED: 'REPLACE_GUARD_SHIFT_CHANGED',
  REASON_REQUIRED: 'REPLACE_GUARD_REASON_REQUIRED',
} as const;
export type ReplaceGuardErrorCode = (typeof REPLACE_GUARD_ERROR_CODES)[keyof typeof REPLACE_GUARD_ERROR_CODES];

/** A refusal with a machine-readable code the web app can turn into words. */
export function replaceGuardError(status: HttpStatus, code: ReplaceGuardErrorCode, message: string) {
  return new HttpException({ statusCode: status, code, message }, status);
}

/** Why a shift in `status` cannot be replaced at `nowMs`, or null when it can. Re-evaluated under the row lock. */
export function replaceGuardStateRefusal(shift: { status: string; guardId: number | null; startMs: number; endMs: number }, nowMs: number) {
  const E = REPLACE_GUARD_ERROR_CODES;
  if (shift.status === 'in_progress') {
    return replaceGuardError(HttpStatus.CONFLICT, E.IN_PROGRESS,
      'This shift is in progress. Its Guard must book off (or Control closes it without Book Off); then create a new shift for the replacement.');
  }
  if (!REPLACEABLE_STATUSES.has(shift.status) || !shift.guardId) {
    return replaceGuardError(HttpStatus.CONFLICT, E.NOT_REPLACEABLE,
      `This shift is ${shift.status.replace('_', ' ')}. Only an offered or accepted shift can have its Guard replaced.`);
  }
  if (nowMs >= shift.endMs) {
    return replaceGuardError(HttpStatus.CONFLICT, E.ENDED, 'This shift has already ended. Its Guard can no longer be replaced.');
  }
  if (shift.status === 'ready' && nowMs >= shift.startMs) {
    return replaceGuardError(HttpStatus.CONFLICT, E.STARTED,
      'This accepted shift has already started. Mark it missed if the Guard did not book on, then cover it with a new shift.');
  }
  return null;
}
