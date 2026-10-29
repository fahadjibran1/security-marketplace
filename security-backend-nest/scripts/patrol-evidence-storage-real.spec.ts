/**
 * Patrol evidence storage (P1-C) — provider certification against a REAL S3-compatible bucket (Cloudflare R2, AWS S3,
 * MinIO, SeaweedFS…). Not part of the release gate (CI has no bucket): run it against the NON-production patrol bucket
 * before the feature is switched on. It writes only synthetic objects under a synthetic company id (999999) and deletes
 * them afterwards. It never prints a URL, a signature or a credential. Every check runs and is reported; the run fails at
 * the end if any did.
 *
 *   PSR-1  presigned PUT with the signed Content-Type, Content-Length and x-amz-checksum-sha256 stores the object
 *   PSR-2a the provider refuses a body that does not match the signed x-amz-checksum-sha256. If it does NOT (some
 *          providers ignore the header), the server-side SHA-256 check in PatrolEvidenceLifecycleService still rejects
 *          and quarantines such an upload — but record the result: the provider-side guarantee is absent
 *   PSR-2b the provider refuses a Content-Type other than the signed one
 *   PSR-3  HEAD reports the exact size and type; GET streams the exact bytes
 *   PSR-4  server-side COPY (x-amz-copy-source) works and DELETE is idempotent (404 tolerated)
 *   PSR-5  a download link is short-lived, exact-object and served as an attachment of the stored type
 *          (response-content-type / response-content-disposition)
 *   PSR-6  tampered signatures, unsigned URLs and anonymous listing are refused (the bucket is private)
 *
 * Run: PATROL_EVIDENCE_STORAGE_ENDPOINT=… PATROL_EVIDENCE_STORAGE_BUCKET=… PATROL_EVIDENCE_STORAGE_ACCESS_KEY_ID=… \
 *      PATROL_EVIDENCE_STORAGE_SECRET_ACCESS_KEY=… [PATROL_EVIDENCE_STORAGE_REGION=auto] npm run test:patrol-evidence-storage
 * The token needs Object Read & Write on that bucket only (no ListBucket, no admin).
 */
import { createHash } from 'node:crypto';
import { PatrolObjectStore, readPatrolStorageConfig } from '../src/patrol/evidence/patrol-object-store';
import { patrolObjectKey, siblingKey } from '../src/patrol/evidence/patrol-evidence-keys';
import { jpeg } from './fixtures/patrol-test-images';

const config = readPatrolStorageConfig();
if (!config.ok) throw new Error(`patrol evidence storage is not configured: ${config.reason}`);
const settings = config.config;
const store = new PatrolObjectStore();
const SYNTHETIC_COMPANY = 999_999;
const created = new Set<string>();
const failed: string[] = [];
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function check(id: string, what: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn();
    console.log(`PASS ${id} ${what}${note ? ` (${note})` : ''}`);
  } catch (error) {
    failed.push(id);
    console.log(`FAIL ${id} ${what}: ${String((error as Error)?.message ?? error).replace(/https?:\/\/\S+/g, '[url]')}`);
  }
}
function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** The security property is that the object is not served (R2 answers 400 to some unsigned requests, S3 / MinIO 403). */
async function refused(label: string, target: string | URL, marker: string) {
  const res = await fetch(target);
  const text = await res.text();
  must(!res.ok, `${label}: expected a refusal, got ${res.status}`);
  must(!text.includes(marker), `${label}: the response leaked object content`);
}

