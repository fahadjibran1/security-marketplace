import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 73: durable patrol schedule successors (S4 1.2.1, owner decision B1 — "a timing change ends the schedule and
 * creates a successor"). Until now the link between a schedule and the version that replaced it lived only in the
 * patrol.schedule.superseded audit entry; this makes it a column the window engine, the sweep, the Guard plan and the
 * windows-due count read directly.
 *
 * Additive only. Nothing existing is re-typed or removed, and no existing schedule, run, exception, evidence or audit row
 * is altered or deleted; the only write is the backfill of the two NEW columns from the audit trail (below).
 *
 *   patrol_schedules  + "supersededByScheduleId" integer NULL  the schedule that replaced this one (its successor)
 *                     + "supersededAt"           timestamptz NULL  the instant the successor took effect
 *     CHK_patrol_schedules_superseded_pair       both set or both null
 *     CHK_patrol_schedules_superseded_not_self   never this schedule itself
 *     CHK_patrol_schedules_superseded_archived   a replaced schedule is archived (archivedAt set)
 *     FK_patrol_schedules_superseded_by          ("supersededByScheduleId", "companyId", "siteId") →
 *                                                patrol_schedules ("id", "companyId", "siteId") ON DELETE RESTRICT — the
 *                                                successor exists and is of the SAME company AND site. The target is the
 *                                                existing UNIQUE "UQ_patrol_schedules_id_company_site" (Migration 68), so
 *                                                no new key is needed; a composite key states the rule declaratively and
 *                                                cannot be bypassed, which a trigger could (disable / replace) and which
 *                                                would need its own test of firing order. MATCH SIMPLE: an unlinked row
 *                                                (NULL) is never checked.
 *     UQ_patrol_schedules_superseded_by          partial UNIQUE on "supersededByScheduleId": a successor replaces exactly
 *                                                one schedule (no merges). It also serves "which schedule did this one
 *                                                replace" lookups.
 *     IDX_patrol_schedules_superseded            ("companyId") WHERE linked: "the company's version links", read by
 *                                                every sweep pass, plan and windows-due count.
 *
 * Backfill (idempotent): every patrol.schedule.superseded audit entry (afterData.successorId, afterData.effectiveAt)
 * written by the 1.2.1 code before this migration links its schedule, when the link is still empty, the successor is
 * of the same company and site, not already linked from another schedule, and the replaced schedule is archived. The
 * earliest valid entry per schedule and per successor wins. Production has no such entry; local and staging databases may.
 *
 * Rollback compatibility: the previous releases (1.2.0, 4f4de31, and 1.2.1 before this migration) never name the
 * columns. Their raw SELECT * returns two extra keys that nothing reads; the TypeORM entity of those releases maps only
 * its own columns; their INSERTs leave the columns NULL, which every constraint allows. After a code rollback an
 * already-replaced schedule simply stays archived (hidden) and its successor is an ordinary active schedule, judged from
 * its creation (its updatedAt) as any new schedule always was.
 *
 * Runs in a transaction. Every statement is guarded (IF NOT EXISTS / pg_constraint checks), so a repeated run converges.
 * Numbered 1720900000020: Migration 72 is 1720900000018, and 1720900000019 is reserved by another branch
 * (docs/patrols/P1-follow-ups.md).
 */
export class AddPatrolScheduleSuccessors1720900000020 implements MigrationInterface {
  name = 'AddPatrolScheduleSuccessors1720900000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const q = (sql: string) => queryRunner.query(sql);

    await q(`ALTER TABLE "patrol_schedules" ADD COLUMN IF NOT EXISTS "supersededByScheduleId" integer`);
    await q(`ALTER TABLE "patrol_schedules" ADD COLUMN IF NOT EXISTS "supersededAt" TIMESTAMP WITH TIME ZONE`);

    const constraints: Array<[string, string]> = [
      ['CHK_patrol_schedules_superseded_pair', 'CHECK (("supersededByScheduleId" IS NULL) = ("supersededAt" IS NULL))'],
      ['CHK_patrol_schedules_superseded_not_self', 'CHECK ("supersededByScheduleId" IS NULL OR "supersededByScheduleId" <> "id")'],
      ['CHK_patrol_schedules_superseded_archived', 'CHECK ("supersededByScheduleId" IS NULL OR "archivedAt" IS NOT NULL)'],
      ['FK_patrol_schedules_superseded_by',
        'FOREIGN KEY ("supersededByScheduleId", "companyId", "siteId") REFERENCES "patrol_schedules"("id", "companyId", "siteId") ON DELETE RESTRICT ON UPDATE NO ACTION'],
    ];
    for (const [name, definition] of constraints) {
      await q(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
            ALTER TABLE "patrol_schedules" ADD CONSTRAINT "${name}" ${definition};
          END IF;
        END $$
      `);
    }
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_patrol_schedules_superseded_by" ON "patrol_schedules" ("supersededByScheduleId") WHERE "supersededByScheduleId" IS NOT NULL`);
    await q(`CREATE INDEX IF NOT EXISTS "IDX_patrol_schedules_superseded" ON "patrol_schedules" ("companyId") WHERE "supersededByScheduleId" IS NOT NULL`);

    // Backfill from the audit trail written by the 1.2.1 code before this migration. Only the two new columns are written.
    await q(`
      WITH entries AS (
        SELECT a."id" AS "auditId", a."entityId" AS "predecessorId", a."companyId",
               (a."afterData"->>'successorId')::int AS "successorId", (a."afterData"->>'effectiveAt')::timestamptz AS "effectiveAt"
          FROM "audit_logs" a
         WHERE a."action" = 'patrol.schedule.superseded' AND a."entityType" = 'patrol_schedule' AND a."entityId" IS NOT NULL
           AND (a."afterData"->>'successorId') ~ '^[0-9]+$' AND (a."afterData"->>'effectiveAt') IS NOT NULL
      ),
      valid AS (
        SELECT e.* FROM entries e
          JOIN "patrol_schedules" p ON p."id" = e."predecessorId"
          JOIN "patrol_schedules" s ON s."id" = e."successorId"
         WHERE p."supersededByScheduleId" IS NULL AND p."archivedAt" IS NOT NULL AND p."id" <> s."id"
           AND s."companyId" = p."companyId" AND s."siteId" = p."siteId" AND (e."companyId" IS NULL OR e."companyId" = p."companyId")
           AND NOT EXISTS (SELECT 1 FROM "patrol_schedules" o WHERE o."supersededByScheduleId" = e."successorId")
      ),
      firsts AS (
        SELECT DISTINCT ON ("successorId") * FROM (
          SELECT DISTINCT ON ("predecessorId") * FROM valid ORDER BY "predecessorId", "auditId"
        ) per_predecessor ORDER BY "successorId", "auditId"
      )
      UPDATE "patrol_schedules" p
         SET "supersededByScheduleId" = f."successorId", "supersededAt" = f."effectiveAt"
        FROM firsts f
       WHERE p."id" = f."predecessorId" AND p."supersededByScheduleId" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // A link is the record of which schedule version replaced which, and when. Dropping the columns would lose it (the
    // audit entries stay, but the code that reads the columns would no longer bound the versions), so it is refused while
    // any link exists — as Migration 72 refuses while recovery grants exist. A code rollback never needs this: the
    // previous releases never name the columns.
    const [col] = await queryRunner.query(
      `SELECT 1 AS present FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'patrol_schedules' AND column_name = 'supersededByScheduleId'`,
    );
    const links = col ? Number((await queryRunner.query(`SELECT count(*)::int AS n FROM "patrol_schedules" WHERE "supersededByScheduleId" IS NOT NULL`))[0].n) : 0;
    if (links) {
      throw new Error(
        `Refusing to revert AddPatrolScheduleSuccessors1720900000020: ${links} patrol schedule successor link(s) exist. ` +
          'Export them (pg_dump of patrol_schedules and audit_logs) and get explicit approval before removing them.',
      );
    }
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_patrol_schedules_superseded"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_patrol_schedules_superseded_by"`);
    for (const name of ['FK_patrol_schedules_superseded_by', 'CHK_patrol_schedules_superseded_archived', 'CHK_patrol_schedules_superseded_not_self',
      'CHK_patrol_schedules_superseded_pair']) {
      await queryRunner.query(`ALTER TABLE "patrol_schedules" DROP CONSTRAINT IF EXISTS "${name}"`);
    }
    await queryRunner.query(`ALTER TABLE "patrol_schedules" DROP COLUMN IF EXISTS "supersededAt"`);
    await queryRunner.query(`ALTER TABLE "patrol_schedules" DROP COLUMN IF EXISTS "supersededByScheduleId"`);
  }
}
