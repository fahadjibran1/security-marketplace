// Staging-only password reset — safe, no password written to disk or printed.
// Usage:
//   $env:DATABASE_URL = "postgres://..."; $env:TARGET_EMAIL = "p1gb-guard-a@staging.test"; $env:NEW_PASSWORD = "<NEW_TEMP_PASSWORD>"
//   node security-backend-nest/scripts/reset-staging-password.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const bcrypt = require('../node_modules/bcrypt/bcrypt.js');
import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;

// ── Fail-closed guards ───────────────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.error('ABORT: DATABASE_URL not set'); process.exit(1); }

const dbName = new URL(dbUrl).pathname.replace(/^\//, '');
if (dbName !== 'security_marketplace_staging') {
  console.error(`ABORT: DATABASE_URL points to "${dbName}", not "security_marketplace_staging" — production guard active`);
  process.exit(1);
}

const targetEmail = process.env.TARGET_EMAIL;
if (!targetEmail) { console.error('ABORT: TARGET_EMAIL not set'); process.exit(1); }

const newPassword = process.env.NEW_PASSWORD;
if (!newPassword || newPassword.length < 8) {
  console.error('ABORT: NEW_PASSWORD not set or too short (minimum 8 characters)');
  process.exit(1);
}

// ── Staging-identity whitelist ───────────────────────────────────────────────
const ALLOWED_EMAILS = [
  'p1gb-guard-a@staging.test',
  'p1gb-guard-b@staging.test',
  'p1gb-guard-c@staging.test',
  'p1gb-guard-d@staging.test',
  'p1gb-co-a-admin@staging.test',
  'p1gb-co-b-admin@staging.test',
  'p1gb-client@staging.test',
];
if (!ALLOWED_EMAILS.includes(targetEmail)) {
  console.error(`ABORT: "${targetEmail}" is not in the P1G-B staging whitelist — refusing to reset`);
  process.exit(1);
}

// ── Connect and verify ───────────────────────────────────────────────────────
const db = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await db.connect();

const dbActual = (await db.query('SELECT current_database() AS d')).rows[0].d;
if (dbActual !== 'security_marketplace_staging') {
  console.error(`ABORT: current_database()="${dbActual}"`);
  await db.end(); process.exit(1);
}

// Verify user exists
const userRow = await db.query('SELECT id, email, role FROM users WHERE email = $1', [targetEmail]);
if (userRow.rows.length === 0) {
  console.error(`ABORT: No user found with email "${targetEmail}"`);
  await db.end(); process.exit(1);
}
const user = userRow.rows[0];
console.log(`Target user confirmed: id=${user.id} email=${user.email} role=${user.role}`);

// Hash and update — never print the plaintext or hash
const hash = await bcrypt.hash(newPassword, 12);
await db.query('UPDATE users SET "passwordHash" = $1 WHERE id = $2', [hash, user.id]);

await db.end();
console.log(`Password reset complete for ${targetEmail} (id=${user.id})`);
console.log('The new password is not stored anywhere in this script or output.');
