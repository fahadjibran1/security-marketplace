// Live Shift Amendments — the Guard side (Phase 3). Pure, so every word, state and refusal is executed by the spec.
//
// The API is the authority. Nothing here moves a shift: the app shows the new end only after the server has accepted
// the answer and the shift has been re-read. There is no push delivery for these requests, so nothing here says the
// Guard was alerted instantly — requests appear when the app refreshes.

import { formatInstantTime, formatUkDateTime } from '../../services/siteTime';
import type { AmendmentWarning, ShiftAmendment } from '../../types/models';

export const GUARD_DISPUTE_MIN = 3;
export const GUARD_DISPUTE_MAX = 500;
/** How often the Guard's active-shift card re-reads requests while the app is open (the screen's existing tick). */
export const GUARD_AMENDMENT_REFRESH_MS = 60_000;
/** Foregrounding re-reads requests unless they were read this recently. */
export const GUARD_AMENDMENT_FOREGROUND_MIN_MS = 15_000;

export const GUARD_DELIVERY_NOTE =
  'Extension requests appear here when the app refreshes — about every minute while it is open, and when you return to it. S4 does not send instant alerts for them.';

const OPEN: readonly string[] = ['awaiting_approval', 'pending'];
const AGREED: readonly string[] = ['accepted', 'disputed', 'dispute_upheld', 'dispute_corrected'];

export function isOpenRequest(a: Pick<ShiftAmendment, 'status' | 'effectiveStatus'>): boolean {
  return OPEN.includes(a.status) && a.effectiveStatus !== 'expired';
}

/** The request the Guard must answer (or is waiting on management for), for this shift. At most one exists. */
export function openRequestForShift(list: ShiftAmendment[] | null | undefined, shiftId: number | null | undefined): ShiftAmendment | null {
  if (shiftId === null || shiftId === undefined) return null;
  return (list ?? []).find((a) => a.shiftId === shiftId && isOpenRequest(a)) ?? null;
}

/**
 * What the Home card should show for a shift: the open request, otherwise the most recent request of the shift
 * (so an answer, a withdrawal, an expiry or a staff-recorded agreement is visible after the fact).
 */
export function cardRequestForShift(list: ShiftAmendment[] | null | undefined, shiftId: number | null | undefined): ShiftAmendment | null {
  const open = openRequestForShift(list, shiftId);
  if (open) return open;
  const mine = (list ?? []).filter((a) => a.shiftId === shiftId);
  return mine.sort((x, y) => y.sequence - x.sequence)[0] ?? null;
}

/** A staff-recorded agreement the Guard has not disputed yet — on any recent shift, not only the live one. */
export function disputableRequests(list: ShiftAmendment[] | null | undefined): ShiftAmendment[] {
  return (list ?? []).filter((a) => a.status === 'accepted' && a.responseMethod === 'staff_recorded_verbal');
}

export function canAnswer(a: ShiftAmendment | null, nowMs: number): boolean {
  if (!a || a.status !== 'pending' || a.effectiveStatus === 'expired') return false;
  const deadline = Date.parse(a.expiresAt ?? '');
  return Number.isFinite(deadline) && deadline > nowMs;
}

export function formatExtraTime(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  if (r === 0) return h === 1 ? '1 hour' : `${h} hours`;
  return `${h} h ${r} min`;
}

/** The state of a request in the Guard's own words. */
export function guardRequestTitle(a: ShiftAmendment): string {
  const s = a.effectiveStatus === 'expired' && OPEN.includes(a.status) ? 'expired' : a.status;
  switch (s) {
    case 'awaiting_approval': return 'Extension request — waiting for management approval';
    case 'pending': return 'Your company is asking you to stay later';
    case 'accepted': return a.responseMethod === 'staff_recorded_verbal' ? 'Extension recorded by your company' : 'You accepted the extension';
    case 'declined': return 'You declined the extension';
    case 'withdrawn': return 'Your company withdrew the extension request';
    case 'expired': return 'The extension request expired';
    case 'voided': return 'Extension request cancelled — you booked off';
    case 'disputed': return 'You disputed this extension — waiting for review';
    case 'dispute_upheld': return 'Dispute reviewed — the recorded agreement stands';
    case 'dispute_corrected': return 'Dispute reviewed — your company will correct it';
    default: return 'Shift extension';
  }
}

