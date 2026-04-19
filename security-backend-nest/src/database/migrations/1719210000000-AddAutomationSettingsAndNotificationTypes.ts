import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAutomationSettingsAndNotificationTypes1719210000000 implements MigrationInterface {
  name = 'AddAutomationSettingsAndNotificationTypes1719210000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
      ADD COLUMN IF NOT EXISTS "autoCreatePayrollBatch" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "autoCreateInvoiceBatch" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "autoFinalisePayrollBatch" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "autoIssueInvoiceBatch" boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'financial_reminder'`);
    await queryRunner.query(`ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'payroll_suggestion'`);
    await queryRunner.query(`ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'invoice_suggestion'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
      DROP COLUMN IF EXISTS "autoIssueInvoiceBatch",
      DROP COLUMN IF EXISTS "autoFinalisePayrollBatch",
      DROP COLUMN IF EXISTS "autoCreateInvoiceBatch",
      DROP COLUMN IF EXISTS "autoCreatePayrollBatch"
    `);
  }
}
