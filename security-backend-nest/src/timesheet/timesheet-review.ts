import { BadRequestException, HttpStatus } from '@nestjs/common';

/**
 * Timesheet review reasons and history (owner-approved, 28 Oct 2026). Pure: no I/O, no clock.
 *
 * Live pilot finding: a timesheet was returned with the company web's generic default ("Returned for correction by
 * company reviewer.") because no reason was required, so the Guard saw a status, not a reason. A return or a rejection
 * now needs a reason a Guard can act on, enforced here as well as in the web.
 *
 * The history is derived from the existing audit_logs timesheet.* entries (no migration). It is shown to the owning
 * Guard and the owning company, so it carries no ids: only what happened, when, who (the actor's role and display
 * name), the claimed hours, the approved minutes and the reason / note written at that step. Owner decision (28 Oct
 * 2026): the Guard may see the name of the company reviewer (their own company's staff); the Guard's own steps read
 * "You". The rows are already limited to one timesheet of one company, so no other Guard or company can appear.
 */

/** A return / reject reason needs at least this many non-space characters ("ok", "no" or "." is not a reason). */
export const TIMESHEET_REVIEW_REASON_MIN_CHARS = 5;
/** And at most this many characters (trimmed). */
export const TIMESHEET_REVIEW_REASON_MAX_CHARS = 500;

export const TIMESHEET_REVIEW_ERROR_CODES = {
  REASON_REQUIRED: 'TIMESHEET_REVIEW_REASON_REQUIRED',
  REASON_TOO_LONG: 'TIMESHEET_REVIEW_REASON_TOO_LONG',
} as const;

/**
 * The refusal for a return / reject reason, or null when the reason is acceptable. `decision` words the message.
 */
export function timesheetReviewReasonRefusal(raw: unknown, decision: 'returned' | 'rejected'): BadRequestException | null {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  const verb = decision === 'returned' ? 'returning a timesheet for correction' : 'rejecting a timesheet';
  // A BadRequestException (as before) whose body also carries a machine-readable code.
  if (reason.replace(/\s+/g, '').length < TIMESHEET_REVIEW_REASON_MIN_CHARS) {
    return new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      code: TIMESHEET_REVIEW_ERROR_CODES.REASON_REQUIRED,
      message: `A reason is required when ${verb} (at least ${TIMESHEET_REVIEW_REASON_MIN_CHARS} characters). The Guard sees it, so say what to correct.`,
    });
  }
  if (reason.length > TIMESHEET_REVIEW_REASON_MAX_CHARS) {
    return new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      code: TIMESHEET_REVIEW_ERROR_CODES.REASON_TOO_LONG,
      message: `The reason must be ${TIMESHEET_REVIEW_REASON_MAX_CHARS} characters or fewer.`,
    });
  }
  return null;
}

/** The in-app notice for the Guard after a return / reject, carrying the reason (in-app only; never pushed). */
export function timesheetDecisionNoticeMessage(decision: 'returned' | 'rejected', shiftRef: number, reason: string | null | undefined): string {
  const trimmed = (reason ?? '').trim();
  const quoted = trimmed ? ` Reason: "${trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed}"` : '';
  return decision === 'returned'
    ? `Your timesheet for shift #${shiftRef} was returned for correction.${quoted} Correct your hours or note and submit again.`
    : `Your timesheet for shift #${shiftRef} was rejected.${quoted}`;
}

// ─── history ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The audit actions the history is built from. */
export const TIMESHEET_HISTORY_AUDIT_ACTIONS = [
  'timesheet.submitted',
  'timesheet.returned',
  'timesheet.rejected',
  'timesheet.approved',
  'timesheet.approved_duration_overridden',
  'timesheet.company_approved_times_updated',
] as const;

export type TimesheetHistoryAction =
  | 'submitted'
  | 'resubmitted'
  | 'returned'
  | 'rejected'
  | 'approved'
  | 'approved_hours_overridden'
  | 'approved_times_updated';

export type TimesheetHistoryActorRole = 'guard' | 'company' | 'admin' | 'system';

export interface TimesheetHistoryItem {
  action: TimesheetHistoryAction;
  /** ISO instant the step was recorded. */
  at: string;
  actorRole: TimesheetHistoryActorRole;
  /**
   * Who did it, for display: a company reviewer's name; the Guard's name for the company, "You" for the Guard; null
   * when unknown (admin, system, or a user without a name).
   */
  actorName: string | null;
  /** A resubmission: the claim the Guard had submitted before (the one that was returned). Otherwise null. */
  claimedMinutesBefore: number | null;
  /** The Guard's claim submitted at this step, or the claim this decision was made on. */
  claimedMinutesAfter: number | null;
  /** An approval: the approved (payable) minutes. Otherwise null. */
  approvedMinutes: number | null;
  /** A return / reject: the reason given. An approval with different hours: the override reason. */
  reason: string | null;
  /** The Guard's note (submission) or the company note (decision) at this step. */
  note: string | null;
}

