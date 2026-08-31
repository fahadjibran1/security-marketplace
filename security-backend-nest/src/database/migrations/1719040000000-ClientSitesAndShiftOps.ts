import { MigrationInterface, QueryRunner } from 'typeorm';

export class ClientSitesAndShiftOps1719040000000 implements MigrationInterface {
  name = 'ClientSitesAndShiftOps1719040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "clients" (
        "id" SERIAL NOT NULL,
        "name" character varying NOT NULL,
        "contactName" character varying,
        "contactDetails" character varying,
        "status" character varying NOT NULL DEFAULT 'active',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "companyId" integer,
        CONSTRAINT "PK_clients_id" PRIMARY KEY ("id")
      );
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'FK_clients_company'
        ) THEN
          ALTER TABLE "clients"
          ADD CONSTRAINT "FK_clients_company"
          FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END$$;
    `);
    await queryRunner.query(`
      ALTER TABLE "sites"
      ADD COLUMN IF NOT EXISTS "clientId" integer;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'FK_sites_client'
        ) THEN
          ALTER TABLE "sites"
          ADD CONSTRAINT "FK_sites_client"
          FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END$$;
    `);
    await queryRunner.query(`
      INSERT INTO "clients" ("name", "status", "createdAt", "updatedAt", "companyId")
      SELECT DISTINCT s."clientName", 'active', NOW(), NOW(), s."companyId"
      FROM "sites" s
      WHERE s."clientName" IS NOT NULL
        AND btrim(s."clientName") <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM "clients" c
          WHERE c."companyId" = s."companyId"
            AND lower(c."name") = lower(s."clientName")
        );
    `);
    await queryRunner.query(`
      UPDATE "sites" s
      SET "clientId" = c."id"
      FROM "clients" c
      WHERE s."companyId" = c."companyId"
        AND s."clientName" IS NOT NULL
        AND lower(s."clientName") = lower(c."name")
        AND s."clientId" IS NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "shifts"
      ADD COLUMN IF NOT EXISTS "checkCallIntervalMinutes" integer NOT NULL DEFAULT 60;
    `);
    await queryRunner.query(`
      UPDATE "shifts" s
      SET "checkCallIntervalMinutes" = COALESCE(site."welfareCheckIntervalMinutes", 60)
      FROM "sites" site
      WHERE s."siteId" = site."id";
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TYPE "public"."daily_logs_logtype_enum" ADD VALUE IF NOT EXISTS 'check_call';
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END$$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TYPE "public"."daily_logs_logtype_enum" ADD VALUE IF NOT EXISTS 'welfare_check';
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END$$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sites" DROP CONSTRAINT IF EXISTS "FK_sites_client";`);
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN IF EXISTS "clientId";`);
    await queryRunner.query(`ALTER TABLE "shifts" DROP COLUMN IF EXISTS "checkCallIntervalMinutes";`);
    await queryRunner.query(`ALTER TABLE "clients" DROP CONSTRAINT IF EXISTS "FK_clients_company";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "clients";`);
  }
}
