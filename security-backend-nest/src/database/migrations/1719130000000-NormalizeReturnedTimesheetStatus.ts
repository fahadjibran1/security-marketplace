import { MigrationInterface, QueryRunner } from 'typeorm';

export class NormalizeReturnedTimesheetStatus1719130000000 implements MigrationInterface {
  name = 'NormalizeReturnedTimesheetStatus1719130000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "timesheets"
      SET "approvalStatus" = 'returned'
      WHERE "approvalStatus" = 'draft'
        AND "rejectionReason" IS NOT NULL
        AND btrim("rejectionReason") <> '';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "timesheets"
      SET "approvalStatus" = 'draft'
      WHERE "approvalStatus" = 'returned'
        AND "rejectionReason" IS NOT NULL
        AND btrim("rejectionReason") <> '';
    `);
  }
}
