import { MigrationInterface, QueryRunner } from 'typeorm';

export class PhaseFiveGovernanceAndNotifications1717040000000
  implements MigrationInterface
{
  name = 'PhaseFiveGovernanceAndNotifications1717040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attachments_entitytype_enum') THEN
          CREATE TYPE "public"."attachments_entitytype_enum" AS ENUM(
            'incident',
            'alert',
            'daily_log',
            'timesheet',
            'shift'
          );
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "attachments" (
        "id" SERIAL NOT NULL,
        "entityType" "public"."attachments_entitytype_enum" NOT NULL,
        "entityId" integer NOT NULL,
        "fileName" character varying NOT NULL,
        "fileUrl" character varying NOT NULL,
        "mimeType" character varying NOT NULL,
        "sizeBytes" integer NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "companyId" integer,
        "uploadedById" integer,
        CONSTRAINT "PK_attachments_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notifications_type_enum') THEN
          CREATE TYPE "public"."notifications_type_enum" AS ENUM(
            'job_assigned',
            'shift_reminder',
            'check_call_missed',
            'incident_reported',
            'timesheet_submitted',
            'timesheet_approved',
            'timesheet_rejected',
            'alert_raised'
          );
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notifications_status_enum') THEN
          CREATE TYPE "public"."notifications_status_enum" AS ENUM('unread', 'read');
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notifications" (
        "id" SERIAL NOT NULL,
        "type" "public"."notifications_type_enum" NOT NULL,
        "title" character varying NOT NULL,
        "message" text NOT NULL,
        "status" "public"."notifications_status_enum" NOT NULL DEFAULT 'unread',
        "sentAt" TIMESTAMP,
        "readAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "userId" integer NOT NULL,
        "companyId" integer,
        CONSTRAINT "PK_notifications_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_logs" (
        "id" SERIAL NOT NULL,
        "action" character varying NOT NULL,
        "entityType" character varying NOT NULL,
        "entityId" integer,
        "beforeData" json,
        "afterData" json,
        "ipAddress" character varying,
        "userAgent" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "companyId" integer,
        "userId" integer,
        CONSTRAINT "PK_audit_logs_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'FK_attachments_company'
        ) THEN
          ALTER TABLE "attachments"
            ADD CONSTRAINT "FK_attachments_company"
            FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL;
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'FK_attachments_uploaded_by'
        ) THEN
          ALTER TABLE "attachments"
            ADD CONSTRAINT "FK_attachments_uploaded_by"
            FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL;
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'FK_notifications_user'
        ) THEN
          ALTER TABLE "notifications"
            ADD CONSTRAINT "FK_notifications_user"
            FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'FK_notifications_company'
        ) THEN
          ALTER TABLE "notifications"
            ADD CONSTRAINT "FK_notifications_company"
            FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL;
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'FK_audit_logs_company'
        ) THEN
          ALTER TABLE "audit_logs"
            ADD CONSTRAINT "FK_audit_logs_company"
            FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL;
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'FK_audit_logs_user'
        ) THEN
          ALTER TABLE "audit_logs"
            ADD CONSTRAINT "FK_audit_logs_user"
            FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL;
        END IF;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "FK_audit_logs_user";`);
    await queryRunner.query(`ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "FK_audit_logs_company";`);
    await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "FK_notifications_company";`);
    await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "FK_notifications_user";`);
    await queryRunner.query(`ALTER TABLE "attachments" DROP CONSTRAINT IF EXISTS "FK_attachments_uploaded_by";`);
    await queryRunner.query(`ALTER TABLE "attachments" DROP CONSTRAINT IF EXISTS "FK_attachments_company";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notifications";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."notifications_status_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."notifications_type_enum";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "attachments";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."attachments_entitytype_enum";`);
  }
}
