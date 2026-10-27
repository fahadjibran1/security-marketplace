/**
 * Migration 65 (AddWelfarePushReminders1720900000011) certification, on a disposable database built from the
 * repository's own migrations.
 *
 *   M65-01  a database at 64 migrates to 65 and 65 is the last migration
 *   M65-02  the schema it adds: two tables, columns, defaults, constraints, indexes, foreign keys (no enum, no new label)
 *   M65-03  every existing row of every table is byte-identical; nothing is backfilled
 *   M65-04  a second run applies nothing; re-running up() directly changes nothing (every statement is guarded)
 *   M65-05  the database refuses a second reminder of one kind for one window, unknown kinds/statuses/receipts/
 *           platforms, a duplicate token, and deleting a shift that has reminders; deleting a user drops its devices
 *   M65-06  down() refuses while any reminder exists and changes nothing
 *   M65-07  down() with no reminders removes exactly what 65 added; re-applying restores the identical schema
 *   M65-08  rollback compatibility: the previous release's pre-deploy migration run (through 64) is a no-op on a 65
 *           database, and the previous release's writes still succeed
 *   M65-09  no semantic entity-to-migration drift at 65, and none of the new objects drift at all
 *
 * Needs M65_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.M65_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M65_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('M65 database must be local');

const MIGRATION_64 = 'AddShiftAmendments1720900000010';
const MIGRATION_65 = 'AddWelfarePushReminders1720900000011';
const NEW_TABLES = ['push_devices', 'welfare_reminders'];

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
  const through64 = allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000010).map((f) => path.join(migrationsDir, f));
  // Migration 66 (Guard shift notifications) follows 65; this certification stays about 65 alone.
  const through65 = allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000011).map((f) => path.join(migrationsDir, f));
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: false,
    migrations: through65, migrationsTableName: 'typeorm_migrations', logging: false,
  });
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const scalar = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0];
  const migrationCount = async () => Number(await scalar('SELECT count(*)::int FROM typeorm_migrations'));

  const schema = async () => ({
    tables: (await q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r: any) => r.tablename),
    columns: await q(`SELECT table_name, column_name, data_type, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('push_devices', 'welfare_reminders')
       ORDER BY table_name, column_name`),
    constraints: await q(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid::regclass::text IN ('push_devices', 'welfare_reminders', 'users', 'shifts', 'companies', 'guard_profiles')
       ORDER BY 1, 2`),
    indexes: await q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
       AND tablename IN ('push_devices', 'welfare_reminders', 'users', 'shifts') ORDER BY 1, 2`),
    enums: await q(`SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid ORDER BY 1, e.enumsortorder`),
  });
  const hashAll = async (run: (sql: string) => Promise<any[]>) => {
    const tables = (await run(`SELECT tablename t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.t as string)
      .filter((t) => !NEW_TABLES.includes(t) && t !== 'typeorm_migrations');
    const out: Record<string, string[]> = {};
    for (const t of tables) out[t] = (await run(`SELECT md5(to_jsonb(x)::text) h FROM "${t}" x ORDER BY 1`)).map((r) => r.h);
    return out;
  };

  try {
    // ── to 64, seed production-shaped rows, then 65 ──────────────────────────────────────────────────────
    const at64 = new DataSource({
      type: 'postgres', url, entities: [], synchronize: false, migrations: through64, migrationsTableName: 'typeorm_migrations', logging: false,
    });
    await at64.initialize();
    await at64.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const applied64 = await at64.runMigrations({ transaction: 'each' });
    assert.equal(applied64[applied64.length - 1].name, MIGRATION_64);
    const [owner] = await at64.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m65.owner@example.invalid','x','company_admin','active') RETURNING id`);
    const [company] = await at64.query(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,'M65 Ltd','65656565','1 Way','o@example.invalid') RETURNING id`, [owner.id]);
    const [site] = await at64.query(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'M65 Site','2 Way') RETURNING id`, [company.id]);
    const [gu] = await at64.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m65.guard@example.invalid','x','guard','active') RETURNING id`);
    const [guard] = await at64.query(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'M65 Guard','1000000000000065','07000000000') RETURNING id`, [gu.id]);
    const shiftIds: number[] = [];
    for (const [status, hours] of [['in_progress', -1], ['completed', -30], ['ready', 24]] as const) {
      const [s] = await at64.query(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'M65 Site',$3,$4,
          now() + ($5 || ' hours')::interval, now() + ($5 || ' hours')::interval + interval '8 hours') RETURNING id`,
        [company.id, site.id, guard.id, status, String(hours)]);
      shiftIds.push(s.id);
    }
    const [live, done] = shiftIds;
    await at64.query(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt") VALUES ($1,$3,'check-in',now() - interval '1 hour'),
        ($2,$3,'check-in',now() - interval '30 hours'), ($2,$3,'check-out',now() - interval '22 hours')`, [live, done, guard.id]);
    await at64.query(`INSERT INTO daily_logs ("companyId","guardId","shiftId",message,"logType") VALUES ($1,$2,$3,'All quiet','welfare_check')`, [company.id, guard.id, live]);
    await at64.query(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message,"welfareWindowIndex") VALUES ($1,$2,$3,'missed_checkcall','high','closed','missed',0)`,
      [company.id, guard.id, done]);
    await at64.query(`INSERT INTO notifications ("userId","companyId",type,title,message) VALUES ($1,$2,'alert_raised','t','m')`, [owner.id, company.id]);
    await at64.query(`INSERT INTO audit_logs ("companyId","userId",action,"entityType","entityId","afterData") VALUES ($1,$2,'daily_log.created','daily_log',1,'{"logType":"welfare_check"}')`, [company.id, owner.id]);
    const before = await hashAll((sql) => at64.query(sql));
    for (const t of ['shifts', 'attendance_events', 'daily_logs', 'safety_alerts', 'audit_logs', 'notifications', 'users']) {
      assert.ok(before[t]?.length > 0, `${t} is seeded for the comparison`);
    }
    await at64.destroy();

    await ds.initialize();
    const at64Schema = await schema();
    const applied = await ds.runMigrations({ transaction: 'each' });

    await test('M65-01-A-64-DATABASE-MIGRATES-TO-65-AND-65-IS-LAST', () => {
      assert.equal(applied.length, 1, 'only 65 is pending on a 64 database');
      assert.equal(applied[0].name, MIGRATION_65);
      assert.equal(allFiles.length, 67);
      assert.equal(allFiles[64], '1720900000011-AddWelfarePushReminders.ts');
      assert.equal(allFiles[65], '1720900000012-AddGuardNotificationDispatches.ts', 'Migration 66 follows 65 and is certified by m66-migration.spec.ts');
      assert.equal(allFiles[66], '1720900000013-AddManualAttendance.ts', 'Migration 67 follows 66 and is certified by m67-migration.spec.ts');
    });
    const head = await schema();

    await test('M65-02-THE-SCHEMA-IT-ADDS', async () => {
      assert.deepEqual(head.tables.filter((t: string) => !at64Schema.tables.includes(t)), NEW_TABLES, 'exactly two new tables');
      const col = (table: string, column: string) => head.columns.find((c: any) => c.table_name === table && c.column_name === column);
      assert.equal(col('push_devices', 'token')?.character_maximum_length, 255);
      assert.equal(col('push_devices', 'revokedAt')?.is_nullable, 'YES');
      assert.equal(col('welfare_reminders', 'windowStart')?.data_type, 'timestamp without time zone', 'window times are UTC wall time, like shifts');
      assert.equal(col('welfare_reminders', 'attempts')?.column_default, '0');
      assert.match(String(col('welfare_reminders', 'ticketIds')?.column_default), /'\[\]'::jsonb/);
      assert.deepEqual(head.columns.filter((c: any) => c.data_type === 'USER-DEFINED'), [], 'no PostgreSQL enum');
      assert.deepEqual(head.enums, at64Schema.enums, 'no enum label is added');
      const def = (name: string) => head.constraints.find((c: any) => c.conname === name)?.def as string;
      for (const name of ['PK_push_devices', 'CHK_push_devices_platform', 'FK_push_devices_user', 'PK_welfare_reminders',
        'CHK_welfare_reminders_kind', 'CHK_welfare_reminders_status', 'CHK_welfare_reminders_receipt',
        'FK_welfare_reminders_shift', 'FK_welfare_reminders_company', 'FK_welfare_reminders_guard']) assert.ok(def(name), `constraint ${name}`);
      assert.match(def('FK_push_devices_user'), /ON DELETE CASCADE/);
      assert.match(def('FK_welfare_reminders_shift'), /ON DELETE RESTRICT/, 'reminders never cascade away with a shift');
      const index = (name: string) => head.indexes.find((i: any) => i.indexname === name)?.indexdef as string;
      assert.match(index('UQ_welfare_reminders_window_kind'), /UNIQUE INDEX .*\("shiftId", "windowIndex", kind\)/);
      assert.match(index('UQ_push_devices_token'), /UNIQUE INDEX .*\(token\)/);
      assert.ok(index('IDX_push_devices_user'));
      assert.ok(index('IDX_welfare_reminders_company_shift'));
      const old = (rows: any[]) => rows.filter((r) => !NEW_TABLES.includes(r.tbl ?? r.tablename));
      assert.deepEqual(old(head.constraints), old(at64Schema.constraints), 'no existing constraint changes');
      assert.deepEqual(old(head.indexes), old(at64Schema.indexes), 'no existing index changes');
    });

    await test('M65-03-EXISTING-ROWS-ARE-UNCHANGED', async () => {
      assert.deepEqual(await hashAll((sql) => q(sql)), before, 'every existing row of every table is byte-identical');
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM push_devices`)), 0, 'nothing is backfilled');
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM welfare_reminders`)), 0);
    });

    await test('M65-04-SECOND-RUN-AND-REPEATED-UP-ARE-NO-OPS', async () => {
      assert.equal((await ds.runMigrations({ transaction: 'each' })).length, 0);
      const { AddWelfarePushReminders1720900000011 } = await import('../src/database/migrations/1720900000011-AddWelfarePushReminders');
      const runner = ds.createQueryRunner();
      try {
        await new AddWelfarePushReminders1720900000011().up(runner);
      } finally {
        await runner.release();
      }
      assert.deepEqual(await schema(), head);
      assert.equal(await migrationCount(), 65);
    });

    const reminder = (over: Record<string, string> = {}) => {
      const cols: Record<string, string> = {
        shiftId: String(live), companyId: String(company.id), guardId: String(guard.id), windowIndex: '0', kind: `'window_open'`,
        windowStart: 'now()', windowEnd: `now() + interval '1 hour'`, status: `'provider_accepted'`, ...over,
      };
      return q(`INSERT INTO welfare_reminders (${Object.keys(cols).map((c) => `"${c}"`).join(',')}) VALUES (${Object.values(cols).join(',')}) RETURNING id`);
    };

    await test('M65-05-THE-DATABASE-REFUSES-INVALID-ROWS', async () => {
      await reminder();
      await assert.rejects(() => reminder(), /UQ_welfare_reminders_window_kind/, 'a second window-open reminder for the same window');
      await reminder({ kind: `'follow_up'` });
      await assert.rejects(() => reminder({ kind: `'follow_up'`, status: `'failed'` }), /UQ_welfare_reminders_window_kind/, 'a second follow-up');
      await assert.rejects(() => reminder({ windowIndex: '1', kind: `'nag'` }), /CHK_welfare_reminders_kind/);
      await assert.rejects(() => reminder({ windowIndex: '1', status: `'delivered'` }), /CHK_welfare_reminders_status/, 'never claims delivery');
      await assert.rejects(() => reminder({ windowIndex: '1', status: `'confirmed_safe'` }), /CHK_welfare_reminders_status/, 'a reminder is never a check');
      await assert.rejects(() => reminder({ windowIndex: '1', receiptStatus: `'read'` }), /CHK_welfare_reminders_receipt/);
      await assert.rejects(() => q(`DELETE FROM shifts WHERE id = $1`, [live]), /FK_welfare_reminders_shift/, 'a shift with reminders cannot be deleted');
      await q(`INSERT INTO push_devices ("userId",token,platform) VALUES ($1,'ExponentPushToken[m65aaaaaaaaaa]','ios')`, [gu.id]);
      await assert.rejects(() => q(`INSERT INTO push_devices ("userId",token,platform) VALUES ($1,'ExponentPushToken[m65aaaaaaaaaa]','android')`, [owner.id]), /UQ_push_devices_token/);
      await assert.rejects(() => q(`INSERT INTO push_devices ("userId",token,platform) VALUES ($1,'ExponentPushToken[m65bbbbbbbbbb]','web')`, [gu.id]), /CHK_push_devices_platform/);
      const [temp] = await q(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m65.temp@example.invalid','x','guard','active') RETURNING id`);
      await q(`INSERT INTO push_devices ("userId",token,platform) VALUES ($1,'ExponentPushToken[m65cccccccccc]','android')`, [temp.id]);
      await q(`DELETE FROM users WHERE id = $1`, [temp.id]);
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM push_devices WHERE "userId" = $1`, [temp.id])), 0, 'devices go with their user');
    });

    await test('M65-06-DOWN-REFUSES-WHILE-REMINDERS-EXIST-AND-CHANGES-NOTHING', async () => {
      const snapshot = await q(`SELECT md5(string_agg(to_jsonb(r)::text, '' ORDER BY id)) h FROM welfare_reminders r`);
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /Refusing to revert AddWelfarePushReminders1720900000011: 2 Welfare reminder/);
      assert.equal(await migrationCount(), 65);
      assert.deepEqual(await q(`SELECT md5(string_agg(to_jsonb(r)::text, '' ORDER BY id)) h FROM welfare_reminders r`), snapshot, 'the evidence is untouched');
      await q(`DELETE FROM welfare_reminders`);
      await q(`DELETE FROM push_devices`);
    });

    await test('M65-07-DOWN-REMOVES-WHAT-65-ADDED-AND-REAPPLY-RESTORES-IT', async () => {
      await ds.undoLastMigration({ transaction: 'each' });
      assert.equal(await migrationCount(), 64);
      assert.deepEqual(await schema(), at64Schema, 'back to the 64 schema');
      assert.deepEqual(await hashAll((sql) => q(sql)), before, 'existing rows survive the round trip');
      await ds.runMigrations({ transaction: 'each' });
      assert.deepEqual(await schema(), head);
    });

    await test('M65-08-ROLLBACK-COMPATIBLE-WITH-THE-PREVIOUS-RELEASE', async () => {
      const previous = new DataSource({
        type: 'postgres', url, entities: [], synchronize: false, migrations: through64, migrationsTableName: 'typeorm_migrations', logging: false,
      });
      await previous.initialize();
      try {
        assert.equal((await previous.runMigrations({ transaction: 'each' })).length, 0, "the previous release's pre-deploy run is a no-op");
        await previous.query(`INSERT INTO daily_logs ("companyId","guardId","shiftId",message,"logType") VALUES ($1,$2,$3,'Still fine','welfare_check')`, [company.id, guard.id, live]);
        await previous.query(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'M65 Site',$3,'offered',
            now() + interval '72 hours', now() + interval '80 hours')`, [company.id, site.id, guard.id]);
        await previous.query(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message) VALUES ($1,$2,$3,'panic','critical','open','help')`,
          [company.id, guard.id, live]);
      } finally {
        await previous.destroy();
      }
    });

    await test('M65-09-NO-SEMANTIC-DRIFT-AND-NO-DRIFT-ON-NEW-OBJECTS', async () => {
      const drift = (await ds.driver.createSchemaBuilder().log()).upQueries.map((x) => x.query);
      const ours = drift.filter((x) => /push_devices|welfare_reminders/.test(x));
      assert.deepEqual(ours, [], `entity and migration 65 disagree:\n${ours.join('\n')}`);
      // This database stops at 65, so Migration 66's table and four notification labels are absent by design;
      // m66-migration.spec.ts (M66-09) certifies that their entities and migration agree. Nothing else is set aside.
      const after65 = /guard_notification_dispatches|notifications_type_enum/;
      // …and Migration 67's nine added columns, statement by statement (m67-migration.spec.ts M67-10 certifies them).
      const m67 = /^ALTER TABLE "(attendance_events" ADD "(source|recordedAt|recordedByUserId|reason|verificationMethod|verificationNote|correctionOfEventId)|company_memberships" ADD "canManageAttendance|timesheets" ADD "verifiedSource)" /;
      const semantic = drift.filter((x) => !after65.test(x) && !m67.test(x) &&
        /CREATE TABLE|DROP TABLE|CREATE TYPE|DROP TYPE|ALTER TYPE|ALTER TABLE.*ALTER COLUMN|ALTER TABLE.*DROP COLUMN|ALTER TABLE.*ADD "/i.test(x));
      assert.deepEqual(semantic, [], `semantic drift (the release gate would fail):\n${semantic.join('\n')}`);
      console.log(`      (diagnostic-only drift elsewhere, unchanged by 65: ${drift.length} statement(s))`);
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