/** What the state means for the Guard, including what did NOT happen. */
export function guardRequestExplanation(a: ShiftAmendment, timeZone?: string | null): string {
  const t = (iso: string | null | undefined) => formatInstantTime(iso, timeZone);
  const s = a.effectiveStatus === 'expired' && OPEN.includes(a.status) ? 'expired' : a.status;
  switch (s) {
    case 'awaiting_approval':
      return 'Management must approve this request before you can answer it. Your shift end has not changed.';
    case 'pending':
      return `Nothing changes unless you accept. If you do not answer by ${t(a.expiresAt)}, the request expires and your shift still ends at ${t(a.previousEnd)}.`;
    case 'accepted':
      if (a.responseMethod === 'staff_recorded_verbal') {
        return `Your company recorded that you agreed verbally${a.verbalContactAt ? ` (${verbalMethodWord(a.verbalContactMethod)} at ${t(a.verbalContactAt)})` : ''}. You did not accept this in the app. Your shift now ends at ${t(a.agreedEnd)}. If you did not agree, you can dispute it.`;
      }
      return `Your shift now ends at ${t(a.agreedEnd)}.`;
    case 'declined':
      return `Your shift end did not change (${t(a.previousEnd)}).`;
    case 'withdrawn':
      return `Your shift end did not change (${t(a.previousEnd)}). You do not need to do anything.`;
    case 'expired':
      return `It was not answered in time. Your shift end did not change (${t(a.previousEnd)}).`;
    case 'voided':
      return 'You booked off before the request was answered. Your shift end did not change.';
    case 'disputed':
      return `The extension stays in place until your company reviews it. Your reason: ${a.disputeReason ?? '—'}`;
    case 'dispute_upheld':
      return a.disputeResolutionNote ? `Your company's note: ${a.disputeResolutionNote}` : 'Your company reviewed the dispute.';
    case 'dispute_corrected':
      return `Your company will correct your hours through the timesheet.${a.disputeResolutionNote ? ` Their note: ${a.disputeResolutionNote}` : ''}`;
    default:
      return '';
  }
}

function verbalMethodWord(method: string | null | undefined): string {
  switch (method) {
    case 'telephone': return 'by telephone';
    case 'in_person': return 'in person';
    case 'radio': return 'by radio';
    default: return 'verbally';
  }
}

export function guardStatusTone(a: ShiftAmendment): 'info' | 'warning' | 'success' | 'neutral' | 'danger' {
  const s = a.effectiveStatus === 'expired' && OPEN.includes(a.status) ? 'expired' : a.status;
  if (s === 'pending') return 'warning';
  if (s === 'awaiting_approval') return 'info';
  if (s === 'disputed') return 'danger';
  if (AGREED.includes(s)) return 'success';
  return 'neutral';
}

export function guardApprovalText(a: ShiftAmendment): string | null {
  if (!a.approvalRequired) return null;
  if (a.approvedAt) return 'Approved by management';
  if (a.status === 'awaiting_approval') return 'Waiting for management approval';
  return 'Management approval was required';
}

/** Fatigue and working-time warnings the backend attached — its figures, never thresholds guessed by the app. */
export function guardWarningText(w: AmendmentWarning, f: ShiftAmendment['fatigue']): string {
  const h = (n: number | null | undefined) => (n === null || n === undefined ? '' : ` (${Math.round(n * 100) / 100} h)`);
  switch (w) {
    case 'LONG_SHIFT': return `Long shift: this would make your shift longer than your company's usual limit${h(f.totalScheduledHours)}.`;
    case 'SHORT_REST': return `Short rest: you would have less rest than recommended before your next shift${h(f.restHoursBeforeNextShift)}.`;
    case 'WEEKLY_HOURS': return `7-day hours: your scheduled hours in the last 7 days are high${h(f.sevenDayScheduledHours)}.`;
    case 'LAST_MINUTE': return 'Last-minute request: your shift was due to end very soon after this was sent.';
    default: return String(w);
  }
}

export function validateGuardDispute(reason: string): { ok: true } | { ok: false; message: string } {
  if (reason.trim().length < GUARD_DISPUTE_MIN) return { ok: false, message: 'Say briefly what you did agree to.' };
  if (reason.length > GUARD_DISPUTE_MAX) return { ok: false, message: `Keep it under ${GUARD_DISPUTE_MAX} characters.` };
  return { ok: true };
}

export interface GuardAmendmentGuidance {
  message: string;
  /** Re-read the requests before anything else: the request changed. */
  reload: boolean;
  /** Safe to tap again: nothing was changed and the server answers a repeated answer with the stored result. */
  retryable: boolean;
}

