import { PatrolSiteSetup, PATROL_SETUP_UPDATED_ACTION, SHIFT_PATROL_REQUIREMENT_CHANGED_ACTION, siteSetupOf } from './patrol-shift-windows';
import { ScheduleVersionBounds, withVersionBounds } from './patrol-schedule-versions';

/**
 * Database reads shared by every reader of shift-based patrol windows (S4 1.3.0 B1): the sweep, the Guard plan and run
 * start, the windows-due count and the dashboard reads. Plain SQL on the caller's runner (a transaction's manager or the
 * DataSource), company-scoped.
 */

type Runner = { query: (sql: string, params?: unknown[]) => Promise<any> };

/** Each site's setup (its own policy row only; a site without one has no setup). */
export async function siteSetups(runner: Runner, companyId: number, siteIds: number[] | null = null): Promise<Map<number, PatrolSiteSetup>> {
  const rows = await runner.query(
    `SELECT "siteId", "setupMode", "windowAnchor", "setupConfirmedAt", "setupConfirmedByUserId" FROM "patrol_policies"
      WHERE "companyId" = $1 AND "siteId" IS NOT NULL AND ($2::int[] IS NULL OR "siteId" = ANY($2::int[]))`,
    [companyId, siteIds],
  );
  const out = new Map<number, PatrolSiteSetup>();
  for (const row of rows) out.set(Number(row.siteId), siteSetupOf(row));
  return out;
}

export function setupFor(setups: Map<number, PatrolSiteSetup>, siteId: number): PatrolSiteSetup {
  return setups.get(siteId) ?? siteSetupOf(null);
}

/**
 * The shift-anchored schedules of the company's sites (anchor = 'shift'): the current version of each site and every
 * version replaced after `since` (its windows that started before the change are still its own), with version bounds.
 */
export async function shiftAnchoredSchedules(
  runner: Runner,
  companyId: number,
  siteIds: number[] | null,
  versions: Map<number, ScheduleVersionBounds>,
  since: Date,
): Promise<any[]> {
  const replaced = [...versions.entries()]
    .filter(([, v]) => v.effectiveUntil && v.effectiveUntil.getTime() > since.getTime())
    .map(([id]) => id);
  const rows = await runner.query(
    `SELECT * FROM "patrol_schedules" WHERE "companyId" = $1 AND "anchor" = 'shift' AND ($2::int[] IS NULL OR "siteId" = ANY($2::int[]))
        AND ("archivedAt" IS NULL OR "id" = ANY($3::int[])) ORDER BY "id"`,
    [companyId, siteIds, replaced],
  );
  return rows.map((s: any) => withVersionBounds(s, versions));
}

/**
 * When each shift's patrol requirement last changed (the audited shift.patrol_requirement_changed): windows that started
 * before it are never judged, so a mid-shift change applies to future windows only.
 */
export async function requirementChangedAt(runner: Runner, companyId: number, shiftIds: number[]): Promise<Map<number, Date>> {
  const out = new Map<number, Date>();
  if (!shiftIds.length) return out;
  const rows = await runner.query(
    `SELECT "entityId", max("createdAt") AS "at" FROM "audit_logs"
      WHERE "companyId" = $1 AND "action" = $2 AND "entityType" = 'shift' AND "entityId" = ANY($3::int[]) GROUP BY "entityId"`,
    [companyId, SHIFT_PATROL_REQUIREMENT_CHANGED_ACTION, shiftIds],
  );
  for (const row of rows) out.set(Number(row.entityId), new Date(row.at));
  return out;
}

/**
 * When each site's setup last changed WHO patrols or HOW windows anchor (setupMode / windowAnchor; the audited
 * patrol.setup.updated with requirementChanged): windows that started before it are never judged.
 */
export async function setupChangedAt(runner: Runner, companyId: number): Promise<Map<number, Date>> {
  const rows = await runner.query(
    `SELECT ("afterData"->>'siteId')::int AS "siteId", max("createdAt") AS "at" FROM "audit_logs"
      WHERE "companyId" = $1 AND "action" = $2 AND ("afterData"->>'requirementChanged') = 'true' AND ("afterData"->>'siteId') ~ '^[0-9]+$'
      GROUP BY 1`,
    [companyId, PATROL_SETUP_UPDATED_ACTION],
  );
  const out = new Map<number, Date>();
  for (const row of rows) out.set(Number(row.siteId), new Date(row.at));
  return out;
}

/** The latest of the given instants (null ones ignored). */
export function latest(...values: Array<Date | null | undefined>): Date {
  return new Date(Math.max(...values.filter((v): v is Date => v instanceof Date).map((v) => v.getTime()), 0));
}
