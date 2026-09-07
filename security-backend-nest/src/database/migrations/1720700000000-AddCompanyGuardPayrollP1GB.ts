import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCompanyGuardPayrollP1GB1720700000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "guard_pay_frequency_enum" AS ENUM (
        'WEEKLY',
        'FORTNIGHTLY',
        'FOUR_WEEKLY',
        'MONTHLY',
        'IRREGULAR'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "guard_payroll_payment_method_enum" AS ENUM (
        'BACS',
        'CHAPS',
        'CASH',
        'OTHER'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "guard_payroll_status_enum" AS ENUM (
        'ACTIVE',
        'ON_HOLD',
        'EXCLUDED'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "company_guard_payroll_records" (
        "id"                   SERIAL PRIMARY KEY,
        "companyGuardId"       integer NOT NULL,
        "companyId"            integer NOT NULL,
        "payrollReference"     varchar(50) NULL,
        "payFrequency"         "guard_pay_frequency_enum" NULL,
        "payrollPaymentMethod" "guard_payroll_payment_method_enum" NULL,
        "payrollStatus"        "guard_payroll_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "payrollStartDate"     date NULL,
        "payrollEndDate"       date NULL,
        "payrollNoteEnc"       text NULL,
        "createdAt"            timestamp NOT NULL DEFAULT now(),
        "updatedAt"            timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_payroll_records_companyGuardId"
          UNIQUE ("companyGuardId"),
        CONSTRAINT "FK_payroll_records_companyGuard"
          FOREIGN KEY ("companyGuardId")
          REFERENCES "company_guards" ("id")
          ON DELETE RESTRICT,
        CONSTRAINT "FK_payroll_records_company"
          FOREIGN KEY ("companyId")
          REFERENCES "companies" ("id")
          ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_payroll_records_company_ref"
        ON "company_guard_payroll_records" ("companyId", "payrollReference")
        WHERE "payrollReference" IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_payroll_records_company_ref"`);
    await queryRunner.query(`DROP TABLE "company_guard_payroll_records"`);
    await queryRunner.query(`DROP TYPE "guard_payroll_status_enum"`);
    await queryRunner.query(`DROP TYPE "guard_payroll_payment_method_enum"`);
    await queryRunner.query(`DROP TYPE "guard_pay_frequency_enum"`);
  }
}
