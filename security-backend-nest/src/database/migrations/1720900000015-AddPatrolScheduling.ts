import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 69: Patrol scheduling, deadlines, offline sync after Book Off and operational alerts (S4 Patrols Phase 1,
 * package P1-B; owner-approved 28 Oct 2026).
 *
 * Additive only. Nothing existing is backfilled, re-typed or removed; every new column is nullable or has a default that
 * keeps every existing row and INSERT valid:
 *
 *   safety_alerts_type_enum   + 'patrol_missed', 'patrol_abandoned', 'patrol_incomplete', 'checkpoint_missed',
 *                               'patrol_unverified' (appended; the column has been a PostgreSQL enum since Migration 3)
 *   safety_alerts             + "patrolExceptionId" int NULL → patrol_exceptions (RESTRICT)   the exception it carries
 *                             + "patrolRunId"       int NULL → patrol_runs (RESTRICT)         the run (link for the web)
 *                             + "patrolWindowKey"   varchar(64) NULL
 *                             + "patrolLateSyncAt"  timestamptz NULL   evidence reached the server after the alert
 *                             + "patrolAnnotation"  varchar(500) NULL  what arrived (the message stays as raised)
 *                             uq_safety_alerts_patrol_exception  UNIQUE ("patrolExceptionId") WHERE NOT NULL: one alert
 *                             per patrol exception (the sweep inserts ON CONFLICT DO NOTHING against it)
 *   patrol_policies           + "postShiftSyncHours" int 24 (1–72), "clockDriftThresholdMinutes" int 5 (1–120),
 *                               "allowUnscheduledPatrols" bool true, "escalateUnverified" bool false
 *   patrol_runs               + "lateStart", "provisional", "needsReview" bool false, "syncFlags" jsonb '[]',
 *                               "clockDriftMs" int NULL, "verificationFinalAt" timestamptz NULL; IDX_patrol_runs_open
 *   patrol_checkpoint_visits  + "syncedLate" bool false, "syncFlags" jsonb '[]', "clockDriftMs" int NULL
 *   patrol_exceptions         + "guardId" → guard_profiles, "windowStart", "windowEnd", "acknowledgedAt",
 *                               "acknowledgedByUserId" → users, "lateEvidenceAt", "annotations" jsonb '[]' (append-only);
 *                             CHK_patrol_exceptions_type gains 'patrol_abandoned'; IDX_patrol_exceptions_window_type
 *
 * Runs OUTSIDE a transaction, as Migrations 59 and 63 do: ALTER TYPE … ADD VALUE cannot be used in the transaction that
 * would then use the label. Every statement is guarded (IF NOT EXISTS / pg_constraint checks), so a partial run converges
 * when repeated.
 *
 * Backward compatible: the previous release (P1-A, 9517a25) never names the new columns, labels or index; the defaults
 * keep its INSERTs valid, and its CHECK on patrol_exceptions is a subset of the new one. A Render rollback over a
 * migrated database is safe.
 */
export class AddPatrolScheduling1720900000015 implements MigrationInterface {
  name = 'AddPatrolScheduling1720900000015';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const q = (sql: string) => queryRunner.query(sql);

    for (const label of ['patrol_missed', 'patrol_abandoned', 'patrol_incomplete', 'checkpoint_missed', 'patrol_unverified']) {
      await q(`ALTER TYPE "public"."safety_alerts_type_enum" ADD VALUE IF NOT EXISTS '${label}'`);
    }

