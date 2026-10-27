// Manual attendance (S4 Part B) — the client side of the rules the API enforces. Pure, so permissions, feature
// detection, eligibility, validation, error wording and the attendance history are executed by the spec suite.
//
// The API is the authority. This only decides which controls to OFFER, refuses an incomplete or impossible form
// before it is sent, and turns the API's answers into words. Nothing here ever books a Guard on or off by itself.

import { formatSiteDateInput, formatSiteTime, formatUkDateTime, siteLocalToInstant } from '../../services/siteTime';
import type {
  AttendanceEvent,
  AttendanceEventView,
  AttendanceHistory,
  AttendanceVerificationMethod,
  ManualAttendanceCapabilities,
  OperationsAttendanceView,
} from '../../types/models';

export type { AttendanceEventView, AttendanceHistory, AttendanceVerificationMethod, ManualAttendanceCapabilities };

// ─── contract (mirrors security-backend-nest/src/attendance) ─────────────────────────────────────────

export const VERIFICATION_METHOD_OPTIONS: ReadonlyArray<{ value: AttendanceVerificationMethod; label: string }> = [
  { value: 'phone_call', label: 'Phone call with the Guard' },
  { value: 'supervisor_on_site', label: 'Supervisor on site' },
  { value: 'cctv', label: 'CCTV' },
  { value: 'client_confirmation', label: 'Client confirmation' },
  { value: 'radio', label: 'Radio' },
  { value: 'other', label: 'Other' },
];

/** The API's text limits for reason and verification note. */
export const MANUAL_ATTENDANCE_TEXT_MAX = 500;

/**
 * Defaults used only until capabilities arrive; the values the API returns always win. Owner decision: the actual time
 * must be within [scheduled start − 12 h, scheduled end + 12 h] and never in the future, and an entry or correction
 * more than 24 hours old needs an Owner or Admin.
 */
export const DEFAULT_MANUAL_ATTENDANCE_LIMITS = {
  windowBeforeStartHours: 12,
  windowAfterEndHours: 12,
  ownerAdminOnlyOlderThanHours: 24,
} as const;

export const MANUAL_ATTENDANCE_UNAVAILABLE_NOTE = "Manual Book On/Off isn't available on this server yet.";

const HOUR = 3_600_000;

export function verificationMethodLabel(method: string | null | undefined): string {
  return VERIFICATION_METHOD_OPTIONS.find((option) => option.value === method)?.label ?? (method ? String(method) : '—');
}

// ─── who may do what ──────────────────────────────────────────────────────────────────────────────────

/**
 * From the session's companyPermissions: attendance.manage (Owner, Admin, Operations by role; a Control Room member
 * only through their individual grant, which arrives in the same list). A session without the list (issued before
 * memberships) falls back to the legacy owner roles. Display only: the API re-checks every action.
 */
export function canManageAttendanceFromSession(companyPermissions: string[] | undefined | null, role: string | undefined | null): boolean {
  if (role === 'guard' || role === 'admin') return false;
  if (companyPermissions) return companyPermissions.includes('attendance.manage');
  return role === 'company_admin' || role === 'company';
}

// ─── feature detection ────────────────────────────────────────────────────────────────────────────────

export type ManualAttendanceAvailability =
  | { state: 'loading' }
  | { state: 'available'; capabilities: ManualAttendanceCapabilities }
  | { state: 'unavailable' }
  | { state: 'error' };

/**
 * What a failed capabilities read means. A 404 WITHOUT a machine-readable code is Nest's "Cannot GET …": this backend
 * predates manual attendance, so every manual action is hidden. Anything else is a temporary failure — also hidden
 * (never guessed available), but not described as an old server.
 */
export function classifyCapabilitiesFailure(error: unknown): 'unavailable' | 'error' {
  const e = error as { status?: number; body?: unknown } | null;
  if (!e || typeof e.status !== 'number') return 'error';
  const body = (e.body && typeof e.body === 'object' ? e.body : {}) as { code?: unknown };
  if (e.status === 404 && typeof body.code !== 'string') return 'unavailable';
  return 'error';
}

