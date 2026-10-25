import { HttpException, HttpStatus } from '@nestjs/common';
import { CompanyMembershipRole, CompanyPermission, hasPermission } from '../company-membership/company-membership-types';

/**
 * Live Shift Amendments (Phase 1, owner-approved 22 Oct 2026; a standard feature for every company since 25 Oct 2026,
 * within platform safety limits a company may tighten but never weaken). A company extends an IN-PROGRESS shift; the Guard
 * agrees in the app, or authorised staff record the Guard's verbal agreement. Pure rules only: no I/O here.
 *
 * Lifecycle:
 *   awaiting_approval ──approve──▶ pending ──accept / verbal──▶ accepted ──dispute──▶ disputed ──resolve──▶ dispute_upheld
 *          │                          │                                                             └──▶ dispute_corrected
 *          └──withdraw / expire / void┴──decline / withdraw / expire / void
 * A pending proposal never changes the shift. Only acceptance (in the app, or staff-recorded) moves shifts.end, and a
 * proposal expires at the shift's current effective end: there is no retrospective acceptance.
 */
export const AMENDMENT_STATUSES = [
  'awaiting_approval',
  'pending',
  'accepted',
  'declined',
  'withdrawn',
  'expired',
  'voided',
  'disputed',
  'dispute_upheld',
  'dispute_corrected',
] as const;
export type AmendmentStatus = (typeof AMENDMENT_STATUSES)[number];

/** Proposals that still hold the shift's single open slot (partial unique index UQ_shift_amendments_one_open). */
export const OPEN_AMENDMENT_STATUSES: readonly AmendmentStatus[] = ['awaiting_approval', 'pending'];
/** Statuses in which the extension is in force (shifts.end = agreedEnd). */
export const AGREED_AMENDMENT_STATUSES: readonly AmendmentStatus[] = ['accepted', 'disputed', 'dispute_upheld', 'dispute_corrected'];

export type AmendmentResponseMethod = 'guard_app' | 'staff_recorded_verbal';
export const VERBAL_CONTACT_METHODS = ['telephone', 'in_person', 'radio', 'other'] as const;
export type VerbalContactMethod = (typeof VERBAL_CONTACT_METHODS)[number];

/**
 * The outcome of a confirmation email attempt. Deliberately never "delivered": S4 only knows whether its provider
 * accepted the message (or, outside production, whether it was captured in the local outbox).
 */
export type ConfirmationEmailStatus = 'provider_accepted' | 'captured_outbox' | 'not_configured' | 'failed' | 'no_address';

export const AMENDMENT_ERROR_CODES = {
  DISABLED: 'SHIFT_AMENDMENTS_DISABLED',
  NOT_LIVE: 'SHIFT_AMENDMENT_NOT_LIVE',
  NOT_LATER: 'SHIFT_AMENDMENT_NOT_LATER',
  TOO_LATE: 'SHIFT_AMENDMENT_TOO_LATE',
  PENDING: 'SHIFT_AMENDMENT_PENDING',
  STALE: 'SHIFT_AMENDMENT_STALE',
  EXPIRED: 'SHIFT_AMENDMENT_EXPIRED',
  ALREADY_ANSWERED: 'SHIFT_AMENDMENT_ALREADY_ANSWERED',
  NOT_OPEN: 'SHIFT_AMENDMENT_NOT_OPEN',
  CLASH: 'SHIFT_AMENDMENT_CLASH',
  INELIGIBLE: 'SHIFT_AMENDMENT_GUARD_INELIGIBLE',
  FATIGUE_LIMIT: 'SHIFT_AMENDMENT_FATIGUE_LIMIT',
  POLICY_WEAKER_THAN_PLATFORM: 'SHIFT_POLICY_WEAKER_THAN_PLATFORM',
  APPROVAL_REQUIRED: 'SHIFT_AMENDMENT_APPROVAL_REQUIRED',
  SELF_APPROVAL_CONFIRMATION: 'SHIFT_AMENDMENT_SELF_APPROVAL_CONFIRMATION_REQUIRED',
  AGREED_TERMS_MISMATCH: 'SHIFT_AMENDMENT_AGREED_TERMS_MISMATCH',
  CONTACT_TIME_INVALID: 'SHIFT_AMENDMENT_CONTACT_TIME_INVALID',
  NOT_DISPUTABLE: 'SHIFT_AMENDMENT_NOT_DISPUTABLE',
  FORBIDDEN: 'SHIFT_AMENDMENT_FORBIDDEN',
  BUSY: 'SHIFT_AMENDMENT_BUSY',
  NOT_FOUND: 'SHIFT_AMENDMENT_NOT_FOUND',
} as const;
export type AmendmentErrorCode = (typeof AMENDMENT_ERROR_CODES)[keyof typeof AMENDMENT_ERROR_CODES];

