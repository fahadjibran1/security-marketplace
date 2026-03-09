import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCompanyGuardsAndTimesheetOneToOne1710000001000 implements MigrationInterface {
  name = 'AddCompanyGuardsAndTimesheetOneToOne1710000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."company_guards_status_enum" AS ENUM('ACTIVE', 'INACTIVE', 'BLOCKED')`);
    await queryRunner.query(`CREATE TYPE "public"."company_guards_relationshiptype_enum" AS ENUM('EMPLOYEE', 'PREFERRED', 'APPROVED_CONTRACTOR')`);

    await queryRunner.query(`CREATE TABLE "company_guards" (
      "id" SERIAL NOT NULL,
      "status" "public"."company_guards_status_enum" NOT NULL DEFAULT 'ACTIVE',
      "relationshipType" "public"."company_guards_relationshiptype_enum" NOT NULL DEFAULT 'APPROVED_CONTRACTOR',
      "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
      "companyId" integer,
      "guardId" integer,
      CONSTRAINT "UQ_company_guard" UNIQUE ("companyId", "guardId"),
      CONSTRAINT "PK_company_guards_id" PRIMARY KEY ("id")
    )`);

    await queryRunner.query(`ALTER TABLE "company_guards" ADD CONSTRAINT "FK_company_guard_company" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "company_guards" ADD CONSTRAINT "FK_company_guard_guard" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);

    await queryRunner.query(`ALTER TABLE "timesheets" ADD CONSTRAINT "UQ_timesheets_shift" UNIQUE ("shiftId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "timesheets" DROP CONSTRAINT "UQ_timesheets_shift"`);
    await queryRunner.query(`ALTER TABLE "company_guards" DROP CONSTRAINT "FK_company_guard_guard"`);
    await queryRunner.query(`ALTER TABLE "company_guards" DROP CONSTRAINT "FK_company_guard_company"`);
    await queryRunner.query(`DROP TABLE "company_guards"`);
    await queryRunner.query(`DROP TYPE "public"."company_guards_relationshiptype_enum"`);
    await queryRunner.query(`DROP TYPE "public"."company_guards_status_enum"`);
  }
}
