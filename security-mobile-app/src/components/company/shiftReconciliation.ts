// Close without Book Off — the client side of the rules the API enforces. (S4 Live Operations Phase 4.)
// Pure, so the exact reasons, validation and eligibility are executed by the spec suite.
//
// The API is the authority: this only decides when to OFFER the action and refuses an incomplete form
// before it is sent. Nothing here, or anywhere in the app, ever reconciles a shift on its own.

import { isBookOffOverdue } from './liveOperationsPolicy';

export const SHIFT_RECONCILIATION_OPTIONS = [
  { value: 'guard_forgot_book_off', label: 'Guard forgot to Book Off' },
  { value: 'app_connectivity_failure', label: 'Application/connectivity failure' },
  { value: 'control_confirmed_departure', label: 'Control-room confirmed departure' },
  { value: 'other', label: 'Other' },
] as const;

export type ShiftReconciliationReason = (typeof SHIFT_RECONCILIATION_OPTIONS)[number]['value'];

/** Matches the API's limit. */
export const SHIFT_RECONCILIATION_NOTE_MAX = 1000;

/** What every reconciled shift reads as in historical views. */
export const CLOSED_BY_CONTROL_LABEL = 'Closed by Control — No Book Off';

export function validateShiftReconciliation(input: { reason: string | null; note: string }):
  { ok: true } | { ok: false; message: string } {
  if (!input.reason || !SHIFT_RECONCILIATION_OPTIONS.some((option) => option.value === input.reason)) {
    return { ok: false, message: 'Choose why the shift is being closed without a Book Off.' };
  }
  if (input.reason === 'other' && !input.note.trim()) {
    return { ok: false, message: 'Explain why the shift is being closed without a Book Off.' };
  }
  if (input.note.length > SHIFT_RECONCILIATION_NOTE_MAX) {
    return { ok: false, message: `Keep the note under ${SHIFT_RECONCILIATION_NOTE_MAX} characters.` };
  }
  return { ok: true };
}

/**
 * Whether to offer Close without Book Off: in progress, a genuine Book On, no Book Off, and the scheduled
 * end plus the 15-minute grace has passed. A genuinely active shift is never offered it.
 */
export function isEligibleForReconciliation(
  shift: { status?: string | null; end: string },
  attendance: { checkInAt?: string | null; checkOutAt?: string | null } | null | undefined,
  nowMs: number,
): boolean {
  if ((shift.status || '').trim().toLowerCase() !== 'in_progress') return false;
  if (!attendance?.checkInAt || attendance.checkOutAt) return false;
  return isBookOffOverdue(shift.end, nowMs);
}

/** A completed shift with a Book On and no Book Off: closed by Control, never booked off by the Guard. */
export function isClosedWithoutBookOff(
  shift: { status?: string | null },
  attendance: { checkInAt?: string | null; checkOutAt?: string | null } | null | undefined,
): boolean {
  return (shift.status || '').trim().toLowerCase() === 'completed' && Boolean(attendance?.checkInAt) && !attendance?.checkOutAt;
}
