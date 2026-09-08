import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateClientWeeklyApprovalTables1720800000002 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "client_weekly_approval_status_enum" AS ENUM (
        'pending_approval','client_approved','disputed','resolved','locked'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "client_shift_dispute_status_enum" AS ENUM (
        'open','resolved','withdrawn'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "client_weekly_approval_requests" (
        "id"                   SERIAL PRIMARY KEY,
        "companyId"            INT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
        "clientId"             INT NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "siteId"               INT NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
        "weekCommencing"       DATE NOT NULL,
        "weekEnding"           DATE NOT NULL,
        "status"               "client_weekly_approval_status_enum" NOT NULL DEFAULT 'pending_approval',
        "currentVersion"       INT NOT NULL DEFAULT 1,
        "submittedAt"          TIMESTAMPTZ,
        "submittedByUserId"    INT REFERENCES "users"("id") ON DELETE SET NULL,
        "clientRespondedAt"    TIMESTAMPTZ,
        "clientRespondedBy"    INT REFERENCES "users"("id") ON DELETE SET NULL,
        "totalApprovedHours"   NUMERIC(8,2),
        "companyInternalNote"  TEXT,
        "clientSubmissionNote" TEXT,
        "createdAt"            TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt"            TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_weekly_approval_company_client_site_week"
          UNIQUE("companyId","clientId","siteId","weekCommencing")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_weekly_approval_client_status" ON "client_weekly_approval_requests"("clientId","status")`);
    await queryRunner.query(`CREATE INDEX "IDX_weekly_approval_company_status" ON "client_weekly_approval_requests"("companyId","status")`);

    await queryRunner.query(`
      CREATE TABLE "client_weekly_approval_lines" (
        "id"                          SERIAL PRIMARY KEY,
        "weeklyApprovalRequestId"     INT NOT NULL REFERENCES "client_weekly_approval_requests"("id") ON DELETE CASCADE,
        "timesheetId"                 INT NOT NULL REFERENCES "timesheets"("id"),
        "submissionVersion"           INT NOT NULL DEFAULT 1,
        "superseded"                  BOOLEAN NOT NULL DEFAULT FALSE,
        "approvedHoursAtSubmission"   NUMERIC(8,2) NOT NULL,
        "shiftDate"                   DATE NOT NULL,
        "scheduledStart"              TIMESTAMPTZ,
        "scheduledEnd"                TIMESTAMPTZ,
        "actualCheckIn"               TIMESTAMPTZ,
        "actualCheckOut"              TIMESTAMPTZ,
        "verifiedMinutes"             INT,
        "hasOverride"                 BOOLEAN NOT NULL DEFAULT FALSE,
        "createdAt"                   TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_approval_line_request_timesheet_version"
          UNIQUE("weeklyApprovalRequestId","timesheetId","submissionVersion")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_active_approval_line"
        ON "client_weekly_approval_lines"("timesheetId")
        WHERE "superseded" = FALSE
    `);

    await queryRunner.query(`
      CREATE TABLE "client_shift_disputes" (
        "id"                      SERIAL PRIMARY KEY,
        "weeklyApprovalRequestId" INT NOT NULL REFERENCES "client_weekly_approval_requests"("id"),
        "lineId"                  INT NOT NULL REFERENCES "client_weekly_approval_lines"("id"),
        "timesheetId"             INT NOT NULL REFERENCES "timesheets"("id"),
        "submissionVersion"       INT NOT NULL,
        "disputeReason"           TEXT NOT NULL,
        "disputedByUserId"        INT REFERENCES "users"("id") ON DELETE SET NULL,
        "disputedAt"              TIMESTAMPTZ NOT NULL DEFAULT now(),
        "status"                  "client_shift_dispute_status_enum" NOT NULL DEFAULT 'open',
        "resolutionMessage"       TEXT,
        "resolvedByUserId"        INT REFERENCES "users"("id") ON DELETE SET NULL,
        "resolvedAt"              TIMESTAMPTZ,
        "createdAt"               TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt"               TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_disputes_request_status" ON "client_shift_disputes"("weeklyApprovalRequestId","status")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "client_shift_disputes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "client_weekly_approval_lines"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "client_weekly_approval_requests"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "client_shift_dispute_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "client_weekly_approval_status_enum"`);
  }
}
