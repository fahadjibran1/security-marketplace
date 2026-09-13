import pkg from '../node_modules/pg/lib/index.js';
const { Client } = pkg;
const _stagingUrl = process.env.DATABASE_URL;
if (!_stagingUrl) {
  console.error('ABORT: DATABASE_URL environment variable is not set');
  process.exit(1);
}
const _dbName = new URL(_stagingUrl).pathname.replace(/^\//, '');
if (_dbName !== 'security_marketplace_staging') {
  console.error(`ABORT: DATABASE_URL points to "${_dbName}", not "security_marketplace_staging" — non-staging DB rejected`);
  process.exit(1);
}
const client = new Client({
  connectionString: _stagingUrl,
  ssl: { rejectUnauthorized: false }
});
await client.connect();

// Get users table columns
const cols = await client.query(`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'users' AND table_schema = 'public'
  ORDER BY ordinal_position
`);
console.log('USERS COLUMNS:', JSON.stringify(cols.rows));

// Get companies table columns
const cols2 = await client.query(`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'companies' AND table_schema = 'public'
  ORDER BY ordinal_position
`);
console.log('COMPANIES COLUMNS:', JSON.stringify(cols2.rows));

// Check employment records columns
const cols3 = await client.query(`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'company_guard_employment_records' AND table_schema = 'public'
  ORDER BY ordinal_position
`);
console.log('EMPLOYMENT COLUMNS:', JSON.stringify(cols3.rows));

await client.end();
