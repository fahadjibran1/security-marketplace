/**
 * Verified attendance beside the Guard's timesheet (owner-approved, 27 Oct 2026). Pure: no I/O, no clock.
 *
 * A timesheet holds two different things that used to share columns:
 *
 *   - the Guard's CLAIM: actualCheckInAt / actualCheckOutAt and hoursWorked / workedMinutes / roundedMinutes. Pre-filled
 *     from attendance when the Guard has not entered anything, editable by the Guard while the timesheet is a draft or
 *     returned, and never overwritten by attendance once the Guard has entered a value;
 *   - the VERIFIED attendance: the effective Book On / Book Off of the shift's append-only attendance events (Guard app,
 *     manual, or corrected — see effective-attendance.ts). It is read from those events, never stored as a claim, and
 *     its duration is persisted as verifiedMinutes (the approval default) while the timesheet is still open.
 *
 * This module compares the two so a reviewer sees where they differ. It never changes either, never gates an action
 * and adds no approval rule: the existing submission, return and approval workflow decides worked hours.
 */

/** A difference above this many minutes, at the start, the end or in total, is highlighted for the reviewer. */
export const TIMESHEET_ATTENDANCE_TOLERANCE_MINUTES = 10;

export type TimesheetAttendanceField = 'start' | 'end' | 'total';

export interface TimesheetAttendanceDiscrepancy {
  /** What the verified attendance is compared with: the Guard's claim (open timesheet) or the approved timesheet. */
  comparedWith: 'guard_claim' | 'approved';
  toleranceMinutes: number;
  /** Signed minutes, claimed/approved minus verified (positive: the claim starts later / ends later / is longer). */
  startDifferenceMinutes: number | null;
  endDifferenceMinutes: number | null;
  totalDifferenceMinutes: number | null;
  /** The comparisons whose difference exceeds the tolerance. */
  fields: TimesheetAttendanceField[];
  exceedsTolerance: boolean;
}

export interface TimesheetAttendanceInput {
  approvalStatus: string | null | undefined;
  verifiedCheckInAt: Date | null;
  verifiedCheckOutAt: Date | null;
  claimedCheckInAt?: Date | string | null;
  claimedCheckOutAt?: Date | string | null;
  claimedHours?: number | string | null;
  approvedMinutes?: number | string | null;
  approvedHours?: number | string | null;
  approvedStartAt?: Date | string | null;
  approvedEndAt?: Date | string | null;
}

const ms = (value: Date | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
};
const num = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const minutesBetween = (a: number, b: number) => Math.round((a - b) / 60000);

/**
 * Approved, rejected or in a payroll batch: the timesheet is settled and attendance never writes to it (the same rule
 * as manual-attendance-policy.ts timesheetLockedForAttendance). Only draft, submitted and returned timesheets follow
 * attendance.
 */
export function timesheetIsSettled(timesheet: {
  approvalStatus?: string | null;
  payrollBatch?: { id: number } | null;
  payrollBatchId?: number | null;
}): boolean {
  const status = String(timesheet.approvalStatus ?? '').trim().toLowerCase();
  const batched = (timesheet.payrollBatch !== null && timesheet.payrollBatch !== undefined)
    || (timesheet.payrollBatchId !== null && timesheet.payrollBatchId !== undefined);
  return !['draft', 'submitted', 'returned'].includes(status) || batched;
}

/** The Guard has entered hours (0 is the untouched default of a new timesheet). */
export function guardHasClaimedHours(timesheet: { hoursWorked?: number | string | null; workedMinutes?: number | string | null }): boolean {
  return (num(timesheet.hoursWorked) ?? 0) > 0 || (num(timesheet.workedMinutes) ?? 0) > 0;
}

/** The verified duration in whole minutes (null until both Book On and Book Off are known). */
export function verifiedAttendanceMinutes(checkInAt: Date | null, checkOutAt: Date | null): number | null {
  if (!checkInAt || !checkOutAt) return null;
  return Math.max(0, Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60000));
}

/**
 * Where verified attendance and the timesheet differ. Null when there is nothing to compare: no verified Book On, a
 * rejected timesheet, or nothing on the other side yet (no claimed times or hours, nothing approved).
 */
export function timesheetAttendanceDiscrepancy(
  input: TimesheetAttendanceInput,
  toleranceMinutes = TIMESHEET_ATTENDANCE_TOLERANCE_MINUTES,
): TimesheetAttendanceDiscrepancy | null {
  const status = String(input.approvalStatus ?? '').trim().toLowerCase();
  if (status === 'rejected') return null;
  const onMs = input.verifiedCheckInAt ? input.verifiedCheckInAt.getTime() : null;
  if (onMs === null) return null;
  const offMs = input.verifiedCheckOutAt ? input.verifiedCheckOutAt.getTime() : null;
  const verifiedTotal = verifiedAttendanceMinutes(input.verifiedCheckInAt, input.verifiedCheckOutAt);

  const approved = status === 'approved';
  let startMs: number | null;
  let endMs: number | null;
  let total: number | null;
  if (approved) {
    startMs = ms(input.approvedStartAt);
    endMs = ms(input.approvedEndAt);
    const minutes = num(input.approvedMinutes);
    const hours = num(input.approvedHours);
    total = minutes !== null ? Math.round(minutes) : hours !== null ? Math.round(hours * 60) : null;
  } else {
    startMs = ms(input.claimedCheckInAt);
    endMs = ms(input.claimedCheckOutAt);
    const hours = num(input.claimedHours);
    // 0 h is the untouched default of a new timesheet, not a claim of no work.
    total = hours !== null && hours > 0 ? Math.round(hours * 60) : null;
  }

  const startDifferenceMinutes = startMs !== null ? minutesBetween(startMs, onMs) : null;
  const endDifferenceMinutes = endMs !== null && offMs !== null ? minutesBetween(endMs, offMs) : null;
  const totalDifferenceMinutes = total !== null && verifiedTotal !== null ? total - verifiedTotal : null;
  if (startDifferenceMinutes === null && endDifferenceMinutes === null && totalDifferenceMinutes === null) return null;

  const fields: TimesheetAttendanceField[] = [];
  if (startDifferenceMinutes !== null && Math.abs(startDifferenceMinutes) > toleranceMinutes) fields.push('start');
  if (endDifferenceMinutes !== null && Math.abs(endDifferenceMinutes) > toleranceMinutes) fields.push('end');
  if (totalDifferenceMinutes !== null && Math.abs(totalDifferenceMinutes) > toleranceMinutes) fields.push('total');
  return {
    comparedWith: approved ? 'approved' : 'guard_claim',
    toleranceMinutes,
    startDifferenceMinutes,
    endDifferenceMinutes,
    totalDifferenceMinutes,
    fields,
    exceedsTolerance: fields.length > 0,
  };
}
