import { HttpException, HttpStatus } from '@nestjs/common';
import { AmendmentWarning, ShiftPolicyValues, assessFatigue } from '../shift-amendment/shift-amendment-policy';
import { MISSED_SHIFT_GRACE_MINUTES } from './shift-edit-policy';

/**
 * Replace Guard (owner-approved, 25 Oct 2026). A company moves a shift that has not started being worked from the
 * Guard who holds it to another Guard, as one atomic operation: the shift becomes a fresh offer to the replacement
 * (never accepted on their behalf, so it is not confirmed cover until they accept), the outgoing Guard is told it is no
 * longer theirs, and one audit entry records who changed it, from whom, to whom, and why. Pure rules only: no I/O here.
 *
 *   offered   → may be replaced until the shift's scheduled end (an offer may be accepted late; see
 *               offer-acceptance-window.ts)
 *   ready     → may be replaced until the shift's scheduled start; after it, only as a NO-SHOW: the request says so
 *               explicitly (noShow: true), the missed-shift grace (MISSED_SHIFT_GRACE_MINUTES, the rule Live
 *               Operations and "mark missed" use) has passed, the shift has not ended, and no attendance is recorded
 *               (checked under the shift row lock, so a concurrent Book On wins or loses cleanly)
 *   in_progress → refused: live attendance and Welfare Check evidence belong to the Guard who booked on. The safe
 *               route is Book Off (or Close without Book Off) and a new shift for the replacement.
 *   anything else (unfilled, rejected, missed, cancelled, completed) → refused: there is no Guard to replace, or the
 *               shift is part of the record. Unfilled and declined positions are filled through assignment.
 *   a marketplace hire (the shift carries an assignment or job application) → refused until the hire lifecycle has a
 *               designed treatment for a substitute (see the PR); nothing about the hire is ever overwritten.
 *
 * Eligibility of the replacement is what every other assignment path checks (an ACTIVE relationship, an active Guard
 * account, the company's compliance assessment, no approved leave, not marked unavailable, no overlapping committed
 * shift, repeated under the Guard's assignment lock), plus the fatigue and rest assessment of the replacement's
 * resulting schedule against the Live Shift Amendment thresholds (the company's policy, never looser than the platform
 * safety limits): over the maximum shift length or under the minimum rest is refused; over the approval threshold needs
 * an explicit acknowledgement by someone who may approve extensions; other warnings are returned and audited.
 *
 * Guards only ever see a neutral reason category. The free-text reason is required, and kept in the audit log only.
 */
export const REPLACEABLE_STATUSES: ReadonlySet<string> = new Set(['offered', 'ready']);

export const REPLACE_GUARD_AUDIT_ACTION = 'shift.guard_replaced';
/** The voidedReason written on an open Live Shift Amendment of the outgoing Guard. */
export const REPLACE_GUARD_VOID_REASON = 'guard_replaced';
export const REPLACE_GUARD_REASON_MAX_LENGTH = 500;
/** A no-show replacement is possible this long after the scheduled start: the existing missed-shift grace. */
export const NO_SHOW_GRACE_MINUTES = MISSED_SHIFT_GRACE_MINUTES;

