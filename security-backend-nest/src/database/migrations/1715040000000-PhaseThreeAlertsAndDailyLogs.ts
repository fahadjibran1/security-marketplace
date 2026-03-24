import { MigrationInterface, QueryRunner } from 'typeorm';

export class PhaseThreeAlertsAndDailyLogs1715040000000 implements MigrationInterface {
  name = 'PhaseThreeAlertsAndDailyLogs1715040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."safety_alerts_type_enum" AS ENUM(
        'check_call',
        'panic',
        'welfare',
        'late_checkin',
        'missed_checkcall',
        'other'
      );
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."safety_alerts_priority_enum" AS ENUM(
        'low',
        'medium',
        'high',
        'critical'
      );
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."safety_alerts_status_enum" AS ENUM(
        'open',
        'acknowledged',
        'closed'
      );
    `);
    await queryRunner.query(`
      CREATE TABLE "safety_alerts" (
        "id" SERIAL NOT NULL,
        "type" "public"."safety_alerts_type_enum" NOT NULL DEFAULT 'other',
        "priority" "public"."safety_alerts_priority_enum" NOT NULL DEFAULT 'medium',
        "message" text NOT NULL,
        "status" "public"."safety_alerts_status_enum" NOT NULL DEFAULT 'open',
        "acknowledgedAt" TIMESTAMP,
        "acknowledgedByUserId" integer,
        "closedAt" TIMESTAMP,
        "closedByUserId" integer,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "companyId" integer,
        "guardId" integer,
        "shiftId" integer,
        CONSTRAINT "PK_safety_alerts_id" PRIMARY KEY ("id")
      );
    `);
    await queryRunner.query(`
      ALTER TABLE "safety_alerts"
      ADD CONSTRAINT "FK_safety_alerts_company" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    `);
    await queryRunner.query(`
      ALTER TABLE "safety_alerts"
      ADD CONSTRAINT "FK_safety_alerts_guard" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    `);
    await queryRunner.query(`
      ALTER TABLE "safety_alerts"
      ADD CONSTRAINT "FK_safety_alerts_shift" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    `);

    await queryRunner.query(`
      CREATE TYPE "public"."daily_logs_logtype_enum" AS ENUM(
        'patrol',
        'observation',
        'visitor',
        'delivery',
        'maintenance',
        'other'
      );
    `);
    await queryRunner.query(`
      CREATE TABLE "daily_logs" (
        "id" SERIAL NOT NULL,
        "message" text NOT NULL,
        "logType" "public"."daily_logs_logtype_enum" NOT NULL DEFAULT 'other',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "companyId" integer,
        "guardId" integer,
        "shiftId" integer,
        CONSTRAINT "PK_daily_logs_id" PRIMARY KEY ("id")
      );
    `);
    await queryRunner.query(`
      ALTER TABLE "daily_logs"
      ADD CONSTRAINT "FK_daily_logs_company" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    `);
    await queryRunner.query(`
      ALTER TABLE "daily_logs"
      ADD CONSTRAINT "FK_daily_logs_guard" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    `);
    await queryRunner.query(`
      ALTER TABLE "daily_logs"
      ADD CONSTRAINT "FK_daily_logs_shift" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "daily_logs" DROP CONSTRAINT "FK_daily_logs_shift";`);
    await queryRunner.query(`ALTER TABLE "daily_logs" DROP CONSTRAINT "FK_daily_logs_guard";`);
    await queryRunner.query(`ALTER TABLE "daily_logs" DROP CONSTRAINT "FK_daily_logs_company";`);
    await queryRunner.query(`DROP TABLE "daily_logs";`);
    await queryRunner.query(`DROP TYPE "public"."daily_logs_logtype_enum";`);

    await queryRunner.query(`ALTER TABLE "safety_alerts" DROP CONSTRAINT "FK_safety_alerts_shift";`);
    await queryRunner.query(`ALTER TABLE "safety_alerts" DROP CONSTRAINT "FK_safety_alerts_guard";`);
    await queryRunner.query(`ALTER TABLE "safety_alerts" DROP CONSTRAINT "FK_safety_alerts_company";`);
    await queryRunner.query(`DROP TABLE "safety_alerts";`);
    await queryRunner.query(`DROP TYPE "public"."safety_alerts_status_enum";`);
    await queryRunner.query(`DROP TYPE "public"."safety_alerts_priority_enum";`);
    await queryRunner.query(`DROP TYPE "public"."safety_alerts_type_enum";`);
  }
}
