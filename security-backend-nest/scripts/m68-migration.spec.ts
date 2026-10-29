/**
 * Migration 68 (AddPatrolManagement1720900000014) certification, on a disposable database built from the repository's
 * own migrations.
 *
 *   M68-01  a database at 67 migrates to 68 and 68 is the last migration
 *   M68-02  the schema it adds: eleven patrol tables, companies.patrolsEnabled (boolean NOT NULL DEFAULT false); every
 *           new time is timestamptz; no PostgreSQL enum type is created (status / method columns are varchar + CHECK);
 *           no existing table, column, constraint or index changes apart from the one company column
 *   M68-03  every existing row keeps its values; every existing company reads patrolsEnabled = false
 *   M68-04  a second run applies nothing; re-running up() directly changes nothing
 *   M68-05  the CHECK vocabularies are exactly patrol-constants.ts (every value accepted, anything else refused), and a
 *           bare policy row carries exactly the owner-approved defaults
 *   M68-06  tenant and site integrity in the database itself: composite foreign keys refuse a route link to another
 *           site's checkpoint, a scan of another company's checkpoint, evidence or a scan on another company's run
 *   M68-07  idempotency keys: (companyId, clientRunId / clientVisitId / clientEvidenceId) unique per company, the same id
 *           in another company allowed; at most one open run per Guard per shift; one open exception per window
 *   M68-08  down() refuses while any run, scan, evidence, exception or hold exists, and changes nothing
 *   M68-09  down() with none removes exactly what 68 added; re-applying restores the identical schema
 *   M68-10  no semantic entity-to-migration drift at 68 and no column-level drift on any patrol table
 *   M68-11  rollback compatibility: the previous release's pre-deploy run (through 67) is a no-op on a 68 database and
 *           its company / shift writes (which never name patrolsEnabled) still succeed
 *
 * Needs M68_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';
import {
  PATROL_EVIDENCE_RETENTION_STATUSES,
  PATROL_EVIDENCE_UPLOAD_STATUSES,
  PATROL_EXCEPTION_STATUSES,
  PATROL_EXCEPTION_TYPES,
  PATROL_HOLD_SCOPES,
  PATROL_HOLD_SOURCES,
  PATROL_ORDER_MODES,
  PATROL_POLICY_DEFAULTS,
  PATROL_REQUIREMENT_SCOPES,
  PATROL_RUN_STATUSES,
  PATROL_VERIFICATION_STATUSES,
  PATROL_VISIT_METHODS,
  PATROL_VISIT_RESULTS,
} from '../src/patrol/patrol-constants';

const url = process.env.M68_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M68_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('M68 database must be local');

const MIGRATION_67 = 'AddManualAttendance1720900000013';
const MIGRATION_68 = 'AddPatrolManagement1720900000014';
const PATROL_TABLES = [
  'patrol_checkpoint_visits', 'patrol_checkpoints', 'patrol_evidence', 'patrol_evidence_holds', 'patrol_exceptions', 'patrol_policies',
  'patrol_route_checkpoints', 'patrol_routes', 'patrol_runs', 'patrol_schedules', 'patrol_storage_usage_daily',
];
const EXISTING = ['companies', 'sites', 'shifts', 'users', 'guard_profiles', 'attendance_events', 'company_memberships', 'timesheets', 'safety_alerts', 'incidents'];

let passed = 0;
const failures: string[] = [];
const test = async (id: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failures.push(id);
    console.log(`FAIL  ${id}\n      ${String((error as Error)?.stack ?? error).split('\n').slice(0, 6).join('\n      ')}`);
  }
};

async function main() {
  const path = require('node:path');
  const fs = require('node:fs');
  const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
  const allFiles: string[] = fs.readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).sort();
  const through67 = allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000013).map((f) => path.join(migrationsDir, f));
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: false,
    migrations: allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000014).map((f) => path.join(migrationsDir, f)),
    migrationsTableName: 'typeorm_migrations', logging: false,
  });
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const scalar = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0];
  const migrationCount = async () => Number(await scalar('SELECT count(*)::int FROM typeorm_migrations'));

  const schemaOf = async (run: (sql: string) => Promise<any[]>) => ({
    tables: (await run(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r: any) => r.tablename),
    columns: await run(`SELECT table_name, column_name, data_type, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`),
    constraints: await run(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace AND conrelid <> 0 ORDER BY 1, 2`),
    indexes: await run(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`),
    enums: await run(`SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid ORDER BY 1, e.enumsortorder`),
  });
  const schema = () => schemaOf((sql) => q(sql));
  const notPatrol = (rows: any[], key: string) => rows.filter((r: any) => !String(r[key]).startsWith('patrol_'));
  /** Every row of every pre-existing table, without Migration 68's one new column. */
  const hashAll = async (run: (sql: string) => Promise<any[]>) => {
    const tables = (await run(`SELECT tablename t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.t as string)
      .filter((t) => t !== 'typeorm_migrations' && !t.startsWith('patrol_'));
    const out: Record<string, string[]> = {};
    for (const t of tables) {
      const drop = t === 'companies' ? ` - 'patrolsEnabled'` : '';
      out[t] = (await run(`SELECT md5((to_jsonb(x)${drop})::text) h FROM "${t}" x ORDER BY 1`)).map((r) => r.h);
    }
    return out;
  };

  try {
    // ── to 67, seed production-shaped rows ──────────────────────────────────────────────────────────────
    const at67 = new DataSource({
      type: 'postgres', url, entities: [], synchronize: false, migrations: through67, migrationsTableName: 'typeorm_migrations', logging: false,
    });
    await at67.initialize();
    await at67.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const applied67 = await at67.runMigrations({ transaction: 'each' });
    assert.equal(applied67[applied67.length - 1].name, MIGRATION_67);
    const user = async (email: string, role: string) =>
      (await at67.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ($1,'x',$2,'active') RETURNING id`, [email, role]))[0].id as number;
    const companyRow = async (label: string, ownerId: number) =>
      (await at67.query(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,$2,'68686868','1 Way','o@example.invalid') RETURNING id`,
        [ownerId, label]))[0].id as number;
    const ownerA = await user('m68.a@example.invalid', 'company_admin');
    const ownerB = await user('m68.b@example.invalid', 'company_admin');
    const coA = await companyRow('M68 A Ltd', ownerA);
    const coB = await companyRow('M68 B Ltd', ownerB);
    const site = async (co: number, name: string) => (await at67.query(`INSERT INTO sites ("companyId",name,address) VALUES ($1,$2,'2 Way') RETURNING id`, [co, name]))[0].id as number;
    const siteA1 = await site(coA, 'A1');
    const siteA2 = await site(coA, 'A2');
    const siteB1 = await site(coB, 'B1');
    const gu = await user('m68.guard@example.invalid', 'guard');
    const [guard] = await at67.query(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'M68 Guard','1000000000000068','07000000068') RETURNING id`, [gu]);
    const shift = async (co: number, s: number, status: string) => (await at67.query(
      `INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'x',$3,$4,now() - interval '1 hour',now() + interval '7 hours') RETURNING id`,
      [co, s, guard.id, status]))[0].id as number;
    const shiftA = await shift(coA, siteA1, 'in_progress');
    const shiftB = await shift(coB, siteB1, 'in_progress');
    await at67.query(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","gpsVerified") VALUES ($1,$2,'check-in',now() - interval '1 hour',false)`, [shiftA, guard.id]);
    await at67.query(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,'operations','active')`,
      [await user('m68.ops@example.invalid', 'company_staff'), coA]);
    const before = await hashAll((sql) => at67.query(sql));
    const at67Schema = await schemaOf((sql) => at67.query(sql));
    await at67.destroy();

    await ds.initialize();
    const applied = await ds.runMigrations({ transaction: 'each' });

    await test('M68-01-A-67-DATABASE-MIGRATES-TO-68-AND-ONLY-69-FOLLOWS', () => {
      assert.equal(applied.length, 1, 'only 68 is pending on a 67 database');
      assert.equal(applied[0].name, MIGRATION_68);
      assert.equal(allFiles.length, 70);
      assert.equal(allFiles[67], '1720900000014-AddPatrolManagement.ts');
      assert.equal(allFiles[68], '1720900000015-AddPatrolScheduling.ts', 'Migration 69 follows 68 and is certified by m69-migration.spec.ts');
      assert.equal(allFiles[69], '1720900000016-AddPatrolEvidenceStorage.ts', 'Migration 70 follows 69 and is certified by m70-migration.spec.ts');
    });
    const head = await schema();

    await test('M68-02-THE-SCHEMA-IT-ADDS-AND-NOTHING-ELSE', async () => {
      assert.deepEqual(head.tables.filter((t: string) => t.startsWith('patrol_')), PATROL_TABLES, 'exactly the eleven patrol tables');
      assert.deepEqual(head.tables.filter((t: string) => !t.startsWith('patrol_')), at67Schema.tables, 'no other table');
      const col = (t: string, c: string) => head.columns.find((x: any) => x.table_name === t && x.column_name === c);
      assert.deepEqual(
        [col('companies', 'patrolsEnabled')?.data_type, col('companies', 'patrolsEnabled')?.is_nullable, col('companies', 'patrolsEnabled')?.column_default],
        ['boolean', 'NO', 'false'],
      );
      const existingCols = notPatrol(head.columns, 'table_name').filter((c: any) => !(c.table_name === 'companies' && c.column_name === 'patrolsEnabled'));
      assert.deepEqual(existingCols, at67Schema.columns, 'no existing column changes');
      // PostgreSQL 18 also lists NOT NULL as named constraints; the new column's is its nullability, checked above.
      assert.deepEqual(notPatrol(head.constraints, 'tbl').filter((c: any) => !/patrolsEnabled_not_null$/.test(c.conname)), at67Schema.constraints,
        'no existing constraint changes');
      assert.deepEqual(notPatrol(head.indexes, 'tablename'), at67Schema.indexes, 'no existing index changes');
      assert.deepEqual(head.enums, at67Schema.enums, 'no enum type created or changed');
      const patrolTimes = head.columns.filter((c: any) => c.table_name.startsWith('patrol_') && /timestamp/.test(c.data_type));
      assert.ok(patrolTimes.length >= 40);
      for (const c of patrolTimes) assert.equal(c.data_type, 'timestamp with time zone', `${c.table_name}.${c.column_name} is timestamptz`);
      for (const [t, c] of [['patrol_runs', 'status'], ['patrol_runs', 'verificationStatus'], ['patrol_checkpoint_visits', 'result'], ['patrol_checkpoint_visits', 'method'],
        ['patrol_evidence', 'uploadStatus'], ['patrol_evidence', 'retentionStatus'], ['patrol_exceptions', 'type'], ['patrol_exceptions', 'status']]) {
        assert.equal(col(t, c)?.data_type, 'character varying', `${t}.${c} is varchar + CHECK, never an enum`);
      }
      const evidence = ['retentionStatus', 'claimToken', 'claimedAt', 'quarantinedAt', 'purgedAt', 'restoredAt', 'deletionAttempts', 'lastDeletionError', 'expiresAt', 'sha256Client', 'sha256Stored'];
      for (const c of evidence) assert.ok(col('patrol_evidence', c), `patrol_evidence.${c} exists for P1-C`);
      assert.equal(col('patrol_checkpoints', 'publicId')?.character_maximum_length, 32);
      const fks = head.constraints.filter((c: any) => c.tbl.startsWith('patrol_') && c.conname.startsWith('FK_'));
      assert.ok(fks.length >= 50, `${fks.length} foreign keys`);
      for (const fk of fks.filter((f: any) => !/route_checkpoints_route/.test(f.conname))) {
        assert.doesNotMatch(fk.def, /ON DELETE (CASCADE|SET NULL)/, `${fk.conname}: evidence-bearing references never cascade`);
      }
    });

    await test('M68-03-EXISTING-ROWS-ARE-UNCHANGED-AND-THE-SWITCH-IS-OFF', async () => {
      assert.deepEqual(await hashAll((sql) => q(sql)), before, 'every existing row keeps its values');
      assert.deepEqual((await q(`SELECT "patrolsEnabled" FROM companies ORDER BY id`)).map((r: any) => r.patrolsEnabled), [false, false]);
      for (const t of PATROL_TABLES) assert.equal(Number(await scalar(`SELECT count(*)::int FROM "${t}"`)), 0, `${t} starts empty`);
    });

    await test('M68-04-SECOND-RUN-AND-REPEATED-UP-ARE-NO-OPS', async () => {
      assert.equal((await ds.runMigrations({ transaction: 'each' })).length, 0);
      const { AddPatrolManagement1720900000014 } = await import('../src/database/migrations/1720900000014-AddPatrolManagement');
      const runner = ds.createQueryRunner();
      try {
        await new AddPatrolManagement1720900000014().up(runner);
      } finally {
        await runner.release();
      }
      assert.deepEqual(await schema(), head);
      assert.equal(await migrationCount(), 68);
    });

    // Small builders for valid rows; `over` replaces values (SQL literals).
    const insert = async (table: string, cols: Record<string, string>, over: Record<string, string> = {}) => {
      const entries = Object.entries({ ...cols, ...over }).filter(([, v]) => v !== 'OMIT');
      return (await q(`INSERT INTO "${table}" (${entries.map(([c]) => `"${c}"`).join(',')}) VALUES (${entries.map(([, v]) => v).join(',')}) RETURNING *`))[0];
    };
    let seq = 0;
    const cid = () => `'m68-client-${String(++seq).padStart(4, '0')}'`;
    const hex = (n: number) => `'${n.toString(16).padStart(32, '0')}'`;
    const checkpoint = (co: number, s: number, over: Record<string, string> = {}) =>
      insert('patrol_checkpoints', { companyId: String(co), siteId: String(s), publicId: hex(++seq), label: `'Gate'` }, over);
    const run = (co: number, s: number, sh: number, over: Record<string, string> = {}) =>
      insert('patrol_runs', { companyId: String(co), siteId: String(s), shiftId: String(sh), guardId: String(guard.id), startedByUserId: String(gu),
        startedAtDevice: 'now()', clientRunId: cid() }, over);
    const visit = (co: number, r: number, over: Record<string, string> = {}) =>
      insert('patrol_checkpoint_visits', { companyId: String(co), runId: String(r), scannedPublicId: hex(9999), result: `'unverified'`, scannedAtDevice: 'now()', clientVisitId: cid() }, over);
    const evidence = (co: number, s: number, r: number, sh: number, over: Record<string, string> = {}) =>
      insert('patrol_evidence', { companyId: String(co), siteId: String(s), runId: String(r), guardId: String(guard.id), shiftId: String(sh),
        sha256Client: `'${'a'.repeat(64)}'`, capturedAtDevice: 'now()', clientEvidenceId: cid() }, over);
    const cleanup = async () => {
      for (const t of ['patrol_evidence_holds', 'patrol_evidence', 'patrol_exceptions', 'patrol_checkpoint_visits', 'patrol_runs', 'patrol_schedules',
        'patrol_route_checkpoints', 'patrol_routes', 'patrol_checkpoints', 'patrol_policies', 'patrol_storage_usage_daily']) await q(`DELETE FROM "${t}"`);
    };

    await test('M68-05-CHECK-VOCABULARIES-ARE-THE-CONSTANTS-AND-DEFAULTS-ARE-THE-OWNER-APPROVED-ONES', async () => {
      const [policy] = await q(`INSERT INTO patrol_policies ("companyId") VALUES ($1) RETURNING *`, [coA]);
      // Migration 68's columns: the four sync / review settings PATROL_POLICY_DEFAULTS also holds arrive with Migration 69
      // (m69-migration.spec.ts certifies their defaults).
      const { postShiftSyncHours: _h, clockDriftThresholdMinutes: _c, allowUnscheduledPatrols: _u, escalateUnverified: _e, ...d } = PATROL_POLICY_DEFAULTS;
      assert.deepEqual(
        { methods: policy.methods, photosPerRun: policy.photosPerRun, photosPerCheckpoint: policy.photosPerCheckpoint, orderMode: policy.orderMode,
          startGraceMinutes: policy.startGraceMinutes, maxPatrolDurationMinutes: policy.maxPatrolDurationMinutes, completionGraceMinutes: policy.completionGraceMinutes,
          syncGraceMinutes: policy.syncGraceMinutes, requirementScope: policy.requirementScope, retentionDays: policy.retentionDays,
          incompleteNeedsAction: policy.incompleteNeedsAction, qrRequireProximity: policy.qrRequireProximity, proximityMeters: policy.proximityMeters },
        { ...d },
        'database defaults = PATROL_POLICY_DEFAULTS',
      );
      assert.deepEqual([d.requirementScope, d.retentionDays, d.startGraceMinutes, d.maxPatrolDurationMinutes, d.completionGraceMinutes, d.syncGraceMinutes, d.qrRequireProximity],
        ['site', 30, 15, 45, 30, 60, false], 'the owner-approved values (28 Oct 2026)');
      await assert.rejects(() => q(`INSERT INTO patrol_policies ("companyId") VALUES ($1)`, [coA]), /UQ_patrol_policies_company_default/, 'one company default');
      await assert.rejects(() => q(`UPDATE patrol_policies SET "retentionDays" = 60`), /CHK_patrol_policies_retention/);
      await q(`UPDATE patrol_policies SET "retentionDays" = 90`);
      await assert.rejects(() => q(`UPDATE patrol_policies SET methods = '["gps"]'`), /CHK_patrol_policies_methods/);
      await assert.rejects(() => q(`UPDATE patrol_policies SET methods = '[]'`), /CHK_patrol_policies_methods/);
      for (const v of PATROL_REQUIREMENT_SCOPES) await q(`UPDATE patrol_policies SET "requirementScope" = $1`, [v]);
      await assert.rejects(() => q(`UPDATE patrol_policies SET "requirementScope" = 'everyone'`), /CHK_patrol_policies_scope/);
      for (const v of PATROL_ORDER_MODES) await q(`UPDATE patrol_policies SET "orderMode" = $1`, [v]);
      await assert.rejects(() => q(`UPDATE patrol_policies SET "orderMode" = 'random'`), /CHK_patrol_policies_order_mode/);

      const sched = { companyId: String(coA), siteId: String(siteA1), name: `'Hourly'`, activeFrom: `'22:00'`, activeTo: `'06:00'`, frequencyMinutes: '60', windowMinutes: '60' };
      await insert('patrol_schedules', sched);
      await assert.rejects(() => insert('patrol_schedules', sched, { frequencyMinutes: '14', windowMinutes: '10' }), /CHK_patrol_schedules_frequency/);
      await assert.rejects(() => insert('patrol_schedules', sched, { frequencyMinutes: '1441' }), /CHK_patrol_schedules_frequency/);
      await assert.rejects(() => insert('patrol_schedules', sched, { windowMinutes: '61' }), /CHK_patrol_schedules_window/);
      await assert.rejects(() => insert('patrol_schedules', sched, { activeFrom: `'24:00'` }), /CHK_patrol_schedules_active_period/);
      await assert.rejects(() => insert('patrol_schedules', sched, { daysOfWeek: `'[0]'` }), /CHK_patrol_schedules_days/);

      await assert.rejects(() => checkpoint(coA, siteA1, { publicId: `'NOT-HEX'` }), /CHK_patrol_checkpoints_public_id/);
      await assert.rejects(() => checkpoint(coA, siteA1, { tokenVersion: '0' }), /CHK_patrol_checkpoints_token_version/);
      await assert.rejects(() => checkpoint(coA, siteA1, { revokedAt: 'now()' }), /CHK_patrol_checkpoints_revoked_inactive/);
      const cp = await checkpoint(coA, siteA1);
      await assert.rejects(() => checkpoint(coA, siteA1, { publicId: `'${cp.publicId}'` }), /UQ_patrol_checkpoints_public_id/);

      const r = await run(coA, siteA1, shiftA);
      for (const v of PATROL_VERIFICATION_STATUSES) await q(`UPDATE patrol_runs SET "verificationStatus" = $1 WHERE id = $2`, [v, r.id]);
      await assert.rejects(() => q(`UPDATE patrol_runs SET "verificationStatus" = 'ok' WHERE id = $1`, [r.id]), /CHK_patrol_runs_verification_status/);
      for (const v of PATROL_RUN_STATUSES.filter((s) => s !== 'in_progress')) {
        await q(`UPDATE patrol_runs SET status = $1, "completedAtServer" = now(), "exceptionReason" = 'x' WHERE id = $2`, [v, r.id]);
      }
      await q(`UPDATE patrol_runs SET status = 'in_progress', "completedAtServer" = NULL, "exceptionReason" = NULL WHERE id = $1`, [r.id]);
      await assert.rejects(() => q(`UPDATE patrol_runs SET status = 'done', "completedAtServer" = now() WHERE id = $1`, [r.id]), /CHK_patrol_runs_status/);
      await assert.rejects(() => q(`UPDATE patrol_runs SET status = 'completed' WHERE id = $1`, [r.id]), /CHK_patrol_runs_completion/, 'completed needs its server time');
      await assert.rejects(() => q(`UPDATE patrol_runs SET status = 'incomplete', "completedAtServer" = now() WHERE id = $1`, [r.id]), /CHK_patrol_runs_incomplete_reason/);
      await assert.rejects(() => run(coA, siteA1, shiftA, { clientRunId: `'bad id!'` }), /CHK_patrol_runs_client_run_id/);

      const v = await visit(coA, r.id);
      for (const x of PATROL_VISIT_RESULTS) await q(`UPDATE patrol_checkpoint_visits SET result = $1 WHERE id = $2`, [x, v.id]);
      await assert.rejects(() => q(`UPDATE patrol_checkpoint_visits SET result = 'ok' WHERE id = $1`, [v.id]), /CHK_patrol_checkpoint_visits_result/);
      for (const x of PATROL_VISIT_METHODS) await q(`UPDATE patrol_checkpoint_visits SET method = $1 WHERE id = $2`, [x, v.id]);
      await assert.rejects(() => q(`UPDATE patrol_checkpoint_visits SET method = 'gps' WHERE id = $1`, [v.id]), /CHK_patrol_checkpoint_visits_method/);
      await assert.rejects(() => visit(coA, r.id, { scannedPublicId: 'NULL' }), /CHK_patrol_checkpoint_visits_scanned/);

      const e = await evidence(coA, siteA1, r.id, shiftA);
      for (const x of PATROL_EVIDENCE_UPLOAD_STATUSES) await q(`UPDATE patrol_evidence SET "uploadStatus" = $1 WHERE id = $2`, [x, e.id]);
      await assert.rejects(() => q(`UPDATE patrol_evidence SET "uploadStatus" = 'gone' WHERE id = $1`, [e.id]), /CHK_patrol_evidence_upload_status/);
      await q(`UPDATE patrol_evidence SET "claimToken" = gen_random_uuid(), "claimedAt" = now(), "purgedAt" = now() WHERE id = $1`, [e.id]);
      for (const x of PATROL_EVIDENCE_RETENTION_STATUSES) await q(`UPDATE patrol_evidence SET "retentionStatus" = $1 WHERE id = $2`, [x, e.id]);
      await assert.rejects(() => q(`UPDATE patrol_evidence SET "retentionStatus" = 'deleted' WHERE id = $1`, [e.id]), /CHK_patrol_evidence_retention_status/);
      await assert.rejects(() => q(`UPDATE patrol_evidence SET "retentionStatus" = 'claimed', "claimToken" = NULL WHERE id = $1`, [e.id]), /CHK_patrol_evidence_claim/);
      await assert.rejects(() => q(`UPDATE patrol_evidence SET "retentionStatus" = 'tombstone', "purgedAt" = NULL WHERE id = $1`, [e.id]), /CHK_patrol_evidence_purged/);
      await assert.rejects(() => evidence(coA, siteA1, r.id, shiftA, { sha256Client: `'XYZ'` }), /CHK_patrol_evidence_sha256/);
      await assert.rejects(() => evidence(coA, siteA1, r.id, shiftA, { retentionDays: '60' }), /CHK_patrol_evidence_retention_days/);

      const exc = { companyId: String(coA), siteId: String(siteA1), windowKey: `'s1:2026-10-28:3'`, type: `'patrol_missed'` };
      const x1 = await insert('patrol_exceptions', exc);
      // 'patrol_abandoned' is Migration 69's (m69-migration.spec.ts); at 68 it is still refused.
      for (const t of PATROL_EXCEPTION_TYPES.filter((t) => t !== 'patrol_abandoned')) await q(`UPDATE patrol_exceptions SET type = $1 WHERE id = $2`, [t, x1.id]);
      await assert.rejects(() => q(`UPDATE patrol_exceptions SET type = 'patrol_abandoned' WHERE id = $1`, [x1.id]), /CHK_patrol_exceptions_type/);
      await assert.rejects(() => q(`UPDATE patrol_exceptions SET type = 'other' WHERE id = $1`, [x1.id]), /CHK_patrol_exceptions_type/);
      for (const s of PATROL_EXCEPTION_STATUSES.filter((s) => s !== 'resolved')) await q(`UPDATE patrol_exceptions SET status = $1 WHERE id = $2`, [s, x1.id]);
      await q(`UPDATE patrol_exceptions SET status = 'resolved', "resolvedAt" = now() WHERE id = $1`, [x1.id]);
      await assert.rejects(() => q(`UPDATE patrol_exceptions SET status = 'closed', "resolvedAt" = NULL WHERE id = $1`, [x1.id]), /CHK_patrol_exceptions_status/);
      await assert.rejects(() => q(`UPDATE patrol_exceptions SET "resolvedAt" = NULL WHERE id = $1`, [x1.id]), /CHK_patrol_exceptions_resolved/);

      const hold = { companyId: String(coA), scope: `'run'`, runId: String(r.id), reason: `'Incident 4'`, source: `'incident'` };
      await insert('patrol_evidence_holds', hold);
      for (const s of PATROL_HOLD_SOURCES.filter((s) => s !== 'manual')) await insert('patrol_evidence_holds', hold, { source: `'${s}'` });
      await assert.rejects(() => insert('patrol_evidence_holds', hold, { source: `'manual'` }), /CHK_patrol_evidence_holds_manual_creator/, 'a manual hold names its creator');
      for (const s of PATROL_HOLD_SCOPES) {
        // Each scope names its own target (the run is in `hold` already).
        if (s === 'site_date_range') await insert('patrol_evidence_holds', hold, { scope: `'${s}'`, siteId: String(siteA1), fromDate: `'2026-10-01'`, toDate: `'2026-10-02'` });
        else await insert('patrol_evidence_holds', hold, { scope: `'${s}'`, evidenceId: String(e.id), shiftId: String(shiftA) });
      }
      await assert.rejects(() => insert('patrol_evidence_holds', hold, { scope: `'site_date_range'`, siteId: String(siteA1), fromDate: `'2026-10-02'`, toDate: `'2026-10-01'` }),
        /CHK_patrol_evidence_holds_target/, 'a date range runs forwards');
      await assert.rejects(() => insert('patrol_evidence_holds', hold, { scope: `'shift'` }), /CHK_patrol_evidence_holds_target/);
      await assert.rejects(() => insert('patrol_evidence_holds', hold, { scope: `'forever'` }), /CHK_patrol_evidence_holds_scope/);
      await cleanup();
    });

    await test('M68-06-THE-DATABASE-REFUSES-CROSS-TENANT-AND-CROSS-SITE-LINKS', async () => {
      const cpA1 = await checkpoint(coA, siteA1);
      const cpA2 = await checkpoint(coA, siteA2);
      const cpB1 = await checkpoint(coB, siteB1);
      const [route] = await q(`INSERT INTO patrol_routes ("companyId","siteId",name) VALUES ($1,$2,'Perimeter') RETURNING id`, [coA, siteA1]);
      const link = (cp: number, pos: number, co = coA, s = siteA1) =>
        q(`INSERT INTO patrol_route_checkpoints ("companyId","siteId","routeId","checkpointId",position) VALUES ($1,$2,$3,$4,$5)`, [co, s, route.id, cp, pos]);
      await link(cpA1.id, 1);
      await assert.rejects(() => link(cpA2.id, 2), /FK_patrol_route_checkpoints_checkpoint/, 'another site\'s checkpoint');
      await assert.rejects(() => link(cpA2.id, 2, coA, siteA2), /FK_patrol_route_checkpoints_route/, 'a route of another site');
      await assert.rejects(() => link(cpB1.id, 2, coB, siteB1), /FK_patrol_route_checkpoints_route/, 'another company');
      await assert.rejects(() => link(cpA1.id, 2), /UQ_patrol_route_checkpoints_checkpoint/, 'once per route');
      await assert.rejects(() => q(`INSERT INTO patrol_schedules ("companyId","siteId","routeId",name,"activeFrom","activeTo","frequencyMinutes","windowMinutes")
          VALUES ($1,$2,$3,'x','08:00','18:00',60,60)`, [coA, siteA2, route.id]), /FK_patrol_schedules_route/, 'a schedule cannot use another site\'s route');
      const rA = await run(coA, siteA1, shiftA);
      await assert.rejects(() => visit(coB, rA.id), /FK_patrol_checkpoint_visits_run/, 'a scan in another company\'s run');
      await assert.rejects(() => visit(coA, rA.id, { checkpointId: String(cpB1.id) }), /FK_patrol_checkpoint_visits_checkpoint/, 'another company\'s checkpoint');
      await assert.rejects(() => evidence(coB, siteB1, rA.id, shiftB), /FK_patrol_evidence_run/, 'evidence on another company\'s run');
      await assert.rejects(() => run(coA, siteA1, shiftA, { routeId: String(route.id), siteId: String(siteA2), status: `'completed'`, completedAtServer: 'now()' }),
        /FK_patrol_runs_route/, 'a run cannot follow another site\'s route');
      await run(coB, siteB1, shiftB);
      await assert.rejects(() => q(`DELETE FROM shifts WHERE id = $1`, [shiftB]), /FK_patrol_runs_shift/, 'a shift with a patrol run is never deleted from under it');
      await cleanup();
    });

    await test('M68-07-IDEMPOTENCY-KEYS-AND-ONE-OPEN-RUN', async () => {
      const r = await run(coA, siteA1, shiftA, { clientRunId: `'same-client-id-1'` });
      await assert.rejects(() => run(coA, siteA1, shiftA, { clientRunId: `'same-client-id-1'`, status: `'completed'`, completedAtServer: 'now()' }), /UQ_patrol_runs_client_run_id/);
      await run(coB, siteB1, shiftB, { clientRunId: `'same-client-id-1'` });
      await assert.rejects(() => run(coA, siteA1, shiftA), /UQ_patrol_runs_one_open_per_guard_shift/, 'one open run per Guard per shift');
      await run(coA, siteA1, shiftA, { status: `'completed'`, completedAtServer: 'now()' });
      await visit(coA, r.id, { clientVisitId: `'same-visit-id-1'` });
      await assert.rejects(() => visit(coA, r.id, { clientVisitId: `'same-visit-id-1'` }), /UQ_patrol_checkpoint_visits_client_visit_id/);
      await evidence(coA, siteA1, r.id, shiftA, { clientEvidenceId: `'same-evid-id-1'`, storageKey: `'patrol/1/a.jpg'` });
      await assert.rejects(() => evidence(coA, siteA1, r.id, shiftA, { clientEvidenceId: `'same-evid-id-1'` }), /UQ_patrol_evidence_client_evidence_id/);
      await assert.rejects(() => evidence(coA, siteA1, r.id, shiftA, { storageKey: `'patrol/1/a.jpg'` }), /UQ_patrol_evidence_storage_key/);
      const exc = { companyId: String(coA), siteId: String(siteA1), windowKey: `'s1:2026-10-28:4'`, type: `'patrol_missed'` };
      const x = await insert('patrol_exceptions', exc);
      await assert.rejects(() => insert('patrol_exceptions', exc), /UQ_patrol_exceptions_open_window_type/, 'one open exception per window and type');
      await q(`UPDATE patrol_exceptions SET status = 'resolved', "resolvedAt" = now() WHERE id = $1`, [x.id]);
      await insert('patrol_exceptions', exc);
    });

    await test('M68-08-DOWN-REFUSES-WHILE-PATROL-RECORDS-EXIST-AND-CHANGES-NOTHING', async () => {
      const snapshot = await hashAll((sql) => q(sql));
      const patrolRows = async () => Promise.all(PATROL_TABLES.map((t) => scalar(`SELECT count(*)::int FROM "${t}"`)));
      const rowsBefore = await patrolRows();
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /Refusing to revert AddPatrolManagement1720900000014: .*patrol_runs/);
      assert.equal(await migrationCount(), 68);
      assert.deepEqual(await hashAll((sql) => q(sql)), snapshot);
      assert.deepEqual(await patrolRows(), rowsBefore, 'the patrol records are untouched');
      // Each kind of record blocks on its own.
      await cleanup();
      const r = await run(coA, siteA1, shiftA);
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /1 patrol_runs exist/);
      await evidence(coA, siteA1, r.id, shiftA);
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /1 patrol_evidence/);
      await cleanup();
      await insert('patrol_evidence_holds', { companyId: String(coA), scope: `'shift'`, shiftId: String(shiftA), reason: `'Claim'`, source: `'incident'` });
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /1 patrol_evidence_holds exist/);
      await cleanup();
      await insert('patrol_exceptions', { companyId: String(coA), siteId: String(siteA1), windowKey: `'w'`, type: `'patrol_missed'` });
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /1 patrol_exceptions exist/);
      await cleanup();
      assert.equal(await migrationCount(), 68);
    });

    await test('M68-09-DOWN-REMOVES-EXACTLY-WHAT-68-ADDED-AND-REAPPLY-RESTORES-IT', async () => {
      // Configuration alone (not evidence) does not block.
      await q(`INSERT INTO patrol_policies ("companyId") VALUES ($1)`, [coA]);
      await q(`UPDATE companies SET "patrolsEnabled" = true WHERE id = $1`, [coA]);
      const rowsBefore = await hashAll((sql) => q(sql));
      await ds.undoLastMigration({ transaction: 'each' });
      assert.equal(await migrationCount(), 67);
      const back = await schema();
      assert.deepEqual(back, at67Schema, 'back to the 67 schema');
      assert.deepEqual(await hashAll((sql) => q(sql)), rowsBefore, 'existing rows survive the round trip');
      await ds.runMigrations({ transaction: 'each' });
      assert.deepEqual(await schema(), head);
      assert.deepEqual((await q(`SELECT "patrolsEnabled" FROM companies ORDER BY id`)).map((r: any) => r.patrolsEnabled), [false, false], 'off again after re-apply');
    });

    await test('M68-10-NO-SEMANTIC-DRIFT-AND-NO-COLUMN-DRIFT-ON-PATROL-TABLES', async () => {
      const drift = (await ds.driver.createSchemaBuilder().log()).upQueries.map((x) => x.query);
      // This database stops at 68, so Migration 69's labels, columns and indexes are absent by design; they are set aside
      // statement by statement (m69-migration.spec.ts M69-09 certifies them). Nothing else is.
      const m69 = /safety_alerts_type_enum|^ALTER TABLE "safety_alerts" ALTER COLUMN "type" |^ALTER TABLE "safety_alerts" ADD "patrol(ExceptionId|RunId|WindowKey|LateSyncAt|Annotation)" |^ALTER TABLE "patrol_(policies|runs|checkpoint_visits|exceptions)" ADD "(postShiftSyncHours|clockDriftThresholdMinutes|allowUnscheduledPatrols|escalateUnverified|lateStart|provisional|needsReview|syncFlags|clockDriftMs|verificationFinalAt|syncedLate|guardId|windowStart|windowEnd|acknowledgedAt|acknowledgedByUserId|lateEvidenceAt|annotations)" |^CREATE (UNIQUE )?INDEX "(uq_safety_alerts_patrol_exception|IDX_patrol_runs_open|IDX_patrol_exceptions_window_type)" /;
      // …and Migration 70's eleven patrol_evidence columns, its two tables (evidence exports, live storage usage) and their
      // indexes, statement by statement (m70-migration.spec.ts M70-09 certifies that its entities and migration agree).
      const m70 = /^CREATE TABLE "patrol_(evidence_exports|storage_usage)" |^ALTER TABLE "patrol_evidence" ADD "(declaredSizeBytes|detectedMimeType|uploadUrlIssuedAt|completionToken|completionStartedAt|syncFlags|needsReview|purgeAfter|primaryDeletedAt|objectDeletedAt|deletionRequestedByUserId)" |^CREATE (UNIQUE )?INDEX "(IDX_patrol_evidence_(lifecycle|pending_upload|exports_company|exports_open)|UQ_patrol_evidence_exports_storage_key|UQ_patrol_storage_usage_(site|company))" |^ALTER TABLE "patrol_(evidence_exports|storage_usage)" /;
      const semantic = drift.filter((x) => !m69.test(x) && !m70.test(x) &&
        /CREATE TABLE|DROP TABLE|CREATE TYPE|DROP TYPE|ALTER TYPE|ALTER TABLE.*ALTER COLUMN|ALTER TABLE.*DROP COLUMN|ALTER TABLE.*ADD "/i.test(x));
      assert.deepEqual(semantic, [], `semantic drift (the release gate would fail):\n${semantic.join('\n')}`);
      const ours = drift.filter((x) => /"patrol_|patrolsEnabled/.test(x) && !m69.test(x) && !m70.test(x));
      // Foreign keys (most are composite, which TypeORM cannot declare) and CHECKs live in the migration only, as for
      // several existing tables; every column, unique key and index agrees.
      const unexpected = ours.filter((x) => !/^ALTER TABLE "patrol_[a-z_]+" DROP CONSTRAINT "(FK|CHK)_patrol_/.test(x));
      assert.deepEqual(unexpected, [], `patrol entity and migration 68 disagree:\n${unexpected.join('\n')}`);
      console.log(`      (diagnostic-only drift: ${drift.length} statement(s), of which ${ours.length} are patrol FK / CHECK names)`);
    });

    await test('M68-11-ROLLBACK-COMPATIBLE-WITH-THE-PREVIOUS-RELEASE', async () => {
      const previous = new DataSource({
        type: 'postgres', url, entities: [], synchronize: false, migrations: through67, migrationsTableName: 'typeorm_migrations', logging: false,
      });
      await previous.initialize();
      try {
        assert.equal((await previous.runMigrations({ transaction: 'each' })).length, 0, "the previous release's pre-deploy run is a no-op");
        const owner = (await previous.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m68.prev@example.invalid','x','company_admin','active') RETURNING id`))[0].id;
        const [c] = await previous.query(
          `INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","autoCreatePayrollBatch","autoCreateInvoiceBatch","autoFinalisePayrollBatch","autoIssueInvoiceBatch",status)
           VALUES ($1,'Prev Ltd','1','a','b',false,false,false,false,'onboarding') RETURNING id, "patrolsEnabled"`, [owner]);
        assert.equal(c.patrolsEnabled, false, 'a company created by the previous release is off');
        const [s] = await previous.query(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'P','a') RETURNING id`, [c.id]);
        await previous.query(`INSERT INTO shifts ("companyId","siteId","siteName",status,start,"end") VALUES ($1,$2,'P','unfilled',now(),now() + interval '1 hour')`, [c.id, s.id]);
      } finally {
        await previous.destroy();
      }
    });
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  console.log(JSON.stringify({ event: 'm68_migration_certified', tests: passed }));
  if (failures.length) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