/** A failed request in the Guard's words. `error` is the app's ApiError / NetworkError (duck-typed, so pure). */
export function guardAmendmentGuidance(error: unknown): GuardAmendmentGuidance {
  const e = error as { status?: number; body?: unknown } | null;
  if (!e || typeof e.status !== 'number') {
    return { message: 'No connection to S4. Your answer was not sent — check your signal and try again.', reload: false, retryable: true };
  }
  const body = (e.body && typeof e.body === 'object' ? e.body : {}) as { code?: unknown; message?: unknown };
  const code = typeof body.code === 'string' ? body.code : null;
  const apiMessage = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : null;
  switch (code) {
    case 'SHIFT_AMENDMENT_EXPIRED':
      return { message: 'This request has expired. Your shift end has not changed.', reload: true, retryable: false };
    case 'SHIFT_AMENDMENT_NOT_OPEN':
      return { message: `${apiMessage ?? 'This request is no longer open.'} Your shift end has not changed.`, reload: true, retryable: false };
    case 'SHIFT_AMENDMENT_ALREADY_ANSWERED':
      return { message: apiMessage ?? 'This request has already been answered.', reload: true, retryable: false };
    case 'SHIFT_AMENDMENT_APPROVAL_REQUIRED':
      return { message: 'Management has not approved this request yet, so it cannot be answered.', reload: true, retryable: false };
    case 'SHIFT_AMENDMENTS_DISABLED':
      return { message: 'Your company has switched shift extensions off. Nothing was changed.', reload: true, retryable: false };
    case 'SHIFT_AMENDMENT_BUSY':
      return { message: 'Your shift is being updated right now. Nothing was changed — try again in a moment.', reload: false, retryable: true };
    case 'SHIFT_AMENDMENT_CLASH':
    case 'SHIFT_AMENDMENT_GUARD_INELIGIBLE':
    case 'SHIFT_AMENDMENT_NOT_LIVE':
    case 'SHIFT_AMENDMENT_TOO_LATE':
    case 'SHIFT_AMENDMENT_STALE':
      return { message: `${apiMessage ?? 'This request can no longer be accepted.'} Your shift end has not changed.`, reload: true, retryable: false };
    case 'SHIFT_AMENDMENT_NOT_DISPUTABLE':
      return { message: apiMessage ?? 'Only an agreement recorded by your company can be disputed.', reload: true, retryable: false };
    case 'SHIFT_AMENDMENT_NOT_FOUND':
      return { message: 'This request is no longer available.', reload: true, retryable: false };
    default:
      break;
  }
  if (e.status === 401) return { message: 'Your session has ended. Sign in again.', reload: false, retryable: false };
  if (e.status === 403 || e.status === 404) return { message: 'This request is not available to you.', reload: true, retryable: false };
  if (e.status >= 500) return { message: 'S4 could not take your answer right now. Nothing was changed — try again.', reload: false, retryable: true };
  return { message: apiMessage ?? 'S4 could not take your answer.', reload: false, retryable: false };
}

/**
 * Whether the server has no amendment routes at all (an older backend): a plain 404 without an amendment code.
 * The app then hides the feature quietly instead of showing an error on every refresh.
 */
export function isFeatureUnavailable(error: unknown): boolean {
  const e = error as { status?: number; body?: unknown } | null;
  if (!e || e.status !== 404) return false;
  const code = e.body && typeof e.body === 'object' ? (e.body as { code?: unknown }).code : undefined;
  return code === undefined;
}

export interface GuardHistoryEvent { at: string; title: string; detail: string }

/** One shift's requests, oldest first, in the Guard's words. Only what the server recorded. */
export function buildGuardHistory(list: ShiftAmendment[] | null | undefined, timeZone?: string | null): GuardHistoryEvent[] {
  const t = (iso: string | null | undefined) => formatUkDateTime(iso, timeZone);
  const out: Array<GuardHistoryEvent & { seq: number }> = [];
  for (const a of list ?? []) {
    const seq = a.sequence;
    if (a.proposedAt) out.push({ seq, at: a.proposedAt, title: `Request ${a.sequence}: stay until ${t(a.proposedEnd)} (+${formatExtraTime(a.additionalMinutes)})`, detail: `Reason: ${a.reason}. Originally due to end ${t(a.originalEnd)}.` });
    if (a.approvedAt) out.push({ seq, at: a.approvedAt, title: 'Approved by management', detail: '' });
    if (a.respondedAt && a.responseMethod === 'staff_recorded_verbal') {
      out.push({ seq, at: a.respondedAt, title: 'Recorded by your company as agreed verbally', detail: `Not accepted in the app. ${a.verbalConfirmation ? `Their record: "${a.verbalConfirmation}"` : ''}`.trim() });
    } else if (a.respondedAt && AGREED.includes(a.status)) {
      out.push({ seq, at: a.respondedAt, title: 'You accepted in the app', detail: `New end ${t(a.agreedEnd)}.` });
    } else if (a.respondedAt && a.status === 'declined') {
      out.push({ seq, at: a.respondedAt, title: 'You declined', detail: 'Shift end unchanged.' });
    }
    if (a.withdrawnAt) out.push({ seq, at: a.withdrawnAt, title: 'Withdrawn by your company', detail: 'Shift end unchanged.' });
    if (a.expiredAt) out.push({ seq, at: a.expiredAt, title: 'Expired', detail: 'Shift end unchanged.' });
    if (a.voidedAt) out.push({ seq, at: a.voidedAt, title: 'Cancelled — you booked off', detail: 'Shift end unchanged.' });
    if (a.disputedAt) out.push({ seq, at: a.disputedAt, title: 'You disputed it', detail: a.disputeReason ?? '' });
    if (a.disputeResolvedAt) out.push({ seq, at: a.disputeResolvedAt, title: a.disputeResolution === 'corrected' ? 'Dispute reviewed — to be corrected' : 'Dispute reviewed — agreement stands', detail: a.disputeResolutionNote ?? '' });
  }
  return out.sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || x.seq - y.seq).map(({ seq: _s, ...e }) => e);
}
