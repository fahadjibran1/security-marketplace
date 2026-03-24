import { MigrationInterface, QueryRunner } from 'typeorm';

export class PhaseFourTimesheetsAndIncidents1716040000000 implements MigrationInterface {
  name = 'PhaseFourTimesheetsAndIncidents1716040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'timesheets_approvalstatus_enum') THEN
          CREATE TYPE "timesheets_approvalstatus_enum" AS ENUM ('draft', 'submitted', 'approved', 'rejected');
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ADD COLUMN IF NOT EXISTS "scheduledStartAt" timestamp,
      ADD COLUMN IF NOT EXISTS "scheduledEndAt" timestamp,
      ADD COLUMN IF NOT EXISTS "actualCheckInAt" timestamp,
      ADD COLUMN IF NOT EXISTS "actualCheckOutAt" timestamp,
      ADD COLUMN IF NOT EXISTS "workedMinutes" integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "breakMinutes" integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "roundedMinutes" integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "reviewedAt" timestamp,
      ADD COLUMN IF NOT EXISTS "reviewedByUserId" integer,
      ADD COLUMN IF NOT EXISTS "rejectionReason" text,
      ADD COLUMN IF NOT EXISTS "updatedAt" timestamp NOT NULL DEFAULT now();
    `);

    await queryRunner.query(`
      UPDATE "timesheets"
      SET "approvalStatus" = CASE
        WHEN "approvalStatus" = 'pending' THEN 'submitted'
        ELSE COALESCE(NULLIF("approvalStatus", ''), 'draft')
      END
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ALTER COLUMN "approvalStatus" DROP DEFAULT
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ALTER COLUMN "approvalStatus"
      TYPE "timesheets_approvalstatus_enum"
      USING (
        CASE
          WHEN "approvalStatus" = 'pending' THEN 'submitted'
          WHEN "approvalStatus" IN ('draft', 'submitted', 'approved', 'rejected') THEN "approvalStatus"
          ELSE 'draft'
        END
      )::"timesheets_approvalstatus_enum"
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ALTER COLUMN "approvalStatus" SET DEFAULT 'draft'
    `);

    await queryRunner.query(`
      UPDATE "timesheets" "t"
      SET
        "scheduledStartAt" = COALESCE("t"."scheduledStartAt", "s"."start"),
        "scheduledEndAt" = COALESCE("t"."scheduledEndAt", "s"."end"),
        "actualCheckInAt" = COALESCE("t"."actualCheckInAt", "a"."checkedInAt"),
        "actualCheckOutAt" = COALESCE("t"."actualCheckOutAt", "a"."checkedOutAt"),
        "workedMinutes" = CASE
          WHEN "t"."workedMinutes" = 0 AND "t"."hoursWorked" > 0 THEN ROUND("t"."hoursWorked" * 60)
          ELSE "t"."workedMinutes"
        END,
        "roundedMinutes" = CASE
          WHEN "t"."roundedMinutes" = 0 AND "t"."hoursWorked" > 0 THEN ROUND("t"."hoursWorked" * 60)
          ELSE "t"."roundedMinutes"
        END
      FROM "shifts" "s"
      LEFT JOIN "assignments" "a" ON "a"."id" = "s"."assignmentId"
      WHERE "t"."shiftId" = "s"."id"
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'incidents_category_enum') THEN
          CREATE TYPE "incidents_category_enum" AS ENUM (
            'trespass',
            'theft',
            'damage',
            'violence',
            'fire',
            'health_safety',
            'access_control',
            'other'
          );
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'incidents_status_enum') THEN
          CREATE TYPE "incidents_status_enum" AS ENUM ('open', 'in_review', 'resolved', 'closed');
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      ALTER TABLE "incidents"
      ADD COLUMN IF NOT EXISTS "category" "incidents_category_enum" NOT NULL DEFAULT 'other',
      ADD COLUMN IF NOT EXISTS "siteId" integer,
      ADD COLUMN IF NOT EXISTS "reportedAt" timestamp NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS "reviewedAt" timestamp,
      ADD COLUMN IF NOT EXISTS "reviewedByUserId" integer,
      ADD COLUMN IF NOT EXISTS "closedAt" timestamp,
      ADD COLUMN IF NOT EXISTS "closedByUserId" integer,
      ADD COLUMN IF NOT EXISTS "updatedAt" timestamp NOT NULL DEFAULT now();
    `);

    await queryRunner.query(`
      ALTER TABLE "incidents"
      ALTER COLUMN "status" DROP DEFAULT
    `);

    await queryRunner.query(`
      ALTER TABLE "incidents"
      ALTER COLUMN "status"
      TYPE "incidents_status_enum"
      USING (
        CASE
          WHEN "status" IN ('open', 'in_review', 'resolved', 'closed') THEN "status"
          ELSE 'open'
        END
      )::"incidents_status_enum"
    `);

    await queryRunner.query(`
      ALTER TABLE "incidents"
      ALTER COLUMN "status" SET DEFAULT 'open'
    `);

    await queryRunner.query(`
      UPDATE "incidents" "i"
      SET
        "siteId" = COALESCE("i"."siteId", "s"."siteId"),
        "reportedAt" = COALESCE("i"."reportedAt", "i"."createdAt")
      FROM "shifts" "s"
      WHERE "i"."shiftId" = "s"."id"
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'FK_incidents_site'
            AND table_name = 'incidents'
        ) THEN
          ALTER TABLE "incidents"
          ADD CONSTRAINT "FK_incidents_site"
          FOREIGN KEY ("siteId") REFERENCES "sites"("id")
          ON DELETE SET NULL;
        END IF;
      END$$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "incidents"
      ALTER COLUMN "status" DROP DEFAULT
    `);
    await queryRunner.query(`
      ALTER TABLE "incidents"
      ALTER COLUMN "status"
      TYPE character varying
      USING "status"::text
    `);
    await queryRunner.query(`
      ALTER TABLE "incidents"
      ALTER COLUMN "status" SET DEFAULT 'open'
    `);
    await queryRunner.query(`
      ALTER TABLE "incidents" DROP CONSTRAINT IF EXISTS "FK_incidents_site"
    `);
    await queryRunner.query(`
      ALTER TABLE "incidents"
      DROP COLUMN IF EXISTS "siteId",
      DROP COLUMN IF EXISTS "category",
      DROP COLUMN IF EXISTS "reportedAt",
      DROP COLUMN IF EXISTS "reviewedAt",
      DROP COLUMN IF EXISTS "reviewedByUserId",
      DROP COLUMN IF EXISTS "closedAt",
      DROP COLUMN IF EXISTS "closedByUserId",
      DROP COLUMN IF EXISTS "updatedAt"
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS "incidents_category_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "incidents_status_enum"`);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ALTER COLUMN "approvalStatus" DROP DEFAULT
    `);
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ALTER COLUMN "approvalStatus"
      TYPE character varying
      USING "approvalStatus"::text
    `);
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ALTER COLUMN "approvalStatus" SET DEFAULT 'draft'
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP COLUMN IF EXISTS "scheduledStartAt",
      DROP COLUMN IF EXISTS "scheduledEndAt",
      DROP COLUMN IF EXISTS "actualCheckInAt",
      DROP COLUMN IF EXISTS "actualCheckOutAt",
      DROP COLUMN IF EXISTS "workedMinutes",
      DROP COLUMN IF EXISTS "breakMinutes",
      DROP COLUMN IF EXISTS "roundedMinutes",
      DROP COLUMN IF EXISTS "reviewedAt",
      DROP COLUMN IF EXISTS "reviewedByUserId",
      DROP COLUMN IF EXISTS "rejectionReason",
      DROP COLUMN IF EXISTS "updatedAt"
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS "timesheets_approvalstatus_enum"`);
  }
}
