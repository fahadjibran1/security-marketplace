/**
 * Migration 66 (AddGuardNotificationDispatches1720900000012) certification, on a disposable database built from the
 * repository's own migrations.
 *
 *   M66-01  a database at 65 migrates to 66 and 66 is the last migration
 *   M66-02  the schema it adds: one table, columns, defaults, constraints, indexes, foreign keys; four notification
 *           labels appended (existing labels and their order unchanged; no other enum changes)
 *   M66-03  every existing row of every table is byte-identical; nothing is backfilled
 *   M66-04  a second run applies nothing; re-running up() directly changes nothing (every statement is guarded)
 *   M66-05  the database refuses a second dispatch for one (user, event), unknown types/statuses/receipts; deleting a
 *           shift, notification or amendment clears the reference (never blocks); deleting a user drops its dispatches
 *   M66-06  down() refuses while any dispatch exists and changes nothing
 *   M66-07  down() with no dispatches removes exactly the table (labels stay; PostgreSQL cannot drop them); re-applying
 *           restores the identical schema
 *   M66-08  rollback compatibility: the previous release's pre-deploy migration run (through 65) is a no-op on a 66
 *           database, its writes still succeed, and it can read a notice written with a new label
 *   M66-09  no semantic entity-to-migration drift at 66, and none of the new objects drift at all
 *
 * Needs M66_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.M66_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M66_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('M66 database must be local');

const MIGRATION_65 = 'AddWelfarePushReminders1720900000011';
const MIGRATION_66 = 'AddGuardNotificationDispatches1720900000012';
const NEW_TABLES = ['guard_notification_dispatches'];
const NEW_LABELS = ['shift_offered', 'shift_offer_withdrawn', 'shift_reacceptance_required', 'shift_replaced'];

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
  const through65 = allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000011).map((f) => path.join(migrationsDir, f));
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: false,
    // Migration 67 (manual attendance) follows 66; this certification stays about 66 alone.
    migrations: allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000012).map((f) => path.join(migrationsDir, f)), migrationsTableName: 'typeorm_migrations', logging: false,
  });
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const scalar = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0];
  const migrationCount = async () => Number(await scalar('SELECT count(*)::int FROM typeorm_migrations'));

  const schema = async () => ({
    tables: (await q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r: any) => r.tablename),
    columns: await q(`SELECT table_name, column_name, data_type, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('guard_notification_dispatches', 'notifications')
       ORDER BY table_name, column_name`),
    constraints: await q(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid::regclass::text IN ('guard_notification_dispatches', 'notifications', 'users', 'shifts', 'companies', 'guard_profiles', 'shift_amendments', 'push_devices')
       ORDER BY 1, 2`),
    indexes: await q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
       AND tablename IN ('guard_notification_dispatches', 'notifications', 'users', 'shifts', 'push_devices') ORDER BY 1, 2`),
  });
  const enums = async () =>
    q(`SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid ORDER BY 1, e.enumsortorder`);
  const labels = async () =>
    (await q(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'notifications_type_enum'
       ORDER BY e.enumsortorder`)).map((r: { enumlabel: string }) => r.enumlabel);
  const hashAll = async (run: (sql: string) => Promise<any[]>) => {
    const tables = (await run(`SELECT tablename t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.t as string)
      .filter((t) => !NEW_TABLES.includes(t) && t !== 'typeorm_migrations');
    const out: Record<string, string[]> = {};
    for (const t of tables) out[t] = (await run(`SELECT md5(to_jsonb(x)::text) h FROM "${t}" x ORDER BY 1`)).map((r) => r.h);
    return out;
  };

  try {
    // ── to 65, seed production-shaped rows, then 66 ──────────────────────────────────────────────────────
    const at65 = new DataSource({
      type: 'postgres', url, entities: [], synchronize: false, migrations: through65, migrationsTableName: 'typeorm_migrations', logging: false,
    });
    await at65.initialize();
    await at65.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const applied65 = await at65.runMigrations({ transaction: 'each' });
    assert.equal(applied65[applied65.length - 1].name, MIGRATION_65);
    const [owner] = await at65.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m66.owner@example.invalid','x','company_admin','active') RETURNING id`);
    const [company] = await at65.query(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,'M66 Ltd','66666666','1 Way','o@example.invalid') RETURNING id`, [owner.id]);
    const [site] = await at65.query(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'M66 Site','2 Way') RETURNING id`, [company.id]);
    const [gu] = await at65.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m66.guard@example.invalid','x','guard','active') RETURNING id`);
    const [guard] = await at65.query(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'M66 Guard','1000000000000066','07000000000') RETURNING id`, [gu.id]);
    const shiftIds: number[] = [];
    for (const [status, hours] of [['offered', 24], ['ready', 48], ['in_progress', -1]] as const) {
      const [s] = await at65.query(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'M66 Site',$3,$4,
          now() + ($5 || ' hours')::interval, now() + ($5 || ' hours')::interval + interval '8 hours') RETURNING id`,
        [company.id, site.id, guard.id, status, String(hours)]);
      shiftIds.push(s.id);
    }
    const [offered, , live] = shiftIds;
    await at65.query(`INSERT INTO notifications ("userId","companyId",type,title,message) VALUES ($1,$2,'shift_amendment_requested','t','m'), ($3,$2,'alert_raised','t','m')`,
      [gu.id, company.id, owner.id]);
    await at65.query(`INSERT INTO push_devices ("userId",token,platform) VALUES ($1,'ExponentPushToken[m66aaaaaaaaaa]','android')`, [gu.id]);
    await at65.query(`INSERT INTO audit_logs ("companyId","userId",action,"entityType","entityId","afterData") VALUES ($1,$2,'shift.updated','shift',$3,'{}')`, [company.id, owner.id, offered]);
    const labelsAt65 = (await at65.query(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'notifications_type_enum' ORDER BY e.enumsortorder`)).map((r: { enumlabel: string }) => r.enumlabel);
    const before = await hashAll((sql) => at65.query(sql));
    for (const t of ['shifts', 'notifications', 'push_devices', 'audit_logs', 'users', 'guard_profiles']) {
      assert.ok(before[t]?.length > 0, `${t} is seeded for the comparison`);
    }
    await at65.destroy();

    await ds.initialize();
    const at65Schema = await schema();
    const at65Enums = await enums();
    const applied = await ds.runMigrations({ transaction: 'each' });

    await test('M66-01-A-65-DATABASE-MIGRATES-TO-66-AND-66-IS-LAST', () => {
      assert.equal(applied.length, 1, 'only 66 is pending on a 65 database');
      assert.equal(applied[0].name, MIGRATION_66);
      assert.equal(allFiles.length, 72);
      assert.equal(allFiles[65], '1720900000012-AddGuardNotificationDispatches.ts');
      assert.equal(allFiles[66], '1720900000013-AddManualAttendance.ts', 'Migration 67 follows 66 and is certified by m67-migration.spec.ts');
      assert.equal(allFiles[67], '1720900000014-AddPatrolManagement.ts', 'Migration 68 follows 67 and is certified by m68-migration.spec.ts');
      assert.equal(allFiles[68], '1720900000015-AddPatrolScheduling.ts', 'Migration 69 follows 68 and is certified by m69-migration.spec.ts');
      assert.equal(allFiles[69], '1720900000016-AddPatrolEvidenceStorage.ts', 'Migration 70 follows 69 and is certified by m70-migration.spec.ts');
      assert.equal(allFiles[70], '1720900000017-AddPatrolSweepReconciliation.ts', 'Migration 71 follows 70 and is certified by m71-migration.spec.ts');
      assert.equal(allFiles[71], '1720900000018-AddPatrolSyncRecoveryGrants.ts', 'Migration 72 follows 71 and is certified by m72-migration.spec.ts');
    });
    const head = await schema();
    const headLabels = await labels();

    await test('M66-02-THE-SCHEMA-IT-ADDS', async () => {
      assert.deepEqual(head.tables.filter((t: string) => !at65Schema.tables.includes(t)), NEW_TABLES, 'exactly one new table');
      const col = (column: string) => head.columns.find((c: any) => c.table_name === 'guard_notification_dispatches' && c.column_name === column);
      assert.equal(col('eventKey')?.character_maximum_length, 160);
      assert.equal(col('eventKey')?.is_nullable, 'NO');
      assert.equal(col('type')?.data_type, 'character varying', 'type is varchar + CHECK, not a PostgreSQL enum');
      assert.equal(col('status')?.column_default, `'pending'::character varying`);
      assert.equal(col('notificationId')?.is_nullable, 'YES');
      assert.equal(col('shiftId')?.is_nullable, 'YES');
      assert.equal(col('shiftStartAt')?.data_type, 'timestamp without time zone', 'shift times are UTC wall time, like shifts');
      assert.equal(col('attempts')?.column_default, '0');
      assert.match(String(col('ticketIds')?.column_default), /'\[\]'::jsonb/);
      const def = (name: string) => head.constraints.find((c: any) => c.conname === name)?.def as string;
      for (const name of ['PK_guard_notification_dispatches', 'CHK_guard_notification_dispatches_type', 'CHK_guard_notification_dispatches_status',
        'CHK_guard_notification_dispatches_receipt', 'FK_guard_notification_dispatches_user', 'FK_guard_notification_dispatches_guard',
        'FK_guard_notification_dispatches_company', 'FK_guard_notification_dispatches_notification', 'FK_guard_notification_dispatches_shift',
        'FK_guard_notification_dispatches_amendment']) assert.ok(def(name), `constraint ${name}`);
      assert.match(def('FK_guard_notification_dispatches_user'), /ON DELETE CASCADE/);
      assert.match(def('FK_guard_notification_dispatches_shift'), /ON DELETE SET NULL/, 'never blocks deleting a shift');
      assert.match(def('FK_guard_notification_dispatches_notification'), /ON DELETE SET NULL/);
      assert.match(def('FK_guard_notification_dispatches_amendment'), /ON DELETE SET NULL/);
      const index = (name: string) => head.indexes.find((i: any) => i.indexname === name)?.indexdef as string;
      assert.match(index('UQ_guard_notification_dispatches_user_event'), /UNIQUE INDEX .*\("userId", "eventKey"\)/);
      assert.ok(index('IDX_guard_notification_dispatches_status'));
      assert.ok(index('IDX_guard_notification_dispatches_shift'));
      const old = (rows: any[]) => rows.filter((r) => !NEW_TABLES.includes(r.tbl ?? r.tablename ?? r.table_name));
      assert.deepEqual(old(head.constraints), old(at65Schema.constraints), 'no existing constraint changes');
      assert.deepEqual(old(head.indexes), old(at65Schema.indexes), 'no existing index changes');
      assert.deepEqual(old(head.columns), old(at65Schema.columns), 'no existing column changes (notifications included)');
      assert.deepEqual(headLabels.slice(0, labelsAt65.length), labelsAt65, 'existing labels keep their order');
      assert.deepEqual(headLabels.slice(labelsAt65.length), NEW_LABELS, 'the four labels are appended');
      const otherEnums = (rows: any[]) => rows.filter((r) => r.typname !== 'notifications_type_enum');
      assert.deepEqual(otherEnums(await enums()), otherEnums(at65Enums), 'no other enum changes');
    });

    await test('M66-03-EXISTING-ROWS-ARE-UNCHANGED', async () => {
      assert.deepEqual(await hashAll((sql) => q(sql)), before, 'every existing row of every table is byte-identical');
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM guard_notification_dispatches`)), 0, 'nothing is backfilled');
    });

    await test('M66-04-SECOND-RUN-AND-REPEATED-UP-ARE-NO-OPS', async () => {
      assert.equal((await ds.runMigrations({ transaction: 'each' })).length, 0);
      const { AddGuardNotificationDispatches1720900000012 } = await import('../src/database/migrations/1720900000012-AddGuardNotificationDispatches');
      const runner = ds.createQueryRunner();
      try {
        await new AddGuardNotificationDispatches1720900000012().up(runner);
      } finally {
        await runner.release();
      }
      assert.deepEqual(await schema(), head);
      assert.deepEqual(await labels(), headLabels);
      assert.equal(await migrationCount(), 66);
    });

    const dispatch = (over: Record<string, string> = {}) => {
      const cols: Record<string, string> = {
        userId: String(gu.id), guardId: String(guard.id), companyId: String(company.id), shiftId: String(live),
        type: `'shift_amendment_requested'`, eventKey: `'shift_amendment_requested:amendment:1'`, ...over,
      };
      return q(`INSERT INTO guard_notification_dispatches (${Object.keys(cols).map((c) => `"${c}"`).join(',')}) VALUES (${Object.values(cols).join(',')}) RETURNING id, status`);
    };

    await test('M66-05-THE-DATABASE-REFUSES-INVALID-ROWS', async () => {
      const [first] = await dispatch();
      assert.equal(first.status, 'pending', 'pending by default');
      await assert.rejects(() => dispatch(), /UQ_guard_notification_dispatches_user_event/, 'a second dispatch for the same event');
      await assert.rejects(() => dispatch({ eventKey: `'k2'`, type: `'shift_amendment_disputed'` }), /CHK_guard_notification_dispatches_type/, 'staff-only types are never Guard pushes');
      await assert.rejects(() => dispatch({ eventKey: `'k3'`, status: `'delivered'` }), /CHK_guard_notification_dispatches_status/, 'never claims delivery');
      await assert.rejects(() => dispatch({ eventKey: `'k4'`, status: `'read'` }), /CHK_guard_notification_dispatches_status/, 'never claims the Guard read it');
      await assert.rejects(() => dispatch({ eventKey: `'k5'`, receiptStatus: `'read'` }), /CHK_guard_notification_dispatches_receipt/);
      // A new label is writable on notifications.
      const [n] = await q(`INSERT INTO notifications ("userId","companyId",type,title,message) VALUES ($1,$2,'shift_offered','t','m') RETURNING id`, [gu.id, company.id]);
      const [d] = await dispatch({ eventKey: `'shift_offered:shift:${offered}:tx:1'`, type: `'shift_offered'`, shiftId: String(offered), notificationId: String(n.id) });
      await q(`DELETE FROM shifts WHERE id = $1`, [offered]);
      assert.equal(await scalar(`SELECT "shiftId" FROM guard_notification_dispatches WHERE id = $1`, [d.id]), null, 'a deleted shift clears the reference');
      await q(`DELETE FROM notifications WHERE id = $1`, [n.id]);
      assert.equal(await scalar(`SELECT "notificationId" FROM guard_notification_dispatches WHERE id = $1`, [d.id]), null);
      const [temp] = await q(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m66.temp@example.invalid','x','guard','active') RETURNING id`);
      const [tg] = await q(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'Temp','1000000000000067','07000000001') RETURNING id`, [temp.id]);
      await dispatch({ userId: String(temp.id), guardId: String(tg.id), eventKey: `'k6'` });
      await q(`DELETE FROM guard_profiles WHERE id = $1`, [tg.id]);
      await q(`DELETE FROM users WHERE id = $1`, [temp.id]);
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM guard_notification_dispatches WHERE "userId" = $1`, [temp.id])), 0, 'dispatches go with their user');
    });

    await test('M66-06-DOWN-REFUSES-WHILE-DISPATCHES-EXIST-AND-CHANGES-NOTHING', async () => {
      const snapshot = await q(`SELECT md5(string_agg(to_jsonb(r)::text, '' ORDER BY id)) h FROM guard_notification_dispatches r`);
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /Refusing to revert AddGuardNotificationDispatches1720900000012: 2 Guard notification dispatch/);
      assert.equal(await migrationCount(), 66);
      assert.deepEqual(await q(`SELECT md5(string_agg(to_jsonb(r)::text, '' ORDER BY id)) h FROM guard_notification_dispatches r`), snapshot);
      await q(`DELETE FROM guard_notification_dispatches`);
      await q(`DELETE FROM notifications WHERE type = 'shift_offered'`);
    });

    await test('M66-07-DOWN-REMOVES-THE-TABLE-AND-REAPPLY-RESTORES-IT', async () => {
      const rowsBefore = await hashAll((sql) => q(sql));
      await ds.undoLastMigration({ transaction: 'each' });
      assert.equal(await migrationCount(), 65);
      assert.deepEqual(await schema(), at65Schema, 'back to the 65 schema');
      assert.deepEqual(await labels(), headLabels, 'labels stay (PostgreSQL cannot drop them; older code never writes them)');
      assert.deepEqual(await hashAll((sql) => q(sql)), rowsBefore, 'existing rows survive the round trip');
      await ds.runMigrations({ transaction: 'each' });
      assert.deepEqual(await schema(), head);
    });

    await test('M66-08-ROLLBACK-COMPATIBLE-WITH-THE-PREVIOUS-RELEASE', async () => {
      const previous = new DataSource({
        type: 'postgres', url, entities: [], synchronize: false, migrations: through65, migrationsTableName: 'typeorm_migrations', logging: false,
      });
      await previous.initialize();
      try {
        assert.equal((await previous.runMigrations({ transaction: 'each' })).length, 0, "the previous release's pre-deploy run is a no-op");
        const [s] = await previous.query(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'M66 Site',$3,'offered',
            now() + interval '72 hours', now() + interval '80 hours') RETURNING id`, [company.id, site.id, guard.id]);
        await previous.query(`INSERT INTO notifications ("userId","companyId",type,title,message) VALUES ($1,$2,'shift_amendment_responded','t','m')`, [gu.id, company.id]);
        // A notice written by the new code with a new label is still listed by the previous release's query shape.
        await q(`INSERT INTO notifications ("userId","companyId",type,title,message) VALUES ($1,$2,'shift_offer_withdrawn','Shift withdrawn','m')`, [gu.id, company.id]);
        const mine = await previous.query(`SELECT id, type, title, status FROM notifications WHERE "userId" = $1 ORDER BY "createdAt" DESC`, [gu.id]);
        assert.ok(mine.some((r: any) => r.type === 'shift_offer_withdrawn'));
        // The previous release deletes and cancels shifts that have dispatches without knowing the table exists.
        await dispatch({ shiftId: String(s.id), eventKey: `'shift_offer_withdrawn:shift:${s.id}'`, type: `'shift_offer_withdrawn'` });
        await previous.query(`UPDATE shifts SET status = 'cancelled' WHERE id = $1`, [s.id]);
        await previous.query(`DELETE FROM shifts WHERE id = $1`, [s.id]);
      } finally {
        await previous.destroy();
      }
    });

    await test('M66-09-NO-SEMANTIC-DRIFT-AND-NO-DRIFT-ON-NEW-OBJECTS', async () => {
      const drift = (await ds.driver.createSchemaBuilder().log()).upQueries.map((x) => x.query);
      const ours = drift.filter((x) => /guard_notification_dispatches|notifications_type_enum/.test(x));
      assert.deepEqual(ours, [], `entity and migration 66 disagree:\n${ours.join('\n')}`);
      // This database stops at 66, so Migration 67's nine added columns are absent by design (m67-migration.spec.ts
      // M67-10 certifies them); they are set aside statement by statement. Nothing else is.
      const m67 = /^ALTER TABLE "(attendance_events" ADD "(source|recordedAt|recordedByUserId|reason|verificationMethod|verificationNote|correctionOfEventId)|company_memberships" ADD "canManageAttendance|timesheets" ADD "verifiedSource)" /;
      // …and Migration 68's eleven patrol tables and companies.patrolsEnabled (m68-migration.spec.ts M68-10 certifies them).
      const m68 = /^CREATE TABLE "patrol_(policies|schedules|checkpoints|routes|route_checkpoints|runs|checkpoint_visits|evidence|exceptions|evidence_holds|storage_usage_daily)" |^ALTER TABLE "companies" ADD "patrolsEnabled" /;
      // …and Migration 69's five alert labels (the enum's re-creation), its safety_alerts and patrol columns and its three
      // indexes, statement by statement (m69-migration.spec.ts M69-09 certifies that its entities and migration agree).
      const m69 = /safety_alerts_type_enum|^ALTER TABLE "safety_alerts" ALTER COLUMN "type" |^ALTER TABLE "safety_alerts" ADD "patrol(ExceptionId|RunId|WindowKey|LateSyncAt|Annotation)" |^ALTER TABLE "patrol_(policies|runs|checkpoint_visits|exceptions)" ADD "(postShiftSyncHours|clockDriftThresholdMinutes|allowUnscheduledPatrols|escalateUnverified|lateStart|provisional|needsReview|syncFlags|clockDriftMs|verificationFinalAt|syncedLate|guardId|windowStart|windowEnd|acknowledgedAt|acknowledgedByUserId|lateEvidenceAt|annotations)" |^CREATE (UNIQUE )?INDEX "(uq_safety_alerts_patrol_exception|IDX_patrol_runs_open|IDX_patrol_exceptions_window_type)" /;
      // …and Migration 70's eleven patrol_evidence columns, its two tables (evidence exports, live storage usage) and their
      // indexes, statement by statement (m70-migration.spec.ts M70-09 certifies that its entities and migration agree).
      const m70 = /^CREATE TABLE "patrol_(evidence_exports|storage_usage)" |^ALTER TABLE "patrol_evidence" ADD "(declaredSizeBytes|detectedMimeType|uploadUrlIssuedAt|completionToken|completionStartedAt|syncFlags|needsReview|purgeAfter|primaryDeletedAt|objectDeletedAt|deletionRequestedByUserId)" |^CREATE (UNIQUE )?INDEX "(IDX_patrol_evidence_(lifecycle|pending_upload|exports_company|exports_open)|UQ_patrol_evidence_exports_storage_key|UQ_patrol_storage_usage_(site|company))" |^ALTER TABLE "patrol_(evidence_exports|storage_usage)" /;
      // …and Migration 71's two tables (sweep watermarks, reconciliation runs), its patrol_exceptions / safety_alerts columns
      // and their indexes, statement by statement (m71-migration.spec.ts M71-09 certifies that its entities and migration agree).
      const m71 = /^CREATE TABLE "patrol_(sweep_watermarks|reconciliation_runs)" |^ALTER TABLE "patrol_exceptions" ADD "reconciliationRunId" |^ALTER TABLE "safety_alerts" ADD "patrolReconciliationRunId" |^CREATE (UNIQUE )?INDEX "(IDX_patrol_exceptions_reconciliation|uq_safety_alerts_patrol_reconciliation|UQ_patrol_reconciliation_runs_running|IDX_patrol_reconciliation_runs_company)" |^ALTER TABLE "patrol_(sweep_watermarks|reconciliation_runs)" /;
      // …and Migration 72's recovery grant table and its indexes (m72-migration.spec.ts M72-09 certifies them).
      const m72 = /^CREATE TABLE "patrol_sync_recovery_grants" |^CREATE INDEX "IDX_patrol_sync_recovery_grants_(active|company)" |^ALTER TABLE "patrol_sync_recovery_grants" /;
      const semantic = drift.filter((x) => !m67.test(x) && !m68.test(x) && !m69.test(x) && !m70.test(x) && !m71.test(x) && !m72.test(x) &&
        /CREATE TABLE|DROP TABLE|CREATE TYPE|DROP TYPE|ALTER TYPE|ALTER TABLE.*ALTER COLUMN|ALTER TABLE.*DROP COLUMN|ALTER TABLE.*ADD "/i.test(x));
      assert.deepEqual(semantic, [], `semantic drift (the release gate would fail):\n${semantic.join('\n')}`);
      console.log(`      (diagnostic-only drift elsewhere, unchanged by 66: ${drift.length} statement(s))`);
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
