import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPayRuleConfigAndPayableSnapshots1719220000000 implements MigrationInterface {
  name = 'AddPayRuleConfigAndPayableSnapshots1719220000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "pay_rule_configs" (
        "id" SERIAL NOT NULL,
        "companyId" integer NOT NULL,
        "overtimeThresholdHours" numeric(8,2),
        "overtimeMultiplier" numeric(6,2) NOT NULL DEFAULT 1,
        "nightStart" character varying(5),
        "nightEnd" character varying(5),
        "nightMultiplier" numeric(6,2) NOT NULL DEFAULT 1,
        "weekendMultiplier" numeric(6,2) NOT NULL DEFAULT 1,
        "bankHolidayMultiplier" numeric(6,2) NOT NULL DEFAULT 1,
        "minimumPaidHours" numeric(8,2),
        "unpaidBreakMinutes" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_pay_rule_configs_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_pay_rule_configs_companyId" UNIQUE ("companyId"),
        CONSTRAINT "FK_pay_rule_configs_companyId" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "timesheets"
      ADD COLUMN IF NOT EXISTS "payableHoursSnapshot" numeric(8,2),
      ADD COLUMN IF NOT EXISTS "payableAmountSnapshot" numeric(10,2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "timesheets"
      DROP COLUMN IF EXISTS "payableAmountSnapshot",
      DROP COLUMN IF EXISTS "payableHoursSnapshot"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "pay_rule_configs"`);
  }
}
