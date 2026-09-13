import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;

import { readFileSync } from 'fs';
import { createRequire } from 'module';

const migFile = readFileSync(new URL('../scripts/check-staging-migrations.mjs', import.meta.url), 'utf8');
const urlMatch = migFile.match(/const STAGING_DB = '([^']+)'/);
if (!urlMatch) { console.error('Could not extract STAGING_DB'); process.exit(1); }
const STAGING_DB = urlMatch[1];

const client = new Client({ connectionString: STAGING_DB, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  const exists = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='guard_bank_details'"
  );
  console.log('TABLE EXISTS BEFORE MIGRATION:', exists.rows.length > 0 ? 'YES' : 'NO');

  if (exists.rows.length > 0) {
    console.log('MIGRATION ALREADY APPLIED — table exists. Aborting to avoid duplicate.');
    await client.end();
    process.exit(0);
  }

  await client.query('BEGIN');

  await client.query(`
    CREATE TABLE "guard_bank_details" (
      "id"                     SERIAL PRIMARY KEY,
      "guardId"                integer NOT NULL,
      "accountHolderNameEnc"   text NULL,
      "sortCodeEnc"            text NULL,
      "accountNumberEnc"       text NULL,
      "createdAt"              timestamp NOT NULL DEFAULT now(),
      "updatedAt"              timestamp NOT NULL DEFAULT now(),
      CONSTRAINT "UQ_guard_bank_details_guardId"
        UNIQUE ("guardId"),
      CONSTRAINT "FK_guard_bank_details_guard"
        FOREIGN KEY ("guardId")
        REFERENCES "guard_profiles" ("id")
        ON DELETE CASCADE
    )
  `);

  await client.query(
    "INSERT INTO typeorm_migrations (timestamp, name) VALUES ($1, $2)",
    [1720600000000, 'AddGuardBankDetailsP1GA1720600000000']
  );

  await client.query('COMMIT');
  console.log('MIGRATION APPLIED: SUCCESS');

  const after = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='guard_bank_details'"
  );
  console.log('TABLE EXISTS AFTER MIGRATION:', after.rows.length > 0 ? 'YES' : 'NO');

  const cols = await client.query(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='guard_bank_details' ORDER BY ordinal_position"
  );
  console.log('COLUMNS:');
  for (const c of cols.rows) {
    console.log(`  ${c.column_name} — ${c.data_type} — nullable:${c.is_nullable}`);
  }

  const constraints = await client.query(
    "SELECT constraint_name, constraint_type FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='guard_bank_details'"
  );
  console.log('CONSTRAINTS:');
  for (const c of constraints.rows) {
    console.log(`  ${c.constraint_name} — ${c.constraint_type}`);
  }

  const migCheck = await client.query(
    "SELECT timestamp, name FROM typeorm_migrations WHERE timestamp = 1720600000000"
  );
  console.log('MIGRATION RECORD:', JSON.stringify(migCheck.rows));

} catch (e) {
  await client.query('ROLLBACK');
  console.error('MIGRATION FAILED:', e.message);
  process.exit(1);
} finally {
  await client.end();
}
