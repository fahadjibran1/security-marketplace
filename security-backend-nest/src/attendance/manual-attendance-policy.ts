import { HttpException, HttpStatus } from '@nestjs/common';
import { CompanyMembershipRole, CompanyPermission, hasPermission } from '../company-membership/company-membership-types';
import { ATTENDANCE_VERIFICATION_METHODS, AttendanceVerificationMethod } from './entities/attendance.entity';

/**
 * Manual attendance management (S4 Part B, owner-approved 27 Oct 2026). Pure rules only: no I/O here.
 *
 * Authorised company staff record a Book On / Book Off for a Guard who could not use the app, and correct a recorded
 * time. Every record states the ACTUAL time (occurredAt), is stamped with the server time it was recorded and the user
 * who recorded it, and carries a reason and how the attendance was verified. Original rows are never changed: a
 * correction is a new row, and the effective value is the latest correction (see effective-attendance.ts).
 *
 * Worked hours are confirmed through the EXISTING Guard timesheet submission and company approval: there is no
 * separate manual-attendance approval queue and no extra approval rule (owner decision, 27 Oct 2026).
 */

// ── Owner-set limits (named so they are easy to change) ───────────────────────────────────────────────

/** A manual time may be at most this long before the scheduled start (owner decision 27 Oct 2026: 12 h). */
export const MANUAL_ATTENDANCE_WINDOW_BEFORE_START_HOURS = 12;
/** …and at most this long after the scheduled end (owner decision 27 Oct 2026: 12 h). */
export const MANUAL_ATTENDANCE_WINDOW_AFTER_END_HOURS = 12;
/** An entry or correction whose actual time is older than this needs an Owner or Admin (owner decision: 24 h). */
export const MANUAL_ATTENDANCE_OWNER_ADMIN_ONLY_OLDER_THAN_HOURS = 24;
/** Longest reason / verification note accepted. */
export const MANUAL_ATTENDANCE_TEXT_MAX = 500;

export const MANUAL_ATTENDANCE_ERROR_CODES = {
  FORBIDDEN: 'MANUAL_ATTENDANCE_FORBIDDEN',
  NOT_FOUND: 'MANUAL_ATTENDANCE_NOT_FOUND',
  VALIDATION: 'ATTENDANCE_VALIDATION',
  TIME_IN_FUTURE: 'ATTENDANCE_TIME_IN_FUTURE',
  TIME_OUTSIDE_WINDOW: 'ATTENDANCE_TIME_OUTSIDE_WINDOW',
  OLD_ENTRY_REQUIRES_OWNER_OR_ADMIN: 'ATTENDANCE_OLD_ENTRY_REQUIRES_OWNER_OR_ADMIN',
  BOOK_OFF_BEFORE_BOOK_ON: 'ATTENDANCE_BOOK_OFF_BEFORE_BOOK_ON',
  BOOK_ON_STATUS: 'MANUAL_BOOK_ON_STATUS',
  BOOK_OFF_STATUS: 'MANUAL_BOOK_OFF_STATUS',
  NO_GUARD: 'ATTENDANCE_NO_GUARD',
  ALREADY_BOOKED_ON: 'ATTENDANCE_ALREADY_BOOKED_ON',
  NOT_BOOKED_ON: 'ATTENDANCE_NOT_BOOKED_ON',
  ALREADY_BOOKED_OFF: 'ATTENDANCE_ALREADY_BOOKED_OFF',
  OVERLAP: 'ATTENDANCE_OVERLAP',
  GUARD_INELIGIBLE: 'ATTENDANCE_GUARD_INELIGIBLE',
  CORRECTION_NOT_TIP: 'ATTENDANCE_CORRECTION_NOT_TIP',
  CORRECTION_UNCHANGED: 'ATTENDANCE_CORRECTION_UNCHANGED',
  TIMESHEET_LOCKED: 'ATTENDANCE_TIMESHEET_LOCKED',
  CONFLICT: 'ATTENDANCE_CONFLICT',
} as const;
export type ManualAttendanceErrorCode = (typeof MANUAL_ATTENDANCE_ERROR_CODES)[keyof typeof MANUAL_ATTENDANCE_ERROR_CODES];

