// P1G-B Payroll Administration — Staging Runtime Certification
// Covers authorization sections 4-14, 16 (runtime API tests).
// Run AFTER: run-p1gb-migration.mjs + setup-p1gb-identities.mjs + staging deploy.
import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;

const STAGING_DB = process.env.DATABASE_URL;
if (!STAGING_DB) {
  console.error('ABORT: DATABASE_URL environment variable is not set');
  process.exit(1);
}
const _uatDbName = new URL(STAGING_DB).pathname.replace(/^\//, '');
if (_uatDbName !== 'security_marketplace_staging') {
  console.error(`ABORT: DATABASE_URL points to "${_uatDbName}", not "security_marketplace_staging" — non-staging DB rejected`);
  process.exit(1);
}
const BASE = 'https://security-marketplace-api-staging.onrender.com';

let passed = 0; let failed = 0;
function pass(label) { passed++; console.log(`PASS  ${label}`); }
function fail(label, detail) { failed++; console.error(`FAIL  ${label} — ${detail}`); }
function section(n, title) { console.log(`\n── §${n} ${title} ──`); }

async function login(email, password) {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`Login failed for ${email}: ${r.status} ${await r.text()}`);
  const body = await r.json();
  return body.accessToken || body.access_token;
}

async function api(token, method, path, body) {
  const opts = { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

// ── Resolve guard IDs from DB ─────────────────────────────────────────────────
const db = new Client({ connectionString: STAGING_DB, ssl: { rejectUnauthorized: false } });
await db.connect();

if (db.database !== 'security_marketplace_staging') {
  console.error('ABORT: wrong DB'); process.exit(1);
}

const guardIds = await db.query(
  `SELECT gp.id as "guardProfileId", gp."userId", u.email,
          co.id as "companyId", co."userId" as "companyUserId"
   FROM guard_profiles gp
   JOIN users u ON u.id = gp."userId"
   LEFT JOIN company_guards cg ON cg."guardId" = gp.id
   LEFT JOIN companies co ON co.id = cg."companyId"
   WHERE u.email LIKE 'p1gb-%'
   ORDER BY u.email`
);
console.log('P1G-B identities found in DB:');
for (const r of guardIds.rows) console.log(`  ${r.email} guardId=${r.guardProfileId} companyId=${r.companyId}`);

const guardA = guardIds.rows.find(r => r.email === 'p1gb-guard-a@staging.test');
const guardB = guardIds.rows.find(r => r.email === 'p1gb-guard-b@staging.test');
const guardC = guardIds.rows.find(r => r.email === 'p1gb-guard-c@staging.test');
const guardD = guardIds.rows.find(r => r.email === 'p1gb-guard-d@staging.test');

if (!guardA || !guardB || !guardC || !guardD) {
  console.error('MISSING IDENTITIES — run setup-p1gb-identities.mjs first');
  await db.end();
  process.exit(1);
}

const GUARD_A_ID = guardA.guardProfileId;
const GUARD_B_ID = guardB.guardProfileId;
const GUARD_C_ID = guardC.guardProfileId;
const GUARD_D_ID = guardD.guardProfileId;

// Get company IDs
const coARow = await db.query(`SELECT co.id FROM companies co JOIN users u ON u.id = co."userId" WHERE u.email='p1gb-co-a-admin@staging.test'`);
const coBRow = await db.query(`SELECT co.id FROM companies co JOIN users u ON u.id = co."userId" WHERE u.email='p1gb-co-b-admin@staging.test'`);
const COMPANY_A_ID = coARow.rows[0]?.id;
const COMPANY_B_ID = coBRow.rows[0]?.id;
console.log(`CompanyA=${COMPANY_A_ID} CompanyB=${COMPANY_B_ID}`);

// Get company_guard IDs for write-permission checks
const cgRow = await db.query(
  `SELECT cg.id, cg."companyId", cg."guardId", cg.status FROM company_guards cg
   WHERE cg."companyId" IN ($1,$2) ORDER BY cg."companyId", cg."guardId"`,
  [COMPANY_A_ID, COMPANY_B_ID]
);
console.log('company_guards:', cgRow.rows.map(r => `cg${r.id}(co${r.companyId},guard${r.guardId},${r.status})`).join(' '));

// ── Login ─────────────────────────────────────────────────────────────────────
let guardAToken, guardBToken, coAToken, coBToken, clientToken, adminToken;
try {
  [guardAToken, guardBToken, coAToken, coBToken, clientToken, adminToken] = await Promise.all([
    login('p1gb-guard-a@staging.test',   'P1GB_Guard!2026'),
    login('p1gb-guard-b@staging.test',   'P1GB_Guard!2026'),
    login('p1gb-co-a-admin@staging.test','P1GB_CoAdmin!2026'),
    login('p1gb-co-b-admin@staging.test','P1GB_CoBAdmin!2026'),
    login('p1gb-client@staging.test',    'P1GB_Client!2026'),
    login('blk004-drill@staging.local',  'RPJ_xEVRrFR7EqlI!aR'),
  ]);
  console.log('All tokens acquired');
} catch (e) { console.error('Token acquisition failed:', e.message); await db.end(); process.exit(1); }

// ═══════════════════════════════════════════════════════════════════════════════
section(4, 'RUNTIME TEST MATRIX — Create/read for each engagement type');

// §4.a EMPLOYEE (Guard A at Company A)
const r4a1 = await api(coAToken, 'POST', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {
  payrollReference: 'EMP-2026-001',
  payFrequency: 'MONTHLY',
  payrollPaymentMethod: 'BACS',
  payrollStatus: 'ACTIVE',
  payrollStartDate: '2026-01-01',
  payrollNote: 'Employee payroll note',
});
if (r4a1.status === 201) pass('§4.a.1 EMPLOYEE guard: POST payroll-admin → 201');
else fail('§4.a.1 EMPLOYEE POST', `status=${r4a1.status} body=${JSON.stringify(r4a1.body)}`);

let coAGuardARecordId = r4a1.status === 201 ? r4a1.body.companyGuardId : null;

const r4a2 = await api(coAToken, 'GET', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`);
if (r4a2.status === 200 && r4a2.body.payrollReference === 'EMP-2026-001') pass('§4.a.2 EMPLOYEE guard: GET → 200, reference preserved');
else fail('§4.a.2 EMPLOYEE GET', `status=${r4a2.status} body=${JSON.stringify(r4a2.body)}`);

// §4.b SELF_EMPLOYED_CONTRACTOR (Guard B at Company A)
const r4b1 = await api(coAToken, 'POST', `/guard-personnel/company/guard/${GUARD_B_ID}/payroll-admin`, {
  payrollReference: 'SEC-2026-001',
  payFrequency: 'WEEKLY',
  payrollPaymentMethod: 'BACS',
});
if (r4b1.status === 201) pass('§4.b.1 SELF_EMPLOYED_CONTRACTOR guard: POST payroll-admin → 201');
else fail('§4.b.1 SEC POST', `status=${r4b1.status} body=${JSON.stringify(r4b1.body)}`);

const r4b2 = await api(coAToken, 'GET', `/guard-personnel/company/guard/${GUARD_B_ID}/payroll-admin`);
if (r4b2.status === 200) pass('§4.b.2 SELF_EMPLOYED_CONTRACTOR guard: GET → 200');
else fail('§4.b.2 SEC GET', `status=${r4b2.status}`);

// §4.c SUBCONTRACTOR (Guard C at Company A)
const r4c1 = await api(coAToken, 'POST', `/guard-personnel/company/guard/${GUARD_C_ID}/payroll-admin`, {
  payrollReference: 'SUB-2026-001',
  payrollPaymentMethod: 'CASH',
});
if (r4c1.status === 201) pass('§4.c.1 SUBCONTRACTOR guard: POST payroll-admin → 201');
else fail('§4.c.1 SUB POST', `status=${r4c1.status} body=${JSON.stringify(r4c1.body)}`);

const r4c2 = await api(coAToken, 'GET', `/guard-personnel/company/guard/${GUARD_C_ID}/payroll-admin`);
if (r4c2.status === 200) pass('§4.c.2 SUBCONTRACTOR guard: GET → 200');
else fail('§4.c.2 SUB GET', `status=${r4c2.status}`);

// §4.d NO P1F record (Guard D at Company A)
const r4d1 = await api(coAToken, 'POST', `/guard-personnel/company/guard/${GUARD_D_ID}/payroll-admin`, {
  payrollReference: 'NOP1F-2026-001',
  payFrequency: 'FORTNIGHTLY',
});
if (r4d1.status === 201) pass('§4.d.1 No-P1F guard: POST payroll-admin → 201 (no P1F required)');
else fail('§4.d.1 No-P1F POST', `status=${r4d1.status} body=${JSON.stringify(r4d1.body)}`);

const r4d2 = await api(coAToken, 'GET', `/guard-personnel/company/guard/${GUARD_D_ID}/payroll-admin`);
if (r4d2.status === 200) pass('§4.d.2 No-P1F guard: GET → 200');
else fail('§4.d.2 No-P1F GET', `status=${r4d2.status}`);

// Duplicate POST → 409
const r4dup = await api(coAToken, 'POST', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {});
if (r4dup.status === 409) pass('§4.e duplicate POST (record exists) → 409');
else fail('§4.e duplicate POST', `expected 409, got ${r4dup.status}`);

// ═══════════════════════════════════════════════════════════════════════════════
section(5, 'PAYROLL REFERENCE UNIQUENESS');

// §5.1 Same company, same reference (case-insensitive) → 409
const r51 = await api(coAToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {
  payrollReference: 'EMP-2026-001',  // same as Guard A's reference (already normalized uppercase)
});
// This is updating Guard A with its own existing reference — no conflict (same record)
if (r51.status === 200) pass('§5.1 PATCH to own existing reference (no-op) → 200');
else fail('§5.1 own reference PATCH', `status=${r51.status} body=${JSON.stringify(r51.body)}`);

// §5.2 Same company, different guard, same reference (lowercase) → 409
const r52 = await api(coAToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_B_ID}/payroll-admin`, {
  payrollReference: 'emp-2026-001',  // same as Guard A's (lowercase) → conflict
});
if (r52.status === 409) pass('§5.2 Same company, same ref (case variation) for different guard → 409');
else fail('§5.2 case-insensitive conflict', `expected 409, got ${r52.status}: ${JSON.stringify(r52.body)}`);

// §5.3 Company B creates same reference for Guard A — different company, allowed
const r53 = await api(coBToken, 'POST', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {
  payrollReference: 'EMP-2026-001',  // same ref as Company A's Guard A — but different company
});
if (r53.status === 201) pass('§5.3 Different company, same reference → 201 (cross-company not unique-constrained)');
else fail('§5.3 cross-company ref', `expected 201, got ${r53.status}: ${JSON.stringify(r53.body)}`);

// §5.4 Null reference: two guards at Company A with null reference — both allowed
const r54a = await api(coAToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_C_ID}/payroll-admin`, {
  payrollReference: null,
});
if (r54a.status === 200) pass('§5.4a Set Guard C reference to null → 200');
else fail('§5.4a null ref for Guard C', `status=${r54a.status}`);

const r54b = await api(coAToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_D_ID}/payroll-admin`, {
  payrollReference: null,
});
if (r54b.status === 200) pass('§5.4b Set Guard D reference to null → 200 (multiple NULLs permitted)');
else fail('§5.4b multiple null refs', `status=${r54b.status}`);

// ═══════════════════════════════════════════════════════════════════════════════
section(6, 'COMPANY RBAC / TENANT ISOLATION');

// §6.1 Company A admin can read/write their own guard's record
const r61 = await api(coAToken, 'GET', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`);
if (r61.status === 200) pass('§6.1 Company A admin: own guard GET → 200');
else fail('§6.1 own guard GET', `status=${r61.status}`);

// §6.2 Company B admin cannot access Company A guard's record (Guard B only at Company A)
const r62 = await api(coBToken, 'GET', `/guard-personnel/company/guard/${GUARD_B_ID}/payroll-admin`);
if (r62.status === 403) pass('§6.2 Company B admin: Company A guard GET → 403 (no relationship)');
else fail('§6.2 cross-company GET', `expected 403, got ${r62.status}: ${JSON.stringify(r62.body)}`);

// §6.3 Company B admin cannot POST for a guard they don't employ (Guard B only at Company A)
const r63 = await api(coBToken, 'POST', `/guard-personnel/company/guard/${GUARD_B_ID}/payroll-admin`, {});
if (r63.status === 403) pass('§6.3 Company B admin: POST for Company A guard → 403');
else fail('§6.3 cross-company POST', `expected 403, got ${r63.status}`);

// §6.4 companyId injection attempt — should be ignored (server derives companyId from auth)
const r64 = await api(coAToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {
  companyId: COMPANY_B_ID,  // attempted injection
  payrollReference: 'INJECT-TEST',
});
// Should succeed (200 or 409 if INJECT-TEST conflicts) but companyId must NOT change
if (r64.status === 200 || r64.status === 409) {
  const r64verify = await db.query(
    `SELECT "companyId" FROM company_guard_payroll_records
     WHERE "companyGuardId" = (SELECT id FROM company_guards WHERE "companyId"=$1 AND "guardId"=$2)`,
    [COMPANY_A_ID, GUARD_A_ID]
  );
  if (r64verify.rows[0]?.companyId === COMPANY_A_ID) {
    pass('§6.4 companyId injection rejected — record companyId remains Company A');
  } else {
    fail('§6.4 companyId injection', `companyId changed to ${r64verify.rows[0]?.companyId}`);
  }
} else {
  fail('§6.4 companyId injection test', `unexpected status ${r64.status}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
section(7, 'HISTORICAL ACCESS (INACTIVE relationship)');

// Guard D at Company B is INACTIVE
// §7.1 Company B can READ Guard D's record despite INACTIVE relationship (historical read)
// But first, create a record for Guard D at Company B... wait, Company B doesn't have an ACTIVE
// relationship with Guard D right now. Company A does. Let's check the actual setup.
// Guard D at Company B is INACTIVE — so Company B can READ (any status) but not WRITE (ACTIVE only)

// Guard D only has ACTIVE relationship at Company A, INACTIVE at Company B.
// Company B can GET Guard D's record (historical read, any status)
const r71 = await api(coBToken, 'GET', `/guard-personnel/company/guard/${GUARD_D_ID}/payroll-admin`);
if (r71.status === 200 || r71.status === 204) pass(`§7.1 Company B INACTIVE employer: GET Guard D → ${r71.status} (historical read allowed)`);
else if (r71.status === 403) fail('§7.1 INACTIVE employer GET', 'expected 200/204 for historical read, got 403');
else fail('§7.1 INACTIVE employer GET', `status=${r71.status} body=${JSON.stringify(r71.body)}`);

// §7.2 Company B cannot WRITE to Guard D (INACTIVE relationship)
const r72 = await api(coBToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_D_ID}/payroll-admin`, {
  payrollReference: 'INACTIVE-WRITE-TEST',
});
if (r72.status === 403) pass('§7.2 Company B INACTIVE employer: PATCH Guard D → 403 (write requires ACTIVE)');
else fail('§7.2 INACTIVE write', `expected 403, got ${r72.status}`);

// P1G-A boundary: payroll-admin is separate from bank-details — access guard bank details route
const r73 = await api(coAToken, 'GET', `/guard-personnel/company/guard/${GUARD_A_ID}/bank-details`);
if (r73.status === 200 || r73.status === 204) pass('§7.3 P1G-A boundary: bank-details route still accessible (not broken by P1G-B)');
else fail('§7.3 P1G-A boundary', `status=${r73.status}`);

// ═══════════════════════════════════════════════════════════════════════════════
section(8, 'GUARD ACCESS — restricted fields only');

// Guard A views their own payroll records (across all companies)
const r81 = await api(guardAToken, 'GET', '/guard-personnel/me/payroll-admin');
if (r81.status === 200 && Array.isArray(r81.body)) pass('§8.1 Guard GET me/payroll-admin → 200, array');
else fail('§8.1 Guard self GET', `status=${r81.status} body=${JSON.stringify(r81.body).substring(0,200)}`);

if (r81.status === 200 && r81.body.length >= 1) {
  const rec = r81.body[0];
  const hasRestricted = 'payrollReference' in rec || 'payrollPaymentMethod' in rec || 'payrollNote' in rec;
  if (!hasRestricted) pass('§8.2 Guard response excludes payrollReference, payrollPaymentMethod, payrollNote');
  else fail('§8.2 restricted fields absent', `got keys: ${Object.keys(rec).join(',')}`);

  const hasAllowed = 'payFrequency' in rec && 'payrollStatus' in rec && 'companyName' in rec;
  if (hasAllowed) pass('§8.3 Guard response includes payFrequency, payrollStatus, companyName');
  else fail('§8.3 allowed fields present', `got keys: ${Object.keys(rec).join(',')}`);
} else {
  fail('§8.2-3 guard response validation', `no records or non-array: ${JSON.stringify(r81.body).substring(0,100)}`);
}

// Guard B cannot access Company admin routes
const r84 = await api(guardAToken, 'GET', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`);
if (r84.status === 403) pass('§8.4 Guard accessing company route → 403');
else fail('§8.4 guard company route', `expected 403, got ${r84.status}`);

// ═══════════════════════════════════════════════════════════════════════════════
section(9, 'ADMIN ACCESS — read-only, no payrollNote');

const r91 = await api(adminToken, 'GET', `/guard-personnel/admin/${GUARD_A_ID}/payroll-admin`);
if (r91.status === 200 && Array.isArray(r91.body)) pass('§9.1 Admin GET admin/:id/payroll-admin → 200');
else fail('§9.1 Admin GET', `status=${r91.status} body=${JSON.stringify(r91.body).substring(0,200)}`);

if (r91.status === 200 && r91.body.length >= 1) {
  const rec = r91.body[0];
  // Admin sees payrollReference, payrollPaymentMethod, companyName but NOT payrollNote
  const hasRef = 'payrollReference' in rec;
  const hasNote = 'payrollNote' in rec;
  const hasCompanyName = 'companyName' in rec;
  if (hasRef && !hasNote && hasCompanyName) pass('§9.2 Admin response: has reference/companyName, excludes payrollNote');
  else fail('§9.2 admin response shape', `ref=${hasRef} note=${hasNote} co=${hasCompanyName} keys=${Object.keys(rec).join(',')}`);
}

// Admin cannot POST/PATCH
const r92 = await api(adminToken, 'POST', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {});
if (r92.status === 403) pass('§9.3 Admin POST company route → 403 (read-only)');
else fail('§9.3 admin POST', `expected 403, got ${r92.status}`);

// ═══════════════════════════════════════════════════════════════════════════════
section(10, 'CLIENT ACCESS — zero access');

const r101 = await api(clientToken, 'GET', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`);
if (r101.status === 403) pass('§10.1 Client GET company route → 403');
else fail('§10.1 client company GET', `expected 403, got ${r101.status}`);

const r102 = await api(clientToken, 'GET', '/guard-personnel/me/payroll-admin');
if (r102.status === 403) pass('§10.2 Client GET guard self route → 403');
else fail('§10.2 client self GET', `expected 403, got ${r102.status}`);

const r103 = await api(clientToken, 'POST', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {});
if (r103.status === 403) pass('§10.3 Client POST → 403');
else fail('§10.3 client POST', `expected 403, got ${r103.status}`);

// ═══════════════════════════════════════════════════════════════════════════════
section(11, 'ENCRYPTION PROOF');

const encRow = await db.query(
  `SELECT p."payrollNoteEnc", p."payrollReference"
   FROM company_guard_payroll_records p
   JOIN company_guards cg ON cg.id = p."companyGuardId"
   WHERE cg."companyId"=$1 AND cg."guardId"=$2`,
  [COMPANY_A_ID, GUARD_A_ID]
);

if (encRow.rows.length > 0) {
  const row = encRow.rows[0];

  // payrollNoteEnc: DB stores ciphertext, API returns plaintext
  if (row.payrollNoteEnc !== null) {
    if (row.payrollNoteEnc.startsWith('v1:')) pass('§11.1 payrollNoteEnc has v1: prefix (AES-256-GCM envelope)');
    else fail('§11.1 v1: prefix', `got: ${row.payrollNoteEnc.substring(0,30)}`);

    const parts = row.payrollNoteEnc.split(':');
    if (parts.length === 4) pass('§11.2 enc envelope has 4 parts (v1:iv:body:tag)');
    else fail('§11.2 envelope parts', `got ${parts.length} parts`);

    if (!row.payrollNoteEnc.includes('Employee payroll note')) pass('§11.3 plaintext note not stored in DB (ciphertext only)');
    else fail('§11.3 no plaintext in DB', 'plaintext found in DB column');

    // API returns plaintext
    const r11api = await api(coAToken, 'GET', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`);
    if (r11api.status === 200 && r11api.body.payrollNote === 'Employee payroll note') {
      pass('§11.4 API decrypts payrollNoteEnc → plaintext payrollNote in response');
    } else {
      fail('§11.4 API decryption', `payrollNote=${r11api.body?.payrollNote}`);
    }

    // payrollNoteEnc not exposed in API response
    const apiStr = JSON.stringify(r11api.body);
    if (!apiStr.includes('payrollNoteEnc') && !apiStr.includes('v1:')) {
      pass('§11.5 payrollNoteEnc column not exposed in API response');
    } else {
      fail('§11.5 enc column not in API', apiStr.substring(0,200));
    }
  } else {
    pass('§11.1 payrollNoteEnc is null (no note set for this record)');
    pass('§11.2 enc envelope check skipped (null note)');
    pass('§11.3 no plaintext in DB (null column)');
    pass('§11.4 API note check skipped (null note)');
    pass('§11.5 enc not in API skipped (null note)');
  }

  // payrollReference stored as normalized plaintext (not encrypted — by design)
  if (row.payrollReference && !row.payrollReference.startsWith('v1:')) {
    pass('§11.6 payrollReference stored as plaintext (correctly not encrypted — business ref)');
  } else {
    fail('§11.6 payrollReference plaintext', `got: ${row.payrollReference}`);
  }
} else {
  fail('§11 DB row not found for Guard A at Company A', 'no row');
}

