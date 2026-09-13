import pg from '../node_modules/pg/lib/index.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const bcrypt = require('../node_modules/bcrypt/bcrypt.js');
const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
await c.connect();
// Check guard A hash
const row = await c.query('SELECT "passwordHash" FROM users WHERE email = $1', ['p1gb-guard-a@staging.test']);
const hash = row.rows[0]?.passwordHash;
const ok = await bcrypt.compare('P1GB_Guard!2026', hash);
console.log('Guard A password P1GB_Guard!2026 matches:', ok);
// Also try the expected hash from setup script
const expectedHash = '$2b$10$p3tVetsULWG/A8RWN2DQDOOcJYzzZdxedWbSsUzMpEanWVmEBUOrS';
console.log('Hash is expected hash:', hash === expectedHash);
await c.end();