/** Whether to offer manual actions at all: the permission AND a backend that has the feature. */
export function manualActionsOffered(canManage: boolean, availability: ManualAttendanceAvailability): boolean {
  return canManage && availability.state === 'available';
}

export function limitsOf(capabilities: ManualAttendanceCapabilities | null | undefined) {
  return {
    windowBeforeStartHours: capabilities?.windowBeforeStartHours ?? DEFAULT_MANUAL_ATTENDANCE_LIMITS.windowBeforeStartHours,
    windowAfterEndHours: capabilities?.windowAfterEndHours ?? DEFAULT_MANUAL_ATTENDANCE_LIMITS.windowAfterEndHours,
    ownerAdminOnlyOlderThanHours:
      capabilities?.ownerAdminOnlyOlderThanHours ?? DEFAULT_MANUAL_ATTENDANCE_LIMITS.ownerAdminOnlyOlderThanHours,
  };
}

// ─── eligibility ──────────────────────────────────────────────────────────────────────────────────────

export type ManualAttendanceKind = 'book_on' | 'book_off' | 'correct';

export interface ManualAttendanceAction {
  kind: 'book_on' | 'book_off';
  label: string;
  /** One line saying why the action is offered. */
  hint: string;
}

type ShiftLike = {
  status?: string | null;
  start: string;
  end: string;
  guard?: { id?: number; fullName?: string | null } | null;
  guardId?: number | null;
};
type AttendanceLike = { checkInAt: string | null; checkOutAt: string | null } | null | undefined;

const normalise = (status: string | null | undefined) => String(status ?? '').trim().toLowerCase();

/**
 * The manual actions a shift offers right now. Mirrors the API's state rules; the API re-checks them under lock.
 *
 *   ready, Guard assigned, no Book On, start − 12 h has passed  → Book On for Guard
 *   missed, Guard assigned, no Book On                          → Book On for Guard (late arrival)
 *   in progress with a Book On and no Book Off                  → Book Off for Guard
 *   completed with a Book On and no Book Off (closed by Control) → Book Off for Guard
 */
export function manualAttendanceActions(
  shift: ShiftLike,
  attendance: AttendanceLike,
  nowMs: number,
  capabilities?: ManualAttendanceCapabilities | null,
): ManualAttendanceAction[] {
  const status = normalise(shift.status);
  const hasGuard = Boolean(shift.guard?.id ?? shift.guardId ?? shift.guard?.fullName);
  const bookedOn = Boolean(attendance?.checkInAt);
  const bookedOff = Boolean(attendance?.checkOutAt);
  const limits = limitsOf(capabilities);
  const startMs = Date.parse(shift.start);
  const actions: ManualAttendanceAction[] = [];
  if (!hasGuard) return actions;
  if (status === 'ready' && !bookedOn && Number.isFinite(startMs) && nowMs >= startMs - limits.windowBeforeStartHours * HOUR) {
    actions.push({
      kind: 'book_on',
      label: 'Book On for Guard',
      hint: 'The Guard could not Book On in the app. Record the time they actually started, how Control verified it, and why.',
    });
  }
  if (status === 'missed' && !bookedOn) {
    actions.push({
      kind: 'book_on',
      label: 'Book On for Guard (late arrival)',
      hint: 'This shift was marked missed. If the Guard did arrive, record their actual start time and how it was verified.',
    });
  }
  if ((status === 'in_progress' || status === 'completed') && bookedOn && !bookedOff) {
    actions.push({
      kind: 'book_off',
      label: 'Book Off for Guard',
      hint: status === 'completed'
        ? 'This shift was closed without a Book Off. If Control has since verified when the Guard left, record it.'
        : 'The Guard could not Book Off in the app. Record the time they actually left, how Control verified it, and why.',
    });
  }
  return actions;
}

