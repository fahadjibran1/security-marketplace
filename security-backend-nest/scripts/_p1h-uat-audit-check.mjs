import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

// Check recent audit events for timesheets 9, 10, 11
const r = await db.query(`
  SELECT id, action, "entityType", "entityId", "createdAt"
  FROM audit_logs
  WHERE "entityId" = ANY($1::int[]) AND "entityType" = 'timesheet'
  ORDER BY id DESC LIMIT 20
`, [[9, 10, 11]]);
console.log('Timesheet audit events:');
r.rows.forEach(row => console.log(JSON.stringify(row)));

// Check what columns audit_logs has
const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='audit_logs' ORDER BY ordinal_position`)).rows.map(r => r.column_name);
console.log('\naudit_logs columns:', cols.join(', '));

await db.end();
