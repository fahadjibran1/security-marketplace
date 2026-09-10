import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCompanyApprovedTimes1720800000003 implements MigrationInterface {
  name = 'AddCompanyApprovedTimes1720800000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "timesheets" ADD "companyApprovedStartAt" TIMESTAMP NULL`);
    await queryRunner.query(`ALTER TABLE "timesheets" ADD "companyApprovedEndAt" TIMESTAMP NULL`);
    await queryRunner.query(`ALTER TABLE "client_weekly_approval_lines" ADD "companyApprovedStartAtSubmission" TIMESTAMPTZ NULL`);
    await queryRunner.query(`ALTER TABLE "client_weekly_approval_lines" ADD "companyApprovedEndAtSubmission" TIMESTAMPTZ NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "client_weekly_approval_lines" DROP COLUMN IF EXISTS "companyApprovedEndAtSubmission"`);
    await queryRunner.query(`ALTER TABLE "client_weekly_approval_lines" DROP COLUMN IF EXISTS "companyApprovedStartAtSubmission"`);
    await queryRunner.query(`ALTER TABLE "timesheets" DROP COLUMN IF EXISTS "companyApprovedEndAt"`);
    await queryRunner.query(`ALTER TABLE "timesheets" DROP COLUMN IF EXISTS "companyApprovedStartAt"`);
  }
}
