/**
 * Migration 69 (AddPatrolScheduling1720900000015) certification, on a disposable database built from the repository's
 * own migrations.
 *
 *   M69-01  a database at 68 migrates to 69 and 69 is the last migration
 *   M69-02  the schema it adds and nothing else: five safety_alerts_type_enum labels (appended), five safety_alerts
 *           columns, four patrol_policies / six patrol_runs / three patrol_checkpoint_visits / seven patrol_exceptions
 *           columns, four foreign keys, four CHECKs, the widened exception-type CHECK and three indexes; every new time
 *           is timestamptz; no other table, column, constraint, index or enum changes
 *   M69-03  every existing row keeps its values (P1-A patrol rows and alerts included); new columns take their defaults
 *   M69-04  a second run applies nothing; re-running up() directly changes nothing
 *   M69-05  defaults are PATROL_POLICY_DEFAULTS' P1-B values and the CHECKs hold them (1–72 h, 1–120 min, arrays only);
 *           'patrol_abandoned' becomes a valid exception type; the five alert labels are usable
 *   M69-06  one alert per patrol exception (uq_safety_alerts_patrol_exception + ON CONFLICT DO NOTHING); the links refuse
 *           an unknown exception or run
 *   M69-07  down() refuses while any patrol alert, abandoned-patrol exception or late-sync / review record exists, and
 *           changes nothing
 *   M69-08  down() with none removes exactly what 69 added (the enum labels are kept, as Migrations 58, 59 and 63 do);
 *           re-applying restores the identical schema
 *   M69-09  no semantic entity-to-migration drift at 69 and no column drift on the patrol tables or safety_alerts
 *   M69-10  rollback compatibility: the previous release's pre-deploy run (through 68) is a no-op on a 69 database and
 *           P1-A-shaped writes (which never name a new column) still succeed
 *
 * Needs M69_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';
import { PATROL_POLICY_DEFAULTS } from '../src/patrol/patrol-constants';

const url = process.env.M69_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M69_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('M69 database must be local');

const MIGRATION_68 = 'AddPatrolManagement1720900000014';
const MIGRATION_69 = 'AddPatrolScheduling1720900000015';
const NEW_LABELS = ['patrol_missed', 'patrol_abandoned', 'patrol_incomplete', 'checkpoint_missed', 'patrol_unverified'];
const NEW_COLUMNS: Record<string, string[]> = {
  safety_alerts: ['patrolAnnotation', 'patrolExceptionId', 'patrolLateSyncAt', 'patrolRunId', 'patrolWindowKey'],
  patrol_policies: ['allowUnscheduledPatrols', 'clockDriftThresholdMinutes', 'escalateUnverified', 'postShiftSyncHours'],
  patrol_runs: ['clockDriftMs', 'lateStart', 'needsReview', 'provisional', 'syncFlags', 'verificationFinalAt'],
  patrol_checkpoint_visits: ['clockDriftMs', 'syncFlags', 'syncedLate'],
  patrol_exceptions: ['acknowledgedAt', 'acknowledgedByUserId', 'annotations', 'guardId', 'lateEvidenceAt', 'windowEnd', 'windowStart'],
};
const NEW_CONSTRAINTS = [
  'CHK_patrol_checkpoint_visits_sync_flags', 'CHK_patrol_exceptions_annotations', 'CHK_patrol_policies_sync', 'CHK_patrol_runs_sync_flags',
  'FK_patrol_exceptions_acknowledged_by', 'FK_patrol_exceptions_guard', 'FK_safety_alerts_patrol_exception', 'FK_safety_alerts_patrol_run',
];
const NEW_INDEXES = ['IDX_patrol_exceptions_window_type', 'IDX_patrol_runs_open', 'uq_safety_alerts_patrol_exception'];
const isNewColumn = (c: any) => (NEW_COLUMNS[c.table_name] ?? []).includes(c.column_name);

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
  const through68 = allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000014).map((f) => path.join(migrationsDir, f));
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: false,
    migrations: allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000015).map((f) => path.join(migrationsDir, f)),
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
  /** The head schema without what 69 adds (the exception-type CHECK compared separately). */
  const without69 = (s: Awaited<ReturnType<typeof schema>>, keepLabels = false) => ({
    tables: s.tables,
    columns: s.columns.filter((c: any) => !isNewColumn(c)),
    // PostgreSQL 18 also lists a new column's NOT NULL as a constraint ("<table>_<column>_not_null").
    constraints: s.constraints.filter((c: any) => !NEW_CONSTRAINTS.includes(c.conname) && c.conname !== 'CHK_patrol_exceptions_type'
      && !(NEW_COLUMNS[c.tbl] ?? []).some((col) => c.def === `NOT NULL "${col}"` || c.def === `NOT NULL ${col}`)),
    indexes: s.indexes.filter((i: any) => !NEW_INDEXES.includes(i.indexname)),
    enums: keepLabels ? s.enums : s.enums.filter((e: any) => !(e.typname === 'safety_alerts_type_enum' && NEW_LABELS.includes(e.enumlabel))),
  });
  const hashAll = async (run: (sql: string) => Promise<any[]>) => {
    const tables = (await run(`SELECT tablename t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.t as string)
      .filter((t) => t !== 'typeorm_migrations');
    const out: Record<string, string[]> = {};
    for (const t of tables) {
      const drop = (NEW_COLUMNS[t] ?? []).map((c) => ` - '${c}'`).join('');
      out[t] = (await run(`SELECT md5((to_jsonb(x)${drop})::text) h FROM "${t}" x ORDER BY 1`)).map((r) => r.h);
    }
    return out;
  };

  try {
    // ── to 68, seed production-shaped rows (P1-A patrol data and existing alerts) ───────────────────────
    const at68 = new DataSource({
      type: 'postgres', url, entities: [], synchronize: false, migrations: through68, migrationsTableName: 'typeorm_migrations', logging: false,
    });
    await at68.initialize();
    await at68.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const applied68 = await at68.runMigrations({ transaction: 'each' });
    assert.equal(applied68[applied68.length - 1].name, MIGRATION_68);
    const one = async (sql: string, params: unknown[] = []) => (await at68.query(sql, params))[0];
    const ownerId = (await one(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m69.o@example.invalid','x','company_admin','active') RETURNING id`)).id;
    const coA = (await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,'M69 A','69696969','1 Way','o@example.invalid',true) RETURNING id`, [ownerId])).id;
    const siteA = (await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'A1','2 Way') RETURNING id`, [coA])).id;
    const gu = (await one(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m69.g@example.invalid','x','guard','active') RETURNING id`)).id;
    const guard = (await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'M69 Guard','1000000000000069','07000000069') RETURNING id`, [gu])).id;
    const shiftA = (await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'x',$3,'in_progress',now() - interval '1 hour',now() + interval '7 hours') RETURNING id`,
      [coA, siteA, guard])).id;
    await at68.query(`INSERT INTO patrol_policies ("companyId") VALUES ($1)`, [coA]);
    const schedule = (await one(`INSERT INTO patrol_schedules ("companyId","siteId",name,"activeFrom","activeTo","frequencyMinutes","windowMinutes") VALUES ($1,$2,'Hourly','00:00','00:00',60,60) RETURNING id`, [coA, siteA])).id;
    const run = (await one(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","scheduleId","startedAtDevice","clientRunId")
      VALUES ($1,$2,$3,$4,$5,$6,now(),'m69-run-0001') RETURNING id`, [coA, siteA, shiftA, guard, gu, schedule])).id;
    await at68.query(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","scannedPublicId","result","scannedAtDevice","clientVisitId")
      VALUES ($1,$2,$3,'unverified',now(),'m69-visit-0001')`, [coA, run, 'a'.repeat(32)]);
    await at68.query(`INSERT INTO patrol_exceptions ("companyId","siteId","runId","windowKey","type") VALUES ($1,$2,$3,'s1:2026-10-28:1','patrol_incomplete')`, [coA, siteA, run]);
    await at68.query(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status) VALUES ($1,$2,$3,'panic','critical','SOS','acknowledged'),
      ($1,$2,$3,'missed_checkcall','high','Welfare missed','open')`, [coA, guard, shiftA]);
    const before = await hashAll((sql) => at68.query(sql));
    const at68Schema = await schemaOf((sql) => at68.query(sql));
    await at68.destroy();

    await ds.initialize();
    const applied = await ds.runMigrations({ transaction: 'each' });

    await test('M69-01-A-68-DATABASE-MIGRATES-TO-69-AND-69-IS-LAST', () => {
      assert.deepEqual(applied.map((m) => m.name), [MIGRATION_69], 'only 69 is pending on a 68 database');
      assert.equal(allFiles.length, 72);
      assert.equal(allFiles[68], '1720900000015-AddPatrolScheduling.ts');
      assert.equal(allFiles[69], '1720900000016-AddPatrolEvidenceStorage.ts', 'Migration 70 follows 69 and is certified by m70-migration.spec.ts');
      assert.equal(allFiles[70], '1720900000017-AddPatrolSweepReconciliation.ts', 'Migration 71 follows 70 and is certified by m71-migration.spec.ts');
      assert.equal(allFiles[71], '1720900000018-AddPatrolSyncRecoveryGrants.ts', 'Migration 72 follows 71 and is certified by m72-migration.spec.ts');
    });
    const head = await schema();

    await test('M69-02-THE-SCHEMA-IT-ADDS-AND-NOTHING-ELSE', async () => {
      assert.deepEqual(head.tables, at68Schema.tables, 'no table added or removed');
      for (const [table, cols] of Object.entries(NEW_COLUMNS)) {
        assert.deepEqual(head.columns.filter((c: any) => c.table_name === table && cols.includes(c.column_name)).map((c: any) => c.column_name).sort(), [...cols].sort(), table);
      }
      const col = (t: string, c: string) => head.columns.find((x: any) => x.table_name === t && x.column_name === c);
      for (const [t, c] of [['safety_alerts', 'patrolLateSyncAt'], ['patrol_runs', 'verificationFinalAt'], ['patrol_exceptions', 'windowStart'], ['patrol_exceptions', 'windowEnd'],
        ['patrol_exceptions', 'acknowledgedAt'], ['patrol_exceptions', 'lateEvidenceAt']]) {
        assert.equal(col(t, c).data_type, 'timestamp with time zone', `${t}.${c} is timestamptz`);
      }
      for (const [t, c] of [['safety_alerts', 'patrolExceptionId'], ['safety_alerts', 'patrolRunId'], ['patrol_runs', 'clockDriftMs'], ['patrol_exceptions', 'guardId']]) {
        assert.equal(col(t, c).is_nullable, 'YES', `${t}.${c} nullable`);
      }
      assert.equal(col('patrol_runs', 'syncFlags').column_default, `'[]'::jsonb`);
      const [now69, was68] = [without69(head), without69(at68Schema)];
      for (const key of Object.keys(now69) as Array<keyof typeof now69>) {
        const added = (now69[key] as any[]).filter((x) => !(was68[key] as any[]).some((y) => JSON.stringify(y) === JSON.stringify(x)));
        const removed = (was68[key] as any[]).filter((x) => !(now69[key] as any[]).some((y) => JSON.stringify(y) === JSON.stringify(x)));
        assert.deepEqual({ added, removed }, { added: [], removed: [] }, `every other ${key} is unchanged: ${JSON.stringify({ added, removed })}`);
      }
      assert.deepEqual(head.constraints.filter((c: any) => NEW_CONSTRAINTS.includes(c.conname)).map((c: any) => c.conname).sort(), [...NEW_CONSTRAINTS].sort());
      assert.deepEqual(head.indexes.filter((i: any) => NEW_INDEXES.includes(i.indexname)).map((i: any) => i.indexname).sort(), [...NEW_INDEXES].sort());
      const typeCheck = (s: any) => s.constraints.find((c: any) => c.conname === 'CHK_patrol_exceptions_type').def;
      assert.match(typeCheck(head), /patrol_abandoned/);
      assert.doesNotMatch(typeCheck(at68Schema), /patrol_abandoned/);
      const labels = head.enums.filter((e: any) => e.typname === 'safety_alerts_type_enum').map((e: any) => e.enumlabel);
      assert.deepEqual(labels.slice(-5), NEW_LABELS, 'the five labels are appended in order');
      assert.deepEqual(labels.slice(0, -5), at68Schema.enums.filter((e: any) => e.typname === 'safety_alerts_type_enum').map((e: any) => e.enumlabel));
      assert.match(head.indexes.find((i: any) => i.indexname === 'uq_safety_alerts_patrol_exception').indexdef,
        /CREATE UNIQUE INDEX uq_safety_alerts_patrol_exception ON public\.safety_alerts USING btree \("patrolExceptionId"\) WHERE \("patrolExceptionId" IS NOT NULL\)/);
    });

    await test('M69-03-EVERY-EXISTING-ROW-KEEPS-ITS-VALUES-AND-NEW-COLUMNS-TAKE-DEFAULTS', async () => {
      assert.deepEqual(await hashAll((sql) => q(sql)), before);
      const [r] = await q(`SELECT "lateStart", provisional, "needsReview", "syncFlags", "clockDriftMs", "verificationFinalAt" FROM patrol_runs`);
      assert.deepEqual(r, { lateStart: false, provisional: false, needsReview: false, syncFlags: [], clockDriftMs: null, verificationFinalAt: null });
      const [v] = await q(`SELECT "syncedLate", "syncFlags", "clockDriftMs" FROM patrol_checkpoint_visits`);
      assert.deepEqual(v, { syncedLate: false, syncFlags: [], clockDriftMs: null });
      const [e] = await q(`SELECT annotations, "lateEvidenceAt", "guardId" FROM patrol_exceptions`);
      assert.deepEqual(e, { annotations: [], lateEvidenceAt: null, guardId: null });
      assert.deepEqual((await q(`SELECT "patrolExceptionId", "patrolRunId", "patrolLateSyncAt" FROM safety_alerts ORDER BY id`)),
        [{ patrolExceptionId: null, patrolRunId: null, patrolLateSyncAt: null }, { patrolExceptionId: null, patrolRunId: null, patrolLateSyncAt: null }]);
    });

    await test('M69-04-A-SECOND-RUN-APPLIES-NOTHING-AND-UP-IS-REPEATABLE', async () => {
      assert.equal((await ds.runMigrations({ transaction: 'each' })).length, 0);
      const { AddPatrolScheduling1720900000015 } = await import('../src/database/migrations/1720900000015-AddPatrolScheduling');
      const runner = ds.createQueryRunner();
      try {
        await new AddPatrolScheduling1720900000015().up(runner);
      } finally {
        await runner.release();
      }
      assert.deepEqual(await schema(), head);
      assert.equal(await migrationCount(), 69);
    });

    await test('M69-05-DEFAULTS-CHECKS-AND-THE-NEW-VOCABULARY', async () => {
      const [p] = await q(`SELECT "postShiftSyncHours", "clockDriftThresholdMinutes", "allowUnscheduledPatrols", "escalateUnverified" FROM patrol_policies`);
      const d = PATROL_POLICY_DEFAULTS;
      assert.deepEqual(p, { postShiftSyncHours: d.postShiftSyncHours, clockDriftThresholdMinutes: d.clockDriftThresholdMinutes,
        allowUnscheduledPatrols: d.allowUnscheduledPatrols, escalateUnverified: d.escalateUnverified });
      assert.deepEqual([d.postShiftSyncHours, d.clockDriftThresholdMinutes], [24, 5], 'owner requirement: 24 h post-shift acceptance, 5 min drift');
      await assert.rejects(() => q(`UPDATE patrol_policies SET "postShiftSyncHours" = 0`), /CHK_patrol_policies_sync/);
      await assert.rejects(() => q(`UPDATE patrol_policies SET "postShiftSyncHours" = 73`), /CHK_patrol_policies_sync/);
      await assert.rejects(() => q(`UPDATE patrol_policies SET "clockDriftThresholdMinutes" = 121`), /CHK_patrol_policies_sync/);
      await q(`UPDATE patrol_policies SET "postShiftSyncHours" = 72, "clockDriftThresholdMinutes" = 1`);
      await q(`UPDATE patrol_policies SET "postShiftSyncHours" = 24, "clockDriftThresholdMinutes" = 5`);
      await assert.rejects(() => q(`UPDATE patrol_runs SET "syncFlags" = '{}'::jsonb`), /CHK_patrol_runs_sync_flags/);
      await assert.rejects(() => q(`UPDATE patrol_checkpoint_visits SET "syncFlags" = '"x"'::jsonb`), /CHK_patrol_checkpoint_visits_sync_flags/);
      await assert.rejects(() => q(`UPDATE patrol_exceptions SET annotations = '{}'::jsonb`), /CHK_patrol_exceptions_annotations/);
      const [x] = await q(`INSERT INTO patrol_exceptions ("companyId","siteId","windowKey","type") VALUES ($1,$2,'s1:2026-10-28:9','patrol_abandoned') RETURNING id`, [coA, siteA]);
      await assert.rejects(() => q(`UPDATE patrol_exceptions SET type = 'other' WHERE id = $1`, [x.id]), /CHK_patrol_exceptions_type/);
      for (const label of NEW_LABELS) {
        const [a] = await q(`INSERT INTO safety_alerts ("companyId",type,message) VALUES ($1,$2,'probe') RETURNING id`, [coA, label]);
        await q(`DELETE FROM safety_alerts WHERE id = $1`, [a.id]);
      }
      await q(`DELETE FROM patrol_exceptions WHERE id = $1`, [x.id]);
    });

    await test('M69-06-ONE-ALERT-PER-PATROL-EXCEPTION-AND-THE-LINKS-HOLD', async () => {
      const [x] = await q(`INSERT INTO patrol_exceptions ("companyId","siteId","windowKey","type") VALUES ($1,$2,'s1:2026-10-28:5','patrol_missed') RETURNING id`, [coA, siteA]);
      const insertAlert = () => q(`INSERT INTO safety_alerts ("companyId",type,message,"patrolExceptionId","patrolRunId") VALUES ($1,'patrol_missed','m',$2,$3)
        ON CONFLICT DO NOTHING RETURNING id`, [coA, x.id, run]);
      const results = await Promise.all([insertAlert(), insertAlert(), insertAlert()]);
      assert.equal(results.filter((r) => r.length === 1).length, 1, 'exactly one row inserted');
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM safety_alerts WHERE "patrolExceptionId" = $1`, [x.id])), 1);
      await assert.rejects(() => q(`INSERT INTO safety_alerts ("companyId",type,message,"patrolExceptionId") VALUES ($1,'patrol_missed','m',999999)`, [coA]), /FK_safety_alerts_patrol_exception/);
      await assert.rejects(() => q(`INSERT INTO safety_alerts ("companyId",type,message,"patrolRunId") VALUES ($1,'patrol_missed','m',999999)`, [coA]), /FK_safety_alerts_patrol_run/);
      await assert.rejects(() => q(`UPDATE patrol_exceptions SET "guardId" = 999999 WHERE id = $1`, [x.id]), /FK_patrol_exceptions_guard/);
      await q(`DELETE FROM safety_alerts WHERE "patrolExceptionId" = $1`, [x.id]);
      await q(`DELETE FROM patrol_exceptions WHERE id = $1`, [x.id]);
    });

    await test('M69-07-DOWN-REFUSES-WHILE-PATROL-ALERTS-OR-LATE-SYNC-RECORDS-EXIST', async () => {
      const snapshot = await hashAll((sql) => q(sql));
      const [x] = await q(`INSERT INTO patrol_exceptions ("companyId","siteId","windowKey","type") VALUES ($1,$2,'s1:2026-10-28:6','patrol_missed') RETURNING id`, [coA, siteA]);
      const [a] = await q(`INSERT INTO safety_alerts ("companyId",type,message,"patrolExceptionId") VALUES ($1,'patrol_missed','m',$2) RETURNING id`, [coA, x.id]);
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /Refusing to revert AddPatrolScheduling1720900000015: 1 patrol alert/);
      assert.equal(await migrationCount(), 69);
      assert.deepEqual(await schema(), head, 'nothing changed');
      await q(`DELETE FROM safety_alerts WHERE id = $1`, [a.id]);
      await q(`UPDATE patrol_exceptions SET type = 'patrol_abandoned' WHERE id = $1`, [x.id]);
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /1 abandoned-patrol exception/);
      await q(`DELETE FROM patrol_exceptions WHERE id = $1`, [x.id]);
      await q(`UPDATE patrol_runs SET "syncFlags" = '["post_shift_creation"]', provisional = true`);
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /late-sync or review data/);
      await q(`UPDATE patrol_runs SET "syncFlags" = '[]', provisional = false`);
      assert.equal(await migrationCount(), 69);
      assert.deepEqual(await hashAll((sql) => q(sql)), snapshot);
    });

    await test('M69-08-DOWN-REMOVES-EXACTLY-WHAT-69-ADDED-AND-RE-APPLY-RESTORES-IT', async () => {
      const rows = await hashAll((sql) => q(sql));
      await ds.undoLastMigration({ transaction: 'each' });
      assert.equal(await migrationCount(), 68);
      const back = await schema();
      assert.deepEqual(without69(back, true), { ...without69(at68Schema, true), enums: back.enums }, 'back to the 68 schema');
      assert.deepEqual(back.constraints.find((c: any) => c.conname === 'CHK_patrol_exceptions_type'),
        at68Schema.constraints.find((c: any) => c.conname === 'CHK_patrol_exceptions_type'), 'the exception-type CHECK is M68\'s again');
      assert.deepEqual(back.columns, at68Schema.columns);
      assert.deepEqual(back.constraints, at68Schema.constraints);
      assert.deepEqual(back.indexes, at68Schema.indexes);
      assert.deepEqual(back.enums, head.enums, 'the enum labels are kept (PostgreSQL cannot drop one); no row uses them');
      assert.deepEqual(await hashAll((sql) => q(sql)), rows, 'existing rows survive the round trip');
      await ds.runMigrations({ transaction: 'each' });
      assert.deepEqual(await schema(), head);
    });

    await test('M69-09-NO-SEMANTIC-DRIFT-AND-NO-COLUMN-DRIFT-ON-PATROL-OR-ALERT-COLUMNS', async () => {
      const drift = (await ds.driver.createSchemaBuilder().log()).upQueries.map((x) => x.query);
      // This database stops at 69, so Migration 70's eleven patrol_evidence columns, its two tables and their indexes are
      // absent by design; they are set aside statement by statement (m70-migration.spec.ts M70-09 certifies them).
      const m70 = /^CREATE TABLE "patrol_(evidence_exports|storage_usage)" |^ALTER TABLE "patrol_evidence" ADD "(declaredSizeBytes|detectedMimeType|uploadUrlIssuedAt|completionToken|completionStartedAt|syncFlags|needsReview|purgeAfter|primaryDeletedAt|objectDeletedAt|deletionRequestedByUserId)" |^CREATE (UNIQUE )?INDEX "(IDX_patrol_evidence_(lifecycle|pending_upload|exports_company|exports_open)|UQ_patrol_evidence_exports_storage_key|UQ_patrol_storage_usage_(site|company))" |^ALTER TABLE "patrol_(evidence_exports|storage_usage)" /;
      // …and Migration 71's two tables (sweep watermarks, reconciliation runs), its patrol_exceptions / safety_alerts columns
      // and their indexes, statement by statement (m71-migration.spec.ts M71-09 certifies that its entities and migration agree).
      const m71 = /^CREATE TABLE "patrol_(sweep_watermarks|reconciliation_runs)" |^ALTER TABLE "patrol_exceptions" ADD "reconciliationRunId" |^ALTER TABLE "safety_alerts" ADD "patrolReconciliationRunId" |^CREATE (UNIQUE )?INDEX "(IDX_patrol_exceptions_reconciliation|uq_safety_alerts_patrol_reconciliation|UQ_patrol_reconciliation_runs_running|IDX_patrol_reconciliation_runs_company)" |^ALTER TABLE "patrol_(sweep_watermarks|reconciliation_runs)" /;
      // …and Migration 72's recovery grant table and its indexes (m72-migration.spec.ts M72-09 certifies them).
      const m72 = /^CREATE TABLE "patrol_sync_recovery_grants" |^CREATE INDEX "IDX_patrol_sync_recovery_grants_(active|company)" |^ALTER TABLE "patrol_sync_recovery_grants" /;
      const semantic = drift.filter((x) => !m70.test(x) && !m71.test(x) && !m72.test(x) &&
        /CREATE TABLE|DROP TABLE|CREATE TYPE|DROP TYPE|ALTER TYPE|ALTER TABLE.*ALTER COLUMN|ALTER TABLE.*DROP COLUMN|ALTER TABLE.*ADD "/i.test(x));
      assert.deepEqual(semantic, [], `semantic drift (the release gate would fail):\n${semantic.join('\n')}`);
      const ours = drift.filter((x) => /"patrol_|patrolsEnabled|patrol(ExceptionId|RunId|WindowKey|LateSyncAt|Annotation)|uq_safety_alerts_patrol_exception/.test(x) && !m70.test(x) && !m71.test(x) && !m72.test(x));
      // Foreign keys (most composite) and CHECKs live in the migration only, as for M68's patrol tables; every column, unique
      // key and index agrees.
      const unexpected = ours.filter((x) => !/^ALTER TABLE "(patrol_[a-z_]+|safety_alerts)" DROP CONSTRAINT "(FK|CHK)_(patrol_|safety_alerts_patrol_)/.test(x));
      assert.deepEqual(unexpected, [], `entity and migration 69 disagree:\n${unexpected.join('\n')}`);
      console.log(`      (diagnostic-only drift: ${drift.length} statement(s), of which ${ours.length} are patrol FK / CHECK names)`);
    });

    await test('M69-10-ROLLBACK-COMPATIBLE-WITH-THE-PREVIOUS-RELEASE', async () => {
      const previous = new DataSource({
        type: 'postgres', url, entities: [], synchronize: false, migrations: through68, migrationsTableName: 'typeorm_migrations', logging: false,
      });
      await previous.initialize();
      try {
        assert.equal((await previous.runMigrations({ transaction: 'each' })).length, 0, 'the previous release finds nothing to run');
        // P1-A's own writes, which never name a Migration 69 column.
        await previous.query(`UPDATE patrol_runs SET status = 'completed', "completedAtDevice" = now(), "completedAtServer" = now() WHERE "clientRunId" = 'm69-run-0001'`);
        const [r] = await previous.query(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","startedAtDevice","clientRunId")
          VALUES ($1,$2,$3,$4,$5,now(),'m69-run-0002') RETURNING id`, [coA, siteA, shiftA, guard, gu]);
        await previous.query(`UPDATE patrol_runs SET status = 'completed', "completedAtDevice" = now(), "completedAtServer" = now() WHERE id = $1`, [r.id]);
        await previous.query(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","scannedPublicId","result","scannedAtDevice","clientVisitId")
          VALUES ($1,$2,$3,'unverified',now(),'m69-visit-0002')`, [coA, r.id, 'b'.repeat(32)]);
        await previous.query(`INSERT INTO patrol_policies ("companyId","siteId") VALUES ($1,$2)`, [coA, siteA]);
        await previous.query(`INSERT INTO safety_alerts ("companyId","guardId",type,message) VALUES ($1,$2,'panic','SOS')`, [coA, guard]);
      } finally {
        await previous.destroy();
      }
      assert.equal(await migrationCount(), 69);
    });
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