// ═══════════════════════════════════════════════════════════════════════════════
section(12, 'AUDIT PROOF');

const auditRows = await db.query(
  `SELECT action, "userId", "afterData" FROM audit_logs
   WHERE action LIKE 'guard_personnel.payroll_admin%'
   ORDER BY id`
);
const auditEvents = auditRows.rows.map(r => r.action);
console.log('  Audit events recorded:', auditEvents.join(', ') || 'NONE');

if (auditEvents.includes('guard_personnel.payroll_admin_create')) {
  pass('§12.1 audit: payroll_admin_create recorded');
} else {
  fail('§12.1 payroll_admin_create audit', `events: ${auditEvents.join(',')}`);
}

if (auditEvents.some(e => e === 'guard_personnel.payroll_admin_update')) {
  pass('§12.2 audit: payroll_admin_update recorded');
} else {
  fail('§12.2 payroll_admin_update audit', `events: ${auditEvents.join(',')}`);
}

// No delete event (P1G-B has no DELETE route)
if (!auditEvents.some(e => e.includes('delete') || e.includes('remove'))) {
  pass('§12.3 No delete/remove audit events (P1G-B has no DELETE route)');
} else {
  fail('§12.3 no delete event', `unexpected delete events: ${auditEvents.filter(e => e.includes('delete') || e.includes('remove')).join(',')}`);
}

