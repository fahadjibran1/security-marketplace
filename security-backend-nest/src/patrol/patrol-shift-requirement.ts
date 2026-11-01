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

// ── S4 1.3.0 B2: the Rota Planner (slots of positions) ────────────────────────────────────────────────────────────────

/** Whether this database has shifts."patrolRequirement" (Migration 74). Checked rather than tried inside a transaction. */
export async function shiftPatrolRequirementColumnExists(runner: Runner): Promise<boolean> {
  const [row] = await runner.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'shifts'
        AND column_name = 'patrolRequirement') AS "present"`,
  );
  return Boolean(row?.present);
}

/** Writes one stored requirement (NULL = the site's default) to the given shifts. No-op for no shifts. */
export async function setShiftsPatrolRequirement(runner: Runner, shiftIds: number[], value: 'required' | 'not_required' | null): Promise<void> {
  const ids = [...new Set(shiftIds.map(Number))];
  if (!ids.length) return;
  await runner.query(`UPDATE "shifts" SET "patrolRequirement" = $2 WHERE "id" = ANY($1::int[])`, [ids, value]);
}

/**
 * A new position of a slot (more guards, or a replacement) takes the slot's requirement: the replaced position's own
 * value, else the one value every other live position of the slot shares (none, or a mix, = the site's default).
 */
export async function inheritSlotPatrolRequirement(runner: Runner, slotId: number, newShiftIds: number[], fromShiftId?: number): Promise<void> {
  if (!newShiftIds.length || !(await shiftPatrolRequirementColumnExists(runner))) return;
  let value: 'required' | 'not_required' | null = null;
  if (fromShiftId != null) {
    value = await shiftPatrolRequirementSetting(runner, fromShiftId);
  } else {
    const rows = await runner.query(
      `SELECT DISTINCT "patrolRequirement" FROM "shifts" WHERE "rotaSlotId" = $1 AND "status" <> 'cancelled' AND NOT ("id" = ANY($2::int[]))`,
      [slotId, newShiftIds],
    );
    value = rows.length === 1 ? storedPatrolRequirement(rows[0].patrolRequirement) : null;
  }
  if (value) await setShiftsPatrolRequirement(runner, newShiftIds, value);
}

export type SlotPatrolRequirementView = {
  /** The slot's positions' value; 'mixed' when individual shifts were set differently. */
  value: 'required' | 'not_required' | 'site_default' | 'mixed';
  /** Whether the slot's positions owe shift-based patrol windows (null when they differ). */
  effectiveRequired: boolean | null;
  source: 'site' | 'shift' | 'mixed';
  summary: string;
  /** The site's default (the guided site setup): which shifts patrol, how often, and from when. */
  site: {
    setupMode: string | null;
    active: boolean;
    frequencyMinutes: number | null;
    windowAnchor: 'scheduled_start' | 'book_on';
    summary: string;
  };
};

function everyText(minutes: number | null): string {
  if (minutes == null) return 'no frequency set';
  if (minutes % 60 === 0) return minutes === 60 ? 'every hour' : `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}

/** Plain English for the site's default, as the Rota Planner shows it next to the slot's choice. */
export function siteDefaultSummary(setupMode: string | null, active: boolean, frequencyMinutes: number | null, windowAnchor: 'scheduled_start' | 'book_on'): string {
  if (!setupMode || setupMode === 'off') return 'Site default: no patrols (patrols are not set up for this site).';
  const from = windowAnchor === 'book_on' ? 'from Book On' : 'from the scheduled start';
  const which = setupMode === 'every_shift' ? 'every shift patrols' : 'only shifts marked "Required" patrol';
  const timing = `${everyText(frequencyMinutes)}, ${from}`;
  return active
    ? `Site default: ${which}, ${timing}.`
    : `Site default: ${which}, ${timing} - not active yet (the site's patrol setup has not been activated).`;
}

/**
 * The slot's patrol requirement for the Rota Planner, from its positions (the column lives on shifts; a slot has none of
 * its own). Null - nothing added to the response - when the company has Patrols off or the schema has no column.
 */
export async function slotPatrolRequirement(
  runner: Runner, companyId: number, siteId: number, shifts: Array<{ id: number; status: string }>,
): Promise<SlotPatrolRequirementView | null> {
  let policy: any;
  let schedule: any;
  try {
    const [company] = await runner.query(`SELECT "patrolsEnabled" FROM "companies" WHERE "id" = $1`, [companyId]);
    if (!company?.patrolsEnabled) return null;
    if (!(await shiftPatrolRequirementColumnExists(runner))) return null;
    [policy] = await runner.query(
      `SELECT "setupMode", "windowAnchor", "setupConfirmedAt", "setupConfirmedByUserId" FROM "patrol_policies" WHERE "companyId" = $1 AND "siteId" = $2`,
      [companyId, siteId],
    );
    [schedule] = await runner.query(
      `SELECT "frequencyMinutes" FROM "patrol_schedules" WHERE "companyId" = $1 AND "siteId" = $2 AND "anchor" = 'shift' AND "archivedAt" IS NULL
        ORDER BY "id" DESC LIMIT 1`,
      [companyId, siteId],
    );
  } catch (error) {
    if (missingSchema(error)) return null;
    throw error;
  }
  const live = shifts.filter((s) => s.status !== 'cancelled');
  const views = await shiftPatrolRequirements(runner, (live.length ? live : shifts).map((s) => s.id));
  const setup = siteSetupOf(policy);
  const active = setup.setupConfirmedAt != null && (setup.setupMode === 'every_shift' || setup.setupMode === 'per_shift');
  const frequencyMinutes = schedule ? Number(schedule.frequencyMinutes) : null;
  const site = {
    setupMode: setup.setupMode,
    active,
    frequencyMinutes,
    windowAnchor: setup.windowAnchor,
    summary: siteDefaultSummary(setup.setupMode, active, frequencyMinutes, setup.windowAnchor),
  };
  const all = [...views.values()];
  if (!all.length) {
    const view = effectiveShiftRequirement(null, setup);
    return { value: view.value, effectiveRequired: view.effectiveRequired, source: view.source, summary: view.summary, site };
  }
  const values = new Set(all.map((v) => v.value));
  if (values.size === 1) {
    const first = all[0];
    const effective = new Set(all.map((v) => v.effectiveRequired));
    return { value: first.value, effectiveRequired: effective.size === 1 ? first.effectiveRequired : null, source: first.source, summary: first.summary, site };
  }
  const required = all.filter((v) => v.effectiveRequired).length;
  return {
    value: 'mixed',
    effectiveRequired: null,
    source: 'mixed',
    summary: `Positions differ: ${required} of ${all.length} require patrols (set on individual shifts). Choosing a value here sets every open position.`,
    site,
  };
}