/** A refusal with a machine-readable code the web and Guard apps can turn into words. */
export function amendmentError(status: HttpStatus, code: AmendmentErrorCode, message: string, details?: Record<string, unknown>) {
  return new HttpException({ statusCode: status, code, message, ...(details ? { details } : {}) }, status);
}

// ── Policy (company_shift_policies) ─────────────────────────────────────────────────────────────────

/**
 * Defaults (owner-approved D6). Planning safeguards on SCHEDULED hours; not legal limits. Amendments are a standard
 * feature: a company with no policy row has them, and only the S4 platform administrator can switch a company off (an
 * emergency control, recorded in that company's row).
 */
export const DEFAULT_SHIFT_POLICY = {
  amendmentsEnabled: true,
  fatigueWarningHours: 12,
  approvalRequiredHours: 14,
  hardLimitHours: 16 as number | null,
  minRestHours: 11,
  weeklyReviewHours: 48,
  lastMinuteWarningMinutes: 10,
};
export type ShiftPolicyValues = typeof DEFAULT_SHIFT_POLICY;
export type ShiftPolicyThresholds = Omit<ShiftPolicyValues, 'amendmentsEnabled'>;

/**
 * Platform safety limits: the loosest values any company may use. A company may make each one stricter (warn, require
 * approval and refuse sooner; demand more rest; review fewer weekly hours; warn earlier before the end), never looser.
 * They equal the defaults, so a company that has changed nothing is exactly at the limit.
 */
export const PLATFORM_SAFETY_LIMITS = {
  maxFatigueWarningHours: 12,
  maxApprovalRequiredHours: 14,
  maxHardLimitHours: 16,
  minMinRestHours: 11,
  maxWeeklyReviewHours: 48,
  minLastMinuteWarningMinutes: 10,
} as const;

export type PlatformSafetyViolation = { field: keyof ShiftPolicyThresholds; limit: number; message: string };

/** Each threshold looser than the platform allows, with the limit, in words a Control Room can act on. */
export function platformSafetyViolations(t: ShiftPolicyThresholds): PlatformSafetyViolation[] {
  const L = PLATFORM_SAFETY_LIMITS;
  const out: PlatformSafetyViolation[] = [];
  if (t.fatigueWarningHours > L.maxFatigueWarningHours) {
    out.push({ field: 'fatigueWarningHours', limit: L.maxFatigueWarningHours, message: `The fatigue warning cannot start later than ${L.maxFatigueWarningHours} hours.` });
  }
  if (t.approvalRequiredHours > L.maxApprovalRequiredHours) {
    out.push({ field: 'approvalRequiredHours', limit: L.maxApprovalRequiredHours, message: `Management approval cannot start later than ${L.maxApprovalRequiredHours} hours.` });
  }
  if (t.hardLimitHours === null || t.hardLimitHours > L.maxHardLimitHours) {
    out.push({ field: 'hardLimitHours', limit: L.maxHardLimitHours, message: `The maximum shift length cannot be removed or set above ${L.maxHardLimitHours} hours.` });
  }
  if (t.minRestHours < L.minMinRestHours) {
    out.push({ field: 'minRestHours', limit: L.minMinRestHours, message: `Minimum rest cannot be less than ${L.minMinRestHours} hours.` });
  }
  if (t.weeklyReviewHours > L.maxWeeklyReviewHours) {
    out.push({ field: 'weeklyReviewHours', limit: L.maxWeeklyReviewHours, message: `The weekly hours review cannot start above ${L.maxWeeklyReviewHours} hours.` });
  }
  if (t.lastMinuteWarningMinutes < L.minLastMinuteWarningMinutes) {
    out.push({ field: 'lastMinuteWarningMinutes', limit: L.minLastMinuteWarningMinutes, message: `The last-minute warning cannot be shorter than ${L.minLastMinuteWarningMinutes} minutes.` });
  }
  return out;
}

/**
 * The thresholds actually applied: the stricter of the company's value and the platform limit, field by field. A row
 * written before the limits existed, or edited outside the API, can therefore never loosen a safeguard.
 */
export function withinPlatformSafety(t: ShiftPolicyThresholds): ShiftPolicyThresholds {
  const L = PLATFORM_SAFETY_LIMITS;
  return {
    fatigueWarningHours: Math.min(t.fatigueWarningHours, L.maxFatigueWarningHours),
    approvalRequiredHours: Math.min(t.approvalRequiredHours, L.maxApprovalRequiredHours),
    hardLimitHours: t.hardLimitHours === null ? L.maxHardLimitHours : Math.min(t.hardLimitHours, L.maxHardLimitHours),
    minRestHours: Math.max(t.minRestHours, L.minMinRestHours),
    weeklyReviewHours: Math.min(t.weeklyReviewHours, L.maxWeeklyReviewHours),
    lastMinuteWarningMinutes: Math.max(t.lastMinuteWarningMinutes, L.minLastMinuteWarningMinutes),
  };
}

