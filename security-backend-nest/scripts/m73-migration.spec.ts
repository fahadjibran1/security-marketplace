/**
 * Migration 73 (AddPatrolScheduleSuccessors1720900000020, S4 1.2.1 durable schedule successors) certification, on a
 * disposable database built from the repository's own migrations. (73 follows Migration 72 = 1720900000018,
 * AddPatrolSyncRecoveryGrants; 1720900000019 is reserved by another branch.)
 *
 *   M73-01  a database at 72 migrates to 73 and 73 is the last migration
 *   M73-02  the schema it adds and nothing else: two nullable columns on patrol_schedules (supersededByScheduleId int,
 *           supersededAt timestamptz), their CHECKs, the composite same-company-and-site foreign key, a partial unique
 *           index and a partial index; no other table, column, constraint, index or enum changes
 *   M73-03  every existing row keeps its values; the ONLY write is the backfill of the new columns from the
 *           patrol.schedule.superseded audit entries (earliest per schedule and per successor; never across a site or
 *           company, never onto a successor already linked, never an unarchived schedule); audit rows are untouched
 *   M73-04  a second run applies nothing; re-running up() (backfill included) changes nothing
 *   M73-05  the constraints refuse an invalid link: itself, another site or company, a missing schedule, an unarchived
 *           schedule, half a pair, a second predecessor for one successor; a linked successor cannot be deleted
 *   M73-06  down() refuses while any link exists, and changes nothing
 *   M73-07  down() with none removes exactly what 73 added; re-applying restores the identical schema
 *   M73-08  no semantic entity-to-migration drift at 73 (FK / CHECK names live in the migration only)
 *   M73-09  rollback compatibility: the previous releases' migrations (through 72) are a no-op on a 73 database, and
 *           1.2.0-shaped schedule reads and writes (SELECT *, INSERT / UPDATE that never name the columns) still work
 *
 * Needs M73_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.M73_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M73_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('M73 database must be local');

const MIGRATION_72 = 'AddPatrolSyncRecoveryGrants1720900000018';
const MIGRATION_73 = 'AddPatrolScheduleSuccessors1720900000020';
const NEW_COLUMNS = ['supersededAt', 'supersededByScheduleId'];
const NEW_CONSTRAINTS = ['CHK_patrol_schedules_superseded_pair', 'CHK_patrol_schedules_superseded_not_self', 'CHK_patrol_schedules_superseded_archived',
  'FK_patrol_schedules_superseded_by'];
const NEW_INDEXES = ['UQ_patrol_schedules_superseded_by', 'IDX_patrol_schedules_superseded'];

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
  const through72 = allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000018).map((f) => path.join(migrationsDir, f));
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: false,
    migrations: allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000020).map((f) => path.join(migrationsDir, f)),
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
  /** The head schema without what 73 adds. */
  const without73 = (s: Awaited<ReturnType<typeof schema>>) => ({
    tables: s.tables,
    columns: s.columns.filter((c: any) => !(c.table_name === 'patrol_schedules' && NEW_COLUMNS.includes(c.column_name))),
    constraints: s.constraints.filter((c: any) => !NEW_CONSTRAINTS.includes(c.conname)),
    indexes: s.indexes.filter((i: any) => !NEW_INDEXES.includes(i.indexname)),
    enums: s.enums,
  });
  /** Every row of every table, as hashes; patrol_schedules without the two new columns. */
  const hashAll = async (run: (sql: string) => Promise<any[]>) => {
    const tables = (await run(`SELECT tablename t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.t as string)
      .filter((t) => t !== 'typeorm_migrations');
    const out: Record<string, string[]> = {};
    for (const t of tables) {
      const expr = t === 'patrol_schedules' ? `(to_jsonb(x) - 'supersededByScheduleId' - 'supersededAt')` : 'to_jsonb(x)';
      out[t] = (await run(`SELECT md5(${expr}::text) h FROM "${t}" x ORDER BY 1`)).map((r) => r.h);
    }
    return out;
  };
  const links = async () => (await q(`SELECT id, "supersededByScheduleId" AS s, "supersededAt" AS at FROM patrol_schedules WHERE "supersededByScheduleId" IS NOT NULL ORDER BY id`))
    .map((r: any) => [Number(r.id), Number(r.s), new Date(r.at).toISOString()]);

  try {
    // ── to 72, seed production-shaped rows: schedules (some replaced by the 1.2.1 code before 73), runs, exceptions, audit ──
    const at72 = new DataSource({
      type: 'postgres', url, entities: [], synchronize: false, migrations: through72, migrationsTableName: 'typeorm_migrations', logging: false,
    });
    await at72.initialize();
    await at72.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const applied72 = await at72.runMigrations({ transaction: 'each' });
    assert.equal(applied72[applied72.length - 1].name, MIGRATION_72);
    const one = async (sql: string, params: unknown[] = []) => (await at72.query(sql, params))[0];
    const ownerId = (await one(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m73.o@example.invalid','x','company_admin','active') RETURNING id`)).id;
    const ownerB = (await one(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m73.ob@example.invalid','x','company_admin','active') RETURNING id`)).id;
    const coA = (await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,'M73 A','73737373','1 Way','o@example.invalid',true) RETURNING id`, [ownerId])).id;
    const coB = (await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,'M73 B','73737374','2 Way','b@example.invalid',true) RETURNING id`, [ownerB])).id;
    const siteA1 = (await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'A1','2 Way') RETURNING id`, [coA])).id;
    const siteA2 = (await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'A2','3 Way') RETURNING id`, [coA])).id;
    const siteB1 = (await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'B1','4 Way') RETURNING id`, [coB])).id;
    const sch = async (companyId: number, siteId: number, name: string, archived: boolean) => Number((await one(
      `INSERT INTO patrol_schedules ("companyId","siteId",name,"activeFrom","activeTo","frequencyMinutes","windowMinutes",active,"archivedAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,'08:00','12:00',60,60,$4,$5,'2026-10-30T08:00:00Z','2026-10-30T08:00:00Z') RETURNING id`,
      [companyId, siteId, name, !archived, archived ? '2026-10-31T10:00:00Z' : null])).id);
    const superseded = (companyId: number, pred: number, succ: number, at: string) => at72.query(
      `INSERT INTO audit_logs ("companyId","userId",action,"entityType","entityId","afterData") VALUES ($1,$2,'patrol.schedule.superseded','patrol_schedule',$3,$4)`,
      [companyId, ownerId, pred, JSON.stringify({ successorId: succ, effectiveAt: at, reason: 'timing_changed' })]);
    const s1 = await sch(coA, siteA1, 'replaced', true);
    const s2 = await sch(coA, siteA1, 'successor', false);
    await superseded(coA, s1, s2, '2026-10-31T10:00:00.000Z'); // links
    const s3 = await sch(coA, siteA1, 'claims another site', true);
    const s4 = await sch(coA, siteA2, 'other site', false);
    await superseded(coA, s3, s4, '2026-10-31T10:00:00.000Z'); // another site: never linked
    const s5 = await sch(coA, siteA1, 'claims a taken successor', true);
    await superseded(coA, s5, s2, '2026-10-31T11:00:00.000Z'); // s2 already replaces s1: never linked
    const s6 = await sch(coA, siteA1, 'two entries', true);
    const s7 = await sch(coA, siteA1, 'first successor', false);
    const s8 = await sch(coA, siteA1, 'later successor', false);
    await superseded(coA, s6, s7, '2026-10-31T12:00:00.000Z'); // earliest wins
    await superseded(coA, s6, s8, '2026-10-31T13:00:00.000Z');
    const s9 = await sch(coA, siteA1, 'not archived', false);
    const s10 = await sch(coA, siteA1, 'its successor', false);
    await superseded(coA, s9, s10, '2026-10-31T14:00:00.000Z'); // an unarchived schedule is never linked
    const sB = await sch(coB, siteB1, 'company B', true);
    const sB2 = await sch(coB, siteB1, 'company B successor', false);
    await superseded(coB, sB, s7, '2026-10-31T15:00:00.000Z'); // another company: never linked
    await superseded(coB, sB, sB2, '2026-10-31T16:00:00.000Z'); // links: the earliest VALID entry for sB (B's own successor)
    // Runs and an exception on the replaced schedule (history the migration must not touch).
    const gu = (await one(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m73.g@example.invalid','x','guard','active') RETURNING id`)).id;
    const guard = (await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'M73 Guard','1000000000000073','07000000073') RETURNING id`, [gu])).id;
    const shift = (await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'x',$3,'completed','2026-10-31T06:00:00Z','2026-10-31T14:00:00Z') RETURNING id`,
      [coA, siteA1, guard])).id;
    await at72.query(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","scheduleId","windowKey","windowStart","windowEnd","startedAtDevice","clientRunId")
      VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-10-31T08:00:00Z','2026-10-31T09:00:00Z','2026-10-31T08:05:00Z','m73-run-0001')`, [coA, siteA1, shift, guard, gu, s1, `s${s1}:2026-10-31:0`]);
    await at72.query(`INSERT INTO patrol_exceptions ("companyId","siteId","scheduleId","shiftId","windowKey","scopeKey",type,"windowStart","windowEnd")
      VALUES ($1,$2,$3,$4,$5,'site','patrol_missed','2026-10-31T09:00:00Z','2026-10-31T10:00:00Z')`, [coA, siteA1, s1, shift, `s${s1}:2026-10-31:1`]);
    const before = await hashAll((sql) => at72.query(sql));
    const at72Schema = await schemaOf((sql) => at72.query(sql));
    await at72.destroy();

    await ds.initialize();
    const applied = await ds.runMigrations({ transaction: 'each' });
    const expectedLinks = [[s1, s2, '2026-10-31T10:00:00.000Z'], [s6, s7, '2026-10-31T12:00:00.000Z'], [sB, sB2, '2026-10-31T16:00:00.000Z']]
      .sort((a, b) => Number(a[0]) - Number(b[0]));

    await test('M73-01-A-72-DATABASE-MIGRATES-TO-73-AND-73-IS-LAST', () => {
      assert.deepEqual(applied.map((m) => m.name), [MIGRATION_73], 'only 73 is pending on a 72 database');
      assert.equal(allFiles.length, 74);
      assert.equal(allFiles[71], '1720900000018-AddPatrolSyncRecoveryGrants.ts', 'Migration 72 comes just before 73');
      assert.equal(allFiles[72], '1720900000020-AddPatrolScheduleSuccessors.ts', '1720900000019 is reserved by another branch');
      assert.equal(allFiles[73], '1720900000021-AddPatrolSiteSetup.ts', 'Migration 74 follows 73 and is certified by m74-migration.spec.ts');
    });
    const head = await schema();

    await test('M73-02-THE-SCHEMA-IT-ADDS-AND-NOTHING-ELSE', () => {
      assert.deepEqual(head.tables, at72Schema.tables, 'no table added');
      const cols = head.columns.filter((c: any) => c.table_name === 'patrol_schedules' && NEW_COLUMNS.includes(c.column_name));
      assert.deepEqual(cols.map((c: any) => [c.column_name, c.data_type, c.is_nullable, c.column_default]),
        [['supersededAt', 'timestamp with time zone', 'YES', null], ['supersededByScheduleId', 'integer', 'YES', null]]);
      assert.deepEqual(head.enums, at72Schema.enums, 'no enum added or changed');
      const [now73, was72] = [without73(head), without73(at72Schema)];
      for (const key of Object.keys(now73) as Array<keyof typeof now73>) {
        const added = (now73[key] as any[]).filter((x) => !(was72[key] as any[]).some((y) => JSON.stringify(y) === JSON.stringify(x)));
        const removed = (was72[key] as any[]).filter((x) => !(now73[key] as any[]).some((y) => JSON.stringify(y) === JSON.stringify(x)));
        assert.deepEqual({ added, removed }, { added: [], removed: [] }, `every other ${key} is unchanged: ${JSON.stringify({ added, removed })}`);
      }
      const def = (n: string) => head.constraints.find((c: any) => c.conname === n)?.def;
      assert.equal(def('CHK_patrol_schedules_superseded_pair'), 'CHECK ((("supersededByScheduleId" IS NULL) = ("supersededAt" IS NULL)))');
      assert.equal(def('CHK_patrol_schedules_superseded_not_self'), 'CHECK ((("supersededByScheduleId" IS NULL) OR ("supersededByScheduleId" <> id)))');
      assert.equal(def('CHK_patrol_schedules_superseded_archived'), 'CHECK ((("supersededByScheduleId" IS NULL) OR ("archivedAt" IS NOT NULL)))');
      assert.match(def('FK_patrol_schedules_superseded_by'),
        /FOREIGN KEY \("supersededByScheduleId", "companyId", "siteId"\) REFERENCES patrol_schedules\(id, "companyId", "siteId"\) ON DELETE RESTRICT/, 'same company AND site');
      const idx = (n: string) => head.indexes.find((i: any) => i.indexname === n)?.indexdef;
      assert.match(idx('UQ_patrol_schedules_superseded_by'), /CREATE UNIQUE INDEX .* \("supersededByScheduleId"\) WHERE \("supersededByScheduleId" IS NOT NULL\)/);
      assert.match(idx('IDX_patrol_schedules_superseded'), /\("companyId"\) WHERE \("supersededByScheduleId" IS NOT NULL\)/);
    });

    await test('M73-03-EVERY-ROW-KEEPS-ITS-VALUES-AND-ONLY-THE-AUDITED-LINKS-ARE-BACKFILLED', async () => {
      assert.deepEqual(await hashAll((sql) => q(sql)), before, 'no existing value changed (audit rows included)');
      assert.deepEqual(await links(), expectedLinks,
        'linked: s1→s2, s6→s7 (earliest entry), B\'s own; never another site (s3), a taken successor (s5), an unarchived schedule (s9) or another company');
    });

    await test('M73-04-A-SECOND-RUN-APPLIES-NOTHING-AND-UP-IS-REPEATABLE', async () => {
      assert.equal((await ds.runMigrations({ transaction: 'each' })).length, 0);
      const rows = await hashAll((sql) => q(sql));
      const { AddPatrolScheduleSuccessors1720900000020 } = await import('../src/database/migrations/1720900000020-AddPatrolScheduleSuccessors');
      const runner = ds.createQueryRunner();
      try {
        await new AddPatrolScheduleSuccessors1720900000020().up(runner);
      } finally {
        await runner.release();
      }
      assert.deepEqual(await schema(), head);
      assert.deepEqual(await hashAll((sql) => q(sql)), rows);
      assert.deepEqual(await links(), expectedLinks, 'the backfill is idempotent');
      assert.equal(await migrationCount(), 73);
    });

    await test('M73-05-THE-CONSTRAINTS-REFUSE-AN-INVALID-LINK', async () => {
      const link = (id: number, to: number | null, at: string | null = '2026-10-31T18:00:00Z') =>
        q(`UPDATE patrol_schedules SET "supersededByScheduleId" = $2, "supersededAt" = $3 WHERE id = $1`, [id, to, at]);
      await assert.rejects(() => link(s3, s3), /CHK_patrol_schedules_superseded_not_self/);
      await assert.rejects(() => link(s3, s4), /FK_patrol_schedules_superseded_by/, 'another site');
      await assert.rejects(() => link(s3, sB), /FK_patrol_schedules_superseded_by/, 'another company');
      await assert.rejects(() => link(s3, 999999), /FK_patrol_schedules_superseded_by/, 'a missing schedule');
      await assert.rejects(() => link(s9, s10), /CHK_patrol_schedules_superseded_archived/, 'an unarchived schedule');
      await assert.rejects(() => link(s3, s10, null), /CHK_patrol_schedules_superseded_pair/);
      await assert.rejects(() => link(s3, null), /CHK_patrol_schedules_superseded_pair/);
      await assert.rejects(() => link(s5, s2), /UQ_patrol_schedules_superseded_by/, 'one predecessor per successor');
      await assert.rejects(() => q(`DELETE FROM patrol_schedules WHERE id = $1`, [s7]), /FK_patrol_schedules_superseded_by/, 'a linked successor is never deleted');
      await link(s3, s10); // valid: same company and site, archived, unused successor
      await link(s3, null, null);
      assert.deepEqual(await links(), expectedLinks);
    });

    await test('M73-06-DOWN-REFUSES-WHILE-LINKS-EXIST', async () => {
      const snapshot = await hashAll((sql) => q(sql));
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /Refusing to revert AddPatrolScheduleSuccessors1720900000020: 3 patrol schedule successor link/);
      assert.equal(await migrationCount(), 73);
      assert.deepEqual(await schema(), head, 'nothing changed');
      assert.deepEqual(await hashAll((sql) => q(sql)), snapshot);
      assert.deepEqual(await links(), expectedLinks);
    });

    await test('M73-07-DOWN-REMOVES-EXACTLY-WHAT-73-ADDED-AND-RE-APPLY-RESTORES-IT', async () => {
      await q(`UPDATE patrol_schedules SET "supersededByScheduleId" = NULL, "supersededAt" = NULL`);
      const rows = await hashAll((sql) => q(sql));
      await ds.undoLastMigration({ transaction: 'each' });
      assert.equal(await migrationCount(), 72);
      const back = await schema();
      assert.deepEqual(back.tables, at72Schema.tables);
      assert.deepEqual(back.columns, at72Schema.columns);
      assert.deepEqual(back.constraints, at72Schema.constraints);
      assert.deepEqual(back.indexes, at72Schema.indexes);
      assert.deepEqual(back.enums, at72Schema.enums);
      assert.deepEqual(await hashAll((sql) => q(sql)), rows, 'existing rows survive the round trip');
      await ds.runMigrations({ transaction: 'each' });
      assert.deepEqual(await schema(), head);
      assert.deepEqual(await links(), expectedLinks, 're-applying backfills the same links from the audit trail');
    });

    await test('M73-08-NO-SEMANTIC-DRIFT', async () => {
      const drift = (await ds.driver.createSchemaBuilder().log()).upQueries.map((x) => x.query);
      // Migration 74 (1720900000021, certified by m74-migration.spec.ts) follows 73: its columns and indexes are not drift here.
      const m74 = /^ALTER TABLE "(patrol_policies|patrol_schedules|patrol_routes|patrol_checkpoints|shifts)" ADD "(setupMode|windowAnchor|setupConfirmedAt|setupConfirmedByUserId|anchor|kind|supersededByRouteId|supersededAt|confirmedAt|confirmedByUserId|confirmedTokenVersion|patrolRequirement)" |^CREATE (UNIQUE )?INDEX "(UQ_patrol_routes_superseded_by|IDX_patrol_routes_superseded)" /;
      const semantic = drift.filter((x) => !m74.test(x) &&
        /CREATE TABLE|DROP TABLE|CREATE TYPE|DROP TYPE|ALTER TYPE|ALTER TABLE.*ALTER COLUMN|ALTER TABLE.*DROP COLUMN|ALTER TABLE.*ADD "/i.test(x));
      assert.deepEqual(semantic, [], `semantic drift (the release gate would fail):\n${semantic.join('\n')}`);
      const ours = drift.filter((x) => /patrol_schedules.*superseded|_patrol_schedules_superseded/i.test(x));
      // The CHECKs and the composite foreign key live in the migration only, as for the other patrol constraints; the
      // columns and both indexes agree with the entity.
      const unexpected = ours.filter((x) => !/^ALTER TABLE "patrol_schedules" DROP CONSTRAINT "(FK|CHK)_patrol_schedules_superseded_/.test(x));
      assert.deepEqual(unexpected, [], `entity and migration 73 disagree:\n${unexpected.join('\n')}`);
      console.log(`      (diagnostic-only drift: ${drift.length} statement(s), of which ${ours.length} are Migration 73 FK / CHECK names)`);
    });

    await test('M73-09-ROLLBACK-COMPATIBLE-WITH-THE-PREVIOUS-RELEASES', async () => {
      const previous = new DataSource({
        type: 'postgres', url, entities: [], synchronize: false, migrations: through72, migrationsTableName: 'typeorm_migrations', logging: false,
      });
      await previous.initialize();
      try {
        assert.equal((await previous.runMigrations({ transaction: 'each' })).length, 0, 'the previous release finds nothing to run');
        // 1.2.0 (4f4de31) schedule writes and reads, which never name the new columns.
        const [created] = await previous.query(`INSERT INTO patrol_schedules ("companyId","siteId","routeId",name,"daysOfWeek","activeFrom","activeTo","frequencyMinutes","windowMinutes","startsOn","endsOn",active,"createdByUserId","updatedByUserId")
          VALUES ($1,$2,NULL,'1.2.0 schedule','[1,2,3]'::jsonb,'22:00','06:00',60,60,NULL,NULL,true,$3,$3) RETURNING *`, [coA, siteA1, ownerId]);
        assert.deepEqual([created.supersededByScheduleId, created.supersededAt], [null, null], 'SELECT * / RETURNING * just carries two null keys');
        await previous.query(`UPDATE patrol_schedules SET "frequencyMinutes" = 30, "windowMinutes" = 30, "updatedAt" = now() WHERE id = $1`, [created.id]);
        await previous.query(`UPDATE patrol_schedules SET active = false, "archivedAt" = now(), "updatedAt" = now() WHERE id = $1`, [created.id]);
        const listed = await previous.query(`SELECT * FROM patrol_schedules WHERE "companyId" = $1 AND "archivedAt" IS NULL ORDER BY id`, [coA]);
        assert.ok(listed.some((r: any) => Number(r.id) === s2) && !listed.some((r: any) => Number(r.id) === s1),
          'a replaced schedule stays archived (hidden) and its successor is an ordinary active schedule');
      } finally {
        await previous.destroy();
      }
      assert.equal(await migrationCount(), 73);
    });
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`);
  console.log(JSON.stringify({ event: 'm73_migration_certified', tests: passed }));
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
