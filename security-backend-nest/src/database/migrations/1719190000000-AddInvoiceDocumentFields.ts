import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInvoiceDocumentFields1719190000000 implements MigrationInterface {
  name = 'AddInvoiceDocumentFields1719190000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "invoice_batches"
      ADD COLUMN IF NOT EXISTS "invoiceNumber" character varying,
      ADD COLUMN IF NOT EXISTS "dueDate" timestamp,
      ADD COLUMN IF NOT EXISTS "billingAddressSnapshot" text,
      ADD COLUMN IF NOT EXISTS "clientNameSnapshot" character varying,
      ADD COLUMN IF NOT EXISTS "companyNameSnapshot" character varying,
      ADD COLUMN IF NOT EXISTS "companyAddressSnapshot" text,
      ADD COLUMN IF NOT EXISTS "paymentTermsDays" integer DEFAULT 30,
      ADD COLUMN IF NOT EXISTS "currency" character varying DEFAULT 'GBP',
      ADD COLUMN IF NOT EXISTS "vatRate" numeric(5,2) DEFAULT 20,
      ADD COLUMN IF NOT EXISTS "netAmountSnapshot" numeric(12,2),
      ADD COLUMN IF NOT EXISTS "vatAmountSnapshot" numeric(12,2),
      ADD COLUMN IF NOT EXISTS "grossAmountSnapshot" numeric(12,2)
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_invoice_batches_invoiceNumber"
      ON "invoice_batches" ("invoiceNumber")
      WHERE "invoiceNumber" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_invoice_batches_invoiceNumber"`);
    await queryRunner.query(`
      ALTER TABLE "invoice_batches"
      DROP COLUMN IF EXISTS "grossAmountSnapshot",
      DROP COLUMN IF EXISTS "vatAmountSnapshot",
      DROP COLUMN IF EXISTS "netAmountSnapshot",
      DROP COLUMN IF EXISTS "vatRate",
      DROP COLUMN IF EXISTS "currency",
      DROP COLUMN IF EXISTS "paymentTermsDays",
      DROP COLUMN IF EXISTS "companyAddressSnapshot",
      DROP COLUMN IF EXISTS "companyNameSnapshot",
      DROP COLUMN IF EXISTS "clientNameSnapshot",
      DROP COLUMN IF EXISTS "billingAddressSnapshot",
      DROP COLUMN IF EXISTS "dueDate",
      DROP COLUMN IF EXISTS "invoiceNumber"
    `);
  }
}