async function main() {
  const image = jpeg({ nonce: `psr-${Date.now()}` });
  const marker = image.subarray(image.length - 40, image.length - 20).toString('latin1');
  const key = patrolObjectKey('evidence', SYNTHETIC_COMPANY, new Date(), settings.prefix);
  const incoming = siblingKey(key, 'incoming');

  await check('PSR-1', 'presigned PUT with signed type, length and checksum stores the object', async () => {
    const upload = store.presignUpload(incoming, { contentType: 'image/jpeg', sizeBytes: image.length, sha256Hex: sha(image) });
    const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: new Uint8Array(image) });
    must(put.status === 200, `signed PUT failed (${put.status})`);
    created.add(incoming);
  });

  await check('PSR-2a', 'a body that does not match the signed checksum is refused by the provider', async () => {
    const probe = siblingKey(patrolObjectKey('evidence', SYNTHETIC_COMPANY, new Date(), settings.prefix), 'incoming');
    const upload = store.presignUpload(probe, { contentType: 'image/jpeg', sizeBytes: image.length, sha256Hex: sha(image) });
    const wrong = Buffer.from(image);
    wrong[wrong.length - 3] ^= 0xff;
    const res = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: new Uint8Array(wrong) });
    if (res.ok) created.add(probe);
    must(!res.ok, `the provider ACCEPTED a mismatched body (${res.status}); the server-side hash check is the only integrity guarantee here`);
  });

  await check('PSR-2b', 'a Content-Type other than the signed one is refused', async () => {
    const probe = siblingKey(patrolObjectKey('evidence', SYNTHETIC_COMPANY, new Date(), settings.prefix), 'incoming');
    const upload = store.presignUpload(probe, { contentType: 'image/jpeg', sizeBytes: image.length, sha256Hex: sha(image) });
    const res = await fetch(upload.url, { method: 'PUT', headers: { ...upload.headers, 'Content-Type': 'text/html' }, body: new Uint8Array(image) });
    if (res.ok) created.add(probe);
    must(!res.ok, `a tampered Content-Type was accepted (${res.status})`);
  });

  await check('PSR-3', 'HEAD reports the exact size and type; GET streams the exact bytes', async () => {
    const head = await store.head(incoming);
    must(head.exists && head.size === image.length, 'HEAD size');
    must(head.exists && head.contentType === 'image/jpeg', `HEAD type ${head.exists ? head.contentType : ''}`);
    const chunks: Buffer[] = [];
    for await (const c of await store.getStream(incoming)) chunks.push(c as Buffer);
    must(sha(Buffer.concat(chunks)) === sha(image), 'GET bytes');
  });

  await check('PSR-4', 'server-side copy and idempotent delete', async () => {
    await store.copy(incoming, key);
    created.add(key);
    const copied = await store.head(key);
    must(copied.exists && copied.size === image.length, 'copy');
    await store.delete(incoming);
    created.delete(incoming);
    await store.delete(incoming);
    must(!(await store.head(incoming)).exists, 'deleted');
  });

  let linkUrl = '';
  await check('PSR-5', 'a download link is short-lived, exact-object, an attachment of the stored type', async () => {
    const link = store.presignDownload(key, { contentType: 'image/jpeg', fileName: 'patrol-evidence-1.jpg' });
    linkUrl = link.url;
    const expires = Number(new URL(link.url).searchParams.get('X-Amz-Expires'));
    must(expires >= 60 && expires <= 300, `lifetime ${expires}`);
    const got = await fetch(link.url);
    must(got.status === 200, `GET ${got.status}`);
    must(got.headers.get('content-type') === 'image/jpeg', `content-type ${got.headers.get('content-type')}`);
    must((got.headers.get('content-disposition') ?? '').startsWith('attachment'), 'content-disposition override not honoured');
    must(sha(Buffer.from(await got.arrayBuffer())) === sha(image), 'bytes');
    return `${expires}s`;
  });

  await check('PSR-6', 'tampered signatures, unsigned URLs and anonymous listing are refused', async () => {
    must(linkUrl, 'no link from PSR-5');
    const u = new URL(linkUrl);
    const tampered = new URL(linkUrl);
    tampered.searchParams.set('X-Amz-Signature', '0'.repeat(64));
    await refused('tampered signature', tampered, marker);
    await refused('unsigned URL', `${u.origin}${u.pathname}`, marker);
    await refused('anonymous listing', `${u.origin}/${settings.bucket}`, marker);
  });

  console.log(JSON.stringify({ event: 'patrol_evidence_storage_real', endpointHost: settings.endpoint.host, region: settings.region, failed }));
}

async function cleanup() {
  for (const key of created) await store.delete(key).catch(() => console.log('NOTE a synthetic object under company 999999 was left; delete it manually'));
}

main()
  .then(cleanup)
  .then(() => process.exit(failed.length ? 1 : 0))
  .catch(async (error) => {
    await cleanup().catch(() => undefined);
    console.error(String(error?.stack ?? error).replace(/https?:\/\/\S+/g, '[url]'));
    process.exit(1);
  });
