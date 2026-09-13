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

const users = await client.query('SELECT u.id, u.email, u.role FROM users u ORDER BY u.id');
console.log('USERS:', JSON.stringify(users.rows));

const guards = await client.query('SELECT gp.id as "guardProfileId", gp."userId", u.email FROM guard_profiles gp JOIN users u ON u.id = gp."userId" ORDER BY gp.id');
console.log('GUARD_PROFILES:', JSON.stringify(guards.rows));

const companies = await client.query('SELECT cp.id as "companyProfileId", cp."userId", cp.name, u.email FROM companies cp JOIN users u ON u.id = cp."userId" ORDER BY cp.id');
console.log('COMPANY_PROFILES:', JSON.stringify(companies.rows));

const cgs = await client.query('SELECT cg.id, cg."companyId", cg."guardId", cg.status FROM company_guards cg ORDER BY cg.id');
console.log('COMPANY_GUARDS:', JSON.stringify(cgs.rows));

const emps = await client.query('SELECT * FROM company_guard_employment_records');
console.log('EMPLOYMENT_RECORDS:', JSON.stringify(emps.rows));

await client.end();
