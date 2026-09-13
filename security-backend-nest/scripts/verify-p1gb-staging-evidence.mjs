// P1G-B Staging Evidence Closure — D1 (encryption) + D2 (audit)
// Outputs only safe boolean/metadata results. Never prints credentials,
// ciphertext, plaintext note, tokens, or keys.
import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;

const STAGING_DB = process.env.DATABASE_URL;
if (!STAGING_DB) {
  console.error('ABORT: DATABASE_URL environment variable is not set');
  process.exit(1);
}
const _dbName = new URL(STAGING_DB).pathname.replace(/^\//, '');
if (_dbName !== 'security_marketplace_staging') {
  console.error(`ABORT: DATABASE_URL points to "${_dbName}", not "security_marketplace_staging"`);
  process.exit(1);
}

const BASE = 'https://security-marketplace-api-staging.onrender.com';
const COMPANY_A_ID = 6;
const GUARD_A_ID   = 9;

let passed = 0; let failed = 0;
function pass(l) { passed++; console.log(`PASS  ${l}`); }
function fail(l, d) { failed++; console.error(`FAIL  ${l} — ${d}`); }
function sect(s) { console.log(`\n── ${s} ──`); }

const db = new Client({ connectionString: STAGING_DB, ssl: { rejectUnauthorized: false } });
await db.connect();

// ── Target verification ──────────────────────────────────────────────────────
sect('DATABASE TARGET');
const dbName = (await db.query('SELECT current_database() AS d')).rows[0].d;
if (dbName === 'security_marketplace_staging') pass('DB name = security_marketplace_staging');
else { fail('DB name', `got "${dbName}"`); await db.end(); process.exit(1); }

const dbHost = (await db.query('SELECT inet_server_addr() AS h')).rows[0].h;
const dbHostStr = dbHost ? String(dbHost) : '';
pass(`DB host resolves (inet_server_addr present): ${dbHostStr.length > 0}`);

// ── D1: Encryption proof ─────────────────────────────────────────────────────
sect('D1 ENCRYPTION DB PROOF');

// Find Guard A's record at Company A
const encRow = await db.query(
  `SELECT
     (p."payrollNoteEnc" IS NOT NULL)                                   AS enc_not_null,
     (p."payrollNoteEnc" IS NOT NULL
        AND p."payrollNoteEnc" LIKE 'v1:%')                             AS starts_with_v1,
     (array_length(
        string_to_array(p."payrollNoteEnc", ':'), 1) = 4)               AS has_four_parts,
     (p."payrollNoteEnc" NOT LIKE '%Employee payroll note%')            AS plaintext_not_in_db,
     (p."payrollReference" IS NOT NULL)                                 AS ref_not_null,
     (p."payrollReference" NOT LIKE '%v1:%')                            AS ref_is_plaintext
   FROM company_guard_payroll_records p
   JOIN company_guards cg ON cg.id = p."companyGuardId"
   WHERE cg."companyId" = $1 AND cg."guardId" = $2`,
  [COMPANY_A_ID, GUARD_A_ID]
);

if (encRow.rows.length === 0) {
  fail('D1 record found', 'no company_guard_payroll_records row for Guard A at Company A');
} else {
  const r = encRow.rows[0];
  if (r.enc_not_null)        pass('D1.1 payrollNoteEnc IS NOT NULL');
  else                       fail('D1.1 payrollNoteEnc not null', 'column is NULL — no note stored');
  if (r.starts_with_v1)      pass('D1.2 payrollNoteEnc starts with v1: (version marker correct)');
  else                       fail('D1.2 v1: prefix', 'envelope version prefix absent');
  if (r.has_four_parts)      pass('D1.3 envelope has 4 colon-delimited parts (v1:iv:body:tag)');
  else                       fail('D1.3 envelope structure', 'unexpected part count');
  if (r.plaintext_not_in_db) pass('D1.4 plaintext note NOT stored in payrollNoteEnc column (ciphertext only)');
  else                       fail('D1.4 no plaintext in DB', 'plaintext found in encrypted column');
  if (r.ref_not_null)        pass('D1.5 payrollReference IS NOT NULL');
  else                       fail('D1.5 ref not null', 'unexpected null');
  if (r.ref_is_plaintext)    pass('D1.6 payrollReference stored as plaintext (not encrypted — correct by design)');
  else                       fail('D1.6 ref plaintext', 'reference appears to contain v1: envelope');
}

// ── D1: API decryption correlation ──────────────────────────────────────────
sect('D1 API DECRYPTION CORRELATION');

async function login(email, password) {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`Login failed ${email}: ${r.status}`);
  const body = await r.json();
  return body.accessToken || body.access_token;
}

