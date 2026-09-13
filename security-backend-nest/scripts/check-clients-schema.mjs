import pkg from '../node_modules/pg/lib/index.js';
const { Client } = pkg;
const _clientsUrl = process.env.DATABASE_URL;
if (!_clientsUrl) {
  console.error('ABORT: DATABASE_URL environment variable is not set');
  process.exit(1);
}
const _clientsDbName = new URL(_clientsUrl).pathname.replace(/^\//, '');
if (_clientsDbName !== 'security_marketplace_staging') {
  console.error(`ABORT: DATABASE_URL points to "${_clientsDbName}", not "security_marketplace_staging" — non-staging DB rejected`);
  process.exit(1);
}
const client = new Client({
  connectionString: _clientsUrl,
  ssl: { rejectUnauthorized: false }
});
await client.connect();

for (const tbl of ['clients', 'client_portal_users']) {
  const r = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = $1 AND table_schema = 'public'
    ORDER BY ordinal_position`, [tbl]);
  console.log(`\n${tbl.toUpperCase()} COLUMNS:`);
  for (const row of r.rows) console.log(`  ${row.column_name}: ${row.data_type} ${row.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'} ${row.column_default ? `DEFAULT ${row.column_default}` : ''}`);
}

// Check existing clients and client_portal_users
const clients = await client.query('SELECT * FROM clients ORDER BY id');
console.log('\nEXISTING CLIENTS:', JSON.stringify(clients.rows));
const cpus = await client.query('SELECT id, email, role, "clientId", "isActive" FROM client_portal_users');
console.log('EXISTING CLIENT_PORTAL_USERS:', JSON.stringify(cpus.rows));

// Also confirm P1F migration is in typeorm_migrations
const mig = await client.query("SELECT name FROM typeorm_migrations WHERE name LIKE '%P1F%'");
console.log('\nP1F MIGRATION IN DB:', JSON.stringify(mig.rows));

await client.end();
