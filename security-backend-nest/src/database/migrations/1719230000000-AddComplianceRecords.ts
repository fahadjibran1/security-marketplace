import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddComplianceRecords1719230000000 implements MigrationInterface {
  name = 'AddComplianceRecords1719230000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'compliance_records_type_enum') THEN
          CREATE TYPE "public"."compliance_records_type_enum" AS ENUM('SIA', 'RIGHT_TO_WORK', 'TRAINING', 'OTHER');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'compliance_records_status_enum') THEN
          CREATE TYPE "public"."compliance_records_status_enum" AS ENUM('valid', 'expiring', 'expired');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "compliance_records" (
        "id" SERIAL NOT NULL,
        "companyId" integer NOT NULL,
        "guardId" integer NOT NULL,
        "type" "public"."compliance_records_type_enum" NOT NULL,
        "documentName" character varying NOT NULL,
        "documentNumber" character varying,
        "issueDate" date,
        "expiryDate" date NOT NULL,
        "status" "public"."compliance_records_status_enum" NOT NULL DEFAULT 'valid',
        "reminderSentAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_compliance_records_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_compliance_records_companyId" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_compliance_records_guardId" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_compliance_records_company_guard_type"
      ON "compliance_records" ("companyId", "guardId", "type")
    `);

    await queryRunner.query(`ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'compliance_alert'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_compliance_records_company_guard_type"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "compliance_records"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."compliance_records_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."compliance_records_type_enum"`);
  }
}
