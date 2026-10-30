/**
 * The pure parts of scripts/staging-patrol-evidence-probe.cjs: the target lock, the storage-URL guard, key parsing,
 * redaction, credential-file placement and argument parsing. No network, no database.
 *
 *   node scripts/staging-patrol-evidence-probe.spec.cjs
 */
'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const probe = require('./staging-patrol-evidence-probe.cjs');

let passed = 0;
const failed = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`FAIL  ${name}\n      ${String(error && error.message).replace(/https?:\/\/\S+/g, '[url]')}`);
  }
}
const refuses = (fn, pattern) => assert.throws(fn, (e) => /^REFUSED/.test(e.message) && (!pattern || pattern.test(e.message)));

const STAGING = 'https://security-marketplace-api-staging.onrender.com';
const staging = { kind: 'staging', origin: STAGING };
const local = { kind: 'local', origin: 'http://127.0.0.1:3999' };
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const signed = (host, keyPath, extra = '') => `https://${host}/s4-staging-patrol/${keyPath}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261030%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261030T120000Z&X-Amz-Expires=120&X-Amz-SignedHeaders=host&X-Amz-Signature=${'a'.repeat(64)}${extra}`;

// ── target lock ──
test('default, "staging" and the exact staging origin resolve to staging', () => {
  for (const arg of [undefined, '', 'staging', STAGING, `${STAGING}/`]) assert.deepEqual(probe.resolveTarget(arg), staging);
});
test('production API is refused by name', () => {
  refuses(() => probe.resolveTarget('https://security-marketplace-api.onrender.com'), /PRODUCTION/);
  refuses(() => probe.resolveTarget('local=https://security-marketplace-api.onrender.com'), /PRODUCTION/);
});
test('every sfour.co.uk host is refused', () => {
  for (const h of ['https://sfour.co.uk', 'https://api.sfour.co.uk', 'https://www.sfour.co.uk', 'local=https://app.sfour.co.uk']) refuses(() => probe.resolveTarget(h), /sfour/);
});
test('any other host, look-alike or scheme is refused', () => {
  for (const h of ['https://security-marketplace-api-staging.onrender.com.evil.example', 'http://security-marketplace-api-staging.onrender.com',
    'https://example.com', 'https://security-marketplace-api-staging2.onrender.com', 'ftp://127.0.0.1', 'not a url']) {
    refuses(() => probe.resolveTarget(h));
  }
});
test('the staging origin with a path, query or credentials is refused', () => {
  for (const h of [`${STAGING}/patrols`, `${STAGING}/?x=1`, 'https://u:p@security-marketplace-api-staging.onrender.com']) refuses(() => probe.resolveTarget(h));
});
test('local= accepts only 127.0.0.1 / localhost origins', () => {
  assert.deepEqual(probe.resolveTarget('local=http://127.0.0.1:3999'), local);
  assert.deepEqual(probe.resolveTarget('local=http://localhost:3000'), { kind: 'local', origin: 'http://localhost:3000' });
  for (const h of ['local=http://10.0.0.5:3000', 'local=http://192.168.1.2', `local=${STAGING}`, 'local=http://127.0.0.1:3999/api', 'local=http://[::2]:80']) refuses(() => probe.resolveTarget(h));
  refuses(() => probe.resolveTarget('http://127.0.0.1:3999'), /only remote target/);
});

// ── storage URL guard ──
test('a staging presigned URL to the patrol bucket is accepted and parsed (company, area, ttl, key hash)', () => {
  const d = probe.assertBucketUrl(signed('acc0123.r2.cloudflarestorage.com', `patrol-incoming/42/2026/10/${UUID}`), staging);
  assert.equal(d.bucket, 's4-staging-patrol');
  assert.equal(d.area, 'patrol-incoming');
  assert.equal(d.companyId, 42);
  assert.equal(d.expiresSeconds, 120);
  assert.match(d.keyHash, /^[0-9a-f]{12}$/);
  const withPrefix = probe.describeObjectUrl(signed('acc0123.r2.cloudflarestorage.com', `staging/patrol/7/2026/10/${UUID}`));
  assert.equal(withPrefix.prefix, 'staging');
  assert.equal(withPrefix.area, 'patrol');
  assert.equal(withPrefix.companyId, 7);
  assert.equal(probe.describeObjectUrl(signed('h.example', 'compliance/guard/1/x')).area, null);
});
test('storage URLs at the API, production, sfour.co.uk, the production bucket, http or another bucket are refused', () => {
  refuses(() => probe.assertBucketUrl(`${STAGING}/s4-staging-patrol/patrol/1/2026/10/${UUID}`, staging), /API itself/);
  refuses(() => probe.assertBucketUrl(signed('security-marketplace-api.onrender.com', `patrol/1/2026/10/${UUID}`), staging), /production/);
  refuses(() => probe.assertBucketUrl(signed('files.sfour.co.uk', `patrol/1/2026/10/${UUID}`), staging), /sfour/);
  refuses(() => probe.assertBucketUrl(signed('acc.r2.cloudflarestorage.com', `x`).replace('/s4-staging-patrol/', '/s4-evidence-pilot/'), staging), /PRODUCTION evidence bucket/);
  refuses(() => probe.assertBucketUrl(signed('acc.r2.cloudflarestorage.com', `patrol/1/2026/10/${UUID}`).replace('https:', 'http:'), staging), /not https/);
  refuses(() => probe.assertBucketUrl(signed('acc.r2.cloudflarestorage.com', `patrol/1/2026/10/${UUID}`), staging, 'other-bucket'), /expect-bucket/);
  assert.equal(probe.assertBucketUrl(signed('acc.r2.cloudflarestorage.com', `patrol/1/2026/10/${UUID}`), staging, 's4-staging-patrol').bucket, 's4-staging-patrol');
});
test('local rehearsal accepts a local http store but never a remote http one', () => {
  const localUrl = `http://127.0.0.1:4555/b/patrol/1/2026/10/${UUID}?X-Amz-Expires=60&X-Amz-Signature=${'b'.repeat(64)}`;
  assert.equal(probe.assertBucketUrl(localUrl, local).bucket, 'b');
  refuses(() => probe.assertBucketUrl(localUrl.replace('127.0.0.1:4555', 'example.com'), local), /local or https/);
});

