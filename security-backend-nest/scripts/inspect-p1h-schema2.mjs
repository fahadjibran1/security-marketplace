// Schema inspection: company-user associations, client tables
import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

// All tables
const tables = await db.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`
);
console.log('ALL TABLES:', tables.rows.map(r => r.table_name).join(', '));

// companies table schema
const compCols = await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='companies' ORDER BY ordinal_position`
);
console.log('COMPANIES_COLS:', compCols.rows.map(r => r.column_name).join(', '));
const companies = await db.query(`SELECT * FROM companies ORDER BY id`);
console.log('COMPANIES:', JSON.stringify(companies.rows));

// client_portal_users table if exists
const cpuCols = await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='client_portal_users' ORDER BY ordinal_position`
);
if (cpuCols.rows.length > 0) {
  console.log('CLIENT_PORTAL_USERS_COLS:', cpuCols.rows.map(r => r.column_name).join(', '));
  const cpu = await db.query(`SELECT * FROM client_portal_users ORDER BY id`);
  console.log('CLIENT_PORTAL_USERS:', JSON.stringify(cpu.rows));
}

// company_guards if exists
const cgCols = await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='company_guards' ORDER BY ordinal_position`
);
if (cgCols.rows.length > 0) {
  console.log('COMPANY_GUARDS_COLS:', cgCols.rows.map(r => r.column_name).join(', '));
  const cg = await db.query(`SELECT * FROM company_guards ORDER BY id LIMIT 10`);
  console.log('COMPANY_GUARDS:', JSON.stringify(cg.rows));
}

// guards table
const guardCols = await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='guards' ORDER BY ordinal_position`
);
if (guardCols.rows.length > 0) {
  console.log('GUARDS_COLS:', guardCols.rows.map(r => r.column_name).join(', '));
  const guards = await db.query(`SELECT * FROM guards ORDER BY id LIMIT 10`);
  console.log('GUARDS:', JSON.stringify(guards.rows));
}

// jobs table if exists
const jobCols = await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='jobs' ORDER BY ordinal_position`
);
if (jobCols.rows.length > 0) {
  console.log('JOBS_COLS:', jobCols.rows.map(r => r.column_name).join(', '));
  const jobs = await db.query(`SELECT id, "siteId", "companyId", status FROM jobs ORDER BY id LIMIT 10`);
  console.log('JOBS:', JSON.stringify(jobs.rows));
}

// shifts
const shiftData = await db.query(
  `SELECT id, "siteId", "companyId", "guardId", start, "end", status FROM shifts ORDER BY id LIMIT 10`
);
console.log('SHIFTS:', JSON.stringify(shiftData.rows));

await db.end();
