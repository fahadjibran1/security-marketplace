import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const bcrypt = require('../node_modules/bcrypt/bcrypt.js');
import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.error('ABORT: DATABASE_URL not set'); process.exit(1); }
const dbName = new URL(dbUrl).pathname.replace(/^\//, '');
if (dbName !== 'security_marketplace_staging') { console.error('ABORT: wrong DB'); process.exit(1); }

const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();
if (!client.host.includes('render.com')) { console.error('ABORT: not render.com'); await client.end(); process.exit(1); }

const newPw = 'P1H_CAdmin_R!2026';
const hash = await bcrypt.hash(newPw, 10);
const result = await client.query(
  `UPDATE client_portal_users SET "passwordHash" = $1 WHERE email = $2 RETURNING id, email, role`,
  [hash, 'p1h-client-admin@staging.test']
);
if (result.rows.length === 0) { console.error('ABORT: user not found'); await client.end(); process.exit(1); }
console.log(`Reset: ${JSON.stringify(result.rows[0])}`);
console.log('Password for p1h-client-admin@staging.test reset. New password NOT printed here.');
await client.end();