let coAToken;
try {
  coAToken = await login('p1gb-co-a-admin@staging.test', 'P1GB_CoAdmin!2026');
  pass('D1 API login as Company A admin');
} catch (e) { fail('D1 API login', e.message); }

if (coAToken) {
  const apiR = await fetch(`${BASE}/guard-personnel/company/guard/${GUARD_A_ID}/payroll-admin`, {
    headers: { Authorization: `Bearer ${coAToken}` },
  });
  const apiBody = await apiR.json();
  const apiKeys = Object.keys(apiBody);

  if (apiR.ok && typeof apiBody.payrollNote === 'string' && apiBody.payrollNote.length > 0)
    pass('D1 API returns non-empty payrollNote (decryption successful)');
  else
    fail('D1 API decryption', `payrollNote=${apiBody.payrollNote}`);

  if (!apiBody.payrollNote?.startsWith('v1:'))
    pass('D1 API payrollNote is plaintext (does not start with v1: — correctly decrypted)');
  else
    fail('D1 API ciphertext exposed', 'API returned v1: envelope instead of plaintext');

  if (!apiKeys.includes('payrollNoteEnc'))
    pass('D1 payrollNoteEnc column absent from API response');
  else
    fail('D1 payrollNoteEnc in API response', 'encrypted column exposed');

  const rawStr = JSON.stringify(apiBody);
  if (!rawStr.includes('v1:'))
    pass('D1 raw API response contains no v1: ciphertext pattern');
  else
    fail('D1 v1: in raw response', 'ciphertext leaked into API response');
}

// ── D2: Audit log proof ──────────────────────────────────────────────────────
sect('D2 AUDIT LOG PROOF');

// Fetch audit events for P1G-B payroll_admin actions
const auditRows = await db.query(
  `SELECT
     action,
     ("userId" IS NOT NULL)                                           AS actor_present,
     ("entityId" IS NOT NULL OR "afterData" IS NOT NULL)              AS resource_context_present,
     (json_typeof("afterData") = 'object')                            AS after_data_is_object,
     -- changedFields (update), payrollStatus (create), newStatus (status_change)
     ("afterData"->>'changedFields' IS NOT NULL
       OR "afterData"->>'payrollStatus' IS NOT NULL
       OR "afterData"->>'newStatus' IS NOT NULL)                      AS changed_fields_or_status,
     -- Safety: dangerous field absence
     (("afterData"->>'payrollNote') IS NULL
       AND ("afterData"->>'payrollNoteEnc') IS NULL)                  AS no_plaintext_or_enc_note,
     (("afterData"->>'sortCode') IS NULL
       AND ("afterData"->>'accountNumber') IS NULL
       AND ("afterData"->>'accountHolderName') IS NULL)               AS no_bank_details,
     (("afterData"->>'nino') IS NULL AND ("afterData"->>'utr') IS NULL) AS no_nino_utr,
     (("afterData"->>'passwordHash') IS NULL
       AND ("afterData"->>'accessToken') IS NULL)                     AS no_secrets
   FROM audit_logs
   WHERE action LIKE 'guard_personnel.payroll_admin%'
   ORDER BY id`,
  []
);

