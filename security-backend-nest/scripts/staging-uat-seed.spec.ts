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
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fictionalPdf, stagingEvidenceProblem } from './staging-uat-seed';

let passed = 0;
const test = (id: string, fn: () => void) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
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
    "api('POST', '/compliance/documents'",
    "fetch(created.upload.url, { method: 'PUT'",
    '/complete-upload`',
    "/verify`, ownerToken, { verified: true }",
  ].map((needle) => source.indexOf(needle));
  order.forEach((at) => assert.ok(at > 0, 'each step is present'));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'presign, PUT, complete, verify — in that order');
  const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/fileUrl/.test(code), 'the legacy file-less path is never used');
  assert.ok(!/guard_documents|INSERT INTO/i.test(code), 'no evidence rows are written directly');
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

console.log(`\n${passed} staging UAT seeder checks passed`);
