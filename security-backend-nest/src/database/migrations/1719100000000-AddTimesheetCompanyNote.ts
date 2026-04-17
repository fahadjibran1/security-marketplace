import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTimesheetCompanyNote1719100000000 implements MigrationInterface {
  name = 'AddTimesheetCompanyNote1719100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ADD COLUMN IF NOT EXISTS "companyNote" text;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP COLUMN IF EXISTS "companyNote";
    `);
  }
}