const actions = auditRows.rows.map(r => r.action);
console.log(`  Persisted P1G-B audit events (${auditRows.rows.length} total):`);
for (const a of [...new Set(actions)]) {
  const count = actions.filter(x => x === a).length;
  console.log(`    ${a}: ${count} event(s)`);
}

// D2.1 Create event
const createEvents = auditRows.rows.filter(r => r.action === 'guard_personnel.payroll_admin_create');
if (createEvents.length > 0) pass(`D2.1 payroll_admin_create persisted (${createEvents.length} event(s))`);
else                          fail('D2.1 payroll_admin_create', 'no persisted event found');

// D2.2 Update event
const updateEvents = auditRows.rows.filter(r => r.action === 'guard_personnel.payroll_admin_update');
if (updateEvents.length > 0) pass(`D2.2 payroll_admin_update persisted (${updateEvents.length} event(s))`);
else                          fail('D2.2 payroll_admin_update', 'no persisted event found');

// D2.3 Status change event
const statusEvents = auditRows.rows.filter(r => r.action === 'guard_personnel.payroll_admin_status_change');
if (statusEvents.length > 0) pass(`D2.3 payroll_admin_status_change persisted (${statusEvents.length} event(s))`);
else                          fail('D2.3 payroll_admin_status_change', 'no persisted event found');

// D2.4 No delete event
const deleteEvents = auditRows.rows.filter(r => r.action.includes('delete') || r.action.includes('remove'));
if (deleteEvents.length === 0) pass('D2.4 payroll_admin_delete: 0 persisted events (correct — no DELETE route)');
else                           fail('D2.4 no delete event', `found unexpected: ${deleteEvents.map(r=>r.action).join(',')}`);

// D2.5 Actor present on all events
if (auditRows.rows.every(r => r.actor_present)) pass('D2.5 actor (userId) present on all audit events');
else fail('D2.5 actor present', `${auditRows.rows.filter(r=>!r.actor_present).length} event(s) missing actor`);

// D2.6 Resource context present
if (auditRows.rows.every(r => r.resource_context_present)) pass('D2.6 resource/afterData context present on all events');
else fail('D2.6 resource context', 'some events missing context');

// D2.7 afterData is object
if (auditRows.rows.every(r => r.after_data_is_object)) pass('D2.7 afterData is JSON object on all events');
else fail('D2.7 afterData object', 'some events have non-object afterData');

// D2.8 changedFields or status in afterData
if (auditRows.rows.every(r => r.changed_fields_or_status)) pass('D2.8 changedFields/payrollStatus present in afterData on all events');
else fail('D2.8 changedFields', `${auditRows.rows.filter(r=>!r.changed_fields_or_status).length} event(s) missing`);

// D2.9 No plaintext payrollNote or payrollNoteEnc in audit afterData
if (auditRows.rows.every(r => r.no_plaintext_or_enc_note)) pass('D2.9 No payrollNote or payrollNoteEnc value in afterData (encrypted column excluded)');
else fail('D2.9 no note in audit', 'sensitive note data found in audit afterData');

// D2.10 No bank details
if (auditRows.rows.every(r => r.no_bank_details)) pass('D2.10 No bank details in afterData');
else fail('D2.10 no bank details in audit', 'bank field found in audit afterData');

// D2.11 No NINO/UTR
if (auditRows.rows.every(r => r.no_nino_utr)) pass('D2.11 No NINO or UTR in afterData');
else fail('D2.11 no nino/utr', 'identifier found in audit afterData');

// D2.12 No passwords/tokens
if (auditRows.rows.every(r => r.no_secrets)) pass('D2.12 No passwordHash or accessToken in afterData');
else fail('D2.12 no secrets in audit', 'secret field found in audit afterData');

// ── Summary ──────────────────────────────────────────────────────────────────
await db.end();
console.log(`\n══════════════════════════════════════════`);
console.log(`P1G-B EVIDENCE: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) { console.error(`\nEVIDENCE CLOSURE: FAIL`); process.exit(1); }
else             { console.log('\nEVIDENCE CLOSURE: PASS'); }
