// Verify shift 4 with fresh connection and check for triggers
import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;

const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

// Check session timezone
const tz = (await db.query('SHOW TimeZone')).rows[0];
console.log('Session timezone:', JSON.stringify(tz));

// Current shift 4 value
const cur = (await db.query('SELECT id, "start"::text AS start_text, "start" FROM shifts WHERE id=4')).rows[0];
console.log('Current shift 4:', JSON.stringify(cur));

// Check triggers on shifts table
const trigs = await db.query(`
  SELECT trigger_name, event_manipulation, action_statement
  FROM information_schema.triggers
  WHERE event_object_table='shifts'
`);
console.log('Triggers on shifts:', JSON.stringify(trigs.rows));

// Try SET timezone UTC then update
await db.query("SET TimeZone='UTC'");
const res2 = await db.query(`UPDATE shifts SET "start"='2026-09-06 23:00:00+00' WHERE id=4 RETURNING "start"`);
console.log('Updated RETURNING:', JSON.stringify(res2.rows));
console.log('rowCount:', res2.rowCount);

// Re-read fresh
const fresh = (await db.query('SELECT id, "start" FROM shifts WHERE id=4')).rows[0];
console.log('Fresh read:', JSON.stringify(fresh));

await db.end();
