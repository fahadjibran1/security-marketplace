/**
 * Migration 77 (AddPlatformAdminMfa1720900000024, Platform Admin two-step verification) certification, on a DISPOSABLE
 * local database populated at Migration 76.
 *
 *   M77-01  the identifier and order: 77 files, 1720900000024 follows 76 and is the last; a database at 76 applies exactly 77
 *   M77-02  exactly one new table (platform_admin_mfa) with the documented columns, primary key, foreign key and CHECKs;
 *           no other table, column, constraint, index or enum changed, and no row of any table changed (users and
 *           sessions included: nobody is enrolled, so every account signs in exactly as before)
 *   M77-03  the constraints hold: one row per user; an enabled row must hold a secret and a secret means enabled; a
 *           pending secret needs its start time; deleting the user deletes the row; the user must exist
 *   M77-04  no semantic entity-to-migration drift at 77, and none at all about platform_admin_mfa
 *   M77-05  down() removes exactly the table; the schema and every row are as they were at 76; up() again is the same
 *   M77-06  rollback compatibility: the previous release's migrations find nothing to run on a 77 database, and its
 *           user INSERTs and reads (which never name the table) still work
 *   M77-07  a fresh, empty database migrates 0 → 77 in one run, ends at 77 with no drift about the table
 *   M77-08  every migration identifier, file name and class name is unique and increasing
 *
 * Needs M77_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.M77_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M77_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('M77 database must be local');

const MIGRATION_76 = 'AddCompanyVerification1720900000023';
const MIGRATION_77 = 'AddPlatformAdminMfa1720900000024';
const TABLE = 'platform_admin_mfa';

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

  // ── a populated database at 76: an admin, a company owner, a Guard and a live session ──
  const at76 = source(1720900000023);
  await at76.initialize();
  await at76.query('DROP SCHEMA public CASCADE');
  await at76.query('CREATE SCHEMA public');
  await at76.runMigrations({ transaction: 'each' });
  const seeded: number[] = [];
  for (const [i, role] of ['admin', 'company_admin', 'guard'].entries()) {
    const [u] = await at76.query(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified") VALUES ($1,'x',$2,'active',true) RETURNING id`,
      [`m77.user${i}@example.invalid`, role]);
    seeded.push(u.id);
  }
  await at76.query(`INSERT INTO auth_sessions ("userId","tokenHash","familyId","expiresAt","absoluteExpiresAt")
    VALUES ($1, repeat('a', 64), gen_random_uuid(), now() + interval '1 day', now() + interval '30 days')`, [seeded[0]]);
  await at76.destroy();

  const ds = source(1720900000024, appEntities);
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
  const without77 = (s: Awaited<ReturnType<typeof schema>>) => ({
    tables: s.tables.filter((t: string) => t !== TABLE),
    columns: s.columns.filter((c: any) => c.table_name !== TABLE),
    constraints: s.constraints.filter((c: any) => c.tbl !== TABLE),
    indexes: s.indexes.filter((i: any) => i.tablename !== TABLE),
    enums: s.enums,
  });
  const hashAll = async () => {
    const tables = (await q(`SELECT tablename t FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('typeorm_migrations', '${TABLE}') ORDER BY 1`))
      .map((r: any) => r.t as string);
    const out: Record<string, string[]> = {};
    for (const t of tables) out[t] = (await q(`SELECT md5(to_jsonb(x)::text) h FROM "${t}" x ORDER BY 1`)).map((r: any) => r.h);
    return out;
  };

  const schema76 = await schema();
  const rows76 = await hashAll();
  assert.equal(rows76.users.length, 3, 'seeded');
  assert.ok(!schema76.tables.includes(TABLE), 'no table at 76');

  try {
    await test('M77-01-IDENTIFIER-AND-ORDER', async () => {
      assert.equal(allFiles.length, 77, 'exactly 77 migration files');
      assert.equal(allFiles[75], '1720900000023-AddCompanyVerification.ts', 'Migration 76 comes just before 77');
      assert.equal(allFiles[76], '1720900000024-AddPlatformAdminMfa.ts', 'Migration 77 = 1720900000024 and is the last');
      assert.equal((await ledger()).at(-1), MIGRATION_76);
      const applied = await ds.runMigrations({ transaction: 'each' });
      assert.deepEqual(applied.map((m) => m.name), [MIGRATION_77], 'a 76 database applies exactly Migration 77');
      assert.equal((await ledger()).length, 77);
    });

    await test('M77-02-EXACTLY-ONE-NEW-TABLE-NO-ROW-CHANGED', async () => {
      const head = await schema();
      assert.deepEqual(without77(head), schema76, 'no other table, column, constraint, index or enum changed');
      const cols = head.columns.filter((c: any) => c.table_name === TABLE).map((c: any) => [c.column_name, c.udt_name, c.is_nullable, c.column_default]);
      assert.deepEqual(cols, [
        ['createdAt', 'timestamptz', 'NO', 'now()'],
        ['enabledAt', 'timestamptz', 'YES', null],
        ['lastUsedStep', 'int4', 'YES', null],
        ['pendingCreatedAt', 'timestamptz', 'YES', null],
        ['pendingSecretEncrypted', 'text', 'YES', null],
        ['totpSecretEncrypted', 'text', 'YES', null],
        ['updatedAt', 'timestamptz', 'NO', 'now()'],
        ['userId', 'int4', 'NO', null],
      ]);
      const cons = head.constraints.filter((c: any) => c.tbl === TABLE).map((c: any) => [c.conname, c.def]);
      assert.deepEqual(cons, [
        ['CHK_platform_admin_mfa_enabled_secret', 'CHECK ((("enabledAt" IS NULL) = ("totpSecretEncrypted" IS NULL)))'],
        ['CHK_platform_admin_mfa_pending_pair', 'CHECK ((("pendingSecretEncrypted" IS NULL) = ("pendingCreatedAt" IS NULL)))'],
        ['FK_platform_admin_mfa_user', 'FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE'],
        ['PK_platform_admin_mfa', 'PRIMARY KEY ("userId")'],
      ]);
      assert.equal(Number((await q(`SELECT count(*) n FROM "${TABLE}"`))[0].n), 0, 'empty: nobody is enrolled');
      assert.deepEqual(await hashAll(), rows76, 'no row of any table changed (users, sessions, everything)');
    });

    await test('M77-03-CONSTRAINTS', async () => {
      const [admin] = seeded;
      await q(`INSERT INTO "${TABLE}" ("userId") VALUES ($1)`, [admin]);
      await assert.rejects(q(`INSERT INTO "${TABLE}" ("userId") VALUES ($1)`, [admin]), /PK_platform_admin_mfa|duplicate key/, 'one row per user');
      await assert.rejects(q(`UPDATE "${TABLE}" SET "enabledAt" = now() WHERE "userId" = $1`, [admin]), /CHK_platform_admin_mfa_enabled_secret/, 'enabled needs a secret');
      await assert.rejects(q(`UPDATE "${TABLE}" SET "totpSecretEncrypted" = 'v1:a:b:c' WHERE "userId" = $1`, [admin]), /CHK_platform_admin_mfa_enabled_secret/, 'a secret means enabled');
      await assert.rejects(q(`UPDATE "${TABLE}" SET "pendingSecretEncrypted" = 'v1:a:b:c' WHERE "userId" = $1`, [admin]), /CHK_platform_admin_mfa_pending_pair/, 'pending needs its start');
      await q(`UPDATE "${TABLE}" SET "totpSecretEncrypted" = 'v1:a:b:c', "enabledAt" = now(), "lastUsedStep" = 1 WHERE "userId" = $1`, [admin]);
      await assert.rejects(q(`INSERT INTO "${TABLE}" ("userId") VALUES (999999)`), /FK_platform_admin_mfa_user/, 'the user must exist');
      const [tmp] = await q(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m77.tmp@example.invalid','x','admin','active') RETURNING id`);
      await q(`INSERT INTO "${TABLE}" ("userId") VALUES ($1)`, [tmp.id]);
      await q(`DELETE FROM users WHERE id = $1`, [tmp.id]);
      assert.equal(Number((await q(`SELECT count(*) n FROM "${TABLE}" WHERE "userId" = $1`, [tmp.id]))[0].n), 0, 'cascade with the user');
      await q(`DELETE FROM "${TABLE}"`);
    });

    await test('M77-04-NO-DRIFT', async () => {
      const drift = (await ds.driver.createSchemaBuilder().log()).upQueries.map((x) => x.query);
      const semantic = drift.filter((x) =>
        /CREATE TABLE|DROP TABLE|CREATE TYPE|DROP TYPE|ALTER TYPE|ALTER TABLE.*ALTER COLUMN|ALTER TABLE.*DROP COLUMN|ALTER TABLE.*ADD "/i.test(x));
      assert.deepEqual(semantic, [], `semantic drift (the release gate would fail):\n${semantic.join('\n')}`);
      const ours = drift.filter((x) => x.includes(TABLE));
      assert.deepEqual(ours, [], `entity and Migration 77 disagree:\n${ours.join('\n')}`);
      console.log(`      (diagnostic-only drift: ${drift.length} statement(s), none about Migration 77)`);
    });

    await test('M77-05-DOWN-AND-UP-AGAIN', async () => {
      await q(`INSERT INTO "${TABLE}" ("userId","totpSecretEncrypted","enabledAt") VALUES ($1,'v1:a:b:c',now())`, [seeded[0]]);
      await ds.undoLastMigration({ transaction: 'each' });
      assert.equal((await ledger()).at(-1), MIGRATION_76);
      assert.deepEqual(await schema(), schema76, 'exactly the schema at 76');
      assert.deepEqual(await hashAll(), rows76, 'every row as it was at 76');
      await ds.runMigrations({ transaction: 'each' });
      assert.equal((await ledger()).at(-1), MIGRATION_77);
      assert.equal(Number((await q(`SELECT count(*) n FROM "${TABLE}"`))[0].n), 0, 'up() again starts empty');
    });

    await test('M77-06-ROLLBACK-COMPATIBLE', async () => {
      const previous = source(1720900000023);
      await previous.initialize();
      try {
        assert.equal((await previous.runMigrations({ transaction: 'each' })).length, 0, 'the previous release finds nothing to run');
        const [u] = await previous.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m77.prev@example.invalid','x','admin','active') RETURNING id`);
        const [row] = await previous.query(`SELECT id, role, status FROM users WHERE id = $1`, [u.id]);
        assert.equal(row.role, 'admin');
        await previous.query(`DELETE FROM users WHERE id = $1`, [u.id]);
      } finally {
        await previous.destroy();
      }
    });
  } finally {
    await ds.destroy();
  }

  await test('M77-07-FRESH-DATABASE', async () => {
    const fresh = source(1720900000024, appEntities);
    await fresh.initialize();
    try {
      await fresh.query('DROP SCHEMA public CASCADE');
      await fresh.query('CREATE SCHEMA public');
      const applied = await fresh.runMigrations({ transaction: 'each' });
      assert.equal(applied.length, 77, 'all 77 migrations apply to an empty database');
      assert.equal(applied.at(-1)?.name, MIGRATION_77);
      const drift = (await fresh.driver.createSchemaBuilder().log()).upQueries.map((x) => x.query).filter((x) => x.includes(TABLE));
      assert.deepEqual(drift, []);
    } finally {
      await fresh.destroy();
    }
  });

  await test('M77-08-UNIQUE-IDENTIFIERS-AND-NAMES', async () => {
    const ids = allFiles.map((f) => f.split('-')[0]);
    assert.equal(new Set(ids).size, ids.length, 'identifiers unique');
    assert.equal(new Set(allFiles.map((f) => f.replace(/^\d+-/, ''))).size, allFiles.length, 'file names unique');
    const classes = allFiles.map((f) => {
      const text = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
      const cls = /export class (\w+)/.exec(text)?.[1];
      assert.ok(cls && cls.endsWith(f.split('-')[0]), `${f}: class carries the file identifier`);
      return cls!;
    });
    assert.equal(new Set(classes).size, classes.length, 'class names unique (the ledger key)');
    assert.ok(ids.every((id, i) => i === 0 || Number(id) > Number(ids[i - 1])), 'identifiers strictly increase in file order');
  });

  console.log(JSON.stringify({ event: 'm77_migration_certified', passed, failed: failures.length }));
  if (failures.length) {
    console.error(`FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