// ─── the form ─────────────────────────────────────────────────────────────────────────────────────────

export interface ManualAttendanceFormInput {
  kind: ManualAttendanceKind;
  /** For a correction: which entry type is being corrected. */
  eventType?: 'check-in' | 'check-out';
  /** Site-local YYYY-MM-DD and HH:MM, exactly as the form holds them. */
  date: string;
  time: string;
  timeZone: string;
  reason: string;
  method: AttendanceVerificationMethod | null;
  note: string;
  scheduledStart: string;
  scheduledEnd: string;
  /** Effective Book On / Book Off, for ordering checks. */
  bookOnAt?: string | null;
  bookOffAt?: string | null;
  /** For a correction: the time currently recorded on the entry being corrected. */
  currentOccurredAt?: string | null;
  nowMs: number;
  capabilities?: ManualAttendanceCapabilities | null;
}

export type ManualAttendanceVerdict =
  | { ok: true; occurredAt: string; instant: number }
  | { ok: false; message: string; field: 'time' | 'reason' | 'method' | 'note' };

/** Which side of the shift an entry is: a Book On, or a Book Off. */
export function entryTypeOf(input: Pick<ManualAttendanceFormInput, 'kind' | 'eventType'>): 'check-in' | 'check-out' {
  if (input.kind === 'book_on') return 'check-in';
  if (input.kind === 'book_off') return 'check-out';
  return input.eventType ?? 'check-in';
}

/**
 * Refuses a form the API would refuse, in the same order the API checks, so the person learns it before sending.
 * The API remains authoritative (its clock, the shift under lock, overlap with other shifts).
 */
export function validateManualAttendance(input: ManualAttendanceFormInput): ManualAttendanceVerdict {
  const resolved = siteLocalToInstant(input.date, input.time, input.timeZone);
  if (!resolved.ok) return { ok: false, message: resolved.message, field: 'time' };
  const at = resolved.instant;
  const limits = limitsOf(input.capabilities);
  const tz = input.timeZone;
  const type = entryTypeOf(input);
  const word = type === 'check-in' ? 'Book On' : 'Book Off';

  if (at > input.nowMs) {
    return { ok: false, message: `The ${word} time cannot be in the future.`, field: 'time' };
  }
  const startMs = Date.parse(input.scheduledStart);
  const endMs = Date.parse(input.scheduledEnd);
  const earliest = startMs - limits.windowBeforeStartHours * HOUR;
  const latest = endMs + limits.windowAfterEndHours * HOUR;
  if (Number.isFinite(earliest) && Number.isFinite(latest) && (at < earliest || at > latest)) {
    return {
      ok: false,
      message: `The ${word} time must be between ${formatUkDateTime(new Date(earliest).toISOString(), tz)} and ${formatUkDateTime(new Date(latest).toISOString(), tz)} (${limits.windowBeforeStartHours} hours before the scheduled start to ${limits.windowAfterEndHours} hours after the scheduled end).`,
      field: 'time',
    };
  }
  if (type === 'check-out' && input.bookOnAt) {
    const on = Date.parse(input.bookOnAt);
    if (Number.isFinite(on) && at <= on) {
      return { ok: false, message: `The Book Off time must be after the Book On (${formatUkDateTime(input.bookOnAt, tz)}).`, field: 'time' };
    }
  }
  if (type === 'check-in' && input.bookOffAt) {
    const off = Date.parse(input.bookOffAt);
    if (Number.isFinite(off) && at >= off) {
      return { ok: false, message: `The Book On time must be before the Book Off (${formatUkDateTime(input.bookOffAt, tz)}).`, field: 'time' };
    }
  }
  if (input.kind === 'correct' && input.currentOccurredAt) {
    const current = Date.parse(input.currentOccurredAt);
    if (Number.isFinite(current) && Math.floor(current / 60_000) === Math.floor(at / 60_000)) {
      return { ok: false, message: 'That is the time already recorded. Enter the corrected time.', field: 'time' };
    }
  }
  if (input.capabilities && !input.capabilities.canRecordOlderThan24h && input.nowMs - at > limits.ownerAdminOnlyOlderThanHours * HOUR) {
    return {
      ok: false,
      message: `Only an Owner or Admin can record or correct attendance more than ${limits.ownerAdminOnlyOlderThanHours} hours ago.`,
      field: 'time',
    };
  }
  const reason = input.reason.trim();
  if (!reason) return { ok: false, message: 'Give the reason this is being recorded by Control.', field: 'reason' };
  if (reason.length > MANUAL_ATTENDANCE_TEXT_MAX) {
    return { ok: false, message: `The reason must be ${MANUAL_ATTENDANCE_TEXT_MAX} characters or fewer.`, field: 'reason' };
  }
  if (!input.method || !VERIFICATION_METHOD_OPTIONS.some((option) => option.value === input.method)) {
    return { ok: false, message: 'Choose how the time was verified.', field: 'method' };
  }
  const note = input.note.trim();
  if (input.method === 'other' && !note) {
    return { ok: false, message: 'Explain how the time was verified.', field: 'note' };
  }
  if (note.length > MANUAL_ATTENDANCE_TEXT_MAX) {
    return { ok: false, message: `The verification note must be ${MANUAL_ATTENDANCE_TEXT_MAX} characters or fewer.`, field: 'note' };
  }
  return { ok: true, occurredAt: new Date(at).toISOString(), instant: at };
}

