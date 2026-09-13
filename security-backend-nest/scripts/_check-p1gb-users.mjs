import pg from '../node_modules/pg/lib/index.js';
const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
await c.connect();
const u = await c.query("SELECT id, email, role, status, \"isEmailVerified\" FROM users WHERE email LIKE '%p1gb%' ORDER BY email");
u.rows.forEach(r => console.log('USER:', r.id, r.email, r.role, r.status, r.isEmailVerified));
const cg = await c.query("SELECT cg.id, cg.\"userId\", u.email FROM company_guards cg JOIN users u ON u.id = cg.\"userId\" WHERE cg.\"companyId\" = 6 LIMIT 5");
cg.rows.forEach(r => console.log('CG6:', r.id, 'userId:', r.userId, r.email));
await c.end();
