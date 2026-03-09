import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMatchingEngineV11710000002000 implements MigrationInterface {
  name = 'AddMatchingEngineV11710000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "company_guards" ADD "updatedAt" TIMESTAMP NOT NULL DEFAULT now()`);

    await queryRunner.query(`ALTER TABLE "jobs" ADD "startAt" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "jobs" ADD "endAt" TIMESTAMP`);

    await queryRunner.query(`ALTER TABLE "assignments" DROP CONSTRAINT IF EXISTS "UQ_assignments_jobSlotId"`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_assignments_jobslot_active" ON "assignments" ("jobSlotId") WHERE "status" = 'active'`);

    await queryRunner.query(`CREATE TYPE "public"."job_matches_sourcetype_enum" AS ENUM('INTERNAL_POOL', 'MARKETPLACE_POOL')`);
    await queryRunner.query(`CREATE TYPE "public"."job_matches_status_enum" AS ENUM('SUGGESTED', 'INVITED', 'VIEWED', 'DECLINED', 'APPLIED', 'ASSIGNED')`);
    await queryRunner.query(`CREATE TABLE "job_matches" (
      "id" SERIAL NOT NULL,
      "matchScore" numeric(5,2) NOT NULL,
      "matchReason" text NOT NULL,
      "sourceType" "public"."job_matches_sourcetype_enum" NOT NULL,
      "status" "public"."job_matches_status_enum" NOT NULL DEFAULT 'SUGGESTED',
      "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
      "jobSlotId" integer,
      "guardId" integer,
      CONSTRAINT "UQ_job_matches_slot_guard" UNIQUE ("jobSlotId", "guardId"),
      CONSTRAINT "PK_job_matches_id" PRIMARY KEY ("id")
    )`);

    await queryRunner.query(`ALTER TABLE "job_matches" ADD CONSTRAINT "FK_job_matches_slot" FOREIGN KEY ("jobSlotId") REFERENCES "job_slots"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "job_matches" ADD CONSTRAINT "FK_job_matches_guard" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "job_matches" DROP CONSTRAINT "FK_job_matches_guard"`);
    await queryRunner.query(`ALTER TABLE "job_matches" DROP CONSTRAINT "FK_job_matches_slot"`);
    await queryRunner.query(`DROP TABLE "job_matches"`);
    await queryRunner.query(`DROP TYPE "public"."job_matches_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."job_matches_sourcetype_enum"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_assignments_jobslot_active"`);
    await queryRunner.query(`ALTER TABLE "assignments" ADD CONSTRAINT "UQ_assignments_jobSlotId" UNIQUE ("jobSlotId")`);

    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "endAt"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "startAt"`);

    await queryRunner.query(`ALTER TABLE "company_guards" DROP COLUMN "updatedAt"`);
  }
}