/** The date and time the form opens with: the existing time for a correction, otherwise now (site-local). */
export function initialFormDateTime(timeZone: string, nowMs: number, existingIso?: string | null): { date: string; time: string } {
  const iso = existingIso && Number.isFinite(Date.parse(existingIso)) ? existingIso : new Date(nowMs).toISOString();
  return { date: formatSiteDateInput(iso, timeZone), time: formatSiteTime(iso, timeZone) };
}

/** The request body for the API. */
export function manualAttendancePayload(verdict: { occurredAt: string }, form: { reason: string; method: AttendanceVerificationMethod; note: string }) {
  const note = form.note.trim();
  return {
    occurredAt: verdict.occurredAt,
    reason: form.reason.trim(),
    verificationMethod: form.method,
    ...(note ? { verificationNote: note } : {}),
  };
}

export function manualAttendanceTitle(kind: ManualAttendanceKind, eventType?: 'check-in' | 'check-out', late = false): string {
  if (kind === 'book_on') return late ? 'Book On for Guard (late arrival)' : 'Book On for Guard';
  if (kind === 'book_off') return 'Book Off for Guard';
  return eventType === 'check-out' ? 'Correct Book Off time' : 'Correct Book On time';
}

/** What the confirmation step says will be recorded. */
export function confirmationLines(input: {
  kind: ManualAttendanceKind;
  eventType?: 'check-in' | 'check-out';
  occurredAt: string;
  timeZone: string;
  guardName: string;
  method: AttendanceVerificationMethod;
  note: string;
  reason: string;
  currentOccurredAt?: string | null;
}): string[] {
  const at = formatUkDateTime(input.occurredAt, input.timeZone);
  const how = `${verificationMethodLabel(input.method)}${input.note.trim() ? ` — ${input.note.trim()}` : ''}`;
  const lines: string[] = [];
  if (input.kind === 'book_on') {
    lines.push(`${input.guardName} will be booked on at ${at}, recorded by you on their behalf. The shift becomes In progress.`);
    lines.push('It is shown everywhere as a manual Book On, not a Guard app Book On. Welfare Checks are monitored from now, never before.');
  } else if (input.kind === 'book_off') {
    lines.push(`${input.guardName} will be booked off at ${at}, recorded by you on their behalf. The shift becomes Completed.`);
    lines.push('It is shown everywhere as a manual Book Off. The timesheet takes this time, and the Guard still submits it for the normal company approval.');
  } else {
    const word = input.eventType === 'check-out' ? 'Book Off' : 'Book On';
    lines.push(`The ${word} will be corrected${input.currentOccurredAt ? ` from ${formatUkDateTime(input.currentOccurredAt, input.timeZone)}` : ''} to ${at}.`);
    lines.push('The original entry is kept unchanged in the history; the correction becomes the effective time. A draft, submitted or returned timesheet takes the corrected time.');
  }
  lines.push(`Verified by: ${how}`);
  lines.push(`Reason: ${input.reason.trim()}`);
  return lines;
}

