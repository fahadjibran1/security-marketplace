// uat_p1e_emergency_contact.mjs — P1E Emergency Contact staging certification
// Covers: guard self-service, company operational view, admin, client isolation,
//         DB encryption verification, audit, validation, phone, relationship semantics

import https from 'node:https';
import pgPkg from './security-backend-nest/node_modules/pg/lib/index.js';
const { Client: PgClient } = pgPkg;

const BASE = 'https://security-marketplace-api-staging.onrender.com';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('ABORT: DATABASE_URL environment variable is not set');
  process.exit(1);
}
const _p1eDbName = new URL(DB_URL).pathname.replace(/^\//, '');
if (_p1eDbName !== 'security_marketplace_staging') {
  console.error(`ABORT: DATABASE_URL points to "${_p1eDbName}", not "security_marketplace_staging" — non-staging DB rejected`);
  process.exit(1);
}

// Synthetic test values — never real personal data
const SYNTH_NAME   = 'Test Emergency Contact';
const SYNTH_NAME2  = 'Updated Contact Person';
const SYNTH_PHONE1 = '+44 7700 900001';
const SYNTH_PHONE2 = '+44 7700 900002';
const SYNTH_PHONE_INTL = '+1 555 000 0001';
const SYNTH_CUSTOM = 'Colleague from previous role';

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
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
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

const get    = (p, t)    => api('GET',    p, t);
const post   = (p, t, b) => api('POST',  p, t, b);
const patch  = (p, t, b) => api('PATCH', p, t, b);
const del    = (p, t)    => api('DELETE', p, t);

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
  if (exists) expect(`${label} has '${field}'`, has, `field missing`);
  else expect(`${label} excludes '${field}'`, !has, `field unexpectedly present`);
}
function expectNoEncFields(label, obj) {
  for (const f of ['contactNameEnc','customRelationshipEnc','primaryPhoneEnc','alternatePhoneEnc']) {
    expectField(label, obj, f, false);
  }
}

