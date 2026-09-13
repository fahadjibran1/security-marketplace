// uat_p1f_completion.mjs
// P1F Staging Certification Completion Gate
// Covers: multi-company token isolation, client token isolation,
//         leakage review, credential housekeeping

import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const bcrypt = require('./security-backend-nest/node_modules/bcrypt/bcrypt.js');
import pgPkg from './security-backend-nest/node_modules/pg/lib/index.js';
const { Client: PgClient } = pgPkg;

const BASE   = 'https://security-marketplace-api-staging.onrender.com';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('ABORT: DATABASE_URL environment variable is not set');
  process.exit(1);
}
const _p1fCompDbName = new URL(DB_URL).pathname.replace(/^\//, '');
if (_p1fCompDbName !== 'security_marketplace_staging') {
  console.error(`ABORT: DATABASE_URL points to "${_p1fCompDbName}", not "security_marketplace_staging" — non-staging DB rejected`);
  process.exit(1);
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
function raw(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { body = null; }
        resolve({ status: res.statusCode, data: body });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function api(method, path, token, jsonBody) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const bodyStr = jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined;
  return raw(`${BASE}${path}`, { method, headers }, bodyStr);
}
const get    = (p, t)    => api('GET',   p, t);
const post   = (p, t, b) => api('POST',  p, t, b);
const patch  = (p, t, b) => api('PATCH', p, t, b);

// ── Assertions ──────────────────────────────────────────────────────────────
let passed = 0; let failed = 0;
function pass(label) { passed++; console.log(`  PASS  ${label}`); }
function fail(label, reason) { failed++; console.error(`  FAIL  ${label}: ${reason}`); }
function section(title) { console.log(`\n=== ${title} ===`); }
function expect(label, cond, reason = '') {
  if (cond) pass(label);
  else fail(label, reason || 'assertion failed');
}
function expectStatus(label, res, code) {
  if (res.status === code) pass(`${label} → HTTP ${code}`);
  else fail(`${label} → HTTP ${code}`, `got HTTP ${res.status}: ${JSON.stringify(res.data)}`);
}
function expectField(label, obj, field, exists = true) {
  const has = obj != null && field in obj && obj[field] !== undefined;
  if (exists) expect(`${label} has '${field}'`, has, 'field missing');
  else expect(`${label} excludes '${field}'`, !has, 'field unexpectedly present');
}

// ── DB helper ───────────────────────────────────────────────────────────────
let pg;
async function db(sql, params = []) {
  if (!pg) {
    pg = new PgClient({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await pg.connect();
  }
  return pg.query(sql, params);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS (staging identifiers)
// ─────────────────────────────────────────────────────────────────────────────
const GUARD_A_ID   = 3;   // p1d-guard@staging.test (guardProfileId)
const GUARD_B_ID   = 2;   // sec019-guard2@staging.local (guardProfileId, Guard B-exclusive)
const COMPANY_A_ID = 2;   // P1D Test Company Ltd (companyProfileId)
const CG_A_ID      = 1;   // existing CompanyGuard: P1D ↔ Guard A (ACTIVE)

// ─────────────────────────────────────────────────────────────────────────────
// SETUP — generate temporary credentials (never printed)
// ─────────────────────────────────────────────────────────────────────────────
section('SETUP — temporary credential generation');

function genPw(tag) {
  return randomBytes(12).toString('base64url') + tag;
}
const coBpw    = genPw('!cB');   // Company B password
const caAdmPw  = genPw('!cA');   // CLIENT_ADMIN password
const caVwPw   = genPw('!cV');   // CLIENT_VIEWER password

// New rotation passwords for permanent staging accounts
const newGuardPw   = genPw('!gR');
const newCompanyPw = genPw('!coR');
const newAdminPw   = genPw('!aR');
const newStaffPw   = genPw('!sR');

console.log('  Temporary credentials generated (not printed)');

// ─────────────────────────────────────────────────────────────────────────────
// AUTH — login existing permanent accounts
// ─────────────────────────────────────────────────────────────────────────────
section('AUTH — permanent accounts');
const [loginG, loginA, loginAdm] = await Promise.all([
  post('/auth/login', null, { email: 'p1d-guard@staging.test',     password: 'P1dGuard!2026' }),
  post('/auth/login', null, { email: 'p1d-company@staging.test',   password: 'P1dCompany!2026' }),
  post('/auth/login', null, { email: 'blk004-drill@staging.local', password: 'BlkDrill!2026Admin' }),
]);
expectStatus('Guard login',   loginG,   201);
expectStatus('Company A login', loginA, 201);
expectStatus('Admin login',   loginAdm, 201);
const tG   = loginG.data?.accessToken;
const tA   = loginA.data?.accessToken;
const tAdm = loginAdm.data?.accessToken;

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-COMPANY SETUP
// ─────────────────────────────────────────────────────────────────────────────
section('MULTI-COMPANY SETUP — register Company B');

const regB = await post('/auth/register', null, {
  email:       'p1f-coB@staging.test',
  password:    coBpw,
  role:        'company_admin',
  companyName: 'P1F Company B Ltd',
  companyNumber: 'TESTB001',
  address:     '99 Test Lane, London',
  contactDetails: 'test-b@example.com',
});
if (regB.status === 201) {
  console.log(`  Company B registered: HTTP 201`);
} else if (regB.status === 409) {
  console.log(`  Company B already exists (409) — continuing`);
} else {
  fail('Company B registration', `HTTP ${regB.status}: ${JSON.stringify(regB.data)}`);
}

// Login as Company B
const loginB = await post('/auth/login', null, { email: 'p1f-coB@staging.test', password: coBpw });
expectStatus('Company B login', loginB, 201);
const tB = loginB.data?.accessToken;

// Find Company B's companyId from DB
const coBRow = await db("SELECT id FROM companies WHERE name = 'P1F Company B Ltd'");
const COMPANY_B_ID = coBRow.rows[0]?.id;
if (!COMPANY_B_ID) { fail('Company B profile', 'not found in DB'); process.exit(1); }
console.log(`  Company B profile ID: ${COMPANY_B_ID}`);

// Ensure CompanyGuard A ↔ Guard A (id=1) is ACTIVE
await db('UPDATE company_guards SET status = \'ACTIVE\' WHERE id = $1', [CG_A_ID]);

// Create Company B ↔ Guard A CompanyGuard (shared guard test)
let cgBRow = await db('SELECT id FROM company_guards WHERE "companyId" = $1 AND "guardId" = $2', [COMPANY_B_ID, GUARD_A_ID]);
let CG_B_ID;
if (cgBRow.rows.length === 0) {
  const ins = await db('INSERT INTO company_guards ("companyId", "guardId", status) VALUES ($1, $2, \'ACTIVE\') RETURNING id', [COMPANY_B_ID, GUARD_A_ID]);
  CG_B_ID = ins.rows[0].id;
  console.log(`  Company B ↔ Guard A CompanyGuard created id=${CG_B_ID}`);
} else {
  CG_B_ID = cgBRow.rows[0].id;
  await db('UPDATE company_guards SET status = \'ACTIVE\' WHERE id = $1', [CG_B_ID]);
  console.log(`  Company B ↔ Guard A CompanyGuard exists id=${CG_B_ID}, set ACTIVE`);
}

// Create Company B ↔ Guard B CompanyGuard (B-exclusive guard, no relationship for Company A)
let cgBExRow = await db('SELECT id FROM company_guards WHERE "companyId" = $1 AND "guardId" = $2', [COMPANY_B_ID, GUARD_B_ID]);
let CG_B_EXCL_ID;
if (cgBExRow.rows.length === 0) {
  const ins = await db('INSERT INTO company_guards ("companyId", "guardId", status) VALUES ($1, $2, \'ACTIVE\') RETURNING id', [COMPANY_B_ID, GUARD_B_ID]);
  CG_B_EXCL_ID = ins.rows[0].id;
  console.log(`  Company B ↔ Guard B (exclusive) CompanyGuard created id=${CG_B_EXCL_ID}`);
} else {
  CG_B_EXCL_ID = cgBExRow.rows[0].id;
  console.log(`  Company B ↔ Guard B (exclusive) CompanyGuard exists id=${CG_B_EXCL_ID}`);
}

// Clean any pre-existing P1F employment records for our test CompanyGuards
await db('DELETE FROM company_guard_employment_records WHERE "companyGuardId" IN ($1, $2)', [CG_A_ID, CG_B_ID]);
console.log('  Pre-existing employment records cleaned for CG_A and CG_B');

// ─────────────────────────────────────────────────────────────────────────────
// §2  MULTI-COMPANY TOKEN-LEVEL ISOLATION
// ─────────────────────────────────────────────────────────────────────────────
section('§2  MULTI-COMPANY — Company A creates independent employment record');
const createA = await patch(`/guard-personnel/company/guard/${GUARD_A_ID}/employment`, tA, {
  engagementType:    'EMPLOYEE',
  jobRole:           'SECURITY_OFFICER',
  workingArrangement:'FULL_TIME',
  startDate:         '2025-01-15',
  payBasis:          'HOURLY',
  noticePeriodDays:  28,
  internalNote:      'CompanyA-confidential',
});
expectStatus('Company A PATCH create → 200', createA, 200);
expect('Company A record: SECURITY_OFFICER',      createA.data?.jobRole === 'SECURITY_OFFICER',    `got: ${createA.data?.jobRole}`);
expect('Company A record: companyGuardId is CG_A', createA.data?.companyGuardId === CG_A_ID,       `got: ${createA.data?.companyGuardId} expected ${CG_A_ID}`);

section('§2  MULTI-COMPANY — Company B creates independent employment record');
const createB = await patch(`/guard-personnel/company/guard/${GUARD_A_ID}/employment`, tB, {
  engagementType:    'AGENCY_WORKER',
  jobRole:           'MOBILE_PATROL_OFFICER',
  workingArrangement:'ZERO_HOURS',
  startDate:         '2025-06-01',
  payBasis:          'DAILY',
  noticePeriodDays:  7,
  internalNote:      'CompanyB-confidential',
});
expectStatus('Company B PATCH create → 200', createB, 200);
expect('Company B record: MOBILE_PATROL_OFFICER',  createB.data?.jobRole === 'MOBILE_PATROL_OFFICER', `got: ${createB.data?.jobRole}`);
expect('Company B record: companyGuardId is CG_B', createB.data?.companyGuardId === CG_B_ID,          `got: ${createB.data?.companyGuardId} expected ${CG_B_ID}`);

section('§2  MULTI-COMPANY — Company A GET owns its record');
const getA = await get(`/guard-personnel/company/guard/${GUARD_A_ID}/employment`, tA);
expectStatus('Company A GET → 200', getA, 200);
expect('Company A sees own companyGuardId',      getA.data?.companyGuardId === CG_A_ID,          `got: ${getA.data?.companyGuardId}`);
expect('Company A sees own jobRole',             getA.data?.jobRole === 'SECURITY_OFFICER',       `got: ${getA.data?.jobRole}`);
expect('Company A sees own internalNote',        getA.data?.internalNote === 'CompanyA-confidential', `got: ${getA.data?.internalNote}`);
expect('Company A does NOT see CompanyB data',   getA.data?.jobRole !== 'MOBILE_PATROL_OFFICER',  `got Company B jobRole!`);
expect('Company A internalNote is NOT CompanyB', getA.data?.internalNote !== 'CompanyB-confidential', `got Company B note!`);

section('§2  MULTI-COMPANY — Company B GET owns its record');
const getB = await get(`/guard-personnel/company/guard/${GUARD_A_ID}/employment`, tB);
expectStatus('Company B GET → 200', getB, 200);
expect('Company B sees own companyGuardId',      getB.data?.companyGuardId === CG_B_ID,            `got: ${getB.data?.companyGuardId}`);
expect('Company B sees own jobRole',             getB.data?.jobRole === 'MOBILE_PATROL_OFFICER',    `got: ${getB.data?.jobRole}`);
expect('Company B sees own internalNote',        getB.data?.internalNote === 'CompanyB-confidential', `got: ${getB.data?.internalNote}`);
expect('Company B does NOT see CompanyA data',   getB.data?.jobRole !== 'SECURITY_OFFICER',         `got Company A jobRole!`);
expect('Company B internalNote is NOT CompanyA', getB.data?.internalNote !== 'CompanyA-confidential', `got Company A note!`);

section('§2  MULTI-COMPANY — Company A → Guard B exclusive (no relationship): DENIED');
// Guard B has no CompanyGuard with Company A — should 403
const aOnBGuard = await get(`/guard-personnel/company/guard/${GUARD_B_ID}/employment`, tA);
expectStatus('Company A GET Guard B (no CG) → 403', aOnBGuard, 403);
// Verify response leaks nothing
expect('Denied response: no jobRole leaked',      !aOnBGuard.data?.jobRole,      `got: ${aOnBGuard.data?.jobRole}`);
expect('Denied response: no internalNote leaked', !aOnBGuard.data?.internalNote, `got: ${aOnBGuard.data?.internalNote}`);
expect('Denied response: no companyGuardId',      !aOnBGuard.data?.companyGuardId, `got: ${aOnBGuard.data?.companyGuardId}`);

section('§2  MULTI-COMPANY — Company B → Company A record isolation: reads own only');
// Both companies share Guard A but each sees only their own record
// Explicit proof: Company B read (already done above) — companyGuardId=CG_B, not CG_A
expect('B cannot access A record (proven by companyGuardId)', getB.data?.companyGuardId !== CG_A_ID, `companyGuardId should not be ${CG_A_ID}`);

section('§2  MULTI-COMPANY — Company A PATCH does NOT affect Company B record');
const patchA = await patch(`/guard-personnel/company/guard/${GUARD_A_ID}/employment`, tA, {
  noticePeriodDays: 30,
});
expectStatus('Company A PATCH noticePeriodDays → 200', patchA, 200);
expect('A record updated: noticePeriodDays=30', patchA.data?.noticePeriodDays === 30, `got: ${patchA.data?.noticePeriodDays}`);
// Check Company B record unchanged
const getBafter = await get(`/guard-personnel/company/guard/${GUARD_A_ID}/employment`, tB);
expect('Company B noticePeriodDays still 7 (A PATCH did not affect B)', getBafter.data?.noticePeriodDays === 7, `got: ${getBafter.data?.noticePeriodDays}`);

section('§2  MULTI-COMPANY — Company B PATCH does NOT affect Company A record');
const patchB = await patch(`/guard-personnel/company/guard/${GUARD_A_ID}/employment`, tB, {
  payBasis: 'SALARY',
});
expectStatus('Company B PATCH payBasis → 200', patchB, 200);
expect('B record updated: payBasis=SALARY', patchB.data?.payBasis === 'SALARY', `got: ${patchB.data?.payBasis}`);
// Check Company A record unchanged
const getAafter = await get(`/guard-personnel/company/guard/${GUARD_A_ID}/employment`, tA);
expect('Company A payBasis still HOURLY (B PATCH did not affect A)', getAafter.data?.payBasis === 'HOURLY', `got: ${getAafter.data?.payBasis}`);

section('§2  MULTI-COMPANY — Guard GET /me/employments sees both independently');
const guardList = await get('/guard-personnel/me/employments', tG);
expectStatus('Guard GET /me/employments → 200', guardList, 200);
expect('Guard list is array', Array.isArray(guardList.data), `got: ${typeof guardList.data}`);
const empA = guardList.data?.find(e => e.companyGuardId === CG_A_ID);
const empB = guardList.data?.find(e => e.companyGuardId === CG_B_ID);
expect('Guard sees Company A record (companyGuardId=CG_A)', !!empA, `CG_A=${CG_A_ID} not in list: ${JSON.stringify(guardList.data?.map(e=>e.companyGuardId))}`);
expect('Guard sees Company B record (companyGuardId=CG_B)', !!empB, `CG_B=${CG_B_ID} not in list: ${JSON.stringify(guardList.data?.map(e=>e.companyGuardId))}`);
// Guard records have different fields from each company
if (empA && empB) {
  expect('Guard A-record: SECURITY_OFFICER',      empA.jobRole === 'SECURITY_OFFICER',     `got: ${empA.jobRole}`);
  expect('Guard B-record: MOBILE_PATROL_OFFICER', empB.jobRole === 'MOBILE_PATROL_OFFICER', `got: ${empB.jobRole}`);
  expect('Guard A-record: no internalNote',        !('internalNote' in empA),                'internalNote leaked to guard');
  expect('Guard B-record: no internalNote',        !('internalNote' in empB),                'internalNote leaked to guard');
}

// ─────────────────────────────────────────────────────────────────────────────
// §3  CLIENT TOKEN ISOLATION
// ─────────────────────────────────────────────────────────────────────────────
section('§3  CLIENT SETUP — create staging-only client users');

// Create a client record linked to Company A
let clientRow = await db("SELECT id FROM clients WHERE name = 'P1F Test Client'");
let clientId;
if (clientRow.rows.length === 0) {
  const ins = await db(
    "INSERT INTO clients (name, status, \"companyId\") VALUES ('P1F Test Client', 'active', $1) RETURNING id",
    [COMPANY_A_ID]
  );
  clientId = ins.rows[0].id;
  console.log(`  Client record created id=${clientId}`);
} else {
  clientId = clientRow.rows[0].id;
  console.log(`  Client record already exists id=${clientId}`);
}

// Create CLIENT_ADMIN portal user
const caAdmHash = await bcrypt.hash(caAdmPw, 10);
let caAdmRow = await db("SELECT id FROM client_portal_users WHERE email = 'p1f-client-admin@staging.test'");
let caAdmId;
if (caAdmRow.rows.length === 0) {
  const ins = await db(
    "INSERT INTO client_portal_users (\"clientId\", email, \"passwordHash\", \"firstName\", \"lastName\", role) VALUES ($1, 'p1f-client-admin@staging.test', $2, 'Test', 'ClientAdmin', 'client_admin') RETURNING id",
    [clientId, caAdmHash]
  );
  caAdmId = ins.rows[0].id;
  console.log(`  CLIENT_ADMIN portal user created id=${caAdmId}`);
} else {
  caAdmId = caAdmRow.rows[0].id;
  console.log(`  CLIENT_ADMIN portal user already exists id=${caAdmId}`);
}

// Create CLIENT_VIEWER portal user
const caVwHash = await bcrypt.hash(caVwPw, 10);
let caVwRow = await db("SELECT id FROM client_portal_users WHERE email = 'p1f-client-viewer@staging.test'");
let caVwId;
if (caVwRow.rows.length === 0) {
  const ins = await db(
    "INSERT INTO client_portal_users (\"clientId\", email, \"passwordHash\", \"firstName\", \"lastName\", role) VALUES ($1, 'p1f-client-viewer@staging.test', $2, 'Test', 'ClientViewer', 'client_viewer') RETURNING id",
    [clientId, caVwHash]
  );
  caVwId = ins.rows[0].id;
  console.log(`  CLIENT_VIEWER portal user created id=${caVwId}`);
} else {
  caVwId = caVwRow.rows[0].id;
  console.log(`  CLIENT_VIEWER portal user already exists id=${caVwId}`);
}

section('§3  CLIENT TOKEN — login via /auth/client-login');
const [loginCAdm, loginCVw] = await Promise.all([
  post('/auth/client-login', null, { email: 'p1f-client-admin@staging.test', password: caAdmPw }),
  post('/auth/client-login', null, { email: 'p1f-client-viewer@staging.test', password: caVwPw }),
]);
expectStatus('CLIENT_ADMIN login → 201', loginCAdm, 201);
expectStatus('CLIENT_VIEWER login → 201', loginCVw,  201);
const tCAdm = loginCAdm.data?.accessToken;
const tCVw  = loginCVw.data?.accessToken;

section('§3  CLIENT TOKEN — CLIENT_ADMIN: no access to P1F routes');
const [cadmCompany, cadmAdmin, cadmGuard, cadmStaff] = await Promise.all([
  get(`/guard-personnel/company/guard/${GUARD_A_ID}/employment`,        tCAdm),
  get(`/guard-personnel/admin/${GUARD_A_ID}/employments`,               tCAdm),
  get('/guard-personnel/me/employments',                                 tCAdm),
  get(`/guard-personnel/company-staff/guard/${GUARD_A_ID}/employment`,  tCAdm),
]);
expect('CLIENT_ADMIN company route → 403 or 401',
  cadmCompany.status === 403 || cadmCompany.status === 401,
  `got HTTP ${cadmCompany.status}: ${JSON.stringify(cadmCompany.data)}`);
expect('CLIENT_ADMIN admin route → 403 or 401',
  cadmAdmin.status === 403 || cadmAdmin.status === 401,
  `got HTTP ${cadmAdmin.status}`);
expect('CLIENT_ADMIN guard route → 403 or 401',
  cadmGuard.status === 403 || cadmGuard.status === 401,
  `got HTTP ${cadmGuard.status}`);
expect('CLIENT_ADMIN staff route → 403 or 401',
  cadmStaff.status === 403 || cadmStaff.status === 401,
  `got HTTP ${cadmStaff.status}`);
// Log exact statuses for report
console.log(`  CLIENT_ADMIN exact HTTP: company=${cadmCompany.status} admin=${cadmAdmin.status} guard=${cadmGuard.status} staff=${cadmStaff.status}`);

section('§3  CLIENT TOKEN — CLIENT_VIEWER: no access to P1F routes');
const [cvwCompany, cvwAdmin, cvwGuard, cvwStaff] = await Promise.all([
  get(`/guard-personnel/company/guard/${GUARD_A_ID}/employment`,        tCVw),
  get(`/guard-personnel/admin/${GUARD_A_ID}/employments`,               tCVw),
  get('/guard-personnel/me/employments',                                 tCVw),
  get(`/guard-personnel/company-staff/guard/${GUARD_A_ID}/employment`,  tCVw),
]);
expect('CLIENT_VIEWER company route → 403 or 401',
  cvwCompany.status === 403 || cvwCompany.status === 401,
  `got HTTP ${cvwCompany.status}: ${JSON.stringify(cvwCompany.data)}`);
expect('CLIENT_VIEWER admin route → 403 or 401',
  cvwAdmin.status === 403 || cvwAdmin.status === 401,
  `got HTTP ${cvwAdmin.status}`);
expect('CLIENT_VIEWER guard route → 403 or 401',
  cvwGuard.status === 403 || cvwGuard.status === 401,
  `got HTTP ${cvwGuard.status}`);
expect('CLIENT_VIEWER staff route → 403 or 401',
  cvwStaff.status === 403 || cvwStaff.status === 401,
  `got HTTP ${cvwStaff.status}`);
console.log(`  CLIENT_VIEWER exact HTTP: company=${cvwCompany.status} admin=${cvwAdmin.status} guard=${cvwGuard.status} staff=${cvwStaff.status}`);

// Verify no P1F-specific client route exists
const clientSpecific = await get(`/guard-personnel/client/guard/${GUARD_A_ID}/employment`, tCAdm);
expect('No client-specific P1F route (404 or 403)', clientSpecific.status === 404 || clientSpecific.status === 403, `got HTTP ${clientSpecific.status}`);
console.log(`  Client-specific route probe: HTTP ${clientSpecific.status}`);

// ─────────────────────────────────────────────────────────────────────────────
// §4  LEAKAGE REVIEW — denied responses contain no employment data
// ─────────────────────────────────────────────────────────────────────────────
section('§4  LEAKAGE REVIEW — denied responses contain no employment data');

// Company A → Guard B (no relationship): 403 already tested
const leakCheck1 = aOnBGuard; // already captured
expect('Leak: company→no-CG: no data body', leakCheck1.data === null || !leakCheck1.data?.jobRole, `got: ${JSON.stringify(leakCheck1.data)}`);
expect('Leak: company→no-CG: no internalNote', !leakCheck1.data?.internalNote,    'internalNote in denied response');
expect('Leak: company→no-CG: no internalNoteEnc', !leakCheck1.data?.internalNoteEnc, 'ciphertext in denied response');
expect('Leak: company→no-CG: no engagementType', !leakCheck1.data?.engagementType, 'employment data in denied response');

// Client → company route: denied
const leakCheck2 = cadmCompany;
expect('Leak: client→company: no employment data', !leakCheck2.data?.jobRole,        `got: ${leakCheck2.data?.jobRole}`);
expect('Leak: client→company: no internalNote',    !leakCheck2.data?.internalNote,   'internalNote in client denied response');
expect('Leak: client→company: no internalNoteEnc', !leakCheck2.data?.internalNoteEnc, 'ciphertext in client denied response');

// Check 403 response structure — must be RFC error body, not an employment object
const is403Body = (d) => d != null && (('message' in d) || ('error' in d) || ('statusCode' in d));
expect('Denied response is error body (not employment object)', is403Body(leakCheck1.data) || leakCheck1.data === null,
  `unexpected response structure: ${JSON.stringify(leakCheck1.data)}`);

// ─────────────────────────────────────────────────────────────────────────────
// §6  CREDENTIAL HOUSEKEEPING
// ─────────────────────────────────────────────────────────────────────────────
section('§6  HOUSEKEEPING — delete temporary staging accounts');

// Delete client portal users
await db("DELETE FROM client_portal_users WHERE email IN ('p1f-client-admin@staging.test', 'p1f-client-viewer@staging.test')");
console.log('  CLIENT_ADMIN and CLIENT_VIEWER portal users deleted');

// Delete client record
await db("DELETE FROM clients WHERE name = 'P1F Test Client'");
console.log('  Client record deleted');

// Delete Company B: employment records → CompanyGuards → company profile → user
await db('DELETE FROM company_guard_employment_records WHERE "companyGuardId" IN ($1, $2)', [CG_B_ID, CG_B_EXCL_ID]);
await db('DELETE FROM company_guards WHERE "companyId" = $1', [COMPANY_B_ID]);
await db('DELETE FROM companies WHERE id = $1', [COMPANY_B_ID]);
await db("DELETE FROM users WHERE email = 'p1f-coB@staging.test'");
console.log('  Company B (p1f-coB@staging.test) and all associated records deleted');

// Delete p1f-staff account (temporary, created in previous gate run)
const staffUser = await db("SELECT u.id, c.id as cid FROM users u LEFT JOIN companies c ON c.\"userId\" = u.id WHERE u.email = 'p1f-staff@staging.test'");
if (staffUser.rows.length > 0) {
  const { id: uid, cid } = staffUser.rows[0];
  if (cid) {
    const staffCgs = await db('SELECT id FROM company_guards WHERE "companyId" = $1', [cid]);
    for (const cg of staffCgs.rows) {
      await db('DELETE FROM company_guard_employment_records WHERE "companyGuardId" = $1', [cg.id]);
    }
    await db('DELETE FROM company_guards WHERE "companyId" = $1', [cid]);
    await db('DELETE FROM companies WHERE id = $1', [cid]);
  }
  await db('DELETE FROM users WHERE id = $1', [uid]);
  console.log('  p1f-staff@staging.test and associated records deleted');
}

section('§6  HOUSEKEEPING — rotate permanent staging account passwords');
const [hGuard, hCompany, hAdmin] = await Promise.all([
  bcrypt.hash(newGuardPw,   10),
  bcrypt.hash(newCompanyPw, 10),
  bcrypt.hash(newAdminPw,   10),
]);
await db('UPDATE users SET "passwordHash" = $1 WHERE email = $2', [hGuard,   'p1d-guard@staging.test']);
await db('UPDATE users SET "passwordHash" = $1 WHERE email = $2', [hCompany, 'p1d-company@staging.test']);
await db('UPDATE users SET "passwordHash" = $1 WHERE email = $2', [hAdmin,   'blk004-drill@staging.local']);
console.log('  Passwords rotated for: p1d-guard, p1d-company, blk004-drill');
console.log('  (New credentials written to .p1f-staging-rotated-creds — gitignored)');

// Write rotated credentials to gitignored file for safe local reference
const credsContent = [
  '# P1F post-rotation staging credentials',
  '# Created: ' + new Date().toISOString(),
  '# DO NOT COMMIT — verify .gitignore covers this file',
  '',
  `p1d-guard@staging.test = ${newGuardPw}`,
  `p1d-company@staging.test = ${newCompanyPw}`,
  `blk004-drill@staging.local = ${newAdminPw}`,
].join('\n');
writeFileSync('C:/Users/Admin/S4-Claude/.p1f-staging-rotated-creds', credsContent, 'utf8');
console.log('  Credentials written to C:/Users/Admin/S4-Claude/.p1f-staging-rotated-creds');

// ─────────────────────────────────────────────────────────────────────────────
// FINAL COUNTS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`PASS: ${passed}   FAIL: ${failed}`);
console.log('═'.repeat(60));

await pg?.end();
if (failed > 0) process.exit(1);