/** The neutral reasons a Guard may be shown (owner decision). Small on purpose; nothing personal or judgemental. */
export const REPLACE_GUARD_REASON_CATEGORIES = {
  operational_change: 'Operational change',
  cover_rearranged: 'Cover rearranged',
  schedule_change: 'Schedule change',
} as const;
export type ReplaceGuardReasonCategory = keyof typeof REPLACE_GUARD_REASON_CATEGORIES;
export const REPLACE_GUARD_REASON_CATEGORY_KEYS = Object.keys(REPLACE_GUARD_REASON_CATEGORIES) as ReplaceGuardReasonCategory[];

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
  /** The replacement's shift would be longer than the maximum shift length. */
  FATIGUE_LIMIT: 'REPLACE_GUARD_FATIGUE_LIMIT',
  /** The replacement would not get the minimum rest before or after this shift. */
  MIN_REST: 'REPLACE_GUARD_MIN_REST',
  /** Over the approval threshold: resend with fatigueAcknowledged: true. */
  FATIGUE_ACKNOWLEDGEMENT_REQUIRED: 'REPLACE_GUARD_FATIGUE_ACKNOWLEDGEMENT_REQUIRED',
  /** Over the approval threshold, and the caller may not approve extensions (Owner / Admin may). */
  FATIGUE_APPROVER_REQUIRED: 'REPLACE_GUARD_FATIGUE_APPROVER_REQUIRED',
  IN_PROGRESS: 'REPLACE_GUARD_SHIFT_IN_PROGRESS',
  /** An accepted shift has started: replacing its Guard needs noShow: true. */
  NO_SHOW_CONFIRMATION_REQUIRED: 'REPLACE_GUARD_NO_SHOW_CONFIRMATION_REQUIRED',
  /** noShow: true before the missed-shift grace has passed. */
  NO_SHOW_TOO_EARLY: 'REPLACE_GUARD_NO_SHOW_TOO_EARLY',
  /** noShow: true on a shift that is not an accepted shift that has started. */
  NO_SHOW_NOT_APPLICABLE: 'REPLACE_GUARD_NO_SHOW_NOT_APPLICABLE',
  ENDED: 'REPLACE_GUARD_SHIFT_ENDED',
  NOT_REPLACEABLE: 'REPLACE_GUARD_STATUS_NOT_REPLACEABLE',
  /** The shift belongs to a marketplace hire (assignment / job application). */
  HIRE_LINKED: 'REPLACE_GUARD_HIRE_LINKED',
  ATTENDANCE_RECORDED: 'REPLACE_GUARD_ATTENDANCE_RECORDED',
  TIMESHEET_LOCKED: 'REPLACE_GUARD_TIMESHEET_LOCKED',
  /** The shift changed (accepted, booked on, edited, replaced) between being read and being locked. Reload and retry. */
  CHANGED: 'REPLACE_GUARD_SHIFT_CHANGED',
  REASON_REQUIRED: 'REPLACE_GUARD_REASON_REQUIRED',
} as const;
export type ReplaceGuardErrorCode = (typeof REPLACE_GUARD_ERROR_CODES)[keyof typeof REPLACE_GUARD_ERROR_CODES];

/** A refusal with a machine-readable code the web app can turn into words. */
export function replaceGuardError(status: HttpStatus, code: ReplaceGuardErrorCode, message: string, details?: Record<string, unknown>) {
  return new HttpException({ statusCode: status, code, message, ...(details ? { details } : {}) }, status);
}

/**
 * Why a shift in `status` cannot be replaced at `nowMs` (with or without the no-show confirmation), or null when it
 * can. Re-evaluated under the row lock on the database clock.
 */
export function replaceGuardStateRefusal(
  shift: { status: string; guardId: number | null; startMs: number; endMs: number },
  nowMs: number,
  noShow = false,
) {
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
  const startedAndAccepted = shift.status === 'ready' && nowMs >= shift.startMs;
  if (noShow && !startedAndAccepted) {
    return replaceGuardError(HttpStatus.UNPROCESSABLE_ENTITY, E.NO_SHOW_NOT_APPLICABLE,
      'A no-show applies only to an accepted shift that has started. Replace the Guard without it.');
  }
  if (startedAndAccepted) {
    if (!noShow) {
      return replaceGuardError(HttpStatus.CONFLICT, E.NO_SHOW_CONFIRMATION_REQUIRED,
        'This accepted shift has started. Confirm the Guard has not booked on (a no-show) to replace them.');
    }
    if (nowMs < shift.startMs + NO_SHOW_GRACE_MINUTES * 60_000) {
      return replaceGuardError(HttpStatus.CONFLICT, E.NO_SHOW_TOO_EARLY,
        `A Guard can be replaced as a no-show ${NO_SHOW_GRACE_MINUTES} minutes after the scheduled start.`);
    }
  }
  return null;
}

