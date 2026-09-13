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

try {
  // Check what migration tables exist
  const migTables = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE '%migrat%'"
  );
  console.log('MIGRATION-RELATED TABLES:', migTables.rows.map(r => r.table_name).join(', ') || 'none');

  if (migTables.rows.length > 0) {
    const tname = migTables.rows[0].table_name;
    const migs = await client.query(`SELECT name, timestamp FROM "${tname}" ORDER BY timestamp DESC LIMIT 30`);
    console.log('MIGRATIONS APPLIED:');
    for (const r of migs.rows) console.log(`  [${r.timestamp}] ${r.name}`);
  }

  const tables = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
  );
  console.log('\nTABLES IN public schema:');
  for (const r of tables.rows) console.log(`  ${r.table_name}`);

  const empTable = tables.rows.find(r => r.table_name === 'company_guard_employment_records');
  console.log('\nP1F TABLE EXISTS:', empTable ? 'YES' : 'NO');
} finally {
  await client.end();
}
