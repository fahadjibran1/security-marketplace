// Resolving an operational item: what Control may say, and what the screen calls it. (UAT FIX 02.)
//
// THE STORED VALUE AND THE DISPLAYED WORDS ARE DIFFERENT THINGS. The row stores
// `guard_confirmed_safe`; the button says "Guard confirmed safe". This module owns the mapping and
// nothing else owns it — which is what lets this very phase rewrite "Check Call" to "Welfare Check"
// on every surface without touching a single stored resolution, a backend enum, or a historical row.
//
// THE SETS ARE PER TYPE. A Missing Book Off cannot be resolved as "network signal issue" and an
// incident cannot be resolved as "shift extended", because those sentences are not true about those
// records. The backend enforces exactly these sets; this module exists so the dialog never offers a
// value the API would refuse.

import { formatInstantTime } from '../../services/siteTime';

export type ResolutionOption = {
  /** The stable machine value that is stored. Never shown. */
  value: string;
  /** What Control reads on the button. Never stored. */
  label: string;
};

/** The family of reasons an item may be resolved with, chosen by what the item IS. */
export type ResolutionFamily =
  | 'welfare'
  | 'missing_book_off'
  | 'site_request'
  | 'emergency'
  | 'general'
  | 'incident';

const WELFARE: ResolutionOption[] = [
  { value: 'guard_confirmed_safe', label: 'Guard confirmed safe' },
  { value: 'network_signal_issue', label: 'Network / signal issue' },
  { value: 'phone_device_issue', label: 'Phone battery / device issue' },
  { value: 'app_technical_issue', label: 'App / technical issue' },
  { value: 'guard_missed_check', label: 'Guard forgot / missed check' },
  { value: 'guard_unavailable', label: 'Guard unavailable' },
  { value: 'control_contacted_guard', label: 'Control contacted Guard' },
  { value: 'false_duplicate', label: 'False / duplicate alert' },
  { value: 'other', label: 'Other' },
];

const MISSING_BOOK_OFF: ResolutionOption[] = [
  { value: 'guard_confirmed_off_site', label: 'Guard confirmed off site' },
  { value: 'control_closed_shift', label: 'Control closed shift' },
  { value: 'guard_forgot_book_off', label: 'Guard forgot to Book Off' },
  { value: 'device_network_issue', label: 'Device / network issue' },
  { value: 'shift_extended', label: 'Shift extended' },
  { value: 'incorrect_schedule', label: 'Incorrect schedule' },
  { value: 'other', label: 'Other' },
];

const SITE_REQUEST: ResolutionOption[] = [
  { value: 'request_completed', label: 'Request completed' },
  { value: 'client_supervisor_informed', label: 'Client / supervisor informed' },
  { value: 'maintenance_arranged', label: 'Maintenance arranged' },
  { value: 'equipment_supplies_arranged', label: 'Supplies / equipment arranged' },
  { value: 'not_required', label: 'Not required' },
  { value: 'other', label: 'Other' },
];

/**
 * Emergency has no catch-all. Every value states what Control actually established about the guard,
 * and each one needs words beside it — there is deliberately nothing here that can be clicked through.
 */
const EMERGENCY: ResolutionOption[] = [
  { value: 'guard_confirmed_safe', label: 'Guard confirmed safe' },
  { value: 'control_attended_site', label: 'Control attended site' },
  { value: 'emergency_services_attended', label: 'Emergency services attended' },
  { value: 'escalated_externally', label: 'Escalated externally' },
  { value: 'false_activation', label: 'False activation' },
];

const GENERAL: ResolutionOption[] = [
  { value: 'resolved_by_control', label: 'Resolved by Control' },
  { value: 'guard_contacted', label: 'Guard contacted' },
  { value: 'no_action_required', label: 'No action required' },
  { value: 'false_duplicate', label: 'False / duplicate alert' },
  { value: 'other', label: 'Other' },
];

const INCIDENT: ResolutionOption[] = [
  { value: 'resolved_on_site', label: 'Resolved on site' },
  { value: 'client_informed', label: 'Client informed' },
  { value: 'emergency_services_attended', label: 'Emergency services attended' },
  { value: 'maintenance_arranged', label: 'Maintenance / repair arranged' },
  { value: 'false_alarm', label: 'False alarm / no issue found' },
  { value: 'escalated_externally', label: 'Escalated externally' },
  { value: 'other', label: 'Other' },
];

const FAMILIES: Record<ResolutionFamily, ResolutionOption[]> = {
  welfare: WELFARE,
  missing_book_off: MISSING_BOOK_OFF,
  site_request: SITE_REQUEST,
  emergency: EMERGENCY,
  general: GENERAL,
  incident: INCIDENT,
};

/**
 * Which reason family an alert type belongs to.
 *
 * `welfare` is the HISTORICAL Site Request label — Phase 3C renamed the surface, not the stored
 * value — so it resolves from the Site Request set, exactly as the backend does.
 */
