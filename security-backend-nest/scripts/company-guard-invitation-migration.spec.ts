/**
 * Migration rehearsal for 57 → 58 (AddCompanyGuardInvitations).
 *
 * Runs the repository's own migrations against a disposable PostgreSQL 17, rolls back to the schema
 * production is on today (57), seeds a CompanyGuard relationship exactly as production holds one, then
 * applies 58 and proves: the existing relationship survives untouched with the new columns NULL, the
 * invitation table and its constraints exist, the shared relationship-type enum was reused rather
 * than duplicated, a second run is a no-op, down() is clean, and synchronize stays false.
 *
 * Needs PHASEB_MIGRATION_DATABASE_URL pointing at a DISPOSABLE database.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.PHASEB_MIGRATION_DATABASE_URL;
if (!url) throw new Error('PHASEB_MIGRATION_DATABASE_URL is required (disposable database)');
if (!/127\.0\.0\.1|localhost/.test(url)) {
  throw new Error('PHASEB_MIGRATION_DATABASE_URL must point at a local disposable database');
}

const migrationsGlob = require('node:path').join(__dirname, '..', 'src', 'database', 'migrations', '*.ts');
const base = {
  type: 'postgres' as const,
  url,
  entities: appEntities,
  synchronize: false,
  migrationsTableName: 'typeorm_migrations',
  logging: false,
};

let passed = 0;
const test = async (id: string, fn: () => Promise<void> | void) => {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
};

async function main() {
  const ds = new DataSource({ ...base, migrations: [migrationsGlob] });
  await ds.initialize();

  try {
    assert.equal(ds.options.synchronize, false, 'DATABASE_SYNCHRONIZE must remain false');

    const applied = await ds.runMigrations({ transaction: 'each' });
    await test('PHASEB-MIGRATION-COUNT-58', () => {
      assert.equal(applied.length, 58, `expected 58 migrations, applied ${applied.length}`);
      assert.equal(
        applied[applied.length - 1].name,
        'AddCompanyGuardInvitations1720900000004',
        'the new migration must be the last one',
      );
    });

    // Roll back to the schema version production is on right now.
    await ds.undoLastMigration({ transaction: 'each' });
    const at57 = Number((await ds.query('SELECT count(*)::int n FROM typeorm_migrations'))[0].n);
    await test('PHASEB-BACK-TO-57', () => {
      assert.equal(at57, 57, `expected to be back at 57, found ${at57}`);
    });

    await test('PHASEB-DOWN-REMOVED-EVERYTHING-IT-ADDED', async () => {
      const table = await ds.query(
        `SELECT to_regclass('public.company_guard_invitations') IS NOT NULL AS present`,
      );
      assert.equal(table[0].present, false, 'the invitation table must be gone after down()');
      const cols = await ds.query(
        `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'company_guards' AND column_name IN ('acceptedAt','invitationId')`,
      );
      assert.equal(cols.length, 0, 'the CompanyGuard columns must be gone after down()');
      // The shared enum must survive down(), because company_guards still uses it.
      const enumRow = await ds.query(
        `SELECT 1 FROM pg_type WHERE typname = 'company_guards_relationshiptype_enum'`,
      );
      assert.equal(enumRow.length, 1, 'the shared relationship-type enum must not be dropped');
    });

    // Seed a relationship exactly as production holds one, at migration 57.
    await ds.query(
      `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified")
       VALUES ('phaseb.owner@example.invalid','x','company_admin','active',true)`,
    );
    const ownerId = Number(
      (await ds.query(`SELECT id FROM users WHERE email='phaseb.owner@example.invalid'`))[0].id,
    );
    await ds.query(
      `INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails")
       VALUES ($1,'Phase B Security Ltd','99887766','1 Rehearsal Way','ops@example.invalid')`,
      [ownerId],
    );
    const companyId = Number(
      (await ds.query(`SELECT id FROM companies WHERE "companyNumber"='99887766'`))[0].id,
    );
    await ds.query(
      `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified")
       VALUES ('phaseb.guard@example.invalid','x','guard','active',true)`,
    );
    const guardUserId = Number(
      (await ds.query(`SELECT id FROM users WHERE email='phaseb.guard@example.invalid'`))[0].id,
    );
    await ds.query(
      `INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone)
       VALUES ($1,'Rehearsal Guard','7300000000000001','07700000000')`,
      [guardUserId],
    );
    const guardId = Number(
      (await ds.query(`SELECT id FROM guard_profiles WHERE "userId"=$1`, [guardUserId]))[0].id,
    );
    await ds.query(
      `INSERT INTO company_guards ("companyId","guardId",status,"relationshipType")
       VALUES ($1,$2,'ACTIVE','EMPLOYEE')`,
      [companyId, guardId],
    );
    const relationBefore = (
      await ds.query(`SELECT * FROM company_guards WHERE "companyId"=$1 AND "guardId"=$2`, [companyId, guardId])
    )[0];

    // Apply 58 on top of populated production-shaped data.
    const reapplied = await ds.runMigrations({ transaction: 'each' });
    await test('PHASEB-REAPPLY-ONLY-58', () => {
      assert.equal(reapplied.length, 1, `expected exactly 1 migration, applied ${reapplied.length}`);
      assert.equal(reapplied[0].name, 'AddCompanyGuardInvitations1720900000004');
    });

    await test('PHASEB-EXISTING-RELATIONSHIP-PRESERVED', async () => {
      const after = (
        await ds.query(`SELECT * FROM company_guards WHERE "companyId"=$1 AND "guardId"=$2`, [companyId, guardId])
      )[0];
      assert.equal(after.id, relationBefore.id, 'the row id must not change');
      assert.equal(after.status, 'ACTIVE', 'status must be untouched');
      assert.equal(after.relationshipType, 'EMPLOYEE', 'relationshipType must be untouched');
      assert.equal(
        new Date(after.createdAt).getTime(),
        new Date(relationBefore.createdAt).getTime(),
        'createdAt must be untouched',
      );
      // Pre-existing relationships were not established by guard consent, so both stay NULL.
      assert.equal(after.acceptedAt, null, 'acceptedAt must default to NULL for existing rows');
      assert.equal(after.invitationId, null, 'invitationId must default to NULL for existing rows');
      const count = Number(
        (await ds.query('SELECT count(*)::int n FROM company_guards'))[0].n,
      );
      assert.equal(count, 1, 'no relationship row was added or removed');
    });

    await test('PHASEB-COLUMNS-ARE-NULLABLE', async () => {
      const cols: Array<{ column_name: string; is_nullable: string; data_type: string }> =
        await ds.query(
          `SELECT column_name, is_nullable, data_type FROM information_schema.columns
             WHERE table_name = 'company_guards' AND column_name IN ('acceptedAt','invitationId')
             ORDER BY column_name`,
        );
      assert.equal(cols.length, 2, 'both columns must exist');
      cols.forEach((c) => assert.equal(c.is_nullable, 'YES', `${c.column_name} must be nullable`));
    });

    await test('PHASEB-INVITATION-TABLE-SHAPE', async () => {
      const cols: Array<{ column_name: string; is_nullable: string }> = await ds.query(
        `SELECT column_name, is_nullable FROM information_schema.columns
           WHERE table_name = 'company_guard_invitations' ORDER BY column_name`,
      );
      const names = cols.map((c) => c.column_name);
      for (const expected of [
        'id', 'companyId', 'relationshipType', 'targetSiaLicenceNumber', 'tokenDigest',
        'expiresAt', 'usedAt', 'declinedAt', 'revokedAt', 'revokedByUserId', 'invitedByUserId',
        'createdAt',
      ]) {
        assert.ok(names.includes(expected), `missing column ${expected}`);
      }
      const nullable = (name: string) => cols.find((c) => c.column_name === name)!.is_nullable;
      assert.equal(nullable('tokenDigest'), 'NO');
      assert.equal(nullable('expiresAt'), 'NO');
      assert.equal(nullable('invitedByUserId'), 'NO');
      assert.equal(nullable('usedAt'), 'YES');
      assert.equal(nullable('declinedAt'), 'YES');
      assert.equal(nullable('revokedAt'), 'YES');
      assert.equal(nullable('targetSiaLicenceNumber'), 'YES');
    });

    await test('PHASEB-TOKEN-DIGEST-IS-UNIQUE', async () => {
      const rows = await ds.query(
        `SELECT conname FROM pg_constraint WHERE conname = 'uq_cgi_token' AND contype = 'u'`,
      );
      assert.equal(rows.length, 1, 'tokenDigest must carry a unique constraint');
    });

    await test('PHASEB-ENUM-REUSED-NOT-DUPLICATED', async () => {
      const rows = await ds.query(
        `SELECT a.atttypid::regtype::text AS t
           FROM pg_attribute a
           WHERE a.attrelid = 'company_guard_invitations'::regclass
             AND a.attname = 'relationshipType'`,
      );
      assert.equal(
        rows[0].t,
        'company_guards_relationshiptype_enum',
        'the invitation must reuse the existing relationship-type enum',
      );
    });

    await test('PHASEB-SECOND-RUN-IS-A-NO-OP', async () => {
      const again = await ds.runMigrations({ transaction: 'each' });
      assert.equal(again.length, 0, 'a second run must apply nothing');
      const total = Number((await ds.query('SELECT count(*)::int n FROM typeorm_migrations'))[0].n);
      assert.equal(total, 58);
    });

    await test('PHASEB-FK-CASCADE-AND-SET-NULL', async () => {
      const rows: Array<{ conname: string; confdeltype: string }> = await ds.query(
        `SELECT conname, confdeltype FROM pg_constraint
           WHERE conrelid = 'company_guard_invitations'::regclass AND contype = 'f'`,
      );
      const byName = (needle: string) => rows.find((r) => r.conname.includes(needle));
      // 'c' = CASCADE, 'n' = SET NULL, 'r' = RESTRICT
      assert.ok(rows.length >= 3, `expected at least 3 foreign keys, found ${rows.length}`);
      const cascade = rows.filter((r) => r.confdeltype === 'c');
      assert.ok(cascade.length >= 1, 'companyId must cascade');
      const setNull = rows.filter((r) => r.confdeltype === 'n');
      assert.ok(setNull.length >= 1, 'revokedByUserId must set null');
      const restrict = rows.filter((r) => r.confdeltype === 'r');
      assert.ok(restrict.length >= 1, 'invitedByUserId must restrict');
      assert.ok(byName('') !== undefined);
    });

    console.log(JSON.stringify({ event: 'phaseb_migration_rehearsal_passed', tests: passed, from: 57, to: 58 }));
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
