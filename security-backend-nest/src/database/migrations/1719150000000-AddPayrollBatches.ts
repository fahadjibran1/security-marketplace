import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPayrollBatches1719150000000 implements MigrationInterface {
  name = 'AddPayrollBatches1719150000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payroll_batches_status_enum') THEN
          CREATE TYPE "payroll_batches_status_enum" AS ENUM ('draft', 'finalised', 'paid');
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "payroll_batches" (
        "id" SERIAL NOT NULL,
        "periodStart" TIMESTAMP NOT NULL,
        "periodEnd" TIMESTAMP NOT NULL,
        "status" "payroll_batches_status_enum" NOT NULL DEFAULT 'draft',
        "notes" text,
        "createdByUserId" integer,
        "finalisedAt" TIMESTAMP,
        "paidAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "companyId" integer,
        CONSTRAINT "PK_payroll_batches_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      ALTER TABLE "payroll_batches"
      ADD CONSTRAINT "FK_payroll_batches_companyId"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ADD COLUMN IF NOT EXISTS "payrollBatchId" integer;
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ADD CONSTRAINT "FK_timesheets_payrollBatchId"
      FOREIGN KEY ("payrollBatchId") REFERENCES "payroll_batches"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payroll_batches_companyId" ON "payroll_batches" ("companyId");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_timesheets_payrollBatchId" ON "timesheets" ("payrollBatchId");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_timesheets_payrollBatchId";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_payroll_batches_companyId";
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP CONSTRAINT IF EXISTS "FK_timesheets_payrollBatchId";
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP COLUMN IF EXISTS "payrollBatchId";
    `);

    await queryRunner.query(`
      ALTER TABLE "payroll_batches"
      DROP CONSTRAINT IF EXISTS "FK_payroll_batches_companyId";
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS "payroll_batches";
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "payroll_batches_status_enum";
    `);
  }
}
