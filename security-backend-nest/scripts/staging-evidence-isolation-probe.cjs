/**
 * Proves the STAGING evidence key cannot touch PRODUCTION evidence (staging UAT, 20 Oct 2026).
 *
 * Uses only the staging key from ~/.s4-pilot-secrets/staging-render.env. Against the production bucket it sends
 * READ-ONLY requests (list, HEAD, GET of a random non-existent key) and requires every one to be denied with no
 * object data returned. It never sends PUT or DELETE to production. Against the staging bucket it checks the same
 * key can list, so a "denied" result is not just a broken key. Prints statuses only, never keys or URLs.
 *
 *   node scripts/staging-evidence-isolation-probe.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, createHmac, randomUUID } = require('crypto');

const STAGING_BUCKET = 's4-staging-evidence';
const PRODUCTION_BUCKET = 's4-evidence-pilot';

const env = {};
for (const line of fs.readFileSync(path.join(os.homedir(), '.s4-pilot-secrets', 'staging-render.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim();
}
const endpoint = new URL(env.EVIDENCE_STORAGE_ENDPOINT || 'https://missing.invalid');
if (!endpoint.hostname.endsWith('.r2.cloudflarestorage.com')) { console.error('REFUSED: staging evidence endpoint is not R2 (still the placeholder?)'); process.exit(2); }
if (env.EVIDENCE_STORAGE_BUCKET !== STAGING_BUCKET) { console.error(`REFUSED: staging bucket must be ${STAGING_BUCKET}`); process.exit(2); }

const enc = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (k, v) => createHmac('sha256', k).update(v).digest();

/** A SigV4 query-signed URL, path-style, exactly as the backend signs (region from staging env, normally "auto"). */
function presign(method, bucket, key, extra = {}) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const region = env.EVIDENCE_STORAGE_REGION || 'auto';
  const scope = `${date}/${region}/s3/aws4_request`;
  const uri = `/${enc(bucket)}${key ? `/${key.split('/').map(enc).join('/')}` : ''}`;
  const query = {
    ...extra,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${env.EVIDENCE_STORAGE_ACCESS_KEY_ID}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '60',
    'X-Amz-SignedHeaders': 'host',
  };
  const cq = Object.entries(query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
  const canonical = `${method}\n${uri}\n${cq}\nhost:${endpoint.host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const sts = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`;
  const key2 = hmac(hmac(hmac(hmac(`AWS4${env.EVIDENCE_STORAGE_SECRET_ACCESS_KEY}`, date), region), 's3'), 'aws4_request');
  return `${endpoint.origin}${uri}?${cq}&X-Amz-Signature=${createHmac('sha256', key2).update(sts).digest('hex')}`;
}

async function attempt(label, method, bucket, key, extra) {
  const res = await fetch(presign(method, bucket, key, extra), { method });
  const body = method === 'HEAD' ? '' : await res.text();
  const leaked = res.ok || /<Contents>|<Key>/.test(body);
  return { label, status: res.status, code: (/<Code>([^<]+)<\/Code>/.exec(body) || [])[1] || '', leaked };
}

(async () => {
  const random = `compliance/guard/999999/${randomUUID()}`;
  const control = await attempt('staging bucket: list (control, must work)', 'GET', STAGING_BUCKET, '', { 'list-type': '2', 'max-keys': '1' });
  const prod = [
    await attempt('PRODUCTION bucket: list', 'GET', PRODUCTION_BUCKET, '', { 'list-type': '2', 'max-keys': '1' }),
    await attempt('PRODUCTION bucket: HEAD random key', 'HEAD', PRODUCTION_BUCKET, random),
    await attempt('PRODUCTION bucket: GET random key', 'GET', PRODUCTION_BUCKET, random),
  ];
  console.log(`${control.label}: ${control.status} ${control.code}`);
  for (const r of prod) console.log(`${r.label}: ${r.status} ${r.code}${r.leaked ? '  <-- NOT DENIED' : ''}`);
  // 404 on HEAD/GET would mean the key reached the bucket and merely found no object; only 401/403 is a denial.
  const denied = prod.every((r) => !r.leaked && (r.status === 401 || r.status === 403));
  const controlOk = control.status === 200;
  console.log(controlOk && denied ? 'ISOLATION PASS: the staging key works on staging and is denied on production'
    : `ISOLATION FAIL (control ${controlOk ? 'ok' : 'failed'}, production ${denied ? 'denied' : 'NOT denied'})`);
  process.exit(controlOk && denied ? 0 : 1);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
