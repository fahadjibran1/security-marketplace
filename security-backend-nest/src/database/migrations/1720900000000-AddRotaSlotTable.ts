import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRotaSlotTable1720900000000 implements MigrationInterface {
  name = 'AddRotaSlotTable1720900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create rota_slots table.
    //
    // FK notes:
    //   companyId  — default RESTRICT (matches existing company FK convention)
    //   siteId     — RESTRICT (sites have no DELETE endpoint; constraint is a safety net)
    //   jobId      — SET NULL (optional context; slot survives job deletion)
    //   copiedFromSlotId — SET NULL (self-ref; source slot deletion does not cascade)
    //
    // Status: plain varchar DEFAULT 'active'. Valid values: 'active' | 'cancelled'.
    // 'completed' is intentionally absent — derived from endAt at query time.
    //
    // Idempotency unique index on (copiedFromSlotId, DATE(startAt)) is DEFERRED
    // to the Copy Week service phase — deferred in R4B1 per section J decision.

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rota_slots" (
        "id"                       SERIAL PRIMARY KEY,
        "companyId"                INTEGER NOT NULL
                                     REFERENCES "companies"("id"),
        "siteId"                   INTEGER NOT NULL
                                     REFERENCES "sites"("id") ON DELETE RESTRICT,
        "jobId"                    INTEGER NULL
                                     REFERENCES "jobs"("id") ON DELETE SET NULL,
        "copiedFromSlotId"         INTEGER NULL
                                     REFERENCES "rota_slots"("id") ON DELETE SET NULL,
        "startAt"                  TIMESTAMP NOT NULL,
        "endAt"                    TIMESTAMP NOT NULL,
        "requiredGuardCount"       INTEGER NOT NULL DEFAULT 1,
        "checkCallIntervalMinutes" INTEGER NOT NULL DEFAULT 60,
        "instructions"             TEXT NULL,
        "title"                    VARCHAR(255) NULL,
        "status"                   VARCHAR NOT NULL DEFAULT 'active',
        "createdAt"                TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"                TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_rota_slots_required_count" CHECK ("requiredGuardCount" >= 1),
        CONSTRAINT "CHK_rota_slots_time_window"    CHECK ("endAt" > "startAt")
      )
    `);

    // Week-range query: company week view (primary access pattern)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rota_slots_company_week"
        ON "rota_slots" ("companyId", "startAt", "endAt")
    `);

    // Site-level week view (planning and coverage roll-up)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rota_slots_site_week"
        ON "rota_slots" ("siteId", "startAt", "endAt")
    `);

    // Copy-week tracing (copiedFromSlotId FK lookup)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rota_slots_copied_from"
        ON "rota_slots" ("copiedFromSlotId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rota_slots_copied_from"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rota_slots_site_week"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rota_slots_company_week"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rota_slots"`);
  }
}
