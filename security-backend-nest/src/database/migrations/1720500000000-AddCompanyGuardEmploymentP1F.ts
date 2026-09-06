import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCompanyGuardEmploymentP1F1720500000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "guard_engagement_type_enum" AS ENUM (
        'EMPLOYEE',
        'SELF_EMPLOYED_CONTRACTOR',
        'AGENCY_WORKER',
        'SUBCONTRACTOR',
        'CASUAL_WORKER',
        'OTHER'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "guard_job_role_enum" AS ENUM (
        'SECURITY_OFFICER',
        'DOOR_SUPERVISOR',
        'CCTV_OPERATOR',
        'SITE_SUPERVISOR',
        'CONTROL_ROOM_OPERATOR',
        'MOBILE_PATROL_OFFICER',
        'OTHER'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "guard_working_arrangement_enum" AS ENUM (
        'FULL_TIME',
        'PART_TIME',
        'ZERO_HOURS',
        'CASUAL',
        'TEMPORARY',
        'FIXED_TERM',
        'OTHER'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "guard_pay_basis_enum" AS ENUM (
        'HOURLY',
        'DAILY',
        'SALARY',
        'OTHER'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "company_guard_employment_records" (
        "id"                   SERIAL PRIMARY KEY,
        "companyGuardId"       integer NOT NULL,
        "engagementType"       "guard_engagement_type_enum" NOT NULL,
        "jobRole"              "guard_job_role_enum" NOT NULL,
        "customRole"           varchar(100) NULL,
        "workingArrangement"   "guard_working_arrangement_enum" NOT NULL,
        "startDate"            date NOT NULL,
        "endDate"              date NULL,
        "payBasis"             "guard_pay_basis_enum" NOT NULL,
        "noticePeriodDays"     integer NULL,
        "internalNoteEnc"      text NULL,
        "createdAt"            timestamp NOT NULL DEFAULT now(),
        "updatedAt"            timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_company_guard_employment_companyGuardId"
          UNIQUE ("companyGuardId"),
        CONSTRAINT "FK_company_guard_employment_companyGuard"
          FOREIGN KEY ("companyGuardId")
          REFERENCES "company_guards" ("id")
          ON DELETE RESTRICT
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "company_guard_employment_records"`);
    await queryRunner.query(`DROP TYPE "guard_pay_basis_enum"`);
    await queryRunner.query(`DROP TYPE "guard_working_arrangement_enum"`);
    await queryRunner.query(`DROP TYPE "guard_job_role_enum"`);
    await queryRunner.query(`DROP TYPE "guard_engagement_type_enum"`);
  }
}
