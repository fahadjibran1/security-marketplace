// Live Shift Amendments — the client side of the rules the API enforces. (S4 Live Shift Amendments Phase 2.)
// Pure, so permissions, eligibility, validation, warnings, wording and history are executed by the spec suite.
//
// The API is the authority. This only decides which controls to OFFER, previews what the API will assess using
// the company policy the API returned (never hard-coded thresholds), refuses an incomplete form before it is sent,
// and turns the API's answers into words. Nothing here ever changes a shift on its own.

import { formatSiteDateInput, formatUkDateTime, siteLocalToInstant } from '../../services/siteTime';
import type {
  AmendmentStatus, AmendmentWarning, ConfirmationEmailStatus, ShiftAmendment, ShiftAmendmentList, ShiftPolicy, VerbalContactMethod,
} from '../../types/models';

export type {
  AmendmentStatus, AmendmentWarning, ConfirmationEmailStatus, ShiftAmendment, ShiftAmendmentList, ShiftPolicy, VerbalContactMethod,
};

// ─── contract (mirrors security-backend-nest/src/shift-amendment) ───────────────────────────────────────

export const AMENDMENT_STATUSES = [
  'awaiting_approval', 'pending', 'accepted', 'declined', 'withdrawn', 'expired', 'voided',
  'disputed', 'dispute_upheld', 'dispute_corrected',
] as const;
export const OPEN_AMENDMENT_STATUSES: readonly AmendmentStatus[] = ['awaiting_approval', 'pending'];
/** The extension is in force (the shift's end is the agreed end). */
export const AGREED_AMENDMENT_STATUSES: readonly AmendmentStatus[] = ['accepted', 'disputed', 'dispute_upheld', 'dispute_corrected'];


export const VERBAL_CONTACT_METHOD_OPTIONS = [
  { value: 'telephone', label: 'Telephone' },
  { value: 'in_person', label: 'In person' },
  { value: 'radio', label: 'Radio' },
  { value: 'other', label: 'Other' },
] as const;

/** The API's text limits (ProposeAmendmentDto, ApproveAmendmentDto, RecordVerbalAgreementDto, ResolveDisputeDto). */
export const AMENDMENT_TEXT_MAX = 500;
export const AMENDMENT_REASON_MIN = 3;
export const VERBAL_CONFIRMATION_MIN = 10;

// ─── who may do what ──────────────────────────────────────────────────────────────────────────────────

export interface AmendmentPermissions {
  canPropose: boolean;
  canWithdraw: boolean;
  canRecordAgreement: boolean;
  canApprove: boolean;
  canResolveDispute: boolean;
  /** Any amendment action at all: whether to show the "Shift extension" entry point. */
  any: boolean;
}

/**
 * From the session's companyPermissions (shifts.amend, shifts.amend.record_agreement, shifts.amend.approve,
 * shifts.amend.resolve_dispute). A Control Room member's individual authorisation arrives in that same list.
 * A session without the list (issued before memberships) falls back to the legacy owner roles, which hold every
 * amendment permission. Display only: the API re-checks every action.
 */
export function resolveAmendmentPermissions(companyPermissions: string[] | undefined | null, role: string | undefined | null): AmendmentPermissions {
  const legacyOwner = role === 'company_admin' || role === 'company';
  const has = (p: string) => (companyPermissions ? companyPermissions.includes(p) : legacyOwner);
  const canPropose = has('shifts.amend');
  const canRecordAgreement = has('shifts.amend.record_agreement');
  const canApprove = has('shifts.amend.approve');
  const canResolveDispute = has('shifts.amend.resolve_dispute');
  return {
    canPropose,
    canWithdraw: canPropose,
    canRecordAgreement,
    canApprove,
    canResolveDispute,
    any: canPropose || canRecordAgreement || canApprove || canResolveDispute,
  };
}

// ─── eligibility ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether a shift can be extended now: in progress, a Book On and no Book Off, and its current end not yet
 * reached. The API makes the same checks under lock; this only decides whether to offer the action.
 */
