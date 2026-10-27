import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 67: Manual attendance management (S4 Part B, owner-approved 27 Oct 2026).
 *
 * Authorised company staff record a Book On / Book Off for a Guard, and correct a recorded time, WITHOUT ever
 * rewriting the original row. Additive only; every existing row keeps its values and nothing is backfilled:
 *
 *   attendance_events    + "source" varchar(20) NOT NULL DEFAULT 'guard_app'   ('guard_app' | 'manual')
 *                        + "recordedAt" timestamp NULL (DEFAULT now() for NEW rows only; existing rows stay NULL,
 *                          read as "recorded when it occurred")
 *                        + "recordedByUserId" integer → users (RESTRICT; accounts are anonymised, never deleted)
 *                        + "reason" text, "verificationMethod" varchar(30), "verificationNote" text
 *                        + "correctionOfEventId" integer: the row this one corrects (append-only chain)
 *                        + UNIQUE (id, shiftId, type) and a composite FK (correctionOfEventId, shiftId, type) →
 *                          (id, shiftId, type): a correction always has the same shift and type as what it corrects
 *                        + one root per (shift, type); each row corrected at most once (partial unique indexes),
 *                          so every chain is linear, of any length, with exactly one effective tip
 *                        + CHECKs: source values, verification methods, manual rows carry recorder / time / reason /
 *                          method, 'other' needs a note, manual rows carry no device evidence, app rows carry no
 *                          manual fields, a correction is manual and never points at itself
 *   effective_attendance_events  view: the rows no correction points at (each chain's tip)
 *   company_memberships  + "canManageAttendance" boolean NOT NULL DEFAULT false (per-person Control Room grant)
 *   timesheets           + "verifiedSource" varchar(20) NOT NULL DEFAULT 'guard_app' (informational)
 *
 * PREFLIGHT: refuses to run while any shift has more than one check-in or more than one check-out (the one-root index
 * could not be built, and the "effective" reading would be ambiguous). The offending shift ids are listed.
 *
 * Runs in the normal transaction: no enum is changed. Every statement is guarded, so a repeated run converges.
 *
 * Backward compatible: code at 27d2500 / 5f4e404 never names the new columns (their defaults keep every existing
 * INSERT valid: an app Book On is 'guard_app' with no manual fields), never writes a second check-in or check-out, and
 * ignores the view. A Render rollback over a migrated database is therefore safe, but the old code would read a
 * corrected chain's raw rows (earliest Book On / latest Book Off) instead of the effective tip.
 */
export class AddManualAttendance1720900000013 implements MigrationInterface {
  name = 'AddManualAttendance1720900000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasCorrectionColumn = await this.hasColumn(queryRunner, 'attendance_events', 'correctionOfEventId');
    // Before the chain exists, every row is a root: more than one per (shift, type) cannot be migrated safely.
    const duplicates = (await queryRunner.query(
      `SELECT "shiftId", "type"::text AS "type", count(*)::int AS "n" FROM "attendance_events"
        ${hasCorrectionColumn ? 'WHERE "correctionOfEventId" IS NULL' : ''}
        GROUP BY "shiftId", "type" HAVING count(*) > 1 ORDER BY "shiftId", "type"`,
    )) as Array<{ shiftId: number; type: string; n: number }>;
    if (duplicates.length) {
      throw new Error(
        `Refusing AddManualAttendance1720900000013: ${duplicates.length} shift attendance record(s) have more than one ` +
          `check-in or check-out: ${duplicates.map((d) => `shift ${d.shiftId} ${d.type} x${d.n}`).join(', ')}. ` +
          'Resolve them (keep the genuine Book On / Book Off, with an audit note) before deploying.',
      );
    }

    const add = async (table: string, column: string, definition: string) => {
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${definition}`);
    };
    await add('attendance_events', 'source', `character varying(20) NOT NULL DEFAULT 'guard_app'`);
    // Added WITHOUT a default first so existing rows stay NULL (a default here would stamp them with the deploy time),
    // then the default applies to new rows only.
    await add('attendance_events', 'recordedAt', 'TIMESTAMP');
    await queryRunner.query(`ALTER TABLE "attendance_events" ALTER COLUMN "recordedAt" SET DEFAULT now()`);
    await add('attendance_events', 'recordedByUserId', 'integer');
    await add('attendance_events', 'reason', 'text');
    await add('attendance_events', 'verificationMethod', 'character varying(30)');
    await add('attendance_events', 'verificationNote', 'text');
    await add('attendance_events', 'correctionOfEventId', 'integer');
    await add('company_memberships', 'canManageAttendance', 'boolean NOT NULL DEFAULT false');
    await add('timesheets', 'verifiedSource', `character varying(20) NOT NULL DEFAULT 'guard_app'`);

    const constraints: Array<[string, string, string]> = [
      ['attendance_events', 'UQ_attendance_events_id_shift_type', 'UNIQUE ("id", "shiftId", "type")'],
      ['attendance_events', 'FK_attendance_events_correction',
        'FOREIGN KEY ("correctionOfEventId", "shiftId", "type") REFERENCES "attendance_events"("id", "shiftId", "type") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['attendance_events', 'FK_attendance_events_recorded_by',
        'FOREIGN KEY ("recordedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['attendance_events', 'CHK_attendance_events_source', `CHECK ("source" IN ('guard_app', 'manual'))`],
      ['attendance_events', 'CHK_attendance_events_verification_method', `CHECK ("verificationMethod" IS NULL OR "verificationMethod" IN (
          'phone_call', 'supervisor_on_site', 'cctv', 'client_confirmation', 'radio', 'other'))`],
      ['attendance_events', 'CHK_attendance_events_manual_fields', `CHECK ("source" <> 'manual' OR (
          "recordedByUserId" IS NOT NULL AND "recordedAt" IS NOT NULL AND "reason" IS NOT NULL AND btrim("reason") <> ''
          AND "verificationMethod" IS NOT NULL))`],
      ['attendance_events', 'CHK_attendance_events_other_note', `CHECK ("verificationMethod" IS DISTINCT FROM 'other'
          OR ("verificationNote" IS NOT NULL AND btrim("verificationNote") <> ''))`],
      ['attendance_events', 'CHK_attendance_events_manual_no_device_evidence', `CHECK ("source" <> 'manual' OR (
          "gpsVerified" = false AND "nfcVerified" = false AND "latitude" IS NULL AND "longitude" IS NULL
          AND "gpsAccuracyMeters" IS NULL AND "distanceFromSiteMeters" IS NULL AND "nfcTag" IS NULL))`],
      ['attendance_events', 'CHK_attendance_events_app_fields', `CHECK ("source" <> 'guard_app' OR (
          "recordedByUserId" IS NULL AND "reason" IS NULL AND "verificationMethod" IS NULL AND "verificationNote" IS NULL))`],
      ['attendance_events', 'CHK_attendance_events_correction', `CHECK ("correctionOfEventId" IS NULL OR (
          "source" = 'manual' AND "correctionOfEventId" <> "id"))`],
      ['timesheets', 'CHK_timesheets_verified_source', `CHECK ("verifiedSource" IN ('guard_app', 'manual', 'corrected'))`],
    ];
    for (const [table, name, definition] of constraints) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
            ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ${definition};
          END IF;
        END $$
      `);
    }

    // One root per (shift, type): a second Book On / Book Off, however it arrives (Guard app, manual, a race between
    // the two), is refused by the database itself.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_attendance_events_one_root"
        ON "attendance_events" ("shiftId", "type") WHERE "correctionOfEventId" IS NULL
    `);
    // Each row corrected at most once: with "correct only the tip" this makes every chain linear.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_attendance_events_one_correction"
        ON "attendance_events" ("correctionOfEventId") WHERE "correctionOfEventId" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE OR REPLACE VIEW "effective_attendance_events" AS
        SELECT e.* FROM "attendance_events" e
         WHERE NOT EXISTS (SELECT 1 FROM "attendance_events" c WHERE c."correctionOfEventId" = e."id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Manual rows and corrections are attendance and payroll evidence; a grant is an access decision. Rolling back
    // would delete them, so it is refused while any exist.
    if (await this.hasColumn(queryRunner, 'attendance_events', 'source')) {
      const [counts] = await queryRunner.query(`
        SELECT (SELECT count(*)::int FROM "attendance_events" WHERE "source" <> 'guard_app') AS "manual",
               (SELECT count(*)::int FROM "attendance_events" WHERE "correctionOfEventId" IS NOT NULL) AS "corrections",
               (SELECT count(*)::int FROM "company_memberships" WHERE "canManageAttendance") AS "grants",
               (SELECT count(*)::int FROM "timesheets" WHERE "verifiedSource" <> 'guard_app') AS "timesheets"`);
      const blocking = Object.entries(counts as Record<string, number>).filter(([, n]) => Number(n) > 0);
      if (blocking.length) {
        throw new Error(
          `Refusing to revert AddManualAttendance1720900000013: ${blocking.map(([k, n]) => `${n} ${k}`).join(', ')} exist. ` +
            'Export them (pg_dump of attendance_events, timesheets, company_memberships and audit_logs) and get explicit approval before removing them.',
        );
      }
    }
    await queryRunner.query(`DROP VIEW IF EXISTS "effective_attendance_events"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_attendance_events_one_correction"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_attendance_events_one_root"`);
    for (const name of [
      'CHK_attendance_events_correction', 'CHK_attendance_events_app_fields', 'CHK_attendance_events_manual_no_device_evidence',
      'CHK_attendance_events_other_note', 'CHK_attendance_events_manual_fields', 'CHK_attendance_events_verification_method',
      'CHK_attendance_events_source', 'FK_attendance_events_recorded_by', 'FK_attendance_events_correction',
      'UQ_attendance_events_id_shift_type',
    ]) {
      await queryRunner.query(`ALTER TABLE "attendance_events" DROP CONSTRAINT IF EXISTS "${name}"`);
    }
    await queryRunner.query(`ALTER TABLE "timesheets" DROP CONSTRAINT IF EXISTS "CHK_timesheets_verified_source"`);
    await queryRunner.query(`ALTER TABLE "timesheets" DROP COLUMN IF EXISTS "verifiedSource"`);
    await queryRunner.query(`ALTER TABLE "company_memberships" DROP COLUMN IF EXISTS "canManageAttendance"`);
    for (const column of ['correctionOfEventId', 'verificationNote', 'verificationMethod', 'reason', 'recordedByUserId', 'recordedAt', 'source']) {
      await queryRunner.query(`ALTER TABLE "attendance_events" DROP COLUMN IF EXISTS "${column}"`);
    }
  }

  private async hasColumn(queryRunner: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows = await queryRunner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    return rows.length > 0;
  }
}
