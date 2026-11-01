import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 74: patrol site setup, shift-based patrol windows, checkpoint test-scan confirmation and immutable route
 * versions (S4 1.3.0 Package B, stage B1; owner-approved).
 *
 * Additive only. Nothing existing is re-typed, removed, backfilled or rewritten: every new column is NULL or has a
 * constant default that keeps every existing row and every INSERT of the previous release (1.2.1, 5d749fa) valid.
 *
 *   shifts              + "patrolRequirement" varchar(16) NULL   'required' | 'not_required'; NULL = the site's default
 *     CHK_shifts_patrol_requirement
 *   patrol_policies     + "setupMode" varchar(16) NULL           'off' | 'every_shift' | 'per_shift' (NULL: never set up)
 *                       + "windowAnchor" varchar(16) NULL        'scheduled_start' | 'book_on' (NULL = scheduled_start)
 *                       + "setupConfirmedAt" timestamptz NULL     when the site setup was activated
 *                       + "setupConfirmedByUserId" int NULL → users (RESTRICT)
 *     CHK_patrol_policies_setup_mode, CHK_patrol_policies_window_anchor, CHK_patrol_policies_setup_confirmed (pair)
 *   patrol_schedules    + "anchor" varchar(16) NOT NULL DEFAULT 'clock'   'clock' | 'shift' (every existing row: clock)
 *     CHK_patrol_schedules_anchor
 *   patrol_routes       + "kind" varchar(16) NOT NULL DEFAULT 'custom'    'custom' | 'auto' (every existing row: custom)
 *                       + "supersededByRouteId" int NULL, "supersededAt" timestamptz NULL   the successor version
 *     CHK_patrol_routes_kind
 *     CHK_patrol_routes_superseded_pair        both set or both null
 *     CHK_patrol_routes_superseded_not_self    never the route itself
 *     CHK_patrol_routes_superseded_archived    a replaced route is archived (archivedAt set; CHK_patrol_routes_archived_inactive
 *                                              then makes it inactive)
 *     FK_patrol_routes_superseded_by           ("supersededByRouteId", "companyId", "siteId") → patrol_routes ("id",
 *                                              "companyId", "siteId") ON DELETE RESTRICT: the successor exists and is of
 *                                              the SAME company AND site (target: the existing UQ_patrol_routes_id_company_site)
 *     UQ_patrol_routes_superseded_by           partial UNIQUE: a successor replaces exactly one route
 *     IDX_patrol_routes_superseded             ("companyId") WHERE linked: the company's route version links
 *   patrol_checkpoints  + "confirmedAt" timestamptz NULL, "confirmedByUserId" int NULL → users (RESTRICT),
 *                         "confirmedTokenVersion" int NULL   the authorised test scan of the current label
 *     CHK_patrol_checkpoints_confirmed         all three set or all three null (and a version ≥ 1)
 *
 * Rollback compatibility (1.2.1, 5d749fa): the previous release never names these columns. Its raw SELECT * carries the
 * extra keys, which nothing reads; its entities map only their own columns; its INSERTs leave them NULL or default (a new
 * schedule is 'clock', a new route 'custom'). A shift-anchored schedule row is written by 1.3.0 so that the OLD clock
 * engine yields no window for it (inactive, startsOn = endsOn = 2000-01-01), and a superseded route is an ordinary archived
 * route to the old code (a run keeps its routeId; schedules keep theirs).
 *
 * Runs in a transaction. Every statement is guarded (IF NOT EXISTS / pg_constraint checks), so a repeated run converges.
 * Numbered 1720900000021: Migration 73 is 1720900000020 (1720900000019 stays reserved by another branch).
 */
export class AddPatrolSiteSetup1720900000021 implements MigrationInterface {
  name = 'AddPatrolSiteSetup1720900000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const q = (sql: string) => queryRunner.query(sql);