export function isEligibleForExtension(
  shift: { status?: string | null; end: string },
  attendance: { checkInAt?: string | null; checkOutAt?: string | null } | null | undefined,
  nowMs: number,
): boolean {
  if ((shift.status || '').trim().toLowerCase() !== 'in_progress') return false;
  if (!attendance?.checkInAt || attendance.checkOutAt) return false;
  const endMs = Date.parse(shift.end);
  return Number.isFinite(endMs) && endMs > nowMs;
}

/** Why an in-progress shift cannot be extended right now, in words (null when it can). */
export function extensionIneligibleReason(
  shift: { status?: string | null; end: string },
  attendance: { checkInAt?: string | null; checkOutAt?: string | null } | null | undefined,
  nowMs: number,
): string | null {
  if ((shift.status || '').trim().toLowerCase() !== 'in_progress') return 'Only a shift in progress can be extended.';
  if (!attendance?.checkInAt) return 'The Guard must be booked on before the shift can be extended.';
  if (attendance.checkOutAt) return 'The Guard has booked off. The shift can no longer be extended.';
  if (!(Date.parse(shift.end) > nowMs)) return 'The shift has reached its scheduled end. It can no longer be extended.';
  return null;
}

export function isOpen(a: Pick<ShiftAmendment, 'status' | 'effectiveStatus'>): boolean {
  return OPEN_AMENDMENT_STATUSES.includes(a.status) && a.effectiveStatus !== 'expired';
}

/** The proposal still waiting for a decision, if any (at most one, by the API's unique index). */
export function openAmendment(list: ShiftAmendment[] | null | undefined): ShiftAmendment | null {
  return (list ?? []).find((a) => isOpen(a)) ?? null;
}

/** The latest disputed extension waiting for an Owner/Admin review, if any. */
export function disputedAmendment(list: ShiftAmendment[] | null | undefined): ShiftAmendment | null {
  return [...(list ?? [])].reverse().find((a) => a.status === 'disputed') ?? null;
}

// ─── the proposed end ─────────────────────────────────────────────────────────────────────────────────

export const QUICK_EXTENSION_MINUTES = [30, 60, 120, 180, 240] as const;

export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  if (r === 0) return h === 1 ? '1 hour' : `${h} hours`;
  return `${h} h ${r} min`;
}

/**
 * A site-local "HH:MM" as the new end: on the current end's site-local day, or the next day when that time is not
 * after the current end (an extension runs forward, so 01:00 after a 23:00 end is tomorrow). Calendar days, never
 * +24h, so a clock-change night resolves correctly.
 */
export function resolveProposedEnd(currentEndIso: string, time: string, timeZone: string):
  { ok: true; iso: string; ms: number } | { ok: false; message: string } {
  if (!/^\d{2}:\d{2}$/.test(String(time ?? '').trim())) return { ok: false, message: 'Enter the new end as a 24-hour time, e.g. 21:30.' };
  const currentMs = Date.parse(currentEndIso);
  const day = formatSiteDateInput(currentEndIso, timeZone);
  const sameDay = siteLocalToInstant(day, time.trim(), timeZone);
  if (sameDay.ok && sameDay.instant > currentMs) return { ok: true, iso: new Date(sameDay.instant).toISOString(), ms: sameDay.instant };
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!d) return { ok: false, message: 'Enter the new end as a 24-hour time, e.g. 21:30.' };
  const next = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + 1));
  const nextDay = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  const nextResult = siteLocalToInstant(nextDay, time.trim(), timeZone);
  if (!nextResult.ok) return { ok: false, message: nextResult.message };
  return { ok: true, iso: new Date(nextResult.instant).toISOString(), ms: nextResult.instant };
}

