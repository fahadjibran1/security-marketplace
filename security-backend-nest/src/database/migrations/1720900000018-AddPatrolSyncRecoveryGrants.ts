import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 72: patrol sync recovery grants (S4 Patrols, issue #68 — exceptional offline recovery beyond the post-shift
 * sync window; owner decision 29 Oct 2026, docs/patrols/P1-follow-ups.md §3).
 *
 * Additive only. Nothing existing is backfilled, re-typed or removed. Varchar + CHECK, no PostgreSQL enum.
 *
 *   patrol_sync_recovery_grants  NEW  an Owner / Admin's authorisation for ONE Guard on ONE shift to send patrol data
 *                                     (run start, scan, completion, photo upload) after the standard post-shift sync
 *                                     window has closed. Time-boxed (expiresAt ≤ createdAt + 72 h, CHECKed), a mandatory
 *                                     reason, revocable (revokedAt / revokedByUserId / revokeReason, all or none), and
 *                                     a use counter. Rows are never deleted by the application (they are the record of
 *                                     who allowed late evidence and why).
 *   shifts                       + UNIQUE ("id", "companyId") "UQ_shifts_id_company" — the target of the grant's
 *                                     composite foreign key, so a grant can never name another company's shift even if
 *                                     the service were bypassed. "id" is already the primary key, so it can never
 *                                     reject a row; it only adds an index.
 *
 * Tenancy: (shiftId, companyId) → shifts(id, companyId) RESTRICT; companyId → companies RESTRICT; guardId →
 * guard_profiles; createdByUserId / revokedByUserId → users. Guard profiles are not company-scoped, so "this Guard is on
 * this shift" is checked by the service when the grant is issued.
 *
 * Nothing references the new table from an existing one, so the previous release (Migration 70, P1-C) is unaffected by
 * it and never names it: a Render rollback over a migrated database is safe.
 *
 * Runs in a transaction (no enum change). Every statement is guarded (IF NOT EXISTS / pg_constraint checks), so a
 * repeated run converges. Numbered 1720900000018: 1720900000017 and 1720900000019 are reserved by other branches.
 */
export class AddPatrolSyncRecoveryGrants1720900000018 implements MigrationInterface {
  name = 'AddPatrolSyncRecoveryGrants1720900000018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const q = (sql: string) => queryRunner.query(sql);

    await q(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UQ_shifts_id_company') THEN
          ALTER TABLE "shifts" ADD CONSTRAINT "UQ_shifts_id_company" UNIQUE ("id", "companyId");
        END IF;
      END $$
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_sync_recovery_grants" (
        "id"               SERIAL NOT NULL,
        "companyId"        integer NOT NULL,
        "guardId"          integer NOT NULL,
        "shiftId"          integer NOT NULL,
        "reason"           character varying(1000) NOT NULL,
        "createdByUserId"  integer NOT NULL,
        "createdAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "expiresAt"        TIMESTAMP WITH TIME ZONE NOT NULL,
        "revokedAt"        TIMESTAMP WITH TIME ZONE,
        "revokedByUserId"  integer,
        "revokeReason"     character varying(1000),
        "uses"             integer NOT NULL DEFAULT 0,
        "lastUsedAt"       TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_patrol_sync_recovery_grants" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_patrol_sync_recovery_grants_time_box" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '72 hours'),
        CONSTRAINT "CHK_patrol_sync_recovery_grants_reason" CHECK (char_length(btrim("reason")) >= 3),
        CONSTRAINT "CHK_patrol_sync_recovery_grants_revoked" CHECK (("revokedAt" IS NULL AND "revokedByUserId" IS NULL AND "revokeReason" IS NULL)
          OR ("revokedAt" IS NOT NULL AND "revokedByUserId" IS NOT NULL AND "revokeReason" IS NOT NULL AND char_length(btrim("revokeReason")) >= 3)),
        CONSTRAINT "CHK_patrol_sync_recovery_grants_uses" CHECK ("uses" >= 0 AND ("uses" = 0) = ("lastUsedAt" IS NULL))
      )
    `);

    const constraints: Array<[string, string]> = [
      ['FK_patrol_sync_recovery_grants_company', 'FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['FK_patrol_sync_recovery_grants_shift', 'FOREIGN KEY ("shiftId", "companyId") REFERENCES "shifts"("id", "companyId") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['FK_patrol_sync_recovery_grants_guard', 'FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['FK_patrol_sync_recovery_grants_created_by', 'FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['FK_patrol_sync_recovery_grants_revoked_by', 'FOREIGN KEY ("revokedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
    ];
    for (const [name, definition] of constraints) {
      await q(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
            ALTER TABLE "patrol_sync_recovery_grants" ADD CONSTRAINT "${name}" ${definition};
          END IF;
        END $$
      `);
    }

    // The sync paths look up "an unrevoked grant for this Guard on this shift"; expiry is compared at query time.
    await q(`CREATE INDEX IF NOT EXISTS "IDX_patrol_sync_recovery_grants_active" ON "patrol_sync_recovery_grants" ("companyId", "shiftId", "guardId", "expiresAt") WHERE "revokedAt" IS NULL`);
    await q(`CREATE INDEX IF NOT EXISTS "IDX_patrol_sync_recovery_grants_company" ON "patrol_sync_recovery_grants" ("companyId", "createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // A grant is the record of who authorised late evidence and why. Rolling back would drop that record, so it is
    // refused while any exist: export them (with audit_logs) and decide first. A code rollback never needs this (the
    // previous release never names the table).
    const [table] = await queryRunner.query(`SELECT to_regclass('public.patrol_sync_recovery_grants') AS t`);
    const grants = table?.t ? Number((await queryRunner.query(`SELECT count(*)::int AS n FROM "patrol_sync_recovery_grants"`))[0].n) : 0;
    if (grants) {
      throw new Error(
        `Refusing to revert AddPatrolSyncRecoveryGrants1720900000018: ${grants} patrol sync recovery grant(s) exist. ` +
          'Export them (pg_dump of patrol_sync_recovery_grants and audit_logs) and get explicit approval before removing them.',
      );
    }
    await queryRunner.query(`DROP TABLE IF EXISTS "patrol_sync_recovery_grants"`);
    await queryRunner.query(`ALTER TABLE "shifts" DROP CONSTRAINT IF EXISTS "UQ_shifts_id_company"`);
  }
}