// ── Fatigue and rest of the replacement's resulting schedule ────────────────────────────────────────

export type ReplacementFatigueInput = {
  startMs: number;
  endMs: number;
  nowMs: number;
  /** The end of the replacement's latest committed or worked shift ending at or before this start (any company). */
  previousShiftEndMs: number | null;
  /** The start of their next committed shift after this one (any company). */
  nextShiftStartMs: number | null;
  /** Their scheduled hours in the 7 days ending at this shift's end, this shift included (any company). */
  sevenDayScheduledHours: number;
  policy: ShiftPolicyValues;
};

export type ReplacementFatigue = {
  basis: 'scheduled_hours';
  totalScheduledHours: number;
  restHoursBefore: number | null;
  restHoursAfter: number | null;
  sevenDayScheduledHours: number;
  warnings: AmendmentWarning[];
  approvalRequired: boolean;
  hardLimitExceeded: boolean;
  minRestViolated: boolean;
  thresholds: Omit<ShiftPolicyValues, 'amendmentsEnabled'>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The Live Shift Amendment assessment (assessFatigue, the same thresholds) applied to the replacement taking this whole
 * shift: its length, the rest after it, the rolling 7 days, and also the rest BEFORE it (an extension cannot change
 * that; a new assignment can). The last-minute warning is about extending a shift that is ending and does not apply.
 */
export function assessReplacementFatigue(input: ReplacementFatigueInput): ReplacementFatigue {
  const base = assessFatigue({
    startMs: input.startMs,
    currentEndMs: input.endMs,
    proposedEndMs: input.endMs,
    nowMs: input.nowMs,
    nextShiftStartMs: input.nextShiftStartMs,
    sevenDayScheduledHours: input.sevenDayScheduledHours,
    policy: input.policy,
  });
  const restHoursBefore = input.previousShiftEndMs === null ? null : round2((input.startMs - input.previousShiftEndMs) / 3_600_000);
  const shortBefore = restHoursBefore !== null && restHoursBefore < input.policy.minRestHours;
  const warnings = base.warnings.filter((w) => w !== 'LAST_MINUTE');
  if (shortBefore && !warnings.includes('SHORT_REST')) warnings.push('SHORT_REST');
  return {
    basis: 'scheduled_hours',
    totalScheduledHours: base.totalScheduledHours,
    restHoursBefore,
    restHoursAfter: base.restHoursBeforeNextShift,
    sevenDayScheduledHours: base.sevenDayScheduledHours,
    warnings,
    approvalRequired: base.approvalReasons.includes('LONG_SHIFT'),
    hardLimitExceeded: base.hardLimitExceeded,
    minRestViolated: shortBefore || base.approvalReasons.includes('SHORT_REST'),
    thresholds: base.thresholds,
  };
}

/**
 * What the company may see and what the audit keeps: a rest gap or 7-day total decided by another company's shift is
 * withheld (as Live Shift Amendments do), so no company learns another's schedule.
 */
export function companySafeReplacementFatigue(
  fa: ReplacementFatigue,
  ctx: { restBeforeOwnCompany: boolean; restAfterOwnCompany: boolean; companySevenDayScheduledHours: number },
) {
  const { restHoursBefore, restHoursAfter, sevenDayScheduledHours, ...rest } = fa;
  return {
    ...rest,
    restHoursBefore: ctx.restBeforeOwnCompany ? restHoursBefore : null,
    restHoursAfter: ctx.restAfterOwnCompany ? restHoursAfter : null,
    restFiguresWithheld: (!ctx.restBeforeOwnCompany && restHoursBefore !== null) || (!ctx.restAfterOwnCompany && restHoursAfter !== null),
    companySevenDayScheduledHours: round2(ctx.companySevenDayScheduledHours),
    sevenDayIncludesOtherWork: sevenDayScheduledHours > ctx.companySevenDayScheduledHours + 0.01,
  };
}
