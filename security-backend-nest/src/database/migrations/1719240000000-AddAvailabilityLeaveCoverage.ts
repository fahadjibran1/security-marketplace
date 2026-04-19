import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAvailabilityLeaveCoverage1719240000000 implements MigrationInterface {
  name = 'AddAvailabilityLeaveCoverage1719240000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'guard_availability_overrides_status_enum') THEN
          CREATE TYPE "public"."guard_availability_overrides_status_enum" AS ENUM('available', 'unavailable');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'guard_leave_leavetype_enum') THEN
          CREATE TYPE "public"."guard_leave_leavetype_enum" AS ENUM('annual_leave', 'sick', 'unavailable', 'training', 'suspension', 'other');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'guard_leave_status_enum') THEN
          CREATE TYPE "public"."guard_leave_status_enum" AS ENUM('pending', 'approved', 'rejected');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "guard_availability_rules" (
        "id" SERIAL NOT NULL,
        "companyId" integer,
        "guardId" integer NOT NULL,
        "weekday" integer NOT NULL,
        "startTime" character varying(5) NOT NULL,
        "endTime" character varying(5) NOT NULL,
        "isAvailable" boolean NOT NULL DEFAULT true,
        "effectiveFrom" date,
        "effectiveTo" date,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_guard_availability_rules_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_guard_availability_rules_companyId" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_guard_availability_rules_guardId" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "guard_availability_overrides" (
        "id" SERIAL NOT NULL,
        "guardId" integer NOT NULL,
        "date" date NOT NULL,
        "startTime" character varying(5),
        "endTime" character varying(5),
        "status" "public"."guard_availability_overrides_status_enum" NOT NULL,
        "note" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_guard_availability_overrides_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_guard_availability_overrides_guardId" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "guard_leave" (
        "id" SERIAL NOT NULL,
        "companyId" integer NOT NULL,
        "guardId" integer NOT NULL,
        "leaveType" "public"."guard_leave_leavetype_enum" NOT NULL,
        "startAt" TIMESTAMP NOT NULL,
        "endAt" TIMESTAMP NOT NULL,
        "reason" text,
        "status" "public"."guard_leave_status_enum" NOT NULL DEFAULT 'pending',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_guard_leave_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_guard_leave_companyId" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_guard_leave_guardId" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_guard_availability_rules_guard_weekday" ON "guard_availability_rules" ("guardId", "weekday")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_guard_availability_overrides_guard_date" ON "guard_availability_overrides" ("guardId", "date")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_guard_leave_company_guard_window" ON "guard_leave" ("companyId", "guardId", "startAt", "endAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_guard_leave_company_guard_window"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_guard_availability_overrides_guard_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_guard_availability_rules_guard_weekday"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "guard_leave"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "guard_availability_overrides"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "guard_availability_rules"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."guard_leave_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."guard_leave_leavetype_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."guard_availability_overrides_status_enum"`);
  }
}
