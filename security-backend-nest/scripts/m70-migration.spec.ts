/**
 * Migration 70 (AddPatrolEvidenceStorage1720900000016) certification, on a disposable database built from the
 * repository's own migrations.
 *
 *   M70-01  a database at 69 migrates to 70 and 70 is the last migration
 *   M70-02  the schema it adds and nothing else: eleven patrol_evidence columns, two tables (patrol_evidence_exports,
 *           patrol_storage_usage), their constraints and indexes; every new time is timestamptz; varchar + CHECK, no enum;
 *           no other table, column, constraint, index or enum changes
 *   M70-03  every existing row keeps its values (P1-A / P1-B patrol rows included); new columns take their defaults
 *   M70-04  a second run applies nothing; re-running up() directly changes nothing
 *   M70-05  the CHECKs hold the vocabulary and the invariants (export status / purpose / ready / claim / hashes, usage
 *           counters ≥ 0 and one row per site / per company, quarantine and tombstone completeness, completion lease)
 *   M70-06  foreign keys: exports and usage belong to a company (and an existing site / user); a deletion names a user
 *   M70-07  down() refuses while any evidence record, hold or export exists, and changes nothing
 *   M70-08  down() with none removes exactly what 70 added; re-applying restores the identical schema
 *   M70-09  no semantic entity-to-migration drift at 70 and no column drift on the patrol tables
 *   M70-10  rollback compatibility: the previous release's pre-deploy run (through 69) is a no-op on a 70 database and
 *           P1-A / P1-B-shaped writes (which never name a new column) still succeed
 *
 * Needs M70_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.M70_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M70_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('M70 database must be local');

const MIGRATION_69 = 'AddPatrolScheduling1720900000015';
const MIGRATION_70 = 'AddPatrolEvidenceStorage1720900000016';
const NEW_TABLES = ['patrol_evidence_exports', 'patrol_storage_usage'];
const NEW_COLUMNS: Record<string, string[]> = {
  patrol_evidence: ['completionStartedAt', 'completionToken', 'declaredSizeBytes', 'deletionRequestedByUserId', 'detectedMimeType', 'needsReview',
    'objectDeletedAt', 'primaryDeletedAt', 'purgeAfter', 'syncFlags', 'uploadUrlIssuedAt'],
};
const NEW_EVIDENCE_CONSTRAINTS = [
  'CHK_patrol_evidence_completion_lease', 'CHK_patrol_evidence_declared_size', 'CHK_patrol_evidence_quarantine', 'CHK_patrol_evidence_sync_flags',
  'CHK_patrol_evidence_tombstone', 'FK_patrol_evidence_deletion_requested_by',
];
const NEW_EVIDENCE_INDEXES = ['IDX_patrol_evidence_lifecycle', 'IDX_patrol_evidence_pending_upload'];
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
  const through69 = allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000015).map((f) => path.join(migrationsDir, f));
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: false,
    migrations: allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000016).map((f) => path.join(migrationsDir, f)),
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
  /** The head schema without what 70 adds. */
  const without70 = (s: Awaited<ReturnType<typeof schema>>) => ({
    tables: s.tables.filter((t: string) => !NEW_TABLES.includes(t)),
    columns: s.columns.filter((c: any) => !isNewColumn(c)),
    // PostgreSQL 18 also lists a new column's NOT NULL as a constraint ("<table>_<column>_not_null").
    constraints: s.constraints.filter((c: any) => !NEW_TABLES.includes(c.tbl) && !NEW_EVIDENCE_CONSTRAINTS.includes(c.conname)
      && !(NEW_COLUMNS[c.tbl] ?? []).some((col) => c.def === `NOT NULL "${col}"` || c.def === `NOT NULL ${col}`)),
    indexes: s.indexes.filter((i: any) => !NEW_TABLES.includes(i.tablename) && !NEW_EVIDENCE_INDEXES.includes(i.indexname)),
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
    // ── to 69, seed production-shaped rows (P1-A / P1-B patrol data, including a photo record and a hold) ──────
    const at69 = new DataSource({
      type: 'postgres', url, entities: [], synchronize: false, migrations: through69, migrationsTableName: 'typeorm_migrations', logging: false,
    });
    await at69.initialize();
    await at69.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const applied69 = await at69.runMigrations({ transaction: 'each' });
    assert.equal(applied69[applied69.length - 1].name, MIGRATION_69);
    const one = async (sql: string, params: unknown[] = []) => (await at69.query(sql, params))[0];
    const ownerId = (await one(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m70.o@example.invalid','x','company_admin','active') RETURNING id`)).id;
    const coA = (await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,'M70 A','70707070','1 Way','o@example.invalid',true) RETURNING id`, [ownerId])).id;
    const siteA = (await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'A1','2 Way') RETURNING id`, [coA])).id;
    const gu = (await one(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m70.g@example.invalid','x','guard','active') RETURNING id`)).id;
    const guard = (await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'M70 Guard','1000000000000070','07000000070') RETURNING id`, [gu])).id;
    const shiftA = (await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'x',$3,'in_progress',now() - interval '1 hour',now() + interval '7 hours') RETURNING id`,
      [coA, siteA, guard])).id;
    await at69.query(`INSERT INTO patrol_policies ("companyId") VALUES ($1)`, [coA]);
    const run = (await one(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","startedAtDevice","clientRunId")
      VALUES ($1,$2,$3,$4,$5,now(),'m70-run-0001') RETURNING id`, [coA, siteA, shiftA, guard, gu])).id;
    const evidence = (await one(`INSERT INTO patrol_evidence ("companyId","siteId","runId","guardId","shiftId","sha256Client","capturedAtDevice","clientEvidenceId","mimeType","sizeBytes")
      VALUES ($1,$2,$3,$4,$5,$6,now(),'m70-evidence-0001','image/jpeg',1234) RETURNING id`, [coA, siteA, run, guard, shiftA, 'a'.repeat(64)])).id;
    const hold = (await one(`INSERT INTO patrol_evidence_holds ("companyId",scope,"evidenceId",reason,source,"createdByUserId") VALUES ($1,'evidence',$2,'Incident','manual',$3) RETURNING id`,
      [coA, evidence, ownerId])).id;
    await at69.query(`INSERT INTO patrol_exceptions ("companyId","siteId","runId","windowKey","type") VALUES ($1,$2,$3,'s1:2026-10-29:1','patrol_incomplete')`, [coA, siteA, run]);
    await at69.query(`INSERT INTO patrol_storage_usage_daily ("companyId","siteId","day","objects","bytes") VALUES ($1,$2,'2026-10-28',1,1234)`, [coA, siteA]);
    const before = await hashAll((sql) => at69.query(sql));
    const at69Schema = await schemaOf((sql) => at69.query(sql));
    await at69.destroy();

    await ds.initialize();
    const applied = await ds.runMigrations({ transaction: 'each' });

    await test('M70-01-A-69-DATABASE-MIGRATES-TO-70-AND-70-IS-LAST', () => {
      assert.deepEqual(applied.map((m) => m.name), [MIGRATION_70], 'only 70 is pending on a 69 database');
      assert.equal(allFiles.length, 71);
      assert.equal(allFiles[69], '1720900000016-AddPatrolEvidenceStorage.ts');
      assert.equal(allFiles[70], '1720900000017-AddPatrolSweepReconciliation.ts', 'Migration 71 follows 70 and is certified by m71-migration.spec.ts');
    });
    const head = await schema();

    await test('M70-02-THE-SCHEMA-IT-ADDS-AND-NOTHING-ELSE', () => {
      assert.deepEqual(head.tables.filter((t: string) => !at69Schema.tables.includes(t)).sort(), [...NEW_TABLES].sort(), 'exactly two tables added');
      assert.deepEqual(head.columns.filter((c: any) => c.table_name === 'patrol_evidence' && NEW_COLUMNS.patrol_evidence.includes(c.column_name)).map((c: any) => c.column_name).sort(),
        [...NEW_COLUMNS.patrol_evidence].sort());
      const col = (t: string, c: string) => head.columns.find((x: any) => x.table_name === t && x.column_name === c);
      for (const [t, c] of [['patrol_evidence', 'uploadUrlIssuedAt'], ['patrol_evidence', 'completionStartedAt'], ['patrol_evidence', 'purgeAfter'],
        ['patrol_evidence', 'primaryDeletedAt'], ['patrol_evidence', 'objectDeletedAt'], ['patrol_evidence_exports', 'expiresAt'], ['patrol_evidence_exports', 'claimedAt'],
        ['patrol_evidence_exports', 'createdAt'], ['patrol_storage_usage', 'updatedAt']]) {
        assert.equal(col(t, c).data_type, 'timestamp with time zone', `${t}.${c} is timestamptz`);
      }
      for (const c of NEW_COLUMNS.patrol_evidence.filter((x) => !['syncFlags', 'needsReview'].includes(x))) {
        assert.equal(col('patrol_evidence', c).is_nullable, 'YES', `patrol_evidence.${c} nullable (existing INSERTs stay valid)`);
      }
      assert.equal(col('patrol_evidence', 'syncFlags').column_default, `'[]'::jsonb`);
      assert.equal(col('patrol_evidence', 'needsReview').column_default, 'false');
      assert.equal(col('patrol_evidence_exports', 'status').data_type, 'character varying', 'varchar + CHECK, not an enum');
      assert.deepEqual(head.enums, at69Schema.enums, 'no enum added or changed');
      const [now70, was69] = [without70(head), without70(at69Schema)];
      for (const key of Object.keys(now70) as Array<keyof typeof now70>) {
        const added = (now70[key] as any[]).filter((x) => !(was69[key] as any[]).some((y) => JSON.stringify(y) === JSON.stringify(x)));
        const removed = (was69[key] as any[]).filter((x) => !(now70[key] as any[]).some((y) => JSON.stringify(y) === JSON.stringify(x)));
        assert.deepEqual({ added, removed }, { added: [], removed: [] }, `every other ${key} is unchanged: ${JSON.stringify({ added, removed })}`);
      }
      const names = head.constraints.map((c: any) => c.conname);
      for (const c of [...NEW_EVIDENCE_CONSTRAINTS, 'PK_patrol_evidence_exports', 'UQ_patrol_evidence_exports_id_company', 'CHK_patrol_evidence_exports_status',
        'CHK_patrol_evidence_exports_purpose', 'CHK_patrol_evidence_exports_ready', 'CHK_patrol_evidence_exports_claim', 'CHK_patrol_evidence_exports_hashes',
        'CHK_patrol_evidence_exports_counts', 'CHK_patrol_evidence_exports_dates', 'CHK_patrol_evidence_exports_run_ids', 'FK_patrol_evidence_exports_company',
        'FK_patrol_evidence_exports_site', 'FK_patrol_evidence_exports_requested_by', 'PK_patrol_storage_usage', 'CHK_patrol_storage_usage_counts',
        'FK_patrol_storage_usage_company', 'FK_patrol_storage_usage_site']) {
        assert.ok(names.includes(c), `constraint ${c}`);
      }
      const idx = head.indexes.map((i: any) => i.indexname);
      for (const i of [...NEW_EVIDENCE_INDEXES, 'UQ_patrol_evidence_exports_storage_key', 'IDX_patrol_evidence_exports_company', 'IDX_patrol_evidence_exports_open',
        'UQ_patrol_storage_usage_site', 'UQ_patrol_storage_usage_company']) {
        assert.ok(idx.includes(i), `index ${i}`);
      }
    });

    await test('M70-03-EVERY-EXISTING-ROW-KEEPS-ITS-VALUES-AND-NEW-COLUMNS-TAKE-DEFAULTS', async () => {
      assert.deepEqual(await hashAll((sql) => q(sql)), before);
      const [e] = await q(`SELECT "syncFlags", "needsReview", "declaredSizeBytes", "uploadUrlIssuedAt", "completionToken", "purgeAfter", "objectDeletedAt" FROM patrol_evidence`);
      assert.deepEqual(e, { syncFlags: [], needsReview: false, declaredSizeBytes: null, uploadUrlIssuedAt: null, completionToken: null, purgeAfter: null, objectDeletedAt: null });
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM patrol_evidence_exports`)), 0);
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM patrol_storage_usage`)), 0);
    });

    await test('M70-04-A-SECOND-RUN-APPLIES-NOTHING-AND-UP-IS-REPEATABLE', async () => {
      assert.equal((await ds.runMigrations({ transaction: 'each' })).length, 0);
      const { AddPatrolEvidenceStorage1720900000016 } = await import('../src/database/migrations/1720900000016-AddPatrolEvidenceStorage');
      const runner = ds.createQueryRunner();
      try {
        await new AddPatrolEvidenceStorage1720900000016().up(runner);
      } finally {
        await runner.release();
      }
      assert.deepEqual(await schema(), head);
      assert.equal(await migrationCount(), 70);
    });

    await test('M70-05-THE-CHECKS-HOLD-THE-VOCABULARY-AND-THE-INVARIANTS', async () => {
      const exp = (fields: Record<string, string>) => {
        const all = { companyId: String(coA), requestedByUserId: String(ownerId), purpose: `'audit'`, ...fields };
        return q(`INSERT INTO patrol_evidence_exports (${Object.keys(all).map((k) => `"${k}"`).join(',')}) VALUES (${Object.values(all).join(',')}) RETURNING id`);
      };
      const [ok] = await exp({});
      await assert.rejects(() => exp({ status: `'done'` }), /CHK_patrol_evidence_exports_status/);
      await assert.rejects(() => exp({ purpose: `'curiosity'` }), /CHK_patrol_evidence_exports_purpose/);
      await assert.rejects(() => exp({ status: `'ready'` }), /CHK_patrol_evidence_exports_ready/, 'ready needs its key, hashes, size and expiry');
      await assert.rejects(() => exp({ status: `'running'` }), /CHK_patrol_evidence_exports_claim/, 'running needs its claim');
      await assert.rejects(() => exp({ zipSha256: `'XYZ'` }), /CHK_patrol_evidence_exports_hashes/);
      await assert.rejects(() => exp({ runIds: `'{}'::jsonb` }), /CHK_patrol_evidence_exports_run_ids/);
      await assert.rejects(() => exp({ fromDate: `'2026-10-02'`, toDate: `'2026-10-01'` }), /CHK_patrol_evidence_exports_dates/);
      await assert.rejects(() => exp({ itemCount: '-1' }), /CHK_patrol_evidence_exports_counts/);
      await exp({ status: `'ready'`, storageKey: `'patrol-exports/1/2026/10/k.zip'`, zipSha256: `'${'b'.repeat(64)}'`, manifestSha256: `'${'c'.repeat(64)}'`,
        expiresAt: 'now()', zipBytes: '10' });
      await assert.rejects(() => exp({ status: `'ready'`, storageKey: `'patrol-exports/1/2026/10/k.zip'`, zipSha256: `'${'b'.repeat(64)}'`,
        manifestSha256: `'${'c'.repeat(64)}'`, expiresAt: 'now()', zipBytes: '10' }), /UQ_patrol_evidence_exports_storage_key/, 'one record per export object');
      await q(`DELETE FROM patrol_evidence_exports`);
      assert.ok(ok.id);
      await q(`INSERT INTO patrol_storage_usage ("companyId","siteId") VALUES ($1,$2), ($1,NULL)`, [coA, siteA]);
      await assert.rejects(() => q(`INSERT INTO patrol_storage_usage ("companyId","siteId") VALUES ($1,$2)`, [coA, siteA]), /UQ_patrol_storage_usage_site/);
      await assert.rejects(() => q(`INSERT INTO patrol_storage_usage ("companyId","siteId") VALUES ($1,NULL)`, [coA]), /UQ_patrol_storage_usage_company/);
      await assert.rejects(() => q(`UPDATE patrol_storage_usage SET "activeBytes" = -1`), /CHK_patrol_storage_usage_counts/);
      await q(`DELETE FROM patrol_storage_usage`);
      await assert.rejects(() => q(`UPDATE patrol_evidence SET "retentionStatus" = 'quarantined', "quarantinedAt" = now()`), /CHK_patrol_evidence_quarantine/,
        'a quarantined photo records where its copy is and when it may be purged');
      await assert.rejects(() => q(`UPDATE patrol_evidence SET "retentionStatus" = 'tombstone', "purgedAt" = now()`), /CHK_patrol_evidence_tombstone/,
        'a tombstone records when the object was removed');
      await assert.rejects(() => q(`UPDATE patrol_evidence SET "completionToken" = gen_random_uuid()`), /CHK_patrol_evidence_completion_lease/);
      await assert.rejects(() => q(`UPDATE patrol_evidence SET "declaredSizeBytes" = 0`), /CHK_patrol_evidence_declared_size/);
      await assert.rejects(() => q(`UPDATE patrol_evidence SET "syncFlags" = '{}'::jsonb`), /CHK_patrol_evidence_sync_flags/);
    });

    await test('M70-06-FOREIGN-KEYS-TIE-EXPORTS-AND-USAGE-TO-A-COMPANY', async () => {
      await assert.rejects(() => q(`INSERT INTO patrol_evidence_exports ("companyId","requestedByUserId",purpose) VALUES (999999,$1,'audit')`, [ownerId]), /FK_patrol_evidence_exports_company/);
      await assert.rejects(() => q(`INSERT INTO patrol_evidence_exports ("companyId","requestedByUserId",purpose,"siteId") VALUES ($1,$2,'audit',999999)`, [coA, ownerId]), /FK_patrol_evidence_exports_site/);
      await assert.rejects(() => q(`INSERT INTO patrol_evidence_exports ("companyId","requestedByUserId",purpose) VALUES ($1,999999,'audit')`, [coA]), /FK_patrol_evidence_exports_requested_by/);
      await assert.rejects(() => q(`INSERT INTO patrol_storage_usage ("companyId","siteId") VALUES (999999,NULL)`), /FK_patrol_storage_usage_company/);
      await assert.rejects(() => q(`INSERT INTO patrol_storage_usage ("companyId","siteId") VALUES ($1,999999)`, [coA]), /FK_patrol_storage_usage_site/);
      await assert.rejects(() => q(`UPDATE patrol_evidence SET "deletionRequestedByUserId" = 999999`), /FK_patrol_evidence_deletion_requested_by/);
      await assert.rejects(() => q(`DELETE FROM companies WHERE id = $1`, [coA]), /violates foreign key/, 'evidence and its records never disappear with a company');
    });

    await test('M70-07-DOWN-REFUSES-WHILE-EVIDENCE-HOLDS-OR-EXPORTS-EXIST', async () => {
      const snapshot = await hashAll((sql) => q(sql));
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /Refusing to revert AddPatrolEvidenceStorage1720900000016: 1 patrol evidence record\(s\).*1 evidence hold/);
      assert.equal(await migrationCount(), 70);
      assert.deepEqual(await schema(), head, 'nothing changed');
      await q(`DELETE FROM patrol_evidence_holds WHERE id = $1`, [hold]);
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /1 patrol evidence record/);
      await q(`DELETE FROM patrol_evidence WHERE id = $1`, [evidence]);
      await q(`INSERT INTO patrol_evidence_exports ("companyId","requestedByUserId",purpose) VALUES ($1,$2,'audit')`, [coA, ownerId]);
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /1 evidence export record/);
      await q(`DELETE FROM patrol_evidence_exports`);
      assert.equal(await migrationCount(), 70);
      assert.notDeepEqual(await hashAll((sql) => q(sql)), snapshot, 'the evidence and hold were removed by this test, not by down()');
    });

    await test('M70-08-DOWN-REMOVES-EXACTLY-WHAT-70-ADDED-AND-RE-APPLY-RESTORES-IT', async () => {
      const rows = await hashAll((sql) => q(sql));
      await ds.undoLastMigration({ transaction: 'each' });
      assert.equal(await migrationCount(), 69);
      const back = await schema();
      assert.deepEqual(back.tables, at69Schema.tables);
      assert.deepEqual(back.columns, at69Schema.columns);
      assert.deepEqual(back.constraints, at69Schema.constraints);
      assert.deepEqual(back.indexes, at69Schema.indexes);
      assert.deepEqual(back.enums, at69Schema.enums);
      assert.deepEqual(await hashAll((sql) => q(sql)), rows, 'existing rows survive the round trip');
      await ds.runMigrations({ transaction: 'each' });
      assert.deepEqual(await schema(), head);
    });

    await test('M70-09-NO-SEMANTIC-DRIFT-AND-NO-COLUMN-DRIFT-ON-PATROL-TABLES', async () => {
      const drift = (await ds.driver.createSchemaBuilder().log()).upQueries.map((x) => x.query);
      // This database stops at 70, so Migration 71's two tables, its two columns and their indexes are absent by design;
      // they are set aside statement by statement (m71-migration.spec.ts M71-09 certifies them).
      const m71 = /^CREATE TABLE "patrol_(sweep_watermarks|reconciliation_runs)" |^ALTER TABLE "patrol_exceptions" ADD "reconciliationRunId" |^ALTER TABLE "safety_alerts" ADD "patrolReconciliationRunId" |^CREATE (UNIQUE )?INDEX "(IDX_patrol_exceptions_reconciliation|uq_safety_alerts_patrol_reconciliation|UQ_patrol_reconciliation_runs_running|IDX_patrol_reconciliation_runs_company)" |^ALTER TABLE "patrol_(sweep_watermarks|reconciliation_runs)" /;
      const semantic = drift.filter((x) => !m71.test(x) &&
        /CREATE TABLE|DROP TABLE|CREATE TYPE|DROP TYPE|ALTER TYPE|ALTER TABLE.*ALTER COLUMN|ALTER TABLE.*DROP COLUMN|ALTER TABLE.*ADD "/i.test(x));
      assert.deepEqual(semantic, [], `semantic drift (the release gate would fail):\n${semantic.join('\n')}`);
      const ours = drift.filter((x) => /"patrol_|patrolsEnabled|patrol(ExceptionId|RunId|WindowKey|LateSyncAt|Annotation)|uq_safety_alerts_patrol_exception/.test(x) && !m71.test(x));
      // Foreign keys and CHECKs live in the migration only, as for M68's and M69's patrol tables; every column, unique key and
      // index agrees.
      const unexpected = ours.filter((x) => !/^ALTER TABLE "(patrol_[a-z_]+|safety_alerts)" DROP CONSTRAINT "(FK|CHK)_(patrol_|safety_alerts_patrol_)/.test(x));
      assert.deepEqual(unexpected, [], `entity and migration 70 disagree:\n${unexpected.join('\n')}`);
      console.log(`      (diagnostic-only drift: ${drift.length} statement(s), of which ${ours.length} are patrol FK / CHECK names)`);
    });

    await test('M70-10-ROLLBACK-COMPATIBLE-WITH-THE-PREVIOUS-RELEASE', async () => {
      const previous = new DataSource({
        type: 'postgres', url, entities: [], synchronize: false, migrations: through69, migrationsTableName: 'typeorm_migrations', logging: false,
      });
      await previous.initialize();
      try {
        assert.equal((await previous.runMigrations({ transaction: 'each' })).length, 0, 'the previous release finds nothing to run');
        // P1-A / P1-B writes, which never name a Migration 70 column.
        const [e] = await previous.query(`INSERT INTO patrol_evidence ("companyId","siteId","runId","guardId","shiftId","sha256Client","capturedAtDevice","clientEvidenceId")
          VALUES ($1,$2,$3,$4,$5,$6,now(),'m70-evidence-0002') RETURNING id`, [coA, siteA, run, guard, shiftA, 'd'.repeat(64)]);
        await previous.query(`UPDATE patrol_evidence SET "uploadStatus" = 'uploaded' WHERE id = $1`, [e.id]);
        await previous.query(`INSERT INTO patrol_evidence_holds ("companyId",scope,"runId",reason,source,"createdByUserId") VALUES ($1,'run',$2,'Hold','manual',$3)`, [coA, run, ownerId]);
        await previous.query(`UPDATE patrol_runs SET status = 'completed', "completedAtDevice" = now(), "completedAtServer" = now() WHERE id = $1`, [run]);
        await previous.query(`INSERT INTO patrol_storage_usage_daily ("companyId","siteId","day","objects","bytes") VALUES ($1,$2,'2026-10-29',0,0)`, [coA, siteA]);
      } finally {
        await previous.destroy();
      }
      assert.equal(await migrationCount(), 70);
    });
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`);
  console.log(JSON.stringify({ event: 'm70_migration_certified', tests: passed }));
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
