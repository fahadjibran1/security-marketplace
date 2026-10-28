/**
 * Timesheet review: return / reject reasons, the review history, and the payable-hours approval choice (owner-approved,
 * 28 Oct 2026). Pure: no I/O, no clock. Shared by the company web review panel and the Guard timesheet card.
 *
 *  - A return or a rejection needs a reason the Guard can act on (5–500 characters). There is no generic default:
 *    the server refuses an empty or token reason with TIMESHEET_REVIEW_REASON_REQUIRED.
 *  - The history (GET /timesheets/:id/history) keeps every submission, return, rejection and approval with its
 *    reason, so a reason stays visible after the Guard corrects and resubmits.
 *  - Approval says which hours are paid: the Guard's claim, the verified attendance, or other hours. Whenever the
 *    payable minutes differ from the verified attendance (or there is none), the server requires an override reason —
 *    including approving the Guard's own claim — so the panel asks for it before sending.
 */
import { formatMinutesHM, formatMinutesWithDecimal, hoursToMinutes } from './timesheetHours';

export const REVIEW_REASON_MIN_CHARS = 5;
export const REVIEW_REASON_MAX_CHARS = 500;

/** Why `text` is not an acceptable return / reject / override reason, or null when it is. */
export function reviewReasonProblem(text: string | null | undefined): string | null {
  const trimmed = (text ?? '').trim();
  if (trimmed.replace(/\s+/g, '').length < REVIEW_REASON_MIN_CHARS) {
    return `Enter a reason the Guard can act on (at least ${REVIEW_REASON_MIN_CHARS} characters).`;
  }
  if (trimmed.length > REVIEW_REASON_MAX_CHARS) return `Keep the reason to ${REVIEW_REASON_MAX_CHARS} characters or fewer.`;
  return null;
}

// ─── history ─────────────────────────────────────────────────────────────────────────────────────────────────

export type TimesheetHistoryAction =
  | 'submitted' | 'resubmitted' | 'returned' | 'rejected' | 'approved' | 'approved_hours_overridden' | 'approved_times_updated';

export interface TimesheetHistoryItem {
  action: TimesheetHistoryAction | string;
  at: string;
  actorRole: 'guard' | 'company' | 'admin' | 'system' | string;
  actorName?: string | null;
  claimedMinutesBefore: number | null;
  claimedMinutesAfter: number | null;
  approvedMinutes: number | null;
  reason: string | null;
  note: string | null;
}

export type ReviewAudience = 'guard' | 'company';

export interface HistoryLine {
  key: string;
  title: string;
  when: string;
  details: string[];
  tone: 'neutral' | 'warning' | 'danger' | 'success';
}

function actorLabel(item: TimesheetHistoryItem, audience: ReviewAudience): string {
  const name = item.actorName?.trim();
  if (item.actorRole === 'guard') return audience === 'guard' ? 'You' : name || 'Guard';
  if (item.actorRole === 'company') return name || (audience === 'guard' ? 'Your company' : 'Company reviewer');
  if (item.actorRole === 'admin') return 'S4 support';
  return 'System';
}

