/**
 * Private evidence storage — provider contract certification against a REAL S3-compatible bucket.
 *
 * Runs the production S3CompatibleEvidenceStorageService (SigV4 presigned URLs) against whatever bucket the
 * EVIDENCE_STORAGE_* environment points at, and proves the storage behaviour the compliance workflow relies on.
 * Use it for any bucket before it is trusted with evidence: a disposable MinIO for CI/dev, and the hosted
 * non-production bucket before the pilot deploy. It writes ONLY clearly synthetic objects and deletes them afterwards.
 *
 *   STORE-1  signed PUT stores the object; a tampered Content-Type is refused
 *   STORE-2  verifyUpload accepts the exact size/type and rejects a mismatch and a missing object
 *   STORE-3  signed GET returns the exact bytes; the URL is short-lived (X-Amz-Expires <= 300) and exact-object
 *   STORE-4  a tampered signature and the unsigned (permanent) URL are refused — the bucket is private
 *   STORE-5  URLs for one object cannot read another object
 *   STORE-6  signed URLs expire (only when EVIDENCE_STORAGE_TEST_WAIT_EXPIRY=true, waits the URL lifetime)
 *
 * Run: EVIDENCE_STORAGE_ENDPOINT=... EVIDENCE_STORAGE_REGION=... EVIDENCE_STORAGE_BUCKET=... \
 *      EVIDENCE_STORAGE_ACCESS_KEY_ID=... EVIDENCE_STORAGE_SECRET_ACCESS_KEY=... npm run test:evidence-storage
 * The credential needs GetObject/PutObject/DeleteObject on the bucket only (no ListBucket).
 * DeleteObject is used to clean up; if the credential lacks it the spec reports the leftover keys instead of failing.
 */
import { createHash, randomUUID } from 'node:crypto';
import { equal, ok, rejects } from 'node:assert/strict';
import { S3CompatibleEvidenceStorageService } from '../src/compliance/evidence-storage.service';

for (const key of [
  'EVIDENCE_STORAGE_ENDPOINT',
  'EVIDENCE_STORAGE_REGION',
  'EVIDENCE_STORAGE_BUCKET',
  'EVIDENCE_STORAGE_ACCESS_KEY_ID',
  'EVIDENCE_STORAGE_SECRET_ACCESS_KEY',
]) {
  if (!process.env[key]?.trim()) throw new Error(`${key} is required (a non-production evidence bucket)`);
}

const storage = new S3CompatibleEvidenceStorageService();
const runId = randomUUID();
const keyFor = () => `compliance/guard/999999/${randomUUID()}`; // synthetic owner namespace 999999
const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const synthetic = (label: string) =>
  Buffer.from(`%PDF-1.4\n% SYNTHETIC EVIDENCE-STORAGE CERTIFICATION OBJECT ${label} ${runId} - not real evidence\n%%EOF\n`);
const created: Array<{ key: string; mimeType: string }> = [];

async function put(key: string, body: Buffer, mimeType = 'application/pdf') {
  const upload = await storage.createSignedUploadUrl({ key, mimeType, originalFileName: 'synthetic.pdf' });
  const res = await fetch(upload.url, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: new Uint8Array(body) });
  if (res.ok) created.push({ key, mimeType });
  return { upload, res };
}

async function main() {
  const objectA = keyFor();
  const bodyA = synthetic('A');

  // STORE-1
  const { upload, res } = await put(objectA, bodyA);
  ok(res.ok, `signed PUT must succeed, got ${res.status}`);
  const bad = await fetch(upload.url, { method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: new Uint8Array(bodyA) });
  equal(bad.status, 403, 'a PUT with a different Content-Type must be refused (Content-Type is a signed header)');
  console.log('PASS STORE-1 signed PUT stores the object; tampered Content-Type refused');

  // STORE-2
  await storage.verifyUpload({ key: objectA, mimeType: 'application/pdf', originalFileName: 'x.pdf' }, bodyA.length);
  await rejects(
    () => storage.verifyUpload({ key: objectA, mimeType: 'application/pdf', originalFileName: 'x.pdf' }, bodyA.length + 1),
    /does not match/,
  );
  await rejects(
    () => storage.verifyUpload({ key: objectA, mimeType: 'image/png', originalFileName: 'x.png' }, bodyA.length),
    /does not match/,
  );
  await rejects(
    () => storage.verifyUpload({ key: keyFor(), mimeType: 'application/pdf', originalFileName: 'x.pdf' }, 10),
    /not available/,
  );
  console.log('PASS STORE-2 verifyUpload accepts exact size/type; rejects size, type and missing-object mismatches');

  // STORE-3
  const download = await storage.createSignedDownloadUrl({ key: objectA, mimeType: 'application/pdf', originalFileName: 'x.pdf' });
  const expires = Number(new URL(download.url).searchParams.get('X-Amz-Expires'));
  ok(expires >= 60 && expires <= 300, `signed URL lifetime must be 60-300s, got ${expires}`);
  equal(download.method, 'GET');
  const got = await fetch(download.url);
  equal(got.status, 200);
  equal(sha(Buffer.from(await got.arrayBuffer())), sha(bodyA), 'downloaded bytes must equal the uploaded bytes');
  console.log(`PASS STORE-3 signed GET returns the exact bytes (lifetime ${expires}s)`);

  // STORE-4
  const url = new URL(download.url);
  const tampered = new URL(download.url);
  tampered.searchParams.set('X-Amz-Signature', '0'.repeat(64));
  ok([401, 403].includes((await fetch(tampered)).status), 'tampered signature must be refused');
  ok([401, 403].includes((await fetch(`${url.origin}${url.pathname}`)).status), 'the permanent unsigned URL must not be readable');
  console.log('PASS STORE-4 tampered signature and unsigned permanent URL are refused (private bucket)');

  // STORE-5 — a signature for object A is not valid for object B
  const objectB = keyFor();
  await put(objectB, synthetic('B'));
  const cross = new URL(download.url);
  cross.pathname = cross.pathname.replace(objectA, objectB);
  ok([401, 403].includes((await fetch(cross)).status), 'a signed URL must be exact-object');
  console.log('PASS STORE-5 signed URLs are exact-object');

  // STORE-6 (optional, slow)
  if (process.env.EVIDENCE_STORAGE_TEST_WAIT_EXPIRY === 'true') {
    await new Promise((resolve) => setTimeout(resolve, (expires + 5) * 1000));
    ok([401, 403].includes((await fetch(download.url)).status), 'an expired signed URL must be refused');
    console.log('PASS STORE-6 signed URL expires');
  }

  console.log(JSON.stringify({ event: 'evidence_storage_real_certified', bucketHost: new URL(process.env.EVIDENCE_STORAGE_ENDPOINT!).host }));
}

async function cleanup() {
  const leftovers: string[] = [];
  for (const { key, mimeType } of created) {
    try {
      // The product only issues GET/PUT/HEAD URLs; reuse its signer for a DELETE so cleanup needs no extra credential.
      const signed = (storage as unknown as { sign: (method: string, object: object) => { url: string } }).sign('DELETE', {
        key,
        mimeType,
        originalFileName: 'synthetic.pdf',
      });
      const res = await fetch(signed.url, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) leftovers.push(key);
    } catch {
      leftovers.push(key);
    }
  }
  if (leftovers.length) console.log(`NOTE synthetic objects left in the bucket (delete manually): ${leftovers.join(', ')}`);
}

main()
  .then(cleanup)
  .catch(async (error) => {
    await cleanup().catch(() => undefined);
    console.error(error);
    process.exit(1);
  });
