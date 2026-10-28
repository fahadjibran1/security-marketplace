/**
 * Verified attendance beside the Guard's timesheet (owner-approved, 27 Oct 2026). Pure presentation: no I/O, no clock.
 *
 * The server sends, on every timesheet it lists, the shift's VERIFIED Book On / Book Off (its effective attendance
 * events: Guard app, manual or corrected), their duration, and `attendanceDiscrepancy` — where they differ from the
 * Guard's claim (an open timesheet) or from the approved timesheet, judged against the server's tolerance. The Guard's
 * claim stays in actualCheckInAt / actualCheckOutAt / hoursWorked and is never replaced by the verified values.
 *
 * Informational only: nothing here gates approve, return or reject. The existing review decides worked hours.
 * A backend without this feature sends none of these fields; then nothing new is shown.
 */

export type TimesheetAttendanceField = 'start' | 'end' | 'total';

export interface TimesheetAttendanceDiscrepancy {
  comparedWith: 'guard_claim' | 'approved';
  toleranceMinutes: number;
  startDifferenceMinutes: number | null;
  endDifferenceMinutes: number | null;
  totalDifferenceMinutes: number | null;
  fields: TimesheetAttendanceField[];
  exceedsTolerance: boolean;
}

export interface TimesheetAttendanceFields {
  approvalStatus?: string | null;
  verifiedCheckInAt?: string | null;
  verifiedCheckOutAt?: string | null;
  verifiedAttendanceMinutes?: number | null;
  attendanceDiscrepancy?: TimesheetAttendanceDiscrepancy | null;
}

export interface VerifiedAttendanceView {
  /** The server sent verified attendance (a backend without the feature does not). */
  supported: boolean;
  bookOnLabel: string;
  bookOffLabel: string;
  durationLabel: string;
  flagged: boolean;
  /** Short badge for the review table row. */
  badge: string | null;
  flagTitle: string | null;
  /** One line per comparison over the tolerance, in words. */
  flagLines: string[];
  toleranceNote: string | null;
}

/** "7 h 35 min", "45 min", "8 h". */
export function formatDurationMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) return '—';
  const total = Math.round(Math.abs(Number(minutes)));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export type TimesheetAttendanceAudience = 'company' | 'guard';

function differenceLine(
  field: TimesheetAttendanceField,
  minutes: number,
  comparedWith: TimesheetAttendanceDiscrepancy['comparedWith'],
  audience: TimesheetAttendanceAudience,
): string {
  const whose = comparedWith === 'approved' ? 'Approved' : audience === 'guard' ? 'Your' : "Guard's";
  const amount = formatDurationMinutes(minutes);
  if (field === 'total') {
    return `${whose} total is ${amount} ${minutes > 0 ? 'more' : 'less'} than the verified attendance`;
  }
  const point = field === 'start' ? 'start' : 'finish';
  const event = field === 'start' ? 'Book On' : 'Book Off';
  return `${whose} ${point} is ${amount} ${minutes > 0 ? 'after' : 'before'} the verified ${event}`;
}

export function verifiedAttendanceView(
  timesheet: TimesheetAttendanceFields,
  formatTime: (iso: string | null | undefined) => string,
  audience: TimesheetAttendanceAudience = 'company',
): VerifiedAttendanceView {
  const supported = timesheet.verifiedCheckInAt !== undefined || timesheet.attendanceDiscrepancy !== undefined;
  const bookOnLabel = timesheet.verifiedCheckInAt ? formatTime(timesheet.verifiedCheckInAt) : 'Not recorded';
  const bookOffLabel = timesheet.verifiedCheckOutAt ? formatTime(timesheet.verifiedCheckOutAt) : 'Not recorded';
  const durationLabel = formatDurationMinutes(timesheet.verifiedAttendanceMinutes ?? null);
  const d = timesheet.attendanceDiscrepancy ?? null;
  const flagged = Boolean(d && d.exceedsTolerance && d.fields.length > 0);
  const flagLines: string[] = [];
  if (d && flagged) {
    const value: Record<TimesheetAttendanceField, number | null> = {
      start: d.startDifferenceMinutes, end: d.endDifferenceMinutes, total: d.totalDifferenceMinutes,
    };
    for (const field of d.fields) {
      const minutes = value[field];
      if (minutes !== null && minutes !== undefined && minutes !== 0) flagLines.push(differenceLine(field, minutes, d.comparedWith, audience));
    }
  }
  return {
    supported,
    bookOnLabel,
    bookOffLabel,
    durationLabel,
    flagged,
    badge: flagged ? (d!.comparedWith === 'approved' ? 'Differs from approved' : 'Differs from verified') : null,
    flagTitle: flagged
      ? d!.comparedWith === 'approved'
        ? 'Verified attendance differs from the approved timesheet'
        : audience === 'guard'
          ? 'Your timesheet differs from your recorded Book On / Book Off'
          : "Verified attendance differs from the Guard's timesheet"
      : null,
    flagLines,
    toleranceNote: flagged
      ? audience === 'guard'
        ? 'Your company will review it. Add a note if your times are right.'
        : `Highlighted when a difference is more than ${d!.toleranceMinutes} minutes. For review only — the approval workflow is unchanged.`
      : null,
  };
}
