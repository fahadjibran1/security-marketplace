import { effectiveShiftRequirement, ShiftPatrolRequirementView, siteSetupOf } from './patrol-shift-windows';

/**
 * S4 1.3.0 B1: the resolved patrol requirement of shifts, for shift reads (owner decision 5). Plain SQL on the caller's
 * runner (the shift module has no dependency on the patrol module's services).
 *
 *   { value: 'required' | 'not_required' | 'site_default', effectiveRequired, source: 'site' | 'shift', summary }
 *
 * Only for shifts of companies with Patrols switched ON: with the switch off, existing shift responses stay exactly as
 * they were (as companies.patrolsEnabled itself is never serialised). The raw column (shifts."patrolRequirement",
 * `select: false` on the entity) is read here, never through the entity.
 */

type Runner = { query: (sql: string, params?: unknown[]) => Promise<any> };

/** The API accepts 'site_default' (or null) for the column's NULL. */
export function storedPatrolRequirement(value: string | null | undefined): 'required' | 'not_required' | null {
  return value === 'required' || value === 'not_required' ? value : null;
}

/** Postgres "undefined column / table": a database without Migration 68 or 74 (only ever a certification rehearsal). */
function missingSchema(error: unknown): boolean {
  const code = (error as { driverError?: { code?: string }; code?: string })?.driverError?.code ?? (error as { code?: string })?.code;
  return code === '42703' || code === '42P01';
}

export async function shiftPatrolRequirements(runner: Runner, shiftIds: number[]): Promise<Map<number, ShiftPatrolRequirementView>> {
  const out = new Map<number, ShiftPatrolRequirementView>();
  const ids = [...new Set(shiftIds.map(Number))];
  if (!ids.length) return out;
  let rows: any[];
  try {
    rows = await runner.query(
      `SELECT s."id", s."patrolRequirement", p."setupMode", p."windowAnchor", p."setupConfirmedAt", p."setupConfirmedByUserId"
         FROM "shifts" s JOIN "companies" c ON c."id" = s."companyId" AND c."patrolsEnabled"
         LEFT JOIN "patrol_policies" p ON p."companyId" = s."companyId" AND p."siteId" = s."siteId"
        WHERE s."id" = ANY($1::int[])`,
      [ids],
    );
  } catch (error) {
    // A shift read never fails because of the patrol view: on a schema without it there is nothing to show.
    if (missingSchema(error)) return out;
    throw error;
  }
  for (const row of rows) out.set(Number(row.id), effectiveShiftRequirement(row.patrolRequirement ?? null, siteSetupOf(row)));
  return out;
}

/** A shift's stored requirement (NULL = the site's default). */
export async function shiftPatrolRequirementSetting(runner: Runner, shiftId: number): Promise<'required' | 'not_required' | null> {
  const [row] = await runner.query(`SELECT "patrolRequirement" FROM "shifts" WHERE "id" = $1`, [shiftId]);
  return storedPatrolRequirement(row?.patrolRequirement);
}
