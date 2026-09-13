// P1G-B Staging Migration — company_guard_payroll_records
// Reads DB URL from DATABASE_URL environment variable.
// Applies migration in a transaction; idempotent if already applied.
import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;

const STAGING_DB = process.env.DATABASE_URL;
if (!STAGING_DB) {
  console.error('ABORT: DATABASE_URL environment variable is not set');
  process.exit(1);
}
const _migDbName = new URL(STAGING_DB).pathname.replace(/^\//, '');
if (_migDbName !== 'security_marketplace_staging') {
  console.error(`ABORT: DATABASE_URL points to "${_migDbName}", not "security_marketplace_staging" — non-staging DB rejected`);
  process.exit(1);
}

const client = new Client({ connectionString: STAGING_DB, ssl: { rejectUnauthorized: false } });
await client.connect();

// ── Target verification (non-secret evidence) ─────────────────────────────────
const dbHost = client.host;
const dbName = client.database;
console.log('TARGET VERIFICATION:');
console.log(`  host: ${dbHost}`);
console.log(`  name: ${dbName}`);

if (!dbHost.includes('render.com')) {
  console.error('ABORT: DB host is not on render.com — refusing to proceed');
  await client.end();
  process.exit(1);
}
if (dbName !== 'security_marketplace_staging') {
  console.error(`ABORT: DB name is "${dbName}", not security_marketplace_staging — refusing to proceed`);
  await client.end();
  process.exit(1);
}
console.log('TARGET CONFIRMED: staging');

try {
  // ── Pre-migration check ────────────────────────────────────────────────────
  const migCheck = await client.query(
    `SELECT timestamp, name FROM typeorm_migrations ORDER BY timestamp DESC LIMIT 25`
  );
  console.log('\nMIGRATION HISTORY (recent):');
  for (const m of migCheck.rows) console.log(`  [${m.timestamp}] ${m.name}`);

  const p1gaPresent = migCheck.rows.some(m => String(m.timestamp) === '1720600000000');
  const p1gbPresent = migCheck.rows.some(m => String(m.timestamp) === '1720700000000');

  if (!p1gaPresent) {
    console.error('\nABORT: P1G-A migration (1720600000000) not found — prerequisite not met');
    await client.end();
    process.exit(1);
  }
  console.log('\nP1G-A PREREQUISITE: PRESENT');

  const tableExists = (await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='company_guard_payroll_records'`
  )).rows.length > 0;

  const enumExists = (await client.query(
    `SELECT 1 FROM pg_type WHERE typname='guard_pay_frequency_enum'`
  )).rows.length > 0;

  if (p1gbPresent && tableExists) {
    console.log('\nP1G-B MIGRATION ALREADY APPLIED — table exists. Verifying schema and exiting.');
    // Fall through to schema verification below
  } else if (p1gbPresent && !tableExists) {
    console.error('\nINCONSISTENT STATE: migration recorded but table missing');
    await client.end();
    process.exit(1);
  } else if (!p1gbPresent && tableExists) {
    console.error('\nINCONSISTENT STATE: table exists but migration not recorded');
    await client.end();
    process.exit(1);
  } else {
    // ── Apply migration ────────────────────────────────────────────────────────
    console.log('\nAPPLYING P1G-B MIGRATION...');
    await client.query('BEGIN');

    await client.query(`
      CREATE TYPE "guard_pay_frequency_enum" AS ENUM (
        'WEEKLY',
        'FORTNIGHTLY',
        'FOUR_WEEKLY',
        'MONTHLY',
        'IRREGULAR'
      )
    `);

    await client.query(`
      CREATE TYPE "guard_payroll_payment_method_enum" AS ENUM (
        'BACS',
        'CHAPS',
        'CASH',
        'OTHER'
      )
    `);

    await client.query(`
      CREATE TYPE "guard_payroll_status_enum" AS ENUM (
        'ACTIVE',
        'ON_HOLD',
        'EXCLUDED'
      )
    `);

    await client.query(`
      CREATE TABLE "company_guard_payroll_records" (
        "id"                   SERIAL PRIMARY KEY,
        "companyGuardId"       integer NOT NULL,
        "companyId"            integer NOT NULL,
        "payrollReference"     varchar(50) NULL,
        "payFrequency"         "guard_pay_frequency_enum" NULL,
        "payrollPaymentMethod" "guard_payroll_payment_method_enum" NULL,
        "payrollStatus"        "guard_payroll_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "payrollStartDate"     date NULL,
        "payrollEndDate"       date NULL,
        "payrollNoteEnc"       text NULL,
        "createdAt"            timestamp NOT NULL DEFAULT now(),
        "updatedAt"            timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_payroll_records_companyGuardId"
          UNIQUE ("companyGuardId"),
        CONSTRAINT "FK_payroll_records_companyGuard"
          FOREIGN KEY ("companyGuardId")
          REFERENCES "company_guards" ("id")
          ON DELETE RESTRICT,
        CONSTRAINT "FK_payroll_records_company"
          FOREIGN KEY ("companyId")
          REFERENCES "companies" ("id")
          ON DELETE RESTRICT
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX "UQ_payroll_records_company_ref"
        ON "company_guard_payroll_records" ("companyId", LOWER("payrollReference"))
        WHERE "payrollReference" IS NOT NULL
    `);

    await client.query(
      `INSERT INTO typeorm_migrations (timestamp, name) VALUES ($1, $2)`,
      [1720700000000, 'AddCompanyGuardPayrollP1GB1720700000000']
    );

    await client.query('COMMIT');
    console.log('MIGRATION APPLIED: SUCCESS');
  }

  // ── Schema verification ────────────────────────────────────────────────────
  console.log('\nSCHEMA VERIFICATION:');

  const cols = await client.query(
    `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='company_guard_payroll_records'
     ORDER BY ordinal_position`
  );
  console.log('COLUMNS:');
  for (const c of cols.rows) {
    const len = c.character_maximum_length ? `(${c.character_maximum_length})` : '';
    console.log(`  ${c.column_name} — ${c.data_type}${len} — nullable:${c.is_nullable} — default:${c.column_default ?? 'NULL'}`);
  }

  const expectedCols = ['id','companyGuardId','companyId','payrollReference','payFrequency',
    'payrollPaymentMethod','payrollStatus','payrollStartDate','payrollEndDate','payrollNoteEnc',
    'createdAt','updatedAt'];
  const actualCols = cols.rows.map(c => c.column_name);
  const missingCols = expectedCols.filter(c => !actualCols.includes(c));
  if (missingCols.length === 0) console.log('ALL EXPECTED COLUMNS PRESENT');
  else console.error('MISSING COLUMNS:', missingCols);

  const constraints = await client.query(
    `SELECT constraint_name, constraint_type
     FROM information_schema.table_constraints
     WHERE table_schema='public' AND table_name='company_guard_payroll_records'
     ORDER BY constraint_type, constraint_name`
  );
  console.log('CONSTRAINTS:');
  for (const c of constraints.rows) console.log(`  ${c.constraint_name} — ${c.constraint_type}`);

  const indexes = await client.query(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname='public' AND tablename='company_guard_payroll_records'`
  );
  console.log('INDEXES:');
  for (const i of indexes.rows) console.log(`  ${i.indexname} — ${i.indexdef}`);

  const funcIdx = indexes.rows.find(i => i.indexname === 'UQ_payroll_records_company_ref');
  if (funcIdx) {
    const def = funcIdx.indexdef;
    const hasLower = def.toLowerCase().includes('lower(');
    const hasWhere = def.includes('IS NOT NULL');
    if (hasLower && hasWhere) {
      console.log('FUNCTIONAL PARTIAL UNIQUE INDEX: CONFIRMED');
      console.log('  indexdef:', def);
    } else {
      console.error('FUNCTIONAL PARTIAL UNIQUE INDEX: MISSING lower() or WHERE');
      console.error('  indexdef:', def);
    }
  } else {
    console.error('FUNCTIONAL PARTIAL UNIQUE INDEX: NOT FOUND');
    console.error('Available indexes:', indexes.rows.map(i => i.indexname).join(', '));
  }

  const enums = await client.query(
    `SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) as values
     FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typname IN ('guard_pay_frequency_enum','guard_payroll_payment_method_enum','guard_payroll_status_enum')
     GROUP BY t.typname ORDER BY t.typname`
  );
  console.log('ENUMS:');
  for (const e of enums.rows) console.log(`  ${e.typname}: [${e.values}]`);

  const migRecord = await client.query(
    `SELECT timestamp, name FROM typeorm_migrations WHERE timestamp = 1720700000000`
  );
  console.log('\nMIGRATION RECORD:', JSON.stringify(migRecord.rows));

} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('MIGRATION FAILED:', e.message);
  console.error(e.stack);
  await client.end();
  process.exit(1);
} finally {
  await client.end();
}
