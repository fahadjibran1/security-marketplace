// P1H Staging Migrations — Site Timezone + ClientBilledHoursSnapshot + Weekly Approval Tables
// Reads DB URL from DATABASE_URL environment variable.
// Safe: verifies DB name before any write, wraps each migration in a transaction.
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
  // ── Migration history pre-check ──────────────────────────────────────────────
  const hist = await client.query(
    `SELECT timestamp, name FROM typeorm_migrations ORDER BY timestamp DESC LIMIT 30`
  );
  console.log('MIGRATION HISTORY (recent):');
  for (const m of hist.rows) console.log(`  [${m.timestamp}] ${m.name}`);

  const recorded = new Set(hist.rows.map(r => String(r.timestamp)));
  const p1gbPresent = recorded.has('1720700000000') || recorded.has('1720700000001');
  if (!p1gbPresent) {
    console.error('\nABORT: P1G-B migrations not found — prerequisite not met');
    await client.end(); process.exit(1);
  }
  console.log('\nP1G-B PREREQUISITE: PRESENT');

  const p1hA = recorded.has('1720800000000');
  const p1hB = recorded.has('1720800000001');
  const p1hC = recorded.has('1720800000002');
  console.log(`\nP1H migration status:`);
  console.log(`  1720800000000 (AddSiteTimezone):              ${p1hA ? 'ALREADY RECORDED' : 'PENDING'}`);
  console.log(`  1720800000001 (AddClientBilledHoursSnapshot): ${p1hB ? 'ALREADY RECORDED' : 'PENDING'}`);
  console.log(`  1720800000002 (CreateClientWeeklyApprovalTables): ${p1hC ? 'ALREADY RECORDED' : 'PENDING'}`);

  // Pre-check: no unexpected existing columns/tables
  const timezoneExists = (await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sites' AND column_name='timezone'`
  )).rows.length > 0;
  const billedHoursExists = (await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='timesheets' AND column_name='clientBilledHoursSnapshot'`
  )).rows.length > 0;
  const approvalTableExists = (await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='client_weekly_approval_requests'`
  )).rows.length > 0;

  console.log(`\nPre-check schema state:`);
  console.log(`  sites.timezone column exists:                ${timezoneExists}`);
  console.log(`  timesheets.clientBilledHoursSnapshot exists: ${billedHoursExists}`);
  console.log(`  client_weekly_approval_requests table exists: ${approvalTableExists}`);

  if ((p1hA && !timezoneExists) || (!p1hA && timezoneExists)) {
    console.error('ABORT: Inconsistent state for Migration A (timezone)');
    await client.end(); process.exit(1);
  }
  if ((p1hB && !billedHoursExists) || (!p1hB && billedHoursExists)) {
    console.error('ABORT: Inconsistent state for Migration B (clientBilledHoursSnapshot)');
    await client.end(); process.exit(1);
  }
  if ((p1hC && !approvalTableExists) || (!p1hC && approvalTableExists)) {
    console.error('ABORT: Inconsistent state for Migration C (approval tables)');
    await client.end(); process.exit(1);
  }

  // ── Migration A: AddSiteTimezone ─────────────────────────────────────────────
  if (!p1hA) {
    console.log('\n── APPLYING MIGRATION A: AddSiteTimezone (1720800000000) ──');
    await client.query('BEGIN');
    await client.query(
      `ALTER TABLE "sites" ADD COLUMN "timezone" VARCHAR(64) NOT NULL DEFAULT 'Europe/London'`
    );
    await client.query(
      `INSERT INTO typeorm_migrations (timestamp, name) VALUES ($1, $2)`,
      [1720800000000, 'AddSiteTimezone1720800000000']
    );
    await client.query('COMMIT');
    console.log('Migration A: APPLIED');
  } else {
    console.log('\nMigration A already recorded — skipping');
  }

  // ── Migration B: AddClientBilledHoursSnapshot ────────────────────────────────
  if (!p1hB) {
    console.log('\n── APPLYING MIGRATION B: AddClientBilledHoursSnapshot (1720800000001) ──');
    await client.query('BEGIN');
    await client.query(
      `ALTER TABLE "timesheets" ADD COLUMN "clientBilledHoursSnapshot" NUMERIC(8,2) NULL`
    );
    await client.query(
      `INSERT INTO typeorm_migrations (timestamp, name) VALUES ($1, $2)`,
      [1720800000001, 'AddClientBilledHoursSnapshot1720800000001']
    );
    await client.query('COMMIT');
    console.log('Migration B: APPLIED');
  } else {
    console.log('\nMigration B already recorded — skipping');
  }

  // ── Migration C: CreateClientWeeklyApprovalTables ───────────────────────────
  if (!p1hC) {
    console.log('\n── APPLYING MIGRATION C: CreateClientWeeklyApprovalTables (1720800000002) ──');
    await client.query('BEGIN');

    await client.query(`
      CREATE TYPE "client_weekly_approval_status_enum" AS ENUM (
        'pending_approval','client_approved','disputed','resolved','locked'
      )
    `);
    await client.query(`
      CREATE TYPE "client_shift_dispute_status_enum" AS ENUM (
        'open','resolved','withdrawn'
      )
    `);
    await client.query(`
      CREATE TABLE "client_weekly_approval_requests" (
        "id"                   SERIAL PRIMARY KEY,
        "companyId"            INT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
        "clientId"             INT NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "siteId"               INT NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
        "weekCommencing"       DATE NOT NULL,
        "weekEnding"           DATE NOT NULL,
        "status"               "client_weekly_approval_status_enum" NOT NULL DEFAULT 'pending_approval',
        "currentVersion"       INT NOT NULL DEFAULT 1,
        "submittedAt"          TIMESTAMPTZ,
        "submittedByUserId"    INT REFERENCES "users"("id") ON DELETE SET NULL,
        "clientRespondedAt"    TIMESTAMPTZ,
        "clientRespondedBy"    INT REFERENCES "users"("id") ON DELETE SET NULL,
        "totalApprovedHours"   NUMERIC(8,2),
        "companyInternalNote"  TEXT,
        "clientSubmissionNote" TEXT,
        "createdAt"            TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt"            TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_weekly_approval_company_client_site_week"
          UNIQUE("companyId","clientId","siteId","weekCommencing")
      )
    `);
    await client.query(`CREATE INDEX "IDX_weekly_approval_client_status" ON "client_weekly_approval_requests"("clientId","status")`);
    await client.query(`CREATE INDEX "IDX_weekly_approval_company_status" ON "client_weekly_approval_requests"("companyId","status")`);

    await client.query(`
      CREATE TABLE "client_weekly_approval_lines" (
        "id"                          SERIAL PRIMARY KEY,
        "weeklyApprovalRequestId"     INT NOT NULL REFERENCES "client_weekly_approval_requests"("id") ON DELETE CASCADE,
        "timesheetId"                 INT NOT NULL REFERENCES "timesheets"("id"),
        "submissionVersion"           INT NOT NULL DEFAULT 1,
        "superseded"                  BOOLEAN NOT NULL DEFAULT FALSE,
        "approvedHoursAtSubmission"   NUMERIC(8,2) NOT NULL,
        "shiftDate"                   DATE NOT NULL,
        "scheduledStart"              TIMESTAMPTZ,
        "scheduledEnd"                TIMESTAMPTZ,
        "actualCheckIn"               TIMESTAMPTZ,
        "actualCheckOut"              TIMESTAMPTZ,
        "verifiedMinutes"             INT,
        "hasOverride"                 BOOLEAN NOT NULL DEFAULT FALSE,
        "createdAt"                   TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_approval_line_request_timesheet_version"
          UNIQUE("weeklyApprovalRequestId","timesheetId","submissionVersion")
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX "UQ_active_approval_line"
        ON "client_weekly_approval_lines"("timesheetId")
        WHERE "superseded" = FALSE
    `);

    await client.query(`
      CREATE TABLE "client_shift_disputes" (
        "id"                      SERIAL PRIMARY KEY,
        "weeklyApprovalRequestId" INT NOT NULL REFERENCES "client_weekly_approval_requests"("id"),
        "lineId"                  INT NOT NULL REFERENCES "client_weekly_approval_lines"("id"),
        "timesheetId"             INT NOT NULL REFERENCES "timesheets"("id"),
        "submissionVersion"       INT NOT NULL,
        "disputeReason"           TEXT NOT NULL,
        "disputedByUserId"        INT REFERENCES "users"("id") ON DELETE SET NULL,
        "disputedAt"              TIMESTAMPTZ NOT NULL DEFAULT now(),
        "status"                  "client_shift_dispute_status_enum" NOT NULL DEFAULT 'open',
        "resolutionMessage"       TEXT,
        "resolvedByUserId"        INT REFERENCES "users"("id") ON DELETE SET NULL,
        "resolvedAt"              TIMESTAMPTZ,
        "createdAt"               TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt"               TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX "IDX_disputes_request_status" ON "client_shift_disputes"("weeklyApprovalRequestId","status")`);

    await client.query(
      `INSERT INTO typeorm_migrations (timestamp, name) VALUES ($1, $2)`,
      [1720800000002, 'CreateClientWeeklyApprovalTables1720800000002']
    );
    await client.query('COMMIT');
    console.log('Migration C: APPLIED');
  } else {
    console.log('\nMigration C already recorded — skipping');
  }

  // ── Schema Verification ──────────────────────────────────────────────────────
  console.log('\n════ SCHEMA VERIFICATION ════\n');

  // A. sites.timezone
  const tzCol = await client.query(
    `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='sites' AND column_name='timezone'`
  );
  const tzRow = tzCol.rows[0];
  console.log('A. sites.timezone:');
  if (tzRow) {
    const typeOk = tzRow.data_type === 'character varying';
    const lenOk = Number(tzRow.character_maximum_length) === 64;
    const nullOk = tzRow.is_nullable === 'NO';
    const defOk = tzRow.column_default && tzRow.column_default.includes('Europe/London');
    console.log(`   data_type:   ${tzRow.data_type} — ${typeOk ? 'OK' : 'FAIL'}`);
    console.log(`   max_length:  ${tzRow.character_maximum_length} — ${lenOk ? 'OK' : 'FAIL'}`);
    console.log(`   nullable:    ${tzRow.is_nullable} — ${nullOk ? 'OK (NOT NULL)' : 'FAIL'}`);
    console.log(`   default:     ${tzRow.column_default} — ${defOk ? 'OK' : 'FAIL'}`);
    console.log(`   RESULT: ${typeOk && lenOk && nullOk && defOk ? 'PASS' : 'FAIL'}`);
  } else {
    console.error('   FAIL — column not found');
  }

  // B. timesheets.clientBilledHoursSnapshot
  const cbhCol = await client.query(
    `SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='timesheets' AND column_name='clientBilledHoursSnapshot'`
  );
  const cbhRow = cbhCol.rows[0];
  console.log('\nB. timesheets.clientBilledHoursSnapshot:');
  if (cbhRow) {
    const typeOk = cbhRow.data_type === 'numeric';
    const precOk = Number(cbhRow.numeric_precision) === 8;
    const scaleOk = Number(cbhRow.numeric_scale) === 2;
    const nullOk = cbhRow.is_nullable === 'YES';
    console.log(`   data_type:  ${cbhRow.data_type} — ${typeOk ? 'OK' : 'FAIL'}`);
    console.log(`   precision:  ${cbhRow.numeric_precision} — ${precOk ? 'OK' : 'FAIL'}`);
    console.log(`   scale:      ${cbhRow.numeric_scale} — ${scaleOk ? 'OK' : 'FAIL'}`);
    console.log(`   nullable:   ${cbhRow.is_nullable} — ${nullOk ? 'OK (nullable)' : 'FAIL'}`);
    console.log(`   RESULT: ${typeOk && precOk && scaleOk && nullOk ? 'PASS' : 'FAIL'}`);
  } else {
    console.error('   FAIL — column not found');
  }

  // C-E. Table columns
  for (const [table, expectedCols] of [
    ['client_weekly_approval_requests', [
      'id','companyId','clientId','siteId','weekCommencing','weekEnding','status','currentVersion',
      'submittedAt','submittedByUserId','clientRespondedAt','clientRespondedBy','totalApprovedHours',
      'companyInternalNote','clientSubmissionNote','createdAt','updatedAt'
    ]],
    ['client_weekly_approval_lines', [
      'id','weeklyApprovalRequestId','timesheetId','submissionVersion','superseded',
      'approvedHoursAtSubmission','shiftDate','scheduledStart','scheduledEnd',
      'actualCheckIn','actualCheckOut','verifiedMinutes','hasOverride','createdAt'
    ]],
    ['client_shift_disputes', [
      'id','weeklyApprovalRequestId','lineId','timesheetId','submissionVersion',
      'disputeReason','disputedByUserId','disputedAt','status','resolutionMessage',
      'resolvedByUserId','resolvedAt','createdAt','updatedAt'
    ]]
  ]) {
    const colsRes = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      [table]
    );
    const actualCols = colsRes.rows.map(r => r.column_name);
    const missing = expectedCols.filter(c => !actualCols.includes(c));
    const label = table === 'client_weekly_approval_requests' ? 'C' :
                  table === 'client_weekly_approval_lines' ? 'D' : 'E';
    console.log(`\n${label}. ${table}:`);
    console.log(`   columns present: ${actualCols.length}`);
    if (missing.length === 0) console.log(`   RESULT: PASS — all ${expectedCols.length} expected columns present`);
    else console.error(`   RESULT: FAIL — missing: ${missing.join(', ')}`);
  }

  // F. Constraints and indexes
  console.log('\nF. Constraints / Indexes:');

  const uniqConstraint = await client.query(
    `SELECT constraint_name FROM information_schema.table_constraints
     WHERE table_schema='public' AND table_name='client_weekly_approval_requests'
     AND constraint_type='UNIQUE' AND constraint_name='UQ_weekly_approval_company_client_site_week'`
  );
  console.log(`   UNIQUE(companyId,clientId,siteId,weekCommencing): ${uniqConstraint.rows.length > 0 ? 'PASS' : 'FAIL'}`);

  const lineUniq = await client.query(
    `SELECT constraint_name FROM information_schema.table_constraints
     WHERE table_schema='public' AND table_name='client_weekly_approval_lines'
     AND constraint_type='UNIQUE' AND constraint_name='UQ_approval_line_request_timesheet_version'`
  );
  console.log(`   UNIQUE(requestId,timesheetId,submissionVersion): ${lineUniq.rows.length > 0 ? 'PASS' : 'FAIL'}`);

  const partialIdx = await client.query(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname='public' AND tablename='client_weekly_approval_lines'
     AND indexname='UQ_active_approval_line'`
  );
  if (partialIdx.rows.length > 0) {
    const def = partialIdx.rows[0].indexdef;
    const hasWhere = def.includes('superseded') && def.toLowerCase().includes('false');
    console.log(`   Partial unique index WHERE superseded=FALSE: ${hasWhere ? 'PASS' : 'FAIL'}`);
    console.log(`   indexdef: ${def}`);
  } else {
    console.error(`   Partial unique index WHERE superseded=FALSE: FAIL — not found`);
  }

  const fkCheck = await client.query(
    `SELECT tc.constraint_name, kcu.column_name, ccu.table_name AS foreign_table
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu ON kcu.constraint_name=tc.constraint_name
     JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name
     WHERE tc.constraint_type='FOREIGN KEY'
     AND tc.table_name IN ('client_weekly_approval_requests','client_weekly_approval_lines','client_shift_disputes')
     ORDER BY tc.table_name, kcu.column_name`
  );
  console.log(`   Foreign keys defined: ${fkCheck.rows.length}`);
  for (const fk of fkCheck.rows) {
    console.log(`   FK: ${fk.table_name || ''}.${fk.column_name} → ${fk.foreign_table}`);
  }

  // G. Migration history
  const migs = await client.query(
    `SELECT timestamp, name FROM typeorm_migrations WHERE timestamp IN (1720800000000,1720800000001,1720800000002) ORDER BY timestamp`
  );
  console.log('\nG. P1H Migration records:');
  for (const m of migs.rows) console.log(`   [${m.timestamp}] ${m.name}`);
  const allThree = migs.rows.length === 3;
  console.log(`   All 3 recorded exactly once: ${allThree ? 'PASS' : 'FAIL'}`);

  console.log('\n════ MIGRATION COMPLETE ════');
  console.log(`Applied: ${(!p1hA ? 'A ' : '') + (!p1hB ? 'B ' : '') + (!p1hC ? 'C' : '')}`.trim() || 'none (all already applied)');
  console.log(`Status: ${allThree ? 'SUCCESS' : 'REVIEW NEEDED'}`);

} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('\nMIGRATION FAILED:', e.message);
  console.error(e.stack);
  await client.end();
  process.exit(1);
} finally {
  await client.end();
}