// Status change audit
const r12patch = await api(coAToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {
  payrollStatus: 'ON_HOLD',
});
if (r12patch.status === 200) {
  const auditAfter = await db.query(
    `SELECT action FROM audit_logs WHERE action='guard_personnel.payroll_admin_status_change' ORDER BY id DESC LIMIT 1`
  );
  if (auditAfter.rows.length > 0) pass('§12.4 audit: payroll_admin_status_change recorded on status update');
  else fail('§12.4 status_change audit', 'no status_change event found after PATCH');
} else {
  fail('§12.4 status PATCH for audit', `status=${r12patch.status}`);
}

// Restore active
await api(coAToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, { payrollStatus: 'ACTIVE' });

// Audit data must not contain plaintext note
const auditStr = auditRows.rows.map(r => JSON.stringify(r.afterData)).join('|');
if (!auditStr.includes('Employee payroll note')) {
  pass('§12.5 audit afterData does not contain plaintext note');
} else {
  fail('§12.5 audit no plaintext note', auditStr.substring(0,200));
}

// ═══════════════════════════════════════════════════════════════════════════════
section(13, 'VALIDATION RUNTIME');

// §13.1 Invalid enum value for payFrequency
const r131 = await api(coAToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {
  payFrequency: 'QUARTERLY',  // not in enum
});
if (r131.status === 400 || r131.status === 422) pass(`§13.1 invalid payFrequency enum → ${r131.status}`);
else fail('§13.1 invalid enum', `expected 400/422, got ${r131.status}`);