/** What the success banner says once the API has recorded it. */
export function manualAttendanceSuccessMessage(input: {
  kind: ManualAttendanceKind;
  eventType?: 'check-in' | 'check-out';
  shiftId: number;
  guardName: string;
  occurredAt: string;
  timeZone: string;
  timesheetRestamped?: boolean | null;
}): string {
  const at = formatUkDateTime(input.occurredAt, input.timeZone);
  if (input.kind === 'book_on') return `Shift #${input.shiftId}: Book On recorded for ${input.guardName} at ${at} (manual).`;
  if (input.kind === 'book_off') return `Shift #${input.shiftId}: Book Off recorded for ${input.guardName} at ${at} (manual).`;
  const word = input.eventType === 'check-out' ? 'Book Off' : 'Book On';
  const timesheet = input.timesheetRestamped
    ? ' The timesheet now shows the corrected time.'
    : ' No timesheet times needed updating.';
  return `Shift #${input.shiftId}: ${word} corrected to ${at}.${timesheet}`;
}

// ─── the API's answers, in words ─────────────────────────────────────────────────────────────────────

export interface ManualAttendanceErrorGuidance {
  message: string;
  /** The shift changed under us: re-read the board and the history. */
  reload: boolean;
}

/** Every refusal code the API returns for manual attendance, with the words the company web shows. */
export const MANUAL_ATTENDANCE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  MANUAL_ATTENDANCE_FORBIDDEN: 'You are not authorised to record attendance for Guards. An Owner or Admin can authorise Control Room staff.',
  MANUAL_ATTENDANCE_NOT_FOUND: 'This shift or attendance entry could not be found. It may have been removed or belongs to another company.',
  ATTENDANCE_VALIDATION: 'Check the time, reason and verification method, then try again.',
  ATTENDANCE_TIME_IN_FUTURE: 'The time cannot be in the future. Nothing was recorded.',
  ATTENDANCE_TIME_OUTSIDE_WINDOW: 'The time must be between 12 hours before the scheduled start and 12 hours after the scheduled end. Nothing was recorded.',
  ATTENDANCE_OLD_ENTRY_REQUIRES_OWNER_OR_ADMIN: 'Only an Owner or Admin can record or correct attendance more than 24 hours ago. Nothing was recorded.',
  ATTENDANCE_BOOK_OFF_BEFORE_BOOK_ON: 'The Book Off must be after the Book On. Nothing was recorded.',
  MANUAL_BOOK_ON_STATUS: 'This shift cannot be booked on now (it is not Ready or Missed). Nothing was recorded.',
  MANUAL_BOOK_OFF_STATUS: 'This shift cannot be booked off now (it is not in progress). Nothing was recorded.',
  ATTENDANCE_NO_GUARD: 'This shift has no Guard assigned. Nothing was recorded.',
  ATTENDANCE_ALREADY_BOOKED_ON: 'A Book On is already recorded for this shift. The latest details have been loaded.',
  ATTENDANCE_NOT_BOOKED_ON: 'This shift has no Book On, so it cannot be booked off. Nothing was recorded.',
  ATTENDANCE_ALREADY_BOOKED_OFF: 'A Book Off is already recorded for this shift. The latest details have been loaded.',
  ATTENDANCE_OVERLAP: "That time overlaps the Guard's attendance on another shift. Nothing was recorded.",
  ATTENDANCE_GUARD_INELIGIBLE: 'The Guard is not currently cleared to work for this company, so they cannot be booked on.',
  ATTENDANCE_CORRECTION_NOT_TIP: 'This entry has already been corrected. Correct the latest entry instead — the latest details have been loaded.',
  ATTENDANCE_CORRECTION_UNCHANGED: 'That is the time already recorded. Enter the corrected time.',
  ATTENDANCE_TIMESHEET_LOCKED: "The shift's timesheet is approved, rejected or in a payroll batch, so its attendance can no longer be changed. Nothing was recorded.",
  ATTENDANCE_CONFLICT: 'Someone else changed this shift at the same time. Nothing was recorded — the latest details have been loaded; try again.',
};

