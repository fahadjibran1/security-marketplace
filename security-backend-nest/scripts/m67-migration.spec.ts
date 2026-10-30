/**
 * Migration 67 (AddManualAttendance1720900000013) certification, on a disposable database built from the repository's
 * own migrations.
 *
 *   M67-01  a database at 66 migrates to 67 and 67 is the last migration
 *   M67-02  the schema it adds: nine columns (defaults, nullability), constraints, two partial unique indexes, the view;
 *           no existing column, constraint or index changes; no enum changes
 *   M67-03  every existing row keeps its values (new columns: guard_app / NULL / false); nothing is backfilled — in
 *           particular recordedAt stays NULL on existing rows (never the deploy time)
 *   M67-04  a second run applies nothing; re-running up() directly changes nothing
 *   M67-05  PREFLIGHT: a database with two check-ins (or two check-outs) on one shift is refused, the shift ids named,
 *           and nothing is changed
 *   M67-06  every CHECK refuses what it should (source, method, manual fields, blank reason, 'other' note, no device
 *           evidence on manual rows, no manual fields on app rows, a correction is manual and never itself, verifiedSource)
 *   M67-07  the correction chain: one root per (shift, type); each row corrected at most once; a correction of another
 *           shift or type is refused (composite FK); a chain of any length has exactly one effective row (the view);
 *           a corrected row cannot be deleted; the original row stays byte-identical
 *   M67-08  down() refuses while manual rows, corrections, grants or non-app timesheet sources exist, and changes nothing
 *   M67-09  down() with none removes exactly what 67 added; re-applying restores the identical schema
 *   M67-10  no semantic entity-to-migration drift at 67, and none of the new objects drift at all
 *   M67-11  rollback compatibility: the previous release's pre-deploy run (through 66) is a no-op on a 67 database and
 *           its writes (Guard-app Book On / Book Off, timesheet, membership) still succeed
 *
 * Needs M67_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.M67_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M67_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('M67 database must be local');

const MIGRATION_66 = 'AddGuardNotificationDispatches1720900000012';
const MIGRATION_67 = 'AddManualAttendance1720900000013';
const NEW_COLUMNS: Record<string, string[]> = {
  attendance_events: ['source', 'recordedAt', 'recordedByUserId', 'reason', 'verificationMethod', 'verificationNote', 'correctionOfEventId'],
  company_memberships: ['canManageAttendance'],
  timesheets: ['verifiedSource'],
};
const TABLES = Object.keys(NEW_COLUMNS);

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
  const through66 = allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000012).map((f) => path.join(migrationsDir, f));
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: false,
    // Migration 68 (patrols) follows 67; this certification stays about 67 alone.
    migrations: allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000013).map((f) => path.join(migrationsDir, f)),
    migrationsTableName: 'typeorm_migrations', logging: false,
  });
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const scalar = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0];
  const migrationCount = async () => Number(await scalar('SELECT count(*)::int FROM typeorm_migrations'));

  const schemaOf = async (run: (sql: string) => Promise<any[]>) => ({
    tables: (await run(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r: any) => r.tablename),
    views: (await run(`SELECT viewname, definition FROM pg_views WHERE schemaname = 'public' ORDER BY 1`)),
    columns: await run(`SELECT table_name, column_name, data_type, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('attendance_events', 'company_memberships', 'timesheets', 'shifts', 'users')
       ORDER BY table_name, column_name`),
    constraints: await run(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid::regclass::text IN ('attendance_events', 'company_memberships', 'timesheets', 'shifts', 'users', 'guard_profiles')
       ORDER BY 1, 2`),
    indexes: await run(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
       AND tablename IN ('attendance_events', 'company_memberships', 'timesheets', 'shifts') ORDER BY 1, 2`),
  });
  const schema = () => schemaOf((sql) => q(sql));
  const enums = async () => q(`SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid ORDER BY 1, e.enumsortorder`);
  /** Every row of every table, with Migration 67's columns removed so the same rows hash the same before and after. */
  const hashAll = async (run: (sql: string) => Promise<any[]>) => {
    const tables = (await run(`SELECT tablename t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.t as string)
      .filter((t) => t !== 'typeorm_migrations');
    const out: Record<string, string[]> = {};
    for (const t of tables) {
      const drop = NEW_COLUMNS[t] ? ` - ARRAY[${NEW_COLUMNS[t].map((c) => `'${c}'`).join(',')}]` : '';
      out[t] = (await run(`SELECT md5((to_jsonb(x)${drop})::text) h FROM "${t}" x ORDER BY 1`)).map((r) => r.h);
    }
    return out;
  };

  try {
    // ── to 66, seed production-shaped rows ──────────────────────────────────────────────────────────────
    const at66 = new DataSource({
      type: 'postgres', url, entities: [], synchronize: false, migrations: through66, migrationsTableName: 'typeorm_migrations', logging: false,
    });
    await at66.initialize();
    await at66.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const applied66 = await at66.runMigrations({ transaction: 'each' });
    assert.equal(applied66[applied66.length - 1].name, MIGRATION_66);
    const [owner] = await at66.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m67.owner@example.invalid','x','company_admin','active') RETURNING id`);
    const [staff] = await at66.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m67.cr@example.invalid','x','company_staff','active') RETURNING id`);
    const [recorder] = await at66.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m67.recorder@example.invalid','x','company_staff','active') RETURNING id`);
    const [company] = await at66.query(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,'M67 Ltd','67676767','1 Way','o@example.invalid') RETURNING id`, [owner.id]);
    await at66.query(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,'control_room','active')`, [staff.id, company.id]);
    const [site] = await at66.query(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'M67 Site','2 Way') RETURNING id`, [company.id]);
    const [gu] = await at66.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m67.guard@example.invalid','x','guard','active') RETURNING id`);
    const [guard] = await at66.query(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'M67 Guard','1000000000000067','07000000067') RETURNING id`, [gu.id]);
    const shift = async (status: string, hours: number) => (await at66.query(
      `INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'M67 Site',$3,$4,
         now() + ($5 || ' hours')::interval, now() + ($5 || ' hours')::interval + interval '8 hours') RETURNING id`,
      [company.id, site.id, guard.id, status, String(hours)]))[0].id as number;
    const done = await shift('completed', -30);
    const live = await shift('in_progress', -2);
    const spare = await shift('ready', 30);
    const spare2 = await shift('ready', 60);
    const ev = (s: number, type: string, at: string) =>
      at66.query(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","gpsVerified",latitude,longitude) VALUES ($1,$2,$3,${at},true,51.5,-0.1) RETURNING id`, [s, guard.id, type]);
    await ev(done, 'check-in', `now() - interval '30 hours'`);
    await ev(done, 'check-out', `now() - interval '22 hours'`);
    await ev(live, 'check-in', `now() - interval '2 hours'`);
    await at66.query(`INSERT INTO timesheets ("shiftId","guardId","companyId","hoursWorked","approvalStatus","actualCheckInAt","actualCheckOutAt","verifiedMinutes")
       VALUES ($1,$2,$3,8,'submitted',now() - interval '30 hours',now() - interval '22 hours',480)`, [done, guard.id, company.id]);

    // ── M67-05 first: the preflight on duplicates ──────────────────────────────────────────────────────
    const [dupIn] = await ev(spare, 'check-in', `now() - interval '1 hour'`);
    const [dupIn2] = await ev(spare, 'check-in', `now() - interval '50 minutes'`);
    const [dupOut] = await ev(done, 'check-out', `now() - interval '21 hours'`);
    const beforeRefusal = await hashAll((sql) => at66.query(sql));
    const schemaBeforeRefusal = await schemaOf((sql) => at66.query(sql));
    await at66.destroy();

    await ds.initialize();
    await test('M67-05-PREFLIGHT-REFUSES-DUPLICATE-CHECK-INS-OR-CHECK-OUTS-AND-CHANGES-NOTHING', async () => {
      await assert.rejects(() => ds.runMigrations({ transaction: 'each' }), (error: Error) => {
        assert.match(error.message, /Refusing AddManualAttendance1720900000013: 2 shift attendance record\(s\)/);
        assert.match(error.message, new RegExp(`shift ${done} check-out x2`));
        assert.match(error.message, new RegExp(`shift ${spare} check-in x2`));
        return true;
      });
      assert.equal(await migrationCount(), 66, 'nothing applied');
      assert.deepEqual(await schema(), schemaBeforeRefusal, 'no schema change');
      assert.deepEqual(await hashAll((sql) => q(sql)), beforeRefusal, 'no row change');
    });
    await q(`DELETE FROM attendance_events WHERE id = ANY($1::int[])`, [[dupIn.id, dupIn2.id, dupOut.id]]);

    const before = await hashAll((sql) => q(sql));
    for (const t of ['attendance_events', 'company_memberships', 'timesheets', 'shifts', 'users']) assert.ok(before[t]?.length > 0, `${t} is seeded`);
    const at66Schema = await schema();
    const at66Enums = await enums();
    const applied = await ds.runMigrations({ transaction: 'each' });

    await test('M67-01-A-66-DATABASE-MIGRATES-TO-67-AND-67-IS-LAST', () => {
      assert.equal(applied.length, 1, 'only 67 is pending on a 66 database');
      assert.equal(applied[0].name, MIGRATION_67);
      assert.equal(allFiles.length, 72);
      assert.equal(allFiles[66], '1720900000013-AddManualAttendance.ts');
      assert.equal(allFiles[67], '1720900000014-AddPatrolManagement.ts', 'Migration 68 follows 67 and is certified by m68-migration.spec.ts');
      assert.equal(allFiles[68], '1720900000015-AddPatrolScheduling.ts', 'Migration 69 follows 68 and is certified by m69-migration.spec.ts');
      assert.equal(allFiles[69], '1720900000016-AddPatrolEvidenceStorage.ts', 'Migration 70 follows 69 and is certified by m70-migration.spec.ts');
      assert.equal(allFiles[70], '1720900000017-AddPatrolSweepReconciliation.ts', 'Migration 71 follows 70 and is certified by m71-migration.spec.ts');
      assert.equal(allFiles[71], '1720900000018-AddPatrolSyncRecoveryGrants.ts', 'Migration 72 follows 71 and is certified by m72-migration.spec.ts');
    });
    const head = await schema();

    await test('M67-02-THE-SCHEMA-IT-ADDS', async () => {
      const col = (table: string, column: string) => head.columns.find((c: any) => c.table_name === table && c.column_name === column);
      assert.equal(col('attendance_events', 'source')?.column_default, `'guard_app'::character varying`);
      assert.equal(col('attendance_events', 'source')?.is_nullable, 'NO');
      assert.equal(col('attendance_events', 'source')?.character_maximum_length, 20);
      assert.equal(col('attendance_events', 'recordedAt')?.data_type, 'timestamp without time zone', 'UTC wall time, like occurredAt');
      assert.equal(col('attendance_events', 'recordedAt')?.is_nullable, 'YES');
      assert.equal(col('attendance_events', 'recordedAt')?.column_default, 'now()', 'new rows only');
      assert.equal(col('attendance_events', 'verificationMethod')?.character_maximum_length, 30);
      for (const c of ['recordedByUserId', 'reason', 'verificationNote', 'correctionOfEventId']) {
        assert.equal(col('attendance_events', c)?.is_nullable, 'YES', c);
        assert.equal(col('attendance_events', c)?.column_default, null, c);
      }
      assert.equal(col('company_memberships', 'canManageAttendance')?.column_default, 'false');
      assert.equal(col('company_memberships', 'canManageAttendance')?.is_nullable, 'NO');
      assert.equal(col('timesheets', 'verifiedSource')?.column_default, `'guard_app'::character varying`);
      assert.equal(col('timesheets', 'verifiedSource')?.is_nullable, 'NO');

      const added = head.columns.filter((c: any) => !at66Schema.columns.some((o: any) => o.table_name === c.table_name && o.column_name === c.column_name))
        .map((c: any) => `${c.table_name}.${c.column_name}`).sort();
      assert.deepEqual(added, Object.entries(NEW_COLUMNS).flatMap(([t, cs]) => cs.map((c) => `${t}.${c}`)).sort(), 'exactly nine new columns');
      const kept = (rows: any[]) => rows.filter((c: any) => !(NEW_COLUMNS[c.table_name] ?? []).includes(c.column_name));
      assert.deepEqual(kept(head.columns), at66Schema.columns, 'no existing column changes');

      const def = (name: string) => head.constraints.find((c: any) => c.conname === name)?.def as string;
      // PostgreSQL 18 also lists NOT NULL as named constraints; those are the columns' nullability, checked above.
      const newConstraints = head.constraints.filter((c: any) => !at66Schema.constraints.some((o: any) => o.conname === c.conname))
        .map((c: any) => c.conname).filter((n: string) => !/_not_null$/.test(n)).sort();
      assert.deepEqual(newConstraints, [
        'CHK_attendance_events_app_fields', 'CHK_attendance_events_correction', 'CHK_attendance_events_manual_fields',
        'CHK_attendance_events_manual_no_device_evidence', 'CHK_attendance_events_other_note', 'CHK_attendance_events_source',
        'CHK_attendance_events_verification_method', 'CHK_timesheets_verified_source', 'FK_attendance_events_correction',
        'FK_attendance_events_recorded_by', 'UQ_attendance_events_id_shift_type',
      ].sort());
      assert.match(def('FK_attendance_events_correction'), /FOREIGN KEY \("correctionOfEventId", "shiftId", type\) REFERENCES attendance_events\(id, "shiftId", type\) ON DELETE RESTRICT/);
      assert.match(def('FK_attendance_events_recorded_by'), /REFERENCES users\(id\) ON DELETE RESTRICT/);
      assert.match(def('UQ_attendance_events_id_shift_type'), /UNIQUE \(id, "shiftId", type\)/);
      assert.deepEqual(head.constraints.filter((c: any) => at66Schema.constraints.some((o: any) => o.conname === c.conname)), at66Schema.constraints, 'no existing constraint changes');

      const index = (name: string) => head.indexes.find((i: any) => i.indexname === name)?.indexdef as string;
      assert.match(index('UQ_attendance_events_one_root'), /UNIQUE INDEX .*\("shiftId", type\) WHERE \("correctionOfEventId" IS NULL\)/);
      assert.match(index('UQ_attendance_events_one_correction'), /UNIQUE INDEX .*\("correctionOfEventId"\) WHERE \("correctionOfEventId" IS NOT NULL\)/);
      const kIdx = (rows: any[]) => rows.filter((i: any) => !/UQ_attendance_events_(one_root|one_correction|id_shift_type)/.test(i.indexname));
      assert.deepEqual(kIdx(head.indexes), at66Schema.indexes, 'no existing index changes');

      assert.deepEqual(head.views.map((v: any) => v.viewname), ['effective_attendance_events']);
      assert.match(head.views[0].definition, /NOT \(EXISTS[\s\S]*"correctionOfEventId" = e\.id/);
      assert.deepEqual(head.tables, at66Schema.tables, 'no new table');
      assert.deepEqual(await enums(), at66Enums, 'no enum changes');
    });

    await test('M67-03-EXISTING-ROWS-ARE-UNCHANGED-AND-NOTHING-IS-BACKFILLED', async () => {
      assert.deepEqual(await hashAll((sql) => q(sql)), before, 'every existing row keeps its values');
      const rows = await q(`SELECT source, "recordedAt", "recordedByUserId", reason, "verificationMethod", "verificationNote", "correctionOfEventId" FROM attendance_events`);
      assert.equal(rows.length, 3);
      for (const r of rows) {
        assert.deepEqual(r, { source: 'guard_app', recordedAt: null, recordedByUserId: null, reason: null, verificationMethod: null, verificationNote: null, correctionOfEventId: null },
          'existing rows are Guard-app rows with no recordedAt (never the deploy time)');
      }
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM company_memberships WHERE "canManageAttendance"`)), 0);
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM timesheets WHERE "verifiedSource" <> 'guard_app'`)), 0);
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM effective_attendance_events`)), 3, 'every existing row is effective');
    });

    await test('M67-04-SECOND-RUN-AND-REPEATED-UP-ARE-NO-OPS', async () => {
      assert.equal((await ds.runMigrations({ transaction: 'each' })).length, 0);
      const { AddManualAttendance1720900000013 } = await import('../src/database/migrations/1720900000013-AddManualAttendance');
      const runner = ds.createQueryRunner();
      try {
        await new AddManualAttendance1720900000013().up(runner);
      } finally {
        await runner.release();
      }
      assert.deepEqual(await schema(), head);
      assert.equal(await migrationCount(), 67);
    });

    // A manual row with every required field; `over` replaces columns (SQL literals).
    const manual = (over: Record<string, string> = {}) => {
      const cols: Record<string, string> = {
        shiftId: String(spare2), guardId: String(guard.id), type: `'check-in'`, occurredAt: `now() - interval '10 minutes'`,
        source: `'manual'`, recordedAt: 'now()', recordedByUserId: String(recorder.id), reason: `'Guard phoned in; phone flat'`,
        verificationMethod: `'phone_call'`, ...over,
      };
      const entries = Object.entries(cols).filter(([, v]) => v !== 'OMIT');
      return q(`INSERT INTO attendance_events (${entries.map(([c]) => `"${c}"`).join(',')}) VALUES (${entries.map(([, v]) => v).join(',')}) RETURNING id`);
    };

    await test('M67-06-EVERY-CHECK-REFUSES-WHAT-IT-SHOULD', async () => {
      await assert.rejects(() => manual({ source: `'import'` }), /CHK_attendance_events_source/);
      await assert.rejects(() => manual({ verificationMethod: `'telepathy'` }), /CHK_attendance_events_verification_method/);
      await assert.rejects(() => manual({ recordedByUserId: 'NULL' }), /CHK_attendance_events_manual_fields/, 'manual needs its recorder');
      await assert.rejects(() => manual({ recordedAt: 'NULL' }), /CHK_attendance_events_manual_fields/, 'manual needs its recorded time');
      await assert.rejects(() => manual({ reason: 'NULL' }), /CHK_attendance_events_manual_fields/, 'manual needs a reason');
      await assert.rejects(() => manual({ reason: `'   '` }), /CHK_attendance_events_manual_fields/, 'a blank reason is no reason');
      await assert.rejects(() => manual({ verificationMethod: 'NULL' }), /CHK_attendance_events_manual_fields/, 'manual needs a verification method');
      await assert.rejects(() => manual({ verificationMethod: `'other'` }), /CHK_attendance_events_other_note/, "'other' needs a note");
      await assert.rejects(() => manual({ verificationMethod: `'other'`, verificationNote: `' '` }), /CHK_attendance_events_other_note/);
      for (const evidence of <Array<Record<string, string>>>[{ gpsVerified: 'true' }, { nfcVerified: 'true' }, { latitude: '51.5' }, { longitude: '-0.1' }, { gpsAccuracyMeters: '5' }, { distanceFromSiteMeters: '3' }, { nfcTag: `'x'` }]) {
        await assert.rejects(() => manual(evidence), /CHK_attendance_events_manual_no_device_evidence/, `manual rows carry no device evidence: ${Object.keys(evidence)[0]}`);
      }
      await assert.rejects(() => manual({ source: `'guard_app'`, recordedAt: 'OMIT' }), /CHK_attendance_events_app_fields/, 'an app row carries no manual fields');
      const [root] = await q(`INSERT INTO attendance_events ("shiftId","guardId",type) VALUES ($1,$2,'check-in') RETURNING id, source, "recordedAt"`, [spare2, guard.id]);
      assert.equal(root.source, 'guard_app', 'the Guard app path writes exactly what it always did');
      assert.ok(root.recordedAt instanceof Date, 'a NEW row gets recordedAt by default');
      await assert.rejects(() => q(`INSERT INTO attendance_events ("shiftId","guardId",type,"correctionOfEventId") VALUES ($1,$2,'check-in',$3)`, [spare2, guard.id, root.id]),
        /CHK_attendance_events_correction/, 'a correction is always manual');
      await assert.rejects(() => manual({ id: '987654', correctionOfEventId: '987654' }), /CHK_attendance_events_correction/, 'a row never corrects itself');
      await assert.rejects(() => q(`UPDATE timesheets SET "verifiedSource" = 'guess'`), /CHK_timesheets_verified_source/);
      await q(`DELETE FROM attendance_events WHERE id = $1`, [root.id]);
    });

    await test('M67-07-THE-CORRECTION-CHAIN', async () => {
      const [root] = await manual();
      await assert.rejects(() => manual(), /UQ_attendance_events_one_root/, 'one root per (shift, type)');
      await assert.rejects(() => q(`INSERT INTO attendance_events ("shiftId","guardId",type) VALUES ($1,$2,'check-in')`, [spare2, guard.id]),
        /UQ_attendance_events_one_root/, 'the Guard app cannot add a second Book On either');
      const original = await q(`SELECT to_jsonb(a)::text j FROM attendance_events a WHERE id = $1`, [root.id]);
      const [c1] = await manual({ correctionOfEventId: String(root.id), occurredAt: `now() - interval '20 minutes'` });
      await assert.rejects(() => manual({ correctionOfEventId: String(root.id) }), /UQ_attendance_events_one_correction/, 'a row is corrected at most once');
      const [c2] = await manual({ correctionOfEventId: String(c1.id), occurredAt: `now() - interval '25 minutes'` });
      const [c3] = await manual({ correctionOfEventId: String(c2.id), occurredAt: `now() - interval '30 minutes'` });
      assert.deepEqual((await q(`SELECT id FROM effective_attendance_events WHERE "shiftId" = $1`, [spare2])).map((r: any) => r.id), [c3.id],
        'a chain of any length has exactly one effective row: its tip');
      await assert.rejects(() => manual({ correctionOfEventId: String(c3.id), type: `'check-out'` }), /FK_attendance_events_correction/, 'same type only');
      await assert.rejects(() => manual({ correctionOfEventId: String(c3.id), shiftId: String(spare) }), /FK_attendance_events_correction/, 'same shift only');
      await assert.rejects(() => q(`DELETE FROM attendance_events WHERE id = $1`, [c2.id]), /FK_attendance_events_correction/, 'a corrected row cannot be deleted');
      assert.deepEqual(await q(`SELECT to_jsonb(a)::text j FROM attendance_events a WHERE id = $1`, [root.id]), original, 'the original row is byte-identical');
      await assert.rejects(() => q(`DELETE FROM users WHERE id = $1`, [recorder.id]), /FK_attendance_events_recorded_by/, 'a recorder is never deleted from under the record');
    });

    await test('M67-08-DOWN-REFUSES-WHILE-MANUAL-EVIDENCE-OR-GRANTS-EXIST-AND-CHANGES-NOTHING', async () => {
      const snapshot = await hashAll((sql) => q(sql));
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /Refusing to revert AddManualAttendance1720900000013: 4 manual, 3 corrections exist/);
      assert.equal(await migrationCount(), 67);
      assert.deepEqual(await hashAll((sql) => q(sql)), snapshot, 'the evidence is untouched');
      // Delete the chain tip-first (RESTRICT), then prove each other blocker on its own.
      const chain = await q(`SELECT id FROM attendance_events WHERE source = 'manual' ORDER BY id DESC`);
      for (const r of chain) await q(`DELETE FROM attendance_events WHERE id = $1`, [r.id]);
      await q(`UPDATE company_memberships SET "canManageAttendance" = true`);
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /1 grants exist/);
      await q(`UPDATE company_memberships SET "canManageAttendance" = false`);
      await q(`UPDATE timesheets SET "verifiedSource" = 'manual'`);
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /1 timesheets exist/);
      await q(`UPDATE timesheets SET "verifiedSource" = 'guard_app'`);
      assert.equal(await migrationCount(), 67);
    });

    await test('M67-09-DOWN-REMOVES-EXACTLY-WHAT-67-ADDED-AND-REAPPLY-RESTORES-IT', async () => {
      const rowsBefore = await hashAll((sql) => q(sql));
      await ds.undoLastMigration({ transaction: 'each' });
      assert.equal(await migrationCount(), 66);
      assert.deepEqual(await schema(), at66Schema, 'back to the 66 schema');
      assert.deepEqual(await hashAll((sql) => q(sql)), rowsBefore, 'existing rows survive the round trip');
      await ds.runMigrations({ transaction: 'each' });
      assert.deepEqual(await schema(), head);
    });

    await test('M67-10-NO-SEMANTIC-DRIFT-AND-NO-DRIFT-ON-NEW-OBJECTS', async () => {
      const drift = (await ds.driver.createSchemaBuilder().log()).upQueries.map((x) => x.query);
      const ours = drift.filter((x) => /source|recordedAt|recordedByUserId|verificationMethod|verificationNote|correctionOfEventId|canManageAttendance|verifiedSource|"reason"/.test(x)
        && /attendance_events|company_memberships|timesheets/.test(x) && !/DROP CONSTRAINT|ADD CONSTRAINT|DROP INDEX|CREATE (UNIQUE )?INDEX/.test(x));
      assert.deepEqual(ours, [], `entity and migration 67 disagree:\n${ours.join('\n')}`);
      // This database stops at 67, so Migration 68's eleven patrol tables and companies.patrolsEnabled are absent by
      // design (m68-migration.spec.ts M68-10 certifies them); they are set aside statement by statement. Nothing else is.
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
      const semantic = drift.filter((x) => !m68.test(x) && !m69.test(x) && !m70.test(x) && !m71.test(x) && !m72.test(x) &&
        /CREATE TABLE|DROP TABLE|CREATE TYPE|DROP TYPE|ALTER TYPE|ALTER TABLE.*ALTER COLUMN|ALTER TABLE.*DROP COLUMN|ALTER TABLE.*ADD "/i.test(x));
      assert.deepEqual(semantic, [], `semantic drift (the release gate would fail):\n${semantic.join('\n')}`);
      console.log(`      (diagnostic-only drift elsewhere: ${drift.length} statement(s))`);
    });

    await test('M67-11-ROLLBACK-COMPATIBLE-WITH-THE-PREVIOUS-RELEASE', async () => {
      const previous = new DataSource({
        type: 'postgres', url, entities: [], synchronize: false, migrations: through66, migrationsTableName: 'typeorm_migrations', logging: false,
      });
      await previous.initialize();
      try {
        assert.equal((await previous.runMigrations({ transaction: 'each' })).length, 0, "the previous release's pre-deploy run is a no-op");
        const [s] = await previous.query(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'M67 Site',$3,'ready',
            now() - interval '1 hour', now() + interval '7 hours') RETURNING id`, [company.id, site.id, guard.id]);
        // The statements the previous release's Book On / Book Off issue (TypeORM: the columns it knows, defaults for the rest).
        await previous.query(`INSERT INTO attendance_events ("shiftId","guardId",type,"nfcTag","nfcVerified",latitude,longitude,"gpsAccuracyMeters","distanceFromSiteMeters","gpsVerified",notes)
           VALUES ($1,$2,'check-in',NULL,false,51.5,-0.1,5,10,true,NULL)`, [s.id, guard.id]);
        await previous.query(`INSERT INTO attendance_events ("shiftId","guardId",type,"nfcTag","nfcVerified",latitude,longitude,"gpsAccuracyMeters","distanceFromSiteMeters","gpsVerified",notes)
           VALUES ($1,$2,'check-out',NULL,false,NULL,NULL,NULL,NULL,false,NULL)`, [s.id, guard.id]);
        await previous.query(`INSERT INTO timesheets ("shiftId","guardId","companyId","hoursWorked","approvalStatus") VALUES ($1,$2,$3,0,'draft')`, [s.id, guard.id, company.id]);
        await previous.query(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status,"canAmendShifts") VALUES ($1,$2,'operations','active',false)`, [owner.id, company.id]);
        const rows = await previous.query(`SELECT source FROM attendance_events WHERE "shiftId" = $1`, [s.id]);
        assert.deepEqual(rows.map((r: any) => r.source), ['guard_app', 'guard_app']);
        await previous.query(`DELETE FROM company_memberships WHERE "userId" = $1 AND "membershipRole" = 'operations'`, [owner.id]);
      } finally {
        await previous.destroy();
      }
    });
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  console.log(JSON.stringify({ event: 'm67_migration_certified', tests: passed }));
  if (failures.length) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
