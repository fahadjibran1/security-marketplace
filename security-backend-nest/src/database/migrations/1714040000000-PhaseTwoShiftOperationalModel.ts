import { MigrationInterface, QueryRunner } from 'typeorm';

export class PhaseTwoShiftOperationalModel1714040000000 implements MigrationInterface {
  name = 'PhaseTwoShiftOperationalModel1714040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "assignedAt" timestamp;
      ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "acceptedAt" timestamp;
      ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "checkedInAt" timestamp;
      ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "checkedOutAt" timestamp;
      ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "checkInLat" numeric(10,7);
      ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "checkInLng" numeric(10,7);
      ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "checkOutLat" numeric(10,7);
      ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "checkOutLng" numeric(10,7);
      ALTER TABLE "shifts" ADD COLUMN IF NOT EXISTS "jobId" integer;
      ALTER TABLE "shifts" ADD COLUMN IF NOT EXISTS "jobApplicationId" integer;
      ALTER TABLE "shifts" ADD COLUMN IF NOT EXISTS "createdByUserId" integer;
    `);

    await queryRunner.query(`
      UPDATE "assignments"
      SET
        "assignedAt" = COALESCE("assignedAt", "hiredAt"),
        "status" = CASE
          WHEN "status" = 'active' THEN 'assigned'
          ELSE "status"
        END
      WHERE "assignedAt" IS NULL OR "status" = 'active';
    `);

    await queryRunner.query(`
      UPDATE "shifts" AS "shift"
      SET
        "jobId" = COALESCE("shift"."jobId", "assignment"."jobId"),
        "jobApplicationId" = COALESCE("shift"."jobApplicationId", "assignment"."applicationId"),
        "createdByUserId" = COALESCE("shift"."createdByUserId", "company"."userId")
      FROM "assignments" AS "assignment"
      LEFT JOIN "companies" AS "company" ON "company"."id" = "assignment"."companyId"
      WHERE "assignment"."id" = "shift"."assignmentId";
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'FK_shifts_job'
        ) THEN
          ALTER TABLE "shifts"
          ADD CONSTRAINT "FK_shifts_job" FOREIGN KEY ("jobId") REFERENCES "jobs" ("id") ON DELETE SET NULL;
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'FK_shifts_job_application'
        ) THEN
          ALTER TABLE "shifts"
          ADD CONSTRAINT "FK_shifts_job_application" FOREIGN KEY ("jobApplicationId") REFERENCES "job_applications" ("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shifts" DROP CONSTRAINT IF EXISTS "FK_shifts_job_application";`);
    await queryRunner.query(`ALTER TABLE "shifts" DROP CONSTRAINT IF EXISTS "FK_shifts_job";`);
    await queryRunner.query(`ALTER TABLE "shifts" DROP COLUMN IF EXISTS "createdByUserId";`);
    await queryRunner.query(`ALTER TABLE "shifts" DROP COLUMN IF EXISTS "jobApplicationId";`);
    await queryRunner.query(`ALTER TABLE "shifts" DROP COLUMN IF EXISTS "jobId";`);
    await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN IF EXISTS "checkOutLng";`);
    await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN IF EXISTS "checkOutLat";`);
    await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN IF EXISTS "checkInLng";`);
    await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN IF EXISTS "checkInLat";`);
    await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN IF EXISTS "checkedOutAt";`);
    await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN IF EXISTS "checkedInAt";`);
    await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN IF EXISTS "acceptedAt";`);
    await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN IF EXISTS "assignedAt";`);
  }
}