export interface ExtensionPreview {
  additionalMinutes: number;
  totalScheduledHours: number;
  /** Warnings the client can already see from this shift alone, using the company's policy values. */
  warnings: AmendmentWarning[];
  approvalRequired: boolean;
  hardLimitExceeded: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What the API will say about the length of this extension, from the policy the API returned. Rest before the
 * Guard's next shift and their 7-day hours need the Guard's other shifts, which only the API sees: those are
 * assessed when the proposal is sent and shown from the API's answer.
 */
export function previewExtension(input: { startIso: string; currentEndIso: string; proposedEndMs: number; nowMs: number; policy: ShiftPolicy }): ExtensionPreview {
  const startMs = Date.parse(input.startIso);
  const currentEndMs = Date.parse(input.currentEndIso);
  const totalScheduledHours = round2((input.proposedEndMs - startMs) / 3_600_000);
  const warnings: AmendmentWarning[] = [];
  if (totalScheduledHours > input.policy.fatigueWarningHours) warnings.push('LONG_SHIFT');
  if (Math.floor((currentEndMs - input.nowMs) / 60_000) < input.policy.lastMinuteWarningMinutes) warnings.push('LAST_MINUTE');
  return {
    additionalMinutes: Math.round((input.proposedEndMs - currentEndMs) / 60_000),
    totalScheduledHours,
    warnings,
    approvalRequired: totalScheduledHours > input.policy.approvalRequiredHours,
    hardLimitExceeded: input.policy.hardLimitHours !== null && totalScheduledHours > input.policy.hardLimitHours,
  };
}

export function warningText(w: AmendmentWarning, policy: ShiftPolicy | null, values?: {
  totalScheduledHours?: number | null; restHoursBeforeNextShift?: number | null; sevenDayScheduledHours?: number | null;
}): string {
  const hrs = (n: number | null | undefined) => (n === null || n === undefined ? '' : ` (${round2(n)} h)`);
  switch (w) {
    case 'LONG_SHIFT':
      return `Long shift: more than ${policy?.fatigueWarningHours ?? '—'} scheduled hours${hrs(values?.totalScheduledHours)}.`;
    case 'SHORT_REST':
      return `Short rest: less than ${policy?.minRestHours ?? '—'} hours before the Guard's next shift${hrs(values?.restHoursBeforeNextShift)}. Management approval is required.`;
    case 'WEEKLY_HOURS':
      return `7-day hours: more than ${policy?.weeklyReviewHours ?? '—'} scheduled hours in the last 7 days${hrs(values?.sevenDayScheduledHours)}. Flagged for compliance review.`;
    case 'LAST_MINUTE':
      return `Last minute: the shift ends within ${policy?.lastMinuteWarningMinutes ?? '—'} minutes. The Guard may not see the request in time.`;
    default:
      return String(w);
  }
}

/** The policy, in words, for the drawer's "Company limits" line. Values come from the API, never from here. */
export function policySummary(policy: ShiftPolicy): string {
  const hard = policy.hardLimitHours === null ? 'no hard limit' : `not allowed over ${policy.hardLimitHours} h`;
  return `Warning over ${policy.fatigueWarningHours} h · approval over ${policy.approvalRequiredHours} h · ${hard} · `
    + `rest under ${policy.minRestHours} h needs approval · 7-day review over ${policy.weeklyReviewHours} h `
    + `(scheduled hours; ${policy.source === 'company' ? 'company policy' : 'S4 default policy'})`;
}

// ─── form validation ──────────────────────────────────────────────────────────────────────────────────

type Check = { ok: true } | { ok: false; message: string };

export function validateProposal(input: {
  currentEndMs: number; proposedEndMs: number | null; reason: string; nowMs: number; preview: ExtensionPreview | null; policy: ShiftPolicy | null;
}): Check {
  if (!input.policy?.amendmentsEnabled) return { ok: false, message: 'Shift extensions are not enabled for this company.' };
  if (!(input.currentEndMs > input.nowMs)) return { ok: false, message: 'The shift has reached its scheduled end. It can no longer be extended.' };
  if (input.proposedEndMs === null || !Number.isFinite(input.proposedEndMs)) return { ok: false, message: 'Choose the new end time.' };
  if (!(input.proposedEndMs > input.currentEndMs)) return { ok: false, message: 'The new end must be later than the current end of the shift.' };
  if (input.preview?.hardLimitExceeded) {
    return { ok: false, message: `This would make the shift ${input.preview.totalScheduledHours} scheduled hours, over the company limit of ${input.policy.hardLimitHours} hours.` };
  }
  const reason = input.reason.trim();
  if (reason.length < AMENDMENT_REASON_MIN) return { ok: false, message: 'Give the reason for the extension.' };
  if (input.reason.length > AMENDMENT_TEXT_MAX) return { ok: false, message: `Keep the reason under ${AMENDMENT_TEXT_MAX} characters.` };
  return { ok: true };
}

export function validateApproval(input: { statement: string; selfApproval: boolean; confirmSelfApproval: boolean }): Check {
  if (input.statement.trim().length < AMENDMENT_REASON_MIN) return { ok: false, message: 'Record why you are approving this extension.' };
  if (input.statement.length > AMENDMENT_TEXT_MAX) return { ok: false, message: `Keep the statement under ${AMENDMENT_TEXT_MAX} characters.` };
  if (input.selfApproval && !input.confirmSelfApproval) return { ok: false, message: 'You proposed this extension. Confirm that you are approving your own proposal.' };
  return { ok: true };
}

export function validateWithdrawal(input: { reason: string }): Check {
  if (input.reason.length > AMENDMENT_TEXT_MAX) return { ok: false, message: `Keep the reason under ${AMENDMENT_TEXT_MAX} characters.` };
  return { ok: true };
}

/**
 * A staff-recorded verbal agreement. The agreed terms are the proposal's own (the API refuses anything else), the
 * contact time is after the proposal and not in the future, and the person recording it confirms the Guard agreed.
 */
export function validateVerbalAgreement(input: {
  contactMethod: string | null; contactAtMs: number | null; proposedAtMs: number; nowMs: number;
  confirmation: string; reason: string; termsConfirmed: boolean;
}): Check {
  if (!input.contactMethod || !VERBAL_CONTACT_METHOD_OPTIONS.some((o) => o.value === input.contactMethod)) {
    return { ok: false, message: 'Choose how you contacted the Guard.' };
  }
  if (input.contactAtMs === null || !Number.isFinite(input.contactAtMs)) return { ok: false, message: 'Enter the time you spoke to the Guard.' };
  if (input.contactAtMs < input.proposedAtMs || input.contactAtMs > input.nowMs + 60_000) {
    return { ok: false, message: 'The contact time must be after the extension was proposed and not in the future.' };
  }
  if (input.confirmation.trim().length < VERBAL_CONFIRMATION_MIN) {
    return { ok: false, message: `Describe what the Guard agreed to (at least ${VERBAL_CONFIRMATION_MIN} characters).` };
  }
  if (input.confirmation.length > AMENDMENT_TEXT_MAX) return { ok: false, message: `Keep the confirmation under ${AMENDMENT_TEXT_MAX} characters.` };
  if (input.reason.trim().length < AMENDMENT_REASON_MIN) return { ok: false, message: 'Give the reason for the extension.' };
  if (input.reason.length > AMENDMENT_TEXT_MAX) return { ok: false, message: `Keep the reason under ${AMENDMENT_TEXT_MAX} characters.` };
  if (!input.termsConfirmed) return { ok: false, message: 'Confirm that the Guard agreed to these exact terms.' };
  return { ok: true };
}

/**
 * The contact time as typed in site-local "HH:MM": today at the site, or yesterday when that would be in the future
 * (a call just before midnight recorded just after it).
 */
export function resolveContactTime(time: string, nowMs: number, timeZone: string): { ok: true; ms: number; iso: string } | { ok: false; message: string } {
  if (!/^\d{2}:\d{2}$/.test(String(time ?? '').trim())) return { ok: false, message: 'Enter the contact time as a 24-hour time, e.g. 21:05.' };
  const today = formatSiteDateInput(new Date(nowMs).toISOString(), timeZone);
  const r = siteLocalToInstant(today, time.trim(), timeZone);
  if (r.ok && r.instant <= nowMs + 60_000) return { ok: true, ms: r.instant, iso: new Date(r.instant).toISOString() };
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!d) return { ok: false, message: 'Enter the contact time as a 24-hour time, e.g. 21:05.' };
  const prev = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) - 1));
  const prevDay = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
  const y = siteLocalToInstant(prevDay, time.trim(), timeZone);
  if (!y.ok) return { ok: false, message: y.message };
  return { ok: true, ms: y.instant, iso: new Date(y.instant).toISOString() };
}

