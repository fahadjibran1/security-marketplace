import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 71: Patrol sweep outage reconciliation (S4 Patrols, issue #67; owner decision 29 Oct 2026, design in
 * docs/patrols/P1-follow-ups.md §2).
 *
 * Additive only. Nothing existing is backfilled, re-typed or removed; every new column is nullable, so every existing row
 * and INSERT stays valid. Varchar + CHECK, no PostgreSQL enum.
 *
 *   patrol_sweep_watermarks     NEW  one row per company: "judgedThrough" — every patrol window whose start deadline is at
 *                                    or before it has been judged. Advanced only in the transaction that judged up to it.
 *   patrol_reconciliation_runs  NEW  one row per catch-up after a sweep gap longer than the normal lookback: the range
 *                                    caught up (fromAt → throughAt, toward targetAt), what lay beyond the 14-day horizon
 *                                    and was NOT judged (unjudgedFrom / unjudgedTo), counts, status. At most one running
 *                                    per company (UQ_patrol_reconciliation_runs_running).
 *   patrol_exceptions           + "reconciliationRunId" int NULL → patrol_reconciliation_runs (same company): the marker on
 *                                    an exception raised by reconciliation
 *   safety_alerts               + "patrolReconciliationRunId" int NULL → patrol_reconciliation_runs: a reconciliation
 *                                    summary alert (one per site and run) or the horizon alert (one per run), keyed by
 *                                    uq_safety_alerts_patrol_reconciliation (run, patrolWindowKey)
 *
 * Tenancy: the run and the watermark reference their company (RESTRICT); an exception's run must be its own company's
 * (composite key, as M68's patrol references). Nothing existing references a new table, and the previous release never
 * names a new column: a Render rollback over a migrated database is safe (its sweep simply ignores the watermark).
 *
 * Runs in a transaction (no enum change). Every statement is guarded (IF NOT EXISTS / pg_constraint checks), so a
 * repeated run converges.
 */
export class AddPatrolSweepReconciliation1720900000017 implements MigrationInterface {
  name = 'AddPatrolSweepReconciliation1720900000017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const q = (sql: string) => queryRunner.query(sql);

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_reconciliation_runs" (
        "id"                SERIAL NOT NULL,
        "companyId"         integer NOT NULL,
        "status"            character varying(16) NOT NULL DEFAULT 'running',
        "fromAt"            TIMESTAMP WITH TIME ZONE NOT NULL,
        "throughAt"         TIMESTAMP WITH TIME ZONE NOT NULL,
        "targetAt"          TIMESTAMP WITH TIME ZONE NOT NULL,
        "horizonDays"       integer NOT NULL,
        "unjudgedFrom"      TIMESTAMP WITH TIME ZONE,
        "unjudgedTo"        TIMESTAMP WITH TIME ZONE,
        "batches"           integer NOT NULL DEFAULT 0,
        "windowsJudged"     integer NOT NULL DEFAULT 0,
        "exceptionsRaised"  integer NOT NULL DEFAULT 0,
        "startedAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "completedAt"       TIMESTAMP WITH TIME ZONE,
        "updatedAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patrol_reconciliation_runs" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_patrol_reconciliation_runs_id_company" UNIQUE ("id", "companyId"),
        CONSTRAINT "CHK_patrol_reconciliation_runs_status" CHECK ("status" IN ('running', 'completed')),
        CONSTRAINT "CHK_patrol_reconciliation_runs_completed" CHECK (("status" = 'completed') = ("completedAt" IS NOT NULL)),
        CONSTRAINT "CHK_patrol_reconciliation_runs_range" CHECK ("throughAt" >= "fromAt"),
        CONSTRAINT "CHK_patrol_reconciliation_runs_unjudged" CHECK (("unjudgedFrom" IS NULL) = ("unjudgedTo" IS NULL)
          AND ("unjudgedFrom" IS NULL OR ("unjudgedTo" > "unjudgedFrom" AND "unjudgedTo" <= "fromAt"))),
        CONSTRAINT "CHK_patrol_reconciliation_runs_counts" CHECK ("batches" >= 0 AND "windowsJudged" >= 0 AND "exceptionsRaised" >= 0 AND "horizonDays" > 0)
      )
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_sweep_watermarks" (
        "companyId"      integer NOT NULL,
        "judgedThrough"  TIMESTAMP WITH TIME ZONE NOT NULL,
        "updatedAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patrol_sweep_watermarks" PRIMARY KEY ("companyId")
      )
    `);

    await q(`ALTER TABLE "patrol_exceptions" ADD COLUMN IF NOT EXISTS "reconciliationRunId" integer`);
    await q(`ALTER TABLE "safety_alerts" ADD COLUMN IF NOT EXISTS "patrolReconciliationRunId" integer`);

    const constraints: Array<[string, string, string]> = [
      ['patrol_reconciliation_runs', 'FK_patrol_reconciliation_runs_company', 'FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['patrol_sweep_watermarks', 'FK_patrol_sweep_watermarks_company', 'FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['patrol_exceptions', 'FK_patrol_exceptions_reconciliation_run',
        'FOREIGN KEY ("reconciliationRunId", "companyId") REFERENCES "patrol_reconciliation_runs"("id", "companyId") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['safety_alerts', 'FK_safety_alerts_patrol_reconciliation_run',
        'FOREIGN KEY ("patrolReconciliationRunId") REFERENCES "patrol_reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
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

    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_patrol_reconciliation_runs_running" ON "patrol_reconciliation_runs" ("companyId") WHERE "status" = 'running'`);
    await q(`CREATE INDEX IF NOT EXISTS "IDX_patrol_reconciliation_runs_company" ON "patrol_reconciliation_runs" ("companyId", "startedAt")`);
    await q(`CREATE INDEX IF NOT EXISTS "IDX_patrol_exceptions_reconciliation" ON "patrol_exceptions" ("reconciliationRunId") WHERE "reconciliationRunId" IS NOT NULL`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "uq_safety_alerts_patrol_reconciliation" ON "safety_alerts" ("patrolReconciliationRunId", "patrolWindowKey") WHERE "patrolReconciliationRunId" IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // A reconciliation run is the record of what was judged after an outage and of what was NOT judged (beyond the
    // horizon); exceptions and alerts point at it. Rolling back would drop that record, so it is refused while any run
    // exists: export it and decide first. A code rollback never needs this (the previous release ignores the new tables).
    const [table] = await queryRunner.query(`SELECT to_regclass('public.patrol_reconciliation_runs') AS t`);
    const runs = table?.t ? Number((await queryRunner.query(`SELECT count(*)::int AS n FROM "patrol_reconciliation_runs"`))[0].n) : 0;
    if (runs) {
      throw new Error(
        `Refusing to revert AddPatrolSweepReconciliation1720900000017: ${runs} patrol reconciliation run(s) exist. ` +
          'Export them (pg_dump of patrol_reconciliation_runs, patrol_exceptions, safety_alerts and audit_logs) and get explicit approval before removing them.',
      );
    }
    const q = (sql: string) => queryRunner.query(sql);
    await q(`DROP INDEX IF EXISTS "uq_safety_alerts_patrol_reconciliation"`);
    await q(`DROP INDEX IF EXISTS "IDX_patrol_exceptions_reconciliation"`);
    await q(`ALTER TABLE "safety_alerts" DROP CONSTRAINT IF EXISTS "FK_safety_alerts_patrol_reconciliation_run"`);
    await q(`ALTER TABLE "patrol_exceptions" DROP CONSTRAINT IF EXISTS "FK_patrol_exceptions_reconciliation_run"`);
    await q(`ALTER TABLE "safety_alerts" DROP COLUMN IF EXISTS "patrolReconciliationRunId"`);
    await q(`ALTER TABLE "patrol_exceptions" DROP COLUMN IF EXISTS "reconciliationRunId"`);
    // The watermarks are derived progress (re-created by the sweep), never evidence.
    await q(`DROP TABLE IF EXISTS "patrol_sweep_watermarks"`);
    await q(`DROP TABLE IF EXISTS "patrol_reconciliation_runs"`);
  }
}
