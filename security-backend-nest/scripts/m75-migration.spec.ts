/**
 * Migration 75 (AddPatrolMonitorIndexes1720900000022, S4 Patrol Monitor S1 indexes, owner-approved 3 Nov 2026) certification,
 * on a disposable database built from the repository's own migrations. (75 follows Migration 74 = 1720900000021;
 * 1720900000019 stays reserved by another branch.)
 *
 *   M75-01  the identifier and order: 75 files, 1720900000022 follows 74 and is the last; a populated database at 74
 *           migrates to 75 applying exactly this migration
 *   M75-02  exactly two indexes, with their exact definitions, valid and ready; no other table, column, constraint, index
 *           or enum changes
 *   M75-03  no existing row is modified (every row of every table, hashed)
 *   M75-04  it runs outside a transaction: transaction = false; inside a transaction block its CONCURRENTLY build is refused
 *           by PostgreSQL and leaves nothing behind; a whole-run transaction ('all') is refused by TypeORM before anything
 *           is applied; the deploy's --transaction each applies it
 *   M75-05  idempotent: a second run applies nothing; re-running up() on a 75 database changes nothing
 *   M75-06  an interrupted concurrent build (a real cancelled CREATE INDEX CONCURRENTLY, left INVALID) is detected and
 *           rebuilt valid with the exact definition; no row changes
 *   M75-07  an index with either name but another definition (other columns, UNIQUE, partial, other table, or invalid and
 *           wrong) is refused with the definition found; nothing is built or dropped and the ledger stays at 74
 *   M75-08  down() removes exactly the two indexes (the 74 schema, every row kept); re-applying restores the identical
 *           schema; rollback to 1.3.0 (c1143c0, migrations to 74): nothing pending, its reads and writes work with the
 *           indexes present
 *   M75-09  the Patrol Monitor's range reads can use them (the service's own run and shift queries)
 *   M75-10  no entity-to-migration drift for either index, and no semantic drift at 75
 *
 * Needs M75_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('pg');

const url = process.env.M75_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M75_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('M75 database must be local');

const MIGRATION_74 = 'AddPatrolSiteSetup1720900000021';
const MIGRATION_75 = 'AddPatrolMonitorIndexes1720900000022';
const RUNS_INDEX = 'IDX_patrol_runs_company_site_window_start';
const SHIFTS_INDEX = 'IDX_shifts_company_site_end';
const NEW_INDEXES = [RUNS_INDEX, SHIFTS_INDEX];
const DEFINITIONS: Record<string, string> = {
  [RUNS_INDEX]: 'CREATE INDEX "IDX_patrol_runs_company_site_window_start" ON public.patrol_runs USING btree ("companyId", "siteId", "windowStart")',
  [SHIFTS_INDEX]: 'CREATE INDEX "IDX_shifts_company_site_end" ON public.shifts USING btree ("companyId", "siteId", "end")',
};

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
  const upTo = (id: number) => allFiles.filter((f) => Number(f.split('-')[0]) <= id).map((f) => path.join(migrationsDir, f));
  const source = (id: number, entities: any[] = []) => new DataSource({
    type: 'postgres', url, entities, synchronize: false, dropSchema: false, migrations: upTo(id), migrationsTableName: 'typeorm_migrations', logging: false,
  });
  const ds = source(1720900000022, appEntities);
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const ledger = async () => (await q('SELECT name FROM typeorm_migrations ORDER BY id')).map((r: any) => r.name as string);

  const schema = async () => ({
    tables: (await q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r: any) => r.tablename),
    columns: await q(`SELECT table_name, column_name, data_type, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`),
    constraints: await q(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace AND conrelid <> 0 ORDER BY 1, 2`),
    indexes: await q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`),
    enums: await q(`SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid ORDER BY 1, e.enumsortorder`),
  });
  const without75 = (s: Awaited<ReturnType<typeof schema>>) => ({ ...s, indexes: s.indexes.filter((i: any) => !NEW_INDEXES.includes(i.indexname)) });
  /** Every row of every table, hashed (the ledger aside). */
  const hashAll = async () => {
    const tables = (await q(`SELECT tablename t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'typeorm_migrations' ORDER BY 1`)).map((r: any) => r.t as string);
    const out: Record<string, string[]> = {};
    for (const t of tables) out[t] = (await q(`SELECT md5(to_jsonb(x)::text) h FROM "${t}" x ORDER BY 1`)).map((r: any) => r.h);
    return out;
  };
  const indexState = async (name: string) => one(
    `SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid, i.indisready AS ready, i.indrelid::regclass::text AS tbl
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`, [name]);
  /** As an operator rolls back: migration:revert (--transaction each, which TypeORM runs in a transaction), or --transaction none. */
  const backTo74 = async (transaction: 'each' | 'none' = 'each') => {
    while ((await ledger()).at(-1) !== MIGRATION_74) await ds.undoLastMigration({ transaction });
  };

  try {
    // ── to 74, with production-shaped rows ──
    const at74 = source(1720900000021);
    await at74.initialize();
    await at74.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const applied74 = await at74.runMigrations({ transaction: 'each' });
    assert.equal(applied74.at(-1)!.name, MIGRATION_74);
    const o = async (sql: string, params: unknown[] = []) => (await at74.query(sql, params))[0];
    const owner = (await o(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m75.o@example.invalid','x','company_admin','active') RETURNING id`)).id;
    const co = (await o(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,'M75 A','75757575','1 Way','o@example.invalid',true) RETURNING id`, [owner])).id;
    const siteA = (await o(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'Quay','2 Way') RETURNING id`, [co])).id;
    const siteB = (await o(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'Yard','3 Way') RETURNING id`, [co])).id;
    const guardUser = (await o(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m75.g@example.invalid','x','guard','active') RETURNING id`)).id;
    const guard = (await o(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'Guard M75','7575757575757575','07750000075') RETURNING id`, [guardUser])).id;
    const schedule = (await o(`INSERT INTO patrol_schedules ("companyId","siteId",name,"daysOfWeek","activeFrom","activeTo","frequencyMinutes","windowMinutes",active,"createdAt","updatedAt")
       VALUES ($1,$2,'Hourly','[1,2,3,4,5,6,7]'::jsonb,'00:00','00:00',60,60,true,'2026-01-01','2026-01-01') RETURNING id`, [co, siteA])).id;
    // 60 shifts over 30 days at two sites, every status the Monitor reads or excludes.
    await at74.query(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end")
       SELECT $1, CASE WHEN d % 2 = 0 THEN $2::int ELSE $3::int END, 'Quay', $4, (ARRAY['completed','in_progress','ready','cancelled','missed','unfilled'])[1 + d % 6],
              timestamp '2026-03-01 07:00' + d * interval '12 hours', timestamp '2026-03-01 19:00' + d * interval '12 hours'
         FROM generate_series(0, 59) d`, [co, siteA, siteB, guard]);
    const shiftId = (await o(`SELECT id FROM shifts WHERE status = 'completed' ORDER BY id LIMIT 1`)).id;
    // 240 runs: scheduled (window start set) and unscheduled (no window).
    await at74.query(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","scheduleId","windowKey","windowStart","windowEnd","scopeKey",
         status,"startedAtDevice","startedAtServer","completedAtDevice","completedAtServer","clientRunId","lateStart")
       SELECT $1, $2, $3, $4, $5, CASE WHEN h % 5 = 0 THEN NULL ELSE $6::int END, CASE WHEN h % 5 = 0 THEN NULL ELSE 's' || $6 || ':' || h END,
              CASE WHEN h % 5 = 0 THEN NULL ELSE timestamp '2026-03-01 00:00' + h * interval '1 hour' END,
              CASE WHEN h % 5 = 0 THEN NULL ELSE timestamp '2026-03-01 01:00' + h * interval '1 hour' END, 'site', 'completed',
              timestamp '2026-03-01 00:05' + h * interval '1 hour', timestamp '2026-03-01 00:05' + h * interval '1 hour',
              timestamp '2026-03-01 00:25' + h * interval '1 hour', timestamp '2026-03-01 00:25' + h * interval '1 hour', 'm75-run-' || lpad(h::text, 6, '0'), false
         FROM generate_series(0, 239) h`, [co, siteA, shiftId, guard, guardUser, schedule]);
    await at74.destroy();

    await ds.initialize();
    const schema74 = await schema();
    const rows74 = await hashAll();
    assert.ok(rows74.patrol_runs.length === 240 && rows74.shifts.length === 60, 'seeded');

    await test('M75-01-IDENTIFIER-AND-ORDER', async () => {
      assert.equal(allFiles.length, 75, 'exactly 75 migration files');
      assert.equal(allFiles[73], '1720900000021-AddPatrolSiteSetup.ts', 'Migration 74 comes just before 75');
      assert.equal(allFiles[74], '1720900000022-AddPatrolMonitorIndexes.ts', 'Migration 75 = 1720900000022 and is the last');
      assert.ok(!allFiles.some((f) => f.startsWith('1720900000019')), '1720900000019 stays reserved by another branch');
      assert.equal(new Set(allFiles.map((f) => f.split('-')[0])).size, allFiles.length, 'every identifier is unique');
      assert.equal((await ledger()).at(-1), MIGRATION_74);
      const applied = await ds.runMigrations({ transaction: 'each' });
      assert.deepEqual(applied.map((m) => m.name), [MIGRATION_75], 'a 74 database applies exactly Migration 75');
      assert.equal((await ledger()).length, 75);
      assert.equal((await ledger()).at(-1), MIGRATION_75);
    });

    await test('M75-02-EXACTLY-TWO-VALID-INDEXES', async () => {
      const head = await schema();
      assert.deepEqual(without75(head), schema74, 'no other table, column, constraint, index or enum changed');
      assert.deepEqual(head.indexes.filter((i: any) => NEW_INDEXES.includes(i.indexname)).map((i: any) => i.indexname).sort(), [...NEW_INDEXES].sort());
      for (const name of NEW_INDEXES) {
        const s = await indexState(name);
        assert.deepEqual([s.def, s.valid, s.ready], [DEFINITIONS[name], true, true], `${name}: exact, valid and ready`);
      }
    });

    await test('M75-03-NO-ROW-MODIFIED', async () => {
      assert.deepEqual(await hashAll(), rows74, 'every row of every table is unchanged');
    });

    await test('M75-05-IDEMPOTENT', async () => {
      const head = await schema();
      assert.deepEqual(await ds.runMigrations({ transaction: 'each' }), [], 'a second run applies nothing');
      const { AddPatrolMonitorIndexes1720900000022 } = await import('../src/database/migrations/1720900000022-AddPatrolMonitorIndexes');
      const runner = ds.createQueryRunner();
      try {
        await new AddPatrolMonitorIndexes1720900000022().up(runner);
      } finally {
        await runner.release();
      }
      assert.deepEqual(await schema(), head, 're-running up() changes nothing');
      assert.deepEqual(await hashAll(), rows74);
    });

    await test('M75-08-DOWN-AND-ROLLBACK-TO-1.3.0', async () => {
      const head = await schema();
      // Both revert modes: migration:revert:prod (--transaction each: TypeORM wraps down() in a transaction, so a plain
      // drop with a lock timeout) and --transaction none (a concurrent drop).
      for (const mode of ['each', 'none'] as const) {
        await backTo74(mode);
        assert.equal((await ledger()).at(-1), MIGRATION_74, `revert (${mode})`);
        assert.deepEqual(await schema(), schema74, `revert (${mode}): down() removes exactly the two indexes`);
        assert.deepEqual(await hashAll(), rows74, `revert (${mode}): every row kept`);
        await ds.runMigrations({ transaction: 'each' });
        assert.deepEqual(await schema(), head, 're-applying restores the identical schema');
      }
      // A revert never queues indefinitely behind a long-running read: it gives up after its lock timeout.
      const reader = new Client({ connectionString: url });
      await reader.connect();
      try {
        await reader.query('BEGIN');
        await reader.query('SELECT count(*) FROM shifts');
        await assert.rejects(ds.undoLastMigration({ transaction: 'each' }), /lock timeout/i);
        await reader.query('ROLLBACK');
      } finally {
        await reader.end();
      }
      assert.equal((await ledger()).at(-1), MIGRATION_75, 'the timed-out revert changed nothing');
      assert.deepEqual(await schema(), head);

      // 1.3.0 (c1143c0) knows migrations up to 74: on a 75 database it has nothing pending, and its reads and writes work.
      const old = source(1720900000021);
      await old.initialize();
      try {
        assert.equal(await old.showMigrations(), false, 'no pending migration for the 1.3.0 code');
        assert.deepEqual(await old.runMigrations({ transaction: 'each' }), [], 'its pre-deploy migration:run is a no-op');
        const [s] = await old.query(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Quay',$3,'ready','2026-04-01 07:00','2026-04-01 19:00') RETURNING id`, [co, siteA, guard]);
        await old.query(`UPDATE shifts SET "end" = '2026-04-01 20:00' WHERE id = $1`, [s.id]);
        await old.query(`DELETE FROM shifts WHERE id = $1`, [s.id]);
        const runs = await old.query(`SELECT count(*)::int n FROM patrol_runs WHERE "companyId" = $1 AND "siteId" = $2 AND "windowStart" >= '2026-03-02' AND "windowStart" < '2026-03-03'`, [co, siteA]);
        assert.equal(runs[0].n, 19, '1.3.0-shaped reads see the same rows');
      } finally {
        await old.destroy();
      }
      assert.deepEqual(await hashAll(), rows74);
    });

    await test('M75-04-OUTSIDE-A-TRANSACTION', async () => {
      const { AddPatrolMonitorIndexes1720900000022 } = await import('../src/database/migrations/1720900000022-AddPatrolMonitorIndexes');
      assert.equal(new AddPatrolMonitorIndexes1720900000022().transaction, false);
      await backTo74();
      // Inside a transaction block PostgreSQL refuses the concurrent build, and the rollback leaves nothing behind.
      const runner = ds.createQueryRunner();
      try {
        await runner.startTransaction();
        await assert.rejects(new AddPatrolMonitorIndexes1720900000022().up(runner), /cannot run inside a transaction block/);
        await runner.rollbackTransaction();
      } finally {
        await runner.release();
      }
      assert.deepEqual(await schema(), schema74, 'nothing left behind');
      // A whole-run transaction cannot honour transaction = false: TypeORM refuses before applying anything.
      await assert.rejects(ds.runMigrations({ transaction: 'all' }), /transaction/i);
      assert.equal((await ledger()).at(-1), MIGRATION_74, 'nothing applied');
      assert.deepEqual(await schema(), schema74);
      // The deploy's mode (migration:run:prod uses --transaction each) applies it.
      assert.deepEqual((await ds.runMigrations({ transaction: 'each' })).map((m) => m.name), [MIGRATION_75]);
      for (const name of NEW_INDEXES) assert.equal((await indexState(name)).valid, true);
    });

    await test('M75-06-INTERRUPTED-BUILD-IS-REBUILT', async () => {
      await backTo74();
      // A real interruption: a writer holds the table, the concurrent build waits for it with its catalog entry already
      // committed, and the build is cancelled — PostgreSQL leaves the index behind, INVALID.
      const writer = new Client({ connectionString: url });
      const builder = new Client({ connectionString: url });
      await writer.connect();
      await builder.connect();
      try {
        await writer.query('BEGIN');
        await writer.query('LOCK TABLE patrol_runs IN ROW EXCLUSIVE MODE');
        const [{ pid }] = (await builder.query('SELECT pg_backend_pid() AS pid')).rows;
        const build = builder.query(`CREATE INDEX CONCURRENTLY "${RUNS_INDEX}" ON "patrol_runs" ("companyId", "siteId", "windowStart")`).then(() => 'built', (e: Error) => String(e.message));
        for (let i = 0; i < 100; i += 1) {
          const [w] = await q(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);
          if (w?.wait_event_type === 'Lock') break;
          await new Promise((r) => setTimeout(r, 50));
        }
        await q('SELECT pg_cancel_backend($1)', [pid]);
        assert.match(await build, /canceling statement/i, 'the build was interrupted');
        await writer.query('ROLLBACK');
      } finally {
        await writer.end();
        await builder.end();
      }
      const left = await indexState(RUNS_INDEX);
      assert.deepEqual([left.def, left.valid], [DEFINITIONS[RUNS_INDEX], false], 'an INVALID index with the right definition is left behind');

      assert.deepEqual((await ds.runMigrations({ transaction: 'each' })).map((m) => m.name), [MIGRATION_75]);
      for (const name of NEW_INDEXES) {
        const s = await indexState(name);
        assert.deepEqual([s.def, s.valid, s.ready], [DEFINITIONS[name], true, true], `${name} rebuilt valid`);
      }
      assert.deepEqual(without75(await schema()), schema74);
      assert.deepEqual(await hashAll(), rows74, 'no row changed');
    });

    await test('M75-07-WRONG-DEFINITIONS-ARE-REFUSED', async () => {
      const wrong = [
        { plant: `CREATE INDEX "${SHIFTS_INDEX}" ON "shifts" ("companyId", "end")`, what: 'other columns' },
        { plant: `CREATE UNIQUE INDEX "${SHIFTS_INDEX}" ON "shifts" ("id", "companyId", "siteId", "end")`, what: 'unique, other columns' },
        { plant: `CREATE INDEX "${RUNS_INDEX}" ON "patrol_runs" ("companyId", "siteId", "windowStart") WHERE "windowStart" IS NOT NULL`, what: 'partial' },
        { plant: `CREATE INDEX "${RUNS_INDEX}" ON "shifts" ("companyId", "siteId", "start")`, what: 'another table' },
        { plant: `CREATE INDEX "${RUNS_INDEX}" ON "patrol_runs" USING hash ("companyId")`, what: 'another method' },
      ];
      for (const w of wrong) {
        await backTo74();
        await q(w.plant);
        const name = w.plant.match(/"(IDX_[a-z_]+)"/)![1];
        const planted = await indexState(name);
        await assert.rejects(ds.runMigrations({ transaction: 'each' }), (e: Error) => {
          assert.match(e.message, new RegExp(`Refusing AddPatrolMonitorIndexes1720900000022: "${name}" exists with a different definition`), w.what);
          assert.ok(e.message.includes(planted.def), `${w.what}: names the definition found`);
          return true;
        });
        assert.equal((await ledger()).at(-1), MIGRATION_74, `${w.what}: the ledger stays at 74`);
        const other = NEW_INDEXES.find((n) => n !== name)!;
        assert.equal(await indexState(other), undefined, `${w.what}: nothing was built (checked before building)`);
        assert.equal((await indexState(name)).def, planted.def, `${w.what}: the existing index is never dropped`);
        await q(`DROP INDEX "${name}"`);
      }
      // Invalid AND wrong: refused, not dropped (only an exact definition is treated as an interrupted build of ours).
      const writer = new Client({ connectionString: url });
      const builder = new Client({ connectionString: url });
      await writer.connect();
      await builder.connect();
      try {
        await writer.query('BEGIN');
        await writer.query('LOCK TABLE shifts IN ROW EXCLUSIVE MODE');
        const [{ pid }] = (await builder.query('SELECT pg_backend_pid() AS pid')).rows;
        const build = builder.query(`CREATE INDEX CONCURRENTLY "${SHIFTS_INDEX}" ON "shifts" ("siteId")`).then(() => 'built', (e: Error) => String(e.message));
        for (let i = 0; i < 100; i += 1) {
          const [x] = await q(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);
          if (x?.wait_event_type === 'Lock') break;
          await new Promise((r) => setTimeout(r, 50));
        }
        await q('SELECT pg_cancel_backend($1)', [pid]);
        assert.match(await build, /canceling statement/i);
        await writer.query('ROLLBACK');
      } finally {
        await writer.end();
        await builder.end();
      }
      assert.equal((await indexState(SHIFTS_INDEX)).valid, false);
      await assert.rejects(ds.runMigrations({ transaction: 'each' }), /exists with a different definition \(INVALID\)/);
      assert.equal((await indexState(SHIFTS_INDEX)).valid, false, 'kept for investigation, never dropped automatically');
      assert.equal((await ledger()).at(-1), MIGRATION_74);
      await q(`DROP INDEX "${SHIFTS_INDEX}"`);
      await ds.runMigrations({ transaction: 'each' });
      assert.equal((await ledger()).at(-1), MIGRATION_75);
      assert.deepEqual(await hashAll(), rows74, 'no row changed by any refusal');
    });

    await test('M75-09-THE-MONITOR-QUERIES-CAN-USE-THEM', async () => {
      // The Patrol Monitor service's own range reads (patrol-monitor.service.ts load()); sequential scans off, so the
      // plan shows whether the index serves the query at all on this small table.
      const runner = ds.createQueryRunner();
      try {
        await runner.query('SET enable_seqscan = off');
        const plan = async (sql: string, params: unknown[]) => JSON.stringify(await runner.query(`EXPLAIN (FORMAT JSON) ${sql}`, params));
        const runsPlan = await plan(`SELECT "id" FROM "patrol_runs" WHERE "companyId" = $1 AND "siteId" = ANY($2::int[])
            AND (("windowStart" >= $3 AND "windowStart" < $4) OR ("windowStart" IS NULL AND "startedAtServer" >= $3 AND "startedAtServer" < $4))`,
          [co, [siteA, siteB], '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z']);
        assert.ok(runsPlan.includes(RUNS_INDEX), `runs read uses ${RUNS_INDEX}: ${runsPlan.slice(0, 300)}`);
        const shiftsPlan = await plan(`SELECT "id" FROM "shifts" WHERE "companyId" = $1 AND "siteId" = ANY($2::int[]) AND "start" < $3 AND "end" > $4
            AND NOT ("status"::text = ANY($5::text[]))`, [co, [siteA, siteB], '2026-03-03T00:00:00Z', '2026-03-02T00:00:00Z', ['cancelled', 'rejected']]);
        assert.ok(shiftsPlan.includes(SHIFTS_INDEX), `shifts read uses ${SHIFTS_INDEX}: ${shiftsPlan.slice(0, 300)}`);
        await runner.query('RESET enable_seqscan');
      } finally {
        await runner.release();
      }
    });

    await test('M75-10-NO-DRIFT', async () => {
      const drift = (await ds.driver.createSchemaBuilder().log()).upQueries.map((x) => x.query);
      const semantic = drift.filter((x) =>
        /CREATE TABLE|DROP TABLE|CREATE TYPE|DROP TYPE|ALTER TYPE|ALTER TABLE.*ALTER COLUMN|ALTER TABLE.*DROP COLUMN|ALTER TABLE.*ADD "/i.test(x));
      assert.deepEqual(semantic, [], `semantic drift (the release gate would fail):\n${semantic.join('\n')}`);
      const ours = drift.filter((x) => NEW_INDEXES.some((n) => x.includes(`"${n}"`)));
      assert.deepEqual(ours, [], `entities and Migration 75 disagree:\n${ours.join('\n')}`);
      console.log(`      (diagnostic-only drift: ${drift.length} statement(s), none about Migration 75)`);
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