    const columns: Array<[string, string, string]> = [
      ['shifts', 'patrolRequirement', 'character varying(16)'],
      ['patrol_policies', 'setupMode', 'character varying(16)'],
      ['patrol_policies', 'windowAnchor', 'character varying(16)'],
      ['patrol_policies', 'setupConfirmedAt', 'TIMESTAMP WITH TIME ZONE'],
      ['patrol_policies', 'setupConfirmedByUserId', 'integer'],
      ['patrol_schedules', 'anchor', `character varying(16) NOT NULL DEFAULT 'clock'`],
      ['patrol_routes', 'kind', `character varying(16) NOT NULL DEFAULT 'custom'`],
      ['patrol_routes', 'supersededByRouteId', 'integer'],
      ['patrol_routes', 'supersededAt', 'TIMESTAMP WITH TIME ZONE'],
      ['patrol_checkpoints', 'confirmedAt', 'TIMESTAMP WITH TIME ZONE'],
      ['patrol_checkpoints', 'confirmedByUserId', 'integer'],
      ['patrol_checkpoints', 'confirmedTokenVersion', 'integer'],
    ];
    for (const [table, column, definition] of columns) {
      await q(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${definition}`);
    }

    const constraints: Array<[string, string, string]> = [
      ['shifts', 'CHK_shifts_patrol_requirement', `CHECK ("patrolRequirement" IS NULL OR "patrolRequirement" IN ('required', 'not_required'))`],
      ['patrol_policies', 'CHK_patrol_policies_setup_mode', `CHECK ("setupMode" IS NULL OR "setupMode" IN ('off', 'every_shift', 'per_shift'))`],
      ['patrol_policies', 'CHK_patrol_policies_window_anchor', `CHECK ("windowAnchor" IS NULL OR "windowAnchor" IN ('scheduled_start', 'book_on'))`],
      ['patrol_policies', 'CHK_patrol_policies_setup_confirmed', 'CHECK (("setupConfirmedAt" IS NULL) = ("setupConfirmedByUserId" IS NULL))'],
      ['patrol_policies', 'FK_patrol_policies_setup_confirmed_by',
        'FOREIGN KEY ("setupConfirmedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['patrol_schedules', 'CHK_patrol_schedules_anchor', `CHECK ("anchor" IN ('clock', 'shift'))`],
      ['patrol_routes', 'CHK_patrol_routes_kind', `CHECK ("kind" IN ('custom', 'auto'))`],
      ['patrol_routes', 'CHK_patrol_routes_superseded_pair', 'CHECK (("supersededByRouteId" IS NULL) = ("supersededAt" IS NULL))'],
      ['patrol_routes', 'CHK_patrol_routes_superseded_not_self', 'CHECK ("supersededByRouteId" IS NULL OR "supersededByRouteId" <> "id")'],
      ['patrol_routes', 'CHK_patrol_routes_superseded_archived', 'CHECK ("supersededByRouteId" IS NULL OR "archivedAt" IS NOT NULL)'],
      ['patrol_routes', 'FK_patrol_routes_superseded_by',
        'FOREIGN KEY ("supersededByRouteId", "companyId", "siteId") REFERENCES "patrol_routes"("id", "companyId", "siteId") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['patrol_checkpoints', 'CHK_patrol_checkpoints_confirmed',
        `CHECK ((("confirmedAt" IS NULL) = ("confirmedByUserId" IS NULL)) AND (("confirmedAt" IS NULL) = ("confirmedTokenVersion" IS NULL))
               AND ("confirmedTokenVersion" IS NULL OR "confirmedTokenVersion" >= 1))`],
      ['patrol_checkpoints', 'FK_patrol_checkpoints_confirmed_by',
        'FOREIGN KEY ("confirmedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
    ];
    for (const [table, name, definition] of constraints) {
      await q(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
            ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ${definition};
          END IF;
        END $$
      `);
    }
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_patrol_routes_superseded_by" ON "patrol_routes" ("supersededByRouteId") WHERE "supersededByRouteId" IS NOT NULL`);
    await q(`CREATE INDEX IF NOT EXISTS "IDX_patrol_routes_superseded" ON "patrol_routes" ("companyId") WHERE "supersededByRouteId" IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The new columns carry configuration and history the 1.3.0 code relies on (which route version a window owed, which
    // label was test-scanned and by whom, which shifts need patrols). Dropping them would lose it, so down() is refused
    // while any of it exists — as Migrations 72 and 73 do. A code rollback never needs this: 1.2.1 never names the columns.
    const has = async (table: string, column: string) => (await queryRunner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, column],
    )).length > 0;
    const count = async (sql: string) => Number((await queryRunner.query(sql))[0].n);
    const blocking: string[] = [];
    if (await has('shifts', 'patrolRequirement')) {
      const n = await count(`SELECT count(*)::int AS n FROM "shifts" WHERE "patrolRequirement" IS NOT NULL`);
      if (n) blocking.push(`${n} shift patrol requirement(s)`);
    }
    if (await has('patrol_policies', 'setupMode')) {
      const n = await count(`SELECT count(*)::int AS n FROM "patrol_policies"
        WHERE "setupMode" IS NOT NULL OR "windowAnchor" IS NOT NULL OR "setupConfirmedAt" IS NOT NULL`);
      if (n) blocking.push(`${n} patrol site setup(s)`);
    }
    if (await has('patrol_schedules', 'anchor')) {
      const n = await count(`SELECT count(*)::int AS n FROM "patrol_schedules" WHERE "anchor" <> 'clock'`);
      if (n) blocking.push(`${n} shift-anchored patrol schedule(s)`);
    }
    if (await has('patrol_routes', 'kind')) {
      const n = await count(`SELECT count(*)::int AS n FROM "patrol_routes" WHERE "kind" <> 'custom' OR "supersededByRouteId" IS NOT NULL`);
      if (n) blocking.push(`${n} automatic or versioned patrol route(s)`);
    }
    if (await has('patrol_checkpoints', 'confirmedAt')) {
      const n = await count(`SELECT count(*)::int AS n FROM "patrol_checkpoints" WHERE "confirmedAt" IS NOT NULL`);
      if (n) blocking.push(`${n} confirmed checkpoint(s)`);
    }
    if (blocking.length) {
      throw new Error(
        `Refusing to revert AddPatrolSiteSetup1720900000021: ${blocking.join(', ')} exist. ` +
          'Export them (pg_dump of shifts, the patrol_* tables and audit_logs) and get explicit approval before removing them.',
      );
    }
    const q = (sql: string) => queryRunner.query(sql);
    await q(`DROP INDEX IF EXISTS "IDX_patrol_routes_superseded"`);
    await q(`DROP INDEX IF EXISTS "UQ_patrol_routes_superseded_by"`);
    for (const [table, name] of [
      ['patrol_checkpoints', 'FK_patrol_checkpoints_confirmed_by'],
      ['patrol_checkpoints', 'CHK_patrol_checkpoints_confirmed'],
      ['patrol_routes', 'FK_patrol_routes_superseded_by'],
      ['patrol_routes', 'CHK_patrol_routes_superseded_archived'],
      ['patrol_routes', 'CHK_patrol_routes_superseded_not_self'],
      ['patrol_routes', 'CHK_patrol_routes_superseded_pair'],
      ['patrol_routes', 'CHK_patrol_routes_kind'],
      ['patrol_schedules', 'CHK_patrol_schedules_anchor'],
      ['patrol_policies', 'FK_patrol_policies_setup_confirmed_by'],
      ['patrol_policies', 'CHK_patrol_policies_setup_confirmed'],
      ['patrol_policies', 'CHK_patrol_policies_window_anchor'],
      ['patrol_policies', 'CHK_patrol_policies_setup_mode'],
      ['shifts', 'CHK_shifts_patrol_requirement'],
    ]) {
      await q(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`);
    }
    for (const [table, column] of [
      ['patrol_checkpoints', 'confirmedTokenVersion'], ['patrol_checkpoints', 'confirmedByUserId'], ['patrol_checkpoints', 'confirmedAt'],
      ['patrol_routes', 'supersededAt'], ['patrol_routes', 'supersededByRouteId'], ['patrol_routes', 'kind'],
      ['patrol_schedules', 'anchor'],
      ['patrol_policies', 'setupConfirmedByUserId'], ['patrol_policies', 'setupConfirmedAt'], ['patrol_policies', 'windowAnchor'],
      ['patrol_policies', 'setupMode'],
      ['shifts', 'patrolRequirement'],
    ]) {
      await q(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}"`);
    }
  }
}