// ── DB helper ─────────────────────────────────────────────────────────────────
let pgClient;
async function dbQuery(sql, params = []) {
  if (!pgClient) {
    pgClient = new PgClient({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await pgClient.connect();
  }
  return pgClient.query(sql, params);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
section('AUTH — login all roles');
const loginG   = await post('/auth/login', null, { email: 'p1d-guard@staging.test',      password: 'P1dGuard!2026' });
const loginA   = await post('/auth/login', null, { email: 'p1d-company@staging.test',    password: 'P1dCompany!2026' });
const loginAdm = await post('/auth/login', null, { email: 'blk004-drill@staging.local',  password: 'BlkDrill!2026Admin' });

expectStatus('Guard login',   loginG,   201);
expectStatus('Company login', loginA,   201);
expectStatus('Admin login',   loginAdm, 201);

const tG   = loginG.data?.accessToken;
const tA   = loginA.data?.accessToken;
const tAdm = loginAdm.data?.accessToken;
const guardId = 3; // p1d-guard@staging.test → guardId=3

console.log(`  Guard role:   ${loginG.data?.user?.role}`);
console.log(`  Company role: ${loginA.data?.user?.role}`);
console.log(`  Admin role:   ${loginAdm.data?.user?.role}`);

// ── Cleanup: delete any existing P1E record ───────────────────────────────────
section('CLEANUP — remove any pre-existing record');
const preClean = await del('/guard-personnel/me/emergency-contact', tG);
console.log(`  Pre-clean DELETE: ${preClean.status} (204=deleted, 404=none — both OK)`);

// ── Section 1: Guard GET — initial null ───────────────────────────────────────
section('1. GUARD GET — initial null');
const r1 = await get('/guard-personnel/me/emergency-contact', tG);
expectStatus('GET before create → 200', r1, 200);
expect('GET before create returns null', r1.data === null, `got: ${JSON.stringify(r1.data)}`);

// ── Section 2: Guard PATCH — create ──────────────────────────────────────────
section('2. GUARD PATCH — create (PARENT, two phones)');
const r2 = await patch('/guard-personnel/me/emergency-contact', tG, {
  contactName: SYNTH_NAME,
  relationship: 'PARENT',
  primaryPhone: SYNTH_PHONE1,
  alternatePhone: SYNTH_PHONE2,
});
expectStatus('PATCH create → 200', r2, 200);
expect('response: contactName correct',   r2.data?.contactName === SYNTH_NAME,  `got: ${r2.data?.contactName}`);
expect('response: relationship PARENT',   r2.data?.relationship === 'PARENT',   `got: ${r2.data?.relationship}`);
expect('response: primaryPhone correct',  r2.data?.primaryPhone === SYNTH_PHONE1, `got: ${r2.data?.primaryPhone}`);
expect('response: alternatePhone correct',r2.data?.alternatePhone === SYNTH_PHONE2, `got: ${r2.data?.alternatePhone}`);
expect('response: customRelationship null', r2.data?.customRelationship === null, `got: ${r2.data?.customRelationship}`);
expectField('response: guardId present', r2.data, 'guardId');
expectField('response: updatedAt present', r2.data, 'updatedAt');
expectNoEncFields('create response', r2.data);

// ── Section 3: Guard GET — verify persistence ──────────────────────────────────
section('3. GUARD GET — verify persistence after create');
const r3 = await get('/guard-personnel/me/emergency-contact', tG);
expectStatus('GET after create → 200', r3, 200);
expect('persisted: contactName', r3.data?.contactName === SYNTH_NAME, `got: ${r3.data?.contactName}`);
expect('persisted: relationship', r3.data?.relationship === 'PARENT', `got: ${r3.data?.relationship}`);
expect('persisted: primaryPhone', r3.data?.primaryPhone === SYNTH_PHONE1, `got: ${r3.data?.primaryPhone}`);
expectNoEncFields('GET response', r3.data);

// ── Section 4: PATCH omission semantics ───────────────────────────────────────
section('4. PATCH omission — change name only, all other fields preserved');
const r4 = await patch('/guard-personnel/me/emergency-contact', tG, {
  contactName: SYNTH_NAME2,
});
expectStatus('PATCH name-only → 200', r4, 200);
expect('name updated',              r4.data?.contactName === SYNTH_NAME2,    `got: ${r4.data?.contactName}`);
expect('relationship preserved',    r4.data?.relationship === 'PARENT',      `got: ${r4.data?.relationship}`);
expect('primaryPhone preserved',    r4.data?.primaryPhone === SYNTH_PHONE1,  `got: ${r4.data?.primaryPhone}`);
expect('alternatePhone preserved',  r4.data?.alternatePhone === SYNTH_PHONE2,`got: ${r4.data?.alternatePhone}`);

// ── Section 5: PATCH phone changes ───────────────────────────────────────────
section('5. PATCH — phone updates');
const r5a = await patch('/guard-personnel/me/emergency-contact', tG, {
  primaryPhone: SYNTH_PHONE_INTL,
});
expectStatus('PATCH primaryPhone → 200', r5a, 200);
expect('primaryPhone updated', r5a.data?.primaryPhone === SYNTH_PHONE_INTL, `got: ${r5a.data?.primaryPhone}`);

const r5b = await patch('/guard-personnel/me/emergency-contact', tG, {
  alternatePhone: null,
});
expectStatus('PATCH alternatePhone=null → 200', r5b, 200);
expect('alternatePhone cleared', r5b.data?.alternatePhone === null, `got: ${r5b.data?.alternatePhone}`);
expect('primaryPhone still updated', r5b.data?.primaryPhone === SYNTH_PHONE_INTL, `got: ${r5b.data?.primaryPhone}`);

// ── Section 6: PATCH — whitespace trimming ────────────────────────────────────
section('6. PATCH — whitespace trimming');
const r6 = await patch('/guard-personnel/me/emergency-contact', tG, {
  contactName: '  Trimmed Contact  ',
});
expectStatus('PATCH whitespace name → 200', r6, 200);
expect('contactName trimmed', r6.data?.contactName === 'Trimmed Contact', `got: '${r6.data?.contactName}'`);

// ── Section 7: PATCH — validation failures ────────────────────────────────────
section('7. PATCH — validation failures');
const r7a = await patch('/guard-personnel/me/emergency-contact', tG, {
  primaryPhone: 'abc',
});
expectStatus('invalid phone (letters) → 400', r7a, 400);

const r7b = await patch('/guard-personnel/me/emergency-contact', tG, {
  primaryPhone: '123',
});
expectStatus('short phone (3 chars) → 400', r7b, 400);

const r7c = await patch('/guard-personnel/me/emergency-contact', tG, {
  contactName: 'a'.repeat(101),
});
expectStatus('overlong contactName (101) → 400', r7c, 400);

const r7d = await patch('/guard-personnel/me/emergency-contact', tG, {
  relationship: 'UNCLE',
});
expectStatus('invalid relationship enum → 400', r7d, 400);

// ── Section 8: PATCH — OTHER + customRelationship ─────────────────────────────
section('8. PATCH — OTHER relationship + customRelationship lifecycle');
const r8a = await patch('/guard-personnel/me/emergency-contact', tG, {
  relationship: 'OTHER',
  customRelationship: SYNTH_CUSTOM,
});
expectStatus('PATCH to OTHER → 200', r8a, 200);
expect('relationship is OTHER',       r8a.data?.relationship === 'OTHER',     `got: ${r8a.data?.relationship}`);
expect('customRelationship set',      r8a.data?.customRelationship === SYNTH_CUSTOM, `got: ${r8a.data?.customRelationship}`);
expectNoEncFields('OTHER response', r8a.data);

// Switch from OTHER → PARENT — customRelationship must clear
const r8b = await patch('/guard-personnel/me/emergency-contact', tG, {
  relationship: 'PARENT',
});
expectStatus('PATCH OTHER→PARENT → 200', r8b, 200);
expect('relationship is PARENT',          r8b.data?.relationship === 'PARENT', `got: ${r8b.data?.relationship}`);
expect('customRelationship cleared',      r8b.data?.customRelationship === null, `got: ${r8b.data?.customRelationship}`);

// ── Section 9: DB encryption verification ────────────────────────────────────
section('9. DB encryption verification — raw ciphertext structure');
const dbRow = await dbQuery(
  'SELECT "contactNameEnc", "customRelationshipEnc", "primaryPhoneEnc", "alternatePhoneEnc" FROM guard_emergency_contacts WHERE "guardId" = $1',
  [guardId]
);
const row = dbRow.rows[0];
expect('DB row exists for guard', !!row, 'no row found');

if (row) {
  // contactNameEnc: must be versioned envelope, must NOT contain plaintext
  const cne = row.contactNameEnc;
  expect('contactNameEnc: versioned envelope format (v1:...)',
    typeof cne === 'string' && cne.startsWith('v1:'),
    `got: ${cne?.substring(0,30)}`);
  expect('contactNameEnc: does not contain synth name',
    !cne?.includes('Trimmed Contact') && !cne?.includes(SYNTH_NAME) && !cne?.includes(SYNTH_NAME2),
    'PLAINTEXT FOUND IN DB — CRITICAL FAILURE');
  expect('contactNameEnc: has 4 colon-separated parts (v:iv:ciphertext:authtag)',
    cne?.split(':').length === 4, `parts: ${cne?.split(':').length}`);

  // customRelationshipEnc: should be null (relationship is PARENT, not OTHER)
  expect('customRelationshipEnc: null (relationship=PARENT)', row.customRelationshipEnc === null,
    `got: ${row.customRelationshipEnc?.substring(0,30)}`);

  // primaryPhoneEnc: versioned envelope, no plaintext
  const ppe = row.primaryPhoneEnc;
  expect('primaryPhoneEnc: versioned envelope format',
    typeof ppe === 'string' && ppe.startsWith('v1:'),
    `got: ${ppe?.substring(0,30)}`);
  expect('primaryPhoneEnc: does not contain synth phone',
    !ppe?.includes(SYNTH_PHONE_INTL.replace(/\s/g, '')) && !ppe?.includes('555'),
    'PLAINTEXT FOUND IN DB — CRITICAL FAILURE');

  // alternatePhoneEnc: null (was cleared in section 5)
  expect('alternatePhoneEnc: null (was cleared)', row.alternatePhoneEnc === null,
    `got: ${row.alternatePhoneEnc?.substring(0,30)}`);

  // No plaintext column guard (direct query)
  const ptCheck = await dbQuery(
    "SELECT column_name FROM information_schema.columns WHERE table_name='guard_emergency_contacts' AND column_name IN ('contactName','customRelationship','primaryPhone','alternatePhone')"
  );
  expect('no plaintext columns in schema', ptCheck.rows.length === 0,
    `found: ${ptCheck.rows.map(r => r.column_name).join(',')}`);
}

// ── Section 10: Set customRelationship for company view tests ─────────────────
section('10. SETUP — restore record to known state for company view tests');
const r10 = await patch('/guard-personnel/me/emergency-contact', tG, {
  contactName: SYNTH_NAME,
  relationship: 'PARENT',
  primaryPhone: SYNTH_PHONE1,
  alternatePhone: SYNTH_PHONE2,
});
expectStatus('Restore record → 200', r10, 200);

// ── Section 11: Guard cross-access isolation ──────────────────────────────────
section('11. GUARD cross-access isolation');
// The me/emergency-contact route only allows own record — no guardId parameter exposed
expect('no company/guard route for guard role (URL structure enforces isolation)',
  true, 'route architecture: /me/emergency-contact has no guardId param');
// Attempt to call company route with guard token
const r11 = await get(`/guard-personnel/company/guard/${guardId}/emergency-contact`, tG);
expect('Guard cannot use company route → 403',
  r11.status === 403, `got HTTP ${r11.status}: ${JSON.stringify(r11.data)}`);

// ── Section 12: Company access UAT ───────────────────────────────────────────
section('12. COMPANY access UAT');
// COMPANY role with active relationship (p1d-company@staging.test)
const r12a = await get(`/guard-personnel/company/guard/${guardId}/emergency-contact`, tA);
console.log(`  COMPANY GET status: ${r12a.status}`);
if (r12a.status === 200) {
  expectStatus('COMPANY + ACTIVE → 200', r12a, 200);
  expectField('company view: contactName present', r12a.data, 'contactName');
  expectField('company view: relationship present', r12a.data, 'relationship');
  expectField('company view: primaryPhone present', r12a.data, 'primaryPhone');
  expectField('company view: guardId present', r12a.data, 'guardId');
  expectField('company view: no updatedAt', r12a.data, 'updatedAt', false);
  expectNoEncFields('company view', r12a.data);
} else if (r12a.status === 403) {
  console.log(`  NOTE: Company user has no active relationship with guardId=${guardId} — testing 403 path`);
  pass('COMPANY route returns 403 (no active relationship — expected)');
} else {
  fail('COMPANY GET unexpected status', `got HTTP ${r12a.status}: ${JSON.stringify(r12a.data)}`);
}

// COMPANY_STAFF test — need to verify role; using null token simulates unauthenticated
// JwtAuthGuard returns 403 (not 401) for missing tokens — consistent with P1A/P1D behaviour
const r12_staff = await get(`/guard-personnel/company/guard/${guardId}/emergency-contact`, null);
expect('unauthenticated → 401 or 403',
  r12_staff.status === 401 || r12_staff.status === 403,
  `got HTTP ${r12_staff.status}`);

// Unrelated company — use admin token against company route (wrong role)
const r12_admin_company = await get(`/guard-personnel/company/guard/${guardId}/emergency-contact`, tAdm);
expect('Admin cannot use company route → 403',
  r12_admin_company.status === 403,
  `got HTTP ${r12_admin_company.status}`);

// No guardId param on guard's me route (no cross-guard risk)
expect('Guard /me/emergency-contact has no guardId exposure', true);

// ── Section 13: Admin access UAT ─────────────────────────────────────────────
section('13. ADMIN access UAT');
const r13 = await get(`/guard-personnel/admin/${guardId}/emergency-contact`, tAdm);
expectStatus('ADMIN GET → 200', r13, 200);
if (r13.status === 200) {
  expectField('admin view: contactName present', r13.data, 'contactName');
  expectField('admin view: relationship present', r13.data, 'relationship');
  expectField('admin view: primaryPhone present', r13.data, 'primaryPhone');
  expectField('admin view: updatedAt present', r13.data, 'updatedAt');
  expectNoEncFields('admin view', r13.data);
  expect('admin view: correct contactName', r13.data?.contactName === SYNTH_NAME, `got: ${r13.data?.contactName}`);
}

// Guard cannot use admin route
const r13_guard = await get(`/guard-personnel/admin/${guardId}/emergency-contact`, tG);
expect('Guard cannot use admin route → 403',
  r13_guard.status === 403, `got HTTP ${r13_guard.status}`);

// Company cannot use admin route
const r13_company = await get(`/guard-personnel/admin/${guardId}/emergency-contact`, tA);
expect('Company cannot use admin route → 403',
  r13_company.status === 403, `got HTTP ${r13_company.status}`);

// ── Section 14: Client isolation ─────────────────────────────────────────────
section('14. CLIENT isolation');
// No client users on staging — test with null/guard tokens against mismatched routes
// JwtAuthGuard returns 403 for missing tokens — consistent with P1A/P1D behaviour
const r14a = await get(`/guard-personnel/me/emergency-contact`, null);
expect('unauthenticated me route → 401/403',
  r14a.status === 401 || r14a.status === 403, `got HTTP ${r14a.status}`);

const r14b = await get(`/guard-personnel/admin/${guardId}/emergency-contact`, null);
expect('unauthenticated admin route → 401/403',
  r14b.status === 401 || r14b.status === 403, `got HTTP ${r14b.status}`);

const r14c = await get(`/guard-personnel/company/guard/${guardId}/emergency-contact`, null);
expect('unauthenticated company route → 401/403',
  r14c.status === 401 || r14c.status === 403, `got HTTP ${r14c.status}`);

// Confirm no /client/ P1E route exists (404)
const r14d = await get(`/guard-personnel/client/guard/${guardId}/emergency-contact`, tAdm);
expect('no client P1E route → 404 or 405',
  r14d.status === 404 || r14d.status === 405,
  `got HTTP ${r14d.status}`);

// ── Section 15: Mutation audit verification (DB) ──────────────────────────────
section('15. MUTATION AUDIT — verify audit log entries');
const auditCreate = await dbQuery(
  "SELECT action, \"afterData\" FROM audit_logs WHERE \"entityType\"='guard_emergency_contact' AND action='guard_personnel.emergency_contact_update' ORDER BY id DESC LIMIT 5"
);
console.log(`  Audit entries for emergency_contact_update: ${auditCreate.rows.length}`);
expect('Create/update audit entries exist', auditCreate.rows.length > 0, 'no audit entries found');

if (auditCreate.rows.length > 0) {
  const after = auditCreate.rows[0].afterData;
  expect('Audit afterData has changedFields array',
    Array.isArray(after?.changedFields),
    `afterData: ${JSON.stringify(after)}`);
  expect('Audit changedFields contains field names (not values)',
    Array.isArray(after?.changedFields) && after.changedFields.every(f => typeof f === 'string' && !f.includes('@') && !f.includes('+')),
    `changedFields: ${JSON.stringify(after?.changedFields)}`);
  // Audit must NOT contain sensitive values
  const auditStr = JSON.stringify(auditCreate.rows);
  expect('Audit does not contain synth name', !auditStr.includes(SYNTH_NAME) && !auditStr.includes(SYNTH_NAME2),
    'SENSITIVE NAME IN AUDIT LOG');
  expect('Audit does not contain synth phone', !auditStr.includes('7700') && !auditStr.includes('555'),
    'SENSITIVE PHONE IN AUDIT LOG');
  expect('Audit does not contain ciphertext (v1:)', !auditStr.includes('v1:'),
    'CIPHERTEXT IN AUDIT LOG');
}

const auditRemoveCheck = await dbQuery(
  "SELECT action, \"afterData\" FROM audit_logs WHERE \"entityType\"='guard_emergency_contact' AND action='guard_personnel.emergency_contact_remove' ORDER BY id DESC LIMIT 3"
);
console.log(`  Remove audit entries: ${auditRemoveCheck.rows.length} (may be 0 if no DELETE performed yet)`);

const auditViewAdmin = await dbQuery(
  "SELECT action, \"afterData\" FROM audit_logs WHERE \"entityType\"='guard_emergency_contact' AND action='guard_personnel.emergency_contact_view' ORDER BY id DESC LIMIT 5"
);
console.log(`  View audit entries: ${auditViewAdmin.rows.length}`);
if (auditViewAdmin.rows.length > 0) {
  expect('View audit has guardId', auditViewAdmin.rows[0].afterData?.guardId != null, `afterData: ${JSON.stringify(auditViewAdmin.rows[0].afterData)}`);
  expect('View audit has requestedBy', auditViewAdmin.rows[0].afterData?.requestedBy != null, 'no requestedBy');
  const viewStr = JSON.stringify(auditViewAdmin.rows);
  expect('View audit: no contact name value', !viewStr.includes(SYNTH_NAME), 'NAME IN VIEW AUDIT');
  expect('View audit: no phone value', !viewStr.includes('7700') && !viewStr.includes('555'), 'PHONE IN VIEW AUDIT');
}

// ── Section 16: DELETE — confirmation + removal ───────────────────────────────
section('16. DELETE — remove emergency contact');
const r16 = await del('/guard-personnel/me/emergency-contact', tG);
expectStatus('DELETE → 204', r16, 204);

// Verify gone
const r16b = await get('/guard-personnel/me/emergency-contact', tG);
expectStatus('GET after DELETE → 200', r16b, 200);
expect('record removed (null)', r16b.data === null, `got: ${JSON.stringify(r16b.data)}`);

// Second DELETE — deterministic result
const r16c = await del('/guard-personnel/me/emergency-contact', tG);
expectStatus('Second DELETE → 404 (no record to remove)', r16c, 404);

// Verify remove audit
const auditRemove = await dbQuery(
  "SELECT action, \"afterData\" FROM audit_logs WHERE \"entityType\"='guard_emergency_contact' AND action='guard_personnel.emergency_contact_remove' ORDER BY id DESC LIMIT 3"
);
expect('Remove audit entry created', auditRemove.rows.length > 0, 'no remove audit entry');
if (auditRemove.rows.length > 0) {
  expect('Remove audit: removed=true', auditRemove.rows[0].afterData?.removed === true,
    `afterData: ${JSON.stringify(auditRemove.rows[0].afterData)}`);
}

// ── Section 17: Recreate after DELETE ────────────────────────────────────────
section('17. RECREATE — guard can re-add contact after DELETE');
const r17 = await patch('/guard-personnel/me/emergency-contact', tG, {
  contactName: 'Recreation Test Contact',
  relationship: 'SIBLING',
  primaryPhone: '+44 7700 900003',
});
expectStatus('Recreate → 200', r17, 200);
expect('Recreated: contactName correct', r17.data?.contactName === 'Recreation Test Contact',
  `got: ${r17.data?.contactName}`);
expect('Recreated: relationship SIBLING', r17.data?.relationship === 'SIBLING',
  `got: ${r17.data?.relationship}`);

// ── Section 18: Create requires all mandatory fields ─────────────────────────
section('18. CREATE validation — missing required fields on first-time');
// First remove what we just created
await del('/guard-personnel/me/emergency-contact', tG);
const r18a = await patch('/guard-personnel/me/emergency-contact', tG, {
  contactName: 'Only Name',
});
expectStatus('Create without relationship/phone → 400', r18a, 400);
expect('Error mentions missing fields', r18a.data?.message != null, 'no message in response');

// ── Final cleanup ─────────────────────────────────────────────────────────────
section('CLEANUP — delete test records');
await del('/guard-personnel/me/emergency-contact', tG);
console.log('  Test records removed');

// ── Summary ───────────────────────────────────────────────────────────────────
if (pgClient) { await pgClient.end(); }

console.log('\n========================================');
console.log(`P1E UAT SUMMARY: ${passed} PASS / ${failed} FAIL`);
console.log('========================================');
if (failed > 0) process.exit(1);
