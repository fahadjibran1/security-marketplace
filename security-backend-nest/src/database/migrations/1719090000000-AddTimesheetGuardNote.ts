import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTimesheetGuardNote1719090000000 implements MigrationInterface {
  name = 'AddTimesheetGuardNote1719090000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ADD COLUMN IF NOT EXISTS "guardNote" text;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP COLUMN IF EXISTS "guardNote";
    `);
  }
}
