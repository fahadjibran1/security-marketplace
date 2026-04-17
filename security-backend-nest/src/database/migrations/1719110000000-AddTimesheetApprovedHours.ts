import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTimesheetApprovedHours1719110000000 implements MigrationInterface {
  name = 'AddTimesheetApprovedHours1719110000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ADD COLUMN IF NOT EXISTS "approvedHours" numeric(8,2);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP COLUMN IF EXISTS "approvedHours";
    `);
  }
}
