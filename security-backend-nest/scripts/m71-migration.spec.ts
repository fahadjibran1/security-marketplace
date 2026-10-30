/**
 * Migration 71 (AddPatrolSweepReconciliation1720900000017) certification, on a disposable database built from the
 * repository's own migrations.
 *
 *   M71-01  a database at 70 migrates to 71, and only Migration 72 (m72-migration.spec.ts) follows it
 *   M71-02  the schema it adds and nothing else: two tables (patrol_sweep_watermarks, patrol_reconciliation_runs), one
 *           patrol_exceptions column, one safety_alerts column, their constraints and indexes; every new time is
 *           timestamptz; varchar + CHECK, no enum; no other table, column, constraint, index or enum changes
 *   M71-03  every existing row keeps its values (patrol and alert rows included); the new columns are NULL
 *   M71-04  a second run applies nothing; re-running up() directly changes nothing
 *   M71-05  the CHECKs and unique keys hold: status vocabulary, completed ⇔ completedAt, throughAt ≥ fromAt, the
 *           not-judged range (both or neither, ordered, before fromAt), counts, one running run per company, one
 *           reconciliation alert per (run, key)
 *   M71-06  foreign keys: runs and watermarks belong to a company; an exception's run is its own company's (composite);
 *           an alert's run exists; nothing disappears with a company
 *   M71-07  down() refuses while any reconciliation run exists, and changes nothing
 *   M71-08  down() with none removes exactly what 71 added; re-applying restores the identical schema
 *   M71-09  no semantic entity-to-migration drift at 71 and no column drift on the patrol / alert columns
 *   M71-10  rollback compatibility: the previous release's pre-deploy run (through 70) is a no-op on a 71 database and
 *           P1-C-shaped writes (which never name a new column) still succeed
 *
 * Needs M71_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.M71_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M71_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('M71 database must be local');

const MIGRATION_70 = 'AddPatrolEvidenceStorage1720900000016';
const MIGRATION_71 = 'AddPatrolSweepReconciliation1720900000017';
const NEW_TABLES = ['patrol_reconciliation_runs', 'patrol_sweep_watermarks'];
const NEW_COLUMNS: Record<string, string[]> = {
  patrol_exceptions: ['reconciliationRunId'],
  safety_alerts: ['patrolReconciliationRunId'],
};
const NEW_EXISTING_TABLE_CONSTRAINTS = ['FK_patrol_exceptions_reconciliation_run', 'FK_safety_alerts_patrol_reconciliation_run'];
const NEW_EXISTING_TABLE_INDEXES = ['IDX_patrol_exceptions_reconciliation', 'uq_safety_alerts_patrol_reconciliation'];
const isNewColumn = (c: any) => NEW_TABLES.includes(c.table_name) || (NEW_COLUMNS[c.table_name] ?? []).includes(c.column_name);

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
  const through70 = allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000016).map((f) => path.join(migrationsDir, f));
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: false,
    migrations: allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000017).map((f) => path.join(migrationsDir, f)),
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
  /** The head schema without what 71 adds. */
  const without71 = (s: Awaited<ReturnType<typeof schema>>) => ({
    tables: s.tables.filter((t: string) => !NEW_TABLES.includes(t)),
    columns: s.columns.filter((c: any) => !isNewColumn(c)),
    constraints: s.constraints.filter((c: any) => !NEW_TABLES.includes(c.tbl) && !NEW_EXISTING_TABLE_CONSTRAINTS.includes(c.conname)),
    indexes: s.indexes.filter((i: any) => !NEW_TABLES.includes(i.tablename) && !NEW_EXISTING_TABLE_INDEXES.includes(i.indexname)),
    enums: s.enums,
  });
  const hashAll = async (run: (sql: string) => Promise<any[]>) => {
    const tables = (await run(`SELECT tablename t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.t as string)
      .filter((t) => t !== 'typeorm_migrations' && !NEW_TABLES.includes(t));
    const out: Record<string, string[]> = {};
    for (const t of tables) {
      const drop = (NEW_COLUMNS[t] ?? []).map((c) => ` - '${c}'`).join('');
      out[t] = (await run(`SELECT md5((to_jsonb(x)${drop})::text) h FROM "${t}" x ORDER BY 1`)).map((r) => r.h);
    }
    return out;
  };

  try {
    // ── to 70, seed production-shaped rows (patrol run, exception and its alert, evidence) ─────────────────────
    const at70 = new DataSource({
      type: 'postgres', url, entities: [], synchronize: false, migrations: through70, migrationsTableName: 'typeorm_migrations', logging: false,
    });
    await at70.initialize();
    await at70.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const applied70 = await at70.runMigrations({ transaction: 'each' });
    assert.equal(applied70[applied70.length - 1].name, MIGRATION_70);
    const one = async (sql: string, params: unknown[] = []) => (await at70.query(sql, params))[0];
    const ownerId = (await one(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m71.o@example.invalid','x','company_admin','active') RETURNING id`)).id;
    const coA = (await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,'M71 A','71717171','1 Way','o@example.invalid',true) RETURNING id`, [ownerId])).id;
    const ownerB = (await one(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m71.ob@example.invalid','x','company_admin','active') RETURNING id`)).id;
    const coB = (await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,'M71 B','71717172','2 Way','b@example.invalid') RETURNING id`, [ownerB])).id;
    const siteA = (await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'A1','2 Way') RETURNING id`, [coA])).id;
    const siteB = (await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'B1','3 Way') RETURNING id`, [coB])).id;
    const gu = (await one(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m71.g@example.invalid','x','guard','active') RETURNING id`)).id;
    const guard = (await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'M71 Guard','1000000000000071','07000000071') RETURNING id`, [gu])).id;
    const shiftA = (await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'x',$3,'in_progress',now() - interval '1 hour',now() + interval '7 hours') RETURNING id`,
      [coA, siteA, guard])).id;
    await at70.query(`INSERT INTO patrol_policies ("companyId") VALUES ($1)`, [coA]);
    const run = (await one(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","startedAtDevice","clientRunId")
      VALUES ($1,$2,$3,$4,$5,now(),'m71-run-0001') RETURNING id`, [coA, siteA, shiftA, guard, gu])).id;
    const exception = (await one(`INSERT INTO patrol_exceptions ("companyId","siteId","runId","windowKey","type") VALUES ($1,$2,$3,'s1:2026-10-29:1','patrol_missed') RETURNING id`,
      [coA, siteA, run])).id;
    const alert = (await one(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message,"patrolExceptionId","patrolWindowKey")
      VALUES ($1,$2,$3,'patrol_missed','high','open','Patrol missed',$4,'s1:2026-10-29:1') RETURNING id`, [coA, guard, shiftA, exception])).id;
    await at70.query(`UPDATE patrol_exceptions SET "safetyAlertId" = $2 WHERE id = $1`, [exception, alert]);
    await at70.query(`INSERT INTO patrol_evidence ("companyId","siteId","runId","guardId","shiftId","sha256Client","capturedAtDevice","clientEvidenceId","mimeType","sizeBytes")
      VALUES ($1,$2,$3,$4,$5,$6,now(),'m71-evidence-0001','image/jpeg',1234)`, [coA, siteA, run, guard, shiftA, 'a'.repeat(64)]);
    const before = await hashAll((sql) => at70.query(sql));
    const at70Schema = await schemaOf((sql) => at70.query(sql));
    await at70.destroy();

    await ds.initialize();
    const applied = await ds.runMigrations({ transaction: 'each' });

    await test('M71-01-A-70-DATABASE-MIGRATES-TO-71-AND-ONLY-72-FOLLOWS', () => {
      assert.deepEqual(applied.map((m) => m.name), [MIGRATION_71], 'only 71 is pending on a 70 database');
      assert.equal(allFiles.length, 72);
      assert.equal(allFiles[70], '1720900000017-AddPatrolSweepReconciliation.ts');
      assert.equal(allFiles[71], '1720900000018-AddPatrolSyncRecoveryGrants.ts', 'Migration 72 follows 71 and is certified by m72-migration.spec.ts');
    });
    const head = await schema();

    await test('M71-02-THE-SCHEMA-IT-ADDS-AND-NOTHING-ELSE', () => {
      assert.deepEqual(head.tables.filter((t: string) => !at70Schema.tables.includes(t)).sort(), [...NEW_TABLES].sort(), 'exactly two tables added');
      const col = (t: string, c: string) => head.columns.find((x: any) => x.table_name === t && x.column_name === c);
      for (const [t, cols] of Object.entries(NEW_COLUMNS)) {
        for (const c of cols) {
          assert.equal(col(t, c)?.is_nullable, 'YES', `${t}.${c} nullable (existing INSERTs stay valid)`);
          assert.equal(col(t, c)?.data_type, 'integer');
        }
      }
      for (const [t, c] of [['patrol_sweep_watermarks', 'judgedThrough'], ['patrol_sweep_watermarks', 'updatedAt'], ['patrol_reconciliation_runs', 'fromAt'],
        ['patrol_reconciliation_runs', 'throughAt'], ['patrol_reconciliation_runs', 'targetAt'], ['patrol_reconciliation_runs', 'unjudgedFrom'],
        ['patrol_reconciliation_runs', 'unjudgedTo'], ['patrol_reconciliation_runs', 'startedAt'], ['patrol_reconciliation_runs', 'completedAt']]) {
        assert.equal(col(t, c).data_type, 'timestamp with time zone', `${t}.${c} is timestamptz`);
      }
      assert.equal(col('patrol_reconciliation_runs', 'status').data_type, 'character varying', 'varchar + CHECK, not an enum');
      assert.deepEqual(head.enums, at70Schema.enums, 'no enum added or changed');
      const [now71, was70] = [without71(head), without71(at70Schema)];
      for (const key of Object.keys(now71) as Array<keyof typeof now71>) {
        const added = (now71[key] as any[]).filter((x) => !(was70[key] as any[]).some((y) => JSON.stringify(y) === JSON.stringify(x)));
        const removed = (was70[key] as any[]).filter((x) => !(now71[key] as any[]).some((y) => JSON.stringify(y) === JSON.stringify(x)));
        assert.deepEqual({ added, removed }, { added: [], removed: [] }, `every other ${key} is unchanged: ${JSON.stringify({ added, removed })}`);
      }
      const names = head.constraints.map((c: any) => c.conname);
      for (const c of [...NEW_EXISTING_TABLE_CONSTRAINTS, 'PK_patrol_reconciliation_runs', 'UQ_patrol_reconciliation_runs_id_company',
        'CHK_patrol_reconciliation_runs_status', 'CHK_patrol_reconciliation_runs_completed', 'CHK_patrol_reconciliation_runs_range',
        'CHK_patrol_reconciliation_runs_unjudged', 'CHK_patrol_reconciliation_runs_counts', 'FK_patrol_reconciliation_runs_company',
        'PK_patrol_sweep_watermarks', 'FK_patrol_sweep_watermarks_company']) {
        assert.ok(names.includes(c), `constraint ${c}`);
      }
      const idx = head.indexes.map((i: any) => i.indexname);
      for (const i of [...NEW_EXISTING_TABLE_INDEXES, 'UQ_patrol_reconciliation_runs_running', 'IDX_patrol_reconciliation_runs_company']) {
        assert.ok(idx.includes(i), `index ${i}`);
      }
    });

    await test('M71-03-EVERY-EXISTING-ROW-KEEPS-ITS-VALUES-AND-NEW-COLUMNS-ARE-NULL', async () => {
      assert.deepEqual(await hashAll((sql) => q(sql)), before);
      assert.equal(await scalar(`SELECT "reconciliationRunId" FROM patrol_exceptions WHERE id = $1`, [exception]), null);
      assert.equal(await scalar(`SELECT "patrolReconciliationRunId" FROM safety_alerts WHERE id = $1`, [alert]), null);
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM patrol_sweep_watermarks`)), 0, 'no watermark is backfilled (the sweep starts at its first pass)');
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM patrol_reconciliation_runs`)), 0);
    });

    await test('M71-04-A-SECOND-RUN-APPLIES-NOTHING-AND-UP-IS-REPEATABLE', async () => {
      assert.equal((await ds.runMigrations({ transaction: 'each' })).length, 0);
      const { AddPatrolSweepReconciliation1720900000017 } = await import('../src/database/migrations/1720900000017-AddPatrolSweepReconciliation');
      const runner = ds.createQueryRunner();
      try {
        await new AddPatrolSweepReconciliation1720900000017().up(runner);
      } finally {
        await runner.release();
      }
      assert.deepEqual(await schema(), head);
      assert.equal(await migrationCount(), 71);
    });

    const mkRun = async (fields: Record<string, string> = {}, companyId = coA) => {
      const all = { companyId: String(companyId), fromAt: `'2026-10-01T00:00:00Z'`, throughAt: `'2026-10-01T00:00:00Z'`, targetAt: `'2026-10-10T00:00:00Z'`, horizonDays: '14', ...fields };
      return (await q(`INSERT INTO patrol_reconciliation_runs (${Object.keys(all).map((k) => `"${k}"`).join(',')}) VALUES (${Object.values(all).join(',')}) RETURNING id`))[0];
    };

    await test('M71-05-THE-CHECKS-AND-UNIQUE-KEYS-HOLD', async () => {
      await assert.rejects(() => mkRun({ status: `'done'` }), /CHK_patrol_reconciliation_runs_status/);
      await assert.rejects(() => mkRun({ status: `'completed'` }), /CHK_patrol_reconciliation_runs_completed/, 'completed needs completedAt');
      await assert.rejects(() => mkRun({ completedAt: 'now()' }), /CHK_patrol_reconciliation_runs_completed/, 'running has no completedAt');
      await assert.rejects(() => mkRun({ throughAt: `'2026-09-30T00:00:00Z'` }), /CHK_patrol_reconciliation_runs_range/);
      await assert.rejects(() => mkRun({ unjudgedFrom: `'2026-09-01T00:00:00Z'` }), /CHK_patrol_reconciliation_runs_unjudged/, 'both or neither');
      await assert.rejects(() => mkRun({ unjudgedFrom: `'2026-09-20T00:00:00Z'`, unjudgedTo: `'2026-09-10T00:00:00Z'` }), /CHK_patrol_reconciliation_runs_unjudged/, 'ordered');
      await assert.rejects(() => mkRun({ unjudgedFrom: `'2026-09-20T00:00:00Z'`, unjudgedTo: `'2026-10-02T00:00:00Z'` }), /CHK_patrol_reconciliation_runs_unjudged/,
        'the not-judged range ends where the judged range begins');
      await assert.rejects(() => mkRun({ batches: '-1' }), /CHK_patrol_reconciliation_runs_counts/);
      await assert.rejects(() => mkRun({ horizonDays: '0' }), /CHK_patrol_reconciliation_runs_counts/);
      const first = await mkRun({ unjudgedFrom: `'2026-09-01T00:00:00Z'`, unjudgedTo: `'2026-10-01T00:00:00Z'` });
      await assert.rejects(() => mkRun(), /UQ_patrol_reconciliation_runs_running/, 'one running run per company');
      await q(`UPDATE patrol_reconciliation_runs SET status = 'completed', "completedAt" = now() WHERE id = $1`, [first.id]);
      const second = await mkRun();
      await mkRun({}, coB); // another company runs independently
      await q(`INSERT INTO safety_alerts ("companyId",type,priority,status,message,"patrolReconciliationRunId","patrolWindowKey") VALUES ($1,'patrol_missed','high','open','Summary',$2,'reconciliation:site:1')`, [coA, second.id]);
      await assert.rejects(() => q(`INSERT INTO safety_alerts ("companyId",type,priority,status,message,"patrolReconciliationRunId","patrolWindowKey") VALUES ($1,'patrol_missed','high','open','Again',$2,'reconciliation:site:1')`,
        [coA, second.id]), /uq_safety_alerts_patrol_reconciliation/, 'one alert per (run, key)');
      await q(`INSERT INTO safety_alerts ("companyId",type,priority,status,message,"patrolReconciliationRunId","patrolWindowKey") VALUES ($1,'patrol_missed','high','open','Horizon',$2,'reconciliation:horizon')`, [coA, second.id]);
      await q(`DELETE FROM safety_alerts WHERE "patrolReconciliationRunId" IS NOT NULL`);
      await q(`DELETE FROM patrol_reconciliation_runs`);
    });

    await test('M71-06-FOREIGN-KEYS-TIE-RUNS-WATERMARKS-AND-MARKERS-TO-THEIR-COMPANY', async () => {
      await assert.rejects(() => mkRun({}, 999999), /FK_patrol_reconciliation_runs_company/);
      await assert.rejects(() => q(`INSERT INTO patrol_sweep_watermarks ("companyId","judgedThrough") VALUES (999999, now())`), /FK_patrol_sweep_watermarks_company/);
      const runB = await mkRun({}, coB);
      await assert.rejects(() => q(`UPDATE patrol_exceptions SET "reconciliationRunId" = $2 WHERE id = $1`, [exception, runB.id]), /FK_patrol_exceptions_reconciliation_run/,
        'an exception can only be marked by its own company\'s run');
      const runA = await mkRun();
      await q(`UPDATE patrol_exceptions SET "reconciliationRunId" = $2 WHERE id = $1`, [exception, runA.id]);
      await assert.rejects(() => q(`UPDATE safety_alerts SET "patrolReconciliationRunId" = 999999 WHERE id = $1`, [alert]), /FK_safety_alerts_patrol_reconciliation_run/);
      await q(`INSERT INTO patrol_sweep_watermarks ("companyId","judgedThrough") VALUES ($1, now())`, [coA]);
      await assert.rejects(() => q(`INSERT INTO patrol_sweep_watermarks ("companyId","judgedThrough") VALUES ($1, now())`, [coA]), /PK_patrol_sweep_watermarks/, 'one per company');
      await assert.rejects(() => q(`DELETE FROM patrol_reconciliation_runs WHERE id = $1`, [runA.id]), /FK_patrol_exceptions_reconciliation_run/, 'a run outlives what it marked');
      await assert.rejects(() => q(`DELETE FROM companies WHERE id = $1`, [coB]), /FK_patrol_reconciliation_runs_company/, 'a run never disappears with a company');
      await q(`UPDATE patrol_exceptions SET "reconciliationRunId" = NULL WHERE id = $1`, [exception]);
      await q(`DELETE FROM patrol_sweep_watermarks`);
      await q(`DELETE FROM patrol_reconciliation_runs`);
    });

    await test('M71-07-DOWN-REFUSES-WHILE-A-RECONCILIATION-RUN-EXISTS', async () => {
      await mkRun({ status: `'completed'`, completedAt: 'now()' });
      const snapshot = await hashAll((sql) => q(sql));
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /Refusing to revert AddPatrolSweepReconciliation1720900000017: 1 patrol reconciliation run/);
      assert.equal(await migrationCount(), 71);
      assert.deepEqual(await schema(), head, 'nothing changed');
      assert.deepEqual(await hashAll((sql) => q(sql)), snapshot);
      await q(`DELETE FROM patrol_reconciliation_runs`);
    });

    await test('M71-08-DOWN-REMOVES-EXACTLY-WHAT-71-ADDED-AND-RE-APPLY-RESTORES-IT', async () => {
      await q(`INSERT INTO patrol_sweep_watermarks ("companyId","judgedThrough") VALUES ($1, now())`, [coA]); // derived progress: no blocker
      const rows = await hashAll((sql) => q(sql));
      await ds.undoLastMigration({ transaction: 'each' });
      assert.equal(await migrationCount(), 70);
      const back = await schema();
      assert.deepEqual(back.tables, at70Schema.tables);
      assert.deepEqual(back.columns, at70Schema.columns);
      assert.deepEqual(back.constraints, at70Schema.constraints);
      assert.deepEqual(back.indexes, at70Schema.indexes);
      assert.deepEqual(back.enums, at70Schema.enums);
      assert.deepEqual(await hashAll((sql) => q(sql)), rows, 'existing rows survive the round trip');
      await ds.runMigrations({ transaction: 'each' });
      assert.deepEqual(await schema(), head);
    });

    await test('M71-09-NO-SEMANTIC-DRIFT-AND-NO-COLUMN-DRIFT-ON-PATROL-OR-ALERT-COLUMNS', async () => {
      const drift = (await ds.driver.createSchemaBuilder().log()).upQueries.map((x) => x.query);
      // This database stops at 71, so Migration 72's recovery grant table and its indexes are absent by design; they are set
      // aside statement by statement (m72-migration.spec.ts M72-09 certifies them).
      const m72 = /^CREATE TABLE "patrol_sync_recovery_grants" |^CREATE INDEX "IDX_patrol_sync_recovery_grants_(active|company)" |^ALTER TABLE "patrol_sync_recovery_grants" /;
      const semantic = drift.filter((x) => !m72.test(x) &&
        /CREATE TABLE|DROP TABLE|CREATE TYPE|DROP TYPE|ALTER TYPE|ALTER TABLE.*ALTER COLUMN|ALTER TABLE.*DROP COLUMN|ALTER TABLE.*ADD "/i.test(x));
      assert.deepEqual(semantic, [], `semantic drift (the release gate would fail):\n${semantic.join('\n')}`);
      const ours = drift.filter((x) => /"patrol_|patrolsEnabled|patrol(ExceptionId|RunId|WindowKey|LateSyncAt|Annotation|ReconciliationRunId)|reconciliationRunId|uq_safety_alerts_patrol_/.test(x) && !m72.test(x));
      // Foreign keys (one composite) and CHECKs live in the migration only, as for M68–M70's patrol tables; every column,
      // unique key and index agrees.
      const unexpected = ours.filter((x) => !/^ALTER TABLE "(patrol_[a-z_]+|safety_alerts)" DROP CONSTRAINT "(FK|CHK)_(patrol_|safety_alerts_patrol_)/.test(x));
      assert.deepEqual(unexpected, [], `entity and migration 71 disagree:\n${unexpected.join('\n')}`);
      console.log(`      (diagnostic-only drift: ${drift.length} statement(s), of which ${ours.length} are patrol FK / CHECK names)`);
    });

    await test('M71-10-ROLLBACK-COMPATIBLE-WITH-THE-PREVIOUS-RELEASE', async () => {
      const previous = new DataSource({
        type: 'postgres', url, entities: [], synchronize: false, migrations: through70, migrationsTableName: 'typeorm_migrations', logging: false,
      });
      await previous.initialize();
      try {
        assert.equal((await previous.runMigrations({ transaction: 'each' })).length, 0, 'the previous release finds nothing to run');
        // P1-C's sweep writes, which never name a Migration 71 column.
        const [e] = await previous.query(`INSERT INTO "patrol_exceptions" ("companyId", "siteId", "runId", "scheduleId", "shiftId", "windowKey", "scopeKey", "type", "note",
            "guardId", "windowStart", "windowEnd") VALUES ($1,$2,NULL,NULL,$3,'s1:2026-10-30:2','site','patrol_missed','x',$4,now(),now()) RETURNING id`, [coA, siteA, shiftA, guard]);
        await previous.query(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message,"patrolExceptionId","patrolWindowKey")
          VALUES ($1,$2,$3,'patrol_missed','high','open','Patrol missed',$4,'s1:2026-10-30:2')`, [coA, guard, shiftA, e.id]);
        await previous.query(`UPDATE patrol_exceptions SET status = 'resolved', resolution = 'other', "resolvedAt" = now() WHERE id = $1`, [e.id]);
      } finally {
        await previous.destroy();
      }
      assert.equal(await migrationCount(), 71);
      assert.equal(await scalar(`SELECT "reconciliationRunId" FROM patrol_exceptions WHERE "windowKey" = 's1:2026-10-30:2'`), null);
    });
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`);
  console.log(JSON.stringify({ event: 'm71_migration_certified', tests: passed }));
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
