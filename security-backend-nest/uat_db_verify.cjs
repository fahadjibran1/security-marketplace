const { Client } = require('./node_modules/pg');

const client = new Client({
  connectionString: process.env.DB_URL,
  ssl: { ca: process.env.DB_CA || undefined, rejectUnauthorized: true },
});

async function run() {
  await client.connect();
  console.log('DB CONNECTED');

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
    "SELECT id, \"licenceStatus\", CASE WHEN \"licenceNumberEnc\" IS NOT NULL THEN 'SET' ELSE 'NULL' END as enc_status, \"licenceCategories\" FROM guard_driving_profiles LIMIT 5"
  );
  console.log('DRIVING_PROFILES:' + JSON.stringify(encCheck.rows));

  const enumCheck = await client.query(
    "SELECT enum_range(NULL::driving_licence_status_enum)"
  );
  console.log('LICENCE_ENUM:' + JSON.stringify(enumCheck.rows));

  const enumTM = await client.query(
    "SELECT enum_range(NULL::primary_travel_method_enum)"
  );
  console.log('TRAVEL_ENUM:' + JSON.stringify(enumTM.rows));

  const docEnum = await client.query(
    "SELECT enum_range(NULL::guard_document_type_enum)"
  );
  console.log('DOC_ENUM:' + JSON.stringify(docEnum.rows));

  await client.end();
}

run().catch(e => { console.error('DB_ERROR:' + e.message); process.exit(1); });
