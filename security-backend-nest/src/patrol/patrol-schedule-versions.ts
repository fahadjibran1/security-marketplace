import type { PatrolScheduleLike } from './patrol-window.service';

/**
 * Schedule versions (S4 1.2.1, owner decision B1) — without a migration.
 *
 * A change to a schedule's TIMING (frequencyMinutes, windowMinutes, activeFrom, activeTo, daysOfWeek, startsOn, endsOn)
 * is never applied in place: PatrolConfigService.updateSchedule ARCHIVES the current schedule (active = false,
 * archivedAt = the change instant; kept for history — its runs, exceptions, evidence and audit keep pointing at it) and
 * CREATES a successor with a NEW id in the same transaction. A new id means new window keys ("s{id}:{date}:{slot}"), so
 * the successor never collides with the predecessor's runs (UQ_patrol_runs_schedule_window_scope) or exceptions (raised
 * once per windowKey), and an old run can never satisfy a new window. A name, route or on/off change stays in place.
 *
 * The link is the audit entry written in that transaction — action PATROL_SCHEDULE_SUPERSEDED on the predecessor, with
 * { successorId, effectiveAt } — so no column is needed. effectiveAt is the successor's createdAt (the same transaction
 * instant as the predecessor's archivedAt). A window belongs to the version in force at its START:
 *   predecessor  windows starting before effectiveAt (history, and a window already open at the change, which a Guard may
 *                still start or finish a patrol for). The sweep still judges its windows that had ENDED by the change
 *                (its updatedAt — the judging floor — is left as it was), but never the window open at the change, so an
 *                edit never raises a retrospective "missed";
 *   successor    windows starting at or after effectiveAt ("timing changes apply from now"); its updatedAt is the same
 *                instant, so the sweep judges it from then.
 * daysOfWeek is a timing field: it decides which local dates have windows at all.
 */
export const PATROL_SCHEDULE_SUPERSEDED_ACTION = 'patrol.schedule.superseded';

export type ScheduleVersionBounds = {
  /** Set on a successor: windows start at or after this instant. */
  effectiveFrom?: Date;
  /** Set on a superseded schedule: windows start before this instant. */
  effectiveUntil?: Date;
  predecessorId?: number;
  successorId?: number;
  /** A superseded schedule that was switched on until the change (only then does it still have windows before it). */
  wasActive?: boolean;
};

/** Superseded schedules that still had windows in force after `since` (they were on, and replaced after it). */
export function supersededSince(versions: Map<number, ScheduleVersionBounds>, since: Date): number[] {
  return [...versions.entries()]
    .filter(([, v]) => v.effectiveUntil && v.wasActive !== false && v.effectiveUntil.getTime() > since.getTime())
    .map(([id]) => id);
}

type Runner = { query: (sql: string, params?: unknown[]) => Promise<any> };

/** Every supersession recorded for the company, keyed by schedule id (both ends of each link). */
export async function scheduleVersionBounds(runner: Runner, companyId: number): Promise<Map<number, ScheduleVersionBounds>> {
  const rows = await runner.query(
    `SELECT "entityId", "afterData" FROM "audit_logs" WHERE "companyId" = $1 AND "action" = $2 AND "entityType" = 'patrol_schedule'`,
    [companyId, PATROL_SCHEDULE_SUPERSEDED_ACTION],
  );
  const map = new Map<number, ScheduleVersionBounds>();
  const entry = (id: number) => {
    let e = map.get(id);
    if (!e) {
      e = {};
      map.set(id, e);
    }
    return e;
  };
  for (const row of rows) {
    const data = typeof row.afterData === 'string' ? JSON.parse(row.afterData) : row.afterData;
    const predecessorId = Number(row.entityId);
    const successorId = Number(data?.successorId);
    const at = data?.effectiveAt ? new Date(data.effectiveAt) : null;
    if (!Number.isFinite(predecessorId) || !Number.isFinite(successorId) || !at || Number.isNaN(at.getTime())) continue;
    Object.assign(entry(predecessorId), { effectiveUntil: at, successorId, wasActive: data?.wasActive !== false });
    Object.assign(entry(successorId), { effectiveFrom: at, predecessorId });
  }
  return map;
}

/** The schedule with its version bounds attached (unchanged when it was never superseded nor a successor). */
export function withVersionBounds<T extends PatrolScheduleLike>(schedule: T, versions: Map<number, ScheduleVersionBounds>): T {
  const bounds = versions.get(Number(schedule.id));
  if (!bounds) return schedule;
  return { ...schedule, effectiveFrom: bounds.effectiveFrom ?? null, effectiveUntil: bounds.effectiveUntil ?? null };
}

/** The timing fields of a schedule, normalised: a change to any of them creates a successor. */
export const PATROL_SCHEDULE_TIMING_FIELDS = ['daysOfWeek', 'activeFrom', 'activeTo', 'frequencyMinutes', 'windowMinutes', 'startsOn', 'endsOn'] as const;

export function timingChanged(
  before: { daysOfWeek: number[]; activeFrom: string; activeTo: string; frequencyMinutes: number; windowMinutes: number; startsOn: string | null; endsOn: string | null },
  after: typeof before,
): boolean {
  const days = (d: number[]) => [...d].map(Number).sort((a, b) => a - b).join(',');
  return days(before.daysOfWeek) !== days(after.daysOfWeek)
    || before.activeFrom !== after.activeFrom
    || before.activeTo !== after.activeTo
    || Number(before.frequencyMinutes) !== Number(after.frequencyMinutes)
    || Number(before.windowMinutes) !== Number(after.windowMinutes)
    || (before.startsOn ?? null) !== (after.startsOn ?? null)
    || (before.endsOn ?? null) !== (after.endsOn ?? null);
}
