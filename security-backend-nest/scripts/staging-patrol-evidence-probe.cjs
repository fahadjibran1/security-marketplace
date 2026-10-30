/**
 * S4 STAGING certification probe for Patrols P1-C photo evidence storage (fictional data only; never production).
 *
 * Drives the DEPLOYED staging API exactly as the Guard app and the company web do, and touches the patrol bucket only
 * through the presigned URLs the server issues. It needs NO bucket (R2 / Cloudflare) credential and NO database
 * credential: the "unsigned", "tampered signature" and "anonymous listing" requests are derived in memory from a
 * presigned URL the server returned. Every check runs and is reported; the exit code is 1 if any failed, 2 if a
 * precondition is not met (nothing is written then), 0 if all passed.
 *
 *   node scripts/staging-patrol-evidence-probe.cjs --plan
 *   node scripts/staging-patrol-evidence-probe.cjs --run
 *        [--credentials ~/.s4-pilot-secrets/staging-uat.env]
 *        [--company-b-credentials ~/.s4-pilot-secrets/staging-patrol-probe.env]
 *        [--site-id <company A site>] [--shift-id <an in-progress shift of Guard Alpha>] [--expect-bucket <bucket name>]
 *   node scripts/staging-patrol-evidence-probe.cjs --run --target local=http://127.0.0.1:<port> --credentials <file> ...
 *
 * Target lock: the only remote target is https://security-marketplace-api-staging.onrender.com. Production
 * (security-marketplace-api.onrender.com), any sfour.co.uk host and every other host are refused; --target local=
 * accepts http(s)://127.0.0.1 or localhost only (local rehearsal).
 *
 * Credentials (values are never printed):
 *   staging-uat.env              UAT_OWNER_EMAIL / _PASSWORD (company A Owner), UAT_GUARD_ALPHA_EMAIL / _PASSWORD,
 *                                UAT_GUARD_BRAVO_EMAIL / _PASSWORD (both Guards of company A)
 *   staging-patrol-probe.env     UAT_COMPANY_B_OWNER_EMAIL / UAT_COMPANY_B_OWNER_PASSWORD (an Owner of a SECOND company)
 * For the staging target both files must live in ~/.s4-pilot-secrets/ (outside every repository).
 *
 * Output: check ids, PASS / FAIL, HTTP statuses, error codes, record ids, sizes and SHA-256 prefixes. Never a URL, a
 * query string, a signature, an object key (only a short hash of it), a token, a password, an email or a name.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, randomBytes } = require('crypto');

const STAGING_ORIGIN = 'https://security-marketplace-api-staging.onrender.com';
const PRODUCTION_HOSTS = ['security-marketplace-api.onrender.com'];
const FORBIDDEN_HOST_SUFFIXES = ['sfour.co.uk'];
/** Buckets the probe must never send a request to (the production compliance bucket). */
const PRODUCTION_BUCKETS = ['s4-evidence-pilot'];
const SECRETS_DIR = path.join(os.homedir(), '.s4-pilot-secrets');
const REQUEST_TIMEOUT_MS = 60_000;
const LABEL = 'S4 PROBE - fictional';
const AREAS = ['patrol', 'patrol-incoming', 'patrol-quarantine', 'patrol-exports'];
const MAX_POSSIBLE_BYTES = 25 * 1024 * 1024; // the server's upper bound for PATROL_EVIDENCE_MAX_BYTES
const DAY = 86_400_000;

// ─── target lock ──────────────────────────────────────────────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/**
 * The API origin to use, or throws. undefined / 'staging' / the exact staging origin → staging. 'local=<url>' → a
 * localhost / 127.0.0.1 origin. Everything else (production, sfour.co.uk, any other host, a URL with a path, query or
 * credentials) is refused.
 */
function resolveTarget(arg) {
  if (arg === undefined || arg === null || arg === '' || arg === 'staging') return { kind: 'staging', origin: STAGING_ORIGIN };
  const raw = String(arg);
  const isLocal = raw.startsWith('local=');
  const text = isLocal ? raw.slice('local='.length) : raw;
  let u;
  try { u = new URL(text); } catch { throw new Error('REFUSED: the target is not a URL'); }
  const host = u.hostname.toLowerCase();
  if (PRODUCTION_HOSTS.includes(host)) throw new Error('REFUSED: that is the PRODUCTION API; this probe runs against staging only');
  if (FORBIDDEN_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) throw new Error('REFUSED: sfour.co.uk hosts are never a probe target');
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new Error('REFUSED: the target must be a bare origin');
  if (isLocal) {
    if (!LOCAL_HOSTS.has(host)) throw new Error('REFUSED: --target local= accepts 127.0.0.1 or localhost only');
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('REFUSED: local target must be http(s)');
    return { kind: 'local', origin: u.origin };
  }
  if (u.origin === STAGING_ORIGIN) return { kind: 'staging', origin: STAGING_ORIGIN };
  throw new Error(`REFUSED: the only remote target is ${STAGING_ORIGIN}`);
}

/**
 * A presigned bucket URL the server issued may be fetched only if it is not the API itself, not production, and (for
 * staging) https. Returns { bucket, key } or throws. The URL itself is never printed.
 */
function assertBucketUrl(url, target, expectBucket) {
  let u;
  try { u = new URL(url); } catch { throw new Error('the server returned a storage URL that is not a URL'); }
  const host = u.hostname.toLowerCase();
  if (PRODUCTION_HOSTS.includes(host) || FORBIDDEN_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    throw new Error('REFUSED: a storage URL points at a production / sfour.co.uk host');
  }
  if (u.origin === target.origin) throw new Error('REFUSED: a storage URL points at the API itself');
  if (target.kind === 'staging' && u.protocol !== 'https:') throw new Error('REFUSED: a staging storage URL is not https');
  if (target.kind === 'local' && !(u.protocol === 'https:' || LOCAL_HOSTS.has(host))) throw new Error('REFUSED: local rehearsal storage must be local or https');
  if (u.username || u.password) throw new Error('REFUSED: a storage URL carries credentials');
  const d = describeObjectUrl(url);
  if (PRODUCTION_BUCKETS.includes(d.bucket)) throw new Error('REFUSED: a storage URL names the PRODUCTION evidence bucket');
  if (expectBucket && d.bucket !== expectBucket) throw new Error('REFUSED: the storage URL names a bucket other than --expect-bucket');
  return d;
}

/** Path-style URL → bucket, key, the parsed patrol key and a short hash of the key (the key itself is never printed). */
function describeObjectUrl(url) {
  const u = new URL(url);
  const segments = u.pathname.split('/').slice(1).map((s) => decodeURIComponent(s));
  const bucket = segments[0] || '';
  const key = segments.slice(1).join('/');
  const m = /^(?:([a-z0-9][a-z0-9-]{0,62})\/)?(patrol|patrol-incoming|patrol-quarantine|patrol-exports)\/([1-9][0-9]{0,9})\/([0-9]{4})\/(0[1-9]|1[0-2])\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\.zip)?$/.exec(key);
  return {
    bucket,
    key,
    keyHash: createHash('sha256').update(key).digest('hex').slice(0, 12),
    area: m ? m[2] : null,
    companyId: m ? Number(m[3]) : null,
    prefix: m ? m[1] || null : null,
    expiresSeconds: Number(u.searchParams.get('X-Amz-Expires')),
    signed: u.searchParams.has('X-Amz-Signature'),
  };
}

// ─── redaction ────────────────────────────────────────────────────────────────────────────────────────────────

const knownSecrets = new Set();
function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 4) knownSecrets.add(value);
}
/** Names seen in any API response are registered, so an error message that quotes one is still redacted. */
function registerNamesIn(value, depth = 0) {
  if (!value || depth > 6) return;
  if (Array.isArray(value)) return value.forEach((v) => registerNamesIn(v, depth + 1));
  if (typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && /(name|email|address|contact)/i.test(k) && v.trim().length >= 3) registerSecret(v.trim());
    else if (v && typeof v === 'object') registerNamesIn(v, depth + 1);
  }
}

