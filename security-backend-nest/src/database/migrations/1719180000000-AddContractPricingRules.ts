import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddContractPricingRules1719180000000 implements MigrationInterface {
  name = 'AddContractPricingRules1719180000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "contract_pricing_rules_status_enum" AS ENUM ('active', 'inactive');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "contract_pricing_rules" (
        "id" SERIAL NOT NULL,
        "name" character varying NOT NULL,
        "status" "contract_pricing_rules_status_enum" NOT NULL DEFAULT 'active',
        "priority" integer NOT NULL DEFAULT 100,
        "effectiveFrom" TIMESTAMP,
        "effectiveTo" TIMESTAMP,
        "billingRate" numeric(10,2),
        "minimumBillableHours" numeric(8,2),
        "roundUpToMinutes" integer,
        "graceMinutes" integer,
        "appliesOnMonday" boolean NOT NULL DEFAULT true,
        "appliesOnTuesday" boolean NOT NULL DEFAULT true,
        "appliesOnWednesday" boolean NOT NULL DEFAULT true,
        "appliesOnThursday" boolean NOT NULL DEFAULT true,
        "appliesOnFriday" boolean NOT NULL DEFAULT true,
        "appliesOnSaturday" boolean NOT NULL DEFAULT true,
        "appliesOnSunday" boolean NOT NULL DEFAULT true,
        "startTime" character varying,
        "endTime" character varying,
        "appliesOnBankHoliday" boolean,
        "appliesOnWeekendOnly" boolean NOT NULL DEFAULT false,
        "appliesOnOvernightShift" boolean,
        "flatCallOutFee" numeric(10,2),
        "deductionHoursBeforeBilling" numeric(8,2),
        "notes" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "companyId" integer NOT NULL,
        "clientId" integer NOT NULL,
        "siteId" integer,
        CONSTRAINT "PK_contract_pricing_rules_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "contract_pricing_rules"
        ADD CONSTRAINT "FK_contract_pricing_rules_companyId"
        FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "contract_pricing_rules"
        ADD CONSTRAINT "FK_contract_pricing_rules_clientId"
        FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "contract_pricing_rules"
        ADD CONSTRAINT "FK_contract_pricing_rules_siteId"
        FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_contract_pricing_rules_companyId" ON "contract_pricing_rules" ("companyId");`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_contract_pricing_rules_clientId" ON "contract_pricing_rules" ("clientId");`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_contract_pricing_rules_siteId" ON "contract_pricing_rules" ("siteId");`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_contract_pricing_rules_status" ON "contract_pricing_rules" ("status");`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_contract_pricing_rules_priority" ON "contract_pricing_rules" ("priority");`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_contract_pricing_rules_priority";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_contract_pricing_rules_status";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_contract_pricing_rules_siteId";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_contract_pricing_rules_clientId";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_contract_pricing_rules_companyId";`);
    await queryRunner.query(`ALTER TABLE "contract_pricing_rules" DROP CONSTRAINT IF EXISTS "FK_contract_pricing_rules_siteId";`);
    await queryRunner.query(`ALTER TABLE "contract_pricing_rules" DROP CONSTRAINT IF EXISTS "FK_contract_pricing_rules_clientId";`);
    await queryRunner.query(`ALTER TABLE "contract_pricing_rules" DROP CONSTRAINT IF EXISTS "FK_contract_pricing_rules_companyId";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "contract_pricing_rules";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "contract_pricing_rules_status_enum";`);
  }
}
