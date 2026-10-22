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
 * Statuses in which a shift holds its Guard's time and may still be retimed. Retiming one re-runs the Guard's full
 * eligibility check against the new window (Phase 0b, owner-approved 22 Oct 2026).
 */
export const RETIME_CHECKED_STATUSES: ReadonlySet<string> = new Set([
  'scheduled',
  'offered',
  'ready',
]);

/**
 * Material-change re-acceptance (owner-approved 22 Oct 2026). A Guard accepted a shift on its start, end and site.
 * Any actual change to one of those, by any amount, returns an accepted ('ready') shift to the same Guard as a
 * revised offer ('offered'): it is not confirmed again until the Guard accepts it. Notes, instructions and the
 * Welfare Check interval are not material. Reassigning to another Guard is a separate, controlled workflow.
 */
export const REACCEPTANCE_REASON = 'material_change';
export const REACCEPTANCE_AUDIT_ACTION = 'shift.reacceptance_required';

export type MaterialShiftTerms = { start: Date; end: Date; siteId: number | null };
export type MaterialField = 'start' | 'end' | 'siteId';

/** Which of start, end and site actually differ. Empty when the accepted terms still stand. */
export function materialChanges(before: MaterialShiftTerms, after: MaterialShiftTerms): MaterialField[] {
  const fields: MaterialField[] = [];
  if (new Date(before.start).getTime() !== new Date(after.start).getTime()) fields.push('start');
  if (new Date(before.end).getTime() !== new Date(after.end).getTime()) fields.push('end');
  if ((before.siteId ?? null) !== (after.siteId ?? null)) fields.push('siteId');
  return fields;
}

/** The audit entry for one re-offer: the accepted terms, the revised terms, and why. */
export function reacceptanceAuditData(params: {
  guardId: number;
  accepted: MaterialShiftTerms;
  revised: MaterialShiftTerms;
  changedFields: MaterialField[];
  via: 'shift.update' | 'rota_slot.time_changed';
  rotaSlotId?: number | null;
}): { beforeData: Record<string, unknown>; afterData: Record<string, unknown> } {
  const terms = (t: MaterialShiftTerms) => ({
    start: new Date(t.start).toISOString(),
    end: new Date(t.end).toISOString(),
    siteId: t.siteId ?? null,
  });
  return {
    beforeData: { status: 'ready', guardId: params.guardId, ...terms(params.accepted) },
    afterData: {
      status: 'offered',
      guardId: params.guardId,
      ...terms(params.revised),
      reason: REACCEPTANCE_REASON,
      changedFields: params.changedFields,
      via: params.via,
      ...(params.rotaSlotId != null ? { rotaSlotId: params.rotaSlotId } : {}),
    },
  };
}

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
 * checked as well as status; a shift with a timesheet in any state is never deleted either.
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