/** The history as display lines, oldest first. Unknown actions (a newer server) are skipped. */
export function historyLines(
  items: TimesheetHistoryItem[] | null | undefined,
  audience: ReviewAudience,
  formatWhen: (iso: string) => string,
): HistoryLine[] {
  const lines: HistoryLine[] = [];
  (items ?? []).forEach((item, index) => {
    const who = actorLabel(item, audience);
    const details: string[] = [];
    const claim = item.claimedMinutesAfter;
    let title: string;
    let tone: HistoryLine['tone'] = 'neutral';
    switch (item.action) {
      case 'submitted':
        title = `Submitted by ${who}`;
        if (claim !== null) details.push(`Claimed ${formatMinutesWithDecimal(claim)}`);
        break;
      case 'resubmitted':
        title = `Corrected and resubmitted by ${who}`;
        if (item.claimedMinutesBefore !== null && claim !== null && item.claimedMinutesBefore !== claim) {
          details.push(`Claim changed from ${formatMinutesHM(item.claimedMinutesBefore)} to ${formatMinutesWithDecimal(claim)}`);
        } else if (claim !== null) {
          details.push(`Claimed ${formatMinutesWithDecimal(claim)}${item.claimedMinutesBefore !== null ? ' (unchanged)' : ''}`);
        }
        break;
      case 'returned':
        title = `Returned for correction by ${who}`;
        tone = 'warning';
        if (claim !== null) details.push(`Claim returned: ${formatMinutesHM(claim)}`);
        break;
      case 'rejected':
        title = `Rejected by ${who}`;
        tone = 'danger';
        if (claim !== null) details.push(`Claim rejected: ${formatMinutesHM(claim)}`);
        break;
      case 'approved':
        title = `Approved by ${who}`;
        tone = 'success';
        if (item.approvedMinutes !== null) details.push(`Approved ${formatMinutesWithDecimal(item.approvedMinutes)}`);
        if (claim !== null && item.approvedMinutes !== null && claim !== item.approvedMinutes) details.push(`Claimed ${formatMinutesHM(claim)}`);
        break;
      case 'approved_hours_overridden':
      case 'approved_times_updated':
        title = `Approved hours changed by ${who}`;
        tone = 'success';
        if (item.approvedMinutes !== null) details.push(`Approved ${formatMinutesWithDecimal(item.approvedMinutes)}`);
        break;
      default:
        return;
    }
    if (item.reason) details.push(`Reason: ${item.reason}`);
    if (item.note) details.push(`${item.actorRole === 'guard' ? (audience === 'guard' ? 'Your note' : "Guard's note") : 'Company note'}: ${item.note}`);
    lines.push({ key: `${index}-${item.action}-${item.at}`, title, when: formatWhen(item.at), details, tone });
  });
  return lines;
}

// ─── the Guard's decision banner ─────────────────────────────────────────────────────────────────────────────

export interface DecisionBanner {
  tone: 'warning' | 'danger';
  title: string;
  reason: string;
  whatToDo: string;
}

/**
 * The banner at the top of a returned / rejected Guard card: who returned it, when, and why, then what to do. The
 * reviewer's name and time come from the latest matching history item when it has loaded; until then (or against an
 * older server) the company's name and the timesheet's reviewedAt.
 */
export function guardDecisionBanner(
  timesheet: { approvalStatus?: string | null; rejectionReason?: string | null; companyNote?: string | null; reviewedAt?: string | null; company?: { name?: string | null } | null },
  history: TimesheetHistoryItem[] | null | undefined,
  formatWhen: (iso: string) => string,
): DecisionBanner | null {
  const status = String(timesheet.approvalStatus ?? '').trim().toLowerCase();
  if (status !== 'returned' && status !== 'rejected') return null;
  const latest = [...(history ?? [])].reverse().find((item) => item.action === status) ?? null;
  const company = timesheet.company?.name?.trim() || 'your company';
  const reviewer = latest?.actorRole === 'company' && latest.actorName?.trim() ? `${latest.actorName.trim()} (${company})` : company;
  const at = latest?.at ?? timesheet.reviewedAt ?? null;
  const verb = status === 'returned' ? 'Returned' : 'Rejected';
  const reason = latest?.reason?.trim() || timesheet.rejectionReason?.trim() || 'No reason was given. Contact your office.';
  return {
    tone: status === 'returned' ? 'warning' : 'danger',
    title: `${verb} by ${reviewer}${at ? ` on ${formatWhen(at)}` : ''}`,
    reason,
    whatToDo: status === 'returned'
      ? 'What to do: correct your hours or note and submit again.'
      : 'This timesheet will not be paid as submitted. Contact your office if you think this is wrong.',
  };
}

