import pg from '../node_modules/pg/lib/index.js';
import bcrypt from '../node_modules/bcrypt/bcrypt.js';
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

// Find company admin users by email pattern
const r = await db.query(`SELECT id, email, role, status FROM users WHERE email ILIKE '%p1gb%' OR email ILIKE '%co-a-admin%' OR email ILIKE '%co-b-admin%' ORDER BY id`);
console.log('Found users:');
r.rows.forEach(row => console.log(JSON.stringify(row)));

// Reset passwords to known test values
const usersToReset = [
  { email: 'p1gb-co-a-admin@staging.test', pwd: 'P1GB_CoAdmin!2026' },
  { email: 'p1gb-co-b-admin@staging.test', pwd: 'P1GB_CoBAdmin!2026' },
  { email: 'p1h-co-staff@staging.test', pwd: 'P1H_CoStaff!2026' },
];
for (const u of usersToReset) {
  const hash = await bcrypt.hash(u.pwd, 10);
  const upd = await db.query(`UPDATE users SET "passwordHash"=$1 WHERE email=$2 RETURNING id`, [hash, u.email]);
  if (upd.rows.length > 0) console.log(`RESET: ${u.email} id=${upd.rows[0].id}`);
  else console.log(`NOT FOUND: ${u.email}`);
}
await db.end();