export function validateDisputeResolution(input: { resolution: string | null; note: string }): Check {
  if (input.resolution !== 'upheld' && input.resolution !== 'corrected') return { ok: false, message: 'Choose whether the recorded agreement stands or needs correcting.' };
  if (input.note.trim().length < AMENDMENT_REASON_MIN) return { ok: false, message: 'Record what you found.' };
  if (input.note.length > AMENDMENT_TEXT_MAX) return { ok: false, message: `Keep the note under ${AMENDMENT_TEXT_MAX} characters.` };
  return { ok: true };
}

// ─── status in words ──────────────────────────────────────────────────────────────────────────────────

export function amendmentStatusLabel(a: Pick<ShiftAmendment, 'status' | 'effectiveStatus' | 'staffReported'>): string {
  const s = a.effectiveStatus === 'expired' ? 'expired' : a.status;
  switch (s) {
    case 'awaiting_approval': return 'Waiting for management approval';
    case 'pending': return "Waiting for the Guard's answer";
    case 'accepted': return a.staffReported ? 'Agreed verbally (recorded by staff)' : 'Accepted by the Guard in the app';
    case 'declined': return 'Declined by the Guard';
    case 'withdrawn': return 'Withdrawn';
    case 'expired': return 'Expired — shift end unchanged';
    case 'voided': return 'Cancelled — the Guard booked off';
    case 'disputed': return 'Disputed by the Guard — awaiting review';
    case 'dispute_upheld': return 'Dispute reviewed — agreement stands';
    case 'dispute_corrected': return 'Dispute reviewed — correction required';
    default: return String(s);
  }
}

