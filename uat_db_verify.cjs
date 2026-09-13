const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.DB_URL,
  ssl: { ca: process.env.DB_CA || undefined, rejectUnauthorized: true },
});

async function run() {
  await client.connect();
  
  const users = await client.query(
    "SELECT id, email, role, status FROM users WHERE role IN ('admin', 'platform_admin') ORDER BY id"
  );
  console.log('ADMIN_USERS:' + JSON.stringify(users.rows));
  
  const migCheck = await client.query(
    "SELECT name, timestamp FROM migrations WHERE name LIKE '%P1D%' OR name LIKE '%Driving%' ORDER BY timestamp"
  );
  console.log('P1D_MIGRATIONS:' + JSON.stringify(migCheck.rows));
  
  const tableCheck = await client.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='guard_driving_profiles' ORDER BY ordinal_position"
  );
  console.log('TABLE_COLS:' + JSON.stringify(tableCheck.rows));
  
  const encCheck = await client.query(
    "SELECT id, \"licenceStatus\", CASE WHEN \"licenceNumberEnc\" IS NOT NULL THEN 'SET' ELSE 'NULL' END as enc_status FROM guard_driving_profiles WHERE id IS NOT NULL LIMIT 5"
  );
  console.log('DRIVING_PROFILES:' + JSON.stringify(encCheck.rows));
  
  await client.end();
}

run().catch(e => { console.error('DB_ERROR:' + e.message); process.exit(1); });
