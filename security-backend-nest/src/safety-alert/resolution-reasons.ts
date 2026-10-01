import { SafetyAlertType } from './entities/safety-alert.entity';

/**
 * Why a control room closed an operational item.
 *
 * STABLE MACHINE VALUES, never the words on the button. The screen shows "Guard confirmed safe"; the
 * row stores `guard_confirmed_safe`. Presentation can be rewritten — and in this very phase "Check
 * Call" is being rewritten to "Welfare Check" — without touching a single stored resolution, and a
 * report written a year from now still groups them correctly.
 *
 * THE SETS ARE PER TYPE, NOT ONE UNION. A missing Book Off cannot be resolved as "network signal
 * issue" and an incident cannot be resolved as "shift extended": those sentences are not true about
 * those records. One combined list would make every such nonsense acceptable to the API, and the
 * resulting data would be unusable for exactly the compliance questions it exists to answer.
 */

/** Missed and overdue Welfare Checks, and the legacy rolling check-call alerts. */
export const WELFARE_RESOLUTION_REASONS = [
  'guard_confirmed_safe',
  'network_signal_issue',
  'phone_device_issue',
  'app_technical_issue',
  'guard_missed_check',
  'guard_unavailable',
  'control_contacted_guard',
  'false_duplicate',
  'other',
] as const;

/** A shift that ended with no Book Off recorded. */
export const MISSING_BOOK_OFF_RESOLUTION_REASONS = [
  'guard_confirmed_off_site',
  'control_closed_shift',
  'guard_forgot_book_off',
  'device_network_issue',
  'shift_extended',
  'incorrect_schedule',
  'other',
] as const;

/** A Guard-raised request about the site: supplies, access, lighting, equipment. */
export const SITE_REQUEST_RESOLUTION_REASONS = [
  'request_completed',
  'client_supervisor_informed',
  'maintenance_arranged',
  'equipment_supplies_arranged',
  'not_required',
  'other',
] as const;

/**
 * A Guard pressed Emergency.
 *
 * Deliberately the smallest set here, and deliberately without a "false_duplicate" style shortcut
 * that could be clicked through: every value states what Control actually established about the
 * guard's safety, and a note is mandatory alongside it. `false_activation` exists because accidental
 * presses are real, but it is a claim about the ALERT, not about the guard — if the guard was never
 * contacted, none of these can be chosen honestly except `escalated_externally`.
 */
export const EMERGENCY_RESOLUTION_REASONS = [
  'guard_confirmed_safe',
  'control_attended_site',
  'emergency_services_attended',
  'escalated_externally',
  'false_activation',
] as const;

/** Anything else durable on the alert table: late check-in and `other`. */
export const GENERAL_ALERT_RESOLUTION_REASONS = [
  'resolved_by_control',
  'guard_contacted',
  'no_action_required',
  'false_duplicate',
  'other',
] as const;

/** Incidents, which live on their own table and their own status enum. */
export const INCIDENT_RESOLUTION_REASONS = [
  'resolved_on_site',
  'client_informed',
  'emergency_services_attended',
  'maintenance_arranged',
  'false_alarm',
  'escalated_externally',
  'other',
] as const;

export type ResolutionReason =
  | (typeof WELFARE_RESOLUTION_REASONS)[number]
  | (typeof MISSING_BOOK_OFF_RESOLUTION_REASONS)[number]
  | (typeof SITE_REQUEST_RESOLUTION_REASONS)[number]
  | (typeof EMERGENCY_RESOLUTION_REASONS)[number]
  | (typeof GENERAL_ALERT_RESOLUTION_REASONS)[number]
  | (typeof INCIDENT_RESOLUTION_REASONS)[number];

/** The reasons a given alert type may be closed with. */
export function alertResolutionReasons(type: SafetyAlertType): readonly string[] {
  switch (type) {
    case SafetyAlertType.CHECK_CALL:
    case SafetyAlertType.MISSED_CHECKCALL:
      return WELFARE_RESOLUTION_REASONS;
    case SafetyAlertType.MISSING_BOOK_OFF:
      return MISSING_BOOK_OFF_RESOLUTION_REASONS;
    // `welfare` is the HISTORICAL Site Request type. Phase 3C renamed the surface, not the stored
    // label, so both resolve from the Site Request set — see the entity's own note.
    case SafetyAlertType.WELFARE:
    case SafetyAlertType.SITE_REQUEST:
      return SITE_REQUEST_RESOLUTION_REASONS;
    case SafetyAlertType.PANIC:
      return EMERGENCY_RESOLUTION_REASONS;
    default:
      return GENERAL_ALERT_RESOLUTION_REASONS;
  }
}

/**
 * Whether closing this type of alert requires an explanation in words.
 *
 * Everything a guard's safety could depend on does. A site request is the one item where "request
 * completed" is the whole story — and even there, `other` still has to be explained.
 */
export function alertRequiresResolutionNote(type: SafetyAlertType, reason: string): boolean {
  if (reason === 'other') return true;
  return type !== SafetyAlertType.SITE_REQUEST && type !== SafetyAlertType.WELFARE;
}

/** The longest resolution note the API will accept. Long enough for a paragraph, short of an essay. */
export const RESOLUTION_NOTE_MAX_LENGTH = 2000;