const RELOAD_CODES = new Set([
  'ATTENDANCE_ALREADY_BOOKED_ON', 'ATTENDANCE_ALREADY_BOOKED_OFF', 'ATTENDANCE_CORRECTION_NOT_TIP', 'ATTENDANCE_CONFLICT',
  'MANUAL_BOOK_ON_STATUS', 'MANUAL_BOOK_OFF_STATUS', 'MANUAL_ATTENDANCE_NOT_FOUND', 'ATTENDANCE_TIMESHEET_LOCKED',
]);

/** Codes whose server message carries specifics worth showing beside our words (overlap, ineligibility). */
const DETAIL_CODES = new Set(['ATTENDANCE_GUARD_INELIGIBLE', 'ATTENDANCE_OVERLAP', 'ATTENDANCE_VALIDATION', 'ATTENDANCE_TIME_OUTSIDE_WINDOW']);

export function manualAttendanceErrorGuidance(error: unknown): ManualAttendanceErrorGuidance {
  const e = error as { status?: number; body?: unknown } | null;
  if (!e || typeof e.status !== 'number') {
    return { message: 'S4 could not be reached. Nothing was recorded. Check the connection and try again.', reload: false };
  }
  const body = (e.body && typeof e.body === 'object' ? e.body : {}) as { code?: unknown; message?: unknown };
  const code = typeof body.code === 'string' ? body.code : null;
  const apiMessage = typeof body.message === 'string' && body.message.trim() ? body.message.trim()
    : Array.isArray(body.message) ? body.message.join(', ') : null;
  if (code && MANUAL_ATTENDANCE_ERROR_MESSAGES[code]) {
    const words = MANUAL_ATTENDANCE_ERROR_MESSAGES[code];
    const message = DETAIL_CODES.has(code) && apiMessage && apiMessage !== words ? `${words} (${apiMessage})` : words;
    return { message, reload: RELOAD_CODES.has(code) };
  }
  if (e.status === 404 && !code) return { message: MANUAL_ATTENDANCE_UNAVAILABLE_NOTE, reload: false };
  if (e.status === 403) return { message: apiMessage && code ? apiMessage : MANUAL_ATTENDANCE_ERROR_MESSAGES.MANUAL_ATTENDANCE_FORBIDDEN, reload: false };
  if (e.status === 401) return { message: 'Your session has ended. Sign in again to continue.', reload: false };
  if (e.status === 409) return { message: apiMessage ?? MANUAL_ATTENDANCE_ERROR_MESSAGES.ATTENDANCE_CONFLICT, reload: true };
  if (e.status >= 500) return { message: 'S4 could not complete this right now. Nothing was recorded. Try again shortly.', reload: false };
  return { message: apiMessage ?? 'S4 could not record this attendance.', reload: false };
}

// ─── history ──────────────────────────────────────────────────────────────────────────────────────────

export type AttendanceBadge = 'Guard app' | 'Manual' | 'Correction' | 'Corrected' | 'Superseded' | 'Effective';

export interface AttendanceHistoryRow {
  id: number;
  type: 'check-in' | 'check-out';
  title: string;
  time: string;
  badges: AttendanceBadge[];
  detail: string[];
  /** Only the chain tip (the effective entry) can be corrected. */
  correctable: boolean;
  event: AttendanceEventView;
}

