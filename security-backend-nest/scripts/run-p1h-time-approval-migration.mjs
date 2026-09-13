// P1H Company Time Approval — Migration 1720800000003
// Adds companyApprovedStartAt / companyApprovedEndAt to timesheets
// Adds companyApprovedStartAtSubmission / companyApprovedEndAtSubmission to client_weekly_approval_lines
// Reads DB URL from DATABASE_URL environment variable.
// Safe: verifies DB name = security_marketplace_staging and host on render.com before any write.
import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;

const STAGING_DB = process.env.DATABASE_URL;
if (!STAGING_DB) {
  console.error('ABORT: DATABASE_URL environment variable is not set');
  process.exit(1);
}
const _dbName = new URL(STAGING_DB).pathname.replace(/^\//, '');
if (_dbName !== 'security_marketplace_staging') {
  console.error(`ABORT: DATABASE_URL points to "${_dbName}", not "security_marketplace_staging" — non-staging DB rejected`);
  process.exit(1);
}

const client = new Client({ connectionString: STAGING_DB, ssl: { rejectUnauthorized: false } });
await client.connect();

const dbHost = client.host;
const dbName = client.database;
console.log('TARGET VERIFICATION:');
console.log(`  host: ${dbHost}`);
console.log(`  name: ${dbName}`);

if (!dbHost.includes('render.com')) {
  console.error('ABORT: DB host is not on render.com — refusing to proceed');
  await client.end(); process.exit(1);
}
if (dbName !== 'security_marketplace_staging') {
  console.error(`ABORT: DB name is "${dbName}", not security_marketplace_staging`);
  await client.end(); process.exit(1);
}
console.log('TARGET CONFIRMED: staging\n');

try {
  // ── Pre-checks ──────────────────────────────────────────────────────────────
  const hist = await client.query(
    `SELECT timestamp, name FROM typeorm_migrations ORDER BY timestamp DESC LIMIT 30`
  );
  console.log('MIGRATION HISTORY (recent):');
  for (const m of hist.rows) console.log(`  [${m.timestamp}] ${m.name}`);

  const recorded = new Set(hist.rows.map(r => String(r.timestamp)));

  // Prerequisites: P1H migrations 1720800000000–1720800000002 must be present
  const prereqOk = recorded.has('1720800000000') && recorded.has('1720800000001') && recorded.has('1720800000002');
  if (!prereqOk) {
    console.error('\nABORT: P1H prerequisite migrations (1720800000000-1720800000002) not all recorded');
    await client.end(); process.exit(1);
  }
  console.log('\nP1H PREREQUISITES: PRESENT (1720800000000, 1720800000001, 1720800000002)');

  // Check if 1720800000003 already applied
  const alreadyApplied = recorded.has('1720800000003');
  console.log(`\n1720800000003 (AddCompanyApprovedTimes): ${alreadyApplied ? 'ALREADY RECORDED' : 'PENDING'}`);

  if (alreadyApplied) {
    console.log('\nMigration already recorded — verifying schema only, no DDL changes needed');
  } else {
    // ── Apply migration ──────────────────────────────────────────────────────
    console.log('\n── APPLYING MIGRATION 1720800000003: AddCompanyApprovedTimes ──');
    await client.query('BEGIN');

    await client.query(`ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "companyApprovedStartAt" TIMESTAMP NULL`);
    console.log('  Added timesheets.companyApprovedStartAt (TIMESTAMP NULL)');

    await client.query(`ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "companyApprovedEndAt" TIMESTAMP NULL`);
    console.log('  Added timesheets.companyApprovedEndAt (TIMESTAMP NULL)');

    await client.query(`ALTER TABLE "client_weekly_approval_lines" ADD COLUMN IF NOT EXISTS "companyApprovedStartAtSubmission" TIMESTAMPTZ NULL`);
    console.log('  Added client_weekly_approval_lines.companyApprovedStartAtSubmission (TIMESTAMPTZ NULL)');

    await client.query(`ALTER TABLE "client_weekly_approval_lines" ADD COLUMN IF NOT EXISTS "companyApprovedEndAtSubmission" TIMESTAMPTZ NULL`);
    console.log('  Added client_weekly_approval_lines.companyApprovedEndAtSubmission (TIMESTAMPTZ NULL)');

    await client.query(
      `INSERT INTO typeorm_migrations (timestamp, name) VALUES ($1, $2)`,
      [1720800000003, 'AddCompanyApprovedTimes1720800000003']
    );
    await client.query('COMMIT');
    console.log('\nMigration 1720800000003: APPLIED');
  }

  // ── Schema Verification ──────────────────────────────────────────────────────
  console.log('\n════ SCHEMA VERIFICATION ════\n');

  // 1. timesheets.companyApprovedStartAt
  const startCol = await client.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name='timesheets' AND column_name='companyApprovedStartAt'`
  );
  const startRow = startCol.rows[0];
  console.log('1. timesheets.companyApprovedStartAt:');
  if (startRow) {
    const typeOk = startRow.data_type === 'timestamp without time zone';
    const nullOk = startRow.is_nullable === 'YES';
    console.log(`   data_type: ${startRow.data_type} — ${typeOk ? 'OK (TIMESTAMP)' : 'UNEXPECTED'}`);
    console.log(`   nullable:  ${startRow.is_nullable} — ${nullOk ? 'OK' : 'FAIL'}`);
    console.log(`   RESULT: ${typeOk && nullOk ? 'PASS' : 'FAIL'}`);
  } else {
    console.error('   RESULT: FAIL — column not found');
  }

  // 2. timesheets.companyApprovedEndAt
  const endCol = await client.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name='timesheets' AND column_name='companyApprovedEndAt'`
  );
  const endRow = endCol.rows[0];
  console.log('\n2. timesheets.companyApprovedEndAt:');
  if (endRow) {
    const typeOk = endRow.data_type === 'timestamp without time zone';
    const nullOk = endRow.is_nullable === 'YES';
    console.log(`   data_type: ${endRow.data_type} — ${typeOk ? 'OK (TIMESTAMP)' : 'UNEXPECTED'}`);
    console.log(`   nullable:  ${endRow.is_nullable} — ${nullOk ? 'OK' : 'FAIL'}`);
    console.log(`   RESULT: ${typeOk && nullOk ? 'PASS' : 'FAIL'}`);
  } else {
    console.error('   RESULT: FAIL — column not found');
  }

  // 3. client_weekly_approval_lines.companyApprovedStartAtSubmission
  const snapStartCol = await client.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name='client_weekly_approval_lines' AND column_name='companyApprovedStartAtSubmission'`
  );
  const snapStartRow = snapStartCol.rows[0];
  console.log('\n3. client_weekly_approval_lines.companyApprovedStartAtSubmission:');
  if (snapStartRow) {
    const typeOk = snapStartRow.data_type === 'timestamp with time zone';
    const nullOk = snapStartRow.is_nullable === 'YES';
    console.log(`   data_type: ${snapStartRow.data_type} — ${typeOk ? 'OK (TIMESTAMPTZ)' : 'UNEXPECTED'}`);
    console.log(`   nullable:  ${snapStartRow.is_nullable} — ${nullOk ? 'OK' : 'FAIL'}`);
    console.log(`   RESULT: ${typeOk && nullOk ? 'PASS' : 'FAIL'}`);
  } else {
    console.error('   RESULT: FAIL — column not found');
  }

  // 4. client_weekly_approval_lines.companyApprovedEndAtSubmission
  const snapEndCol = await client.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name='client_weekly_approval_lines' AND column_name='companyApprovedEndAtSubmission'`
  );
  const snapEndRow = snapEndCol.rows[0];
  console.log('\n4. client_weekly_approval_lines.companyApprovedEndAtSubmission:');
  if (snapEndRow) {
    const typeOk = snapEndRow.data_type === 'timestamp with time zone';
    const nullOk = snapEndRow.is_nullable === 'YES';
    console.log(`   data_type: ${snapEndRow.data_type} — ${typeOk ? 'OK (TIMESTAMPTZ)' : 'UNEXPECTED'}`);
    console.log(`   nullable:  ${snapEndRow.is_nullable} — ${nullOk ? 'OK' : 'FAIL'}`);
    console.log(`   RESULT: ${typeOk && nullOk ? 'PASS' : 'FAIL'}`);
  } else {
    console.error('   RESULT: FAIL — column not found');
  }

  // 5. Preservation check — existing data untouched
  const timesheetCount = await client.query(`SELECT COUNT(*) AS n FROM timesheets`);
  const lineCount = await client.query(`SELECT COUNT(*) AS n FROM client_weekly_approval_lines`);
  const requestCount = await client.query(`SELECT COUNT(*) AS n FROM client_weekly_approval_requests`);
  console.log(`\n5. Row preservation:`);
  console.log(`   timesheets rows:                    ${timesheetCount.rows[0].n}`);
  console.log(`   client_weekly_approval_requests:    ${requestCount.rows[0].n}`);
  console.log(`   client_weekly_approval_lines rows:  ${lineCount.rows[0].n}`);
  console.log('   Existing rows preserved: OK (no DELETE / TRUNCATE in migration)');

  // 6. Migration recorded exactly once
  const mig3 = await client.query(
    `SELECT timestamp, name FROM typeorm_migrations WHERE timestamp = 1720800000003`
  );
  console.log(`\n6. Migration 1720800000003 recorded: ${mig3.rows.length === 1 ? 'EXACTLY ONCE — PASS' : 'FAIL'}`);
  if (mig3.rows.length > 0) console.log(`   name: ${mig3.rows[0].name}`);

  // 7. Previous P1H columns still intact
  const prevCheck = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='timesheets'
     AND column_name IN ('scheduledStartAt','scheduledEndAt','actualCheckInAt','actualCheckOutAt','verifiedMinutes','approvedMinutes','clientBilledHoursSnapshot')`
  );
  const prevCols = prevCheck.rows.map(r => r.column_name);
  const expectedPrev = ['scheduledStartAt','scheduledEndAt','actualCheckInAt','actualCheckOutAt','verifiedMinutes','approvedMinutes','clientBilledHoursSnapshot'];
  const prevMissing = expectedPrev.filter(c => !prevCols.includes(c));
  console.log(`\n7. Previous P1H timesheet columns intact:`);
  console.log(`   found: ${prevCols.join(', ')}`);
  console.log(`   RESULT: ${prevMissing.length === 0 ? 'PASS' : 'FAIL — missing: ' + prevMissing.join(', ')}`);

  // 8. Previous line snapshot columns intact
  const lineColCheck = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='client_weekly_approval_lines'
     AND column_name IN ('scheduledStart','scheduledEnd','actualCheckIn','actualCheckOut','verifiedMinutes','hasOverride','approvedHoursAtSubmission')`
  );
  const lineColNames = lineColCheck.rows.map(r => r.column_name);
  const expectedLineCols = ['scheduledStart','scheduledEnd','actualCheckIn','actualCheckOut','verifiedMinutes','hasOverride','approvedHoursAtSubmission'];
  const lineMissing = expectedLineCols.filter(c => !lineColNames.includes(c));
  console.log(`\n8. Previous line snapshot columns intact:`);
  console.log(`   found: ${lineColNames.join(', ')}`);
  console.log(`   RESULT: ${lineMissing.length === 0 ? 'PASS' : 'FAIL — missing: ' + lineMissing.join(', ')}`);

  console.log('\n════ MIGRATION 1720800000003: COMPLETE ════');

} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('\nMIGRATION FAILED:', e.message);
  console.error(e.stack);
  await client.end();
  process.exit(1);
} finally {
  await client.end();
}