// ─── payable-hours approval ──────────────────────────────────────────────────────────────────────────────────

export type ApprovalChoice = 'claimed' | 'verified' | 'other';

export interface ApprovalPlan {
  ok: boolean;
  /** Why it cannot be sent yet (shown under the buttons). */
  error: string | null;
  approvedMinutes: number | null;
  /** The server's rule: approved minutes ≠ verified minutes (or none verified) needs an override reason. */
  differsFromVerified: boolean;
  differsFromClaim: boolean;
  reasonRequired: boolean;
  /** The PATCH body (with approvalStatus 'approved'), when ok. */
  payload: { approvalStatus: 'approved'; approvedMinutes: number; overrideReason: string | null; companyNote: string | null; rejectionReason: null } | null;
}

/**
 * What approving with `choice` sends. claimedMinutes = the Guard's claim (Math.round(hoursWorked × 60)); verifiedMinutes
 * = the timesheet's verifiedMinutes (the server's approval default). A reason is required when the approved minutes
 * differ from the verified minutes (the server's override rule, including approving the claim), when they differ from
 * the Guard's claim (the Guard is told why), and always for "other hours". When only the claim differs the reason
 * goes in the company note (the server keeps no override reason when approved = verified).
 */
export function planApproval(input: {
  choice: ApprovalChoice;
  claimedHours: number | string | null | undefined;
  verifiedMinutes: number | null | undefined;
  otherMinutes?: number | null;
  reason?: string | null;
  companyNote?: string | null;
}): ApprovalPlan {
  const claimed = hoursToMinutes(input.claimedHours);
  const verified = input.verifiedMinutes === null || input.verifiedMinutes === undefined || !Number.isFinite(Number(input.verifiedMinutes))
    ? null : Math.round(Number(input.verifiedMinutes));
  const fail = (error: string, extra: Partial<ApprovalPlan> = {}): ApprovalPlan => ({
    ok: false, error, approvedMinutes: null, differsFromVerified: false, differsFromClaim: false, reasonRequired: false, payload: null, ...extra,
  });
  let minutes: number | null;
  if (input.choice === 'claimed') minutes = claimed;
  else if (input.choice === 'verified') minutes = verified;
  else minutes = input.otherMinutes ?? null;
  if (input.choice === 'verified' && verified === null) return fail('There is no verified attendance for this shift. Approve the claimed or other hours with a reason.');
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) {
    return fail(input.choice === 'other' ? 'Enter the hours and minutes to approve.' : 'There are no claimed hours to approve.');
  }
  const differsFromVerified = verified === null || minutes !== verified;
  const differsFromClaim = claimed === null || minutes !== claimed;
  const reasonRequired = differsFromVerified || differsFromClaim || input.choice === 'other';
  const reason = (input.reason ?? '').trim();
  const note = (input.companyNote ?? '').trim();
  const base = { approvedMinutes: minutes, differsFromVerified, differsFromClaim, reasonRequired };
  if (reasonRequired) {
    const problem = reviewReasonProblem(reason);
    if (problem) {
      const why = differsFromVerified
        ? verified === null
          ? 'There is no verified attendance for this shift, so a reason is required.'
          : `${formatMinutesHM(minutes)} differs from the verified ${formatMinutesHM(verified)}, so a reason is required.`
        : `${formatMinutesHM(minutes)} differs from the Guard's claim of ${formatMinutesHM(claimed)}, so a reason is required.`;
      return fail(`${why} ${problem}`, base);
    }
  }
  const companyNote = !differsFromVerified && reasonRequired
    ? note ? `${note}\nApproved hours: ${reason}` : reason
    : note || null;
  return {
    ok: true,
    error: null,
    ...base,
    payload: {
      approvalStatus: 'approved',
      approvedMinutes: minutes,
      overrideReason: differsFromVerified ? reason : null,
      companyNote,
      rejectionReason: null,
    },
  };
}