/** A refusal with a machine-readable code the web app turns into words. */
export function attendanceError(status: HttpStatus, code: ManualAttendanceErrorCode, message: string, details?: Record<string, unknown>) {
  return new HttpException({ statusCode: status, code, message, ...(details ? { details } : {}) }, status);
}

// ── Who may do what ───────────────────────────────────────────────────────────────────────────────────

/**
 * Owner, Admin and Operations by role (attendance.manage). A Control Room member ONLY when individually authorised
 * by an Owner or Admin (canManageAttendance), and that grant allows nothing else. HR, Finance and Viewer never.
 */
export function mayManageAttendance(role: CompanyMembershipRole, canManageAttendance: boolean): boolean {
  if (hasPermission(role, CompanyPermission.ATTENDANCE_MANAGE)) return true;
  return role === CompanyMembershipRole.CONTROL_ROOM && canManageAttendance;
}

export function mayRecordOldAttendance(role: CompanyMembershipRole): boolean {
  return role === CompanyMembershipRole.OWNER || role === CompanyMembershipRole.ADMIN;
}

// ── Input ─────────────────────────────────────────────────────────────────────────────────────────────

export type ManualAttendanceInput = {
  occurredAt: string;
  reason: string;
  verificationMethod: string;
  verificationNote?: string | null;
};

export type ValidManualAttendance = {
  occurredAtMs: number;
  reason: string;
  verificationMethod: AttendanceVerificationMethod;
  verificationNote: string | null;
};

const E = MANUAL_ATTENDANCE_ERROR_CODES;

/** Trims and checks the stated time, reason and verification. Refuses with ATTENDANCE_VALIDATION (400). */
export function validateManualAttendanceInput(input: ManualAttendanceInput): ValidManualAttendance {
  const bad = (message: string) => attendanceError(HttpStatus.BAD_REQUEST, E.VALIDATION, message);
  const raw = typeof input.occurredAt === 'string' ? input.occurredAt.trim() : '';
  // An explicit instant only: a time with no zone would be read in whatever zone the server runs in.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw bad('Give the actual time as a full date and time with its time zone (for example 2026-10-27T08:05:00Z).');
  }
  const occurredAtMs = new Date(raw).getTime();
  if (!Number.isFinite(occurredAtMs)) throw bad('The actual time is not a valid date and time.');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw bad('Give a reason for recording this attendance.');
  if (reason.length > MANUAL_ATTENDANCE_TEXT_MAX) throw bad(`The reason must be ${MANUAL_ATTENDANCE_TEXT_MAX} characters or fewer.`);
  const method = typeof input.verificationMethod === 'string' ? input.verificationMethod.trim() : '';
  if (!(ATTENDANCE_VERIFICATION_METHODS as readonly string[]).includes(method)) {
    throw bad('Choose how the attendance was verified.');
  }
  const note = typeof input.verificationNote === 'string' ? input.verificationNote.trim() : '';
  if (note.length > MANUAL_ATTENDANCE_TEXT_MAX) throw bad(`The verification note must be ${MANUAL_ATTENDANCE_TEXT_MAX} characters or fewer.`);
  if (method === 'other' && !note) throw bad('Describe how the attendance was verified.');
  return { occurredAtMs, reason, verificationMethod: method as AttendanceVerificationMethod, verificationNote: note || null };
}

/**
 * The time rules every manual entry and correction obeys, in the order a person can act on them:
 *   never in the future; within [scheduled start − 12 h, scheduled end + 12 h]; older than 24 h needs Owner / Admin.
 * `olderReferenceMs` lets a correction apply the 24-hour rule to the time being replaced as well.
 */
