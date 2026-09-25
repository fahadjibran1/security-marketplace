/**
 * Migration rehearsal for AddReferenceConfirmedDates.
 *
 * Runs the repository's own migrations against a disposable PostgreSQL 17, rolls back to the point
 * immediately before this migration, seeds a reference row as it existed then, re-applies, and proves:
 * existing rows survive untouched, the new columns are nullable, the enum gained DISCREPANCY, a second
 * run is a no-op, and synchronize stays false.
 *
 * Positions are found by name rather than by a repository-wide migration count, so adding a later
 * migration does not break this rehearsal and does not require editing it.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.MIGRATION_REHEARSAL_DATABASE_URL;
if (!url) throw new Error('MIGRATION_REHEARSAL_DATABASE_URL is required (disposable database)');

const migrationsGlob = require('node:path').join(__dirname,'..','src','database','migrations','*.ts');
const base = { type: 'postgres' as const, url, entities: appEntities, synchronize: false, migrationsTableName: 'typeorm_migrations', logging: false };

let passed = 0;
const test = async (id: string, fn: () => Promise<void> | void) => { await fn(); passed += 1; console.log(`PASS  ${id}`); };

async function main() {
  const all = new DataSource({ ...base, migrations: [migrationsGlob] });
  await all.initialize();
  assert.equal(all.options.synchronize, false, 'DATABASE_SYNCHRONIZE must remain false');

  // Apply everything up to and including 56 by running all, then rolling the last one back — the
  // cleanest way to reach "production today" using only the repository's own migrations.
  // Not pinned to a repository-wide migration count: migrations added after this one must not break a
  // rehearsal of this one, and a hard-coded total needs editing on every future migration.
  const TARGET = /AddReferenceConfirmedDates/;
  const applied = await all.runMigrations({ transaction: 'each' });
  console.log(`applied ${applied.length} migrations`);
  await test('REHEARSAL-TARGET-PRESENT', async () => {
    assert.ok(applied.length > 0, `expected migrations to apply, applied ${applied.length}`);
    assert.ok(
      applied.some((m) => TARGET.test(m.name)),
      `the migration under rehearsal was not applied: ${applied.map((m) => m.name).join(', ')}`,
    );
  });

  const appliedNames = async (): Promise<string[]> =>
    (await all.query('SELECT name FROM typeorm_migrations ORDER BY id ASC')).map((r: { name: string }) => r.name);

  // Roll back to the point immediately before the target, however many migrations follow it.
  const totalApplied = applied.length;
  let undone = 0;
  while ((await appliedNames()).some((name) => TARGET.test(name))) {
    await all.undoLastMigration({ transaction: 'each' });
    undone += 1;
    assert.ok(undone <= totalApplied, 'ran out of migrations to undo while looking for the target');
  }
  await test('REHEARSAL-ROLLED-BACK-TO-JUST-BEFORE-TARGET', async () => {
    const names = await appliedNames();
    assert.ok(!names.some((name) => TARGET.test(name)), 'the target migration must not be applied');
    assert.equal(
      names.length,
      totalApplied - undone,
      `expected ${totalApplied - undone} migrations applied, found ${names.length}`,
    );
  });

  // Seed a reference exactly as production holds one today, at migration 56.
  await all.query(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified") VALUES ('rehearsal.guard@example.invalid','x','guard','active',true)`);
  const userId = Number((await all.query(`SELECT id FROM users WHERE email='rehearsal.guard@example.invalid'`))[0].id);
  await all.query(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'Rehearsal Guard','7200000000000001','07700000000')`, [userId]);
  const guardId = Number((await all.query(`SELECT id FROM guard_profiles WHERE "userId"=$1`, [userId]))[0].id);
  await all.query(`INSERT INTO guard_screenings ("guardId",status,"screeningPeriodYears","legalFullName") VALUES ($1,'UNDER_REVIEW',5,'Rehearsal Guard')`, [guardId]);
  const screeningId = Number((await all.query(`SELECT id FROM guard_screenings WHERE "guardId"=$1`, [guardId]))[0].id);
  await all.query(`INSERT INTO screening_history ("screeningId",type,"startDate","endDate","isCurrent",organisation,description) VALUES ($1,'EMPLOYMENT','2015-01-01',NULL,true,'Acme Security Ltd','Officer')`, [screeningId]);
  const historyId = Number((await all.query(`SELECT id FROM screening_history WHERE "screeningId"=$1`, [screeningId]))[0].id);
  await all.query(`INSERT INTO screening_references ("screeningId","historyId",organisation,"contactPerson",relationship,"businessEmail",status,"sourceVerified","verificationMethod","outcomeNotes")
     VALUES ($1,$2,'Acme Security Ltd','Jane Referee','Line manager','jane@example.invalid','VERIFIED',true,'Telephone call','Pre-existing note')`, [screeningId, historyId]);
  const before = (await all.query(`SELECT * FROM screening_references WHERE "screeningId"=$1`, [screeningId]))[0];

  // Now re-apply the target migration on top of real pre-existing data.
  const second = await all.runMigrations({ transaction: 'each' });
  await test('REHEARSAL-REAPPLIES-TARGET-FIRST', async () => {
    assert.equal(second.length, undone, `expected ${undone} migrations to re-apply, applied ${second.length}`);
    assert.match(second[0].name, TARGET, 'the target must be the first migration re-applied');
  });

  const after = (await all.query(`SELECT * FROM screening_references WHERE "screeningId"=$1`, [screeningId]))[0];
  await test('REHEARSAL-EXISTING-ROW-PRESERVED', async () => {
    for (const field of ['id', 'screeningId', 'historyId', 'organisation', 'contactPerson', 'relationship', 'businessEmail', 'status', 'sourceVerified', 'verificationMethod', 'outcomeNotes']) {
      assert.deepEqual(after[field], before[field], `${field} changed during migration`);
    }
  });
  await test('REHEARSAL-NEW-COLUMNS-NULLABLE', async () => {
    assert.equal(after.confirmedStartDate, null);
    assert.equal(after.confirmedEndDate, null);
    assert.equal(after.confirmedIsCurrent, null);
    const cols = await all.query(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='screening_references' AND column_name IN ('confirmedStartDate','confirmedEndDate','confirmedIsCurrent')`);
    assert.equal(cols.length, 3, 'all three columns must exist');
    for (const c of cols) assert.equal(c.is_nullable, 'YES', `${c.column_name} must be nullable`);
  });
  await test('REHEARSAL-ENUM-DISCREPANCY', async () => {
    const labels = (await all.query(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='screening_reference_status_enum'`)).map((r: { enumlabel: string }) => r.enumlabel);
    assert.ok(labels.includes('DISCREPANCY'), `DISCREPANCY missing from enum: ${labels.join(',')}`);
    for (const existing of ['NOT_REQUESTED', 'REQUESTED', 'RECEIVED', 'SOURCE_VERIFICATION_REQUIRED', 'VERIFIED', 'UNABLE_TO_VERIFY', 'REJECTED']) {
      assert.ok(labels.includes(existing), `${existing} lost from enum`);
    }
    // And it is actually usable on a real row.
    await all.query(`UPDATE screening_references SET status='DISCREPANCY', "confirmedStartDate"='2015-01-01', "confirmedEndDate"='2019-06-30', "confirmedIsCurrent"=false WHERE "screeningId"=$1`, [screeningId]);
    const row = (await all.query(`SELECT status, "confirmedEndDate" FROM screening_references WHERE "screeningId"=$1`, [screeningId]))[0];
    assert.equal(row.status, 'DISCREPANCY');
    assert.ok(row.confirmedEndDate, 'confirmed dates must persist');
  });
  await test('REHEARSAL-SECOND-RUN-IDEMPOTENT', async () => {
    const third = await all.runMigrations({ transaction: 'each' });
    assert.equal(third.length, 0, 'a second run must apply nothing');
    const n = Number((await all.query('SELECT count(*)::int n FROM typeorm_migrations'))[0].n);
    assert.equal(n, totalApplied, `expected ${totalApplied} recorded migrations, found ${n}`);
  });

  console.log(JSON.stringify({
    event: 'migration_rehearsal_passed',
    tests: passed,
    target: 'AddReferenceConfirmedDates1720900000003',
    rolledBack: undone,
    totalMigrations: totalApplied,
  }));
  await all.destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });

