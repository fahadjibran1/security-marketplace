import { MigrationInterface, QueryRunner } from 'typeorm';

export class PhaseOneRolesAndStatuses1713040000000 implements MigrationInterface {
  name = 'PhaseOneRolesAndStatuses1713040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TYPE "users_role_enum" ADD VALUE IF NOT EXISTS 'company_admin';
        ALTER TYPE "users_role_enum" ADD VALUE IF NOT EXISTS 'company_staff';

        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'users_status_enum') THEN
          CREATE TYPE "users_status_enum" AS ENUM ('pending', 'active', 'inactive', 'suspended');
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'companies_status_enum') THEN
          CREATE TYPE "companies_status_enum" AS ENUM ('onboarding', 'active', 'inactive', 'suspended');
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'guard_profiles_availability_enum') THEN
          CREATE TYPE "guard_profiles_availability_enum" AS ENUM ('available', 'limited', 'unavailable');
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'guard_profiles_approvalstatus_enum') THEN
          CREATE TYPE "guard_profiles_approvalstatus_enum" AS ENUM ('pending', 'approved', 'rejected', 'suspended');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "firstName" character varying;
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastName" character varying;
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" character varying;
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "status" "users_status_enum" NOT NULL DEFAULT 'pending';
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "isEmailVerified" boolean NOT NULL DEFAULT false;
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastLoginAt" timestamp;
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "createdAt" timestamp NOT NULL DEFAULT now();
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "updatedAt" timestamp NOT NULL DEFAULT now();
    `);

    await queryRunner.query(`
      UPDATE "users"
      SET "status" = CASE
        WHEN "role" = 'guard' THEN 'pending'::"users_status_enum"
        ELSE 'active'::"users_status_enum"
      END
      WHERE "status" IS NULL OR "status" = 'pending'::"users_status_enum";
    `);

    await queryRunner.query(`
      ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "status" "companies_status_enum" NOT NULL DEFAULT 'onboarding';
      UPDATE "companies"
      SET "status" = 'active'::"companies_status_enum"
      WHERE "status" IS NULL OR "status" = 'onboarding'::"companies_status_enum";
    `);

    await queryRunner.query(`
      ALTER TABLE "guard_profiles" ADD COLUMN IF NOT EXISTS "availability" "guard_profiles_availability_enum" NOT NULL DEFAULT 'available';
      ALTER TABLE "guard_profiles" ADD COLUMN IF NOT EXISTS "approvalStatus" "guard_profiles_approvalstatus_enum" NOT NULL DEFAULT 'pending';
      ALTER TABLE "guard_profiles" ADD COLUMN IF NOT EXISTS "isApproved" boolean NOT NULL DEFAULT false;
      ALTER TABLE "guard_profiles" ADD COLUMN IF NOT EXISTS "notes" text;
    `);

    await queryRunner.query(`
      UPDATE "guard_profiles"
      SET
        "approvalStatus" = CASE
          WHEN lower("status") = 'approved' THEN 'approved'::"guard_profiles_approvalstatus_enum"
          WHEN lower("status") = 'rejected' THEN 'rejected'::"guard_profiles_approvalstatus_enum"
          WHEN lower("status") = 'suspended' THEN 'suspended'::"guard_profiles_approvalstatus_enum"
          ELSE 'pending'::"guard_profiles_approvalstatus_enum"
        END,
        "isApproved" = CASE
          WHEN lower("status") = 'approved' THEN true
          ELSE false
        END
      WHERE "approvalStatus" IS NULL OR "isApproved" = false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "guard_profiles" DROP COLUMN IF EXISTS "notes";`);
    await queryRunner.query(`ALTER TABLE "guard_profiles" DROP COLUMN IF EXISTS "isApproved";`);
    await queryRunner.query(`ALTER TABLE "guard_profiles" DROP COLUMN IF EXISTS "approvalStatus";`);
    await queryRunner.query(`ALTER TABLE "guard_profiles" DROP COLUMN IF EXISTS "availability";`);
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN IF EXISTS "status";`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "updatedAt";`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "createdAt";`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "lastLoginAt";`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "isEmailVerified";`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "status";`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "phone";`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "lastName";`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "firstName";`);

    await queryRunner.query(`DROP TYPE IF EXISTS "guard_profiles_approvalstatus_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "guard_profiles_availability_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "companies_status_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "users_status_enum";`);
  }
}
