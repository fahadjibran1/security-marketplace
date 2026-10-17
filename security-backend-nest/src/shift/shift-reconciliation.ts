// Close without Book Off: the reasons a control room may give, and what they mean for the alerts the
// shift carries. (S4 Live Operations Phase 4.)
//
// STABLE MACHINE VALUES, never the words on the button — the same rule as alert resolution reasons.

export const SHIFT_RECONCILIATION_REASONS = [
  'guard_forgot_book_off',
  'app_connectivity_failure',
  'control_confirmed_departure',
  'other',
] as const;

export type ShiftReconciliationReason = (typeof SHIFT_RECONCILIATION_REASONS)[number];

export const SHIFT_RECONCILIATION_REASON_LABELS: Record<ShiftReconciliationReason, string> = {
  guard_forgot_book_off: 'Guard forgot to Book Off',
  app_connectivity_failure: 'Application/connectivity failure',
  control_confirmed_departure: 'Control-room confirmed departure',
  other: 'Other',
};

/** The longest note stored. Matches the alert resolution note's practical size. */
export const SHIFT_RECONCILIATION_NOTE_MAX = 1000;

/**
 * Book Off is late, not missing, until the scheduled end plus this grace — the same 15 minutes after which
 * the welfare sweep raises its Missing Book Off alert and Live Operations stops calling the shift live.
 */
export const RECONCILIATION_BOOK_OFF_GRACE_MINUTES = 15;

/**
 * The resolution recorded on the alerts reconciliation closes. Each value comes from that alert type's
 * own reason set (safety-alert/resolution-reasons.ts), so a reconciled alert reads exactly like one a
 * person closed and no report has to learn a new value.
 */
export const MISSING_BOOK_OFF_REASON_FOR: Record<ShiftReconciliationReason, string> = {
  guard_forgot_book_off: 'guard_forgot_book_off',
  app_connectivity_failure: 'device_network_issue',
  control_confirmed_departure: 'guard_confirmed_off_site',
  other: 'other',
};

export const WELFARE_SUMMARY_REASON_FOR: Record<ShiftReconciliationReason, string> = {
  guard_forgot_book_off: 'other',
  app_connectivity_failure: 'app_technical_issue',
  control_confirmed_departure: 'control_contacted_guard',
  other: 'other',
};

/** The note written on each alert reconciliation closes: why, and the controller's own words if any. */
export function reconciliationAlertNote(reason: ShiftReconciliationReason, note: string | null): string {
  const base = `Closed by Control without Book Off (shift reconciliation): ${SHIFT_RECONCILIATION_REASON_LABELS[reason]}.`;
  return note ? `${base} ${note}` : base;
}
