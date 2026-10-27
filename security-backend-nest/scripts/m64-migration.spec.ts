/**
 * Migration 64 (AddShiftAmendments1720900000010) certification, on a disposable database built from the repository's
 * own migrations.
 *
 *   M64-01  a fresh database migrates 0 → 64 and 64 is the last migration
 *   M64-02  the schema it adds: tables, columns, defaults, constraints, indexes, foreign keys, enum labels
 *   M64-03  every existing row of every table (shifts, attendance, timesheets, Welfare logs, alerts, audit …) is byte-identical
 *   M64-04  a second run applies nothing; re-running up() directly changes nothing (every statement is guarded)
 *   M64-05  the database refuses invalid amendments: a second open proposal, a non-extension, different agreed
 *           terms, an incomplete acceptance or verbal record, a dispute of an in-app acceptance, an unknown status
 *   M64-06  down() refuses while any amendment exists and changes nothing
 *   M64-07  down() with no amendments removes exactly what 64 added; re-applying restores the identical schema
 *   M64-08  rollback compatibility: the previous release's pre-deploy migration run (through 63) is a no-op on a 64
 *           database, and the previous release's writes (rows without the new columns) still succeed
 *   M64-09  no semantic entity-to-migration drift at 64, and none of the new objects drift at all
 *
 * Needs M64_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.M64_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M64_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('M64 database must be local');

const MIGRATION_63 = 'AddComplianceLapseAlerts1720900000009';
const MIGRATION_64 = 'AddShiftAmendments1720900000010';
const NEW_TABLES = ['shift_amendments', 'company_shift_policies'];
const NEW_LABELS = ['shift_amendment_requested', 'shift_amendment_responded', 'shift_amendment_disputed', 'shift_amendment_expired'];

let passed = 0;
const failures: string[] = [];
const test = async (id: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failures.push(id);
    console.log(`FAIL  ${id}\n      ${String((error as Error)?.message ?? error).split('\n').join('\n      ')}`);
  }
};

async function main() {
  const path = require('node:path');
  const fs = require('node:fs');
  const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
  const allFiles: string[] = fs.readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).sort();
  const through63 = allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000009).map((f) => path.join(migrationsDir, f));
  // Migration 65 (Welfare push reminders) follows 64; this certification stays about 64 alone.
  const through64 = allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000010).map((f) => path.join(migrationsDir, f));
  // The schema is dropped and built to 63 by `at63` below; this DataSource (all migrations, app entities) then takes
  // the database from 63 to 64. It must not drop the schema itself.
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: false,
    migrations: through64, migrationsTableName: 'typeorm_migrations', logging: false,
  });
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const scalar = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0];
  const migrationCount = async () => Number(await scalar('SELECT count(*)::int FROM typeorm_migrations'));

  /** Everything 64 could touch: columns, constraints, indexes of the affected tables, and the notification labels. */
  const schema = async () => ({
    columns: await q(`SELECT table_name, column_name, data_type, is_nullable, column_default, character_maximum_length,
        numeric_precision, numeric_scale FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('shifts', 'company_memberships', 'notifications', 'shift_amendments', 'company_shift_policies')
       ORDER BY table_name, column_name`),
    constraints: await q(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid::regclass::text IN ('shifts', 'company_memberships', 'notifications', 'shift_amendments', 'company_shift_policies')
       ORDER BY 1, 2`),
    indexes: await q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
       AND tablename IN ('shifts', 'company_memberships', 'notifications', 'shift_amendments', 'company_shift_policies') ORDER BY 1, 2`),
  });
  const labels = async () =>
    (await q(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'notifications_type_enum'
       ORDER BY e.enumsortorder`)).map((r: { enumlabel: string }) => r.enumlabel);
  /**
   * Every row of EVERY existing table (shifts, attendance, timesheets, Welfare logs, alerts, audit, notifications …),
   * hashed with the two new columns removed, so the comparison asks exactly "did any existing value change?".
   */
  const NEW_COLUMNS: Record<string, string[]> = { shifts: ['originalEnd'], company_memberships: ['canAmendShifts'] };
  const hashAll = async (run: (sql: string) => Promise<any[]>) => {
    const tables = (await run(`SELECT tablename t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.t as string)
      .filter((t) => !NEW_TABLES.includes(t) && t !== 'typeorm_migrations');
    const out: Record<string, string[]> = {};
    for (const t of tables) {
      const drop = (NEW_COLUMNS[t] ?? []).map((c) => ` - '${c}'`).join('');
      out[t] = (await run(`SELECT md5((to_jsonb(x)${drop})::text) h FROM "${t}" x ORDER BY 1`)).map((r) => r.h);
    }
    return out;
  };
  const dumpExisting = () => hashAll((sql) => q(sql));

  try {
    // ── to 63, seed production-shaped rows, then 64 ──────────────────────────────────────────────────────
    const at63 = new DataSource({
      type: 'postgres', url, entities: [], synchronize: false, migrations: through63, migrationsTableName: 'typeorm_migrations', logging: false,
    });
    await at63.initialize();
    await at63.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const applied63 = await at63.runMigrations({ transaction: 'each' });
    assert.equal(applied63[applied63.length - 1].name, MIGRATION_63);
    const [owner] = await at63.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m64.owner@example.invalid','x','company_admin','active') RETURNING id`);
    const [company] = await at63.query(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,'M64 Ltd','64646464','1 Way','o@example.invalid') RETURNING id`, [owner.id]);
    const [site] = await at63.query(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'M64 Site','2 Way') RETURNING id`, [company.id]);
    const [gu] = await at63.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m64.guard@example.invalid','x','guard','active') RETURNING id`);
    const [guard] = await at63.query(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'M64 Guard','1000000000000064','07000000000') RETURNING id`, [gu.id]);
    await at63.query(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,'owner','active')`, [owner.id, company.id]);
    const shiftIds: number[] = [];
    for (const [status, hours] of [['in_progress', -1], ['completed', -30], ['ready', 24], ['offered', 48]] as const) {
      const [s] = await at63.query(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'M64 Site',$3,$4,
          now() + ($5 || ' hours')::interval, now() + ($5 || ' hours')::interval + interval '8 hours') RETURNING id`,
        [company.id, site.id, guard.id, status, String(hours)]);
      shiftIds.push(s.id);
    }
    await at63.query(`INSERT INTO notifications ("userId","companyId",type,title,message) VALUES ($1,$2,'alert_raised','t','m')`, [owner.id, company.id]);
    // Operational and financial evidence on the worked shifts: Book On / Book Off, a Welfare Check, a missed window, a
    // timesheet with actuals, and an audit entry.
    const [live, done] = shiftIds;
    await at63.query(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt") VALUES ($1,$3,'check-in',now() - interval '1 hour'),
        ($2,$3,'check-in',now() - interval '30 hours'), ($2,$3,'check-out',now() - interval '22 hours')`, [live, done, guard.id]);
    await at63.query(`INSERT INTO daily_logs ("companyId","guardId","shiftId",message,"logType") VALUES ($1,$2,$3,'All quiet','welfare_check')`, [company.id, guard.id, live]);
    await at63.query(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message,"welfareWindowIndex") VALUES ($1,$2,$3,'missed_checkcall','high','closed','missed',0)`,
      [company.id, guard.id, done]);
    await at63.query(`INSERT INTO timesheets ("shiftId","guardId","companyId","approvalStatus","payrollStatus","billingStatus","scheduledStartAt","scheduledEndAt","actualCheckInAt","actualCheckOutAt")
        VALUES ($1,$2,$3,'approved','paid','invoiced',now() - interval '30 hours',now() - interval '22 hours',now() - interval '30 hours',now() - interval '22 hours')`, [done, guard.id, company.id]);
    await at63.query(`INSERT INTO audit_logs ("companyId","userId",action,"entityType","entityId","afterData") VALUES ($1,$2,'shift.updated','shift',$3,'{"end":"x"}')`, [company.id, owner.id, done]);
    // The same reads as dumpExisting(), at 63 (the new columns do not exist yet, so removing them is a no-op).
    const before = await hashAll((sql) => at63.query(sql));
    for (const t of ['shifts', 'attendance_events', 'timesheets', 'daily_logs', 'safety_alerts', 'audit_logs', 'notifications']) {
      assert.ok(before[t]?.length > 0, `${t} is seeded for the comparison`);
    }
    const labelsAt63 = (await at63.query(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'notifications_type_enum' ORDER BY e.enumsortorder`)).map((r: { enumlabel: string }) => r.enumlabel);
    await at63.destroy();

    await ds.initialize();
    const at63Schema = await schema();
    const applied = await ds.runMigrations({ transaction: 'each' });

    await test('M64-01-FRESH-DATABASE-MIGRATES-TO-64-AND-64-IS-LAST', () => {
      assert.equal(applied.length, 1, 'only 64 is pending on a 63 database');
      assert.equal(applied[0].name, MIGRATION_64);
      assert.equal(allFiles.length, 67);
      assert.equal(allFiles[63], '1720900000010-AddShiftAmendments.ts');
      assert.equal(allFiles[64], '1720900000011-AddWelfarePushReminders.ts', 'Migration 65 follows 64 and is certified by m65-migration.spec.ts');
      assert.equal(allFiles[65], '1720900000012-AddGuardNotificationDispatches.ts', 'Migration 66 follows 65 and is certified by m66-migration.spec.ts');
      assert.equal(allFiles[66], '1720900000013-AddManualAttendance.ts', 'Migration 67 follows 66 and is certified by m67-migration.spec.ts');
    });
    const head = await schema();
    const headLabels = await labels();

    await test('M64-02-THE-SCHEMA-IT-ADDS', async () => {
      for (const table of NEW_TABLES) {
        assert.equal(Number(await scalar(`SELECT count(*)::int FROM information_schema.tables WHERE table_name = $1`, [table])), 1, table);
      }
      const col = (table: string, column: string) => head.columns.find((c: any) => c.table_name === table && c.column_name === column);
      assert.equal(col('shifts', 'originalEnd')?.is_nullable, 'YES');
      assert.equal(col('shifts', 'originalEnd')?.data_type, 'timestamp without time zone');
      assert.equal(col('company_memberships', 'canAmendShifts')?.is_nullable, 'NO');
      assert.equal(col('company_memberships', 'canAmendShifts')?.column_default, 'false');
      assert.equal(col('company_shift_policies', 'amendmentsEnabled')?.column_default, 'false', 'amendments are off by default');
      assert.equal(col('shift_amendments', 'status')?.data_type, 'character varying', 'status is varchar + CHECK, not a PostgreSQL enum');
      assert.equal(col('shift_amendments', 'billingReviewRequired')?.column_default, 'true', 'every extension is flagged for billing review');
      const userDefined = head.columns.filter((c: any) => NEW_TABLES.includes(c.table_name) && c.data_type === 'USER-DEFINED');
      assert.deepEqual(userDefined, [], 'no new column is a PostgreSQL enum');
      const names = head.constraints.map((c: any) => c.conname);
      for (const name of [
        'CHK_shift_amendments_status', 'CHK_shift_amendments_extends', 'CHK_shift_amendments_agreed_terms',
        'CHK_shift_amendments_response_method', 'CHK_shift_amendments_agreed_fields', 'CHK_shift_amendments_verbal_fields',
        'CHK_shift_amendments_dispute_verbal_only', 'CHK_shift_amendments_email_status', 'FK_shift_amendments_shift',
        'FK_shift_amendments_company', 'FK_shift_amendments_guard', 'FK_company_shift_policies_company',
        'CHK_company_shift_policies_positive', 'CHK_company_shift_policies_order',
      ]) assert.ok(names.includes(name), `constraint ${name}`);
      const fk = (name: string) => head.constraints.find((c: any) => c.conname === name)?.def as string;
      assert.match(fk('FK_shift_amendments_shift'), /ON DELETE RESTRICT/, 'amendments never cascade away with a shift');
      const openIndex = head.indexes.find((i: any) => i.indexname === 'UQ_shift_amendments_one_open')?.indexdef as string;
      assert.match(openIndex, /UNIQUE INDEX/);
      assert.match(openIndex, /awaiting_approval/);
      assert.ok(head.indexes.some((i: any) => i.indexname === 'UQ_shift_amendments_shift_sequence'));
      assert.ok(head.indexes.some((i: any) => i.indexname === 'UQ_company_shift_policies_company'));
      assert.deepEqual(headLabels.slice(0, labelsAt63.length), labelsAt63, 'existing labels keep their order');
      assert.deepEqual(headLabels.slice(labelsAt63.length), NEW_LABELS, 'the four labels are appended');
    });

    await test('M64-03-EXISTING-ROWS-ARE-UNCHANGED', async () => {
      assert.deepEqual(await dumpExisting(), before, 'every existing row of every table (shifts, attendance, timesheets, Welfare logs, alerts, audit, notifications …) is byte-identical apart from the new columns');
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM shifts WHERE "originalEnd" IS NOT NULL`)), 0, 'nothing is backfilled');
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM company_memberships WHERE "canAmendShifts"`)), 0, 'no one is authorised by default');
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM company_shift_policies`)), 0, 'no company is enabled');
    });

    await test('M64-04-SECOND-RUN-AND-REPEATED-UP-ARE-NO-OPS', async () => {
      assert.equal((await ds.runMigrations({ transaction: 'each' })).length, 0);
      const { AddShiftAmendments1720900000010 } = await import('../src/database/migrations/1720900000010-AddShiftAmendments');
      const runner = ds.createQueryRunner();
      try {
        await new AddShiftAmendments1720900000010().up(runner);
      } finally {
        await runner.release();
      }
      assert.deepEqual(await schema(), head);
      assert.deepEqual(await labels(), headLabels);
      assert.equal(await migrationCount(), 64);
    });

    // A valid base row; each case overrides one rule.
    const insert = (over: Record<string, string> = {}) => {
      const cols: Record<string, string> = {
        shiftId: String(shiftIds[0]), companyId: String(company.id), guardId: String(guard.id), sequence: '1', status: `'pending'`,
        originalEnd: `now()`, previousEnd: `now()`, proposedEnd: `now() + interval '1 hour'`, reason: `'cover'`,
        proposedByUserId: String(owner.id), proposedAt: `now()`, expiresAt: `now()`, fatigueAssessment: `'{}'::jsonb`, ...over,
      };
      return q(`INSERT INTO shift_amendments (${Object.keys(cols).map((c) => `"${c}"`).join(',')}) VALUES (${Object.values(cols).join(',')}) RETURNING id`);
    };
    const rejects = async (over: Record<string, string>, pattern: RegExp, label: string) => {
      await assert.rejects(() => insert(over), pattern, label);
    };

    await test('M64-05-THE-DATABASE-REFUSES-INVALID-AMENDMENTS', async () => {
      const [first] = await insert();
      await rejects({ sequence: '2' }, /UQ_shift_amendments_one_open/, 'a second open proposal on the same shift');
      await rejects({ sequence: '2', status: `'awaiting_approval'` }, /UQ_shift_amendments_one_open/, 'awaiting approval counts as open');
      await q(`UPDATE shift_amendments SET status = 'withdrawn' WHERE id = $1`, [first.id]);
      await rejects({ sequence: '1', status: `'declined'` }, /UQ_shift_amendments_shift_sequence/, 'a duplicate sequence');
      await rejects({ sequence: '2', proposedEnd: `now() - interval '1 minute'` }, /CHK_shift_amendments_extends/, 'not an extension');
      await rejects({ sequence: '2', status: `'accepted'`, agreedEnd: `now() + interval '2 hours'`, respondedAt: 'now()', responseMethod: `'guard_app'` },
        /CHK_shift_amendments_agreed_terms/, 'agreed terms different from the proposal');
      await rejects({ sequence: '2', status: `'accepted'` }, /CHK_shift_amendments_agreed_fields/, 'an acceptance without its terms');
      await rejects({ sequence: '2', status: `'accepted'`, agreedEnd: `now() + interval '1 hour'`, respondedAt: 'now()', responseMethod: `'staff_recorded_verbal'` },
        /CHK_shift_amendments_verbal_fields/, 'a verbal agreement without contact method, time and confirmation');
      await rejects({ sequence: '2', status: `'disputed'`, agreedEnd: `now() + interval '1 hour'`, respondedAt: 'now()', responseMethod: `'guard_app'` },
        /CHK_shift_amendments_dispute_verbal_only/, 'a dispute of an in-app acceptance');
      await rejects({ sequence: '2', status: `'approved'` }, /CHK_shift_amendments_status/, 'an unknown status');
      await rejects({ sequence: '2', responseMethod: `'email'` }, /CHK_shift_amendments_response_method/, 'an unknown response method');
      await rejects({ sequence: '2', confirmationEmailStatus: `'delivered'` }, /CHK_shift_amendments_email_status/, 'claiming delivery');
      await assert.rejects(() => q(`DELETE FROM shifts WHERE id = $1`, [shiftIds[0]]), /FK_shift_amendments_shift/, 'a shift with amendments cannot be deleted');
      await assert.rejects(() => q(`INSERT INTO company_shift_policies ("companyId","fatigueWarningHours","approvalRequiredHours") VALUES ($1, 15, 14)`, [company.id]),
        /CHK_company_shift_policies_order/, 'thresholds out of order');
    });

    await test('M64-06-DOWN-REFUSES-WHILE-AMENDMENTS-EXIST-AND-CHANGES-NOTHING', async () => {
      const snapshot = await q(`SELECT md5(string_agg(to_jsonb(a)::text, '' ORDER BY id)) h FROM shift_amendments a`);
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /Refusing to revert AddShiftAmendments1720900000010: 1 shift amendment/);
      assert.equal(await migrationCount(), 64);
      assert.deepEqual(await schema(), head);
      assert.deepEqual(await q(`SELECT md5(string_agg(to_jsonb(a)::text, '' ORDER BY id)) h FROM shift_amendments a`), snapshot, 'the evidence is untouched');
      await q(`DELETE FROM shift_amendments`);
    });

    await test('M64-07-DOWN-REMOVES-WHAT-64-ADDED-AND-REAPPLY-RESTORES-IT', async () => {
      await ds.undoLastMigration({ transaction: 'each' });
      assert.equal(await migrationCount(), 63);
      assert.deepEqual(await schema(), at63Schema, 'back to the 63 schema');
      assert.deepEqual(await labels(), headLabels, 'enum labels stay (PostgreSQL cannot drop them; older code never writes them)');
      assert.deepEqual(await dumpExisting(), before, 'existing rows survive the round trip');
      await ds.runMigrations({ transaction: 'each' });
      assert.deepEqual(await schema(), head);
    });

    await test('M64-08-ROLLBACK-COMPATIBLE-WITH-THE-PREVIOUS-RELEASE', async () => {
      const previous = new DataSource({
        type: 'postgres', url, entities: [], synchronize: false, migrations: through63, migrationsTableName: 'typeorm_migrations', logging: false,
      });
      await previous.initialize();
      try {
        assert.equal((await previous.runMigrations({ transaction: 'each' })).length, 0, "the previous release's pre-deploy run is a no-op");
        // The previous release's writes name only the columns it knows; the new columns' defaults keep them valid.
        const [s] = await previous.query(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'M64 Site',$3,'offered',
            now() + interval '72 hours', now() + interval '80 hours') RETURNING id, "originalEnd"`, [company.id, site.id, guard.id]);
        assert.equal(s.originalEnd, null);
        const [u] = await previous.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m64.staff@example.invalid','x','company_staff','active') RETURNING id`);
        const [m] = await previous.query(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,'control_room','active') RETURNING "canAmendShifts"`, [u.id, company.id]);
        assert.equal(m.canAmendShifts, false);
        await previous.query(`INSERT INTO notifications ("userId","companyId",type,title,message) VALUES ($1,$2,'compliance_alert','t','m')`, [owner.id, company.id]);
      } finally {
        await previous.destroy();
      }
    });

    await test('M64-09-NO-SEMANTIC-DRIFT-AND-NO-DRIFT-ON-NEW-OBJECTS', async () => {
      const drift = (await ds.driver.createSchemaBuilder().log()).upQueries.map((x) => x.query);
      // Migration 66 appends four notification labels the entity already declares. At 64 the database must hold exactly
      // the entity's labels without those four (certified here directly), so the enum's re-creation drift is set aside.
      const { NotificationType } = await import('../src/notification/entities/notification.entity');
      const M66_LABELS = ['shift_offered', 'shift_offer_withdrawn', 'shift_reacceptance_required', 'shift_replaced'];
      assert.deepEqual([...(await labels())].sort(), Object.values(NotificationType).filter((l) => !M66_LABELS.includes(l)).sort(),
        'at 64 the notification labels are the entity\'s, less the four Migration 66 appends');
      const ours = drift.filter((x) => !/guard_notification_dispatches/.test(x) &&
        /shift_amendments|company_shift_policies|originalEnd|canAmendShifts/.test(x));
      assert.deepEqual(ours, [], `entity and migration 64 disagree:\n${ours.join('\n')}`);
      // This database stops at 64, so Migration 65's two tables and 66's table and labels are absent by design;
      // m65-migration.spec.ts (M65-09) and m66-migration.spec.ts (M66-09) certify that their entities and migrations
      // agree. Migration 67's nine added columns are absent too (m67-migration.spec.ts M67-10 certifies them), matched
      // statement by statement. Nothing else is set aside.
      const after64 = /push_devices|welfare_reminders|guard_notification_dispatches|notifications_type_enum/;
      const m67 = /^ALTER TABLE "(attendance_events" ADD "(source|recordedAt|recordedByUserId|reason|verificationMethod|verificationNote|correctionOfEventId)|company_memberships" ADD "canManageAttendance|timesheets" ADD "verifiedSource)" /;
      const semantic = drift.filter((x) => !after64.test(x) && !m67.test(x) &&
        /CREATE TABLE|DROP TABLE|CREATE TYPE|DROP TYPE|ALTER TYPE|ALTER TABLE.*ALTER COLUMN|ALTER TABLE.*DROP COLUMN|ALTER TABLE.*ADD "/i.test(x));
      assert.deepEqual(semantic, [], `semantic drift (the release gate would fail):\n${semantic.join('\n')}`);
      console.log(`      (diagnostic-only drift elsewhere, unchanged by 64: ${drift.length} statement(s))`);
    });
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