function redact(text) {
  let out = String(text);
  for (const s of [...knownSecrets].sort((a, b) => b.length - a.length)) out = out.split(s).join('<redacted>');
  return out
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '<database-url>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '<jwt>')
    .replace(/X-Amz-[A-Za-z-]+=[^&\s"'<>]*/gi, 'X-Amz-<redacted>')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '<url>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b(Contact)\s+[^.]*\./g, '$1 <redacted>.')
    .replace(/((?:patrol|patrol-incoming|patrol-quarantine|patrol-exports)\/\d+\/\d{4}\/\d{2}\/)[0-9a-f-]{36}/g, '$1<id>');
}

function out(line = '') {
  process.stdout.write(`${redact(line)}\n`);
}

// ─── credentials ─────────────────────────────────────────────────────────────────────────────────────────────

function readEnvFile(file) {
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) values[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

/** A credentials file for the staging target must be inside ~/.s4-pilot-secrets (never in a repository). */
function credentialFileProblem(file, target) {
  if (!file) return 'no file given';
  const resolved = path.resolve(file.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (!fs.existsSync(resolved)) return `${path.basename(resolved)} does not exist`;
  if (target.kind === 'staging') {
    const rel = path.relative(SECRETS_DIR, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return `${path.basename(resolved)} is not inside ~/.s4-pilot-secrets`;
  }
  return null;
}

const CREDENTIAL_NAMES = {
  a: ['UAT_OWNER_EMAIL', 'UAT_OWNER_PASSWORD', 'UAT_GUARD_ALPHA_EMAIL', 'UAT_GUARD_ALPHA_PASSWORD', 'UAT_GUARD_BRAVO_EMAIL', 'UAT_GUARD_BRAVO_PASSWORD'],
  b: ['UAT_COMPANY_B_OWNER_EMAIL', 'UAT_COMPANY_B_OWNER_PASSWORD'],
};

// ─── synthetic images (ported from scripts/fixtures/patrol-test-images.ts; no real photo, no personal data) ───

const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const segment = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), u16(payload.length + 2), payload]);

/** A baseline JPEG (flat grey, 16x8) whose COM segment labels it as fictional; the nonce makes every image unique. */
function jpeg(nonce = randomBytes(8).toString('hex')) {
  const width = 16;
  const height = 8;
  const parts = [Buffer.from([0xff, 0xd8])];
  parts.push(segment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])));
  parts.push(segment(0xfe, Buffer.from(`${LABEL} synthetic test image ${nonce}`, 'latin1')));
  parts.push(segment(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)])));
  parts.push(segment(0xc0, Buffer.concat([Buffer.from([0x08]), u16(height), u16(width), Buffer.from([0x01, 0x01, 0x11, 0x00])])));
  const oneCodeTable = (tcth) => segment(0xc4, Buffer.concat([Buffer.from([tcth, 1]), Buffer.alloc(15, 0), Buffer.from([0x00])]));
  parts.push(oneCodeTable(0x00), oneCodeTable(0x10));
  parts.push(segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])));
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  let bits = '00'.repeat(blocks);
  bits += '1'.repeat((8 - (bits.length % 8)) % 8);
  const entropy = [];
  for (let i = 0; i < bits.length; i += 8) {
    const byte = parseInt(bits.slice(i, i + 8), 2);
    entropy.push(byte);
    if (byte === 0xff) entropy.push(0x00);
  }
  parts.push(Buffer.from(entropy), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const short = (hex) => (hex ? String(hex).slice(0, 12) : '-');

// ─── arguments ────────────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { mode: null, target: undefined, credentials: path.join(SECRETS_DIR, 'staging-uat.env'),
    companyB: path.join(SECRETS_DIR, 'staging-patrol-probe.env'), siteId: null, shiftId: null, expectBucket: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--plan') opts.mode = opts.mode && opts.mode !== 'plan' ? 'both' : 'plan';
    else if (a === '--run') opts.mode = opts.mode && opts.mode !== 'run' ? 'both' : 'run';
    else if (a === '--target') opts.target = next();
    else if (a.startsWith('--target=')) opts.target = a.slice('--target='.length);
    else if (a === '--credentials') opts.credentials = next();
    else if (a === '--company-b-credentials') opts.companyB = next();
    else if (a === '--site-id') opts.siteId = positiveInt(next(), a);
    else if (a === '--shift-id') opts.shiftId = positiveInt(next(), a);
    else if (a === '--expect-bucket') opts.expectBucket = next();
    else throw new Error(`unknown argument ${a}`);
  }
  if (opts.mode === 'both') throw new Error('use --plan or --run, not both');
  if (!opts.mode) throw new Error('use --plan (no network) or --run');
  return opts;
}
function positiveInt(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

// ─── the plan ─────────────────────────────────────────────────────────────────────────────────────────────────

const PLAN = [
  ['P0', 'target lock (staging origin only) and credential files present (names only)', 'none'],
  ['P1', 'API readiness', 'GET /health/ready'],
  ['P2', 'company A Owner, Guard Alpha, Guard Bravo sign in; company A has patrols.evidence + patrols.holds (so patrolsEnabled is on)', 'POST /auth/login'],
  ['P3', 'company B Owner signs in; company B differs from A; records whether B has Patrols on (strong isolation) or off (weak)', 'POST /auth/login'],
  ['P4', 'patrol photo storage configured on the target; baseline metering and retention mode', 'GET /patrols/storage-usage'],
  ['P5', 'a shift of Guard Alpha in progress at a company A site: --shift-id, or created and booked on here', 'GET /sites; POST /shifts; PATCH /shifts/:id/respond; POST /attendance/check-in; GET /patrols/mine/plan?shiftId='],
  ['P6', 'an unscheduled patrol run on that shift (clientRunId idempotent)', 'POST /patrols/runs'],
  ['U1', 'upload intent → presigned PUT (incoming area, company A, TTL ≤ 300 s) → exact bytes → complete: verified, SHA-256 / size / type match', 'POST /patrols/runs/:id/evidence; PUT <presigned>; POST /patrols/evidence/:id/complete'],
  ['U2', 'idempotency: second complete is a no-op; intent replay returns the same record and no URL; same clientEvidenceId with other bytes is 409', 'same'],
  ['U3', 'provider refuses a Content-Type other than the signed one', 'PUT <presigned> (in-memory variant)'],
  ['U4', 'provider refuses a body longer than the signed length', 'PUT <presigned>'],
  ['U5', 'provider refuses a body not matching the signed x-amz-checksum-sha256 (else the server must quarantine it as hash_mismatch)', 'PUT <presigned>; POST /patrols/evidence/:id/complete'],
  ['U6', 'after the refused PUTs nothing reached storage (complete → 409 PATROL_EVIDENCE_NOT_UPLOADED); the right bytes then verify', 'POST /patrols/evidence/:id/complete'],
  ['U7', 'API refuses a type outside JPEG/PNG/HEIC/WebP and a size above the cap before issuing any URL', 'POST /patrols/runs/:id/evidence'],
  ['U8', 'server inspection catches bytes that are not what was declared (JPEG declared as PNG): rejected + quarantined, never viewable or restorable', 'POST …/evidence; PUT; POST …/complete; GET /patrols/evidence/:id/download; POST /patrols/evidence/:id/restore'],
  ['A1', 'download link: no-store, exact object (patrol/ area, company A), TTL 60–300 s, attachment of image/jpeg, exact bytes', 'GET /patrols/evidence/:id/download?purpose=audit; GET <presigned>'],
  ['A2', 'unsigned URL (signature stripped in memory) refused', 'GET <bucket>/<key>'],
  ['A3', 'tampered signature refused', 'GET <presigned with X-Amz-Signature zeroed>'],
  ['A4', 'anonymous bucket listing refused', 'GET <bucket>/ and ?list-type=2'],
  ['A5', 'a Guard cannot obtain a download link; purpose is required; an unknown id is 404', 'GET /patrols/evidence/:id/download'],
  ['D1', 'Owner deletion: verified → quarantined (manual, purgeAfter ≈ 7 days); the earlier link stops serving; not viewable; not deletable twice', 'POST /patrols/evidence/:id/delete'],
  ['X*', 'company B (while A holds a deleted-but-restorable photo and active holds) cannot read, list, link, delete, restore, hold or release A\'s data — 404 with no data; Guard Bravo cannot upload to / complete Alpha\'s run', 'GET /patrols/runs[/:id[/evidence]]; GET /patrols/holds; GET /patrols/storage-usage; POST /patrols/evidence/:id/{delete,restore}; POST /patrols/holds; POST /patrols/holds/:id/release; POST /patrols/runs/:id/evidence; POST /patrols/evidence/:id/complete; GET /patrols/mine/plan'],
  ['D2', 'Owner restore from quarantine: active, byte-exact through a fresh link (new key), retention extended ≥ 7 days; restoring an active photo is 409', 'POST /patrols/evidence/:id/restore; GET …/download'],
  ['H1', 'evidence hold blocks deletion (409 PATROL_EVIDENCE_HELD); run hold blocks it too; released holds stop blocking; double release is 409', 'POST /patrols/holds; GET /patrols/holds; POST /patrols/holds/:id/release; POST /patrols/evidence/:id/delete'],
  ['C*', 'cleanup: release holds, complete the run, delete every verified probe photo (→ quarantine), Book Off a shift the probe created', 'POST …/release; POST /patrols/runs/:id/complete; POST …/delete; POST /attendance/check-out'],
  ['S1', 'metering equals the probe\'s own transitions (active ±0, quarantined +3 objects / bytes) — assumes no other patrol activity meanwhile', 'GET /patrols/storage-usage'],
];

function printPlan(target) {
  out(`PLAN (no network). Target: ${target.kind === 'staging' ? 'staging' : 'local rehearsal'} (origin locked; production and sfour.co.uk refused).`);
  out('Preconditions the OPERATOR arranges beforehand (the probe never toggles switches, permissions or platform settings):');
  out('  1. The target runs a build with Patrols P1-C (Migration 70) and the PATROL_EVIDENCE_STORAGE_* variables set to the');
  out('     NON-production patrol bucket (endpoint, bucket, access key id, secret; optional region/prefix/TTL/max bytes).');
  out('  2. Company A (the UAT company) has Patrol Management ON (platform admin: PUT /admin/patrols/companies/:id).');
  out('  3. A second company B with an Owner who can sign in; its login in ~/.s4-pilot-secrets/staging-patrol-probe.env as');
  out('     UAT_COMPANY_B_OWNER_EMAIL / UAT_COMPANY_B_OWNER_PASSWORD. Turn Patrols ON for B too for STRONG isolation');
  out('     (with it off every B route answers 404 PATROLS_NOT_ENABLED before any id lookup: still a pass, reported as weak).');
  out('  4. Guard Alpha can Book On at a company A site without GPS / NFC (compliance current), OR pass --shift-id of an');
  out('     in-progress shift of Guard Alpha. Nobody else should use Guard Alpha\'s account during the run (~2 min).');
  out('Writes (all fictional, labelled "S4 PROBE - fictional"): 1 shift + Book On/Off + its timesheet (unless --shift-id),');
  out('1 patrol run, 3 photo records (2 verified then deleted to quarantine, 1 rejected to quarantine), 2 holds (released),');
  out('audit entries. Bucket residue: 3 quarantine objects, purged only by the maintenance job in PATROL_EVIDENCE_RETENTION_MODE=');
  out('enforce once purgeAfter (7 days) has passed. The API cannot delete records, tombstones or audit rows.');
  out('Ordered steps:');
  for (const [id, what, how] of PLAN) out(`  ${id.padEnd(3)} ${what}\n        ${how}`);
}

// ─── runtime ──────────────────────────────────────────────────────────────────────────────────────────────────

const results = [];
function must(condition, message) {
  if (!condition) throw new Error(message);
}
async function check(id, title, fn) {
  try {
    const note = await fn();
    results.push({ id, ok: true });
    out(`PASS ${id} ${title}${note ? ` (${note})` : ''}`);
  } catch (error) {
    results.push({ id, ok: false });
    out(`FAIL ${id} ${title}: ${String(error && error.message ? error.message : error)}`);
  }
}

class Precondition extends Error {}

async function main(opts) {
  const target = resolveTarget(opts.target);
  if (opts.mode === 'plan') {
    printPlan(target);
    return 0;
  }

  // ── P0 ──
  const problems = [];
  for (const [label, file] of [['credentials', opts.credentials], ['company-b-credentials', opts.companyB]]) {
    const p = credentialFileProblem(file, target);
    if (p) problems.push(`--${label}: ${p}`);
  }
  if (problems.length) throw new Precondition(problems.join('; '));
  const credsA = readEnvFile(path.resolve(opts.credentials.replace(/^~(?=$|[\\/])/, os.homedir())));
  const credsB = readEnvFile(path.resolve(opts.companyB.replace(/^~(?=$|[\\/])/, os.homedir())));
  const missing = [...CREDENTIAL_NAMES.a.filter((k) => !credsA[k]), ...CREDENTIAL_NAMES.b.filter((k) => !credsB[k])];
  if (missing.length) throw new Precondition(`credential names missing: ${missing.join(', ')}`);
  for (const v of [...Object.values(credsA), ...Object.values(credsB)]) registerSecret(v);
  out(`P0 target ${target.kind} (origin locked), credential names present`);

  const api = async (method, route, token, body) => {
    const url = new URL(route, target.origin);
    if (url.origin !== target.origin) throw new Error('REFUSED: a request left the locked origin');
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    registerNamesIn(json);
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const bucket = async (method, url, init = {}) => {
    assertBucketUrl(url, target, opts.expectBucket);
    registerSecret(url);
    const res = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...init });
    const buf = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buf };
  };
  const code = (r) => (r.body && typeof r.body === 'object' ? r.body.code || '' : '');
  const expect = (r, status, errorCode, what) => {
    must(r.status === status && (!errorCode || code(r) === errorCode),
      `${what}: expected ${status}${errorCode ? ` ${errorCode}` : ''}, got ${r.status}${code(r) ? ` ${code(r)}` : ''}${r.status >= 400 && !code(r) && r.body?.message ? ` "${String(r.body.message).slice(0, 160)}"` : ''}`);
  };

  // ── P1 ──
  const ready = await api('GET', '/health/ready');
  if (ready.status !== 200) throw new Precondition(`GET /health/ready answered ${ready.status}`);
  out('P1 /health/ready 200');

  // ── P2 / P3 ──
  const login = async (email, password, who) => {
    // POST /auth/login is throttled (6 per minute per client IP): a 429 waits out the window, at most twice. Signing in
    // changes nothing, so a retry is safe.
    let r = await api('POST', '/auth/login', null, { email, password });
    for (let attempt = 0; r.status === 429 && attempt < 2; attempt += 1) {
      const wait = Math.min(Math.max(Number(r.headers.get('retry-after')) || 61, 1), 65);
      out(`  sign-in throttled (429); waiting ${wait}s`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      r = await api('POST', '/auth/login', null, { email, password });
    }
    if (r.status !== 200 && r.status !== 201) throw new Precondition(`${who} cannot sign in (HTTP ${r.status}${code(r) ? ` ${code(r)}` : ''})`);
    registerSecret(r.body.accessToken);
    return { token: r.body.accessToken, user: r.body.user || {} };
  };
  const ownerA = await login(credsA.UAT_OWNER_EMAIL, credsA.UAT_OWNER_PASSWORD, 'company A Owner');
  const alpha = await login(credsA.UAT_GUARD_ALPHA_EMAIL, credsA.UAT_GUARD_ALPHA_PASSWORD, 'Guard Alpha');
  const bravo = await login(credsA.UAT_GUARD_BRAVO_EMAIL, credsA.UAT_GUARD_BRAVO_PASSWORD, 'Guard Bravo');
  const ownerB = await login(credsB.UAT_COMPANY_B_OWNER_EMAIL, credsB.UAT_COMPANY_B_OWNER_PASSWORD, 'company B Owner');
  const companyA = Number(ownerA.user.companyId);
  const companyB = Number(ownerB.user.companyId);
  const permsA = ownerA.user.companyPermissions || [];
  if (!Number.isInteger(companyA) || companyA < 1) throw new Precondition('the company A login is not a company account');
  if (!permsA.includes('patrols.evidence') || !permsA.includes('patrols.holds')) {
    throw new Precondition(`company A (${companyA}) Owner lacks patrols.evidence / patrols.holds: Patrol Management is OFF for company A (operator: a platform admin turns it on)`);
  }
  if (!Number.isInteger(alpha.user.guardId) || !Number.isInteger(bravo.user.guardId) || alpha.user.guardId === bravo.user.guardId) {
    throw new Precondition('the Alpha / Bravo logins are not two different Guard accounts');
  }
  if (!Number.isInteger(companyB) || companyB < 1) throw new Precondition('the company B login is not a company account');
  if (companyB === companyA) throw new Precondition('company B is the same company as A; isolation needs a second company');
  const strong = (ownerB.user.companyPermissions || []).includes('patrols.view');
  out(`P2 company ${companyA} (A): Owner, Guards ${alpha.user.guardId} (Alpha) and ${bravo.user.guardId} (Bravo) signed in; Patrols on`);
  out(`P3 company ${companyB} (B): Owner signed in; Patrols ${strong ? 'ON (strong isolation)' : 'OFF (WEAK isolation: every B route stops at the switch)'}`);

  // ── P4 ──
  const usage0 = await api('GET', '/patrols/storage-usage', ownerA.token);
  if (usage0.status !== 200) throw new Precondition(`GET /patrols/storage-usage answered ${usage0.status} ${code(usage0)}`);
  if (usage0.body.storageConfigured !== true) throw new Precondition('patrol photo storage is NOT configured on the target (PATROL_EVIDENCE_STORAGE_* unset or invalid)');
  out(`P4 storage configured; retention mode ${usage0.body.retentionMode}; baseline company A active ${usage0.body.totals.activeObjects} / quarantined ${usage0.body.totals.quarantinedObjects} objects`);

  // ── P5 ──
  const state = { createdShift: false, shiftId: opts.shiftId, runId: null, createdRun: false, holds: [], images: {}, evidence: {} };
  if (state.shiftId) {
    const plan = await api('GET', `/patrols/mine/plan?shiftId=${state.shiftId}`, alpha.token);
    if (plan.status !== 200) throw new Precondition(`--shift-id ${state.shiftId}: Guard Alpha's plan answered ${plan.status} ${code(plan)}`);
    if (plan.body.shift.status !== 'in_progress') throw new Precondition(`--shift-id ${state.shiftId} is ${plan.body.shift.status}, not in_progress`);
    state.siteId = Number(plan.body.site.id);
  } else {
    const sites = await api('GET', '/sites', ownerA.token);
    if (sites.status !== 200 || !Array.isArray(sites.body)) throw new Precondition(`GET /sites answered ${sites.status}`);
    const usable = sites.body.filter((s) => !s.requireGpsCheckIn && !s.requireNfcCheckIn && (!opts.siteId || Number(s.id) === opts.siteId));
    if (!usable.length) throw new Precondition(opts.siteId ? `site ${opts.siteId} is not a company A site without GPS / NFC Book On` : 'company A has no site without GPS / NFC Book On; pass --site-id or --shift-id');
    state.siteId = Number(usable[0].id);
  }
  out(`P5 preconditions met; site ${state.siteId}. Writing fictional data from here.`);

  const now = () => new Date().toISOString();
  const cid = (p) => `s4probe-${p}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

  // From here every step is a check, so everything is reported even when an early one fails.
  await check('P5', 'Guard Alpha has an in-progress shift at a company A site', async () => {
    if (state.shiftId) return `given shift ${state.shiftId}`;
    const start = new Date(Date.now() - 2 * 60_000).toISOString();
    const end = new Date(Date.now() + 40 * 60_000).toISOString();
    const created = await api('POST', '/shifts', ownerA.token, {
      siteId: state.siteId, guardId: alpha.user.guardId, start, end, checkCallIntervalMinutes: 60,
      instructions: `${LABEL}: patrol evidence storage certification probe. Not a real shift.`,
    });
    must(created.status === 201 || created.status === 200, `POST /shifts answered ${created.status} ${code(created)}`);
    const shift = created.body && created.body.shift;
    must(shift && Number.isInteger(shift.id), 'POST /shifts did not return { shift: { id } }');
    state.shiftId = shift.id;
    state.createdShift = true;
    const accept = await api('PATCH', `/shifts/${shift.id}/respond`, alpha.token, { response: 'accepted' });
    must(accept.status === 200, `accept answered ${accept.status} ${code(accept)}`);
    const on = await api('POST', '/attendance/check-in', alpha.token, { shiftId: shift.id });
    must(on.status === 201 || on.status === 200, `Book On answered ${on.status}${on.body?.message ? ` "${String(on.body.message).slice(0, 160)}"` : ''}`);
    const plan = await api('GET', `/patrols/mine/plan?shiftId=${shift.id}`, alpha.token);
    expect(plan, 200, null, 'plan');
    must(plan.body.shift.status === 'in_progress', `shift is ${plan.body.shift.status}`);
    return `shift ${shift.id} created, accepted and booked on`;
  });

  await check('P6', 'a patrol run starts on that shift', async () => {
    must(state.shiftId, 'blocked: no shift');
    const r = await api('POST', '/patrols/runs', alpha.token, { clientRunId: cid('run'), shiftId: state.shiftId, startedAtDevice: now(), sentAtDevice: now() });
    if (r.status === 409 && code(r) === 'PATROL_RUN_ALREADY_IN_PROGRESS' && r.body.details?.runId) {
      state.runId = Number(r.body.details.runId);
      return `reusing Alpha's run ${state.runId} already in progress`;
    }
    expect(r, 201, null, 'start run');
    state.runId = Number(r.body.id);
    state.createdRun = true;
    return `run ${state.runId}`;
  });

  const intent = (token, runId, image, extra = {}) => api('POST', `/patrols/runs/${runId}/evidence`, token, {
    clientEvidenceId: cid('ev'), kind: 'run_photo', contentType: 'image/jpeg', sizeBytes: image.length, sha256: sha(image),
    capturedAtDevice: new Date(Date.now() - 30_000).toISOString(), sentAtDevice: now(), ...extra,
  });
  const complete = (token, id) => api('POST', `/patrols/evidence/${id}/complete`, token);
  const putBytes = (upload, bytes, headers) => bucket('PUT', upload.url, { headers: headers || upload.headers, body: new Uint8Array(bytes) });
  const download = (token, id, purpose = 'audit') => api('GET', `/patrols/evidence/${id}/download${purpose ? `?purpose=${purpose}` : ''}`, token);
  const ttlOf = (expiresAt) => Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000);

  // ── U1 ──
  await check('U1', 'correct upload verifies: incoming key of company A, TTL ≤ 300 s, SHA-256 / size / type match', async () => {
    must(state.runId, 'blocked: no run');
    const image = jpeg();
    state.images.e1 = image;
    const r = await intent(alpha.token, state.runId, image);
    expect(r, 201, null, 'intent');
    must((r.headers.get('cache-control') || '').includes('no-store'), 'the intent response is cacheable');
    must(r.body.upload && r.body.upload.method === 'PUT', 'no presigned PUT returned');
    must(!/storageKey|quarantineKey/.test(JSON.stringify(r.body.evidence)), 'the record exposes a storage key');
    const d = assertBucketUrl(r.body.upload.url, target, opts.expectBucket);
    must(d.area === 'patrol-incoming' && d.companyId === companyA, `upload key is ${d.area || 'not a patrol key'} of company ${d.companyId}`);
    must(d.expiresSeconds >= 60 && d.expiresSeconds <= 300 && ttlOf(r.body.upload.expiresAt) <= 305, `upload URL lifetime ${d.expiresSeconds}s`);
    state.evidence.e1 = { id: Number(r.body.evidence.id), clientEvidenceId: r.body.evidence.clientEvidenceId, intentBody: null };
    state.e1Intent = { body: { clientEvidenceId: r.body.evidence.clientEvidenceId, kind: 'run_photo', contentType: 'image/jpeg', sizeBytes: image.length, sha256: sha(image), capturedAtDevice: r.body.evidence.capturedAtDevice } };
    const put = await putBytes(r.body.upload, image);
    must(put.status === 200, `signed PUT answered ${put.status}`);
    const c = await complete(alpha.token, state.evidence.e1.id);
    expect(c, 200, null, 'complete');
    must(c.body.uploadStatus === 'verified', `uploadStatus ${c.body.uploadStatus} (${c.body.rejectionReason || ''})`);
    must(c.body.sha256Stored === sha(image) && c.body.sizeBytes === image.length && c.body.detectedMimeType === 'image/jpeg', 'stored hash / size / type differ');
    must(c.body.retentionStatus === 'active' && c.body.expiresAt, 'retention not started');
    state.evidence.e1.verified = c.body;
    return `evidence ${state.evidence.e1.id}, ${image.length} bytes, sha ${short(sha(image))}, key#${d.keyHash}, ttl ${d.expiresSeconds}s`;
  });

  // ── U2 ──
  await check('U2', 'completion and intent are idempotent; a reused clientEvidenceId with other bytes is 409', async () => {
    const e1 = state.evidence.e1;
    must(e1 && e1.verified, 'blocked: U1');
    const again = await complete(alpha.token, e1.id);
    expect(again, 200, null, 'second complete');
    must(again.body.uploadStatus === 'verified' && again.body.verifiedAt === e1.verified.verifiedAt && again.body.sha256Stored === e1.verified.sha256Stored, 'second complete changed the record');
    const replay = await api('POST', `/patrols/runs/${state.runId}/evidence`, alpha.token, state.e1Intent.body);
    must(replay.status === 201 || replay.status === 200, `intent replay answered ${replay.status} ${code(replay)}`);
    must(Number(replay.body.evidence.id) === e1.id && replay.body.upload === null, 'intent replay issued a new record or a new URL for a settled photo');
    const other = jpeg();
    const conflict = await api('POST', `/patrols/runs/${state.runId}/evidence`, alpha.token, { ...state.e1Intent.body, sizeBytes: other.length, sha256: sha(other) });
    expect(conflict, 409, 'PATROL_IDEMPOTENCY_CONFLICT', 'reused clientEvidenceId');
    return 'verifiedAt unchanged; replay upload null';
  });

  // ── U3–U6 on one intent (e2): the provider must refuse each tampered PUT, so nothing lands; then the right bytes verify ──
  const freshE2 = async () => {
    const image = jpeg();
    const r = await intent(alpha.token, state.runId, image);
    expect(r, 201, null, 'intent');
    state.images.e2 = image;
    state.evidence.e2 = { id: Number(r.body.evidence.id), upload: r.body.upload };
  };
  /** A tampered PUT the provider ACCEPTED: the server must catch it on completion (rejected + quarantined). */
  const serverCatch = async (expectReason) => {
    const c = await complete(alpha.token, state.evidence.e2.id);
    const caught = c.status === 200 && c.body.uploadStatus === 'rejected' && c.body.retentionStatus === 'quarantined';
    state.extraQuarantined = (state.extraQuarantined || 0) + (caught ? 1 : 0);
    await freshE2();
    return caught ? `server caught it (${c.body.rejectionReason}; quarantined)` : `server did NOT catch it (${c.status} ${c.body?.uploadStatus || code(c)}; expected ${expectReason})`;
  };
  await check('U3', 'the provider refuses a Content-Type other than the signed one', async () => {
    must(state.runId, 'blocked: no run');
    await freshE2();
    const res = await putBytes(state.evidence.e2.upload, state.images.e2, { ...state.evidence.e2.upload.headers, 'Content-Type': 'text/html' });
    if (res.status < 300) throw new Error(`ACCEPTED (${res.status}); ${await serverCatch('content_type_mismatch')}`);
    return `refused ${res.status}`;
  });
  await check('U4', 'the provider refuses a body longer than the signed length', async () => {
    must(state.evidence.e2, 'blocked: no intent');
    const longer = Buffer.concat([state.images.e2, Buffer.alloc(1024, 0x20)]);
    const res = await putBytes(state.evidence.e2.upload, longer);
    if (res.status < 300) throw new Error(`ACCEPTED (${res.status}); ${await serverCatch('size_mismatch / hash_mismatch')}`);
    return `refused ${res.status}`;
  });
  await check('U5', 'the provider refuses a body that does not match the signed SHA-256', async () => {
    must(state.evidence.e2, 'blocked: no intent');
    const wrong = Buffer.from(state.images.e2);
    wrong[wrong.length - 3] ^= 0xff;
    const res = await putBytes(state.evidence.e2.upload, wrong);
    if (res.status < 300) throw new Error(`ACCEPTED (${res.status}): the provider-side checksum guarantee is absent; ${await serverCatch('hash_mismatch')}`);
    return `refused ${res.status}`;
  });
  await check('U6', 'after the refused PUTs nothing reached storage; the right bytes then verify', async () => {
    const e2 = state.evidence.e2;
    must(e2, 'blocked: no intent');
    const early = await complete(alpha.token, e2.id);
    expect(early, 409, 'PATROL_EVIDENCE_NOT_UPLOADED', 'complete before any accepted PUT');
    const put = await putBytes(e2.upload, state.images.e2);
    must(put.status === 200, `signed PUT answered ${put.status}`);
    const c = await complete(alpha.token, e2.id);
    expect(c, 200, null, 'complete');
    must(c.body.uploadStatus === 'verified' && c.body.sha256Stored === sha(state.images.e2), `uploadStatus ${c.body.uploadStatus}`);
    e2.verified = c.body;
    return `evidence ${e2.id} verified, sha ${short(sha(state.images.e2))}`;
  });

  // ── U7 ──
  await check('U7', 'the API refuses a disallowed type and an oversize photo before issuing a URL', async () => {
    must(state.runId, 'blocked: no run');
    const image = jpeg();
    const type = await intent(alpha.token, state.runId, image, { contentType: 'text/html' });
    expect(type, 400, 'PATROL_EVIDENCE_TYPE_NOT_ALLOWED', 'text/html');
    const big = await intent(alpha.token, state.runId, image, { sizeBytes: MAX_POSSIBLE_BYTES + 1 });
    expect(big, 400, 'PATROL_EVIDENCE_TOO_LARGE', 'oversize');
    const cap = Number(big.body.details?.maxBytes);
    must(Number.isInteger(cap) && cap >= 65536 && cap <= MAX_POSSIBLE_BYTES, 'cap not reported');
    const atCapPlusOne = await intent(alpha.token, state.runId, image, { sizeBytes: cap + 1 });
    expect(atCapPlusOne, 400, 'PATROL_EVIDENCE_TOO_LARGE', 'cap + 1');
    must(!JSON.stringify([type.body, big.body]).includes('X-Amz'), 'a refusal carried a URL');
    return `cap ${cap} bytes`;
  });

  // ── U8 ──
  await check('U8', 'the server rejects and quarantines bytes that are not the declared type; never viewable or restorable', async () => {
    must(state.runId, 'blocked: no run');
    const image = jpeg();
    const r = await intent(alpha.token, state.runId, image, { contentType: 'image/png' });
    expect(r, 201, null, 'intent');
    const put = await putBytes(r.body.upload, image);
    must(put.status === 200, `signed PUT answered ${put.status}`);
    const id = Number(r.body.evidence.id);
    state.evidence.e3 = { id };
    const c = await complete(alpha.token, id);
    expect(c, 200, null, 'complete');
    must(c.body.uploadStatus === 'rejected' && c.body.retentionStatus === 'quarantined', `state ${c.body.uploadStatus}/${c.body.retentionStatus}`);
    must(c.body.rejectionReason === 'content_type_mismatch' && c.body.needsReview === true, `reason ${c.body.rejectionReason}`);
    const purgeIn = (new Date(c.body.purgeAfter).getTime() - Date.now()) / DAY;
    must(purgeIn > 6.9 && purgeIn < 7.1, `purgeAfter in ${purgeIn.toFixed(2)} days`);
    expect(await download(ownerA.token, id), 409, 'PATROL_EVIDENCE_NOT_AVAILABLE', 'download of a rejected photo');
    expect(await api('POST', `/patrols/evidence/${id}/restore`, ownerA.token, { reason: `${LABEL} restore attempt` }), 409, 'PATROL_EVIDENCE_STATE_CONFLICT', 'restore of a rejected photo');
    expect(await complete(alpha.token, id), 200, null, 'repeat complete');
    return `evidence ${id} rejected (content_type_mismatch), quarantined, purge in ${purgeIn.toFixed(1)} d`;
  });

  // ── A1–A5 ──
  let link = null;
  await check('A1', 'download link: no-store, company A patrol/ key, TTL 60–300 s, attachment image/jpeg, exact bytes', async () => {
    const e1 = state.evidence.e1;
    must(e1 && e1.verified, 'blocked: U1');
    const r = await download(ownerA.token, e1.id);
    expect(r, 200, null, 'download');
    must((r.headers.get('cache-control') || '').includes('no-store'), 'the link response is cacheable');
    must(r.body.method === 'GET' && Number(r.body.evidenceId) === e1.id, 'link shape');
    const d = assertBucketUrl(r.body.url, target, opts.expectBucket);
    must(d.area === 'patrol' && d.companyId === companyA, `key is ${d.area} of company ${d.companyId}`);
    const ttl = ttlOf(r.body.expiresAt);
    must(d.expiresSeconds >= 60 && d.expiresSeconds <= 300 && ttl <= 305, `lifetime ${d.expiresSeconds}s / ${ttl}s`);
    const got = await bucket('GET', r.body.url);
    must(got.status === 200, `GET ${got.status}`);
    must((got.headers.get('content-type') || '') === 'image/jpeg', `content-type ${got.headers.get('content-type')}`);
    const disposition = got.headers.get('content-disposition') || '';
    must(disposition.startsWith('attachment') && disposition.includes(`patrol-evidence-${e1.id}.jpg`), 'not served as an attachment with the expected file name');
    must(sha(got.buf) === sha(state.images.e1), 'bytes differ');
    link = { url: r.body.url, keyHash: d.keyHash };
    state.e1KeyHash = d.keyHash;
    return `ttl ${d.expiresSeconds}s, ${got.buf.length} bytes, sha ${short(sha(got.buf))}, key#${d.keyHash}`;
  });
  const marker = () => state.images.e1.subarray(20, 60).toString('latin1');
  const refused = async (label, url) => {
    const r = await bucket('GET', url);
    must(r.status >= 400, `${label}: expected a refusal, got ${r.status}`);
    const body = r.buf.toString('latin1');
    must(!body.includes(marker()) && !/<Contents>|<Key>/.test(body), `${label}: the response leaked content or a listing`);
    return r.status;
  };
  await check('A2', 'an unsigned URL is refused', async () => {
    must(link, 'blocked: A1');
    const u = new URL(link.url);
    return `refused ${await refused('unsigned', `${u.origin}${u.pathname}`)}`;
  });
  await check('A3', 'a tampered signature is refused', async () => {
    must(link, 'blocked: A1');
    const u = new URL(link.url);
    const sig = u.searchParams.get('X-Amz-Signature') || '';
    u.searchParams.set('X-Amz-Signature', sig.replace(/^./, (c) => (c === '0' ? '1' : '0')));
    return `refused ${await refused('tampered', u.toString())}`;
  });
  await check('A4', 'anonymous bucket listing is refused', async () => {
    must(link, 'blocked: A1');
    const u = new URL(link.url);
    const b = describeObjectUrl(link.url).bucket;
    const a = await refused('list', `${u.origin}/${encodeURIComponent(b)}`);
    const v2 = await refused('list-type=2', `${u.origin}/${encodeURIComponent(b)}?list-type=2`);
    return `refused ${a} / ${v2}`;
  });
  await check('A5', 'a Guard gets no link; purpose is required; an unknown id is 404', async () => {
    const e1 = state.evidence.e1;
    must(e1, 'blocked: U1');
    const guard = await download(alpha.token, e1.id);
    must(guard.status === 403, `Guard download answered ${guard.status}`);
    expect(await download(ownerA.token, e1.id, null), 400, null, 'no purpose');
    expect(await download(ownerA.token, 2147483647), 404, null, 'unknown id');
    return 'Guard 403, no purpose 400, unknown 404';
  });

  // ── D1 ──
  await check('D1', 'Owner deletion quarantines the photo; the old link stops serving; it cannot be viewed or deleted twice', async () => {
    const e1 = state.evidence.e1;
    must(e1 && e1.verified, 'blocked: U1');
    const r = await api('POST', `/patrols/evidence/${e1.id}/delete`, ownerA.token, { reason: `${LABEL} deletion test` });
    expect(r, 200, null, 'delete');
    must(r.body.retentionStatus === 'quarantined', `retentionStatus ${r.body.retentionStatus} (a 'claimed' state means the storage move was deferred)`);
    must(r.body.deletionReason === 'manual' && r.body.quarantinedAt, 'deletion not recorded');
    const purgeIn = (new Date(r.body.purgeAfter).getTime() - Date.now()) / DAY;
    must(purgeIn > 6.9 && purgeIn < 7.1, `purgeAfter in ${purgeIn.toFixed(2)} days`);
    e1.deleted = true;
    if (link) {
      const old = await bucket('GET', link.url);
      must(old.status >= 400 && !old.buf.toString('latin1').includes(marker()), `the pre-deletion link still serves (${old.status})`);
    }
    expect(await download(ownerA.token, e1.id), 409, 'PATROL_EVIDENCE_NOT_AVAILABLE', 'download after deletion');
    expect(await api('POST', `/patrols/evidence/${e1.id}/delete`, ownerA.token, { reason: `${LABEL} second deletion` }), 409, 'PATROL_EVIDENCE_NOT_AVAILABLE', 'second deletion');
    return `evidence ${e1.id} quarantined, purge in ${purgeIn.toFixed(1)} d; old link refused`;
  });

  // ── holds placed now so company B meets them active ──
  const placeHold = async (body) => {
    const r = await api('POST', '/patrols/holds', ownerA.token, { reason: `${LABEL} hold test`, ...body });
    expect(r, 201, null, `place ${body.scope} hold`);
    state.holds.push({ id: Number(r.body.id), released: false });
    return Number(r.body.id);
  };
  await check('H1a', 'an evidence hold is placed and listed', async () => {
    const e2 = state.evidence.e2;
    must(e2 && e2.verified, 'blocked: U6');
    state.evidenceHold = await placeHold({ scope: 'evidence', evidenceId: e2.id });
    const list = await api('GET', '/patrols/holds', ownerA.token);
    expect(list, 200, null, 'list holds');
    must(list.body.some((h) => Number(h.id) === state.evidenceHold && !h.releasedAt), 'hold not listed as active');
    return `hold ${state.evidenceHold}`;
  });

  // ── X: company B against company A's ids ──
  const ids = () => ({ run: state.runId, e1: state.evidence.e1?.id, e2: state.evidence.e2?.id, e3: state.evidence.e3?.id, hold: state.evidenceHold, shift: state.shiftId, site: state.siteId });
  const secretsOfA = () => [state.images.e1, state.images.e2].filter(Boolean).map(sha)
    .concat([state.evidence.e1?.clientEvidenceId].filter(Boolean)).concat(['storageKey', 'quarantineKey', 'X-Amz', 'patrol-incoming/', 'patrol-quarantine/']);
  const denied = (r, what) => {
    const allowed = strong ? [404] : [404];
    must(allowed.includes(r.status), `${what}: expected 404, got ${r.status}${code(r) ? ` ${code(r)}` : ''}`);
    if (!strong) must(code(r) === 'PATROLS_NOT_ENABLED', `${what}: weak mode expected PATROLS_NOT_ENABLED, got ${code(r)}`);
    for (const s of secretsOfA()) must(!r.text.includes(s), `${what}: the response carries company A data`);
  };
  const xNote = strong ? 'strong' : 'WEAK (B Patrols off)';
  await check('X1', 'company B cannot read A\'s run, its evidence metadata or a download link', async () => {
    const i = ids();
    must(i.run && i.e2, 'blocked: no run / evidence');
    denied(await api('GET', `/patrols/runs/${i.run}`, ownerB.token), 'GET run');
    denied(await api('GET', `/patrols/runs/${i.run}/evidence`, ownerB.token), 'GET run evidence');
    denied(await download(ownerB.token, i.e2), 'download active photo');
    if (i.e3) denied(await download(ownerB.token, i.e3), 'download rejected photo');
    return xNote;
  });
  await check('X2', 'company B cannot delete, restore or hold A\'s photos, run, shift or site', async () => {
    const i = ids();
    must(i.e1 && i.e2, 'blocked: no evidence');
    denied(await api('POST', `/patrols/evidence/${i.e2}/delete`, ownerB.token, { reason: `${LABEL} cross-company` }), 'delete');
    denied(await api('POST', `/patrols/evidence/${i.e1}/restore`, ownerB.token, { reason: `${LABEL} cross-company` }), 'restore a deleted photo');
    for (const body of [{ scope: 'evidence', evidenceId: i.e2 }, { scope: 'run', runId: i.run }, { scope: 'shift', shiftId: i.shift },
      { scope: 'site_date_range', siteId: i.site, fromDate: now().slice(0, 10), toDate: now().slice(0, 10) }]) {
      denied(await api('POST', '/patrols/holds', ownerB.token, { reason: `${LABEL} cross-company`, ...body }), `${body.scope} hold`);
    }
    const e2 = await download(ownerA.token, i.e2);
    must(e2.status === 200, `A's photo was affected (A download ${e2.status})`);
    const e1 = await api('GET', `/patrols/runs/${i.run}/evidence`, ownerA.token);
    must(e1.status === 200 && e1.body.find((e) => Number(e.id) === i.e1)?.retentionStatus === 'quarantined', 'A\'s deleted photo changed state');
    return xNote;
  });
  await check('X3', 'company B cannot release A\'s hold; A\'s hold stays active', async () => {
    const i = ids();
    must(i.hold, 'blocked: no hold');
    denied(await api('POST', `/patrols/holds/${i.hold}/release`, ownerB.token, { reason: `${LABEL} cross-company` }), 'release');
    const list = await api('GET', '/patrols/holds', ownerA.token);
    must(list.status === 200 && list.body.some((h) => Number(h.id) === i.hold && !h.releasedAt), 'A\'s hold is no longer active');
    return xNote;
  });
  await check('X4', 'company B\'s own lists never include A\'s runs, holds or sites', async () => {
    const i = ids();
    const runs = await api('GET', '/patrols/runs?pageSize=100', ownerB.token);
    const holds = await api('GET', '/patrols/holds?status=all', ownerB.token);
    const usage = await api('GET', '/patrols/storage-usage', ownerB.token);
    if (!strong) {
      for (const [r, w] of [[runs, 'runs'], [holds, 'holds'], [usage, 'usage']]) denied(r, w);
      return xNote;
    }
    must(runs.status === 200 && !runs.body.items.some((r) => Number(r.id) === i.run), 'B\'s run list includes A\'s run');
    must(holds.status === 200 && !holds.body.some((h) => Number(h.id) === i.hold), 'B\'s hold list includes A\'s hold');
    must(usage.status === 200 && !usage.body.sites.some((s) => Number(s.siteId) === i.site), 'B\'s metering includes A\'s site');
    for (const r of [runs, holds, usage]) for (const s of secretsOfA()) must(!r.text.includes(s), 'a B list carries A data');
    return xNote;
  });
  await check('X5', 'nobody but the run\'s Guard can upload to or complete it (B Owner: role 403; Guard Bravo: 404)', async () => {
    const i = ids();
    must(i.run && i.e2, 'blocked: no run / evidence');
    const image = jpeg();
    const body = { clientEvidenceId: cid('x'), kind: 'run_photo', contentType: 'image/jpeg', sizeBytes: image.length, sha256: sha(image), capturedAtDevice: now() };
    const asB = await api('POST', `/patrols/runs/${i.run}/evidence`, ownerB.token, body);
    must(asB.status === 403, `company B Owner upload answered ${asB.status}`);
    const asBravo = await api('POST', `/patrols/runs/${i.run}/evidence`, bravo.token, body);
    must(asBravo.status === 404 && code(asBravo) === 'PATROL_NOT_FOUND', `Guard Bravo upload answered ${asBravo.status} ${code(asBravo)}`);
    const completeBravo = await complete(bravo.token, i.e2);
    must(completeBravo.status === 404, `Guard Bravo complete answered ${completeBravo.status}`);
    const planBravo = await api('GET', `/patrols/mine/plan?shiftId=${i.shift}`, bravo.token);
    must(planBravo.status === 404, `Guard Bravo plan answered ${planBravo.status}`);
    for (const r of [asB, asBravo, completeBravo, planBravo]) for (const s of secretsOfA()) must(!r.text.includes(s), 'a refusal carries A data');
    must(!(asBravo.body && asBravo.body.upload), 'a URL was issued');
    return 'B 403, Bravo 404 ×3';
  });
  await check('X6', 'object keys are company-scoped and server-chosen (never in any API record)', async () => {
    must(state.e1KeyHash, 'blocked: A1');
    const run = await api('GET', `/patrols/runs/${state.runId}/evidence`, ownerA.token);
    expect(run, 200, null, 'A metadata');
    must(!/storageKey|quarantineKey|patrol-incoming\/|patrol-quarantine\/|X-Amz/.test(run.text), 'metadata exposes a key or URL');
    return `upload and download keys carried company ${companyA} (≠ B ${companyB})`;
  });

  // ── D2 ──
  await check('D2', 'Owner restore: active, byte-exact through a fresh link with a new key; restoring again is 409', async () => {
    const e1 = state.evidence.e1;
    must(e1 && e1.deleted, 'blocked: D1');
    const r = await api('POST', `/patrols/evidence/${e1.id}/restore`, ownerA.token, { reason: `${LABEL} restore test` });
    expect(r, 200, null, 'restore');
    must(r.body.retentionStatus === 'active' && r.body.restoredAt && !r.body.quarantinedAt, `state ${r.body.retentionStatus}`);
    must(new Date(r.body.expiresAt).getTime() >= Date.now() + 6.9 * DAY, 'retention not extended to ≥ 7 days');
    const l = await download(ownerA.token, e1.id);
    expect(l, 200, null, 'download after restore');
    const d = assertBucketUrl(l.body.url, target, opts.expectBucket);
    must(d.area === 'patrol' && d.companyId === companyA, 'restored key area / company');
    must(d.keyHash !== state.e1KeyHash, 'the restored photo reuses the deleted key');
    const got = await bucket('GET', l.body.url);
    must(got.status === 200 && sha(got.buf) === sha(state.images.e1), `restored bytes differ (${got.status})`);
    e1.deleted = false;
    expect(await api('POST', `/patrols/evidence/${e1.id}/restore`, ownerA.token, { reason: `${LABEL} restore again` }), 409, 'PATROL_EVIDENCE_STATE_CONFLICT', 'restore of an active photo');
    return `sha ${short(sha(got.buf))} byte-exact, new key#${d.keyHash}`;
  });

  // ── H1 ──
  await check('H1b', 'held photos cannot be deleted (evidence hold, then run hold); released holds stop blocking', async () => {
    const e2 = state.evidence.e2;
    must(e2 && e2.verified && state.evidenceHold, 'blocked: H1a');
    const del = () => api('POST', `/patrols/evidence/${e2.id}/delete`, ownerA.token, { reason: `${LABEL} held deletion` });
    expect(await del(), 409, 'PATROL_EVIDENCE_HELD', 'delete under an evidence hold');
    state.runHold = await placeHold({ scope: 'run', runId: state.runId });
    const release = (id) => api('POST', `/patrols/holds/${id}/release`, ownerA.token, { reason: `${LABEL} release` });
    expect(await release(state.evidenceHold), 200, null, 'release evidence hold');
    state.holds.find((h) => h.id === state.evidenceHold).released = true;
    expect(await del(), 409, 'PATROL_EVIDENCE_HELD', 'delete under a run hold');
    expect(await release(state.runHold), 200, null, 'release run hold');
    state.holds.find((h) => h.id === state.runHold).released = true;
    expect(await release(state.runHold), 409, 'PATROL_HOLD_ALREADY_RELEASED', 'double release');
    const ok = await del();
    expect(ok, 200, null, 'delete after release');
    must(ok.body.retentionStatus === 'quarantined', `retentionStatus ${ok.body.retentionStatus}`);
    e2.deleted = true;
    return `holds ${state.evidenceHold} (evidence), ${state.runHold} (run); evidence ${e2.id} then quarantined`;
  });

  // ── cleanup ──
  await check('C1', 'cleanup: holds released', async () => {
    for (const h of state.holds.filter((x) => !x.released)) {
      const r = await api('POST', `/patrols/holds/${h.id}/release`, ownerA.token, { reason: `${LABEL} cleanup` });
      must(r.status === 200 || code(r) === 'PATROL_HOLD_ALREADY_RELEASED', `release ${h.id}: ${r.status}`);
      h.released = true;
    }
    return `${state.holds.length} hold(s) released`;
  });
  await check('C2', 'cleanup: every verified probe photo deleted to quarantine', async () => {
    const done = [];
    for (const key of ['e1', 'e2']) {
      const e = state.evidence[key];
      if (!e || !e.verified || e.deleted) continue;
      const r = await api('POST', `/patrols/evidence/${e.id}/delete`, ownerA.token, { reason: `${LABEL} cleanup` });
      must(r.status === 200 && r.body.retentionStatus === 'quarantined', `delete ${e.id}: ${r.status} ${code(r) || r.body?.retentionStatus}`);
      e.deleted = true;
      done.push(e.id);
    }
    return done.length ? `deleted ${done.join(', ')}` : 'nothing left active';
  });
  await check('C3', 'cleanup: the probe\'s run completed', async () => {
    if (!state.createdRun) return 'no run created by the probe';
    const r = await api('POST', `/patrols/runs/${state.runId}/complete`, alpha.token, { completedAtDevice: now(), sentAtDevice: now() });
    must(r.status === 200, `complete run answered ${r.status} ${code(r)}`);
    return `run ${state.runId} ${r.body.status}`;
  });
  await check('C4', 'cleanup: the probe\'s shift booked off', async () => {
    if (!state.createdShift) return 'shift not created by the probe; left as it was';
    const r = await api('POST', '/attendance/check-out', alpha.token, { shiftId: state.shiftId, notes: `${LABEL}: probe finished` });
    must(r.status === 201 || r.status === 200, `Book Off answered ${r.status}${r.body?.message ? ` "${String(r.body.message).slice(0, 160)}"` : ''}`);
    return `shift ${state.shiftId} completed`;
  });

  // ── S1 ──
  await check('S1', 'metering moved exactly by the probe\'s transitions', async () => {
    const u = await api('GET', '/patrols/storage-usage', ownerA.token);
    expect(u, 200, null, 'usage');
    const t0 = usage0.body.totals;
    const t1 = u.body.totals;
    const q = 2 + (state.evidence.e3 ? 1 : 0) + (state.extraQuarantined || 0);
    const bytes = [state.images.e1, state.images.e2].filter(Boolean).reduce((a, b) => a + b.length, 0) + (state.evidence.e3 ? state.images.e1.length : 0);
    must(t1.activeObjects - t0.activeObjects === 0, `active objects moved by ${t1.activeObjects - t0.activeObjects}`);
    must(t1.quarantinedObjects - t0.quarantinedObjects === q, `quarantined objects moved by ${t1.quarantinedObjects - t0.quarantinedObjects}, expected ${q}`);
    // e3 is a fresh JPEG of the same generator, so the same length as e1.
    if (!state.extraQuarantined) must(t1.quarantinedBytes - t0.quarantinedBytes === bytes, `quarantined bytes moved by ${t1.quarantinedBytes - t0.quarantinedBytes}, expected ${bytes}`);
    return `quarantined +${q} objects`;
  });

  // ── residue ──
  out('RESIDUE (fictional, on the target):');
  if (state.createdShift) out(`  shift ${state.shiftId} (completed) with its Book On / Book Off events and draft timesheet`);
  if (state.createdRun) out(`  patrol run ${state.runId}`);
  for (const [k, e] of Object.entries(state.evidence)) {
    if (!e) continue;
    const r = await api('GET', `/patrols/runs/${state.runId}/evidence`, ownerA.token).catch(() => null);
    const row = r && r.status === 200 ? r.body.find((x) => Number(x.id) === e.id) : null;
    out(`  evidence ${e.id} (${k}): ${row ? `${row.uploadStatus}/${row.retentionStatus}${row.purgeAfter ? `, purgeAfter ${row.purgeAfter}` : ''}` : 'state unknown'}`);
  }
  if (state.extraQuarantined) out(`  ${state.extraQuarantined} extra rejected record(s) from a tampered PUT the provider accepted`);
  out(`  holds ${state.holds.map((h) => `${h.id}${h.released ? ' released' : ' ACTIVE'}`).join(', ') || 'none'}`);
  out('  bucket: one patrol-quarantine/ object per quarantined record above; removed by the maintenance job only with');
  out('  PATROL_EVIDENCE_RETENTION_MODE=enforce after purgeAfter. Records, tombstones and audit entries are permanent by design.');

  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  out(`SUMMARY ${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.join(', ')}` : ''}; isolation ${strong ? 'strong' : 'WEAK'}`);
  return failed.length ? 1 : 0;
}

module.exports = {
  STAGING_ORIGIN, resolveTarget, assertBucketUrl, describeObjectUrl, redact, registerSecret, registerNamesIn, readEnvFile,
  credentialFileProblem, parseArgs, jpeg, PLAN,
};

if (require.main === module) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    out(`USAGE: ${error.message}. See the header of scripts/staging-patrol-evidence-probe.cjs.`);
    process.exit(2);
  }
  main(opts)
    .then((code) => process.exit(code))
    .catch((error) => {
      if (error instanceof Precondition) {
        out(`PRECONDITION NOT MET (nothing written): ${error.message}`);
        process.exit(2);
      }
      out(`ERROR ${error && error.message && error.message.startsWith('REFUSED') ? error.message : String((error && error.stack) || error)}`);
      process.exit(error && error.message && error.message.startsWith('REFUSED') ? 2 : 1);
    });
}
