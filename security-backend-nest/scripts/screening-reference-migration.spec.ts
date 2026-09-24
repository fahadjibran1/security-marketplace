/**
 * Migration rehearsal for 56 → 57 (AddReferenceConfirmedDates).
 *
 * Runs the real compiled migrations against a disposable PostgreSQL 17, seeds a reference row at
 * migration 56, then applies 57 and proves: existing rows survive untouched, the new columns are
 * nullable, the enum gained DISCREPANCY, a second run is a no-op, and synchronize stays false.
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
  const applied = await all.runMigrations({ transaction: 'each' });
  console.log(`applied ${applied.length} migrations`);
  await test('REHEARSAL-COUNT-57', async () => { assert.equal(applied.length, 57, `expected 57 migrations, applied ${applied.length}`); });

  await all.undoLastMigration({ transaction: 'each' });
  const at56 = Number((await all.query('SELECT count(*)::int n FROM typeorm_migrations'))[0].n);
  await test('REHEARSAL-BACK-TO-56', async () => { assert.equal(at56, 56, `expected to be back at 56, found ${at56}`); });

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

  // Now apply 57 on top of real pre-existing data.
  const second = await all.runMigrations({ transaction: 'each' });
  await test('REHEARSAL-APPLIES-ONE', async () => { assert.equal(second.length, 1, `expected exactly migration 57, applied ${second.length}`); assert.match(second[0].name, /AddReferenceConfirmedDates/); });

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
    assert.equal(n, 57, `expected 57 recorded migrations, found ${n}`);
  });

  console.log(JSON.stringify({ event: 'migration_rehearsal_passed', tests: passed, from: 56, to: 57 }));
  await all.destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });

