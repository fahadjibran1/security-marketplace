import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

const comps = await db.query('SELECT id, name, "userId" FROM companies WHERE id=6');
console.log('COMPANY_6:', JSON.stringify(comps.rows));

const admins = await db.query(`SELECT id, email, role, status FROM users WHERE id = (SELECT "userId" FROM companies WHERE id=6)`);
console.log('COMPANY_6_ADMIN:', JSON.stringify(admins.rows));

const p1hUsers = await db.query(`SELECT id, email, role, status FROM users WHERE email LIKE 'p1h%' ORDER BY id`);
console.log('ALL_P1H_USERS:', JSON.stringify(p1hUsers.rows));

// Check if any COMPANY_ADMIN users exist for company 6's guards/staff
const guIds = await db.query(`SELECT id, email, role, status FROM users WHERE role IN ('company','company_admin','company_staff') ORDER BY id DESC LIMIT 10`);
console.log('COMPANY_ROLE_USERS (last 10):', JSON.stringify(guIds.rows));

await db.end();
