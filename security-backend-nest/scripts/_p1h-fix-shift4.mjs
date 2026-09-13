// Fix shift 4 start time: 2026-09-06T22:00:00Z → 2026-09-06T23:00:00Z
// This corrects the BST midnight boundary test (A4) — shift must be at UTC 23:00 = BST Mon 00:00
import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

const dbName = db.database;
if (dbName !== 'security_marketplace_staging') {
  console.error(`ABORT: wrong DB "${dbName}"`); await db.end(); process.exit(1);
}

const before = (await db.query('SELECT id, "start" FROM shifts WHERE id=4')).rows[0];
console.log('BEFORE shift 4:', JSON.stringify(before));

const res = await db.query(`UPDATE shifts SET "start"=$1 WHERE id=4`, ['2026-09-06T23:00:00+00:00']);
console.log('Rows updated:', res.rowCount);

const after = (await db.query('SELECT id, "start" FROM shifts WHERE id=4')).rows[0];
console.log('AFTER shift 4:', JSON.stringify(after));

// Verify: in BST (UTC+1), 2026-09-06T23:00:00Z = 2026-09-07T00:00:00 BST = Monday Sep 7
const d = new Date(after.start);
const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
const y = parts.find(p=>p.type==='year').value;
const mo = parts.find(p=>p.type==='month').value;
const dd = parts.find(p=>p.type==='day').value;
console.log(`London date: ${y}-${mo}-${dd} (expected 2026-09-07) — ${y===2026&&mo==='09'&&dd==='07' ? 'PASS' : 'FAIL'}`);

await db.end();