/**
 * Why management approval is (or will be) needed, in words with the policy's own threshold — so nobody has to infer
 * it from a "long shift" warning. From the preview (before sending) or a stored amendment (after).
 */
export function approvalReasonText(input: {
  totalScheduledHours: number | null; warnings: AmendmentWarning[]; approvalRequired: boolean;
}, policy: ShiftPolicy | null): string | null {
  if (!input.approvalRequired) return null;
  const reasons: string[] = [];
  if (policy && input.totalScheduledHours !== null && input.totalScheduledHours > policy.approvalRequiredHours) {
    reasons.push(`the shift would be ${input.totalScheduledHours} scheduled hours, over the ${policy.approvalRequiredHours}-hour approval threshold`);
  }
  if (input.warnings.includes('SHORT_REST')) {
    reasons.push(`the Guard would have less than ${policy?.minRestHours ?? '—'} hours' rest before their next shift`);
  }
  if (reasons.length === 0) reasons.push('the company policy requires it');
  return `Owner or Admin approval needed before the Guard is asked: ${reasons.join('; and ')}.`;
}

/**
 * A disputed extension on this shift still waiting for review. Proposing again is allowed, but the person should see
 * it first and say they have.
 */
export function unresolvedDisputeWarning(list: ShiftAmendment[] | null | undefined): string | null {
  const d = disputedAmendment(list);
  if (!d) return null;
  return `Extension #${d.sequence} on this shift is disputed by the Guard and not yet reviewed ("${d.disputeReason ?? '—'}"). An Owner or Admin should review it before the shift is extended again.`;
}