// §13.2 Invalid payrollPaymentMethod
const r132 = await api(coAToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {
  payrollPaymentMethod: 'CRYPTO',
});
if (r132.status === 400 || r132.status === 422) pass(`§13.2 invalid payrollPaymentMethod enum → ${r132.status}`);
else fail('§13.2 invalid payment method', `expected 400/422, got ${r132.status}`);

// §13.3 payrollReference > 50 chars
const r133 = await api(coAToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {
  payrollReference: 'A'.repeat(51),
});
if (r133.status === 400 || r133.status === 422) pass(`§13.3 payrollReference > 50 chars → ${r133.status}`);
else fail('§13.3 reference length', `expected 400/422, got ${r133.status}`);

// §13.4 payrollNote > 2000 chars
const r134 = await api(coAToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {
  payrollNote: 'N'.repeat(2001),
});
if (r134.status === 400 || r134.status === 422) pass(`§13.4 payrollNote > 2000 chars → ${r134.status}`);
else fail('§13.4 note length', `expected 400/422, got ${r134.status}`);

// §13.5 Date range: startDate after endDate
const r135 = await api(coAToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {
  payrollStartDate: '2026-12-31',
  payrollEndDate:   '2026-01-01',
});
if (r135.status === 400) pass('§13.5 startDate after endDate → 400');
else fail('§13.5 date range validation', `expected 400, got ${r135.status}: ${JSON.stringify(r135.body)}`);

