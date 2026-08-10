import { MigrationInterface, QueryRunner } from 'typeorm';

// RB-007: attendance-verified duration becomes the source of truth for payroll.
// All columns are nullable additive columns on an existing table — safe on a
// non-empty "timesheets" table, no backfill required, no NOT NULL constraint.
export class AddTimesheetVerifiedPayroll1719600000000 implements MigrationInterface {
  name = 'AddTimesheetVerifiedPayroll1719600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "verifiedMinutes" integer`);
    await queryRunner.query(`ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "approvedMinutes" integer`);
    await queryRunner.query(`ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "overrideReason" text`);
    await queryRunner.query(`ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "overrideBy" integer`);
    await queryRunner.query(`ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "overrideAt" timestamp`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "timesheets" DROP COLUMN IF EXISTS "overrideAt"`);
    await queryRunner.query(`ALTER TABLE "timesheets" DROP COLUMN IF EXISTS "overrideBy"`);
    await queryRunner.query(`ALTER TABLE "timesheets" DROP COLUMN IF EXISTS "overrideReason"`);
    await queryRunner.query(`ALTER TABLE "timesheets" DROP COLUMN IF EXISTS "approvedMinutes"`);
    await queryRunner.query(`ALTER TABLE "timesheets" DROP COLUMN IF EXISTS "verifiedMinutes"`);
  }
}
