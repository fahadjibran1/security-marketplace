import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSitesAndTimesheetSubmission1712040000000 implements MigrationInterface {
  name = 'AddSitesAndTimesheetSubmission1712040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sites" (
        "id" SERIAL PRIMARY KEY,
        "companyId" integer NOT NULL,
        "name" character varying NOT NULL,
        "clientName" character varying,
        "address" character varying NOT NULL,
        "contactDetails" character varying,
        "status" character varying NOT NULL DEFAULT 'active',
        "welfareCheckIntervalMinutes" integer NOT NULL DEFAULT 60,
        CONSTRAINT "FK_sites_company" FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "siteId" integer;
      ALTER TABLE "shifts" ADD COLUMN IF NOT EXISTS "siteId" integer;
      ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "submittedAt" timestamp;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'FK_jobs_site'
        ) THEN
          ALTER TABLE "jobs"
          ADD CONSTRAINT "FK_jobs_site" FOREIGN KEY ("siteId") REFERENCES "sites" ("id") ON DELETE SET NULL;
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'FK_shifts_site'
        ) THEN
          ALTER TABLE "shifts"
          ADD CONSTRAINT "FK_shifts_site" FOREIGN KEY ("siteId") REFERENCES "sites" ("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets" ALTER COLUMN "approvalStatus" SET DEFAULT 'draft';
      UPDATE "timesheets"
      SET "approvalStatus" = 'draft'
      WHERE "approvalStatus" = 'pending';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "timesheets" ALTER COLUMN "approvalStatus" SET DEFAULT 'pending';`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "FK_jobs_site";`);
    await queryRunner.query(`ALTER TABLE "shifts" DROP CONSTRAINT IF EXISTS "FK_shifts_site";`);
    await queryRunner.query(`ALTER TABLE "timesheets" DROP COLUMN IF EXISTS "submittedAt";`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN IF EXISTS "siteId";`);
    await queryRunner.query(`ALTER TABLE "shifts" DROP COLUMN IF EXISTS "siteId";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sites";`);
  }
}
