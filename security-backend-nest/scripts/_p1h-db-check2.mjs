import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const r = await db.query(`SELECT id, status, "companyId", "clientId", "weekCommencing", "currentVersion" FROM client_weekly_approval_requests ORDER BY id`);
console.log('REQUESTS:', JSON.stringify(r.rows));
const l = await db.query(`SELECT id, "weeklyApprovalRequestId", "timesheetId", superseded FROM client_weekly_approval_lines ORDER BY id`);
console.log('LINES:', JSON.stringify(l.rows));
await db.end();