export function resolutionFamilyForAlert(type: string | null | undefined): ResolutionFamily {
  switch ((type || '').trim().toLowerCase()) {
    case 'check_call':
    case 'missed_checkcall':
      return 'welfare';
    case 'missing_book_off':
      return 'missing_book_off';
    case 'welfare':
    case 'site_request':
      return 'site_request';
    case 'panic':
      return 'emergency';
    default:
      return 'general';
  }
}

export function resolutionOptions(family: ResolutionFamily): ResolutionOption[] {
  return FAMILIES[family] ?? GENERAL;
}

export function resolutionLabel(family: ResolutionFamily, value: string | null | undefined): string {
  if (!value) return '';
  return resolutionOptions(family).find((option) => option.value === value)?.label ?? value;
}

/**
 * Whether this choice needs words beside it.
 *
 * Everything a guard's safety could depend on does. A site request is the one family where
 * "Request completed" is the whole story — and even there, "Other" still has to be explained.
 */
export function requiresResolutionNote(family: ResolutionFamily, reason: string | null | undefined): boolean {
  if (reason === 'other') return true;
  return family !== 'site_request';
}

/** The longest note the API accepts. Mirrors RESOLUTION_NOTE_MAX_LENGTH on the backend. */
export const RESOLUTION_NOTE_MAX_LENGTH = 2000;

export type ResolutionDraft = { reason: string | null; note: string };

/**
 * Whether this draft may be submitted, and if not, what is missing.
 *
 * The same rule the API enforces, applied before the request so Control is told what is needed
 * rather than refused after writing it.
 */
export function validateResolution(
  family: ResolutionFamily,
  draft: ResolutionDraft,
): { ok: boolean; message?: string } {
  const reason = draft.reason?.trim() || '';
  const note = draft.note?.trim() || '';

  if (!reason) return { ok: false, message: 'Choose a resolution reason.' };
  if (!resolutionOptions(family).some((option) => option.value === reason)) {
    return { ok: false, message: 'That reason does not apply to this item.' };
  }
  if (requiresResolutionNote(family, reason) && !note) {
    return {
      ok: false,
      message: reason === 'other'
        ? 'A note is required when the reason is "Other".'
        : 'A resolution note is required.',
    };
  }
  if (note.length > RESOLUTION_NOTE_MAX_LENGTH) {
    return { ok: false, message: `Keep the note under ${RESOLUTION_NOTE_MAX_LENGTH} characters.` };
  }
  return { ok: true };
}

// ─── canonical operational wording ────────────────────────────────────────────

/**
 * What a safety alert is CALLED, as opposed to what it is stored as.
 *
 * "Check Call" was the old name for a Welfare Check and survives in stored enums and historical rows.
 * Nothing here renames a stored value: `check_call` and `missed_checkcall` rows keep their type and
 * simply read correctly.
 */
export function alertTypeLabel(type: string | null | undefined): string {
  switch ((type || '').trim().toLowerCase()) {
    case 'check_call':
      return 'Welfare Check';
    case 'missed_checkcall':
      return 'Missed Welfare Check';
    case 'missing_book_off':
      return 'Missing Book Off';
    case 'panic':
      return 'Emergency';
    case 'welfare':
    case 'site_request':
      return 'Site Request';
    case 'late_checkin':
      return 'Late Book On';
    case 'other':
      return 'Safety alert';
    default:
      return 'Safety alert';
  }
}

/** The lifecycle word shown on an item. Never colour alone, and never a bare dot. */
export function lifecycleLabel(status: string | null | undefined): 'Open' | 'Acknowledged' | 'Resolved' {
  switch ((status || '').trim().toLowerCase()) {
    case 'acknowledged':
      return 'Acknowledged';
    case 'closed':
    case 'resolved':
      return 'Resolved';
    default:
      return 'Open';
  }
}

// ─── missing Book Off ─────────────────────────────────────────────────────────

/**
 * How long a Book Off has been missing, as a control-room-readable duration.
 *
 * Counted from the SCHEDULED END, not from when the alert was raised: the grace period is about when
 * to raise it, and a controller asking "how overdue is this?" means how long the guard has been
 * unaccounted for.
 */
export function overdueDuration(scheduledEndIso: string | null | undefined, nowMs: number): string {
  if (!scheduledEndIso) return '';
  const endMs = Date.parse(scheduledEndIso);
  if (!Number.isFinite(endMs) || nowMs <= endMs) return '';

  const totalMinutes = Math.floor((nowMs - endMs) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes}m overdue`;
  return `${hours}h ${String(minutes).padStart(2, '0')}m overdue`;
}

/**
 * The second line of a Missing Book Off item: when the shift was due to end, on the SITE's clock, and
 * how long ago that was.
 */
export function missingBookOffSummary(
  scheduledEndIso: string | null | undefined,
  timeZone: string,
  nowMs: number,
): string {
  if (!scheduledEndIso) return 'No Book Off recorded.';
  const at = formatInstantTime(scheduledEndIso, timeZone);
  const overdue = overdueDuration(scheduledEndIso, nowMs);
  return overdue ? `Scheduled end ${at} · ${overdue}` : `Scheduled end ${at}`;
}