    const columns: Array<[string, string, string]> = [
      ['safety_alerts', 'patrolExceptionId', 'integer'],
      ['safety_alerts', 'patrolRunId', 'integer'],
      ['safety_alerts', 'patrolWindowKey', 'character varying(64)'],
      ['safety_alerts', 'patrolLateSyncAt', 'TIMESTAMP WITH TIME ZONE'],
      ['safety_alerts', 'patrolAnnotation', 'character varying(500)'],
      ['patrol_policies', 'postShiftSyncHours', 'integer NOT NULL DEFAULT 24'],
      ['patrol_policies', 'clockDriftThresholdMinutes', 'integer NOT NULL DEFAULT 5'],
      ['patrol_policies', 'allowUnscheduledPatrols', 'boolean NOT NULL DEFAULT true'],
      ['patrol_policies', 'escalateUnverified', 'boolean NOT NULL DEFAULT false'],
      ['patrol_runs', 'lateStart', 'boolean NOT NULL DEFAULT false'],
      ['patrol_runs', 'provisional', 'boolean NOT NULL DEFAULT false'],
      ['patrol_runs', 'needsReview', 'boolean NOT NULL DEFAULT false'],
      ['patrol_runs', 'syncFlags', `jsonb NOT NULL DEFAULT '[]'`],
      ['patrol_runs', 'clockDriftMs', 'integer'],
      ['patrol_runs', 'verificationFinalAt', 'TIMESTAMP WITH TIME ZONE'],
      ['patrol_checkpoint_visits', 'syncedLate', 'boolean NOT NULL DEFAULT false'],
      ['patrol_checkpoint_visits', 'syncFlags', `jsonb NOT NULL DEFAULT '[]'`],
      ['patrol_checkpoint_visits', 'clockDriftMs', 'integer'],
      ['patrol_exceptions', 'guardId', 'integer'],
      ['patrol_exceptions', 'windowStart', 'TIMESTAMP WITH TIME ZONE'],
      ['patrol_exceptions', 'windowEnd', 'TIMESTAMP WITH TIME ZONE'],
      ['patrol_exceptions', 'acknowledgedAt', 'TIMESTAMP WITH TIME ZONE'],
      ['patrol_exceptions', 'acknowledgedByUserId', 'integer'],
      ['patrol_exceptions', 'lateEvidenceAt', 'TIMESTAMP WITH TIME ZONE'],
      ['patrol_exceptions', 'annotations', `jsonb NOT NULL DEFAULT '[]'`],
    ];
    for (const [table, column, definition] of columns) {
      await q(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${definition}`);
    }

    const constraints: Array<[string, string, string]> = [
      ['safety_alerts', 'FK_safety_alerts_patrol_exception', 'FOREIGN KEY ("patrolExceptionId") REFERENCES "patrol_exceptions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['safety_alerts', 'FK_safety_alerts_patrol_run', 'FOREIGN KEY ("patrolRunId") REFERENCES "patrol_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['patrol_exceptions', 'FK_patrol_exceptions_guard', 'FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['patrol_exceptions', 'FK_patrol_exceptions_acknowledged_by', 'FOREIGN KEY ("acknowledgedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['patrol_policies', 'CHK_patrol_policies_sync', 'CHECK ("postShiftSyncHours" BETWEEN 1 AND 72 AND "clockDriftThresholdMinutes" BETWEEN 1 AND 120)'],
      ['patrol_runs', 'CHK_patrol_runs_sync_flags', `CHECK (jsonb_typeof("syncFlags") = 'array')`],
      ['patrol_checkpoint_visits', 'CHK_patrol_checkpoint_visits_sync_flags', `CHECK (jsonb_typeof("syncFlags") = 'array')`],
      ['patrol_exceptions', 'CHK_patrol_exceptions_annotations', `CHECK (jsonb_typeof("annotations") = 'array')`],
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

    // The exception type CHECK gains 'patrol_abandoned'. Swapped only while it still has M68's definition, so a repeat run
    // (or a database already at 69) is untouched.
    await q(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'CHK_patrol_exceptions_type' AND pg_get_constraintdef(oid) LIKE '%patrol_abandoned%'
        ) THEN
          ALTER TABLE "patrol_exceptions" DROP CONSTRAINT IF EXISTS "CHK_patrol_exceptions_type";
          ALTER TABLE "patrol_exceptions" ADD CONSTRAINT "CHK_patrol_exceptions_type"
            CHECK ("type" IN ('patrol_missed', 'patrol_late', 'patrol_incomplete', 'checkpoint_missed', 'evidence_unverified', 'patrol_abandoned'));
        END IF;
      END $$
    `);

    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "uq_safety_alerts_patrol_exception" ON "safety_alerts" ("patrolExceptionId") WHERE "patrolExceptionId" IS NOT NULL`);
    await q(`CREATE INDEX IF NOT EXISTS "IDX_patrol_runs_open" ON "patrol_runs" ("companyId") WHERE "status" = 'in_progress'`);
    await q(`CREATE INDEX IF NOT EXISTS "IDX_patrol_exceptions_window_type" ON "patrol_exceptions" ("companyId", "windowKey", "scopeKey", "type")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Patrol alerts, abandoned-patrol exceptions and late-sync records are operational evidence. Rolling back would strip
    // their links and flags, so it is refused while any exist: export them and decide first. A code rollback never needs
    // this (the previous release ignores every new column, label and index).
    const [{ alerts }] = await queryRunner.query(
      `SELECT count(*)::int AS alerts FROM "safety_alerts"
        WHERE "type"::text IN ('patrol_missed', 'patrol_abandoned', 'patrol_incomplete', 'checkpoint_missed', 'patrol_unverified') OR "patrolExceptionId" IS NOT NULL`,
    );
    const [{ abandoned }] = await queryRunner.query(`SELECT count(*)::int AS abandoned FROM "patrol_exceptions" WHERE "type" = 'patrol_abandoned'`);
    const [{ flagged }] = await queryRunner.query(
      `SELECT (SELECT count(*) FROM "patrol_runs" WHERE "syncFlags" <> '[]'::jsonb OR "provisional" OR "needsReview" OR "lateStart")
            + (SELECT count(*) FROM "patrol_checkpoint_visits" WHERE "syncFlags" <> '[]'::jsonb OR "syncedLate")
            + (SELECT count(*) FROM "patrol_exceptions" WHERE "annotations" <> '[]'::jsonb OR "lateEvidenceAt" IS NOT NULL OR "acknowledgedAt" IS NOT NULL) AS flagged`,
    );
    const blocking = [
      Number(alerts) ? `${alerts} patrol alert(s)` : '',
      Number(abandoned) ? `${abandoned} abandoned-patrol exception(s)` : '',
      Number(flagged) ? `${flagged} patrol run / scan / exception record(s) with late-sync or review data` : '',
    ].filter(Boolean);
    if (blocking.length) {
      throw new Error(
        `Refusing to revert AddPatrolScheduling1720900000015: ${blocking.join(', ')} exist. ` +
          'Export them (pg_dump of safety_alerts, the patrol_* tables and audit_logs) and get explicit approval before removing them.',
      );
    }
    const q = (sql: string) => queryRunner.query(sql);
    await q(`DROP INDEX IF EXISTS "IDX_patrol_exceptions_window_type"`);
    await q(`DROP INDEX IF EXISTS "IDX_patrol_runs_open"`);
    await q(`DROP INDEX IF EXISTS "uq_safety_alerts_patrol_exception"`);
    await q(`ALTER TABLE "patrol_exceptions" DROP CONSTRAINT IF EXISTS "CHK_patrol_exceptions_type"`);
    await q(`ALTER TABLE "patrol_exceptions" ADD CONSTRAINT "CHK_patrol_exceptions_type"
      CHECK ("type" IN ('patrol_missed', 'patrol_late', 'patrol_incomplete', 'checkpoint_missed', 'evidence_unverified'))`);
    for (const [table, name] of [
      ['patrol_exceptions', 'CHK_patrol_exceptions_annotations'],
      ['patrol_checkpoint_visits', 'CHK_patrol_checkpoint_visits_sync_flags'],
      ['patrol_runs', 'CHK_patrol_runs_sync_flags'],
      ['patrol_policies', 'CHK_patrol_policies_sync'],
      ['patrol_exceptions', 'FK_patrol_exceptions_acknowledged_by'],
      ['patrol_exceptions', 'FK_patrol_exceptions_guard'],
      ['safety_alerts', 'FK_safety_alerts_patrol_run'],
      ['safety_alerts', 'FK_safety_alerts_patrol_exception'],
    ]) {
      await q(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`);
    }
    for (const [table, column] of [
      ['patrol_exceptions', 'annotations'], ['patrol_exceptions', 'lateEvidenceAt'], ['patrol_exceptions', 'acknowledgedByUserId'],
      ['patrol_exceptions', 'acknowledgedAt'], ['patrol_exceptions', 'windowEnd'], ['patrol_exceptions', 'windowStart'], ['patrol_exceptions', 'guardId'],
      ['patrol_checkpoint_visits', 'clockDriftMs'], ['patrol_checkpoint_visits', 'syncFlags'], ['patrol_checkpoint_visits', 'syncedLate'],
      ['patrol_runs', 'verificationFinalAt'], ['patrol_runs', 'clockDriftMs'], ['patrol_runs', 'syncFlags'], ['patrol_runs', 'needsReview'],
      ['patrol_runs', 'provisional'], ['patrol_runs', 'lateStart'],
      ['patrol_policies', 'escalateUnverified'], ['patrol_policies', 'allowUnscheduledPatrols'], ['patrol_policies', 'clockDriftThresholdMinutes'],
      ['patrol_policies', 'postShiftSyncHours'],
      ['safety_alerts', 'patrolAnnotation'], ['safety_alerts', 'patrolLateSyncAt'], ['safety_alerts', 'patrolWindowKey'], ['safety_alerts', 'patrolRunId'],
      ['safety_alerts', 'patrolExceptionId'],
    ]) {
      await q(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}"`);
    }
    // The five enum labels are left in place: PostgreSQL cannot drop an enum value, and the type is shared with every
    // existing alert (as Migrations 58, 59 and 63 do). No row carries them (refused above otherwise).
  }
}
