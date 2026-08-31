import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInvoiceBatches1719160000000 implements MigrationInterface {
  name = 'AddInvoiceBatches1719160000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "invoice_batches_status_enum" AS ENUM ('draft', 'finalised', 'issued', 'paid');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "timesheets_billingstatus_enum" AS ENUM ('uninvoiced', 'included', 'invoiced');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "invoice_batches" (
        "id" SERIAL NOT NULL,
        "periodStart" TIMESTAMP NOT NULL,
        "periodEnd" TIMESTAMP NOT NULL,
        "status" "invoice_batches_status_enum" NOT NULL DEFAULT 'draft',
        "invoiceReference" character varying,
        "notes" text,
        "createdByUserId" integer,
        "finalisedAt" TIMESTAMP,
        "issuedAt" TIMESTAMP,
        "paidAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "companyId" integer NOT NULL,
        "clientId" integer NOT NULL,
        CONSTRAINT "PK_invoice_batches_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ADD COLUMN IF NOT EXISTS "billingStatus" "timesheets_billingstatus_enum" NOT NULL DEFAULT 'uninvoiced';
    `);
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ADD COLUMN IF NOT EXISTS "invoiceIssuedAt" TIMESTAMP;
    `);
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ADD COLUMN IF NOT EXISTS "invoicePaidAt" TIMESTAMP;
    `);
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ADD COLUMN IF NOT EXISTS "invoiceBatchId" integer;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "invoice_batches"
        ADD CONSTRAINT "FK_invoice_batches_companyId"
        FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "invoice_batches"
        ADD CONSTRAINT "FK_invoice_batches_clientId"
        FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "timesheets"
        ADD CONSTRAINT "FK_timesheets_invoiceBatchId"
        FOREIGN KEY ("invoiceBatchId") REFERENCES "invoice_batches"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_invoice_batches_companyId" ON "invoice_batches" ("companyId");`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_invoice_batches_clientId" ON "invoice_batches" ("clientId");`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_invoice_batches_status" ON "invoice_batches" ("status");`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_timesheets_invoiceBatchId" ON "timesheets" ("invoiceBatchId");`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_timesheets_billingStatus" ON "timesheets" ("billingStatus");`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_timesheets_billingStatus";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_timesheets_invoiceBatchId";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_invoice_batches_status";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_invoice_batches_clientId";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_invoice_batches_companyId";`);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP CONSTRAINT IF EXISTS "FK_timesheets_invoiceBatchId";
    `);
    await queryRunner.query(`
      ALTER TABLE "invoice_batches"
      DROP CONSTRAINT IF EXISTS "FK_invoice_batches_clientId";
    `);
    await queryRunner.query(`
      ALTER TABLE "invoice_batches"
      DROP CONSTRAINT IF EXISTS "FK_invoice_batches_companyId";
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP COLUMN IF EXISTS "invoiceBatchId";
    `);
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP COLUMN IF EXISTS "invoicePaidAt";
    `);
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP COLUMN IF EXISTS "invoiceIssuedAt";
    `);
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP COLUMN IF EXISTS "billingStatus";
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS "invoice_batches";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "timesheets_billingstatus_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "invoice_batches_status_enum";`);
  }
}