export type AmendmentWarning = 'LONG_SHIFT' | 'SHORT_REST' | 'WEEKLY_HOURS' | 'LAST_MINUTE';

export interface FatigueAssessment {
  basis: 'scheduled_hours';
  totalScheduledHours: number;
  restHoursBeforeNextShift: number | null;
  sevenDayScheduledHours: number;
  minutesToCurrentEnd: number;
  warnings: AmendmentWarning[];
  approvalRequired: boolean;
  approvalReasons: Array<'LONG_SHIFT' | 'SHORT_REST'>;
  complianceReviewRequired: boolean;
  hardLimitExceeded: boolean;
  thresholds: Omit<ShiftPolicyValues, 'amendmentsEnabled'>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The fatigue and working-time assessment of extending a shift to `proposedEndMs`. All figures are SCHEDULED
 * hours (never actual attendance), and the result is frozen into the amendment for audit.
 */
export function assessFatigue(input: {
  startMs: number;
  currentEndMs: number;
  proposedEndMs: number;
  nowMs: number;
  nextShiftStartMs: number | null;
  sevenDayScheduledHours: number;
  policy: ShiftPolicyValues;
}): FatigueAssessment {
  const { policy } = input;
  const totalScheduledHours = round2((input.proposedEndMs - input.startMs) / 3_600_000);
  const restHoursBeforeNextShift =
    input.nextShiftStartMs === null ? null : round2((input.nextShiftStartMs - input.proposedEndMs) / 3_600_000);
  const minutesToCurrentEnd = Math.floor((input.currentEndMs - input.nowMs) / 60_000);
  const warnings: AmendmentWarning[] = [];
  const approvalReasons: Array<'LONG_SHIFT' | 'SHORT_REST'> = [];

  if (totalScheduledHours > policy.fatigueWarningHours) warnings.push('LONG_SHIFT');
  if (totalScheduledHours > policy.approvalRequiredHours) approvalReasons.push('LONG_SHIFT');
  if (restHoursBeforeNextShift !== null && restHoursBeforeNextShift < policy.minRestHours) {
    warnings.push('SHORT_REST');
    approvalReasons.push('SHORT_REST');
  }
  const complianceReviewRequired = input.sevenDayScheduledHours > policy.weeklyReviewHours;
  if (complianceReviewRequired) warnings.push('WEEKLY_HOURS');
  if (minutesToCurrentEnd < policy.lastMinuteWarningMinutes) warnings.push('LAST_MINUTE');

  const { amendmentsEnabled: _ignored, ...thresholds } = policy;
  return {
    basis: 'scheduled_hours',
    totalScheduledHours,
    restHoursBeforeNextShift,
    sevenDayScheduledHours: round2(input.sevenDayScheduledHours),
    minutesToCurrentEnd,
    warnings,
    approvalRequired: approvalReasons.length > 0,
    approvalReasons,
    complianceReviewRequired,
    hardLimitExceeded: policy.hardLimitHours !== null && totalScheduledHours > policy.hardLimitHours,
    thresholds,
  };
}

// ── Who may do what ─────────────────────────────────────────────────────────────────────────────────

export type AmendmentAction = 'propose' | 'withdraw' | 'record_agreement' | 'approve' | 'resolve_dispute';

const ACTION_PERMISSION: Record<AmendmentAction, CompanyPermission> = {
  propose: CompanyPermission.SHIFTS_AMEND,
  withdraw: CompanyPermission.SHIFTS_AMEND,
  record_agreement: CompanyPermission.SHIFTS_AMEND_RECORD_AGREEMENT,
  approve: CompanyPermission.SHIFTS_AMEND_APPROVE,
  resolve_dispute: CompanyPermission.SHIFTS_AMEND_RESOLVE_DISPUTE,
};

/**
 * Owner and Admin hold every amendment permission; Operations may propose, withdraw and record agreement. A Control
 * Room member may propose, withdraw and record agreement ONLY when individually authorised (canAmendShifts), and that
 * authorisation grants nothing else: no shift editing, payroll, billing or compliance permission.
 */
export function mayPerformAmendmentAction(
  role: CompanyMembershipRole,
  canAmendShifts: boolean,
  action: AmendmentAction,
): boolean {
  if (hasPermission(role, ACTION_PERMISSION[action])) return true;
  return (
    role === CompanyMembershipRole.CONTROL_ROOM &&
    canAmendShifts &&
    (action === 'propose' || action === 'withdraw' || action === 'record_agreement')
  );
}

/** "YYYY-MM-DD HH:MM:SS.mmm" in UTC, for comparing and writing `timestamp` columns that store UTC wall time. */
export function toDbTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}
