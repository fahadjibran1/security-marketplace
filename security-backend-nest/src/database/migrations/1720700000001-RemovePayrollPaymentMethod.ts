import { MigrationInterface, QueryRunner } from 'typeorm';

// P1G-B product-scope correction: payrollPaymentMethod (BACS/CHAPS/CASH/OTHER) is a
// payment-execution concept that belongs in the company's external payroll system.
// S4 is an operational workforce evidence platform and does not execute payments.
export class RemovePayrollPaymentMethod1720700000001 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "company_guard_payroll_records"
        DROP COLUMN IF EXISTS "payrollPaymentMethod"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "guard_payroll_payment_method_enum"
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "guard_payroll_payment_method_enum" AS ENUM (
        'BACS',
        'CHAPS',
        'CASH',
        'OTHER'
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "company_guard_payroll_records"
        ADD COLUMN "payrollPaymentMethod" "guard_payroll_payment_method_enum" NULL
    `);
  }
}
