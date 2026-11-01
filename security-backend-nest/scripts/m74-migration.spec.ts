/**
 * Migration 74 (AddPatrolSiteSetup1720900000021, S4 1.3.0 B1 patrol site setup) certification, on a disposable database
 * built from the repository's own migrations. (74 follows Migration 73 = 1720900000020, AddPatrolScheduleSuccessors;
 * 1720900000019 stays reserved by another branch.)
 *
 *   M74-01  a database at 73 migrates to 74 and 74 is the last migration
 *   M74-02  the schema it adds and nothing else: shifts."patrolRequirement"; patrol_policies setupMode / windowAnchor /
 *           setupConfirmedAt / setupConfirmedByUserId; patrol_schedules.anchor (NOT NULL DEFAULT 'clock'); patrol_routes
 *           kind (NOT NULL DEFAULT 'custom') / supersededByRouteId / supersededAt; patrol_checkpoints confirmedAt /
 *           confirmedByUserId / confirmedTokenVersion; their CHECKs and foreign keys, a partial unique index and a partial
 *           index; no other table, column, constraint, index or enum changes
 *   M74-03  a populated 73 database (schedules with a successor, routes, checkpoints, runs flagged qr_rule_missing,
 *           exceptions, evidence, holds, audit) keeps every row's values; the new columns read clock / custom / NULL
 *   M74-04  a second run applies nothing; re-running up() changes nothing
 *   M74-05  the constraints refuse invalid data (values, half pairs, self links, unarchived or other-site / other-company
 *           / missing successors, a second predecessor, deleting a linked successor, a partial confirmation)
 *   M74-06  down() refuses while any 1.3.0 data exists, naming it, and changes nothing
 *   M74-07  down() with none removes exactly what 74 added; re-applying restores the identical schema
 *   M74-08  no semantic entity-to-migration drift at 74 (FK / CHECK names live in the migration only)
 *   M74-09  rollback compatibility with 1.2.1 (5d749fa): the previous migrations are a no-op on a 74 database; 1.2.1-shaped
 *           reads and writes (SELECT *, INSERTs / UPDATEs that never name the columns) work and get clock / custom /
 *           NULL; the clock window engine (unchanged since 1.2.1) yields NO window for a shift-anchored schedule row as
 *           1.3.0 writes it (current or superseded), and 1.2.1's own schedule queries never select it as active
 *
 * Needs M74_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.M74_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M74_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('M74 database must be local');

const MIGRATION_73 = 'AddPatrolScheduleSuccessors1720900000020';
const MIGRATION_74 = 'AddPatrolSiteSetup1720900000021';
const NEW_COLUMNS: Record<string, string[]> = {
  shifts: ['patrolRequirement'],
  patrol_policies: ['setupMode', 'windowAnchor', 'setupConfirmedAt', 'setupConfirmedByUserId'],
  patrol_schedules: ['anchor'],
  patrol_routes: ['kind', 'supersededByRouteId', 'supersededAt'],
  patrol_checkpoints: ['confirmedAt', 'confirmedByUserId', 'confirmedTokenVersion'],
};
const NEW_CONSTRAINTS = [
  'CHK_shifts_patrol_requirement', 'CHK_patrol_policies_setup_mode', 'CHK_patrol_policies_window_anchor', 'CHK_patrol_policies_setup_confirmed',
  'FK_patrol_policies_setup_confirmed_by', 'CHK_patrol_schedules_anchor', 'CHK_patrol_routes_kind', 'CHK_patrol_routes_superseded_pair',
  'CHK_patrol_routes_superseded_not_self', 'CHK_patrol_routes_superseded_archived', 'FK_patrol_routes_superseded_by',
  'CHK_patrol_checkpoints_confirmed', 'FK_patrol_checkpoints_confirmed_by',
];
const NEW_INDEXES = ['UQ_patrol_routes_superseded_by', 'IDX_patrol_routes_superseded'];
/** PostgreSQL 18 also catalogues a NOT NULL column as a constraint ({table}_{column}_not_null); 16 does not. */
const PG18_NOT_NULL = ['patrol_routes_kind_not_null', 'patrol_schedules_anchor_not_null'];

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
  const through73 = allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000020).map((f) => path.join(migrationsDir, f));
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: false,
    migrations: allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000021).map((f) => path.join(migrationsDir, f)),
    migrationsTableName: 'typeorm_migrations', logging: false,
  });
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const migrationCount = async () => Number((await one('SELECT count(*)::int AS n FROM typeorm_migrations')).n);

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
  const isNewColumn = (c: any) => (NEW_COLUMNS[c.table_name] ?? []).includes(c.column_name);
  const without74 = (s: Awaited<ReturnType<typeof schema>>) => ({
    tables: s.tables,
    columns: s.columns.filter((c: any) => !isNewColumn(c)),
    constraints: s.constraints.filter((c: any) => !NEW_CONSTRAINTS.includes(c.conname) && !PG18_NOT_NULL.includes(c.conname)),
    indexes: s.indexes.filter((i: any) => !NEW_INDEXES.includes(i.indexname)),
    enums: s.enums,
  });
  /** Every row of every table, as hashes, without Migration 74's columns. */
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
    // ── to 73, seed production-shaped rows (as the 1.2.1 pilot holds them) ──
    const at73 = new DataSource({ type: 'postgres', url, entities: [], synchronize: false, migrations: through73, migrationsTableName: 'typeorm_migrations', logging: false });
    await at73.initialize();
    await at73.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const applied73 = await at73.runMigrations({ transaction: 'each' });
    assert.equal(applied73[applied73.length - 1].name, MIGRATION_73);
    const o = async (sql: string, params: unknown[] = []) => (await at73.query(sql, params))[0];
    const ownerId = (await o(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m74.o@example.invalid','x','company_admin','active') RETURNING id`)).id;
    const ownerB = (await o(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m74.ob@example.invalid','x','company_admin','active') RETURNING id`)).id;
    const coA = (await o(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,'M74 A','74747474','1 Way','o@example.invalid',true) RETURNING id`, [ownerId])).id;
    const coB = (await o(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,'M74 B','74747475','2 Way','b@example.invalid',true) RETURNING id`, [ownerB])).id;
    const siteA1 = (await o(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'A1','2 Way') RETURNING id`, [coA])).id;
    const siteA2 = (await o(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'A2','3 Way') RETURNING id`, [coA])).id;
    const siteB1 = (await o(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'B1','4 Way') RETURNING id`, [coB])).id;
    await at73.query(`INSERT INTO patrol_policies ("companyId","siteId",methods,"photosPerRun") VALUES ($1,$2,'["qr"]'::jsonb,0)`, [coA, siteA1]);
    const cp = async (companyId: number, siteId: number, label: string) => Number((await o(
      `INSERT INTO patrol_checkpoints ("companyId","siteId","publicId",label) VALUES ($1,$2,md5($3),$3) RETURNING id`, [companyId, siteId, `${companyId}-${siteId}-${label}`])).id);
    const cpA1 = await cp(coA, siteA1, 'Gate 1'); // never confirmed (the pilot's checkpoint)
    const cpA2 = await cp(coA, siteA1, 'Gate 2');
    const route = async (companyId: number, siteId: number, name: string, archived = false) => Number((await o(
      `INSERT INTO patrol_routes ("companyId","siteId",name,active,"archivedAt") VALUES ($1,$2,$3,$4,$5) RETURNING id`, [companyId, siteId, name, !archived, archived ? '2026-10-31T09:00:00Z' : null])).id);
    const rA1 = await route(coA, siteA1, 'Perimeter');
    const rA1b = await route(coA, siteA1, 'Old perimeter', true);
    const rA2 = await route(coA, siteA2, 'Annex');
    const rB1 = await route(coB, siteB1, 'B route');
    await at73.query(`INSERT INTO patrol_route_checkpoints ("companyId","siteId","routeId","checkpointId",position) VALUES ($1,$2,$3,$4,1),($1,$2,$3,$5,2)`, [coA, siteA1, rA1, cpA1, cpA2]);
    const sch = async (name: string, archived: boolean, routeId: number | null) => Number((await o(
      `INSERT INTO patrol_schedules ("companyId","siteId","routeId",name,"activeFrom","activeTo","frequencyMinutes","windowMinutes",active,"archivedAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,'08:00','12:00',60,60,$5,$6,'2026-10-30T08:00:00Z','2026-10-30T08:00:00Z') RETURNING id`,
      [coA, siteA1, routeId, name, !archived, archived ? '2026-10-31T10:00:00Z' : null])).id);
    const s1 = await sch('replaced', true, null);
    const s2 = await sch('successor', false, null);
    await at73.query(`UPDATE patrol_schedules SET "supersededByScheduleId" = $2, "supersededAt" = '2026-10-31T10:00:00Z' WHERE id = $1`, [s1, s2]);
    const s3 = await sch('with route', false, rA1);
    const gu = (await o(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m74.g@example.invalid','x','guard','active') RETURNING id`)).id;
    const guard = (await o(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'M74 Guard','1000000000000074','07000000074') RETURNING id`, [gu])).id;
    const shift = (await o(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'x',$3,'completed','2026-10-31T06:00:00Z','2026-10-31T14:00:00Z') RETURNING id`,
      [coA, siteA1, guard])).id;
    const run = (await o(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","scheduleId","routeId","windowKey","windowStart","windowEnd","startedAtDevice","clientRunId",
        status,"completedAtServer","syncFlags","needsReview")
      VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,'2026-10-31T08:00:00Z','2026-10-31T09:00:00Z','2026-10-31T08:05:00Z','m74-run-0001','completed','2026-10-31T08:30:00Z','["qr_rule_missing"]'::jsonb,true) RETURNING id`,
      [coA, siteA1, shift, guard, gu, s1, `s${s1}:2026-10-31:0`])).id;
    await at73.query(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","scheduleId","routeId","startedAtDevice","clientRunId")
      VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-10-31T10:05:00Z','m74-run-0002')`, [coA, siteA1, shift, guard, gu, s3, rA1]);
    await at73.query(`INSERT INTO patrol_exceptions ("companyId","siteId","scheduleId","shiftId","windowKey","scopeKey",type,"windowStart","windowEnd")
      VALUES ($1,$2,$3,$4,$5,'site','patrol_missed','2026-10-31T09:00:00Z','2026-10-31T10:00:00Z')`, [coA, siteA1, s1, shift, `s${s1}:2026-10-31:1`]);
    await at73.query(`INSERT INTO patrol_evidence ("companyId","siteId","runId","guardId","shiftId",kind,"storageKey","mimeType","sha256Client","capturedAtDevice","clientEvidenceId")
      VALUES ($1,$2,$3,$4,$5,'run_photo','patrol/evidence/x/1.jpg','image/jpeg',repeat('a',64),'2026-10-31T08:10:00Z','m74-ev-00001')`, [coA, siteA1, run, guard, shift]);
    await at73.query(`INSERT INTO patrol_evidence_holds ("companyId",scope,"runId",reason,source,"createdByUserId") VALUES ($1,'run',$2,'incident','manual',$3)`, [coA, run, ownerId]);
    await at73.query(`INSERT INTO audit_logs ("companyId","userId",action,"entityType","entityId","afterData") VALUES ($1,$2,'patrol.route.created','patrol_route',$3,'{}'::jsonb)`, [coA, ownerId, rA1]);
    const before = await hashAll((sql) => at73.query(sql));
    const at73Schema = await schemaOf((sql) => at73.query(sql));
    await at73.destroy();

    await ds.initialize();
    const applied = await ds.runMigrations({ transaction: 'each' });

    await test('M74-01-A-73-DATABASE-MIGRATES-TO-74-AND-74-IS-LAST', () => {
      assert.deepEqual(applied.map((m) => m.name), [MIGRATION_74], 'only 74 is pending on a 73 database');
      assert.equal(allFiles.length, 74);
      assert.equal(allFiles[72], '1720900000020-AddPatrolScheduleSuccessors.ts', 'Migration 73 comes just before 74');
      assert.equal(allFiles[73], '1720900000021-AddPatrolSiteSetup.ts', 'Migration 74 = 1720900000021 (1720900000019 stays reserved)');
      assert.ok(!allFiles.some((f) => f.startsWith('1720900000019-')), 'no file takes the reserved timestamp');
    });
    const head = await schema();

    await test('M74-02-THE-SCHEMA-IT-ADDS-AND-NOTHING-ELSE', () => {
      assert.deepEqual(head.tables, at73Schema.tables, 'no table added');
      assert.deepEqual(head.enums, at73Schema.enums, 'no enum added or changed');
      const cols = head.columns.filter(isNewColumn).map((c: any) => [c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default, c.character_maximum_length]);
      assert.deepEqual(cols, [
        ['patrol_checkpoints', 'confirmedAt', 'timestamp with time zone', 'YES', null, null],
        ['patrol_checkpoints', 'confirmedByUserId', 'integer', 'YES', null, null],
        ['patrol_checkpoints', 'confirmedTokenVersion', 'integer', 'YES', null, null],
        ['patrol_policies', 'setupConfirmedAt', 'timestamp with time zone', 'YES', null, null],
        ['patrol_policies', 'setupConfirmedByUserId', 'integer', 'YES', null, null],
        ['patrol_policies', 'setupMode', 'character varying', 'YES', null, 16],
        ['patrol_policies', 'windowAnchor', 'character varying', 'YES', null, 16],
        ['patrol_routes', 'kind', 'character varying', 'NO', "'custom'::character varying", 16],
        ['patrol_routes', 'supersededAt', 'timestamp with time zone', 'YES', null, null],
        ['patrol_routes', 'supersededByRouteId', 'integer', 'YES', null, null],
        ['patrol_schedules', 'anchor', 'character varying', 'NO', "'clock'::character varying", 16],
        ['shifts', 'patrolRequirement', 'character varying', 'YES', null, 16],
      ]);
      const [now74, was73] = [without74(head), without74(at73Schema)];
      for (const key of Object.keys(now74) as Array<keyof typeof now74>) {
        const added = (now74[key] as any[]).filter((x) => !(was73[key] as any[]).some((y) => JSON.stringify(y) === JSON.stringify(x)));
        const removed = (was73[key] as any[]).filter((x) => !(now74[key] as any[]).some((y) => JSON.stringify(y) === JSON.stringify(x)));
        assert.deepEqual({ added, removed }, { added: [], removed: [] }, `every other ${key} is unchanged: ${JSON.stringify({ added, removed })}`);
      }
      const def = (n: string) => head.constraints.find((c: any) => c.conname === n)?.def;
      for (const n of NEW_CONSTRAINTS) assert.ok(def(n), `${n} exists`);
      assert.match(def('CHK_shifts_patrol_requirement'), /'required'.*'not_required'/);
      assert.match(def('CHK_patrol_policies_setup_mode'), /'off'.*'every_shift'.*'per_shift'/);
      assert.match(def('CHK_patrol_policies_window_anchor'), /'scheduled_start'.*'book_on'/);
      assert.match(def('CHK_patrol_schedules_anchor'), /anchor.*'clock'.*'shift'/);
      assert.match(def('CHK_patrol_routes_kind'), /kind.*'custom'.*'auto'/);
      assert.match(def('CHK_patrol_checkpoints_confirmed'), /"confirmedAt" IS NULL.*"confirmedByUserId" IS NULL.*"confirmedTokenVersion" IS NULL.*"confirmedTokenVersion" >= 1/);
      assert.match(def('CHK_patrol_policies_setup_confirmed'), /"setupConfirmedAt" IS NULL.*"setupConfirmedByUserId" IS NULL/);
      assert.equal(def('CHK_patrol_routes_superseded_pair'), 'CHECK ((("supersededByRouteId" IS NULL) = ("supersededAt" IS NULL)))');
      assert.equal(def('CHK_patrol_routes_superseded_not_self'), 'CHECK ((("supersededByRouteId" IS NULL) OR ("supersededByRouteId" <> id)))');
      assert.equal(def('CHK_patrol_routes_superseded_archived'), 'CHECK ((("supersededByRouteId" IS NULL) OR ("archivedAt" IS NOT NULL)))');
      assert.match(def('FK_patrol_routes_superseded_by'),
        /FOREIGN KEY \("supersededByRouteId", "companyId", "siteId"\) REFERENCES patrol_routes\(id, "companyId", "siteId"\) ON DELETE RESTRICT/, 'same company AND site');
      assert.match(def('FK_patrol_checkpoints_confirmed_by'), /FOREIGN KEY \("confirmedByUserId"\) REFERENCES users\(id\) ON DELETE RESTRICT/);
      assert.match(def('FK_patrol_policies_setup_confirmed_by'), /FOREIGN KEY \("setupConfirmedByUserId"\) REFERENCES users\(id\) ON DELETE RESTRICT/);
      const idx = (n: string) => head.indexes.find((i: any) => i.indexname === n)?.indexdef;
      assert.match(idx('UQ_patrol_routes_superseded_by'), /CREATE UNIQUE INDEX .* \("supersededByRouteId"\) WHERE \("supersededByRouteId" IS NOT NULL\)/);
      assert.match(idx('IDX_patrol_routes_superseded'), /\("companyId"\) WHERE \("supersededByRouteId" IS NOT NULL\)/);
    });

    await test('M74-03-EVERY-ROW-KEEPS-ITS-VALUES-AND-THE-NEW-COLUMNS-READ-CLOCK-CUSTOM-NULL', async () => {
      assert.deepEqual(await hashAll((sql) => q(sql)), before, 'no existing value changed (audit rows, runs, evidence and holds included)');
      assert.deepEqual((await q(`SELECT DISTINCT anchor FROM patrol_schedules`)).map((r: any) => r.anchor), ['clock']);
      assert.deepEqual((await q(`SELECT DISTINCT kind FROM patrol_routes`)).map((r: any) => r.kind), ['custom']);
      assert.equal(Number((await one(`SELECT count(*)::int n FROM patrol_routes WHERE "supersededByRouteId" IS NOT NULL OR "supersededAt" IS NOT NULL`)).n), 0);
      assert.equal(Number((await one(`SELECT count(*)::int n FROM patrol_checkpoints WHERE "confirmedAt" IS NOT NULL OR "confirmedByUserId" IS NOT NULL OR "confirmedTokenVersion" IS NOT NULL`)).n), 0);
      assert.equal(Number((await one(`SELECT count(*)::int n FROM patrol_policies WHERE "setupMode" IS NOT NULL OR "windowAnchor" IS NOT NULL OR "setupConfirmedAt" IS NOT NULL`)).n), 0);
      assert.equal(Number((await one(`SELECT count(*)::int n FROM shifts WHERE "patrolRequirement" IS NOT NULL`)).n), 0);
      const pilotRun = await one(`SELECT "syncFlags", "needsReview", "routeId" FROM patrol_runs WHERE id = $1`, [run]);
      assert.deepEqual([pilotRun.syncFlags, pilotRun.needsReview, pilotRun.routeId], [['qr_rule_missing'], true, null], 'the qr_rule_missing run is as it was');
      assert.deepEqual(await one(`SELECT "supersededByScheduleId" AS s FROM patrol_schedules WHERE id = $1`, [s1]), { s: s2 }, 'the schedule successor link is kept');
    });

    await test('M74-04-A-SECOND-RUN-APPLIES-NOTHING-AND-UP-IS-REPEATABLE', async () => {
      assert.equal((await ds.runMigrations({ transaction: 'each' })).length, 0);
      const rows = await hashAll((sql) => q(sql));
      const { AddPatrolSiteSetup1720900000021 } = await import('../src/database/migrations/1720900000021-AddPatrolSiteSetup');
      const runner = ds.createQueryRunner();
      try {
        await new AddPatrolSiteSetup1720900000021().up(runner);
      } finally {
        await runner.release();
      }
      assert.deepEqual(await schema(), head);
      assert.deepEqual(await hashAll((sql) => q(sql)), rows);
      assert.equal(await migrationCount(), 74);
    });

    await test('M74-05-THE-CONSTRAINTS-REFUSE-INVALID-DATA', async () => {
      await assert.rejects(() => q(`UPDATE shifts SET "patrolRequirement" = 'maybe' WHERE id = $1`, [shift]), /CHK_shifts_patrol_requirement/);
      await assert.rejects(() => q(`UPDATE patrol_policies SET "setupMode" = 'sometimes'`), /CHK_patrol_policies_setup_mode/);
      await assert.rejects(() => q(`UPDATE patrol_policies SET "windowAnchor" = 'lunch'`), /CHK_patrol_policies_window_anchor/);
      await assert.rejects(() => q(`UPDATE patrol_policies SET "setupConfirmedAt" = now()`), /CHK_patrol_policies_setup_confirmed/, 'activation needs who');
      await assert.rejects(() => q(`UPDATE patrol_policies SET "setupConfirmedAt" = now(), "setupConfirmedByUserId" = 999999`), /FK_patrol_policies_setup_confirmed_by/);
      await assert.rejects(() => q(`UPDATE patrol_schedules SET anchor = 'tide' WHERE id = $1`, [s3]), /CHK_patrol_schedules_anchor/);
      await assert.rejects(() => q(`UPDATE patrol_schedules SET anchor = NULL WHERE id = $1`, [s3]), /null value|not-null/);
      await assert.rejects(() => q(`UPDATE patrol_routes SET kind = 'magic' WHERE id = $1`, [rA1]), /CHK_patrol_routes_kind/);
      const link = (id: number, to: number | null, at: string | null = '2026-10-31T18:00:00Z') =>
        q(`UPDATE patrol_routes SET "supersededByRouteId" = $2, "supersededAt" = $3 WHERE id = $1`, [id, to, at]);
      await assert.rejects(() => link(rA1b, rA1b), /CHK_patrol_routes_superseded_not_self/);
      await assert.rejects(() => link(rA1b, rA2), /FK_patrol_routes_superseded_by/, 'another site');
      await assert.rejects(() => link(rA1b, rB1), /FK_patrol_routes_superseded_by/, 'another company');
      await assert.rejects(() => link(rA1b, 999999), /FK_patrol_routes_superseded_by/, 'a missing route');
      await assert.rejects(() => link(rA1, rA1b), /CHK_patrol_routes_superseded_archived/, 'an unarchived route');
      await assert.rejects(() => link(rA1b, rA1, null), /CHK_patrol_routes_superseded_pair/);
      await link(rA1b, rA1); // valid: archived, same company and site
      const rA1c = await (async () => Number((await one(`INSERT INTO patrol_routes ("companyId","siteId",name,active,"archivedAt") VALUES ($1,$2,'third',false,now()) RETURNING id`, [coA, siteA1])).id))();
      await assert.rejects(() => link(rA1c, rA1), /UQ_patrol_routes_superseded_by/, 'one predecessor per successor');
      await link(rA1b, null, null);
      // A successor referenced by nothing but its link is still never deleted (the link's own foreign key).
      const lone = Number((await one(`INSERT INTO patrol_routes ("companyId","siteId",name) VALUES ($1,$2,'lone successor') RETURNING id`, [coA, siteA1])).id);
      await link(rA1c, lone);
      await assert.rejects(() => q(`DELETE FROM patrol_routes WHERE id = $1`, [lone]), /FK_patrol_routes_superseded_by/, 'a linked successor is never deleted');
      await link(rA1c, null, null);
      await q(`DELETE FROM patrol_routes WHERE id = ANY($1::int[])`, [[rA1c, lone]]);
      await assert.rejects(() => q(`UPDATE patrol_checkpoints SET "confirmedAt" = now() WHERE id = $1`, [cpA1]), /CHK_patrol_checkpoints_confirmed/, 'all three or none');
      await assert.rejects(() => q(`UPDATE patrol_checkpoints SET "confirmedAt" = now(), "confirmedByUserId" = $2, "confirmedTokenVersion" = 0 WHERE id = $1`, [cpA1, ownerId]), /CHK_patrol_checkpoints_confirmed/, 'a version ≥ 1');
      await assert.rejects(() => q(`UPDATE patrol_checkpoints SET "confirmedAt" = now(), "confirmedByUserId" = 999999, "confirmedTokenVersion" = 1 WHERE id = $1`, [cpA1]), /FK_patrol_checkpoints_confirmed_by/);
    });

    await test('M74-06-DOWN-REFUSES-WHILE-1.3.0-DATA-EXISTS', async () => {
      await q(`UPDATE shifts SET "patrolRequirement" = 'required' WHERE id = $1`, [shift]);
      await q(`UPDATE patrol_checkpoints SET "confirmedAt" = now(), "confirmedByUserId" = $2, "confirmedTokenVersion" = 1 WHERE id = $1`, [cpA2, ownerId]);
      const snapshot = await hashAll((sql) => q(sql));
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }),
        /Refusing to revert AddPatrolSiteSetup1720900000021: 1 shift patrol requirement\(s\), 1 confirmed checkpoint\(s\) exist/);
      assert.equal(await migrationCount(), 74);
      assert.deepEqual(await schema(), head, 'nothing changed');
      assert.deepEqual(await hashAll((sql) => q(sql)), snapshot);
      await q(`UPDATE shifts SET "patrolRequirement" = NULL`);
      await q(`UPDATE patrol_checkpoints SET "confirmedAt" = NULL, "confirmedByUserId" = NULL, "confirmedTokenVersion" = NULL`);
      for (const [sql, what] of [
        [`UPDATE patrol_policies SET "setupMode" = 'off'`, /patrol site setup/],
        [`UPDATE patrol_schedules SET anchor = 'shift' WHERE id = ${s3}`, /shift-anchored patrol schedule/],
        [`UPDATE patrol_routes SET kind = 'auto' WHERE id = ${rA1}`, /automatic or versioned patrol route/],
      ] as Array<[string, RegExp]>) {
        await q(sql);
        await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), what);
        await q(`UPDATE patrol_policies SET "setupMode" = NULL`);
        await q(`UPDATE patrol_schedules SET anchor = 'clock'`);
        await q(`UPDATE patrol_routes SET kind = 'custom'`);
      }
      assert.equal(await migrationCount(), 74);
    });

    await test('M74-07-DOWN-REMOVES-EXACTLY-WHAT-74-ADDED-AND-RE-APPLY-RESTORES-IT', async () => {
      const rows = await hashAll((sql) => q(sql));
      await ds.undoLastMigration({ transaction: 'each' });
      assert.equal(await migrationCount(), 73);
      const back = await schema();
      assert.deepEqual(back.tables, at73Schema.tables);
      assert.deepEqual(back.columns, at73Schema.columns);
      assert.deepEqual(back.constraints, at73Schema.constraints);
      assert.deepEqual(back.indexes, at73Schema.indexes);
      assert.deepEqual(back.enums, at73Schema.enums);
      assert.deepEqual(await hashAll((sql) => q(sql)), rows, 'existing rows survive the round trip');
      await ds.runMigrations({ transaction: 'each' });
      assert.deepEqual(await schema(), head);
    });

    await test('M74-08-NO-SEMANTIC-DRIFT', async () => {
      const drift = (await ds.driver.createSchemaBuilder().log()).upQueries.map((x) => x.query);
      const semantic = drift.filter((x) =>
        /CREATE TABLE|DROP TABLE|CREATE TYPE|DROP TYPE|ALTER TYPE|ALTER TABLE.*ALTER COLUMN|ALTER TABLE.*DROP COLUMN|ALTER TABLE.*ADD "/i.test(x));
      assert.deepEqual(semantic, [], `semantic drift (the release gate would fail):\n${semantic.join('\n')}`);
      const ours = drift.filter((x) => NEW_CONSTRAINTS.some((n) => x.includes(`"${n}"`)) || NEW_INDEXES.some((n) => x.includes(`"${n}"`)));
      // The CHECKs and foreign keys live in the migration only, as for the other patrol constraints; the columns and both
      // indexes agree with the entities.
      const unexpected = ours.filter((x) => !/DROP CONSTRAINT "(FK|CHK)_/.test(x));
      assert.deepEqual(unexpected, [], `entity and migration 74 disagree:\n${unexpected.join('\n')}`);
      console.log(`      (diagnostic-only drift: ${drift.length} statement(s), of which ${ours.length} are Migration 74 FK / CHECK names)`);
    });

    await test('M74-09-ROLLBACK-COMPATIBLE-WITH-1.2.1', async () => {
      const previous = new DataSource({ type: 'postgres', url, entities: [], synchronize: false, migrations: through73, migrationsTableName: 'typeorm_migrations', logging: false });
      await previous.initialize();
      try {
        assert.equal((await previous.runMigrations({ transaction: 'each' })).length, 0, 'the previous release finds nothing to run');
        // 1.2.1 writes, which never name the new columns.
        const [schedule] = await previous.query(`INSERT INTO patrol_schedules ("companyId","siteId","routeId",name,"daysOfWeek","activeFrom","activeTo","frequencyMinutes","windowMinutes","startsOn","endsOn",active,"createdByUserId","updatedByUserId")
          VALUES ($1,$2,NULL,'1.2.1 schedule','[1,2,3]'::jsonb,'22:00','06:00',60,60,NULL,NULL,true,$3,$3) RETURNING *`, [coA, siteA1, ownerId]);
        assert.equal(schedule.anchor, 'clock', 'a 1.2.1 schedule is a clock schedule');
        const [r] = await previous.query(`INSERT INTO patrol_routes ("companyId","siteId",name,"orderMode","createdByUserId","updatedByUserId") VALUES ($1,$2,'1.2.1 route','any',$3,$3) RETURNING *`, [coA, siteA1, ownerId]);
        assert.deepEqual([r.kind, r.supersededByRouteId, r.supersededAt], ['custom', null, null]);
        const [c] = await previous.query(`INSERT INTO patrol_checkpoints ("companyId","siteId","publicId",label,"createdByUserId","updatedByUserId") VALUES ($1,$2,md5('m74-121'),'1.2.1 cp',$3,$3) RETURNING *`, [coA, siteA1, ownerId]);
        assert.deepEqual([c.confirmedAt, c.confirmedByUserId, c.confirmedTokenVersion], [null, null, null]);
        await previous.query(`UPDATE patrol_checkpoints SET "tokenVersion" = "tokenVersion" + 1, "rotatedAt" = now() WHERE id = $1`, [c.id]);
        const [sh] = await previous.query(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'x',$3,'ready','2026-11-02T06:00:00Z','2026-11-02T14:00:00Z') RETURNING *`, [coA, siteA1, guard]);
        assert.equal(sh.patrolRequirement, null, 'a 1.2.1 shift is "site default"');

        // A shift-anchored schedule exactly as 1.3.0 writes it (PatrolSetupService), current and superseded.
        const shiftRow = async (archived: boolean) => (await previous.query(
          `INSERT INTO patrol_schedules ("companyId","siteId","routeId",name,"daysOfWeek","activeFrom","activeTo","frequencyMinutes","windowMinutes","startsOn","endsOn",active,anchor,"archivedAt")
           VALUES ($1,$2,NULL,'Shift patrol','[1,2,3,4,5,6,7]'::jsonb,'00:00','00:00',60,60,'2000-01-01','2000-01-01',false,'shift',$3) RETURNING *, "startsOn"::text AS "startsOnText", "endsOn"::text AS "endsOnText"`,
          [coA, siteA1, archived ? '2026-11-01T10:00:00Z' : null]))[0];
        const current = await shiftRow(false);
        const replacedShift = await shiftRow(true);
        const W = await import('../src/patrol/patrol-window.service');
        for (const row of [current, replacedShift]) {
          const asOld = { id: Number(row.id), daysOfWeek: row.daysOfWeek, activeFrom: row.activeFrom, activeTo: row.activeTo, frequencyMinutes: 60, windowMinutes: 60,
            startsOn: row.startsOnText, endsOn: row.endsOnText, effectiveUntil: row.archivedAt ? new Date('2026-11-01T10:00:00Z') : null };
          for (const [from, to] of [['2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'], ['2026-10-24T00:00:00Z', '2026-10-27T00:00:00Z'], ['2026-03-28T00:00:00Z', '2026-03-31T00:00:00Z']]) {
            assert.deepEqual(W.windowsBetween(asOld, 'Europe/London', new Date(from), new Date(to)), [], `the 1.2.1 clock engine yields no window for shift schedule ${row.id} (${from}…${to})`);
          }
          assert.equal(W.windowForStart(asOld, 'Europe/London', new Date('2026-11-01T12:00:00Z'), 15), null, 'and never assigns a run to it');
        }
        // 1.2.1's own queries: the plan / sweep / windows-due "active" schedules never include it.
        const active = await previous.query(`SELECT id FROM patrol_schedules WHERE "companyId" = $1 AND "siteId" = $2 AND "active" AND "archivedAt" IS NULL`, [coA, siteA1]);
        assert.ok(!active.some((x: any) => [Number(current.id), Number(replacedShift.id)].includes(Number(x.id))), 'never an active schedule to 1.2.1');
        // A versioned route is an ordinary archived route to 1.2.1, and a run keeps its routeId.
        const [succ] = await previous.query(`INSERT INTO patrol_routes ("companyId","siteId",name,kind) VALUES ($1,$2,'All confirmed checkpoints','auto') RETURNING id`, [coA, siteA1]);
        await previous.query(`UPDATE patrol_routes SET active = false, "archivedAt" = now(), "supersededByRouteId" = $2, "supersededAt" = now() WHERE id = $1`, [rA1, succ.id]);
        const listed = await previous.query(`SELECT id FROM patrol_routes WHERE "companyId" = $1 AND "archivedAt" IS NULL ORDER BY id`, [coA]);
        assert.ok(!listed.some((x: any) => Number(x.id) === rA1) && listed.some((x: any) => Number(x.id) === Number(succ.id)), 'the replaced route is hidden, the successor listed');
        assert.equal(Number((await previous.query(`SELECT "routeId" FROM patrol_runs WHERE "clientRunId" = 'm74-run-0002'`))[0].routeId), rA1, 'the run still names the version it started under');
        // 1.3.0 moves every schedule naming the replaced version onto the new one in the same transaction
        // (PatrolConfigService.supersedeRoute; patrol-site-setup.spec.ts PSS-05). As it leaves the schedule, 1.2.1's own
        // route checks — the plan's active routes and the run start's "active and not archived" — accept it, with no
        // manual step on a rollback.
        await previous.query(`UPDATE patrol_schedules SET "routeId" = $2 WHERE "routeId" = $1`, [rA1, succ.id]);
        const [named] = await previous.query(`SELECT r.id, r.active, r."archivedAt" FROM patrol_schedules s JOIN patrol_routes r ON r.id = s."routeId" WHERE s.id = $1`, [s3]);
        assert.deepEqual([Number(named.id), named.active, named.archivedAt], [Number(succ.id), true, null], '1.2.1 finds an active, unarchived route');
        const planRoutes = await previous.query(`SELECT id FROM patrol_routes WHERE "companyId" = $1 AND "siteId" = $2 AND "active" AND "archivedAt" IS NULL`, [coA, siteA1]);
        assert.ok(planRoutes.some((x: any) => Number(x.id) === Number(succ.id)), 'and lists it in the Guard plan');
      } finally {
        await previous.destroy();
      }
      assert.equal(await migrationCount(), 74);
    });
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`);
  console.log(JSON.stringify({ event: 'm74_migration_certified', tests: passed }));
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
