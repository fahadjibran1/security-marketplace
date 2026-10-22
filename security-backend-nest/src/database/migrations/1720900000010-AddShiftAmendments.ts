import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 64: Live Shift Amendments (owner-approved 22 Oct 2026).
 *
 * Additive only. Every existing row keeps its values and nothing is backfilled:
 *   shift_amendments           new table: one row per proposed extension of an in-progress shift, never deleted
 *   company_shift_policies     new table: per-company fatigue thresholds + amendmentsEnabled (default false)
 *   shifts                     + "originalEnd" timestamp NULL      (set at the first accepted extension)
 *   company_memberships        + "canAmendShifts" boolean NOT NULL DEFAULT false  (per-person Control Room grant)
 *   notifications_type_enum    + shift_amendment_requested / _responded / _disputed / _expired
 *
 * Runs in the normal transaction. Unlike migrations 59 and 63, no index predicate or default here uses a newly added
 * enum label (the new status column is varchar + CHECK, and the notification labels are only appended), so nothing
 * needs to run outside a transaction. Every statement is guarded, so a repeated run converges.
 *
 * Backward compatible: code at b3c13db ignores the new tables and columns (the new column defaults keep every
 * existing INSERT valid), so a Render rollback over a migrated database is safe.
 */
export class AddShiftAmendments1720900000010 implements MigrationInterface {
  name = 'AddShiftAmendments1720900000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const label of [
      'shift_amendment_requested',
      'shift_amendment_responded',
      'shift_amendment_disputed',
      'shift_amendment_expired',
    ]) {
      await queryRunner.query(`ALTER TYPE "public"."notifications_type_enum" ADD VALUE IF NOT EXISTS '${label}'`);
    }

    await queryRunner.query(`ALTER TABLE "shifts" ADD COLUMN IF NOT EXISTS "originalEnd" TIMESTAMP`);
    await queryRunner.query(
      `ALTER TABLE "company_memberships" ADD COLUMN IF NOT EXISTS "canAmendShifts" boolean NOT NULL DEFAULT false`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "shift_amendments" (
        "id"                           SERIAL NOT NULL,
        "shiftId"                      integer NOT NULL,
        "companyId"                    integer NOT NULL,
        "guardId"                      integer NOT NULL,
        "sequence"                     integer NOT NULL,
        "status"                       character varying(32) NOT NULL,
        "originalEnd"                  TIMESTAMP NOT NULL,
        "previousEnd"                  TIMESTAMP NOT NULL,
        "proposedEnd"                  TIMESTAMP NOT NULL,
        "agreedEnd"                    TIMESTAMP,
        "reason"                       character varying(500) NOT NULL,
        "proposedByUserId"             integer NOT NULL,
        "proposedAt"                   TIMESTAMP NOT NULL,
        "expiresAt"                    TIMESTAMP NOT NULL,
        "fatigueAssessment"            jsonb NOT NULL,
        "approvalRequired"             boolean NOT NULL DEFAULT false,
        "approvedByUserId"             integer,
        "approvedAt"                   TIMESTAMP,
        "approvalStatement"            character varying(500),
        "selfApproved"                 boolean NOT NULL DEFAULT false,
        "responseMethod"               character varying(32),
        "respondedByUserId"            integer,
        "respondedAt"                  TIMESTAMP,
        "responseReason"               character varying(500),
        "verbalContactMethod"          character varying(32),
        "verbalContactAt"              TIMESTAMP,
        "verbalConfirmation"           character varying(500),
        "confirmationEmailStatus"      character varying(32),
        "confirmationEmailAttemptedAt" TIMESTAMP,
        "confirmationEmailAttempts"    integer NOT NULL DEFAULT 0,
        "withdrawnByUserId"            integer,
        "withdrawnAt"                  TIMESTAMP,
        "voidedReason"                 character varying(64),
        "voidedAt"                     TIMESTAMP,
        "expiredAt"                    TIMESTAMP,
        "disputedAt"                   TIMESTAMP,
        "disputeReason"                character varying(500),
        "disputeResolvedByUserId"      integer,
        "disputeResolvedAt"            TIMESTAMP,
        "disputeResolution"            character varying(32),
        "disputeResolutionNote"        character varying(500),
        "timesheetSync"                character varying(32),
        "payrollReviewRequired"        boolean NOT NULL DEFAULT false,
        "billingReviewRequired"        boolean NOT NULL DEFAULT true,
        "complianceReviewRequired"     boolean NOT NULL DEFAULT false,
        "createdAt"                    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"                    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_shift_amendments" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_shift_amendments_status" CHECK ("status" IN (
          'awaiting_approval', 'pending', 'accepted', 'declined', 'withdrawn', 'expired', 'voided',
          'disputed', 'dispute_upheld', 'dispute_corrected')),
        CONSTRAINT "CHK_shift_amendments_extends" CHECK ("proposedEnd" > "previousEnd"),
        CONSTRAINT "CHK_shift_amendments_agreed_terms" CHECK ("agreedEnd" IS NULL OR "agreedEnd" = "proposedEnd"),
        CONSTRAINT "CHK_shift_amendments_response_method" CHECK (
          "responseMethod" IS NULL OR "responseMethod" IN ('guard_app', 'staff_recorded_verbal')),
        CONSTRAINT "CHK_shift_amendments_agreed_fields" CHECK (
          "status" NOT IN ('accepted', 'disputed', 'dispute_upheld', 'dispute_corrected')
          OR ("agreedEnd" IS NOT NULL AND "respondedAt" IS NOT NULL AND "responseMethod" IS NOT NULL)),
        CONSTRAINT "CHK_shift_amendments_verbal_fields" CHECK (
          "responseMethod" IS DISTINCT FROM 'staff_recorded_verbal'
          OR ("verbalContactMethod" IS NOT NULL AND "verbalContactAt" IS NOT NULL AND "verbalConfirmation" IS NOT NULL)),
        CONSTRAINT "CHK_shift_amendments_dispute_verbal_only" CHECK (
          "status" NOT IN ('disputed', 'dispute_upheld', 'dispute_corrected') OR "responseMethod" = 'staff_recorded_verbal'),
        CONSTRAINT "CHK_shift_amendments_email_status" CHECK ("confirmationEmailStatus" IS NULL OR "confirmationEmailStatus" IN (
          'provider_accepted', 'captured_outbox', 'not_configured', 'failed', 'no_address'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "company_shift_policies" (
        "id"                       SERIAL NOT NULL,
        "companyId"                integer NOT NULL,
        "amendmentsEnabled"        boolean NOT NULL DEFAULT false,
        "fatigueWarningHours"      numeric(5,2) NOT NULL DEFAULT 12,
        "approvalRequiredHours"    numeric(5,2) NOT NULL DEFAULT 14,
        "hardLimitHours"           numeric(5,2) DEFAULT 16,
        "minRestHours"             numeric(5,2) NOT NULL DEFAULT 11,
        "weeklyReviewHours"        numeric(6,2) NOT NULL DEFAULT 48,
        "lastMinuteWarningMinutes" integer NOT NULL DEFAULT 10,
        "updatedByUserId"          integer,
        "createdAt"                TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"                TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_company_shift_policies" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_company_shift_policies_positive" CHECK (
          "fatigueWarningHours" > 0 AND "approvalRequiredHours" > 0 AND "minRestHours" >= 0
          AND "weeklyReviewHours" > 0 AND "lastMinuteWarningMinutes" >= 0),
        CONSTRAINT "CHK_company_shift_policies_order" CHECK (
          "fatigueWarningHours" <= "approvalRequiredHours"
          AND ("hardLimitHours" IS NULL OR "hardLimitHours" >= "approvalRequiredHours"))
      )
    `);

    const foreignKeys: Array<[string, string, string, string, string]> = [
      ['FK_shift_amendments_shift', 'shift_amendments', 'shiftId', 'shifts', 'RESTRICT'],
      ['FK_shift_amendments_company', 'shift_amendments', 'companyId', 'companies', 'RESTRICT'],
      ['FK_shift_amendments_guard', 'shift_amendments', 'guardId', 'guard_profiles', 'RESTRICT'],
      ['FK_company_shift_policies_company', 'company_shift_policies', 'companyId', 'companies', 'CASCADE'],
    ];
    for (const [name, table, column, target, onDelete] of foreignKeys) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
            ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}")
              REFERENCES "${target}"("id") ON DELETE ${onDelete} ON UPDATE NO ACTION;
          END IF;
        END $$
      `);
    }

    // One open proposal per shift: a second simultaneous proposal is refused by the database itself.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_shift_amendments_one_open"
        ON "shift_amendments" ("shiftId") WHERE "status" IN ('awaiting_approval', 'pending')
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_shift_amendments_shift_sequence" ON "shift_amendments" ("shiftId", "sequence")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_shift_amendments_company_status" ON "shift_amendments" ("companyId", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_shift_amendments_guard_status" ON "shift_amendments" ("guardId", "status")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_company_shift_policies_company" ON "company_shift_policies" ("companyId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Amendment rows are operational and payroll evidence (extended schedules, agreements, disputes). Rolling back
    // would delete them and the originalEnd of every extended shift, so it is refused while any exist.
    const [{ n }] = await queryRunner.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'shift_amendments'`,
    );
    if (Number(n) > 0) {
      const [{ rows }] = await queryRunner.query(`SELECT count(*)::int AS rows FROM "shift_amendments"`);
      if (Number(rows) > 0) {
        throw new Error(
          `Refusing to revert AddShiftAmendments1720900000010: ${rows} shift amendment(s) exist. ` +
            'Export them (pg_dump of shift_amendments, shifts and audit_logs) and get explicit approval before removing them.',
        );
      }
    }
    await queryRunner.query(`DROP TABLE IF EXISTS "company_shift_policies"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "shift_amendments"`);
    await queryRunner.query(`ALTER TABLE "company_memberships" DROP COLUMN IF EXISTS "canAmendShifts"`);
    await queryRunner.query(`ALTER TABLE "shifts" DROP COLUMN IF EXISTS "originalEnd"`);
    // The four notification labels stay: PostgreSQL cannot drop an enum value, the type is shared with every existing
    // notification, and older code never writes them. This matches migrations 58, 59 and 63.
  }
}
