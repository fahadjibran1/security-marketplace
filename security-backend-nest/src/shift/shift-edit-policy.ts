/**
 * What a company may change on an existing shift, and when. (Security remediation, owner-approved 20 Oct 2026.)
 *
 * A shift's scheduled times, site and Welfare Check interval are the frame every welfare window, Live
 * Operations row, report and export is graded against. Once the shift is being worked, has been worked, or
 * has been decided (missed, cancelled, declined), they are part of its record: correcting them is not an
 * ordinary edit. Notes and instructions are commentary and stay editable.
 */
export const SCHEDULE_LOCKED_STATUSES: ReadonlySet<string> = new Set([
  'in_progress',
  'completed',
  'missed',
  'cancelled',
  'rejected',
]);

/**
 * Status changes only the Guard (accept / decline through /shifts/:id/respond) or the attendance record
 * (Book On) may make. A company editing the shift into one of these would be acting as the Guard, or
 * starting work that has no Book On behind it.
 */
export const COMPANY_FORBIDDEN_TRANSITIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  offered: {
    ready: 'Only the Guard can accept a shift offer.',
    rejected: 'Only the Guard can decline a shift offer. Withdraw the offer by cancelling it instead.',
  },
  ready: {
    in_progress: 'A shift starts when the Guard books on. It cannot be started by editing the shift.',
  },
};

/** A shift with no Book On may be marked missed this long after its scheduled start (as Live Operations does). */
export const MISSED_SHIFT_GRACE_MINUTES = 15;

/**
 * Shifts that may be deleted: never worked and never decided. Anything else is history — cancel it instead.
 * Deletion also cascades to attendance and Welfare Check logs in the database, which is why evidence is
 * checked as well as status.
 */
export const DELETABLE_STATUSES: ReadonlySet<string> = new Set(['unfilled', 'offered', 'cancelled']);

/** The fields a shift edit is audited on. Dates are recorded as ISO instants. */
export interface ShiftAuditSnapshot {
  start: string;
  end: string;
  siteId: number | null;
  guardId: number | null;
  status: string;
  checkCallIntervalMinutes: number | null;
  instructions: string | null;
  closeOutNotes: string | null;
}

export function shiftAuditSnapshot(shift: {
  start: Date;
  end: Date;
  site?: { id: number } | null;
  guard?: { id: number } | null;
  status: string;
  checkCallIntervalMinutes?: number | null;
  instructions?: string | null;
  closeOutNotes?: string | null;
}): ShiftAuditSnapshot {
  return {
    start: new Date(shift.start).toISOString(),
    end: new Date(shift.end).toISOString(),
    siteId: shift.site?.id ?? null,
    guardId: shift.guard?.id ?? null,
    status: shift.status,
    checkCallIntervalMinutes: shift.checkCallIntervalMinutes ?? null,
    instructions: shift.instructions ?? null,
    closeOutNotes: shift.closeOutNotes ?? null,
  };
}

/** Only the fields that changed, before and after. Empty when nothing did. */
export function changedFields(
  before: ShiftAuditSnapshot,
  after: ShiftAuditSnapshot,
): { before: Partial<ShiftAuditSnapshot>; after: Partial<ShiftAuditSnapshot> } {
  const b: Partial<ShiftAuditSnapshot> = {};
  const a: Partial<ShiftAuditSnapshot> = {};
  for (const key of Object.keys(before) as Array<keyof ShiftAuditSnapshot>) {
    if (before[key] !== after[key]) {
      (b as Record<string, unknown>)[key] = before[key];
      (a as Record<string, unknown>)[key] = after[key];
    }
  }
  return { before: b, after: a };
}
