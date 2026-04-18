import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTimesheetPayrollLifecycle1719140000000 implements MigrationInterface {
  name = 'AddTimesheetPayrollLifecycle1719140000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'timesheets_payrollstatus_enum') THEN
          CREATE TYPE "timesheets_payrollstatus_enum" AS ENUM ('unpaid', 'included', 'paid');
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ADD COLUMN IF NOT EXISTS "payrollStatus" "timesheets_payrollstatus_enum" NOT NULL DEFAULT 'unpaid';
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ADD COLUMN IF NOT EXISTS "payrollIncludedAt" TIMESTAMP;
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ADD COLUMN IF NOT EXISTS "payrollPaidAt" TIMESTAMP;
    `);

    await queryRunner.query(`
      UPDATE "timesheets"
      SET "payrollStatus" = 'unpaid'
      WHERE "payrollStatus" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP COLUMN IF EXISTS "payrollPaidAt";
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP COLUMN IF EXISTS "payrollIncludedAt";
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP COLUMN IF EXISTS "payrollStatus";
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "timesheets_payrollstatus_enum";
    `);
  }
}
