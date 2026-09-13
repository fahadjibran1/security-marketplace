// P1H Staging Data Inspection — read-only
import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;

const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

const companies = await db.query(`SELECT id, name FROM companies ORDER BY id LIMIT 10`);
console.log('COMPANIES:', JSON.stringify(companies.rows));

// Check clients table schema
const clientCols = await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' ORDER BY ordinal_position`
);
console.log('CLIENTS_COLUMNS:', JSON.stringify(clientCols.rows.map(r => r.column_name)));

const clients = await db.query(`SELECT * FROM clients ORDER BY id LIMIT 10`);
console.log('CLIENTS:', JSON.stringify(clients.rows));

// Check sites table schema
const siteCols = await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='sites' ORDER BY ordinal_position`
);
console.log('SITES_COLUMNS:', JSON.stringify(siteCols.rows.map(r => r.column_name)));

const sites = await db.query(`SELECT * FROM sites ORDER BY id LIMIT 10`);
console.log('SITES:', JSON.stringify(sites.rows));

// Check users with client roles
const userCols = await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' ORDER BY ordinal_position`
);
console.log('USERS_COLUMNS:', JSON.stringify(userCols.rows.map(r => r.column_name)));

const users = await db.query(`SELECT id, email, role FROM users ORDER BY id`);
console.log('USERS:', JSON.stringify(users.rows));

// Check timesheets schema
const tsCols = await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='timesheets' ORDER BY ordinal_position`
);
console.log('TIMESHEETS_COLUMNS:', JSON.stringify(tsCols.rows.map(r => r.column_name)));

const ts = await db.query(
  `SELECT t.id, t."approvalStatus", t."billingStatus", t."approvedHours", t."approvedMinutes",
          t."shiftId", t."companyId"
   FROM timesheets t
   WHERE t."approvalStatus" = 'approved' AND t."billingStatus" = 'uninvoiced'
   ORDER BY t.id DESC LIMIT 10`
);
console.log('APPROVED_UNINVOICED_TIMESHEETS:', JSON.stringify(ts.rows));

// Check shifts schema
const shiftCols = await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='shifts' ORDER BY ordinal_position`
);
console.log('SHIFTS_COLUMNS:', JSON.stringify(shiftCols.rows.map(r => r.column_name)));

await db.end();
