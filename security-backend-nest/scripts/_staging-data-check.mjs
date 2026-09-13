import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

// Check site-client association
const sites = await client.query(`SELECT s.id, s.name, s."companyId", s."clientId", c.name as client_name FROM sites s LEFT JOIN clients c ON c.id = s."clientId" ORDER BY s.id`);
console.log('Sites with client:');
sites.rows.forEach(r => console.log(JSON.stringify(r)));

// Check clients
const clients = await client.query(`SELECT id, name, "companyId", status FROM clients ORDER BY id`);
console.log('\nClients:');
clients.rows.forEach(r => console.log(JSON.stringify(r)));

// Weekly approvals
const wa = await client.query(`SELECT w.id, w.status, w."weekCommencing", w."companyId", w."clientId", w."siteId", w."currentVersion" FROM client_weekly_approval_requests w ORDER BY w.id`);
console.log('\nWeekly approvals:');
wa.rows.forEach(r => console.log(JSON.stringify(r)));

await client.end().catch(() => {});
