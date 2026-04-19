import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTimesheetFinancialSnapshots1719200000000 implements MigrationInterface {
  name = 'AddTimesheetFinancialSnapshots1719200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ADD COLUMN IF NOT EXISTS "approvedHoursSnapshot" numeric(8,2),
      ADD COLUMN IF NOT EXISTS "hourlyRateSnapshot" numeric(10,2),
      ADD COLUMN IF NOT EXISTS "billingRateSnapshot" numeric(10,2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP COLUMN IF EXISTS "billingRateSnapshot",
      DROP COLUMN IF EXISTS "hourlyRateSnapshot",
      DROP COLUMN IF EXISTS "approvedHoursSnapshot"
    `);
  }
}
