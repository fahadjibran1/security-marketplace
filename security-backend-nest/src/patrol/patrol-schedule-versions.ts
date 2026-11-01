import type { PatrolScheduleLike } from './patrol-window.service';

/**
 * Schedule versions (S4 1.2.1, owner decision B1; durable since Migration 73).
 *
 * A change to an ACTIVE schedule's TIMING (frequencyMinutes, windowMinutes, activeFrom, activeTo, daysOfWeek, startsOn,
 * endsOn) is never applied in place: PatrolConfigService.updateSchedule ARCHIVES the current schedule (active = false,
 * archivedAt = the change instant; kept for history — its runs, exceptions, evidence and audit keep pointing at it) and
 * CREATES a successor with a NEW id in the same transaction. A new id means new window keys ("s{id}:{date}:{slot}"), so
 * the successor never collides with the predecessor's runs (UQ_patrol_runs_schedule_window_scope) or exceptions (raised
 * once per windowKey), and an old run can never satisfy a new window. A name, route or on/off change stays in place, and
 * so does a timing change to a PAUSED schedule: it has no windows anywhere (plan, sweep, windows-due count all read
 * active schedules only), runs are matched on their actual window start, and re-activation never judges earlier windows.
 *
 * The link is patrol_schedules."supersededByScheduleId" / "supersededAt" (Migration 73; composite FK to the same company
 * and site, one predecessor per successor). The patrol.schedule.superseded audit entry is still written as evidence, but
 * nothing reads it. supersededAt is the successor's createdAt (the same transaction instant as the predecessor's
 * archivedAt). A window belongs to the version in force at its START:
 *   predecessor  windows starting before supersededAt (history, and a window already open at the change, which a Guard
 *                may still start or finish a patrol for). The sweep still judges its windows that had ENDED by the change
 *                (its updatedAt — the judging floor — is left as it was), but never the window open at the change, so an
 *                edit never raises a retrospective "missed";
 *   successor    windows starting at or after supersededAt ("timing changes apply from now"); its updatedAt is the same
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
};

/** Superseded schedules whose own windows reach past `since` (replaced after it). */
export function supersededSince(versions: Map<number, ScheduleVersionBounds>, since: Date): number[] {
  return [...versions.entries()]
    .filter(([, v]) => v.effectiveUntil && v.effectiveUntil.getTime() > since.getTime())
    .map(([id]) => id);
}

type Runner = { query: (sql: string, params?: unknown[]) => Promise<any> };

/** Every successor link of the company (Migration 73 columns), keyed by schedule id (both ends of each link). */
export async function scheduleVersionBounds(runner: Runner, companyId: number): Promise<Map<number, ScheduleVersionBounds>> {
  const rows = await runner.query(
    `SELECT "id", "supersededByScheduleId", "supersededAt" FROM "patrol_schedules" WHERE "companyId" = $1 AND "supersededByScheduleId" IS NOT NULL`,
    [companyId],
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
    const predecessorId = Number(row.id);
    const successorId = Number(row.supersededByScheduleId);
    const at = new Date(row.supersededAt);
    Object.assign(entry(predecessorId), { effectiveUntil: at, successorId });
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