/**
 * The full append-only chain, oldest first: every original and every correction, each saying where it came from.
 * A superseded entry is shown, never hidden: it is the record of what was first said.
 */
export function attendanceHistoryRows(history: AttendanceHistory | null | undefined, timeZone: string): AttendanceHistoryRow[] {
  if (!history?.events?.length) return [];
  const ordered = [...history.events].sort((a, b) => {
    const byRecorded = Date.parse(a.recordedAt ?? a.occurredAt) - Date.parse(b.recordedAt ?? b.occurredAt);
    return byRecorded !== 0 && Number.isFinite(byRecorded) ? byRecorded : a.id - b.id;
  });
  return ordered.map((event) => {
    const word = event.type === 'check-in' ? 'Book On' : 'Book Off';
    const badges: AttendanceBadge[] = [event.source === 'manual' ? 'Manual' : 'Guard app'];
    if (event.isCorrection) badges.push('Correction');
    if (event.correctedByEventId != null || !event.effective) badges.push('Superseded');
    else {
      if (event.isCorrection) badges.push('Corrected');
      badges.push('Effective');
    }
    const detail: string[] = [];
    if (event.source === 'manual') {
      detail.push(`Recorded by ${event.recordedByName || 'company staff'}${event.recordedAt ? ` at ${formatUkDateTime(event.recordedAt, timeZone)}` : ''}`);
      detail.push(`Verified by: ${verificationMethodLabel(event.verificationMethod)}${event.verificationNote ? ` — ${event.verificationNote}` : ''}`);
      if (event.reason) detail.push(`Reason: ${event.reason}`);
    } else {
      const evidence = [event.gpsVerified ? 'GPS verified' : null, event.nfcVerified ? 'NFC verified' : null].filter(Boolean);
      detail.push(`Recorded by the Guard in the S4 app${evidence.length ? ` · ${evidence.join(' · ')}` : ''}`);
    }
    if (event.correctionOfEventId != null) detail.push(`Corrects entry #${event.correctionOfEventId}`);
    if (event.correctedByEventId != null) detail.push(`Superseded by entry #${event.correctedByEventId}`);
    return {
      id: event.id,
      type: event.type,
      title: event.isCorrection ? `${word} (correction)` : word,
      time: formatUkDateTime(event.occurredAt, timeZone),
      badges,
      detail,
      correctable: event.effective && event.correctedByEventId == null,
      event,
    };
  });
}

// ─── Live Operations and timesheets ──────────────────────────────────────────────────────────────────

/** Small badges beside Book On / Book Off on the board. Nothing when the block is absent (an older backend). */
export function operationsAttendanceBadges(view: OperationsAttendanceView | null | undefined): {
  bookOn: 'Manual' | 'Corrected' | null;
  bookOff: 'Manual' | 'Corrected' | null;
} {
  if (!view) return { bookOn: null, bookOff: null };
  const badge = (source: string | null, corrected: boolean) => (corrected ? 'Corrected' : source === 'manual' ? 'Manual' : null);
  return { bookOn: badge(view.bookOnSource, !!view.bookOnCorrected), bookOff: badge(view.bookOffSource, !!view.bookOffCorrected) };
}

/** Informational timesheet label. No approval rule depends on it. */
export function timesheetSourceLabel(verifiedSource: string | null | undefined): string | null {
  if (verifiedSource === 'manual') return 'Manual attendance';
  if (verifiedSource === 'corrected') return 'Corrected attendance';
  return null;
}

/**
 * The attendance rows the board should read: the effective ones. A superseded row (effective === false) is history,
 * not the time the Guard started or left. Rows from a backend without manual attendance carry no flag and all count.
 */
export function effectiveAttendanceEvents<T extends Pick<AttendanceEvent, 'effective'>>(events: readonly T[]): T[] {
  return events.filter((event) => event.effective !== false);
}