export function approvalStatusText(a: ShiftAmendment): string {
  if (!a.approvalRequired) return 'Not required';
  if (a.approvedAt) return a.selfApproved ? 'Approved (by the proposer, confirmed)' : 'Approved';
  if (a.status === 'awaiting_approval' && a.effectiveStatus !== 'expired') return 'Required — waiting for an Owner or Admin';
  return 'Required — not approved';
}

/**
 * The Guard's answer. A staff-recorded verbal agreement is said to be exactly that — never an electronic
 * acceptance by the Guard.
 */
export function guardResponseText(a: ShiftAmendment): string {
  if (a.effectiveStatus === 'expired' && OPEN_AMENDMENT_STATUSES.includes(a.status)) return 'No answer before the deadline';
  switch (a.status) {
    case 'awaiting_approval': return 'Not yet asked — needs management approval first';
    case 'pending': return 'Waiting for the Guard to answer in the app';
    case 'declined': return 'Declined in the app';
    case 'withdrawn': return 'Not needed — proposal withdrawn';
    case 'expired': return 'No answer before the deadline';
    case 'voided': return 'Not needed — the Guard booked off';
    default:
      if (a.responseMethod === 'staff_recorded_verbal') return 'Verbal agreement reported by staff — not an electronic acceptance by the Guard';
      if (a.responseMethod === 'guard_app') return 'Accepted by the Guard in the S4 app';
      return '—';
  }
}

/** What S4 knows about the confirmation email: never "delivered", only what the provider told us. */
export function confirmationEmailText(status: ConfirmationEmailStatus | null | undefined): string {
  switch (status) {
    case 'provider_accepted': return 'Confirmation email accepted by the email provider (delivery not confirmed)';
    case 'captured_outbox': return 'Confirmation email captured in the test outbox — not sent to the Guard';
    case 'not_configured': return 'Confirmation email not sent — email is not configured';
    case 'failed': return 'Confirmation email failed to send';
    case 'no_address': return 'Confirmation email not sent — the Guard has no email address';
    default: return 'No confirmation email attempted';
  }
}

export function voidedReasonText(reason: string | null | undefined): string {
  if (reason === 'booked_off') return 'the Guard booked off';
  return reason ? reason.replace(/_/g, ' ') : 'cancelled by S4';
}

// ─── errors ───────────────────────────────────────────────────────────────────────────────────────────

export interface AmendmentErrorGuidance {
  message: string;
  /** The shift or proposal changed under us: reload before anything else. */
  reload: boolean;
  /** Safe to try the same request again shortly. */
  retryable: boolean;
}

const RELOAD_CODES = new Set([
  'SHIFT_AMENDMENT_STALE', 'SHIFT_AMENDMENT_EXPIRED', 'SHIFT_AMENDMENT_ALREADY_ANSWERED', 'SHIFT_AMENDMENT_NOT_OPEN',
  'SHIFT_AMENDMENT_PENDING', 'SHIFT_AMENDMENT_NOT_LIVE', 'SHIFT_AMENDMENT_TOO_LATE', 'SHIFT_AMENDMENTS_DISABLED',
  'SHIFT_AMENDMENT_APPROVAL_REQUIRED', 'SHIFT_AMENDMENT_NOT_FOUND',
]);

/**
 * An API failure in words. The API's own message is already written for people; a few codes get a clearer next
 * step. `error` is the app's ApiError / NetworkError (duck-typed, so this stays pure).
 */