export interface TimesheetAuditRow {
  action: string;
  beforeData: Record<string, unknown> | null;
  afterData: Record<string, unknown> | null;
  createdAt: Date | string;
  /** The acting user's role (users.role), or null when the user is gone / a system write. */
  role: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export type TimesheetHistoryAudience = 'guard' | 'company';

const COMPANY_ROLES = new Set(['company', 'company_admin', 'company_staff']);

function actorRole(role: string | null): TimesheetHistoryActorRole {
  const r = String(role ?? '').trim().toLowerCase();
  if (r === 'guard') return 'guard';
  if (r === 'admin') return 'admin';
  if (COMPANY_ROLES.has(r)) return 'company';
  return 'system';
}

function displayName(row: TimesheetAuditRow): string | null {
  const name = [row.firstName, row.lastName].map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean).join(' ');
  return name ? name.slice(0, 120) : null;
}

function actorNameFor(row: TimesheetAuditRow, audience: TimesheetHistoryAudience): string | null {
  const role = actorRole(row.role);
  if (role === 'company') return displayName(row);
  if (role === 'guard') return audience === 'guard' ? 'You' : displayName(row);
  return null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t) return null;
  return t.length > 1000 ? `${t.slice(0, 997)}...` : t;
}

function minutesFromHours(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 60) : null;
}

function minutes(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function iso(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/** The claim recorded by a timesheet.submitted entry: hoursWorked when present (newer entries), else workedMinutes. */
function submittedClaimMinutes(after: Record<string, unknown>): number | null {
  return minutesFromHours(after.hoursWorked) ?? minutes(after.workedMinutes);
}

function approvedMinutesOf(after: Record<string, unknown>): number | null {
  return minutes(after.approvedMinutes) ?? minutesFromHours(after.approvedHours);
}

/**
 * The history list, oldest first, from the timesheet's audit rows (already filtered to this timesheet and company and
 * ordered by time). Whitelisted fields only: no ids, no e-mail or contact details.
 */
export function buildTimesheetHistory(rows: TimesheetAuditRow[], audience: TimesheetHistoryAudience): TimesheetHistoryItem[] {
  const items: TimesheetHistoryItem[] = [];
  let lastClaim: number | null = null;
  const approvalOverrideStamps = new Set<string>();
  for (const row of rows) {
    if (row.action === 'timesheet.approved') {
      const stamp = row.afterData?.overrideAt;
      if (stamp !== null && stamp !== undefined) approvalOverrideStamps.add(String(stamp));
    }
  }

  for (const row of rows) {
    const before = (row.beforeData ?? {}) as Record<string, unknown>;
    const after = (row.afterData ?? {}) as Record<string, unknown>;
    const base = { at: iso(row.createdAt), actorRole: actorRole(row.role), actorName: actorNameFor(row, audience) };
    switch (row.action) {
      case 'timesheet.submitted': {
        const claim = submittedClaimMinutes(after);
        const resubmitted = String(before.approvalStatus ?? '').toLowerCase() === 'returned';
        items.push({
          ...base,
          action: resubmitted ? 'resubmitted' : 'submitted',
          claimedMinutesBefore: resubmitted ? (lastClaim ?? minutesFromHours(before.hoursWorked)) : null,
          claimedMinutesAfter: claim,
          approvedMinutes: null,
          reason: null,
          note: text(after.guardNote),
        });
        if (claim !== null) lastClaim = claim;
        break;
      }
      case 'timesheet.returned':
      case 'timesheet.rejected':
        items.push({
          ...base,
          action: row.action === 'timesheet.returned' ? 'returned' : 'rejected',
          claimedMinutesBefore: null,
          claimedMinutesAfter: lastClaim,
          approvedMinutes: null,
          reason: text(after.rejectionReason),
          note: text(after.companyNote),
        });
        break;
      case 'timesheet.approved':
        items.push({
          ...base,
          action: 'approved',
          claimedMinutesBefore: null,
          claimedMinutesAfter: lastClaim,
          approvedMinutes: approvedMinutesOf(after),
          reason: text(after.overrideReason),
          note: text(after.companyNote),
        });
        break;
      case 'timesheet.approved_duration_overridden': {
        // Written beside timesheet.approved (same override stamp), which already carries the reason: shown once.
        const stamp = after.overrideAt;
        if (stamp !== null && stamp !== undefined && approvalOverrideStamps.has(String(stamp))) break;
        items.push({
          ...base,
          action: 'approved_hours_overridden',
          claimedMinutesBefore: null,
          claimedMinutesAfter: lastClaim,
          approvedMinutes: approvedMinutesOf(after),
          reason: text(after.overrideReason),
          note: null,
        });
        break;
      }
      case 'timesheet.company_approved_times_updated':
        items.push({
          ...base,
          action: 'approved_times_updated',
          claimedMinutesBefore: null,
          claimedMinutesAfter: lastClaim,
          approvedMinutes: approvedMinutesOf(after),
          reason: text(after.overrideReason),
          note: null,
        });
        break;
      default:
        break;
    }
  }
  return items;
}