export function assertManualTimeAllowed(input: {
  occurredAtMs: number;
  nowMs: number;
  scheduledStartMs: number;
  scheduledEndMs: number;
  role: CompanyMembershipRole;
  olderReferenceMs?: number | null;
}): void {
  if (input.occurredAtMs > input.nowMs) {
    throw attendanceError(HttpStatus.UNPROCESSABLE_ENTITY, E.TIME_IN_FUTURE, 'The actual time cannot be in the future.');
  }
  const earliest = input.scheduledStartMs - MANUAL_ATTENDANCE_WINDOW_BEFORE_START_HOURS * 3_600_000;
  const latest = input.scheduledEndMs + MANUAL_ATTENDANCE_WINDOW_AFTER_END_HOURS * 3_600_000;
  if (input.occurredAtMs < earliest || input.occurredAtMs > latest) {
    throw attendanceError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      E.TIME_OUTSIDE_WINDOW,
      `The actual time must be between ${MANUAL_ATTENDANCE_WINDOW_BEFORE_START_HOURS} hours before the scheduled start and ` +
        `${MANUAL_ATTENDANCE_WINDOW_AFTER_END_HOURS} hours after the scheduled end.`,
      { earliest: new Date(earliest).toISOString(), latest: new Date(latest).toISOString() },
    );
  }
  const oldBefore = input.nowMs - MANUAL_ATTENDANCE_OWNER_ADMIN_ONLY_OLDER_THAN_HOURS * 3_600_000;
  const oldest = Math.min(input.occurredAtMs, input.olderReferenceMs ?? input.occurredAtMs);
  if (oldest < oldBefore && !mayRecordOldAttendance(input.role)) {
    throw attendanceError(
      HttpStatus.FORBIDDEN,
      E.OLD_ENTRY_REQUIRES_OWNER_OR_ADMIN,
      `Attendance more than ${MANUAL_ATTENDANCE_OWNER_ADMIN_ONLY_OLDER_THAN_HOURS} hours old can only be recorded or corrected by an Owner or Admin.`,
    );
  }
}

/** Whether two attendance intervals overlap. An open interval (no end) runs on indefinitely. Touching ends do not overlap. */
export function intervalsOverlap(a: { from: number; to: number | null }, b: { from: number; to: number | null }): boolean {
  const aTo = a.to ?? Number.POSITIVE_INFINITY;
  const bTo = b.to ?? Number.POSITIVE_INFINITY;
  // A zero-length interval is a point: it overlaps an interval that strictly contains it.
  if (a.from === aTo) return a.from > b.from && a.from < bTo;
  if (b.from === bTo) return b.from > a.from && b.from < aTo;
  return a.from < bTo && b.from < aTo;
}

/**
 * Closed shift statuses whose attendance with no Book Off is bounded by the scheduled end for the overlap check.
 * Any other status (in_progress above all, and anything not clearly closed) keeps an open Book On open-ended.
 */
export const OVERLAP_PROVISIONAL_END_STATUSES: ReadonlySet<string> = new Set(['completed', 'missed', 'cancelled', 'rejected']);

/**
 * Where another shift's attendance ENDS for the overlap check (owner decision 27 Oct 2026).
 *   - a verified (effective) Book Off: that time;
 *   - no Book Off and the shift is still in progress (or not clearly closed): open-ended (null);
 *   - no Book Off and the shift is closed (e.g. completed by Close without Book Off, missed, cancelled): its current
 *     scheduled end (after any approved extension) as a PROVISIONAL boundary — never written or shown as attendance.
 *     A Book On after that scheduled end is a point at the Book On.
 */
export function overlapBoundary(input: {
  bookOnAtMs: number;
  bookOffAtMs: number | null;
  status: string;
  scheduledEndMs: number;
}): { to: number | null; provisional: boolean } {
  if (input.bookOffAtMs !== null) return { to: input.bookOffAtMs, provisional: false };
  const status = String(input.status ?? '').trim().toLowerCase();
  if (!OVERLAP_PROVISIONAL_END_STATUSES.has(status) || !Number.isFinite(input.scheduledEndMs)) return { to: null, provisional: false };
  return { to: Math.max(input.scheduledEndMs, input.bookOnAtMs), provisional: true };
}

/** Timesheet states in which verified actuals may still change (owner: approved and payroll-batched stay locked). */
export function timesheetLockedForAttendance(row: { approvalStatus: string; payrollBatchId: number | null }): boolean {
  const status = String(row.approvalStatus ?? '').trim().toLowerCase();
  return !['draft', 'submitted', 'returned'].includes(status) || row.payrollBatchId !== null;
}
