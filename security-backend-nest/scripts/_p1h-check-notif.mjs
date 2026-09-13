import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const cols = await db.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='notifications' ORDER BY ordinal_position`);
console.log('NOTIFICATIONS_COLS:', cols.rows.map(r => `${r.column_name}(${r.data_type})`).join(', '));
const sample = await db.query('SELECT * FROM notifications ORDER BY id DESC LIMIT 3');
console.log('RECENT_NOTIFS:', JSON.stringify(sample.rows));
await db.end();
