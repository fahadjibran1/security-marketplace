// One-shot: rotate the three permanent staging account passwords
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const bcrypt = require('../node_modules/bcrypt/bcrypt.js');
import pkg from '../node_modules/pg/lib/index.js';
const { Client } = pkg;

function genPw(tag) { return randomBytes(12).toString('base64url') + tag; }

const newGuardPw   = genPw('!gR');
const newCompanyPw = genPw('!coR');
const newAdminPw   = genPw('!aR');

const _rotateUrl = process.env.DATABASE_URL;
if (!_rotateUrl) {
  console.error('ABORT: DATABASE_URL environment variable is not set');
  process.exit(1);
}
const _rotateDbName = new URL(_rotateUrl).pathname.replace(/^\//, '');
if (_rotateDbName !== 'security_marketplace_staging') {
  console.error(`ABORT: DATABASE_URL points to "${_rotateDbName}", not "security_marketplace_staging" — non-staging DB rejected`);
  process.exit(1);
}
const pg = new Client({
  connectionString: _rotateUrl,
  ssl: { rejectUnauthorized: false }
});
await pg.connect();

const [hG, hC, hA] = await Promise.all([
  bcrypt.hash(newGuardPw, 10),
  bcrypt.hash(newCompanyPw, 10),
  bcrypt.hash(newAdminPw, 10),
]);

await pg.query('UPDATE users SET "passwordHash" = $1 WHERE email = $2', [hG, 'p1d-guard@staging.test']);
await pg.query('UPDATE users SET "passwordHash" = $1 WHERE email = $2', [hC, 'p1d-company@staging.test']);
await pg.query('UPDATE users SET "passwordHash" = $1 WHERE email = $2', [hA, 'blk004-drill@staging.local']);
await pg.end();

const ts = new Date().toISOString();
const creds = [
  '# P1F post-rotation staging credentials',
  `# Rotated: ${ts}`,
  '# DO NOT COMMIT',
  '',
  `p1d-guard@staging.test = ${newGuardPw}`,
  `p1d-company@staging.test = ${newCompanyPw}`,
  `blk004-drill@staging.local = ${newAdminPw}`,
].join('\n');

writeFileSync('C:/Users/Admin/S4-Claude/.p1f-staging-rotated-creds', creds, 'utf8');
console.log('Passwords rotated for: p1d-guard, p1d-company, blk004-drill');
console.log('Written to: C:/Users/Admin/S4-Claude/.p1f-staging-rotated-creds');
console.log(`Timestamp: ${ts}`);
