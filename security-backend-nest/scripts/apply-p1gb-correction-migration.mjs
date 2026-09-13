// P1G-B corrective migration runner — staging ONLY.
// Applies migration 1720700000001-RemovePayrollPaymentMethod.
//
// Root-cause fix (2026-09-08): prior version queried table "migrations" which
// does not exist. TypeORM is configured with migrationsTableName: 'typeorm_migrations'
// (src/database/typeorm.config.ts line 46). All history queries now use that table.
//
// Pattern mirrors run-p1gb-migration.mjs which successfully applied 1720700000000.
//
// Usage:
//   $env:DATABASE_URL = "postgres://..."
//   node security-backend-nest/scripts/apply-p1gb-correction-migration.mjs
import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;

// ── Fail-closed guards (env-level) ──────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.error('ABORT: DATABASE_URL not set'); process.exit(1); }
const dbNameFromUrl = new URL(dbUrl).pathname.replace(/^\//, '');
if (dbNameFromUrl !== 'security_marketplace_staging') {
  console.error(`ABORT: DATABASE_URL points to "${dbNameFromUrl}", not "security_marketplace_staging" — production guard active`);
  process.exit(1);
}

const db = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await db.connect();

// ── Fail-closed guards (connection-level) ────────────────────────────────────
const dbHost = db.host;
const dbActual = (await db.query('SELECT current_database() AS d')).rows[0].d;

console.log('TARGET VERIFICATION:');
console.log(`  host: ${dbHost}`);
console.log(`  name: ${dbActual}`);

if (!dbHost.includes('render.com')) {
  console.error('ABORT: DB host is not on render.com — refusing to proceed');
  await db.end(); process.exit(1);
}
if (dbActual !== 'security_marketplace_staging') {
  console.error(`ABORT: current_database()="${dbActual}" — expected security_marketplace_staging`);
  await db.end(); process.exit(1);
}
console.log('TARGET CONFIRMED: staging on render.com');

// ── Pre-flight 1: typeorm_migrations table exists ────────────────────────────
// TypeORM uses migrationsTableName: 'typeorm_migrations' (typeorm.config.ts:46).
// The broken prior version queried table "migrations" — that table does not exist.
const migTableCheck = await db.query(`
  SELECT COUNT(*) AS n FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'typeorm_migrations'
`);
if (parseInt(migTableCheck.rows[0].n, 10) === 0) {
  console.error('ABORT: typeorm_migrations table not found — migration history unavailable');
  await db.end(); process.exit(1);
}
console.log('typeorm_migrations table confirmed');

// ── Pre-flight 2: original P1G-B migration must be recorded ─────────────────
const origCheck = await db.query(
  `SELECT timestamp, name FROM typeorm_migrations WHERE timestamp = 1720700000000`
);
if (origCheck.rows.length === 0) {
  console.error('ABORT: Original P1G-B migration (1720700000000) not found in typeorm_migrations — prerequisite not met');
  await db.end(); process.exit(1);
}
console.log(`Original P1G-B migration confirmed: [${origCheck.rows[0].timestamp}] ${origCheck.rows[0].name}`);

// ── Pre-flight 3: payrollPaymentMethod column must currently exist ────────────
const colCheck = await db.query(`
  SELECT COUNT(*) AS n FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'company_guard_payroll_records'
    AND column_name = 'payrollPaymentMethod'
`);
const colExists = parseInt(colCheck.rows[0].n, 10) > 0;
console.log(`payrollPaymentMethod column currently present: ${colExists}`);
if (!colExists) {
  console.error('ABORT: payrollPaymentMethod column not present — migration may already have been applied outside of this script');
  await db.end(); process.exit(1);
}

// ── Pre-flight 4: corrective migration must NOT already be recorded ──────────
const corrCheck = await db.query(
  `SELECT COUNT(*) AS n FROM typeorm_migrations WHERE timestamp = 1720700000001`
);
if (parseInt(corrCheck.rows[0].n, 10) > 0) {
  console.log('Corrective migration (1720700000001) already recorded in typeorm_migrations — nothing to do.');
  await db.end(); process.exit(0);
}
console.log('Corrective migration not yet applied — proceeding');

// ── Pre-flight 5: snapshot existing record count ─────────────────────────────
const beforeCount = (await db.query('SELECT COUNT(*) AS n FROM company_guard_payroll_records')).rows[0].n;
console.log(`Existing company_guard_payroll_records rows before migration: ${beforeCount}`);

// ── Apply migration inside a transaction ─────────────────────────────────────
console.log('\nApplying 1720700000001-RemovePayrollPaymentMethod…');
await db.query('BEGIN');

try {
  await db.query(`
    ALTER TABLE "company_guard_payroll_records"
      DROP COLUMN "payrollPaymentMethod"
  `);
  console.log('  DROP COLUMN payrollPaymentMethod: done');

  await db.query(`DROP TYPE IF EXISTS "guard_payroll_payment_method_enum"`);
  console.log('  DROP TYPE guard_payroll_payment_method_enum: done');

  // Record in TypeORM's migration history table (NOT "migrations").
  await db.query(
    `INSERT INTO typeorm_migrations (timestamp, name) VALUES ($1, $2)`,
    [1720700000001, 'RemovePayrollPaymentMethod1720700000001']
  );
  console.log('  Recorded in typeorm_migrations');

  await db.query('COMMIT');
  console.log('TRANSACTION COMMITTED');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('MIGRATION FAILED — transaction rolled back:', e.message);
  await db.end();
  process.exit(1);
}

// ── Post-migration verification ───────────────────────────────────────────────
let passed = 0; let failed = 0;
const pass = l => { passed++; console.log(`PASS  ${l}`); };
const fail = (l, d) => { failed++; console.error(`FAIL  ${l} — ${d}`); };

// V1: payrollPaymentMethod column absent
const colAfter = await db.query(`
  SELECT COUNT(*) AS n FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'company_guard_payroll_records'
    AND column_name = 'payrollPaymentMethod'
`);
if (parseInt(colAfter.rows[0].n, 10) === 0) pass('V1 payrollPaymentMethod column removed');
else fail('V1 column removal', 'column still present');

// V2: guard_payroll_payment_method_enum type absent
const enumAfter = await db.query(
  `SELECT COUNT(*) AS n FROM pg_type WHERE typname = 'guard_payroll_payment_method_enum'`
);
if (parseInt(enumAfter.rows[0].n, 10) === 0) pass('V2 guard_payroll_payment_method_enum type removed');
else fail('V2 enum removal', 'type still present');

// V3: company_guard_payroll_records table still exists
const tableCheck = await db.query(`
  SELECT COUNT(*) AS n FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'company_guard_payroll_records'
`);
if (parseInt(tableCheck.rows[0].n, 10) > 0) pass('V3 company_guard_payroll_records table intact');
else fail('V3 table intact', 'table missing after migration');

// V4: required P1G-B columns all present
const colsCheck = await db.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'company_guard_payroll_records'
`);
const presentCols = new Set(colsCheck.rows.map(r => r.column_name));
const required = ['id','companyGuardId','companyId','payrollReference','payFrequency',
  'payrollStatus','payrollStartDate','payrollEndDate','payrollNoteEnc','createdAt','updatedAt'];
const missing = required.filter(c => !presentCols.has(c));
if (missing.length === 0) pass(`V4 all ${required.length} required P1G-B columns intact`);
else fail('V4 column integrity', `missing: ${missing.join(', ')}`);

// V5: existing records preserved
const afterCount = (await db.query('SELECT COUNT(*) AS n FROM company_guard_payroll_records')).rows[0].n;
if (afterCount === beforeCount) pass(`V5 record count preserved: ${afterCount} rows`);
else fail('V5 data preservation', `before=${beforeCount} after=${afterCount}`);

// V6: original P1G-B migration still recorded
const origStill = await db.query(
  `SELECT COUNT(*) AS n FROM typeorm_migrations WHERE timestamp = 1720700000000`
);
if (parseInt(origStill.rows[0].n, 10) === 1) pass('V6 original migration 1720700000000 still recorded');
else fail('V6 original migration', `count=${origStill.rows[0].n}`);

// V7: corrective migration recorded exactly once
const corrStill = await db.query(
  `SELECT COUNT(*) AS n FROM typeorm_migrations WHERE timestamp = 1720700000001`
);
if (parseInt(corrStill.rows[0].n, 10) === 1) pass('V7 corrective migration 1720700000001 recorded exactly once');
else fail('V7 corrective migration record', `count=${corrStill.rows[0].n}`);

// V8: partial unique index intact
const idxCheck = await db.query(
  `SELECT COUNT(*) AS n FROM pg_indexes WHERE indexname = 'UQ_payroll_records_company_ref'`
);
if (parseInt(idxCheck.rows[0].n, 10) > 0) pass('V8 partial unique index UQ_payroll_records_company_ref intact');
else fail('V8 unique index', 'UQ_payroll_records_company_ref missing');

await db.end();
console.log(`\n══ MIGRATION VERIFICATION: ${passed} PASS / ${failed} FAIL ══`);
if (failed > 0) { console.error('MIGRATION: FAIL'); process.exit(1); }
else console.log('\nMIGRATION: PASS');
