'use strict';
const { DB_URL } = require('./uat_db_config.cjs');
const { Client } = require('./node_modules/pg');
const bcrypt = require('./node_modules/bcrypt');

async function run() {
  const newPassword = 'BlkDrill!2026Admin';
  const hash = await bcrypt.hash(newPassword, 12);
  console.log('Hash generated (first 7 chars):', hash.substring(0, 7));

  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const result = await client.query(
    'UPDATE users SET "passwordHash" = $1 WHERE id = 1 RETURNING id, email, role::text',
    [hash],
  );
  console.log('Updated rows:', JSON.stringify(result.rows));
  await client.end();
}

run().catch(e => { console.error('ERR:', e.message); process.exit(1); });
