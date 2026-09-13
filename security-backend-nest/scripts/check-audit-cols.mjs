import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;
import { readFileSync } from 'fs';
const migFile = readFileSync(new URL('../scripts/check-staging-migrations.mjs', import.meta.url), 'utf8');
const url = migFile.match(/const STAGING_DB = '([^']+)'/)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='audit_logs' AND table_schema='public' ORDER BY ordinal_position");
console.log('audit_logs columns:', r.rows.map(x => x.column_name).join(', '));
// Sample recent rows
const rows = await c.query("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 3");
if (rows.rows.length > 0) console.log('sample row keys:', Object.keys(rows.rows[0]).join(', '));
await c.end();