export function amendmentErrorGuidance(error: unknown): AmendmentErrorGuidance {
  const e = error as { name?: string; status?: number; body?: unknown } | null;
  if (!e || typeof e.status !== 'number') {
    return { message: 'S4 could not be reached. Nothing was changed. Check the connection and try again.', reload: false, retryable: true };
  }
  const body = (e.body && typeof e.body === 'object' ? e.body : {}) as { code?: unknown; message?: unknown };
  const code = typeof body.code === 'string' ? body.code : null;
  const apiMessage = typeof body.message === 'string' && body.message.trim() ? body.message.trim()
    : Array.isArray(body.message) ? body.message.join(', ') : null;
  switch (code) {
    case 'SHIFT_AMENDMENTS_DISABLED':
      return { message: 'Shift extensions are not enabled for this company. Nothing was changed.', reload: true, retryable: false };
    case 'SHIFT_AMENDMENT_BUSY':
      return { message: 'This shift is being changed by someone else. Nothing was changed — try again in a moment.', reload: false, retryable: true };
    case 'SHIFT_AMENDMENT_STALE':
      return { message: 'The shift end changed since this was shown. The latest details have been loaded — check them and try again.', reload: true, retryable: false };
    case 'SHIFT_AMENDMENT_PENDING':
      return { message: 'This shift already has an extension waiting for a decision. The latest details have been loaded.', reload: true, retryable: false };
    case 'SHIFT_AMENDMENT_ALREADY_ANSWERED':
    case 'SHIFT_AMENDMENT_NOT_OPEN':
      return { message: `${apiMessage ?? 'This extension has already been answered.'} The latest details have been loaded.`, reload: true, retryable: false };
    case 'SHIFT_AMENDMENT_FORBIDDEN':
      return { message: apiMessage ?? 'You are not authorised to do this for shift extensions.', reload: false, retryable: false };
    default:
      break;
  }
  // A refusal without an amendment code comes from the role guard ("Forbidden resource"): say it in words.
  if (e.status === 403) return { message: code && apiMessage ? apiMessage : 'You are not authorised to do this for shift extensions.', reload: false, retryable: false };
  if (e.status === 404) return { message: 'This shift or extension could not be found. It may have been removed or belongs to another company.', reload: true, retryable: false };
  if (e.status === 409 && !code) return { message: apiMessage ?? 'Someone else changed this shift. The latest details have been loaded.', reload: true, retryable: false };
  if (e.status === 401) return { message: 'Your session has ended. Sign in again to continue.', reload: false, retryable: false };
  if (e.status >= 500) return { message: 'S4 could not complete this right now. Nothing was changed. Try again shortly.', reload: false, retryable: true };
  return { message: apiMessage ?? 'S4 could not complete this request.', reload: !!code && RELOAD_CODES.has(code), retryable: false };
}

// ─── history ──────────────────────────────────────────────────────────────────────────────────────────

export interface AmendmentHistoryEvent {
  at: string;
  amendmentId: number;
  sequence: number;
  kind: 'proposed' | 'approved' | 'accepted_app' | 'verbal_recorded' | 'declined' | 'withdrawn' | 'expired' | 'voided' | 'disputed' | 'dispute_resolved';
  title: string;
  detail: string;
  actor: string | null;
}

/**
 * Every recorded step of every extension of the shift, oldest first, each with its audit time. Built only from what
 * the API stored; nothing is inferred. `nameFor` turns a user id into words ("You", or a staff reference).
 */
