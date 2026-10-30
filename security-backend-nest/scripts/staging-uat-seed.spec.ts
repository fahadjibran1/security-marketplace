/**
 * Safety checks for scripts/staging-uat-seed.ts (staging UAT data, 20 Oct 2026). No database, network or bucket:
 * the seeder's evidence decisions are executed directly and its upload sequence is read from source.
 *
 *   SEED-01  the fictional PDF is a well-formed PDF (every xref offset lands on its object) and says FICTIONAL
 *   SEED-02  the evidence guard refuses the placeholder, non-R2/HTTP endpoints, the production bucket, any other
 *            bucket and the production key; it accepts only the staging bucket
 *   SEED-03  documents go through the real workflow in order (presign -> PUT bytes -> complete-upload -> verify)
 *            and the file-less legacy path (fileUrl) is never used
 *   SEED-04  the database guards are present: staging host only, production host refused, empty target, ledger 68
 *   SEED-05  the shift id is read from the real POST /shifts response ({ shift, timesheet }); the 21 Oct staging seed
 *            stopped at /shifts/undefined/respond because the old code read .id off the wrapper
 *   SEED-06  logins are written as each account is created, before any later step (the 21 Oct runs lost them)
 *   SEED-07  redaction keeps the error and its stack frames but never a password, token, key, URL or signature
 *   SEED-08  every HTTP request carries a 60 s timeout
 *   SEED-09  a state-changing request is sent once; after a failure the state is read back, never resent
 *   SEED-10  --report is read only, needs no confirmation, and prints no secret
 *   SEED-12  the expected ledger is this code's own migration head (64), checked before seeding AND before
 *            --recover-logins boots the app; no in-process timer (incl. amendment expiry) runs; the report tolerates 63
 *   SEED-13  the recovery allowlist is the 3 UAT accounts plus at most the approved platform administrator
 *            (uat-s4-admin@example.com, admin role); any other user is refused; only the 3 UAT accounts are reset
 *   SEED-11  --recover-logins touches only the 3 fictional accounts, only through the product's reset workflow,
 *            saves each login before the next step and proves it on the deployed staging API
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  companyBPreflightProblem, COMPANY_B, UAT_COMPANY_B_OWNER_EMAIL,
  confirmOnce, createdShift, fictionalPdf, recoveryUsersProblem, redact, registerSecret, repositoryMigrationHead, REQUEST_TIMEOUT_MS,
  stagingEvidenceProblem, UAT_ACCOUNT_EMAILS, UAT_PLATFORM_ADMIN_EMAIL, writeLogins,
} from './staging-uat-seed';

let passed = 0;
// Runs in order; an async check is awaited before the next starts, and any failure exits non-zero.
let queue: Promise<void> = Promise.resolve();
const test = (id: string, fn: () => void | Promise<void>) => {
  queue = queue.then(async () => { await fn(); passed += 1; console.log(`PASS  ${id}`); });
};
const source = fs.readFileSync(path.join(__dirname, 'staging-uat-seed.ts'), 'utf8');

test('SEED-01-THE-FICTIONAL-PDF-IS-WELL-FORMED-AND-SAYS-SO', () => {
  const pdf = fictionalPdf('FICTIONAL SIA LICENCE (TEST)', 'Test Guard Alpha', '9900000000000001');
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n') && text.endsWith('%%EOF\n'));
  const xrefAt = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
  assert.ok(text.slice(xrefAt).startsWith('xref\n'), 'startxref points at the xref table');
  const offsets = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 5);
  offsets.forEach((offset, i) => assert.ok(text.slice(offset).startsWith(`${i + 1} 0 obj\n`), `object ${i + 1} offset`));
  for (const phrase of ['FICTIONAL TEST DOCUMENT - S4 STAGING UAT ONLY', 'NOT an SIA licence', 'fictional test person', 'not issued by any authority']) {
    assert.ok(text.includes(phrase), phrase);
  }
  assert.ok(pdf.length > 100 && pdf.length < 10 * 1024 * 1024, 'within the product\'s evidence size limit');
});

test('SEED-02-ONLY-THE-STAGING-BUCKET-IS-ACCEPTED', () => {
  const good = {
    EVIDENCE_STORAGE_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    EVIDENCE_STORAGE_BUCKET: 's4-staging-evidence',
    EVIDENCE_STORAGE_ACCESS_KEY_ID: 'staging-key-id',
  };
  assert.equal(stagingEvidenceProblem(good, 'production-key-id'), null);
  const refuse = (env: Record<string, string>, prodKey: string | undefined, why: RegExp) =>
    assert.match(String(stagingEvidenceProblem({ ...good, ...env }, prodKey)), why);
  refuse({ EVIDENCE_STORAGE_ENDPOINT: 'https://s4-staging-evidence-disabled.invalid' }, undefined, /placeholder/);
  refuse({ EVIDENCE_STORAGE_ENDPOINT: 'http://0123.r2.cloudflarestorage.com' }, undefined, /not Cloudflare R2 over HTTPS/);
  refuse({ EVIDENCE_STORAGE_ENDPOINT: 'https://s3.amazonaws.com' }, undefined, /not Cloudflare R2/);
  refuse({ EVIDENCE_STORAGE_BUCKET: 's4-evidence-pilot' }, undefined, /PRODUCTION bucket/);
  refuse({ EVIDENCE_STORAGE_BUCKET: 'some-other-bucket' }, undefined, /must be s4-staging-evidence/);
  refuse({}, 'staging-key-id', /PRODUCTION key/);
  assert.match(String(stagingEvidenceProblem({}, undefined)), /missing/);
});

test('SEED-03-REAL-UPLOAD-WORKFLOW-ONLY', () => {
  const order = [
    "liveApi('POST', '/compliance/documents'",
    "fetch(created.upload.url, { method: 'PUT'",
    "liveApi('POST', `/compliance/documents/${created.id}/complete-upload`",
    "liveApi('PATCH', `/compliance/documents/${created.id}/verify`, ownerToken, { verified: true }",
    "liveApi('GET', `/compliance/documents/${documents[0].id}/access`",
  ].map((needle) => source.indexOf(needle));
  // For staging, evidence goes through the deployed staging API, never the in-process copy.
  assert.match(source, /const liveBase = target === 'staging' \? STAGING_API : base;/);
  assert.match(source, /const STAGING_API = 'https:\/\/security-marketplace-api-staging\.onrender\.com';/);
  assert.match(source, /includes\('FICTIONAL TEST DOCUMENT'\)/, 'retrieval must return the fictional bytes');
  order.forEach((at) => assert.ok(at > 0, 'each step is present'));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'presign, PUT, complete, verify — in that order');
  const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/fileUrl/.test(code), 'the legacy file-less path is never used');
  // The read-only --report SELECTs from guard_documents; everything else must never name the table or write SQL.
  const writing = code.slice(0, code.indexOf('async function report(')) + code.slice(code.indexOf('if (require.main === module)'));
  assert.ok(!/guard_documents|INSERT INTO/i.test(writing), 'no evidence rows are written directly');
});

test('SEED-04-DATABASE-GUARDS-ARE-PRESENT', () => {
  assert.match(source, /const STAGING_HOST = 'dpg-dbbq13afngtc73a5ls20-a\.oregon-postgres\.render\.com';/);
  assert.match(source, /target host equals the production database host/);
  assert.match(source, /Supabase \/ pooler host/);
  assert.match(source, /seed only a fresh database/);
  assert.match(source, /const EXPECTED_MIGRATIONS = 71;/);
  assert.match(source, /const LAST_MIGRATION = 'AddPatrolSweepReconciliation1720900000017';/);
  assert.match(source, /S4_STAGING_SEED_CONFIRM !== CONFIRM/);
  assert.match(source, /DATABASE_SYNCHRONIZE: 'false'/, 'the in-process app never alters the schema');
  assert.match(source, /DATABASE_POOLER_URL: ''/, 'no pooler URL can be picked up');
});

test('SEED-05-THE-SHIFT-ID-COMES-FROM-THE-REAL-POST-SHIFTS-RESPONSE', () => {
  // The contract, read from the code the controller returns: create() answers { shift, timesheet }.
  const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'shift', 'shift.service.ts'), 'utf8');
  const controller = fs.readFileSync(path.join(__dirname, '..', 'src', 'shift', 'shift.controller.ts'), 'utf8');
  assert.match(service, /return \{ shift: savedShift, timesheet \};/, 'ShiftService.create still answers { shift, timesheet }');
  assert.match(controller, /return this\.shiftService\.createForUser\(user, dto\);/);
  // That shape yields the shift; the old reading (.id on the wrapper) is exactly what is now refused.
  assert.deepEqual(createdShift({ shift: { id: 3, status: 'offered' }, timesheet: { id: 9 } }), { id: 3, status: 'offered' });
  assert.equal(({ shift: { id: 3 }, timesheet: {} } as any).id, undefined, 'the wrapper itself has no id: the 21 Oct failure');
  for (const bad of [{ id: 3, status: 'offered' }, { shift: {} }, { shift: { id: '3' } }, null, undefined]) {
    assert.throws(() => createdShift(bad), /did not return \{ shift: \{ id \} \}/, JSON.stringify(bad));
  }
  // Every POST /shifts in the seeder goes through it.
  const posts = source.match(/api\('POST', '\/shifts'/g) || [];
  const wrapped = source.match(/createdShift\(await api\('POST', '\/shifts'/g) || [];
  assert.ok(posts.length > 0 && posts.length === wrapped.length, `${wrapped.length} of ${posts.length} POST /shifts calls unwrap the response`);
});

const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const seedBody = code.slice(code.indexOf('async function seed('), code.indexOf('async function report('));

test('SEED-06-LOGINS-ARE-KEPT-AS-EACH-ACCOUNT-IS-CREATED', () => {
  // Behaviour: the file holds exactly what was passed, and only that.
  const file = path.join(os.tmpdir(), `seed-06-${process.pid}.env`);
  try {
    writeLogins(file, { UAT_OWNER_EMAIL: 'uat-owner@example.com', UAT_OWNER_PASSWORD: 'p-1' });
    writeLogins(file, { UAT_OWNER_EMAIL: 'uat-owner@example.com', UAT_OWNER_PASSWORD: 'p-1', UAT_GUARD_ALPHA_EMAIL: 'a@example.com', UAT_GUARD_ALPHA_PASSWORD: 'p-2' });
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^# S4 STAGING UAT logins/);
    assert.match(text, /UAT_OWNER_PASSWORD=p-1\n/); assert.match(text, /UAT_GUARD_ALPHA_PASSWORD=p-2\n/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'owner-only');
  } finally { fs.rmSync(file, { force: true }); }
  // Order: each password is saved right after its account is registered, before anything else can fail.
  const writes = [...seedBody.matchAll(/writeLogins\(t\.loginsFile, logins\)/g)].map((m) => m.index!);
  const registers = [...seedBody.matchAll(/await auth\.register\(/g)].map((m) => m.index!);
  assert.equal(registers.length, 2, 'owner, then the guard loop');
  assert.ok(writes.length >= 2);
  assert.ok(writes[0] > registers[0] && writes[0] < seedBody.indexOf("api('POST', '/clients'"), 'owner login saved before the first client');
  assert.ok(writes[1] > registers[1] && writes[1] < seedBody.indexOf("api('POST', '/company-guards'"), 'each guard login saved before its first link');
  assert.ok(writes[writes.length - 1] < seedBody.indexOf("api('POST', '/shifts'"), 'all saved before any shift step');
});

test('SEED-07-REDACTION-KEEPS-THE-STACK-AND-DROPS-SECRETS', () => {
  const password = 'Zq7rN3xVb2kLp9Aa1!';
  registerSecret(password);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjEsInJvbGUiOiJndWFyZCJ9.c2lnbmF0dXJlLXZhbHVl';
  const err = new Error(`login failed for body {"email":"uat-owner@example.com","password":"${password}"} via postgresql://s4_staging:pw@host/db`);
  const out = redact(`${err.stack}\nAuthorization: Bearer ${jwt}\nhttps://x.r2.cloudflarestorage.com/b/k?X-Amz-Credential=AKIA123%2F2026&X-Amz-Signature=abcdef0123&X-Amz-Expires=60\n{"accessToken":"opaque-token-value"}`);
  for (const secret of [password, jwt, 'postgresql://s4_staging:pw@host/db', 'abcdef0123', 'AKIA123', 'opaque-token-value']) {
    assert.ok(!out.includes(secret), `leaked ${secret.slice(0, 6)}…`);
  }
  assert.match(out, /^Error: login failed for body/, 'the message survives');
  assert.match(out, /\n\s+at .+staging-uat-seed\.spec\.ts:\d+:\d+/, 'stack frames survive');
  assert.match(out, /X-Amz-Expires=60/, 'non-secret query parameters survive');
  assert.match(out, /uat-owner@example\.com/, 'fictional identifiers survive');
  // And it is applied to everything printed, including the final failure stack.
  assert.match(code, /function installRedaction\(\)/);
  assert.match(code, /installRedaction\(\);\s*const t = resolveTarget\(\);/, 'installed before anything else runs');
  assert.match(code, /console\.error\('FAILED', redact\(String\(e\?\.stack/, 'the failure keeps its stack, redacted');
});

test('SEED-08-EVERY-REQUEST-TIMES-OUT-AFTER-60-SECONDS', () => {
  assert.equal(REQUEST_TIMEOUT_MS, 60_000);
  const fetches = [...code.matchAll(/await fetch\(/g)].length;
  const timed = [...code.matchAll(/signal: AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/g)].length;
  assert.ok(fetches >= 3 && fetches === timed, `${timed} of ${fetches} fetch calls carry the timeout`);
});

test('SEED-09-A-STATE-CHANGE-IS-SENT-ONCE-AND-READ-BACK-AFTER-A-FAILURE', async () => {
  const run = async (send: () => Promise<unknown>, state: string | Error) => {
    let sends = 0, reads = 0;
    const result = await confirmOnce('accept shift 4', async () => { sends += 1; return send(); },
      async () => { reads += 1; if (state instanceof Error) throw state; return state; }, 'ready').then((r) => r, (e: Error) => e);
    return { result, sends, reads };
  };
  const ok = await run(async () => ({}), 'ready');
  assert.deepEqual([ok.sends, ok.reads, (ok.result as any).outcome], [1, 0, 'done'], 'success: no read-back needed');
  // The 21 Oct case: the server committed, the response was a 500.
  const committed = await run(async () => { throw new Error('PATCH /shifts/4/respond -> 500'); }, 'ready');
  assert.deepEqual([committed.sends, committed.reads, (committed.result as any).outcome], [1, 1, 'confirmed-after-error']);
  const notCommitted = await run(async () => { throw new Error('The operation was aborted due to timeout'); }, 'offered');
  assert.equal(notCommitted.sends, 1, 'never resent');
  assert.match(String(notCommitted.result), /read-back shows "offered", not "ready" — not retried/);
  const unknown = await run(async () => { throw new Error('socket hang up'); }, new Error('read-back timed out'));
  assert.equal(unknown.sends, 1);
  assert.match(String(unknown.result), /state UNKNOWN — not retried/);
  // The seeder routes Accept and Book On through it, and nothing in it loops on a request.
  assert.match(seedBody, /confirmOnce\(`accept shift \$\{shift\.id\}[^]*?\/respond`/);
  assert.match(seedBody, /confirmOnce\(`Book On shift \$\{shift\.id\}[^]*?\/attendance\/check-in'/);
  assert.ok(!/api\('PATCH', `\/shifts\/\$\{shift\.id\}\/respond`[^)]*\);\s*$/m.test(seedBody.replace(/confirmOnce\([^]*?\);/g, '')), 'no bare Accept outside confirmOnce');
  assert.ok(!/\b(retry|retries|attempts?)\b/i.test(seedBody), 'no retry loop in the seed');
});

test('SEED-10-REPORT-IS-READ-ONLY-AND-PRINTS-NO-SECRET', () => {
  const body = code.slice(code.indexOf('async function report('), code.indexOf('if (require.main === module)'));
  assert.match(body, /BEGIN TRANSACTION READ ONLY/);
  assert.match(body, /ROLLBACK/);
  assert.ok(!/(INSERT INTO|UPDATE "?\w+"? SET|DELETE FROM|TRUNCATE|DROP |ALTER )/i.test(body), 'no write statements');
  assert.ok(!/password|storageKey|accessToken|"fileUrl"/i.test(body.replace(/values not printed/, '')), 'never selects a secret or storage key');
  // It runs before the write confirmation and before the app starts, behind the same target guard.
  const main = code.slice(code.indexOf('if (require.main === module)'));
  assert.ok(main.indexOf('if (reportOnly)') < main.indexOf('S4_STAGING_SEED_CONFIRM'), 'needs no write confirmation');
  assert.ok(main.indexOf('resolveTarget()') < main.indexOf('if (reportOnly)'), 'same staging-only target guard');
  assert.ok(!/NestFactory/.test(body), 'does not start the application');
});

test('SEED-11-RECOVERY-USES-THE-PRODUCT-RESET-FLOW-FOR-THE-FICTIONAL-ACCOUNTS-ONLY', () => {
  const body = code.slice(code.indexOf('async function recover('), code.indexOf('async function seed('));
  assert.deepEqual(UAT_ACCOUNT_EMAILS, ['uat-guard-a@example.com', 'uat-guard-b@example.com', 'uat-owner@example.com']);
  assert.ok(UAT_ACCOUNT_EMAILS.every((e) => e.endsWith('@example.com')), 'reserved, never-delivered domain');
  // Refuses unless the users are the UAT set (SEED-13), read in a READ ONLY transaction, before the app starts.
  assert.match(body, /BEGIN TRANSACTION READ ONLY/);
  assert.match(body, /const problem = recoveryUsersProblem\(users\);/);
  assert.ok(body.indexOf('recoveryUsersProblem(users)') < body.indexOf('bootApp(t)'), 'checked before the app starts');
  // Only the three UAT accounts are ever reset — never the platform administrator.
  assert.match(body, /for \(const email of \['uat-owner@example\.com', 'uat-guard-a@example\.com', 'uat-guard-b@example\.com'\]\)/);
  assert.ok(!/uat-s4-admin|UAT_PLATFORM_ADMIN_EMAIL/.test(body), 'recovery never names the platform administrator');
  // The product's own workflow: request (audited token), captured email, reset (audited, sessions revoked).
  assert.ok(body.indexOf('recovery.forgotPassword(') < body.indexOf("m.kind === 'password_reset'"));
  assert.ok(body.indexOf("m.kind === 'password_reset'") < body.indexOf('recovery.resetPassword('));
  assert.ok(!/(INSERT INTO|UPDATE |DELETE FROM|passwordHash|bcrypt)/i.test(body), 'never writes a password or row directly');
  // Saved before the sign-in proof, which goes to the deployed staging API.
  assert.ok(body.indexOf('writeLogins(t.loginsFile, logins)') < body.indexOf('`${STAGING_API}/auth/login`'));
  // Staging only, and only with its own confirmation.
  const main = code.slice(code.indexOf('if (require.main === module)'));
  assert.match(main, /if \(target !== 'staging'\) fail\('--recover-logins is for the staging UAT accounts only'\)/);
  assert.match(main, /S4_STAGING_RECOVER_CONFIRM !== RECOVER_CONFIRM/);
  assert.ok(main.indexOf('resolveTarget()') < main.indexOf('if (recoverLogins)'), 'same staging-only target guard');
});

test('SEED-12-THE-LEDGER-IS-THIS-CODE-S-OWN-HEAD-AND-NO-IN-PROCESS-TIMER-RUNS', () => {
  // The constants are exactly this repository's migration head (Migration 71 today) …
  assert.deepEqual(repositoryMigrationHead(), { count: 71, last: 'AddPatrolSweepReconciliation1720900000017' });
  // … and a migration added later moves the head, so the seeder would refuse until it is updated with it.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's4-seed-head-'));
  try {
    const real = path.join(__dirname, '..', 'src', 'database', 'migrations');
    for (const f of fs.readdirSync(real)) fs.copyFileSync(path.join(real, f), path.join(tmp, f));
    fs.writeFileSync(path.join(tmp, '1720900000999-SomethingLater.ts'), 'export class SomethingLater1720900000999 {}\n');
    assert.deepEqual(repositoryMigrationHead(tmp), { count: 72, last: 'SomethingLater1720900000999' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // One ledger check, used by both paths that boot the app, and before any write or app start.
  assert.match(code, /async function assertLedger\(c: any\)/);
  assert.match(code, /this code's migration head is/);
  const pre = code.slice(code.indexOf('async function preflight('), code.indexOf('async function bootApp('));
  assert.ok(pre.indexOf('await assertLedger(c)') > 0 && pre.indexOf('await assertLedger(c)') < pre.indexOf('select count(*)::int n from users'));
  const rec = code.slice(code.indexOf('async function recover('), code.indexOf('async function report('));
  assert.ok(rec.indexOf('await assertLedger(c)') > 0 && rec.indexOf('await assertLedger(c)') < rec.indexOf('bootApp(t)'),
    'recovery checks the ledger before it boots the app');
  // The in-process app runs no background job against the target, including the amendment expiry job.
  const boot = code.slice(code.indexOf('async function bootApp('), code.indexOf('async function recover('));
  assert.match(boot, /ShiftAmendmentService/);
  assert.match(boot, /'expiryInterval'/);
  assert.match(boot, /expiryJob\?\.stop\(\)/);
  // The report stays read only and also works on a database before Migration 64.
  const report = code.slice(code.indexOf('async function report('), code.indexOf('if (require.main === module)'));
  assert.match(report, /to_regclass\('public\.shift_amendments'\)/);
  assert.match(report, /BEGIN TRANSACTION READ ONLY/);
  assert.ok(!/INSERT|UPDATE |DELETE /i.test(report), 'no write in the report');
});

test('SEED-13-THE-ACCOUNT-ALLOWLIST-IS-THE-UAT-SET-PLUS-AT-MOST-THE-APPROVED-ADMIN', () => {
  assert.equal(UAT_PLATFORM_ADMIN_EMAIL, 'uat-s4-admin@example.com');
  const uat = [
    { email: 'uat-owner@example.com', role: 'company_admin' },
    { email: 'uat-guard-a@example.com', role: 'guard' },
    { email: 'uat-guard-b@example.com', role: 'guard' },
  ];
  const admin = { email: 'uat-s4-admin@example.com', role: 'admin' };
  // Allowed: exactly the three; the three plus the approved administrator (any case).
  assert.equal(recoveryUsersProblem(uat), null);
  assert.equal(recoveryUsersProblem([...uat, admin]), null);
  assert.equal(recoveryUsersProblem([...uat, { email: 'UAT-S4-Admin@Example.com', role: 'admin' }]), null);
  // Refused: anything else.
  assert.match(String(recoveryUsersProblem(uat.slice(1))), /not all present/, 'a missing UAT account');
  assert.match(String(recoveryUsersProblem([...uat.slice(1), admin])), /not all present/, 'the admin does not replace a UAT account');
  assert.match(String(recoveryUsersProblem([...uat, { ...admin, role: 'company_admin' }])), /non-administrator/, 'the approved email with any other role');
  assert.match(String(recoveryUsersProblem([...uat, { ...admin, role: 'guard' }])), /non-administrator/);
  assert.match(String(recoveryUsersProblem([...uat, { email: 'someone@example.com', role: 'admin' }])), /not one of the approved/, 'an arbitrary extra user, even a fictional admin');
  assert.match(String(recoveryUsersProblem([...uat, { email: 'real.person@gmail.com', role: 'guard' }])), /not one of the approved/);
  assert.match(String(recoveryUsersProblem([...uat, admin, { email: 'uat-s4-admin2@example.com', role: 'admin' }])), /not one of the approved/, 'a second, unapproved extra user');
  assert.match(String(recoveryUsersProblem([...uat, admin, admin])), /2 users besides/, 'the same administrator twice');
  assert.match(String(recoveryUsersProblem([])), /not all present/, 'an empty database is not the UAT set');
  // The seed path is unchanged: it still requires an EMPTY users table.
  assert.match(code, /seed only a fresh database/);
});

test('SEED-14-COMPANY-B-IS-ONE-APPROVED-OWNER-ADDED-THROUGH-THE-PRODUCT-ROUTES-ONLY-TO-THE-UAT-SET', () => {
  assert.equal(UAT_COMPANY_B_OWNER_EMAIL, 'uat-company-b-owner@example.com');
  const uat = [
    { email: 'uat-owner@example.com', role: 'company_admin' },
    { email: 'uat-guard-a@example.com', role: 'guard' },
    { email: 'uat-guard-b@example.com', role: 'guard' },
  ];
  const admin = { email: 'uat-s4-admin@example.com', role: 'admin' };
  const ownerB = { email: 'uat-company-b-owner@example.com', role: 'company_admin' };
  // The allowlist: the UAT set plus at most the admin and at most the Company B owner, each with exactly its role.
  assert.equal(recoveryUsersProblem([...uat, ownerB]), null);
  assert.equal(recoveryUsersProblem([...uat, admin, ownerB]), null);
  assert.equal(recoveryUsersProblem([...uat, admin, { ...ownerB, email: 'UAT-Company-B-Owner@Example.com' }]), null);
  assert.match(String(recoveryUsersProblem([...uat, admin, ownerB, ownerB])), /3 users besides.*more than once/, 'the Company B owner twice');
  assert.match(String(recoveryUsersProblem([...uat, { ...ownerB, role: 'admin' }])), /non-owner/, 'the approved email as a platform admin');
  assert.match(String(recoveryUsersProblem([...uat, { ...ownerB, role: 'guard' }])), /non-owner/);
  assert.match(String(recoveryUsersProblem([...uat, admin, ownerB, { email: 'uat-company-c-owner@example.com', role: 'company_admin' }])), /not one of the approved/, 'a third company owner');
  assert.match(String(recoveryUsersProblem([admin, ownerB])), /not all present/, 'Company B never replaces the UAT set');

  // Preflight: only the UAT set with exactly one company and no Company B yet.
  const ok = { users: [...uat, admin], companies: 1, companyIds: [1] };
  assert.equal(companyBPreflightProblem(ok), null);
  assert.equal(companyBPreflightProblem({ ...ok, users: uat }), null, 'without the admin too');
  assert.match(String(companyBPreflightProblem({ ...ok, users: [...uat, admin, ownerB], companies: 2, companyIds: [1, 2] })), /already exists/, 'never twice');
  assert.match(String(companyBPreflightProblem({ ...ok, companies: 2, companyIds: [1, 2] })), /exactly 1 company/, 'an unexpected second company');
  assert.match(String(companyBPreflightProblem({ ...ok, companies: 0, companyIds: [] })), /exactly 1 company/);
  assert.match(String(companyBPreflightProblem({ ...ok, users: [...uat, { email: 'someone@example.com', role: 'guard' }] })), /not the approved staging set/);
  assert.match(String(companyBPreflightProblem({ ...ok, users: [] })), /not the approved staging set/, 'an empty database');

  // Fictional data only.
  assert.match(COMPANY_B.companyName, /^UAT /);
  assert.match(COMPANY_B.contactDetails, /@example\.com$/);
  assert.match(COMPANY_B.address, /ZZ99 9ZZ/);

  // The mode: its own confirmation, product HTTP routes under the strict pipe, login saved before verification, the
  // deployed API proves sign-in, the result is read back; it returns before the seed path and never toggles Patrols.
  const body = code.slice(code.indexOf('async function companyB('), code.indexOf('async function report('));
  assert.ok(body.length > 0);
  assert.match(code, /S4_STAGING_COMPANY_B_CONFIRM !== COMPANY_B_CONFIRM/);
  assert.match(code, /const COMPANY_B_CONFIRM = 's4-staging-company-b';/);
  assert.notEqual('s4-staging-company-b', 's4-staging-db', 'its own confirmation, not the seed one');
  assert.match(body, /companyBPreflightProblem\(before\)/);
  assert.ok(body.indexOf('companyBPreflightProblem(before)') < body.indexOf('bootApp(t)'), 'checked before the app starts');
  assert.ok(body.indexOf('existsSync(loginsFile)') < body.indexOf('bootApp(t)'), 'an existing logins file is never overwritten');
  assert.match(body, /new ValidationPipe\(\{ whitelist: true, transform: true, forbidNonWhitelisted: true \}\)/);
  assert.match(body, /post\(base, '\/auth\/register'/);
  assert.match(body, /post\(base, '\/auth\/verify-email'/);
  assert.doesNotMatch(body, /auth\.register\(|AuthService/, 'never the service directly: the HTTP route with its validation');
  assert.ok(body.indexOf('writeLogins(loginsFile') < body.indexOf("'/auth/verify-email'"), 'login saved before verification');
  assert.match(body, /post\(liveBase, '\/auth\/login'/);
  assert.match(body, /companyBId === companyA/);
  assert.match(body, /readCompanyBState\(t\);\r?\n  const afterProblem/);
  assert.doesNotMatch(body, /"patrolsEnabled"\s*=|\/admin\/patrols|'PUT'/, 'it never switches Patrols on');
  // The in-process app runs no patrol timer either (only the deployed staging service sweeps).
  assert.match(code, /app\.get\(PatrolSweepService\) as any, app\.get\(PatrolEvidenceMaintenanceService\) as any\]\) svc\.onModuleDestroy\(\);/);
  assert.doesNotMatch(body, /\bdelete\b|DELETE|update |UPDATE /i, 'it never deletes or updates rows itself');
  assert.match(code, /path\.join\(SECRETS, 'staging-patrol-probe\.env'\)/);
  const main = code.slice(code.indexOf('if (addCompanyB) {'));
  assert.ok(main.indexOf('return;') < main.indexOf('await seed(t)'), 'the mode returns before the seed path');
});

queue.then(
  () => console.log(`\n${passed} staging UAT seeder checks passed`),
  (error) => { console.error(error); process.exit(1); },
);
