/**
 * Safety checks for scripts/staging-uat-seed.ts (staging UAT data, 20 Oct 2026). No database, network or bucket:
 * the seeder's evidence decisions are executed directly and its upload sequence is read from source.
 *
 *   SEED-01  the fictional PDF is a well-formed PDF (every xref offset lands on its object) and says FICTIONAL
 *   SEED-02  the evidence guard refuses the placeholder, non-R2/HTTP endpoints, the production bucket, any other
 *            bucket and the production key; it accepts only the staging bucket
 *   SEED-03  documents go through the real workflow in order (presign -> PUT bytes -> complete-upload -> verify)
 *            and the file-less legacy path (fileUrl) is never used
 *   SEED-04  the database guards are present: staging host only, production host refused, empty target, ledger 63
 *   SEED-05  the shift id is read from the real POST /shifts response ({ shift, timesheet }); the 21 Oct staging seed
 *            stopped at /shifts/undefined/respond because the old code read .id off the wrapper
 *   SEED-06  logins are written as each account is created, before any later step (the 21 Oct runs lost them)
 *   SEED-07  redaction keeps the error and its stack frames but never a password, token, key, URL or signature
 *   SEED-08  every HTTP request carries a 60 s timeout
 *   SEED-09  a state-changing request is sent once; after a failure the state is read back, never resent
 *   SEED-10  --report is read only, needs no confirmation, and prints no secret
 *   SEED-11  --recover-logins touches only the 3 fictional accounts, only through the product's reset workflow,
 *            saves each login before the next step and proves it on the deployed staging API
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  confirmOnce, createdShift, fictionalPdf, redact, registerSecret, REQUEST_TIMEOUT_MS, stagingEvidenceProblem, UAT_ACCOUNT_EMAILS, writeLogins,
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
  assert.match(source, /const EXPECTED_MIGRATIONS = 63;/);
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
  // Refuses unless the users are exactly those three, read in a READ ONLY transaction, before the app starts.
  assert.match(body, /BEGIN TRANSACTION READ ONLY/);
  assert.match(body, /JSON\.stringify\(emails\) !== JSON\.stringify\(UAT_ACCOUNT_EMAILS\)/);
  assert.ok(body.indexOf('UAT_ACCOUNT_EMAILS') < body.indexOf('bootApp(t)'), 'checked before the app starts');
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

queue.then(
  () => console.log(`\n${passed} staging UAT seeder checks passed`),
  (error) => { console.error(error); process.exit(1); },
);
