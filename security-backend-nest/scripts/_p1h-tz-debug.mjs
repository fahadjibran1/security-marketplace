// Debug pg timezone parsing for shift 4
import pg from '../node_modules/pg/lib/index.js';
const { Client, types } = pg;

// Override type parser to see raw string
const origParser = types.getTypeParser(1184); // timestamptz OID
types.setTypeParser(1184, (v) => { console.log('RAW timestamptz string:', JSON.stringify(v)); return origParser(v); });

const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

await db.query("SET TimeZone='UTC'");

const r = await db.query('SELECT "start", "start"::text AS txt FROM shifts WHERE id=4');
console.log('Row:', JSON.stringify(r.rows[0]));

// Parse UTC text manually
const utcStr = r.rows[0].txt + '+00'; // append timezone
const d = new Date(utcStr);
console.log('Manual UTC parse:', d.toISOString());

// Intl result
const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(d);
const date = `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`;
console.log('London date from manual parse:', date, '(expected 2026-09-07)');

await db.end();
