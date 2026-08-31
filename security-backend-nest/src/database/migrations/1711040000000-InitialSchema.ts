import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1711040000000 implements MigrationInterface {
  name = 'InitialSchema1711040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'users_role_enum') THEN
          CREATE TYPE "users_role_enum" AS ENUM ('admin', 'company', 'guard');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'jobs_sourcetype_enum') THEN
          CREATE TYPE "jobs_sourcetype_enum" AS ENUM ('internal', 'marketplace');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_slots_status_enum') THEN
          CREATE TYPE "job_slots_status_enum" AS ENUM ('open', 'filled', 'cancelled');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_matches_sourcetype_enum') THEN
          CREATE TYPE "job_matches_sourcetype_enum" AS ENUM ('INTERNAL_POOL', 'MARKETPLACE_POOL');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_matches_status_enum') THEN
          CREATE TYPE "job_matches_status_enum" AS ENUM ('SUGGESTED', 'INVITED', 'VIEWED', 'DECLINED', 'APPLIED', 'ASSIGNED');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'company_guards_status_enum') THEN
          CREATE TYPE "company_guards_status_enum" AS ENUM ('ACTIVE', 'INACTIVE', 'BLOCKED');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'company_guards_relationshiptype_enum') THEN
          CREATE TYPE "company_guards_relationshiptype_enum" AS ENUM ('EMPLOYEE', 'PREFERRED', 'APPROVED_CONTRACTOR');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_events_type_enum') THEN
          CREATE TYPE "attendance_events_type_enum" AS ENUM ('check-in', 'check-out');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'incidents_severity_enum') THEN
          CREATE TYPE "incidents_severity_enum" AS ENUM ('low', 'medium', 'high', 'critical');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" SERIAL PRIMARY KEY,
        "email" character varying NOT NULL UNIQUE,
        "passwordHash" character varying NOT NULL,
        "role" "users_role_enum" NOT NULL
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "companies" (
        "id" SERIAL PRIMARY KEY,
        "userId" integer NOT NULL UNIQUE,
        "name" character varying NOT NULL,
        "companyNumber" character varying NOT NULL,
        "address" character varying NOT NULL,
        "contactDetails" character varying NOT NULL,
        CONSTRAINT "FK_companies_user" FOREIGN KEY ("userId") REFERENCES "users" ("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "guard_profiles" (
        "id" SERIAL PRIMARY KEY,
        "userId" integer NOT NULL UNIQUE,
        "fullName" character varying NOT NULL,
        "siaLicenseNumber" character varying NOT NULL UNIQUE,
        "phone" character varying NOT NULL,
        "locationSharingEnabled" boolean NOT NULL DEFAULT false,
        "status" character varying NOT NULL DEFAULT 'pending',
        CONSTRAINT "FK_guard_profiles_user" FOREIGN KEY ("userId") REFERENCES "users" ("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "jobs" (
        "id" SERIAL PRIMARY KEY,
        "companyId" integer NOT NULL,
        "title" character varying NOT NULL,
        "description" text,
        "guardsRequired" integer NOT NULL,
        "hourlyRate" numeric(10,2) NOT NULL,
        "status" character varying NOT NULL DEFAULT 'open',
        "sourceType" "jobs_sourcetype_enum" NOT NULL DEFAULT 'internal',
        "startAt" timestamp,
        "endAt" timestamp,
        CONSTRAINT "FK_jobs_company" FOREIGN KEY ("companyId") REFERENCES "companies" ("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "job_applications" (
        "id" SERIAL PRIMARY KEY,
        "jobId" integer NOT NULL,
        "guardId" integer NOT NULL,
        "status" character varying NOT NULL DEFAULT 'submitted',
        "appliedAt" timestamp NOT NULL DEFAULT now(),
        "hiredAt" timestamp,
        CONSTRAINT "FK_job_applications_job" FOREIGN KEY ("jobId") REFERENCES "jobs" ("id"),
        CONSTRAINT "FK_job_applications_guard" FOREIGN KEY ("guardId") REFERENCES "guard_profiles" ("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "assignments" (
        "id" SERIAL PRIMARY KEY,
        "jobId" integer,
        "companyId" integer NOT NULL,
        "guardId" integer NOT NULL,
        "applicationId" integer,
        "status" character varying NOT NULL DEFAULT 'active',
        "hiredAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_assignments_job" FOREIGN KEY ("jobId") REFERENCES "jobs" ("id"),
        CONSTRAINT "FK_assignments_company" FOREIGN KEY ("companyId") REFERENCES "companies" ("id"),
        CONSTRAINT "FK_assignments_guard" FOREIGN KEY ("guardId") REFERENCES "guard_profiles" ("id"),
        CONSTRAINT "FK_assignments_application" FOREIGN KEY ("applicationId") REFERENCES "job_applications" ("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "shifts" (
        "id" SERIAL PRIMARY KEY,
        "assignmentId" integer NOT NULL,
        "companyId" integer NOT NULL,
        "guardId" integer NOT NULL,
        "siteName" character varying NOT NULL,
        "start" timestamp NOT NULL,
        "end" timestamp NOT NULL,
        "status" character varying NOT NULL DEFAULT 'scheduled',
        CONSTRAINT "FK_shifts_assignment" FOREIGN KEY ("assignmentId") REFERENCES "assignments" ("id"),
        CONSTRAINT "FK_shifts_company" FOREIGN KEY ("companyId") REFERENCES "companies" ("id"),
        CONSTRAINT "FK_shifts_guard" FOREIGN KEY ("guardId") REFERENCES "guard_profiles" ("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "timesheets" (
        "id" SERIAL PRIMARY KEY,
        "shiftId" integer NOT NULL,
        "guardId" integer NOT NULL,
        "companyId" integer NOT NULL,
        "hoursWorked" numeric(8,2) NOT NULL DEFAULT 0,
        "approvalStatus" character varying NOT NULL DEFAULT 'pending',
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_timesheets_shift" FOREIGN KEY ("shiftId") REFERENCES "shifts" ("id"),
        CONSTRAINT "FK_timesheets_guard" FOREIGN KEY ("guardId") REFERENCES "guard_profiles" ("id"),
        CONSTRAINT "FK_timesheets_company" FOREIGN KEY ("companyId") REFERENCES "companies" ("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "job_slots" (
        "id" SERIAL PRIMARY KEY,
        "jobId" integer NOT NULL,
        "slotNumber" integer NOT NULL,
        "status" "job_slots_status_enum" NOT NULL DEFAULT 'open',
        "assignedGuardId" integer,
        "assignmentId" integer UNIQUE,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_job_slots_job" FOREIGN KEY ("jobId") REFERENCES "jobs" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_job_slots_guard" FOREIGN KEY ("assignedGuardId") REFERENCES "guard_profiles" ("id"),
        CONSTRAINT "FK_job_slots_assignment" FOREIGN KEY ("assignmentId") REFERENCES "assignments" ("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "job_matches" (
        "id" SERIAL PRIMARY KEY,
        "jobSlotId" integer NOT NULL,
        "guardId" integer NOT NULL,
        "matchScore" numeric(5,2) NOT NULL,
        "matchReason" text NOT NULL,
        "sourceType" "job_matches_sourcetype_enum" NOT NULL,
        "status" "job_matches_status_enum" NOT NULL DEFAULT 'SUGGESTED',
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_job_matches_slot_guard" UNIQUE ("jobSlotId", "guardId"),
        CONSTRAINT "FK_job_matches_slot" FOREIGN KEY ("jobSlotId") REFERENCES "job_slots" ("id"),
        CONSTRAINT "FK_job_matches_guard" FOREIGN KEY ("guardId") REFERENCES "guard_profiles" ("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "company_guards" (
        "id" SERIAL PRIMARY KEY,
        "companyId" integer NOT NULL,
        "guardId" integer NOT NULL,
        "status" "company_guards_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "relationshipType" "company_guards_relationshiptype_enum" NOT NULL DEFAULT 'APPROVED_CONTRACTOR',
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_company_guards_company_guard" UNIQUE ("companyId", "guardId"),
        CONSTRAINT "FK_company_guards_company" FOREIGN KEY ("companyId") REFERENCES "companies" ("id"),
        CONSTRAINT "FK_company_guards_guard" FOREIGN KEY ("guardId") REFERENCES "guard_profiles" ("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "attendance_events" (
        "id" SERIAL PRIMARY KEY,
        "shiftId" integer NOT NULL,
        "guardId" integer NOT NULL,
        "type" "attendance_events_type_enum" NOT NULL,
        "nfcTag" character varying,
        "notes" text,
        "occurredAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_attendance_shift" FOREIGN KEY ("shiftId") REFERENCES "shifts" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_attendance_guard" FOREIGN KEY ("guardId") REFERENCES "guard_profiles" ("id") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "incidents" (
        "id" SERIAL PRIMARY KEY,
        "companyId" integer NOT NULL,
        "guardId" integer NOT NULL,
        "shiftId" integer,
        "title" character varying NOT NULL,
        "notes" text NOT NULL,
        "severity" "incidents_severity_enum" NOT NULL DEFAULT 'medium',
        "locationText" character varying,
        "status" character varying NOT NULL DEFAULT 'open',
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_incidents_company" FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_incidents_guard" FOREIGN KEY ("guardId") REFERENCES "guard_profiles" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_incidents_shift" FOREIGN KEY ("shiftId") REFERENCES "shifts" ("id") ON DELETE SET NULL
      );
    `);

    await queryRunner.query(`
      ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "sourceType" "jobs_sourcetype_enum" NOT NULL DEFAULT 'internal';
      ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "startAt" timestamp;
      ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "endAt" timestamp;
      ALTER TABLE "attendance_events" ADD COLUMN IF NOT EXISTS "nfcTag" character varying;
      ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "locationText" character varying;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "incidents";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "attendance_events";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "company_guards";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "job_matches";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "job_slots";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "timesheets";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "shifts";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "assignments";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "job_applications";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "jobs";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "guard_profiles";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "companies";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "incidents_severity_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "attendance_events_type_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "company_guards_relationshiptype_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "company_guards_status_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "job_matches_status_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "job_matches_sourcetype_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "job_slots_status_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "jobs_sourcetype_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "users_role_enum";`);
  }
}
