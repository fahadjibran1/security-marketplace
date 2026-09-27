import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWelfareWindowEvidence1720900000005 implements MigrationInterface {
  name = 'AddWelfareWindowEvidence1720900000005';

  /**
   * Runs outside a transaction, which the runner honours per migration even under
   * --transaction each.
   *
   * This migration both adds enum values and creates an index whose predicate uses one of them.
   * PostgreSQL refuses to use an enum value added in the current transaction ("unsafe use of new
   * value of enum type"), and comparing "type"::text instead is not an option either: the enum to
   * text cast is STABLE rather than IMMUTABLE, so PostgreSQL 17 rejects it in an index predicate
   * with 42P17. Committing each statement as it runs is what lets the index see the new label, and
   * keeps the whole change in one migration.
   *
   * Safe without a transaction because every statement is additive and guarded by IF NOT EXISTS: a
   * failure part-way leaves the migration unrecorded, and re-running simply re-executes the
   * statements and converges. Nothing here reads or rewrites an existing row.
   */
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Per-window Welfare Check evidence, the Missing Book Off alert, and the Log Book interval
    // setting. Every statement is additive and nullable; no existing row is read or rewritten.
    //
    // Historical rows stay valid and keep their meaning:
    //   safety_alerts.type = 'welfare'            remains a valid Site Request (displayed as such later)
    //   safety_alerts missed_checkcall + NULL idx  remain old rolling/summary alerts, never re-read as evidence
    //   daily_logs 'observation' / 'check_call' / 'welfare_check' keep their current meaning

    // ── Per-window Welfare evidence ────────────────────────────────────────────────────────────
    // NULL for the shift-level summary alert and for every legacy rolling alert; NOT NULL only on a
    // row that is evidence for exactly one window of one shift.
    await queryRunner.query(`
      ALTER TABLE "safety_alerts"
        ADD COLUMN IF NOT EXISTS "welfareWindowIndex" integer NULL
    `);

    // The concurrency guard for the sweep: one durable miss per (shift, window), enforced by the
    // database rather than by read-then-write. Partial, so it never constrains summary or legacy rows.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_safety_alerts_shift_welfare_window"
        ON "safety_alerts" ("shiftId", "welfareWindowIndex")
        WHERE "welfareWindowIndex" IS NOT NULL
    `);

    // ── New alert types ────────────────────────────────────────────────────────────────────────
    // 'welfare' is deliberately left alone: historical Site Requests keep that type and stay valid.
    await queryRunner.query(`
      ALTER TYPE "public"."safety_alerts_type_enum" ADD VALUE IF NOT EXISTS 'missing_book_off'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."safety_alerts_type_enum" ADD VALUE IF NOT EXISTS 'site_request'
    `);

    // One Missing Book Off alert per shift. The predicate can reference the label because the
    // ALTER TYPE above has already committed — see the transaction note on this class.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_safety_alerts_shift_missing_book_off"
        ON "safety_alerts" ("shiftId")
        WHERE "type" = 'missing_book_off'
    `);

    // ── Log Book interval, configuration only ──────────────────────────────────────────────────
    // Nullable with no default, deliberately: NULL means "as required", so no existing site acquires
    // a periodic written-log obligation it never agreed to. 60 = hourly, 120 = every two hours.
    await queryRunner.query(`
      ALTER TABLE "sites"
        ADD COLUMN IF NOT EXISTS "logBookIntervalMinutes" integer NULL
    `);

    // ── Log Book entry type ────────────────────────────────────────────────────────────────────
    // Nothing writes it yet; W5 gives the Guard app the button. 'observation', 'check_call' and
    // 'welfare_check' keep their existing meaning.
    await queryRunner.query(`
      ALTER TYPE "public"."daily_logs_logtype_enum" ADD VALUE IF NOT EXISTS 'log_book'
    `);

    // ── Read paths the sweep and the future Operations Log depend on ───────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_attendance_events_shift_occurred"
        ON "attendance_events" ("shiftId", "occurredAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_daily_logs_shift_created"
        ON "daily_logs" ("shiftId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_daily_logs_company_type_created"
        ON "daily_logs" ("companyId", "logType", "createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_daily_logs_company_type_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_daily_logs_shift_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_attendance_events_shift_occurred"`);
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN IF EXISTS "logBookIntervalMinutes"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_safety_alerts_shift_missing_book_off"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_safety_alerts_shift_welfare_window"`);
    await queryRunner.query(`ALTER TABLE "safety_alerts" DROP COLUMN IF EXISTS "welfareWindowIndex"`);
    // Enum labels are left in place: PostgreSQL cannot drop an enum value, and both types are shared
    // with existing rows. This matches how migration 58 leaves company_guards_relationshiptype_enum.
  }
}
