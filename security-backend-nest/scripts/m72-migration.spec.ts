/**
 * Migration 72 (AddPatrolSyncRecoveryGrants1720900000018, issue #68) certification, on a disposable database built from
 * the repository's own migrations. (1720900000017 and 1720900000019 are reserved by other branches; on this branch 72
 * directly follows 70.)
 *
 *   M72-01  a database at 70 migrates to 72 and 72 is the last migration
 *   M72-02  the schema it adds and nothing else: one table (patrol_sync_recovery_grants) with its constraints and indexes,
 *           and UNIQUE ("id", "companyId") on shifts for the composite key; every time is timestamptz; varchar + CHECK, no
 *           enum; no other table, column, constraint, index or enum changes
 *   M72-03  every existing row keeps its values (P1-A / P1-B / P1-C patrol rows included)
 *   M72-04  a second run applies nothing; re-running up() directly changes nothing
 *   M72-05  the CHECKs hold the invariants: time box (after issue, at most 72 h — exactly 72 h allowed), a real reason,
 *           revocation all-or-none with its own reason, uses ≥ 0 and lastUsedAt exactly when used
 *   M72-06  foreign keys: a grant belongs to a company and to THAT company's shift (composite), an existing Guard and users
 *   M72-07  down() refuses while any grant exists, and changes nothing
 *   M72-08  down() with none removes exactly what 72 added; re-applying restores the identical schema
 *   M72-09  no semantic entity-to-migration drift at 72 and no column drift on the new table
 *   M72-10  rollback compatibility: the previous release's pre-deploy run (through 70) is a no-op on a 72 database and
 *           P1-A / P1-B / P1-C-shaped writes (which never name the new table) still succeed
 *
 * Needs M72_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.M72_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M72_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('M72 database must be local');

const MIGRATION_70 = 'AddPatrolEvidenceStorage1720900000016';
const MIGRATION_72 = 'AddPatrolSyncRecoveryGrants1720900000018';
const NEW_TABLE = 'patrol_sync_recovery_grants';
const SHIFTS_UNIQUE = 'UQ_shifts_id_company';
const NEW_CONSTRAINTS = [
  'PK_patrol_sync_recovery_grants', 'CHK_patrol_sync_recovery_grants_time_box', 'CHK_patrol_sync_recovery_grants_reason',
  'CHK_patrol_sync_recovery_grants_revoked', 'CHK_patrol_sync_recovery_grants_uses', 'FK_patrol_sync_recovery_grants_company',
  'FK_patrol_sync_recovery_grants_shift', 'FK_patrol_sync_recovery_grants_guard', 'FK_patrol_sync_recovery_grants_created_by',
  'FK_patrol_sync_recovery_grants_revoked_by',
];
const NEW_INDEXES = ['IDX_patrol_sync_recovery_grants_active', 'IDX_patrol_sync_recovery_grants_company'];

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
    migrations: allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000018).map((f) => path.join(migrationsDir, f)),
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
  /** The head schema without what 72 adds. */
  const without72 = (s: Awaited<ReturnType<typeof schema>>) => ({
    tables: s.tables.filter((t: string) => t !== NEW_TABLE),
    columns: s.columns.filter((c: any) => c.table_name !== NEW_TABLE),
    constraints: s.constraints.filter((c: any) => c.tbl !== NEW_TABLE && c.conname !== SHIFTS_UNIQUE),
    indexes: s.indexes.filter((i: any) => i.tablename !== NEW_TABLE && i.indexname !== SHIFTS_UNIQUE),
    enums: s.enums,
  });
  const hashAll = async (run: (sql: string) => Promise<any[]>) => {
    const tables = (await run(`SELECT tablename t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.t as string)
      .filter((t) => t !== 'typeorm_migrations' && t !== NEW_TABLE);
    const out: Record<string, string[]> = {};
    for (const t of tables) out[t] = (await run(`SELECT md5(to_jsonb(x)::text) h FROM "${t}" x ORDER BY 1`)).map((r) => r.h);
    return out;
  };

  try {
    // ── to 70, seed production-shaped rows (P1-A / P1-B / P1-C patrol data across two companies) ──────────────
    const at70 = new DataSource({
      type: 'postgres', url, entities: [], synchronize: false, migrations: through70, migrationsTableName: 'typeorm_migrations', logging: false,
    });
    await at70.initialize();
    await at70.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const applied70 = await at70.runMigrations({ transaction: 'each' });
    assert.equal(applied70[applied70.length - 1].name, MIGRATION_70);
    const one = async (sql: string, params: unknown[] = []) => (await at70.query(sql, params))[0];
    const ownerId = (await one(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m72.o@example.invalid','x','company_admin','active') RETURNING id`)).id;
    const ownerB = (await one(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m72.ob@example.invalid','x','company_admin','active') RETURNING id`)).id;
    const coA = (await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,'M72 A','72727272','1 Way','o@example.invalid',true) RETURNING id`, [ownerId])).id;
    const coB = (await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,'M72 B','72727273','2 Way','b@example.invalid',true) RETURNING id`, [ownerB])).id;
    const siteA = (await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'A1','2 Way') RETURNING id`, [coA])).id;
    const siteB = (await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'B1','3 Way') RETURNING id`, [coB])).id;
    const gu = (await one(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m72.g@example.invalid','x','guard','active') RETURNING id`)).id;
    const guard = (await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'M72 Guard','1000000000000072','07000000072') RETURNING id`, [gu])).id;
    const shiftA = (await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'x',$3,'completed',now() - interval '40 hours',now() - interval '32 hours') RETURNING id`,
      [coA, siteA, guard])).id;
    const shiftB = (await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'y',$3,'completed',now() - interval '40 hours',now() - interval '32 hours') RETURNING id`,
      [coB, siteB, guard])).id;
    await at70.query(`INSERT INTO patrol_policies ("companyId") VALUES ($1)`, [coA]);
    const run = (await one(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","startedAtDevice","clientRunId")
      VALUES ($1,$2,$3,$4,$5,now() - interval '39 hours','m72-run-0001') RETURNING id`, [coA, siteA, shiftA, guard, gu])).id;
    await at70.query(`INSERT INTO patrol_evidence ("companyId","siteId","runId","guardId","shiftId","sha256Client","capturedAtDevice","clientEvidenceId","mimeType","sizeBytes","syncFlags")
      VALUES ($1,$2,$3,$4,$5,$6,now(),'m72-evidence-0001','image/jpeg',1234,'["synced_after_book_off"]')`, [coA, siteA, run, guard, shiftA, 'a'.repeat(64)]);
    await at70.query(`INSERT INTO patrol_evidence_exports ("companyId","requestedByUserId",purpose) VALUES ($1,$2,'audit')`, [coA, ownerId]);
    const before = await hashAll((sql) => at70.query(sql));
    const at70Schema = await schemaOf((sql) => at70.query(sql));
    await at70.destroy();

    await ds.initialize();
    const applied = await ds.runMigrations({ transaction: 'each' });

    await test('M72-01-A-70-DATABASE-MIGRATES-TO-72-AND-72-IS-LAST', () => {
      assert.deepEqual(applied.map((m) => m.name), [MIGRATION_72], 'only 72 is pending on a 70 database');
      assert.equal(allFiles.length, 71);
      assert.equal(allFiles[69], '1720900000016-AddPatrolEvidenceStorage.ts');
      assert.equal(allFiles[70], '1720900000018-AddPatrolSyncRecoveryGrants.ts');
    });
    const head = await schema();

    await test('M72-02-THE-SCHEMA-IT-ADDS-AND-NOTHING-ELSE', () => {
      assert.deepEqual(head.tables.filter((t: string) => !at70Schema.tables.includes(t)), [NEW_TABLE], 'exactly one table added');
      const cols = head.columns.filter((c: any) => c.table_name === NEW_TABLE);
      assert.deepEqual(cols.map((c: any) => c.column_name).sort(), ['companyId', 'createdAt', 'createdByUserId', 'expiresAt', 'guardId', 'id', 'lastUsedAt',
        'reason', 'revokeReason', 'revokedAt', 'revokedByUserId', 'shiftId', 'uses']);
      const col = (c: string) => cols.find((x: any) => x.column_name === c);
      for (const c of ['createdAt', 'expiresAt', 'revokedAt', 'lastUsedAt']) assert.equal(col(c).data_type, 'timestamp with time zone', `${c} is timestamptz`);
      for (const c of ['companyId', 'guardId', 'shiftId', 'reason', 'createdByUserId', 'createdAt', 'expiresAt', 'uses']) assert.equal(col(c).is_nullable, 'NO', `${c} required`);
      for (const c of ['revokedAt', 'revokedByUserId', 'revokeReason', 'lastUsedAt']) assert.equal(col(c).is_nullable, 'YES', `${c} nullable`);
      assert.equal(col('reason').data_type, 'character varying');
      assert.equal(col('reason').character_maximum_length, 1000);
      assert.equal(col('uses').column_default, '0');
      assert.equal(col('createdAt').column_default, 'now()');
      assert.deepEqual(head.enums, at70Schema.enums, 'no enum added or changed');
      const [now72, was70] = [without72(head), without72(at70Schema)];
      for (const key of Object.keys(now72) as Array<keyof typeof now72>) {
        const added = (now72[key] as any[]).filter((x) => !(was70[key] as any[]).some((y) => JSON.stringify(y) === JSON.stringify(x)));
        const removed = (was70[key] as any[]).filter((x) => !(now72[key] as any[]).some((y) => JSON.stringify(y) === JSON.stringify(x)));
        assert.deepEqual({ added, removed }, { added: [], removed: [] }, `every other ${key} is unchanged: ${JSON.stringify({ added, removed })}`);
      }
      const names = head.constraints.map((c: any) => c.conname);
      for (const c of [...NEW_CONSTRAINTS, SHIFTS_UNIQUE]) assert.ok(names.includes(c), `constraint ${c}`);
      const shiftUq = head.constraints.find((c: any) => c.conname === SHIFTS_UNIQUE);
      assert.deepEqual([shiftUq.tbl, shiftUq.def], ['shifts', 'UNIQUE (id, "companyId")']);
      const fk = head.constraints.find((c: any) => c.conname === 'FK_patrol_sync_recovery_grants_shift');
      assert.match(fk.def, /FOREIGN KEY \("shiftId", "companyId"\) REFERENCES shifts\(id, "companyId"\) ON DELETE RESTRICT/, 'composite: the company\'s own shift');
      const idx = head.indexes.map((i: any) => i.indexname);
      for (const i of NEW_INDEXES) assert.ok(idx.includes(i), `index ${i}`);
      assert.match(head.indexes.find((i: any) => i.indexname === 'IDX_patrol_sync_recovery_grants_active').indexdef, /WHERE \("revokedAt" IS NULL\)/);
    });

    await test('M72-03-EVERY-EXISTING-ROW-KEEPS-ITS-VALUES', async () => {
      assert.deepEqual(await hashAll((sql) => q(sql)), before);
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM ${NEW_TABLE}`)), 0);
    });

    await test('M72-04-A-SECOND-RUN-APPLIES-NOTHING-AND-UP-IS-REPEATABLE', async () => {
      assert.equal((await ds.runMigrations({ transaction: 'each' })).length, 0);
      const { AddPatrolSyncRecoveryGrants1720900000018 } = await import('../src/database/migrations/1720900000018-AddPatrolSyncRecoveryGrants');
      const runner = ds.createQueryRunner();
      try {
        await new AddPatrolSyncRecoveryGrants1720900000018().up(runner);
      } finally {
        await runner.release();
      }
      assert.deepEqual(await schema(), head);
      assert.equal(await migrationCount(), 71);
    });

    const grant = (fields: Record<string, string> = {}) => {
      const all = {
        companyId: String(coA), guardId: String(guard), shiftId: String(shiftA), reason: `'Phone recovered after outage'`, createdByUserId: String(ownerId),
        createdAt: `'2026-10-30T10:00:00Z'`, expiresAt: `'2026-10-31T10:00:00Z'`, ...fields,
      };
      return q(`INSERT INTO ${NEW_TABLE} (${Object.keys(all).map((k) => `"${k}"`).join(',')}) VALUES (${Object.values(all).join(',')}) RETURNING id`);
    };

    await test('M72-05-THE-CHECKS-HOLD-THE-INVARIANTS', async () => {
      const [ok] = await grant();
      assert.ok(ok.id);
      await grant({ expiresAt: `'2026-11-02T10:00:00Z'` }); // exactly 72 h: allowed
      await assert.rejects(() => grant({ expiresAt: `'2026-11-02T10:00:01Z'` }), /CHK_patrol_sync_recovery_grants_time_box/, 'never more than 72 h');
      await assert.rejects(() => grant({ expiresAt: `'2026-10-30T10:00:00Z'` }), /CHK_patrol_sync_recovery_grants_time_box/, 'expires after issue');
      await assert.rejects(() => grant({ expiresAt: `'2026-10-29T10:00:00Z'` }), /CHK_patrol_sync_recovery_grants_time_box/);
      await assert.rejects(() => grant({ reason: `'  '` }), /CHK_patrol_sync_recovery_grants_reason/, 'a reason is mandatory');
      await assert.rejects(() => grant({ reason: `'ab'` }), /CHK_patrol_sync_recovery_grants_reason/);
      await assert.rejects(() => grant({ revokedAt: `'2026-10-30T11:00:00Z'` }), /CHK_patrol_sync_recovery_grants_revoked/, 'revocation is all or none');
      await assert.rejects(() => grant({ revokedAt: `'2026-10-30T11:00:00Z'`, revokedByUserId: String(ownerId), revokeReason: `' x '` }),
        /CHK_patrol_sync_recovery_grants_revoked/, 'a revocation has its own reason');
      await assert.rejects(() => grant({ revokeReason: `'Mistake fixed'` }), /CHK_patrol_sync_recovery_grants_revoked/);
      await grant({ revokedAt: `'2026-10-30T11:00:00Z'`, revokedByUserId: String(ownerId), revokeReason: `'Issued in error'` });
      await assert.rejects(() => grant({ uses: '-1' }), /CHK_patrol_sync_recovery_grants_uses/);
      await assert.rejects(() => grant({ uses: '1' }), /CHK_patrol_sync_recovery_grants_uses/, 'a used grant records when');
      await assert.rejects(() => grant({ lastUsedAt: 'now()' }), /CHK_patrol_sync_recovery_grants_uses/);
      await grant({ uses: '2', lastUsedAt: `'2026-10-30T12:00:00Z'` });
      await assert.rejects(() => q(`UPDATE ${NEW_TABLE} SET "expiresAt" = "createdAt" + interval '73 hours' WHERE id = $1`, [ok.id]), /CHK_patrol_sync_recovery_grants_time_box/,
        'cannot be extended beyond 72 h either');
      await q(`DELETE FROM ${NEW_TABLE}`);
    });

    await test('M72-06-FOREIGN-KEYS-TIE-A-GRANT-TO-ITS-COMPANY-S-SHIFT', async () => {
      await assert.rejects(() => grant({ shiftId: String(shiftB) }), /FK_patrol_sync_recovery_grants_shift/, 'another company\'s shift is refused by the database');
      await assert.rejects(() => grant({ companyId: String(coB) }), /FK_patrol_sync_recovery_grants_shift/, 'a shift is only its own company\'s');
      await grant({ companyId: String(coB), shiftId: String(shiftB), createdByUserId: String(ownerB) });
      await assert.rejects(() => grant({ shiftId: '999999' }), /FK_patrol_sync_recovery_grants_shift/);
      await assert.rejects(() => grant({ companyId: '999999' }), /FK_patrol_sync_recovery_grants_(company|shift)/);
      await assert.rejects(() => grant({ guardId: '999999' }), /FK_patrol_sync_recovery_grants_guard/);
      await assert.rejects(() => grant({ createdByUserId: '999999' }), /FK_patrol_sync_recovery_grants_created_by/);
      await assert.rejects(() => grant({ revokedAt: 'now()', revokedByUserId: '999999', revokeReason: `'Issued in error'` }), /FK_patrol_sync_recovery_grants_revoked_by/);
      await assert.rejects(() => q(`DELETE FROM shifts WHERE id = $1`, [shiftB]), /FK_patrol_sync_recovery_grants_shift/, 'a granted shift is never deleted from under its record');
      await assert.rejects(() => q(`UPDATE shifts SET "companyId" = $2 WHERE id = $1`, [shiftB, coA]), /FK_patrol_sync_recovery_grants_shift/, 'nor moved to another company');
      await q(`DELETE FROM ${NEW_TABLE}`);
    });

    await test('M72-07-DOWN-REFUSES-WHILE-GRANTS-EXIST', async () => {
      await grant();
      const snapshot = await hashAll((sql) => q(sql));
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /Refusing to revert AddPatrolSyncRecoveryGrants1720900000018: 1 patrol sync recovery grant/);
      assert.equal(await migrationCount(), 71);
      assert.deepEqual(await schema(), head, 'nothing changed');
      assert.deepEqual(await hashAll((sql) => q(sql)), snapshot);
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM ${NEW_TABLE}`)), 1);
      await q(`DELETE FROM ${NEW_TABLE}`);
    });

    await test('M72-08-DOWN-REMOVES-EXACTLY-WHAT-72-ADDED-AND-RE-APPLY-RESTORES-IT', async () => {
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

    await test('M72-09-NO-SEMANTIC-DRIFT-AND-NO-COLUMN-DRIFT-ON-THE-NEW-TABLE', async () => {
      const drift = (await ds.driver.createSchemaBuilder().log()).upQueries.map((x) => x.query);
      const semantic = drift.filter((x) =>
        /CREATE TABLE|DROP TABLE|CREATE TYPE|DROP TYPE|ALTER TYPE|ALTER TABLE.*ALTER COLUMN|ALTER TABLE.*DROP COLUMN|ALTER TABLE.*ADD "/i.test(x));
      assert.deepEqual(semantic, [], `semantic drift (the release gate would fail):\n${semantic.join('\n')}`);
      const ours = drift.filter((x) => /patrol_sync_recovery_grants|UQ_shifts_id_company/.test(x));
      // Foreign keys, CHECKs and the shifts unique key (the composite key's target) live in the migration only, as for the
      // other patrol tables; every column and index agrees.
      const unexpected = ours.filter((x) => !/^ALTER TABLE "(patrol_sync_recovery_grants|shifts)" DROP CONSTRAINT "(FK|CHK)_patrol_sync_recovery_grants_|^ALTER TABLE "shifts" DROP CONSTRAINT "UQ_shifts_id_company"/.test(x));
      assert.deepEqual(unexpected, [], `entity and migration 72 disagree:\n${unexpected.join('\n')}`);
      console.log(`      (diagnostic-only drift: ${drift.length} statement(s), of which ${ours.length} are Migration 72 FK / CHECK / UNIQUE names)`);
    });

    await test('M72-10-ROLLBACK-COMPATIBLE-WITH-THE-PREVIOUS-RELEASE', async () => {
      const previous = new DataSource({
        type: 'postgres', url, entities: [], synchronize: false, migrations: through70, migrationsTableName: 'typeorm_migrations', logging: false,
      });
      await previous.initialize();
      try {
        assert.equal((await previous.runMigrations({ transaction: 'each' })).length, 0, 'the previous release finds nothing to run');
        // P1-A / P1-B / P1-C writes, which never name the new table.
        const [s] = await previous.query(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'z',$3,'in_progress',now(),now() + interval '8 hours') RETURNING id`,
          [coA, siteA, guard]);
        const [r] = await previous.query(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","startedAtDevice","clientRunId","syncFlags","needsReview")
          VALUES ($1,$2,$3,$4,$5,now(),'m72-run-0002','["synced_after_book_off"]',true) RETURNING id`, [coA, siteA, s.id, guard, gu]);
        await previous.query(`INSERT INTO patrol_evidence ("companyId","siteId","runId","guardId","shiftId","sha256Client","capturedAtDevice","clientEvidenceId","syncFlags","needsReview")
          VALUES ($1,$2,$3,$4,$5,$6,now(),'m72-evidence-0002','[]',false)`, [coA, siteA, r.id, guard, s.id, 'd'.repeat(64)]);
        await previous.query(`UPDATE patrol_runs SET status = 'completed', "completedAtDevice" = now(), "completedAtServer" = now() WHERE id = $1`, [r.id]);
        await previous.query(`UPDATE shifts SET status = 'completed' WHERE id = $1`, [s.id]);
      } finally {
        await previous.destroy();
      }
      assert.equal(await migrationCount(), 71);
    });
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`);
  console.log(JSON.stringify({ event: 'm72_migration_certified', tests: passed }));
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