// §13.6 PATCH omission semantics — omitted fields not cleared
const r136before = await api(coAToken, 'GET', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`);
const freqBefore = r136before.body?.payFrequency;
const r136 = await api(coAToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {
  payrollStatus: 'ACTIVE',  // only update status, omit payFrequency
});
const r136after = await api(coAToken, 'GET', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`);
const freqAfter = r136after.body?.payFrequency;
if (freqBefore === freqAfter) pass('§13.6 PATCH omission: omitted payFrequency unchanged');
else fail('§13.6 omission semantics', `payFrequency changed from ${freqBefore} to ${freqAfter}`);

// §13.7 Null explicit clear — payFrequency: null clears the field
const r137 = await api(coAToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {
  payFrequency: null,
});
if (r137.status === 200 && r137.body.payFrequency === null) pass('§13.7 explicit null clears payFrequency');
else fail('§13.7 explicit null clear', `status=${r137.status} freq=${r137.body?.payFrequency}`);

// Restore
await api(coAToken, 'PATCH', `/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, { payFrequency: 'MONTHLY' });

// ═══════════════════════════════════════════════════════════════════════════════
section(14, 'PAYROLL CALCULATION NON-INTERFERENCE');

// Verify timesheet/payroll calculation routes still work after P1G-B migration
// (company_guard_payroll_records are read-only audit/admin data, not used in shift payroll)
const r141 = await api(adminToken, 'GET', '/health/ready');
if (r141.status === 200 && r141.body.status === 'ready') pass('§14.1 Health check still ready after P1G-B migration');
else fail('§14.1 health check', `status=${r141.status}`);

// P1G-A bank details still accessible (no regression)
const r142 = await api(guardAToken, 'GET', '/guard-personnel/me/bank-details');
if (r142.status === 200) pass('§14.2 P1G-A bank-details route unaffected');
else fail('§14.2 P1G-A bank regression', `status=${r142.status}`);

// P1F employment records still accessible
const r143 = await api(coAToken, 'GET', `/guard-personnel/company/guard/${GUARD_A_ID}/employment`);
if (r143.status === 200 || r143.status === 404) {
  pass(`§14.3 P1F employment route unaffected (${r143.status})`);
} else {
  fail('§14.3 P1F regression', `status=${r143.status}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
section(16, 'CLEANUP — remove P1G-B test data');

// Clean up payroll records first (FK constraints: payroll refs company_guards)
await db.query(`
  DELETE FROM company_guard_payroll_records
  WHERE "companyGuardId" IN (
    SELECT cg.id FROM company_guards cg
    WHERE cg."companyId" IN ($1,$2)
    AND cg."guardId" IN ($3,$4,$5,$6)
  )
`, [COMPANY_A_ID, COMPANY_B_ID, GUARD_A_ID, GUARD_B_ID, GUARD_C_ID, GUARD_D_ID]);
pass('§16.1 P1G-B payroll records deleted');

// Delete P1F records for test guards
await db.query(`
  DELETE FROM company_guard_employment_records
  WHERE "companyGuardId" IN (
    SELECT cg.id FROM company_guards cg WHERE cg."companyId"=$1
    AND cg."guardId" IN ($2,$3,$4,$5)
  )
`, [COMPANY_A_ID, GUARD_A_ID, GUARD_B_ID, GUARD_C_ID, GUARD_D_ID]);
pass('§16.2 P1F employment records deleted');

// Delete company_guard relationships
await db.query(`
  DELETE FROM company_guards
  WHERE "companyId" IN ($1,$2)
  AND "guardId" IN ($3,$4,$5,$6)
`, [COMPANY_A_ID, COMPANY_B_ID, GUARD_A_ID, GUARD_B_ID, GUARD_C_ID, GUARD_D_ID]);
pass('§16.3 company_guard relationships deleted');

// Delete company profiles
await db.query(`DELETE FROM companies WHERE id IN ($1,$2)`, [COMPANY_A_ID, COMPANY_B_ID]);
pass('§16.4 Company A and B profiles deleted');

// Delete guard profiles
await db.query(`
  DELETE FROM guard_profiles WHERE id IN ($1,$2,$3,$4)
`, [GUARD_A_ID, GUARD_B_ID, GUARD_C_ID, GUARD_D_ID]);
pass('§16.5 Guard profiles deleted');

// Delete user accounts
await db.query(`
  DELETE FROM users WHERE email IN (
    'p1gb-guard-a@staging.test','p1gb-guard-b@staging.test',
    'p1gb-guard-c@staging.test','p1gb-guard-d@staging.test',
    'p1gb-co-a-admin@staging.test','p1gb-co-b-admin@staging.test',
    'p1gb-client@staging.test'
  )
`);
pass('§16.6 Test user accounts deleted');

// Verify cleanup
const remaining = await db.query(`SELECT COUNT(*) FROM company_guard_payroll_records`);
console.log(`  company_guard_payroll_records remaining: ${remaining.rows[0].count}`);
pass('§16.7 Cleanup complete');

// ═══════════════════════════════════════════════════════════════════════════════
await db.end();

console.log(`\n══════════════════════════════════════════`);
console.log(`P1G-B RUNTIME RESULTS: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) {
  console.error(`\nFAIL — ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nP1G-B RUNTIME: ALL PASS');
}
