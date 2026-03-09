import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUnifiedWorkforceModel1710000000000 implements MigrationInterface {
  name = 'AddUnifiedWorkforceModel1710000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."jobs_sourcetype_enum" AS ENUM('MARKETPLACE', 'INTERNAL')`);
    await queryRunner.query(`ALTER TABLE "jobs" ADD "sourceType" "public"."jobs_sourcetype_enum" NOT NULL DEFAULT 'MARKETPLACE'`);
    await queryRunner.query(`ALTER TABLE "jobs" ADD "createdAt" TIMESTAMP NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "jobs" ADD "updatedAt" TIMESTAMP NOT NULL DEFAULT now()`);

    await queryRunner.query(`CREATE TYPE "public"."job_slots_status_enum" AS ENUM('OPEN', 'FILLED', 'CANCELLED')`);
    await queryRunner.query(`CREATE TABLE "job_slots" (
      "id" SERIAL NOT NULL,
      "slotNumber" integer NOT NULL,
      "status" "public"."job_slots_status_enum" NOT NULL DEFAULT 'OPEN',
      "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
      "jobId" integer,
      "assignedGuardId" integer,
      CONSTRAINT "PK_job_slots_id" PRIMARY KEY ("id")
    )`);

    await queryRunner.query(`ALTER TABLE "job_slots" ADD CONSTRAINT "FK_job_slots_job" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "job_slots" ADD CONSTRAINT "FK_job_slots_guard" FOREIGN KEY ("assignedGuardId") REFERENCES "guard_profiles"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);

    await queryRunner.query(`ALTER TABLE "assignments" ADD COLUMN "jobSlotId" integer`);
    await queryRunner.query(`ALTER TABLE "assignments" ADD COLUMN "createdAt" TIMESTAMP NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "assignments" ADD COLUMN "updatedAt" TIMESTAMP NOT NULL DEFAULT now()`);
    await queryRunner.query(`CREATE TYPE "public"."assignments_assignmentsource_enum" AS ENUM('MARKETPLACE', 'INTERNAL')`);
    await queryRunner.query(`ALTER TABLE "assignments" ADD COLUMN "assignmentSource" "public"."assignments_assignmentsource_enum"`);
    await queryRunner.query(`ALTER TABLE "assignments" ADD CONSTRAINT "UQ_assignments_jobSlotId" UNIQUE ("jobSlotId")`);
    await queryRunner.query(`ALTER TABLE "assignments" ADD CONSTRAINT "FK_assignments_jobslot" FOREIGN KEY ("jobSlotId") REFERENCES "job_slots"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assignments" DROP CONSTRAINT "FK_assignments_jobslot"`);
    await queryRunner.query(`ALTER TABLE "assignments" DROP CONSTRAINT "UQ_assignments_jobSlotId"`);
    await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN "assignmentSource"`);
    await queryRunner.query(`DROP TYPE "public"."assignments_assignmentsource_enum"`);
    await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN "updatedAt"`);
    await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN "createdAt"`);
    await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN "jobSlotId"`);

    await queryRunner.query(`ALTER TABLE "job_slots" DROP CONSTRAINT "FK_job_slots_guard"`);
    await queryRunner.query(`ALTER TABLE "job_slots" DROP CONSTRAINT "FK_job_slots_job"`);
    await queryRunner.query(`DROP TABLE "job_slots"`);
    await queryRunner.query(`DROP TYPE "public"."job_slots_status_enum"`);

    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "updatedAt"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "createdAt"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "sourceType"`);
    await queryRunner.query(`DROP TYPE "public"."jobs_sourcetype_enum"`);
  }
}