export function buildAmendmentHistory(
  list: ShiftAmendment[] | null | undefined,
  timeZone: string,
  nameFor: (userId: number | null) => string | null,
): AmendmentHistoryEvent[] {
  const t = (iso: string | null | undefined) => formatUkDateTime(iso, timeZone);
  const events: AmendmentHistoryEvent[] = [];
  for (const a of list ?? []) {
    const base = { amendmentId: a.id, sequence: a.sequence };
    const terms = `${t(a.previousEnd)} → ${t(a.proposedEnd)} (+${formatDuration(a.additionalMinutes)})`;
    if (a.proposedAt) {
      const warn = a.fatigue?.warnings?.length ? ` · warnings: ${a.fatigue.warnings.join(', ')}` : '';
      events.push({ ...base, at: a.proposedAt, kind: 'proposed', title: `Extension #${a.sequence} proposed`,
        detail: `${terms}. Original scheduled end ${t(a.originalEnd)}. Reason: ${a.reason}${warn}`, actor: nameFor(a.proposedByUserId) });
    }
    if (a.approvedAt) {
      events.push({ ...base, at: a.approvedAt, kind: 'approved', title: 'Approved by management',
        detail: a.selfApproved ? 'Approved by the person who proposed it (confirmed).' : 'Fatigue safeguards reviewed.', actor: nameFor(a.approvedByUserId) });
    }
    if (a.respondedAt && a.responseMethod === 'staff_recorded_verbal') {
      const how = VERBAL_CONTACT_METHOD_OPTIONS.find((o) => o.value === a.verbalContactMethod)?.label ?? 'Other';
      events.push({ ...base, at: a.respondedAt, kind: 'verbal_recorded', title: 'Verbal agreement recorded by staff',
        detail: `Staff-reported, not an electronic Guard acceptance. ${how} at ${t(a.verbalContactAt)}. New end ${t(a.agreedEnd)}. `
          + `"${a.verbalConfirmation ?? ''}" ${confirmationEmailText(a.confirmationEmailStatus)}.`, actor: nameFor(a.respondedByUserId) });
    } else if (a.respondedAt && AGREED_AMENDMENT_STATUSES.includes(a.status)) {
      events.push({ ...base, at: a.respondedAt, kind: 'accepted_app', title: 'Accepted by the Guard in the app',
        detail: `Shift now ends ${t(a.agreedEnd)}.`, actor: 'Guard' });
    } else if (a.respondedAt && a.status === 'declined') {
      events.push({ ...base, at: a.respondedAt, kind: 'declined', title: 'Declined by the Guard', detail: 'The shift end is unchanged.', actor: 'Guard' });
    }
    if (a.withdrawnAt) events.push({ ...base, at: a.withdrawnAt, kind: 'withdrawn', title: 'Proposal withdrawn', detail: 'The shift end is unchanged.', actor: null });
    if (a.expiredAt) events.push({ ...base, at: a.expiredAt, kind: 'expired', title: 'Proposal expired', detail: 'No answer before the deadline. The shift end is unchanged.', actor: null });
    if (a.voidedAt) events.push({ ...base, at: a.voidedAt, kind: 'voided', title: 'Proposal cancelled', detail: `Cancelled because ${voidedReasonText(a.voidedReason)}. The shift end is unchanged.`, actor: null });
    if (a.disputedAt) events.push({ ...base, at: a.disputedAt, kind: 'disputed', title: 'Disputed by the Guard', detail: `Reason: ${a.disputeReason ?? '—'}. The extension stays in place until reviewed.`, actor: 'Guard' });
    if (a.disputeResolvedAt) {
      events.push({ ...base, at: a.disputeResolvedAt, kind: 'dispute_resolved',
        title: a.disputeResolution === 'corrected' ? 'Dispute reviewed — correction required' : 'Dispute reviewed — agreement stands',
        detail: `${a.disputeResolutionNote ?? ''}${a.disputeResolution === 'corrected' ? ' The schedule is not changed automatically; correct it through timesheet and payroll review.' : ''}`.trim(),
        actor: null });
    }
  }
  return events.sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || x.sequence - y.sequence);
}

/** Review flags the API set when an extension was agreed (timesheet, payroll, billing, compliance). */
export function reviewFlags(a: ShiftAmendment): string[] {
  const flags: string[] = [];
  if (a.timesheetSync === 'synced_draft') flags.push('Draft timesheet updated to the new end');
  if (a.timesheetSync === 'flagged_locked') flags.push('Timesheet already approved — not changed; review required');
  if (a.payrollReviewRequired) flags.push('Payroll review required');
  if (a.billingReviewRequired) flags.push('Billing review required');
  if (a.complianceReviewRequired) flags.push('Compliance review (7-day hours)');
  return flags;
}
