import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPaymentRecords1719280000000 implements MigrationInterface {
  name = 'AddPaymentRecords1719280000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_records_method_enum') THEN
          CREATE TYPE "public"."payment_records_method_enum" AS ENUM('bank_transfer', 'cash', 'card', 'other');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "payment_records" (
        "id" SERIAL NOT NULL,
        "companyId" integer NOT NULL,
        "invoiceBatchId" integer NOT NULL,
        "amount" numeric(12,2) NOT NULL,
        "paymentDate" TIMESTAMP NOT NULL,
        "method" "public"."payment_records_method_enum" NOT NULL DEFAULT 'bank_transfer',
        "reference" character varying,
        "notes" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_payment_records_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_payment_records_companyId" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_payment_records_invoiceBatchId" FOREIGN KEY ("invoiceBatchId") REFERENCES "invoice_batches"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_payment_records_company_invoice" ON "payment_records" ("companyId", "invoiceBatchId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_payment_records_paymentDate" ON "payment_records" ("paymentDate")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payment_records_paymentDate"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payment_records_company_invoice"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payment_records"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."payment_records_method_enum"`);
  }
}