// ── redaction ──
test('redaction removes URLs, query strings, signatures, tokens, database URLs, emails and registered secrets', () => {
  probe.registerSecret('Pa55word-not-real');
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjEsImVtYWlsIjoieCJ9.c2lnbmF0dXJlLXZhbHVl';
  const text = [
    `PUT ${signed('acc.r2.cloudflarestorage.com', `patrol/1/2026/10/${UUID}`)} failed`,
    'X-Amz-Signature=deadbeef&X-Amz-Credential=AKID/2026',
    'postgresql://user:secret@db.example:5432/s4',
    `authorization: Bearer ${jwt}`,
    `token ${jwt}`,
    'login uat-owner@example.com with Pa55word-not-real',
    `key staging/patrol-quarantine/12/2026/10/${UUID}`,
    'You cannot Book On for this shift: compliance. Contact UAT Test Security Ltd to resolve it.',
  ].join('\n');
  const red = probe.redact(text);
  for (const leak of ['https://', 'X-Amz-Signature=deadbeef', 'AKID', 'postgresql://', 'secret@', jwt, 'uat-owner@example.com', 'Pa55word-not-real', UUID, 'UAT Test Security Ltd']) {
    assert.ok(!red.includes(leak), `leaked ${leak.slice(0, 20)}`);
  }
  assert.ok(red.includes('patrol-quarantine/12/2026/10/<id>'), 'key structure kept, id removed');
});
test('names seen in responses are registered and redacted', () => {
  probe.registerNamesIn({ items: [{ siteName: 'UAT Test Site Unit 1', guardName: 'Test Guard Alpha', id: 5 }], contactEmail: 'ops@example.com' });
  const red = probe.redact('site UAT Test Site Unit 1 guard Test Guard Alpha id 5');
  assert.ok(!red.includes('UAT Test Site Unit 1') && !red.includes('Test Guard Alpha') && red.includes('id 5'));
});

// ── credentials and arguments ──
test('a staging credentials file must live in ~/.s4-pilot-secrets; local allows any existing file', () => {
  const tmp = path.join(os.tmpdir(), `probe-spec-${process.pid}.env`);
  fs.writeFileSync(tmp, 'UAT_OWNER_EMAIL=x\n');
  try {
    assert.match(probe.credentialFileProblem(tmp, staging), /not inside/);
    assert.equal(probe.credentialFileProblem(tmp, local), null);
    assert.match(probe.credentialFileProblem(path.join(os.tmpdir(), 'missing-probe.env'), local), /does not exist/);
    assert.deepEqual(probe.readEnvFile(tmp), { UAT_OWNER_EMAIL: 'x' });
  } finally {
    fs.unlinkSync(tmp);
  }
});
test('arguments: --plan or --run (not both), ids are positive integers, unknown flags refused', () => {
  assert.equal(probe.parseArgs(['--plan']).mode, 'plan');
  const o = probe.parseArgs(['--run', '--target', 'local=http://127.0.0.1:1', '--shift-id', '12', '--expect-bucket', 'b']);
  assert.equal(o.mode, 'run');
  assert.equal(o.shiftId, 12);
  assert.equal(o.expectBucket, 'b');
  for (const bad of [[], ['--plan', '--run'], ['--run', '--shift-id', '0'], ['--run', '--nope'], ['--run', '--target']]) assert.throws(() => probe.parseArgs(bad));
});
test('the synthetic JPEG is labelled fictional, unique per call and a well-formed JPEG', () => {
  const a = probe.jpeg();
  const b = probe.jpeg();
  assert.ok(a[0] === 0xff && a[1] === 0xd8 && a[a.length - 2] === 0xff && a[a.length - 1] === 0xd9);
  assert.ok(a.toString('latin1').includes('S4 PROBE - fictional'));
  assert.notDeepEqual(a, b);
  assert.equal(a.length, b.length);
});
test('every planned check id is unique', () => {
  const ids = probe.PLAN.map(([id]) => id);
  assert.equal(new Set(ids).size, ids.length);
});

console.log(`${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
