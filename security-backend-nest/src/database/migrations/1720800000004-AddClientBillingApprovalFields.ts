import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddClientBillingApprovalFields1720800000004 implements MigrationInterface {
  name = 'AddClientBillingApprovalFields1720800000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "timesheets" ADD IF NOT EXISTS "clientBillingApprovedStartAt" TIMESTAMP NULL`);
    await queryRunner.query(`ALTER TABLE "timesheets" ADD IF NOT EXISTS "clientBillingApprovedEndAt" TIMESTAMP NULL`);
    await queryRunner.query(`ALTER TABLE "timesheets" ADD IF NOT EXISTS "clientBillingApprovedMinutes" INTEGER NULL`);
    await queryRunner.query(`ALTER TABLE "timesheets" ADD IF NOT EXISTS "clientBillingCorrectionReason" TEXT NULL`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_cwal_timesheet_superseded" ON "client_weekly_approval_lines" ("timesheetId", "superseded")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_cwal_timesheet_superseded"`);
    await queryRunner.query(`ALTER TABLE "timesheets" DROP COLUMN IF EXISTS "clientBillingCorrectionReason"`);
    await queryRunner.query(`ALTER TABLE "timesheets" DROP COLUMN IF EXISTS "clientBillingApprovedMinutes"`);
    await queryRunner.query(`ALTER TABLE "timesheets" DROP COLUMN IF EXISTS "clientBillingApprovedEndAt"`);
    await queryRunner.query(`ALTER TABLE "timesheets" DROP COLUMN IF EXISTS "clientBillingApprovedStartAt"`);
  }
}
