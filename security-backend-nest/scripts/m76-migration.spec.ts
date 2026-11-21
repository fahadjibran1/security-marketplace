/**
 * Migration 76 (AddCompanyVerification1720900000023, SEC-PUBLIC-03 company verification) certification, on a DISPOSABLE
 * local database populated at Migration 75.
 *
 *   M76-01  the identifier and order: 76 files, 1720900000023 follows 75 and is the last; a database at 75 applies exactly 76
 *   M76-02  every company that existed before 76 is approved (pilot access preserved), whatever its legacy status, with no
 *           decision note or time; no other row of any table changes
 *   M76-03  exactly the enum type (four labels, in order) and the three companies columns were added; nothing else changed
 *   M76-04  a company created after 76 without naming the column starts pending_verification; the enum refuses other values
 *   M76-05  the legacy companies."status" column and its values are untouched
 *   M76-06  down() removes exactly what 76 added; the schema and every row are as they were at 75; up() again re-approves
 *           the companies that existed (a re-run is the same backfill)
 *   M76-07  no semantic entity-to-migration drift at 76 (the release gate's own rule)
 *   M76-08  rollback compatibility: the previous release's migrations find nothing to run on a 76 database, and its
 *           company INSERTs (which never name the new columns) still work
 *
 * Needs M76_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.M76_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M76_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('M76 database must be local');

const MIGRATION_75 = 'AddPatrolMonitorIndexes1720900000022';
const MIGRATION_76 = 'AddCompanyVerification1720900000023';
const NEW_COLUMNS = ['verificationDecidedAt', 'verificationNote', 'verificationStatus'];
const ENUM = 'company_verification_status_enum';

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

  // ── a populated database at 75 ──
  const at75 = source(1720900000022);
  await at75.initialize();
  await at75.query('DROP SCHEMA public CASCADE');
  await at75.query('CREATE SCHEMA public');
  await at75.runMigrations({ transaction: 'each' });
  const legacy = ['onboarding', 'active', 'inactive', 'suspended'];
  for (const [i, status] of legacy.entries()) {
    const [u] = await at75.query(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified") VALUES ($1,'x','company_admin','active',true) RETURNING id`,
      [`m76.owner${i}@example.invalid`]);
    await at75.query(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails",status) VALUES ($1,$2,$3,'1 Way','ops@example.invalid',$4)`,
      [u.id, `M76 Pilot ${i} Ltd`, String(76000000 + i), status]);
  }
  await at75.destroy();

  const ds = source(1720900000023, appEntities);
  await ds.initialize();
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const ledger = async () => (await q('SELECT name FROM typeorm_migrations ORDER BY id')).map((r: any) => r.name as string);
  const schema = async () => ({
    tables: (await q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r: any) => r.tablename),
    columns: await q(`SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`),
    constraints: await q(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace AND conrelid <> 0 ORDER BY 1, 2`),
    indexes: await q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`),
    enums: await q(`SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid ORDER BY 1, e.enumsortorder`),
  });
  const without76 = (s: Awaited<ReturnType<typeof schema>>) => ({
    ...s,
    columns: s.columns.filter((c: any) => !(c.table_name === 'companies' && NEW_COLUMNS.includes(c.column_name))),
    enums: s.enums.filter((e: any) => e.typname !== ENUM),
  });
  /** Every row of every table, hashed (the ledger aside); companies without the new columns so 75 and 76 compare. */
  const hashAll = async () => {
    const tables = (await q(`SELECT tablename t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'typeorm_migrations' ORDER BY 1`)).map((r: any) => r.t as string);
    const out: Record<string, string[]> = {};
    for (const t of tables) {
      out[t] = (await q(`SELECT md5((to_jsonb(x) - '{verificationStatus,verificationNote,verificationDecidedAt}'::text[])::text) h FROM "${t}" x ORDER BY 1`))
        .map((r: any) => r.h);
    }
    return out;
  };

  const schema75 = await schema();
  const rows75 = await hashAll();
  assert.equal(rows75.companies.length, 4, 'seeded');

  try {
    await test('M76-01-IDENTIFIER-AND-ORDER', async () => {
      assert.equal(allFiles.length, 76, 'exactly 76 migration files');
      assert.equal(allFiles[74], '1720900000022-AddPatrolMonitorIndexes.ts', 'Migration 75 comes just before 76');
      assert.equal(allFiles[75], '1720900000023-AddCompanyVerification.ts', 'Migration 76 = 1720900000023 and is the last');
      assert.equal(new Set(allFiles.map((f) => f.split('-')[0])).size, allFiles.length, 'every identifier is unique');
      assert.equal((await ledger()).at(-1), MIGRATION_75);
      const applied = await ds.runMigrations({ transaction: 'each' });
      assert.deepEqual(applied.map((m) => m.name), [MIGRATION_76], 'a 75 database applies exactly Migration 76');
      assert.equal((await ledger()).length, 76);
    });

    await test('M76-02-EXISTING-COMPANIES-APPROVED', async () => {
      const rows = await q(`SELECT "verificationStatus" s, "verificationNote" n, "verificationDecidedAt" d FROM companies ORDER BY id`);
      assert.deepEqual(rows.map((r: any) => [r.s, r.n, r.d]), legacy.map(() => ['approved', null, null]));
      assert.deepEqual(await hashAll(), rows75, 'no other value of any row changed');
    });

    await test('M76-03-EXACTLY-THE-ENUM-AND-THREE-COLUMNS', async () => {
      const head = await schema();
      assert.deepEqual(without76(head), schema75, 'no other table, column, constraint, index or enum changed');
      assert.deepEqual(head.enums.filter((e: any) => e.typname === ENUM).map((e: any) => e.enumlabel),
        ['pending_verification', 'approved', 'rejected', 'suspended']);
      const cols = head.columns.filter((c: any) => c.table_name === 'companies' && NEW_COLUMNS.includes(c.column_name))
        .map((c: any) => [c.column_name, c.udt_name, c.is_nullable, c.column_default]);
      assert.deepEqual(cols, [
        ['verificationDecidedAt', 'timestamptz', 'YES', null],
        ['verificationNote', 'text', 'YES', null],
        ['verificationStatus', ENUM, 'NO', `'pending_verification'::${ENUM}`],
      ]);
    });

    await test('M76-04-NEW-COMPANIES-START-PENDING', async () => {
      const [u] = await q(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m76.new@example.invalid','x','company','active') RETURNING id`);
      const [c] = await q(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,'M76 New Ltd','76999999','1 Way','o@example.invalid') RETURNING "verificationStatus" s`, [u.id]);
      assert.equal(c.s, 'pending_verification');
      await assert.rejects(q(`UPDATE companies SET "verificationStatus" = 'verified' WHERE "userId" = $1`, [u.id]), /invalid input value for enum/);
      await q(`DELETE FROM companies WHERE "userId" = $1`, [u.id]);
      await q(`DELETE FROM users WHERE id = $1`, [u.id]);
    });

    await test('M76-05-LEGACY-STATUS-UNTOUCHED', async () => {
      assert.deepEqual((await q(`SELECT status FROM companies ORDER BY id`)).map((r: any) => r.status), legacy);
    });

    await test('M76-06-DOWN-AND-UP-AGAIN', async () => {
      await q(`UPDATE companies SET "verificationStatus" = 'suspended', "verificationNote" = 'test', "verificationDecidedAt" = now() WHERE name = 'M76 Pilot 0 Ltd'`);
      await ds.undoLastMigration({ transaction: 'each' });
      assert.equal((await ledger()).at(-1), MIGRATION_75);
      assert.deepEqual(await schema(), schema75, 'exactly the schema at 75');
      assert.deepEqual(await hashAll(), rows75, 'every row as it was at 75');
      await ds.runMigrations({ transaction: 'each' });
      assert.deepEqual((await q(`SELECT "verificationStatus" s FROM companies ORDER BY id`)).map((r: any) => r.s), legacy.map(() => 'approved'),
        'up() again is the same backfill: companies that exist are approved');
    });

    await test('M76-07-NO-SEMANTIC-DRIFT', async () => {
      const drift = (await ds.driver.createSchemaBuilder().log()).upQueries.map((x) => x.query);
      const semantic = drift.filter((x) =>
        /CREATE TABLE|DROP TABLE|CREATE TYPE|DROP TYPE|ALTER TYPE|ALTER TABLE.*ALTER COLUMN|ALTER TABLE.*DROP COLUMN|ALTER TABLE.*ADD "/i.test(x));
      assert.deepEqual(semantic, [], `semantic drift (the release gate would fail):\n${semantic.join('\n')}`);
      const ours = drift.filter((x) => /companies/.test(x) && NEW_COLUMNS.some((c) => x.includes(`"${c}"`)) || x.includes(ENUM));
      assert.deepEqual(ours, [], `entity and Migration 76 disagree:\n${ours.join('\n')}`);
      console.log(`      (diagnostic-only drift: ${drift.length} statement(s), none about Migration 76)`);
    });

    await test('M76-08-ROLLBACK-COMPATIBLE', async () => {
      const previous = source(1720900000022);
      await previous.initialize();
      try {
        assert.equal((await previous.runMigrations({ transaction: 'each' })).length, 0, 'the previous release finds nothing to run');
        const [u] = await previous.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m76.prev@example.invalid','x','company','active') RETURNING id`);
        const [c] = await previous.query(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails",status) VALUES ($1,'M76 Prev Ltd','76888888','1 Way','o@example.invalid','onboarding') RETURNING *`, [u.id]);
        assert.equal(c.verificationStatus, 'pending_verification', 'a company the previous release registers lands pending, not approved');
      } finally {
        await previous.destroy();
      }
    });
  } finally {
    await ds.destroy();
  }

  console.log(JSON.stringify({ event: 'm76_migration_certified', passed, failed: failures.length }));
  if (failures.length) {
    console.error(`FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
