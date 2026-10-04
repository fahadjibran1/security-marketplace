/**
 * Migration 61 certification (AddAccountLifecycleAndVerificationTokens).
 *
 * Against a fresh, disposable PostgreSQL:
 *
 *   M61-01  a fresh database migrates 0 → 61 and 61 is the LAST migration (there is no 62)
 *   M61-02  down() returns exactly to the schema production is on today (60)
 *   M61-03  rows seeded at 60, shaped like production users, survive 60 → 61 untouched
 *   M61-04  every account existing when 61 runs is grandfathered: emailVerificationRequired = false
 *   M61-05  every account created after 61 defaults to emailVerificationRequired = true
 *   M61-06  the approved schema, column by column, constraint by constraint
 *   M61-07  a second migration run applies nothing
 *   M61-08  down() removes everything 61 added and nothing else
 *   M61-09  re-applying restores the identical schema
 *   M61-10  no synchronize; no PostgreSQL enum for purpose; no deletionRequestedAt index; no retentionReason
 *
 * Needs GATE2_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.GATE2_MIGRATION_DATABASE_URL;
if (!url) throw new Error('GATE2_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw new Error('GATE2_MIGRATION_DATABASE_URL must point at a local disposable database');
}

const MIGRATION_61 = 'AddAccountLifecycleAndVerificationTokens1720900000007';
const MIGRATION_60 = 'AddResolutionEvidence1720900000006';

let passed = 0;
const test = async (id: string, fn: () => Promise<void> | void) => {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
};

async function main() {
  const migrationsGlob = require('node:path').join(__dirname, '..', 'src', 'database', 'migrations', '*.ts');
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: true,
    migrations: [migrationsGlob], migrationsTableName: 'typeorm_migrations', logging: false,
  });
  await ds.initialize();

  const scalar = async (sql: string, params: unknown[] = []) => Object.values((await ds.query(sql, params))[0] ?? {})[0];
  const migrationCount = async () => Number(await scalar('SELECT count(*)::int FROM typeorm_migrations'));
  /** A complete, ordered description of everything Migration 61 owns, for exact comparison. */
  const snapshot = async () => ({
    columns: await ds.query(`
      SELECT table_name, column_name, data_type, character_maximum_length, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name = 'user_verification_tokens'
              OR (table_name = 'users' AND column_name IN ('deletionRequestedAt','deletionCompletedAt','emailVerificationRequired')))
       ORDER BY table_name, column_name`),
    constraints: await ds.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS def
        FROM pg_constraint WHERE conrelid = 'public.user_verification_tokens'::regclass ORDER BY conname`).catch(() => []),
    indexes: await ds.query(`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename IN ('user_verification_tokens','users') ORDER BY indexname`),
  });
  const usersShape = () => ds.query(`
      SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='users' ORDER BY column_name`);

  try {
    assert.equal(ds.options.synchronize, false, 'synchronize must stay off');

    // ── fresh database to the head ───────────────────────────────────────────────────────────────────
    const applied = await ds.runMigrations({ transaction: 'each' });
    await test('M61-01-FRESH-DATABASE-MIGRATES-TO-61-AND-61-IS-LAST', async () => {
      assert.equal(applied.length, 61, `61 migrations apply to a fresh database (got ${applied.length})`);
      assert.equal(applied[59].name, MIGRATION_60);
      assert.equal(applied[60].name, MIGRATION_61, 'Migration 61 is the subject');
      const files = require('node:fs').readdirSync(require('node:path').join(__dirname, '..', 'src', 'database', 'migrations'));
      assert.equal(files.filter((f: string) => /\.ts$/.test(f)).length, 61, 'exactly 61 migration files: there is no Migration 62');
    });
    const head = await snapshot();
    const headUsers = await usersShape();

    // ── back to 60, the production schema ────────────────────────────────────────────────────────────
    await ds.undoLastMigration({ transaction: 'each' });
    const at60Users = await usersShape();
    await test('M61-02-DOWN-RETURNS-TO-60', async () => {
      assert.equal(await migrationCount(), 60);
      assert.equal(
        await scalar(`SELECT name FROM typeorm_migrations ORDER BY id DESC LIMIT 1`),
        MIGRATION_60,
      );
    });

    await test('M61-08-DOWN-REMOVES-EVERYTHING-61-ADDED-AND-NOTHING-ELSE', async () => {
      const gone = await snapshot();
      assert.deepEqual(gone.columns, [], 'no Gate 2 column or table survives down()');
      assert.deepEqual(gone.constraints, []);
      assert.ok(!gone.indexes.some((i: any) => /user_verification_tokens/.test(i.indexname)));
      assert.equal(await scalar(`SELECT to_regclass('public.user_verification_tokens') IS NULL`), true);
      // users is left exactly as it was before 61: the same columns minus the three added.
      const expected = headUsers.filter((c: any) => !['deletionRequestedAt', 'deletionCompletedAt', 'emailVerificationRequired'].includes(c.column_name));
      assert.deepEqual(at60Users, expected);
    });

    // ── seed production-shaped users at 60 ───────────────────────────────────────────────────────────
    const seed = [
      ['m61.verified.admin@example.invalid', 'admin', 'active', true],
      ['m61.unverified.guard@example.invalid', 'guard', 'active', false],
      ['m61.company@example.invalid', 'company_admin', 'active', false],
      ['m61.suspended@example.invalid', 'guard', 'suspended', true],
      ['m61.inactive@example.invalid', 'company_staff', 'inactive', false],
    ] as const;
    for (const [email, role, status, verified] of seed) {
      await ds.query(
        `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified",phone,"firstName") VALUES ($1,'$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyzABCDE',$2,$3,$4,'07700900000','Seed')`,
        [email, role, status, verified],
      );
    }
    const before = await ds.query(`SELECT * FROM users ORDER BY id`);

    // ── 60 → 61 ──────────────────────────────────────────────────────────────────────────────────────
    const forward = await ds.runMigrations({ transaction: 'each' });
    const after = await ds.query(`SELECT * FROM users ORDER BY id`);

    await test('M61-03-EXISTING-ROWS-SURVIVE-UNTOUCHED', async () => {
      assert.deepEqual(forward.map((m) => m.name), [MIGRATION_61], 'exactly one migration: 61');
      assert.equal(after.length, before.length);
      for (const [index, row] of before.entries()) {
        const { emailVerificationRequired, deletionRequestedAt, deletionCompletedAt, ...rest } = after[index];
        assert.deepEqual(rest, row, `row ${row.email} unchanged: status, isEmailVerified, role, identifiers`);
        assert.equal(deletionRequestedAt, null);
        assert.equal(deletionCompletedAt, null);
      }
    });

    await test('M61-04-EXISTING-ACCOUNTS-ARE-GRANDFATHERED', async () => {
      assert.ok(after.every((row: any) => row.emailVerificationRequired === false), 'every pre-61 account: false');
      // isEmailVerified was NOT mass-changed: the unverified rows stay unverified.
      assert.deepEqual(after.map((row: any) => row.isEmailVerified), seed.map((s) => s[3]));
    });

    await test('M61-05-NEW-ACCOUNTS-DEFAULT-TO-REQUIRED', async () => {
      const [row] = await ds.query(
        `INSERT INTO users (email,"passwordHash",role,status) VALUES ('m61.new@example.invalid','x','guard','active') RETURNING "emailVerificationRequired","isEmailVerified"`,
      );
      assert.equal(row.emailVerificationRequired, true);
      assert.equal(row.isEmailVerified, false);
      await ds.query(`DELETE FROM users WHERE email = 'm61.new@example.invalid'`);
    });

    await test('M61-06-APPROVED-SCHEMA', async () => {
      const s = await snapshot();
      const col = (table: string, name: string) => s.columns.find((c: any) => c.table_name === table && c.column_name === name);
      assert.deepEqual(
        [col('users', 'deletionRequestedAt')?.data_type, col('users', 'deletionRequestedAt')?.is_nullable],
        ['timestamp with time zone', 'YES'],
      );
      assert.deepEqual(
        [col('users', 'deletionCompletedAt')?.data_type, col('users', 'deletionCompletedAt')?.is_nullable],
        ['timestamp with time zone', 'YES'],
      );
      assert.deepEqual(
        [col('users', 'emailVerificationRequired')?.data_type, col('users', 'emailVerificationRequired')?.is_nullable, col('users', 'emailVerificationRequired')?.column_default],
        ['boolean', 'NO', 'true'],
      );
      const tokenColumns = s.columns.filter((c: any) => c.table_name === 'user_verification_tokens')
        .map((c: any) => `${c.column_name}:${c.data_type}:${c.is_nullable}${c.character_maximum_length ? ':' + c.character_maximum_length : ''}`);
      assert.deepEqual(tokenColumns.sort(), [
        'createdAt:timestamp with time zone:NO',
        'expiresAt:timestamp with time zone:NO',
        'id:integer:NO',
        'invalidatedAt:timestamp with time zone:YES',
        'purpose:character varying:NO:32',
        'tokenHash:character varying:NO:64',
        'usedAt:timestamp with time zone:YES',
        'userId:integer:NO',
      ]);
      const fk = s.constraints.find((c: any) => c.contype === 'f');
      assert.match(fk.def, /FOREIGN KEY \("userId"\) REFERENCES users\(id\) ON DELETE CASCADE/);
      assert.ok(s.indexes.some((i: any) => i.indexname === 'UQ_user_verification_tokens_token_hash' && /UNIQUE/.test(i.indexdef)));
      assert.ok(s.indexes.some((i: any) => i.indexname === 'IDX_user_verification_tokens_user_purpose'));
    });

    await test('M61-10-NO-ENUM-NO-SPECULATIVE-INDEX-NO-RETENTION-REASON', async () => {
      assert.equal(
        await scalar(`SELECT count(*)::int FROM pg_type WHERE typtype = 'e' AND (typname ILIKE '%verification_token%' OR typname ILIKE '%purpose%')`),
        0,
        'purpose is not a PostgreSQL enum',
      );
      assert.equal(
        await scalar(`SELECT udt_name FROM information_schema.columns WHERE table_name='user_verification_tokens' AND column_name='purpose'`),
        'varchar',
      );
      const userIndexes = (await snapshot()).indexes.filter((i: any) => /deletion/i.test(i.indexdef));
      assert.deepEqual(userIndexes, [], 'no deletionRequestedAt index (no query needs one)');
      // (guard_screenings.retentionReviewAt predates Gate 2 and is screening-specific; it is not this.)
      assert.equal(
        await scalar(`SELECT count(*)::int FROM information_schema.columns WHERE table_name IN ('users','user_verification_tokens') AND column_name ILIKE 'retention%'`),
        0,
        'no retentionReason on the user row',
      );
    });

    await test('M61-07-SECOND-RUN-APPLIES-NOTHING', async () => {
      const again = await ds.runMigrations({ transaction: 'each' });
      assert.equal(again.length, 0);
      assert.equal(await migrationCount(), 61);
    });

    await test('M61-09-REAPPLY-RESTORES-THE-IDENTICAL-SCHEMA', async () => {
      // Snapshot taken on the fresh 0 → 61 run; this one is after 61 → 60 → 61 on seeded data.
      assert.deepEqual(await snapshot(), head);
      assert.deepEqual(await usersShape(), headUsers);
    });

    await test('M61-11-UP-IS-SAFE-TO-REPEAT-STATEMENT-BY-STATEMENT', async () => {
      // Every statement is guarded, so a partially applied run can be re-executed by hand without error
      // and without disturbing grandfathered rows.
      const runner = ds.createQueryRunner();
      try {
        const { AddAccountLifecycleAndVerificationTokens1720900000007 } = await import(
          '../src/database/migrations/1720900000007-AddAccountLifecycleAndVerificationTokens'
        );
        await new AddAccountLifecycleAndVerificationTokens1720900000007().up(runner);
      } finally {
        await runner.release();
      }
      assert.deepEqual(await snapshot(), head);
      const rows = await ds.query(`SELECT "emailVerificationRequired" FROM users`);
      assert.ok(rows.every((r: any) => r.emailVerificationRequired === false), 'grandfathered rows still false');
    });
  } finally {
    await ds.destroy();
  }

  console.log(JSON.stringify({ event: 'gate2_migration_61_certified', tests: passed }));
}

main().catch((error) => {
  console.error('FAIL ', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
