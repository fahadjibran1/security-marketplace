/**
 * Patrol Management P1-C (Migration 70) certification: patrol photo evidence storage, integrity and retention. The whole
 * application over HTTP against an in-process S3-compatible server that verifies SigV4 independently
 * (scripts/fixtures/fake-s3-server.ts), on a disposable database built from the repository's own migrations. The patrol
 * sweep's, the safety sweep's and the evidence maintenance job's timers are stopped so every pass is explicit.
 *
 * Storage primitives (pure)
 *   PE-S01  SigV4 presigning matches the AWS documentation's published example; R2-style ('auto', path-style) URLs
 *   PE-S02  configuration fails closed (unconfigured, http, bad TTL / cap / prefix) and never reports a secret
 *   PE-S03  object keys: tenant-scoped, server-generated v4 UUIDs (unguessable), no personal data; foreign keys refused
 *   PE-S04  image validation: real JPEG / PNG / WebP / HEIC accepted; non-images, type mismatches, polyglots (image + ZIP,
 *           even ending in a fake EOI; image + HTML), embedded markup and truncation rejected; chunking never matters
 *   PE-S05  the streaming ZIP writer: stored entries, CRC-32, readable by its own parser and an independent reader
 * Upload intent (Guard)
 *   PE-U01  own run: a pending record and a presigned PUT to the tenant's incoming area (structure only; never printed)
 *   PE-U02  authorisation: another Guard's run, another company's Guard, company staff, switch off, location fields
 *   PE-U03  content-type allow-list, size cap, hash format; a client-supplied storage key is refused
 *   PE-U04  idempotent per clientEvidenceId (same → same record, new URL; different → 409; concurrent → one row)
 *   PE-U05  unconfigured storage: 503 PATROL_EVIDENCE_STORAGE_UNAVAILABLE on every evidence route (after authorisation)
 * Completion and integrity
 *   PE-C01  verified: the bytes are copied into the server-only area and hashed there; size, type, dimensions, SHA-256,
 *           30-day retention from cloud receipt; incoming removed; audited; metered
 *   PE-C02  completion before the upload: 409 PATROL_EVIDENCE_NOT_UPLOADED, nothing changes
 *   PE-C03  a PUT whose bytes do not match the signed checksum is refused by storage; bytes that reach storage with the
 *           wrong hash are REJECTED and QUARANTINED (never accepted, never dropped); repeat completion is stable
 *   PE-C04  non-image, wrong declared type and polyglots are rejected and quarantined through the API
 *   PE-C05  concurrent completion: one verification, one audit, one object, every caller gets the same result
 *   PE-C06  an object over the cap is rejected from its HEAD alone (never read)
 *   PE-C07  a still-valid upload URL can never change a verified photo (separate incoming area)
 * Viewing
 *   PE-D01  download: patrols.evidence roles only, purpose required, presigned GET ≤ 300 s as an attachment, exact bytes;
 *           every issue audited with who / which / why and no URL anywhere in the audit trail
 *   PE-D02  pending, rejected and quarantined photos cannot be viewed
 * Retention, holds and the deletion state machine
 *   PE-R01  30-day boundary exact (enforce); 'report' mode changes nothing; a 90-day policy keeps photos 90 days
 *   PE-H01  holds (photo / run / shift / site and date range): Owner / Admin only, tenant-checked, audited; a hold blocks
 *           retention and manual deletion and cancels a pending claim; release is audited and lets retention proceed
 *   PE-Q01  manual deletion → quarantine (primary removed only after the copy is committed) → restore to a NEW key,
 *           re-hashed, kept ≥ 7 days; permissions and tenancy
 *   PE-P01  purge only after the database commits "purged" (observed at the storage DELETE), tombstone keeps hashes,
 *           sizes and times; a hold blocks the purge of quarantined evidence
 *   PE-P02  storage failures never lose evidence: failed quarantine moves and purges are retried; purge is idempotent
 * Exports
 *   PE-E01  authorisation, tenancy, scope validation and bounds (31 days, 500 photos, 2 in flight)
 *   PE-E02  ZIP + manifest: included / held / quarantined / rejected / pending / purged items listed; manifest hash; ZIP
 *           hash; photo bytes re-hashed; download audited; 24 h expiry removes the ZIP and keeps the record
 *   PE-E03  a failed build is recorded with a safe error, audited, and retried on a later pass (never immediately)
 * Metering, late sync, recovery
 *   PE-M01  live usage equals a recount through every transition; Owner / Admin only; tenant-scoped
 *   PE-L01  late sync with P1-B: a photo after Book Off (within 24 h) is accepted and flagged; after the window refused;
 *           a URL issued inside the window can still be completed; a photo after an "evidence missing" alert annotates
 *           the exception and downgrades the alert — NEVER closes it
 *   PE-O01  an upload whose completion never arrived is verified by the maintenance job (after 10 minutes)
 *   PE-W01  switch off (#71): new uploads / completions / other routes stay 404, but retention expiry, holds, manual
 *           deletion and restore, the quarantine → purge → tombstone machine, orphan verification and exports (already
 *           requested and new) continue; Owner / Admin only; a switched-off company without evidence sees nothing
 *   PE-T01  cross-tenant: every new route refuses another company's ids (404) and another company's Guard
 *   PE-X01  compliance / screening EvidenceStorageService is untouched and refuses patrol keys; no signed URL, signature or
 *           credential is ever stored in the database (audit, errors) or returned in metadata
 *
 * Needs PATROL_EVIDENCE_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { startFakeS3 } from './fixtures/fake-s3-server';
import { heic, jpeg, png, sha256, webp, zipTail } from './fixtures/patrol-test-images';

const url = process.env.PATROL_EVIDENCE_DATABASE_URL;
if (!url) throw new Error('PATROL_EVIDENCE_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Patrol evidence database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-evidence-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
for (const key of ['RESEND_API_KEY', 'EXPO_ACCESS_TOKEN', 'PUSH_WELFARE_REMINDERS_ENABLED', 'PUSH_GUARD_NOTIFICATIONS_ENABLED', 'PATROL_QR_SIGNING_KEY',
  'PATROL_QR_PREVIOUS_SIGNING_KEY', 'PATROL_EVIDENCE_STORAGE_PREFIX', 'PATROL_EVIDENCE_MAX_BYTES', 'PATROL_EVIDENCE_URL_TTL_SECONDS',
  'PATROL_EVIDENCE_STORAGE_CHECKSUM_HEADER', 'PATROL_EVIDENCE_STORAGE_SIGN_CONTENT_LENGTH', 'PATROL_EVIDENCE_RETENTION_MODE']) {
  delete process.env[key];
}
// Synthetic test-only credentials for the in-process storage server (not a real account, never used anywhere else).
const STORAGE = { accessKeyId: 'S4TESTACCESSKEY000001', secretAccessKey: 'synthetic-test-secret-not-a-real-credential-0001', bucket: 's4-patrol-evidence-test', region: 'auto' };

let passed = 0;
const failures: string[] = [];
const test = async (id: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failures.push(id);
    // Never print a presigned URL: strip anything URL-like from failure output.
    const text = String((error as Error)?.stack ?? error).replace(/https?:\/\/\S+/g, '[url]').replace(/X-Amz-[A-Za-z]+=[^&\s"]+/g, '[redacted]');
    console.log(`FAIL  ${id}\n      ${text.split('\n').slice(0, 12).join('\n      ')}`);
  }
};

type Res = { status: number; body: any };
const PASSWORD = 'patrol-evidence-spec-only-password-1';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
let seqId = 0;
const cid = (p: string) => `${p}-${Date.now().toString(36)}-${(++seqId).toString().padStart(5, '0')}`;

async function main() {
  const fake = await startFakeS3(STORAGE);
  const setStorageEnv = () => {
    process.env.PATROL_EVIDENCE_STORAGE_ENDPOINT = fake.url;
    process.env.PATROL_EVIDENCE_STORAGE_REGION = STORAGE.region;
    process.env.PATROL_EVIDENCE_STORAGE_BUCKET = STORAGE.bucket;
    process.env.PATROL_EVIDENCE_STORAGE_ACCESS_KEY_ID = STORAGE.accessKeyId;
    process.env.PATROL_EVIDENCE_STORAGE_SECRET_ACCESS_KEY = STORAGE.secretAccessKey;
  };
  const clearStorageEnv = () => {
    for (const k of ['ENDPOINT', 'REGION', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) delete process.env[`PATROL_EVIDENCE_STORAGE_${k}`];
  };
  setStorageEnv();

  const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
  const allFiles: string[] = fs.readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).sort();
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const base = buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' });
  const migrate = new DataSource({ ...base, entities: [], migrations: allFiles.map((f) => path.join(migrationsDir, f)), dropSchema: true } as never);
  await migrate.initialize();
  const migrated = await migrate.runMigrations({ transaction: 'each' });
  assert.equal(migrated[migrated.length - 1]?.name, 'AddPatrolEvidenceStorage1720900000016', 'the head is Migration 70');
  await migrate.destroy();

  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const ds = app.get(DataSource);
  const [{ current_database: db }] = await ds.query('SELECT current_database()');
  if (db !== new URL(url!).pathname.slice(1)) throw new Error(`Refusing: connected to ${db}`);

  const { PatrolSweepService } = await import('../src/patrol/patrol-sweep.service');
  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const { AuthService } = await import('../src/auth/auth.service');
  const { PatrolEvidenceMaintenanceService } = await import('../src/patrol/evidence/patrol-evidence-maintenance.service');
  const { PatrolEvidenceExportService } = await import('../src/patrol/evidence/patrol-evidence-export.service');
  const { PatrolEvidenceService } = await import('../src/patrol/evidence/patrol-evidence.service');
  const { recountUsage, storedUsage, safeError } = await import('../src/patrol/evidence/patrol-evidence-shared');
  const keys = await import('../src/patrol/evidence/patrol-evidence-keys');
  const { readPatrolStorageConfig, PatrolStorageError } = await import('../src/patrol/evidence/patrol-object-store');
  const { presignV4, pathStyleUri } = await import('../src/patrol/evidence/sigv4');
  const { ImageInspector } = await import('../src/patrol/evidence/patrol-image-inspector');
  const { ZipFileWriter, readZipDirectory, readZipEntry, crc32 } = await import('../src/patrol/evidence/patrol-zip-writer');
  const sweeper = app.get(PatrolSweepService);
  const safety = app.get(SafetyAlertService);
  const maint = app.get(PatrolEvidenceMaintenanceService);
  const exportsSvc = app.get(PatrolEvidenceExportService);
  const evidenceSvc = app.get(PatrolEvidenceService);
  sweeper.onModuleDestroy();
  safety.onModuleDestroy();
  maint.onModuleDestroy(); // every maintenance pass in this suite is explicit, on its own clock
  const auth = app.get(AuthService);

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const count = async (sql: string, params: unknown[] = []) => Number(Object.values((await q(sql, params))[0] ?? {})[0]);
  const api = async (method: string, p: string, tok: string | null, body?: unknown): Promise<Res> => {
    const res = await fetch(baseUrl + p, {
      method,
      headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };
  const expect = (r: Res, status: number, code?: string, what = '') => {
    const safeBody = JSON.stringify(r.body).replace(/https?:\/\/[^"]+/g, '[url]');
    assert.equal(r.status, status, `${what} expected ${status}${code ? ` ${code}` : ''}, got ${r.status} ${safeBody}`);
    if (code) assert.equal(r.body?.code, code, `${what} code: ${safeBody}`);
  };
  const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;

  // ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash(PASSWORD, 4);
  let seq = 0;
  const mkUser = async (email: string, role: string) =>
    Number((await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
       VALUES ($1,$2,$3,'active',true,false,$4,'Spec') RETURNING id`, [email, hash, role, email.split('@')[0]])).id);
  const testCompanies: number[] = [];
  const mkCompany = async (label: string) => {
    seq += 1;
    const ownerEmail = `pe.${label}.owner@example.invalid`;
    const ownerId = await mkUser(ownerEmail, 'company_admin');
    const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,$2,$3,'1 Way','ops@example.invalid',true) RETURNING id`,
      [ownerId, `PE ${label} Ltd`, String(70000000 + seq)]);
    testCompanies.push(Number(id));
    return { id: Number(id), ownerId, ownerEmail, token: await login(ownerEmail) };
  };
  const mkSite = async (companyId: number, name: string, tz = 'Europe/London') =>
    Number((await one(`INSERT INTO sites ("companyId",name,address,timezone) VALUES ($1,$2,'3 Quay',$3) RETURNING id`, [companyId, name, tz])).id);
  const mkGuard = async (label: string) => {
    seq += 1;
    const email = `pe.${label}@example.invalid`;
    const userId = await mkUser(email, 'guard');
    const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, `Guard ${label}`, `70${String(seq).padStart(14, '0')}`, `0772${String(seq).padStart(7, '0')}`]);
    return { id: Number(id), userId, email, token: await login(email) };
  };
  const mkMember = async (companyId: number, label: string, role: string) => {
    const email = `pe.${label}.${role}@example.invalid`;
    const userId = await mkUser(email, 'company_admin');
    await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [userId, companyId, role]);
    return { userId, token: await login(email) };
  };
  const mkShift = async (companyId: number, siteId: number, guardId: number, start: Date, end: Date, status = 'in_progress') =>
    Number((await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Gate',$3,$4,$5,$6) RETURNING id`,
      [companyId, siteId, guardId, status, start, end])).id);
  const bookOn = (shiftId: number, guardId: number, at: Date) =>
    q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-in',$3,$3,false)`, [shiftId, guardId, at]);
  const bookOff = async (shiftId: number, guardId: number, at: Date) => {
    await q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-out',$3,$3,false)`, [shiftId, guardId, at]);
    await q(`UPDATE shifts SET status = 'completed' WHERE id = $1`, [shiftId]);
  };
  const insRun = async (companyId: number, siteId: number, shiftId: number, guard: { id: number; userId: number }, startedAt: Date, status = 'in_progress') =>
    one(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId",status,"startedAtDevice","startedAtServer","completedAtDevice","completedAtServer","clientRunId")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$8,$9) RETURNING *`,
      [companyId, siteId, shiftId, guard.id, guard.userId, status, startedAt, status === 'in_progress' ? null : new Date(startedAt.getTime() + 10 * MIN), cid('run')]);
  /** A Guard on an in-progress shift with a run in progress: the usual starting point. */
  const scenario = async (label: string) => {
    const co = await mkCompany(label);
    const site = await mkSite(co.id, `${label} Gate`);
    const guard = await mkGuard(`${label}g`);
    const now = Date.now();
    const shift = await mkShift(co.id, site, guard.id, new Date(now - 2 * HOUR), new Date(now + 6 * HOUR));
    await bookOn(shift, guard.id, new Date(now - 2 * HOUR));
    const run = await insRun(co.id, site, shift, guard, new Date(now - 30 * MIN));
    return { co, site, guard, shift, run };
  };
  const setPolicy = (companyId: number, siteId: number, fields: Record<string, unknown>) => {
    const cols = Object.keys(fields);
    return q(`INSERT INTO patrol_policies ("companyId","siteId",${cols.map((c) => `"${c}"`).join(',')}) VALUES ($1,$2,${cols.map((_, i) => `$${i + 3}`).join(',')})
      ON CONFLICT ("companyId","siteId") WHERE "siteId" IS NOT NULL DO UPDATE SET ${cols.map((c, i) => `"${c}" = $${i + 3}`).join(',')}`,
      [companyId, siteId, ...cols.map((c) => fields[c])]);
  };
  /**
   * Only this company is processed while fn runs: Patrols is switched on for it alone (so a sweep judges only it) and
   * maintenance passes are scoped to it (since #71 maintenance also processes switched-off companies' evidence).
   */
  let maintScope: number[] | null = null;
  const maintRun = (at: Date, mode: 'report' | 'enforce') => maint.run(at, mode, maintScope ? { companyIds: maintScope } : undefined);
  const only = async <T>(companyId: number, fn: () => Promise<T>): Promise<T> => {
    await q(`UPDATE companies SET "patrolsEnabled" = (id = $1) WHERE id = ANY($2::int[])`, [companyId, testCompanies]);
    maintScope = [companyId];
    try {
      return await fn();
    } finally {
      maintScope = null;
      await q(`UPDATE companies SET "patrolsEnabled" = true WHERE id = ANY($1::int[])`, [testCompanies]);
    }
  };

  const body = (image: Buffer, extra: Record<string, unknown> = {}) => ({
    clientEvidenceId: cid('ev'), kind: 'run_photo', contentType: 'image/jpeg', sizeBytes: image.length, sha256: sha256(image),
    capturedAtDevice: new Date(Date.now() - 5 * MIN).toISOString(), ...extra,
  });
  const intent = (tok: string, runId: number, b: Record<string, unknown>) => api('POST', `/patrols/runs/${runId}/evidence`, tok, b);
  const put = (upload: any, bytes: Buffer, headers?: Record<string, string>) =>
    fetch(upload.url, { method: 'PUT', headers: headers ?? upload.headers, body: new Uint8Array(bytes) });
  const complete = (tok: string, id: number) => api('POST', `/patrols/evidence/${id}/complete`, tok);
  /** Intent → PUT → complete, through the API. */
  const uploadPhoto = async (tok: string, runId: number, image: Buffer, extra: Record<string, unknown> = {}) => {
    const r = await intent(tok, runId, body(image, extra));
    expect(r, 201, undefined, 'intent');
    const res = await put(r.body.upload, image);
    assert.equal(res.status, 200, 'the signed PUT is accepted by storage');
    const c = await complete(tok, r.body.evidence.id);
    expect(c, 200, undefined, 'complete');
    return c.body;
  };
  const row = (id: number) => one(`SELECT * FROM patrol_evidence WHERE id = $1`, [id]);
  const usageMatches = async (companyId: number, what: string) => {
    assert.deepEqual(await storedUsage(ds, companyId), await recountUsage(ds, companyId), `live usage equals a recount: ${what}`);
  };
  const noSecretsIn = (value: unknown, what: string) => {
    const text = JSON.stringify(value);
    for (const needle of ['X-Amz-Signature', 'X-Amz-Credential', STORAGE.secretAccessKey, STORAGE.accessKeyId, fake.url]) {
      assert.ok(!text.includes(needle), `${what} must not contain a URL, signature or credential`);
    }
  };

  const A = await scenario('alpha');
  const B = await scenario('beta');
  const gA2 = await mkGuard('alpha2');
  const staffA: Record<string, { userId: number; token: string }> = {};
  for (const role of ['admin', 'operations', 'control_room', 'viewer', 'finance', 'hr_compliance']) staffA[role] = await mkMember(A.co.id, 'alpha', role);
  const platformEmail = 'pe.platform@example.invalid';
  await mkUser(platformEmail, 'admin');
  const platform = await login(platformEmail);

  try {
    // ═══════════════════ Storage primitives (pure) ═══════════════════

    await test('PE-S01-SIGV4-MATCHES-THE-AWS-PUBLISHED-EXAMPLE-AND-R2-STYLE-URLS', () => {
      // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html (example GET of test.txt)
      const aws = presignV4({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', canonicalUri: '/test.txt', region: 'us-east-1',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', expiresSeconds: 86400, now: new Date('2013-05-24T00:00:00Z') });
      assert.equal(aws.query.split('X-Amz-Signature=')[1], 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
      const r2 = presignV4({ method: 'PUT', host: 'acct.r2.cloudflarestorage.com', canonicalUri: pathStyleUri('/', 'bucket', 'patrol-incoming/1/2026/10/x'),
        region: 'auto', accessKeyId: 'k', secretAccessKey: 's', expiresSeconds: 120, now: new Date(), headers: { 'Content-Type': 'image/jpeg' } });
      const params = new URLSearchParams(r2.query);
      assert.match(params.get('X-Amz-Credential')!, /^k\/\d{8}\/auto\/s3\/aws4_request$/, 'R2 signs with region "auto"');
      assert.equal(params.get('X-Amz-SignedHeaders'), 'content-type;host');
      assert.equal(pathStyleUri('/', 'bucket', 'patrol/1/2026/10/a'), '/bucket/patrol/1/2026/10/a', 'path-style');
      assert.throws(() => presignV4({ ...{ method: 'GET', host: 'h', canonicalUri: '/b/k', region: 'auto', accessKeyId: 'k', secretAccessKey: 's', now: new Date() }, expiresSeconds: 604_801 } as never));
    });

    await test('PE-S02-CONFIGURATION-FAILS-CLOSED-AND-NEVER-REPORTS-A-SECRET', () => {
      const good = { PATROL_EVIDENCE_STORAGE_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', PATROL_EVIDENCE_STORAGE_BUCKET: 'b-patrol',
        PATROL_EVIDENCE_STORAGE_ACCESS_KEY_ID: 'AKSECRETISH', PATROL_EVIDENCE_STORAGE_SECRET_ACCESS_KEY: 'very-secret-value' };
      const ok = readPatrolStorageConfig(good as never);
      assert.ok(ok.ok && ok.config.region === 'auto' && ok.config.urlTtlSeconds === 120 && ok.config.maxObjectBytes === 10 * 1024 * 1024);
      assert.deepEqual(readPatrolStorageConfig({} as never), { ok: false, reason: 'not configured' });
      const bad: Array<Record<string, string>> = [
        { ...good, PATROL_EVIDENCE_STORAGE_SECRET_ACCESS_KEY: '' },
        { ...good, PATROL_EVIDENCE_STORAGE_ENDPOINT: 'http://storage.example.com' },
        { ...good, PATROL_EVIDENCE_URL_TTL_SECONDS: '301' },
        { ...good, PATROL_EVIDENCE_URL_TTL_SECONDS: '59' },
        { ...good, PATROL_EVIDENCE_MAX_BYTES: String(26 * 1024 * 1024) },
        { ...good, PATROL_EVIDENCE_STORAGE_PREFIX: 'Bad/Prefix' },
        { ...good, PATROL_EVIDENCE_STORAGE_ENDPOINT: 'https://user:pw@storage.example.com' },
      ];
      for (const env of bad) {
        const r = readPatrolStorageConfig(env as never);
        assert.equal(r.ok, false, JSON.stringify(Object.keys(env)));
        if (!r.ok) assert.ok(!r.reason.includes('very-secret-value') && !r.reason.includes('AKSECRETISH'), 'the reason never echoes a credential');
      }
      assert.ok(readPatrolStorageConfig({ ...good, PATROL_EVIDENCE_STORAGE_ENDPOINT: 'http://127.0.0.1:9000' } as never).ok, 'plain http only for a local test server');
      const err = new PatrolStorageError('get', 403, 'unexpected_status');
      assert.ok(!/https?:|X-Amz/.test(err.message), 'storage errors carry no URL');
      assert.equal(safeError(new Error('failed http://x.example/b/k?X-Amz-Signature=abc')), 'failed [url]');
    });

    await test('PE-S03-KEYS-ARE-TENANT-SCOPED-UNGUESSABLE-AND-FREE-OF-PERSONAL-DATA', () => {
      const at = new Date('2026-10-29T12:00:00Z');
      const k = keys.patrolObjectKey('evidence', 42, at, null);
      assert.match(k, /^patrol\/42\/2026\/10\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const many = new Set(Array.from({ length: 2000 }, () => keys.patrolObjectKey('evidence', 42, at, null)));
      assert.equal(many.size, 2000, 'no collisions: 122 random bits per key');
      assert.equal(keys.siblingKey(k, 'incoming'), k.replace(/^patrol\//, 'patrol-incoming/'));
      assert.match(keys.patrolObjectKey('export', 42, at, 'staging'), /^staging\/patrol-exports\/42\/2026\/10\/[0-9a-f-]{36}\.zip$/);
      assert.ok(keys.keyBelongsTo(k, 42) && !keys.keyBelongsTo(k, 43), 'tenant check');
      for (const bad of ['patrol/42/2026/10/../../43/x', 'compliance/guard/1/' + randomUUID(), `patrol/42/2026/13/${randomUUID()}`, `patrol/0/2026/10/${randomUUID()}`,
        `patrol/42/2026/10/${randomUUID()}.zip`, `patrol-exports/42/2026/10/${randomUUID()}`, `/patrol/42/2026/10/${randomUUID()}`]) {
        assert.equal(keys.isPatrolKey(bad), false, bad);
      }
    });

    await test('PE-S04-IMAGE-VALIDATION-REAL-IMAGES-PASS-POLYGLOTS-AND-NON-IMAGES-FAIL', () => {
      const inspect = (bytes: Buffer, mime: string, chunk = 4096) => {
        const i = new ImageInspector();
        for (let o = 0; o < bytes.length; o += chunk) i.update(bytes.subarray(o, o + chunk));
        return i.finish(mime);
      };
      const cases: Array<[string, Buffer, string, string[]]> = [
        ['jpeg', jpeg(), 'image/jpeg', []],
        ['jpeg with EXIF', jpeg({ exif: true, width: 64, height: 48 }), 'image/jpeg', []],
        ['png', png(), 'image/png', []],
        ['webp', webp(), 'image/webp', []],
        ['heic', heic(), 'image/heic', []],
        ['text', Buffer.from('this is plain text pretending to be a photograph, nothing more ....'), 'image/jpeg', ['not_an_image']],
        ['png declared jpeg', png(), 'image/jpeg', ['content_type_mismatch']],
        ['jpeg + zip', Buffer.concat([jpeg(), zipTail()]), 'image/jpeg', ['trailing_data']],
        ['jpeg + zip + fake EOI', Buffer.concat([jpeg(), zipTail(), Buffer.from([0xff, 0xd9])]), 'image/jpeg', ['trailing_data']],
        ['png + html', Buffer.concat([png(), Buffer.from('<html><body>x</body></html>')]), 'image/png', ['trailing_data', 'embedded_markup']],
        ['jpeg with script', jpeg({ comment: 'x <SCRIPT>alert(1)</SCRIPT>' }), 'image/jpeg', ['embedded_markup']],
        ['jpeg truncated', jpeg().subarray(0, 150), 'image/jpeg', ['truncated']],
        ['webp + tail', Buffer.concat([webp(), Buffer.from('trailing')]), 'image/webp', ['trailing_data']],
      ];
      for (const [name, bytes, mime, problems] of cases) {
        const whole = inspect(bytes, mime, bytes.length);
        assert.deepEqual(whole.problems, problems, name);
        assert.equal(whole.sha256, sha256(bytes), `${name}: hashes exactly the bytes`);
        for (const chunk of [1, 3, 64]) assert.deepEqual(inspect(bytes, mime, chunk), whole, `${name}: chunking (${chunk}) never changes the result`);
      }
      assert.deepEqual([inspect(jpeg({ width: 40, height: 24, exif: true }), 'image/jpeg').width, inspect(png({ width: 7, height: 3 }), 'image/png').height], [40, 3]);
    });

    await test('PE-S05-STREAMING-ZIP-WRITER-IS-READABLE-BY-AN-INDEPENDENT-READER', async () => {
      const file = path.join(os.tmpdir(), `pe-zip-${randomUUID()}.zip`);
      const a = jpeg();
      const b = Buffer.alloc(200_000, 7);
      try {
        const zip = await ZipFileWriter.create(file);
        async function* chunks() {
          for (let o = 0; o < b.length; o += 10_000) yield b.subarray(o, o + 10_000);
        }
        await zip.addBuffer('photos/run-1/evidence-1.jpg', a, new Date());
        await zip.addStream('photos/run-1/evidence-2.bin', chunks(), new Date());
        await zip.addBuffer('manifest.json', Buffer.from('{"ok":true}\n'), new Date());
        await zip.close();
        const buf = fs.readFileSync(file);
        const dir = readZipDirectory(buf);
        assert.deepEqual(dir.map((e) => [e.name, e.method, e.size]), [['photos/run-1/evidence-1.jpg', 0, a.length], ['photos/run-1/evidence-2.bin', 0, b.length], ['manifest.json', 0, 12]]);
        assert.ok(readZipEntry(buf, dir[1]).equals(b));
        assert.equal(dir[0].crc, crc32(a));
        await assert.rejects(() => zip.addBuffer('x', a, new Date()));
        const reader = independentZipCheck(file);
        console.log(`      (independent ZIP reader: ${reader})`);
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    // ═══════════════════ Upload intent ═══════════════════

    let firstEvidence: any;
    await test('PE-U01-OWN-RUN-GETS-A-PENDING-RECORD-AND-A-SHORT-LIVED-PRESIGNED-PUT', async () => {
      const image = jpeg();
      const b = body(image);
      const r = await intent(A.guard.token, A.run.id, b);
      expect(r, 201);
      firstEvidence = r.body.evidence;
      assert.deepEqual([r.body.evidence.uploadStatus, r.body.evidence.retentionStatus, r.body.evidence.sha256Client, r.body.evidence.declaredSizeBytes],
        ['pending', 'active', b.sha256, image.length]);
      const up = r.body.upload;
      const u = new URL(up.url);
      assert.equal(up.method, 'PUT');
      assert.equal(u.origin, fake.url);
      assert.match(u.pathname, new RegExp(`^/${STORAGE.bucket}/patrol-incoming/${A.co.id}/\\d{4}/\\d{2}/[0-9a-f-]{36}$`), 'the tenant\'s incoming area, a server-chosen key');
      const expires = Number(u.searchParams.get('X-Amz-Expires'));
      assert.ok(expires >= 60 && expires <= 300, `short-lived (${expires}s)`);
      assert.deepEqual(u.searchParams.get('X-Amz-SignedHeaders')!.split(';').sort(), ['content-length', 'content-type', 'host', 'x-amz-checksum-sha256']);
      assert.deepEqual(Object.keys(up.headers).sort(), ['Content-Type', 'x-amz-checksum-sha256']);
      assert.ok(Date.parse(up.expiresAt) - Date.now() <= 300_000);
      const segments = u.pathname.split('/').slice(2);
      assert.deepEqual([segments.length, segments[0], segments[1]], [5, 'patrol-incoming', String(A.co.id)], 'area / company / yyyy / mm / uuid — nothing else');
      assert.ok(!u.pathname.includes(b.clientEvidenceId) && !u.pathname.toLowerCase().includes('guard'), 'no client id or person in the key');
      const stored = await row(firstEvidence.id);
      assert.equal(stored.storageKey.startsWith(`patrol/${A.co.id}/`), true);
      assert.ok(stored.uploadUrlIssuedAt);
      const [audit] = await q(`SELECT * FROM audit_logs WHERE action = 'patrol.evidence_upload_requested' AND "entityId" = $1`, [firstEvidence.id]);
      assert.ok(audit && Number(audit.userId) === A.guard.userId);
      noSecretsIn(audit, 'the audit entry');
      noSecretsIn(r.body.evidence, 'the evidence record');
      assert.ok(!('storageKey' in r.body.evidence) && !('quarantineKey' in r.body.evidence));
      // Clean up the upload for later tests.
      assert.equal((await put(up, image)).status, 200);
      expect(await complete(A.guard.token, firstEvidence.id), 200);
    });

    await test('PE-U02-AUTHORISATION-ONLY-THE-GUARD-S-OWN-RUN-WITH-THE-SWITCH-ON', async () => {
      const image = jpeg();
      expect(await intent(gA2.token, A.run.id, body(image)), 404, 'PATROL_NOT_FOUND', 'another Guard of the same company');
      expect(await intent(B.guard.token, A.run.id, body(image)), 404, 'PATROL_NOT_FOUND', 'another company\'s Guard');
      expect(await intent(A.co.token, A.run.id, body(image)), 403, undefined, 'company staff use no Guard route');
      expect(await intent(platform, A.run.id, body(image)), 403, undefined, 'platform admin');
      expect(await intent(A.guard.token, 999999, body(image)), 404, 'PATROL_NOT_FOUND');
      expect(await intent(A.guard.token, A.run.id, body(image, { latitude: 51.5, longitude: -0.1 })), 400, 'PATROL_LOCATION_VERIFICATION_DISABLED');
      await q(`UPDATE companies SET "patrolsEnabled" = false WHERE id = $1`, [A.co.id]);
      try {
        expect(await intent(A.guard.token, A.run.id, body(image)), 404, 'PATROLS_NOT_ENABLED', 'switch off');
        expect(await complete(A.guard.token, firstEvidence.id), 404, 'PATROLS_NOT_ENABLED', 'switch off (complete)');
        expect(await api('GET', `/patrols/evidence/${firstEvidence.id}/download?purpose=review`, A.co.token), 404, 'PATROLS_NOT_ENABLED');
      } finally {
        await q(`UPDATE companies SET "patrolsEnabled" = true WHERE id = $1`, [A.co.id]);
      }
      expect(await complete(B.guard.token, firstEvidence.id), 404, 'PATROL_NOT_FOUND', 'another company\'s Guard cannot complete');
      expect(await complete(gA2.token, firstEvidence.id), 404, 'PATROL_NOT_FOUND', 'another Guard cannot complete');
      expect(await api('POST', `/patrols/evidence/${firstEvidence.id}/complete`, A.co.token), 403, undefined, 'staff cannot complete');
    });

    await test('PE-U03-CONTENT-TYPE-ALLOW-LIST-SIZE-CAP-HASH-FORMAT-AND-NO-CLIENT-KEYS', async () => {
      const image = jpeg();
      for (const contentType of ['image/gif', 'application/pdf', 'text/html', 'image/svg+xml', 'IMAGE/JPEG']) {
        expect(await intent(A.guard.token, A.run.id, body(image, { contentType })), 400, 'PATROL_EVIDENCE_TYPE_NOT_ALLOWED', contentType);
      }
      for (const [contentType, img] of [['image/png', png()], ['image/webp', webp()], ['image/heic', heic()]] as Array<[string, Buffer]>) {
        expect(await intent(A.guard.token, A.run.id, { ...body(img), contentType }), 201, undefined, contentType);
      }
      expect(await intent(A.guard.token, A.run.id, body(image, { sizeBytes: 10 * 1024 * 1024 + 1 })), 400, 'PATROL_EVIDENCE_TOO_LARGE');
      expect(await intent(A.guard.token, A.run.id, body(image, { sizeBytes: 10 * 1024 * 1024 })), 201, undefined, 'exactly the cap');
      expect(await intent(A.guard.token, A.run.id, body(image, { sizeBytes: 0 })), 400);
      expect(await intent(A.guard.token, A.run.id, body(image, { sha256: 'ABC' })), 400);
      expect(await intent(A.guard.token, A.run.id, body(image, { sha256: 'A'.repeat(64) })), 400, undefined, 'lowercase hex only');
      expect(await intent(A.guard.token, A.run.id, body(image, { storageKey: `patrol/${B.co.id}/2026/10/${randomUUID()}` })), 400, undefined, 'a client-supplied key is refused');
      expect(await intent(A.guard.token, A.run.id, body(image, { kind: 'checkpoint_photo' })), 400, 'PATROL_VALIDATION_FAILED', 'checkpoint photo needs its scan');
      const bVisit = await one(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","scannedPublicId",result,"scannedAtDevice","clientVisitId") VALUES ($1,$2,$3,'unverified',now(),$4) RETURNING id`,
        [B.co.id, B.run.id, 'c'.repeat(32), cid('visit')]);
      expect(await intent(A.guard.token, A.run.id, body(image, { kind: 'checkpoint_photo', visitId: Number(bVisit.id) })), 400, 'PATROL_VALIDATION_FAILED', 'another company\'s scan');
    });

    await test('PE-U04-IDEMPOTENT-PER-CLIENT-EVIDENCE-ID', async () => {
      const image = jpeg();
      const b = body(image);
      const first = await intent(A.guard.token, A.run.id, b);
      const again = await intent(A.guard.token, A.run.id, b);
      expect(first, 201);
      expect(again, 201);
      assert.equal(again.body.evidence.id, first.body.evidence.id, 'same record');
      assert.ok(again.body.upload, 'a fresh upload URL while it is pending');
      expect(await intent(A.guard.token, A.run.id, { ...b, sha256: sha256(jpeg()) }), 409, 'PATROL_IDEMPOTENCY_CONFLICT', 'same id, different photo');
      expect(await intent(gA2.token, A.run.id, b), 404, 'PATROL_NOT_FOUND');
      const c = body(jpeg());
      const results = await Promise.all(Array.from({ length: 6 }, () => intent(A.guard.token, A.run.id, c)));
      assert.ok(results.every((r) => r.status === 201));
      assert.equal(new Set(results.map((r) => r.body.evidence.id)).size, 1, 'concurrent duplicates resolve to one record');
      assert.equal(await count(`SELECT count(*) FROM patrol_evidence WHERE "clientEvidenceId" = $1`, [c.clientEvidenceId]), 1);
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.evidence_upload_requested' AND "entityId" = $1`, [results[0].body.evidence.id]), 1);
      // Once verified, a replay returns the record and no upload URL.
      assert.equal((await put(first.body.upload, image)).status, 200);
      expect(await complete(A.guard.token, first.body.evidence.id), 200);
      const settled = await intent(A.guard.token, A.run.id, b);
      expect(settled, 201);
      assert.deepEqual([settled.body.evidence.uploadStatus, settled.body.upload], ['verified', null]);
    });

    await test('PE-U05-UNCONFIGURED-STORAGE-FAILS-CLOSED-WITH-503-AFTER-AUTHORISATION', async () => {
      const pending = await intent(A.guard.token, A.run.id, body(jpeg()));
      expect(pending, 201);
      clearStorageEnv();
      try {
        expect(await intent(A.guard.token, A.run.id, body(jpeg())), 503, 'PATROL_EVIDENCE_STORAGE_UNAVAILABLE', 'intent');
        expect(await complete(A.guard.token, pending.body.evidence.id), 503, 'PATROL_EVIDENCE_STORAGE_UNAVAILABLE', 'complete');
        expect(await api('GET', `/patrols/evidence/${firstEvidence.id}/download?purpose=review`, A.co.token), 503, 'PATROL_EVIDENCE_STORAGE_UNAVAILABLE', 'download');
        expect(await api('POST', '/patrols/exports', A.co.token, { purpose: 'audit', runIds: [A.run.id] }), 503, 'PATROL_EVIDENCE_STORAGE_UNAVAILABLE', 'export');
        expect(await api('POST', `/patrols/evidence/${firstEvidence.id}/delete`, A.co.token, { reason: 'test' }), 503, 'PATROL_EVIDENCE_STORAGE_UNAVAILABLE', 'delete');
        expect(await intent(B.guard.token, A.run.id, body(jpeg())), 404, 'PATROL_NOT_FOUND', 'authorisation still comes first');
        expect(await api('GET', `/patrols/evidence/${firstEvidence.id}/download?purpose=review`, B.co.token), 404, 'PATROL_NOT_FOUND', 'and for another company');
        const counters = await maintRun(new Date(), 'enforce');
        assert.equal(counters.storageAvailable, false, 'maintenance does nothing without storage');
        expect(await api('GET', '/patrols/storage-usage', A.co.token), 200, undefined, 'metering still reads');
      } finally {
        setStorageEnv();
      }
      assert.equal((await row(pending.body.evidence.id)).uploadStatus, 'pending', 'nothing changed');
    });

    // ═══════════════════ Completion and integrity ═══════════════════

    let verified: any;
    await test('PE-C01-VERIFIED-BYTES-ARE-COPIED-HASHED-RETAINED-30-DAYS-AUDITED-AND-METERED', async () => {
      const s = await scenario('c01');
      const image = jpeg({ width: 32, height: 16, exif: true });
      const before = Date.now();
      verified = await uploadPhoto(s.guard.token, s.run.id, image);
      const r = await row(verified.id);
      assert.deepEqual([r.uploadStatus, r.retentionStatus, r.sha256Stored, Number(r.sizeBytes), r.detectedMimeType, r.widthPx, r.heightPx, r.retentionDays],
        ['verified', 'active', sha256(image), image.length, 'image/jpeg', 32, 16, 30]);
      assert.ok(r.receivedAt && new Date(r.receivedAt).getTime() >= before - 1000);
      assert.equal(new Date(r.expiresAt).getTime(), new Date(r.receivedAt).getTime() + 30 * DAY, '30 days from cloud receipt');
      assert.match(r.storageKey, new RegExp(`^patrol/${s.co.id}/\\d{4}/\\d{2}/[0-9a-f-]{36}$`), 'the server-only area');
      assert.ok(fake.objects.get(r.storageKey)?.body.equals(image), 'the stored bytes are exactly the hashed bytes');
      assert.equal(fake.keys(`patrol-incoming/${s.co.id}/`).length, 0, 'the incoming copy is removed');
      const audits = await q(`SELECT * FROM audit_logs WHERE action = 'patrol.evidence_verified' AND "entityId" = $1`, [verified.id]);
      assert.equal(audits.length, 1);
      assert.deepEqual([audits[0].afterData.sha256, audits[0].afterData.retentionDays, audits[0].afterData.via, Number(audits[0].userId)], [sha256(image), 30, 'guard', s.guard.userId]);
      await usageMatches(s.co.id, 'after verification');
      const usage = await api('GET', '/patrols/storage-usage', s.co.token);
      expect(usage, 200);
      assert.deepEqual([usage.body.sites[0].activeObjects, usage.body.sites[0].activeBytes, usage.body.totals.objects], [1, image.length, 1]);
    });

    await test('PE-C02-COMPLETION-BEFORE-THE-UPLOAD-IS-409-AND-CHANGES-NOTHING', async () => {
      const r = await intent(A.guard.token, A.run.id, body(jpeg()));
      expect(await complete(A.guard.token, r.body.evidence.id), 409, 'PATROL_EVIDENCE_NOT_UPLOADED');
      const after = await row(r.body.evidence.id);
      assert.deepEqual([after.uploadStatus, after.completionToken, after.receivedAt], ['pending', null, null]);
    });

    await test('PE-C03-HASH-MISMATCH-IS-REFUSED-BY-STORAGE-OR-REJECTED-AND-QUARANTINED', async () => {
      const s = await scenario('c03');
      const image = jpeg();
      const other = jpeg();
      const r = await intent(s.guard.token, s.run.id, body(image));
      // 1. The storage itself refuses bytes that do not match the signed checksum (S3 / R2 / MinIO behaviour).
      const tampered = await put(r.body.upload, other);
      assert.equal(tampered.status, 400, 'BadDigest');
      // 2. Bytes with the wrong hash that reach storage anyway (a provider that ignores the checksum) are rejected.
      const incomingKey = keys.siblingKey((await row(r.body.evidence.id)).storageKey, 'incoming');
      fake.objects.set(incomingKey, { body: other, contentType: 'image/jpeg' });
      const c = await complete(s.guard.token, r.body.evidence.id);
      expect(c, 200);
      assert.deepEqual([c.body.uploadStatus, c.body.rejectionReason, c.body.retentionStatus], ['rejected', 'hash_mismatch', 'quarantined']);
      const stored = await row(r.body.evidence.id);
      assert.equal(stored.sha256Stored, sha256(other), 'what actually arrived is recorded');
      assert.ok(fake.objects.get(stored.quarantineKey)?.body.equals(other), 'the bytes are kept in quarantine, not dropped');
      assert.match(stored.quarantineKey, new RegExp(`^patrol-quarantine/${s.co.id}/`));
      assert.equal(fake.keys(`patrol/${s.co.id}/`).length, 0, 'nothing in the verified area');
      assert.equal(fake.keys(`patrol-incoming/${s.co.id}/`).length, 0);
      assert.ok(new Date(stored.purgeAfter).getTime() - new Date(stored.quarantinedAt).getTime() === 7 * DAY, 'recoverable for 7 days');
      const again = await complete(s.guard.token, r.body.evidence.id);
      assert.deepEqual([again.status, again.body.uploadStatus, again.body.rejectionReason], [200, 'rejected', 'hash_mismatch'], 'repeat completion is stable');
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.evidence_rejected' AND "entityId" = $1`, [r.body.evidence.id]), 1);
      const replay = await intent(s.guard.token, s.run.id, body(image, { clientEvidenceId: (await row(r.body.evidence.id)).clientEvidenceId, capturedAtDevice: new Date(stored.capturedAtDevice).toISOString() }));
      assert.deepEqual([replay.status, replay.body.upload], [201, null], 'a rejected photo is settled: no new upload URL');
      await usageMatches(s.co.id, 'after a rejection');
    });

    await test('PE-C04-NON-IMAGES-WRONG-TYPES-AND-POLYGLOTS-ARE-REJECTED-AND-QUARANTINED', async () => {
      const s = await scenario('c04');
      const cases: Array<[string, Buffer, string, string]> = [
        ['text as jpeg', Buffer.from('<?xml version="1.0"?> definitely not a photo, padded out to be long enough to inspect'), 'image/jpeg', 'not_an_image'],
        ['png declared jpeg', png(), 'image/jpeg', 'content_type_mismatch'],
        ['jpeg + zip', Buffer.concat([jpeg(), zipTail()]), 'image/jpeg', 'trailing_data'],
        ['jpeg + zip + fake EOI', Buffer.concat([jpeg(), zipTail(), Buffer.from([0xff, 0xd9])]), 'image/jpeg', 'trailing_data'],
        ['png + html', Buffer.concat([png(), Buffer.from('<html><script>x</script></html>')]), 'image/png', 'trailing_data'],
        ['jpeg with markup', jpeg({ comment: '<svg onload=alert(1)>' }), 'image/jpeg', 'embedded_markup'],
      ];
      for (const [name, bytes, contentType, reason] of cases) {
        const r = await intent(s.guard.token, s.run.id, { ...body(bytes), contentType });
        expect(r, 201, undefined, name);
        assert.equal((await put(r.body.upload, bytes)).status, 200, name);
        const c = await complete(s.guard.token, r.body.evidence.id);
        expect(c, 200, undefined, name);
        assert.deepEqual([c.body.uploadStatus, c.body.rejectionReason, c.body.retentionStatus], ['rejected', reason, 'quarantined'], name);
      }
      assert.equal(fake.keys(`patrol/${s.co.id}/`).length, 0, 'no rejected bytes in the verified area');
      assert.equal(fake.keys(`patrol-quarantine/${s.co.id}/`).length, cases.length);
      await usageMatches(s.co.id, 'after rejections');
    });

    await test('PE-C05-CONCURRENT-COMPLETION-ONE-VERIFICATION-ONE-RESULT', async () => {
      const s = await scenario('c05');
      const image = png({ width: 9, height: 9 });
      const r = await intent(s.guard.token, s.run.id, { ...body(image), contentType: 'image/png' });
      assert.equal((await put(r.body.upload, image)).status, 200);
      const copiesBefore = fake.log.filter((l) => l.copySource?.startsWith('patrol-incoming/') && l.status === 200).length;
      const results = await Promise.all(Array.from({ length: 6 }, () => complete(s.guard.token, r.body.evidence.id)));
      assert.ok(results.every((x) => x.status === 200 && x.body.uploadStatus === 'verified' && x.body.sha256Stored === sha256(image)), JSON.stringify(results.map((x) => x.status)));
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.evidence_verified' AND "entityId" = $1`, [r.body.evidence.id]), 1, 'one verification');
      assert.equal(fake.log.filter((l) => l.copySource?.startsWith('patrol-incoming/') && l.status === 200).length - copiesBefore, 1, 'one copy');
      assert.equal(fake.keys(`patrol/${s.co.id}/`).length, 1, 'one object');
      await usageMatches(s.co.id, 'after concurrent completion');
      assert.deepEqual((await storedUsage(ds, s.co.id)).sites.map((x: any) => x.activeObjects), [1]);
    });

    await test('PE-C06-AN-OBJECT-OVER-THE-CAP-IS-REJECTED-FROM-ITS-HEAD-ALONE', async () => {
      const s = await scenario('c06');
      const image = jpeg();
      const r = await intent(s.guard.token, s.run.id, body(image));
      const incomingKey = keys.siblingKey((await row(r.body.evidence.id)).storageKey, 'incoming');
      fake.objects.set(incomingKey, { body: Buffer.alloc(10 * 1024 * 1024 + 10, 1), contentType: 'image/jpeg' });
      const getsBefore = fake.log.filter((l) => l.method === 'GET' && l.key.startsWith(`patrol`) && l.key.includes(`/${s.co.id}/`)).length;
      const c = await complete(s.guard.token, r.body.evidence.id);
      assert.deepEqual([c.status, c.body.uploadStatus, c.body.rejectionReason, c.body.sizeBytes], [200, 'rejected', 'too_large', 10 * 1024 * 1024 + 10]);
      assert.equal(fake.log.filter((l) => l.method === 'GET' && l.key.includes(`/${s.co.id}/`)).length, getsBefore, 'never downloaded');
      await usageMatches(s.co.id, 'too large');
    });

    await test('PE-C07-A-STILL-VALID-UPLOAD-URL-CANNOT-CHANGE-A-VERIFIED-PHOTO', async () => {
      const s = await scenario('c07');
      const image = jpeg();
      const r = await intent(s.guard.token, s.run.id, body(image));
      assert.equal((await put(r.body.upload, image)).status, 200);
      expect(await complete(s.guard.token, r.body.evidence.id), 200);
      const stored = await row(r.body.evidence.id);
      // The URL is still valid for a few minutes; re-using it only writes the incoming area, never the verified key.
      assert.equal((await put(r.body.upload, image)).status, 200);
      assert.ok(fake.objects.get(stored.storageKey)!.body.equals(image));
      assert.ok(!r.body.upload.url.includes(stored.storageKey), 'the upload URL never points at the verified key');
    });

    // ═══════════════════ Viewing ═══════════════════

    await test('PE-D01-DOWNLOAD-PERMISSIONS-PURPOSE-SHORT-LIVED-LINK-AND-AUDIT-WITHOUT-URL', async () => {
      const image = jpeg({ nonce: 'download' });
      const ev = await uploadPhoto(A.guard.token, A.run.id, image);
      const path_ = `/patrols/evidence/${ev.id}/download?purpose=incident`;
      for (const [who, tok, status] of [
        ['owner', A.co.token, 200], ['admin', staffA.admin.token, 200], ['operations', staffA.operations.token, 200], ['control room', staffA.control_room.token, 200],
        ['viewer', staffA.viewer.token, 403], ['finance', staffA.finance.token, 403], ['hr', staffA.hr_compliance.token, 403],
        ['guard', A.guard.token, 403], ['platform', platform, 403], ['other company', B.co.token, 404],
      ] as Array<[string, string, number]>) {
        expect(await api('GET', path_, tok), status, undefined, who);
      }
      expect(await api('GET', `/patrols/evidence/${ev.id}/download`, A.co.token), 400, undefined, 'a purpose is required');
      expect(await api('GET', `/patrols/evidence/${ev.id}/download?purpose=curiosity`, A.co.token), 400);
      const r = await api('GET', path_, staffA.control_room.token);
      const u = new URL(r.body.url);
      assert.equal(r.body.method, 'GET');
      const expires = Number(u.searchParams.get('X-Amz-Expires'));
      assert.ok(expires >= 60 && expires <= 300, `≤ 300 s (${expires})`);
      assert.equal(u.searchParams.get('response-content-disposition'), `attachment; filename="patrol-evidence-${ev.id}.jpg"`);
      const got = await fetch(r.body.url);
      assert.equal(got.status, 200);
      assert.equal(got.headers.get('content-type'), 'image/jpeg');
      assert.equal(sha256(Buffer.from(await got.arrayBuffer())), sha256(image), 'exact bytes');
      const tamper = new URL(r.body.url);
      tamper.searchParams.set('X-Amz-Signature', '0'.repeat(64));
      assert.equal((await fetch(tamper)).status, 403, 'a tampered link is refused');
      const unsigned = await fetch(`${u.origin}${u.pathname}`);
      assert.equal(unsigned.status, 403, 'the object is not public');
      const audits = await q(`SELECT * FROM audit_logs WHERE action = 'patrol.evidence_accessed' AND "entityId" = $1 ORDER BY id`, [ev.id]);
      assert.equal(audits.length, 5, 'every link issued is audited (owner, admin, operations, control room ×2)');
      const last = audits[audits.length - 1];
      assert.deepEqual([Number(last.userId), last.afterData.purpose, Number(last.companyId)], [staffA.control_room.userId, 'incident', A.co.id]);
      for (const a of audits) noSecretsIn(a, 'access audit');
      const meta = await api('GET', `/patrols/runs/${A.run.id}/evidence`, A.co.token);
      expect(meta, 200);
      noSecretsIn(meta.body, 'evidence metadata');
      assert.ok(meta.body.every((e: any) => !('storageKey' in e) && !('quarantineKey' in e) && !('url' in e)));
    });

    await test('PE-D02-PENDING-REJECTED-AND-QUARANTINED-PHOTOS-CANNOT-BE-VIEWED', async () => {
      const pending = await intent(A.guard.token, A.run.id, body(jpeg()));
      expect(await api('GET', `/patrols/evidence/${pending.body.evidence.id}/download?purpose=review`, A.co.token), 409, 'PATROL_EVIDENCE_NOT_AVAILABLE');
      const [rejected] = await q(`SELECT id FROM patrol_evidence WHERE "uploadStatus" = 'rejected' LIMIT 1`);
      const owner = await one(`SELECT u.email FROM patrol_evidence e JOIN companies c ON c.id = e."companyId" JOIN users u ON u.id = c."userId" WHERE e.id = $1`, [rejected.id]);
      expect(await api('GET', `/patrols/evidence/${rejected.id}/download?purpose=review`, await login(owner.email)), 409, 'PATROL_EVIDENCE_NOT_AVAILABLE');
    });

    // ═══════════════════ Retention, holds, deletion ═══════════════════

    await test('PE-R01-RETENTION-30-DAY-BOUNDARY-REPORT-MODE-AND-90-DAY-POLICY', async () => {
      const s = await scenario('r01');
      const ev30 = await uploadPhoto(s.guard.token, s.run.id, jpeg());
      const r30 = await row(ev30.id);
      const expiry = new Date(r30.expiresAt).getTime();
      await only(s.co.id, async () => {
        const report = await maintRun(new Date(expiry + 1), 'report');
        assert.equal(report.wouldClaim, 1, 'report mode counts it');
        assert.equal((await row(ev30.id)).retentionStatus, 'active', 'and changes nothing');
        await maintRun(new Date(expiry - 1), 'enforce');
        assert.equal((await row(ev30.id)).retentionStatus, 'active', 'one millisecond before expiry: kept');
        const c = await maintRun(new Date(expiry), 'enforce');
        assert.deepEqual([c.claimed, c.quarantined], [1, 1]);
      });
      const gone = await row(ev30.id);
      assert.deepEqual([gone.retentionStatus, gone.deletionReason], ['quarantined', 'retention_expired']);
      assert.ok(!fake.objects.has(gone.storageKey) && fake.objects.get(gone.quarantineKey)?.body.length === Number(gone.sizeBytes), 'moved to quarantine');
      assert.ok(gone.primaryDeletedAt, 'primary removal confirmed');
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action IN ('patrol.evidence_retention_claimed','patrol.evidence_quarantined') AND "entityId" = $1`, [ev30.id]), 2);
      await usageMatches(s.co.id, 'after retention');
      // 90 days where the site policy says so (Owner / Admin).
      expect(await api('PUT', `/patrols/policies/sites/${s.site}`, s.co.token, { retentionDays: 90 }), 200);
      const ev90 = await uploadPhoto(s.guard.token, s.run.id, jpeg());
      const r90 = await row(ev90.id);
      assert.equal(Number(r90.retentionDays), 90);
      await only(s.co.id, async () => {
        await maintRun(new Date(new Date(r90.receivedAt).getTime() + 31 * DAY), 'enforce');
        assert.equal((await row(ev90.id)).retentionStatus, 'active', 'kept past 30 days');
        await maintRun(new Date(new Date(r90.expiresAt).getTime()), 'enforce');
        assert.equal((await row(ev90.id)).retentionStatus, 'quarantined', 'claimed at 90 days');
      });
    });

    await test('PE-H01-HOLDS-BLOCK-DELETION-CANCEL-CLAIMS-AND-RELEASE-IS-AUDITED', async () => {
      const s = await scenario('h01');
      const admin = await mkMember(s.co.id, 'h01', 'admin');
      const ops = await mkMember(s.co.id, 'h01', 'operations');
      const cr = await mkMember(s.co.id, 'h01', 'control_room');
      const ev = await uploadPhoto(s.guard.token, s.run.id, jpeg());
      const ev2 = await uploadPhoto(s.guard.token, s.run.id, jpeg());
      const holdBody = { scope: 'run', runId: Number(s.run.id), reason: 'Incident 4471: trespass at the yard gate' };
      expect(await api('POST', '/patrols/holds', ops.token, holdBody), 403, 'PATROL_FORBIDDEN', 'operations');
      expect(await api('POST', '/patrols/holds', cr.token, holdBody), 403, 'PATROL_FORBIDDEN', 'control room');
      expect(await api('POST', '/patrols/holds', s.guard.token, holdBody), 403);
      expect(await api('POST', '/patrols/holds', B.co.token, holdBody), 404, 'PATROL_NOT_FOUND', 'another company\'s run');
      expect(await api('POST', '/patrols/holds', admin.token, { ...holdBody, evidenceId: ev.id }), 400, 'PATROL_VALIDATION_FAILED', 'stray target field');
      expect(await api('POST', '/patrols/holds', admin.token, { scope: 'site_date_range', siteId: s.site, fromDate: '2026-10-05', reason: 'x needs a reason' }), 400);
      expect(await api('POST', '/patrols/holds', admin.token, { ...holdBody, safetyAlertId: 999999 }), 404, undefined, 'unknown link');
      // A claim in progress is cancelled by a hold: held evidence never leaves active.
      await q(`UPDATE patrol_evidence SET "retentionStatus" = 'claimed', "claimToken" = gen_random_uuid(), "claimedAt" = now(), "deletionReason" = 'retention_expired' WHERE id = $1`, [ev2.id]);
      const hold = await api('POST', '/patrols/holds', admin.token, holdBody);
      expect(hold, 201);
      assert.deepEqual([hold.body.scope, hold.body.runId, hold.body.createdByUserId], ['run', Number(s.run.id), admin.userId]);
      assert.deepEqual([(await row(ev2.id)).retentionStatus, (await row(ev2.id)).claimToken], ['active', null], 'the claim was cancelled');
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.evidence_deletion_cancelled' AND "entityId" = $1`, [ev2.id]), 1);
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.evidence_hold_placed' AND "entityId" = $1`, [hold.body.id]), 1);
      expect(await api('POST', `/patrols/evidence/${ev.id}/delete`, s.co.token, { reason: 'Duplicate photo' }), 409, 'PATROL_EVIDENCE_HELD', 'manual deletion is refused');
      await only(s.co.id, async () => {
        await maintRun(new Date(Date.now() + 40 * DAY), 'enforce');
      });
      assert.deepEqual([(await row(ev.id)).retentionStatus, (await row(ev2.id)).retentionStatus], ['active', 'active'], 'retention never touches held evidence');
      const list = await api('GET', '/patrols/holds', admin.token);
      assert.ok(list.body.some((h: any) => h.id === hold.body.id));
      expect(await api('POST', `/patrols/holds/${hold.body.id}/release`, B.co.token, { reason: 'not mine' }), 404, 'PATROL_NOT_FOUND');
      expect(await api('POST', `/patrols/holds/${hold.body.id}/release`, ops.token, { reason: 'Incident closed' }), 403);
      const released = await api('POST', `/patrols/holds/${hold.body.id}/release`, s.co.token, { reason: 'Incident 4471 closed by the client' });
      expect(released, 200);
      assert.deepEqual([Boolean(released.body.releasedAt), released.body.releasedByUserId, released.body.releaseReason], [true, s.co.ownerId, 'Incident 4471 closed by the client']);
      expect(await api('POST', `/patrols/holds/${hold.body.id}/release`, s.co.token, { reason: 'again' }), 409, 'PATROL_HOLD_ALREADY_RELEASED');
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.evidence_hold_released' AND "entityId" = $1`, [hold.body.id]), 1);
      const all = await api('GET', '/patrols/holds?status=all', admin.token);
      assert.ok(all.body.some((h: any) => h.id === hold.body.id && h.releasedAt), 'released holds stay on record');
      await only(s.co.id, async () => {
        await maintRun(new Date(Date.now() + 40 * DAY), 'enforce');
      });
      assert.deepEqual([(await row(ev.id)).retentionStatus, (await row(ev2.id)).retentionStatus], ['quarantined', 'quarantined'], 'released: retention proceeds');
      // Photo, shift and site/date-range holds also protect (checked by the predicate the state machine uses).
      const ev3 = await uploadPhoto(s.guard.token, s.run.id, jpeg());
      const capturedDay = new Date((await row(ev3.id)).capturedAtDevice).toISOString().slice(0, 10);
      for (const h of [
        { scope: 'evidence', evidenceId: ev3.id }, { scope: 'shift', shiftId: s.shift }, { scope: 'site_date_range', siteId: s.site, fromDate: capturedDay, toDate: capturedDay },
      ]) {
        const placed = await api('POST', '/patrols/holds', s.co.token, { ...h, reason: 'Protect for the investigation' });
        expect(placed, 201, undefined, h.scope);
        expect(await api('POST', `/patrols/evidence/${ev3.id}/delete`, s.co.token, { reason: 'try' }), 409, 'PATROL_EVIDENCE_HELD', h.scope);
        expect(await api('POST', `/patrols/holds/${placed.body.id}/release`, s.co.token, { reason: 'done with it' }), 200);
      }
      expect(await api('POST', '/patrols/holds', s.co.token, { scope: 'shift', shiftId: B.shift, reason: 'not my shift' }), 404, undefined, 'another company\'s shift');
      expect(await api('POST', '/patrols/holds', s.co.token, { scope: 'site_date_range', siteId: B.site, fromDate: capturedDay, toDate: capturedDay, reason: 'not my site' }), 404);
      await usageMatches(s.co.id, 'after holds');
    });

    await test('PE-Q01-MANUAL-DELETE-TO-QUARANTINE-AND-RESTORE-TO-A-NEW-KEY', async () => {
      const s = await scenario('q01');
      const ops = await mkMember(s.co.id, 'q01', 'operations');
      const admin = await mkMember(s.co.id, 'q01', 'admin');
      const image = jpeg({ nonce: 'restore-me' });
      const ev = await uploadPhoto(s.guard.token, s.run.id, image);
      const before = await row(ev.id);
      expect(await api('POST', `/patrols/evidence/${ev.id}/delete`, ops.token, { reason: 'Wrong site' }), 403, 'PATROL_FORBIDDEN');
      expect(await api('POST', `/patrols/evidence/${ev.id}/delete`, B.co.token, { reason: 'Wrong site' }), 404, 'PATROL_NOT_FOUND');
      expect(await api('POST', `/patrols/evidence/${ev.id}/delete`, s.co.token, {}), 400, undefined, 'a reason is required');
      const del = await api('POST', `/patrols/evidence/${ev.id}/delete`, s.co.token, { reason: 'Photo of the wrong site' });
      expect(del, 200);
      assert.deepEqual([del.body.retentionStatus, del.body.deletionReason], ['quarantined', 'manual']);
      const q1 = await row(ev.id);
      assert.ok(!fake.objects.has(before.storageKey), 'primary removed (after the quarantine copy was committed)');
      assert.ok(fake.objects.get(q1.quarantineKey)!.body.equals(image));
      assert.equal(Number(q1.deletionRequestedByUserId), s.co.ownerId);
      expect(await api('GET', `/patrols/evidence/${ev.id}/download?purpose=review`, s.co.token), 409, 'PATROL_EVIDENCE_NOT_AVAILABLE');
      await usageMatches(s.co.id, 'after manual deletion');
      expect(await api('POST', `/patrols/evidence/${ev.id}/restore`, ops.token, { reason: 'Mistake' }), 403);
      expect(await api('POST', `/patrols/evidence/${ev.id}/restore`, B.co.token, { reason: 'Mistake' }), 404);
      const restored = await api('POST', `/patrols/evidence/${ev.id}/restore`, admin.token, { reason: 'Deleted by mistake' });
      expect(restored, 200);
      const back = await row(ev.id);
      assert.deepEqual([back.retentionStatus, back.quarantineKey, back.claimToken], ['active', null, null]);
      assert.notEqual(back.storageKey, before.storageKey, 'restored to a NEW key');
      assert.ok(fake.objects.get(back.storageKey)!.body.equals(image), 'the same bytes');
      assert.ok(!fake.objects.has(q1.quarantineKey), 'quarantine copy removed');
      assert.ok(new Date(back.expiresAt).getTime() >= Date.now() + 7 * DAY - 60_000, 'kept at least 7 days from the restore');
      expect(await api('POST', `/patrols/evidence/${ev.id}/restore`, admin.token, { reason: 'again' }), 409, 'PATROL_EVIDENCE_STATE_CONFLICT');
      const dl = await api('GET', `/patrols/evidence/${ev.id}/download?purpose=review`, admin.token);
      expect(dl, 200);
      assert.equal(sha256(Buffer.from(await (await fetch(dl.body.url)).arrayBuffer())), sha256(image));
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE "entityId" = $1 AND action IN ('patrol.evidence_deletion_requested','patrol.evidence_quarantined','patrol.evidence_restored')`, [ev.id]), 3);
      await usageMatches(s.co.id, 'after restore');
      // A rejected upload is not evidence: it cannot be restored.
      const bad = await intent(s.guard.token, s.run.id, body(Buffer.concat([jpeg(), zipTail()])));
      await put(bad.body.upload, Buffer.concat([jpeg(), zipTail()]));
      await complete(s.guard.token, bad.body.evidence.id);
      expect(await api('POST', `/patrols/evidence/${bad.body.evidence.id}/restore`, s.co.token, { reason: 'try' }), 409, 'PATROL_EVIDENCE_STATE_CONFLICT');
    });

    await test('PE-P01-PURGE-ONLY-AFTER-COMMIT-TOMBSTONE-KEEPS-THE-RECORD-HOLD-BLOCKS-PURGE', async () => {
      const s = await scenario('p01');
      const image = jpeg();
      const ev = await uploadPhoto(s.guard.token, s.run.id, image);
      const heldEv = await uploadPhoto(s.guard.token, s.run.id, jpeg());
      expect(await api('POST', `/patrols/evidence/${ev.id}/delete`, s.co.token, { reason: 'Not needed' }), 200);
      expect(await api('POST', `/patrols/evidence/${heldEv.id}/delete`, s.co.token, { reason: 'Not needed' }), 200);
      const hold = await api('POST', '/patrols/holds', s.co.token, { scope: 'evidence', evidenceId: heldEv.id, reason: 'Late complaint received' });
      expect(hold, 201);
      const quarantined = await row(ev.id);
      const observed: Array<{ key: string; status: string }> = [];
      fake.onRequest = async (method, key) => {
        if (method !== 'DELETE') return;
        const [r] = await q(`SELECT "retentionStatus" FROM patrol_evidence WHERE "quarantineKey" = $1 OR "storageKey" = $1`, [key]);
        if (r) observed.push({ key, status: r.retentionStatus });
      };
      try {
        await only(s.co.id, async () => {
          await maintRun(new Date(new Date(quarantined.purgeAfter).getTime() - 1), 'enforce');
          assert.equal((await row(ev.id)).retentionStatus, 'quarantined', 'not before purgeAfter');
          await maintRun(new Date(new Date(quarantined.purgeAfter).getTime()), 'enforce');
        });
      } finally {
        fake.onRequest = null;
      }
      assert.ok(observed.length >= 1 && observed.every((o) => o.status === 'purged'), `every object DELETE happened after "purged" was committed: ${JSON.stringify(observed.map((o) => o.status))}`);
      const tomb = await row(ev.id);
      assert.equal(tomb.retentionStatus, 'tombstone');
      assert.deepEqual([tomb.sha256Stored, Number(tomb.sizeBytes), tomb.uploadStatus], [sha256(image), image.length, 'verified'], 'the record of what was deleted is kept');
      for (const col of ['receivedAt', 'verifiedAt', 'quarantinedAt', 'purgedAt', 'objectDeletedAt', 'primaryDeletedAt']) assert.ok(tomb[col], `${col} kept`);
      assert.ok(!fake.objects.has(tomb.quarantineKey));
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE "entityId" = $1 AND action IN ('patrol.evidence_purge_started','patrol.evidence_purged')`, [ev.id]), 2);
      assert.equal((await row(heldEv.id)).retentionStatus, 'quarantined', 'a hold blocks the purge of quarantined evidence');
      assert.ok(fake.objects.has((await row(heldEv.id)).quarantineKey));
      expect(await api('GET', `/patrols/runs/${s.run.id}/evidence`, s.co.token), 200);
      await usageMatches(s.co.id, 'after purge');
    });

    await test('PE-P02-STORAGE-FAILURES-NEVER-LOSE-EVIDENCE-AND-ARE-RETRIED-PURGE-IS-IDEMPOTENT', async () => {
      const s = await scenario('p02');
      const image = jpeg();
      const ev = await uploadPhoto(s.guard.token, s.run.id, image);
      const original = await row(ev.id);
      // The quarantine copy fails: the photo stays claimed with its object intact, and the next pass finishes the move.
      fake.failures.push({ method: 'PUT', keyPrefix: `patrol-quarantine/${s.co.id}/`, status: 500, times: 1 });
      const del = await api('POST', `/patrols/evidence/${ev.id}/delete`, s.co.token, { reason: 'Duplicate' });
      expect(del, 200);
      const claimed = await row(ev.id);
      assert.deepEqual([claimed.retentionStatus, claimed.deletionAttempts], ['claimed', 1]);
      assert.ok(claimed.lastDeletionError && !/https?:|X-Amz/.test(claimed.lastDeletionError), 'a safe error is recorded');
      assert.ok(fake.objects.get(original.storageKey)!.body.equals(image), 'the photo is untouched');
      await only(s.co.id, () => maintRun(new Date(), 'report'));
      assert.equal((await row(ev.id)).retentionStatus, 'quarantined', 'the move is finished by the next pass (in any mode)');
      const quarantined = await row(ev.id);
      // The purge's object removal fails: the row stays "purged" (the decision is committed, the record intact) and is retried.
      fake.failures.push({ method: 'DELETE', keyPrefix: `patrol-quarantine/${s.co.id}/`, status: 503, times: 2 });
      const at = new Date(new Date(quarantined.purgeAfter).getTime() + 1000);
      await only(s.co.id, () => maintRun(at, 'enforce'));
      const pending = await row(ev.id);
      assert.deepEqual([pending.retentionStatus, pending.sha256Stored], ['purged', sha256(image)]);
      assert.ok(pending.deletionAttempts >= 1 && pending.lastDeletionError);
      assert.ok(fake.objects.has(pending.quarantineKey), 'object still there');
      await only(s.co.id, () => maintRun(at, 'enforce'));
      const tomb = await row(ev.id);
      assert.equal(tomb.retentionStatus, 'tombstone', 'retried to completion');
      assert.ok(!fake.objects.has(tomb.quarantineKey));
      const snapshot = JSON.stringify(await q(`SELECT * FROM patrol_evidence WHERE "companyId" = $1 ORDER BY id`, [s.co.id]));
      const audits = await count(`SELECT count(*) FROM audit_logs WHERE "companyId" = $1`, [s.co.id]);
      await only(s.co.id, () => maintRun(at, 'enforce'));
      assert.equal(JSON.stringify(await q(`SELECT * FROM patrol_evidence WHERE "companyId" = $1 ORDER BY id`, [s.co.id])), snapshot, 'purge is idempotent');
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE "companyId" = $1`, [s.co.id]), audits, 'and writes nothing more');
      await usageMatches(s.co.id, 'after retried purge');
      // A completion whose storage is unreachable leaves the photo pending (503), never lost.
      const retryImage = jpeg();
      const r = await intent(s.guard.token, s.run.id, body(retryImage));
      assert.equal((await put(r.body.upload, retryImage)).status, 200);
      fake.failures.push({ method: 'HEAD', keyPrefix: `patrol-incoming/${s.co.id}/`, status: 500, times: 1 });
      expect(await complete(s.guard.token, r.body.evidence.id), 503, 'PATROL_EVIDENCE_STORAGE_UNAVAILABLE');
      assert.deepEqual([(await row(r.body.evidence.id)).uploadStatus, (await row(r.body.evidence.id)).completionToken], ['pending', null]);
    });

    // ═══════════════════ Exports ═══════════════════

    let exportCo: any;
    await test('PE-E01-EXPORT-AUTHORISATION-TENANCY-SCOPE-AND-BOUNDS', async () => {
      exportCo = await scenario('e01');
      const ops = await mkMember(exportCo.co.id, 'e01', 'operations');
      const cr = await mkMember(exportCo.co.id, 'e01', 'control_room');
      const viewer = await mkMember(exportCo.co.id, 'e01', 'viewer');
      const scope = { purpose: 'incident', runIds: [Number(exportCo.run.id)] };
      for (const [who, tok] of [['operations', ops.token], ['control room', cr.token], ['viewer', viewer.token]] as Array<[string, string]>) {
        expect(await api('POST', '/patrols/exports', tok, scope), 403, 'PATROL_FORBIDDEN', who);
      }
      expect(await api('POST', '/patrols/exports', exportCo.guard.token, scope), 403);
      expect(await api('POST', '/patrols/exports', B.co.token, scope), 404, 'PATROL_NOT_FOUND', 'another company\'s run');
      expect(await api('POST', '/patrols/exports', exportCo.co.token, { purpose: 'incident', siteId: B.site, fromDate: '2026-10-01', toDate: '2026-10-02' }), 404, 'PATROL_SITE_NOT_FOUND');
      expect(await api('POST', '/patrols/exports', exportCo.co.token, { purpose: 'incident' }), 400, 'PATROL_VALIDATION_FAILED', 'a scope is required');
      expect(await api('POST', '/patrols/exports', exportCo.co.token, { purpose: 'incident', fromDate: '2026-09-01', toDate: '2026-10-15' }), 400, 'PATROL_EXPORT_TOO_LARGE', '> 31 days');
      expect(await api('POST', '/patrols/exports', exportCo.co.token, { purpose: 'incident', fromDate: '2026-10-02', toDate: '2026-10-01' }), 400);
      expect(await api('POST', '/patrols/exports', exportCo.co.token, { purpose: 'fun', runIds: [Number(exportCo.run.id)] }), 400);
      // More than 500 photos in scope.
      const big = await insRun(exportCo.co.id, exportCo.site, exportCo.shift, exportCo.guard, new Date(Date.now() - 20 * MIN), 'completed');
      await q(`INSERT INTO patrol_evidence ("companyId","siteId","runId","guardId","shiftId","sha256Client","capturedAtDevice","clientEvidenceId")
        SELECT $1, $2, $3, $4, $5, $6, now(), 'bulk-evidence-' || g FROM generate_series(1, 501) g`, [exportCo.co.id, exportCo.site, big.id, exportCo.guard.id, exportCo.shift, 'd'.repeat(64)]);
      expect(await api('POST', '/patrols/exports', exportCo.co.token, { purpose: 'audit', runIds: [Number(big.id)] }), 400, 'PATROL_EXPORT_TOO_LARGE', '> 500 photos');
      await q(`DELETE FROM patrol_evidence WHERE "runId" = $1`, [big.id]);
      // At most two in flight per company.
      await exportsSvc.whenIdle();
      await q(`INSERT INTO patrol_evidence_exports ("companyId","requestedByUserId","purpose","runIds") VALUES ($1,$2,'audit','[]'), ($1,$2,'audit','[]')`, [exportCo.co.id, exportCo.co.ownerId]);
      expect(await api('POST', '/patrols/exports', exportCo.co.token, scope), 409, 'PATROL_EXPORT_LIMIT_REACHED');
      await q(`DELETE FROM patrol_evidence_exports WHERE "companyId" = $1 AND status = 'queued'`, [exportCo.co.id]);
    });

    await test('PE-E02-ZIP-AND-MANIFEST-COVER-EVERY-STATE-HASHES-AUDIT-AND-24H-EXPIRY', async () => {
      const s = exportCo;
      const tombImage = jpeg();
      const t = await uploadPhoto(s.guard.token, s.run.id, tombImage);
      expect(await api('POST', `/patrols/evidence/${t.id}/delete`, s.co.token, { reason: 'Purge me' }), 200);
      await only(s.co.id, () => maintRun(new Date(Date.now() + 8 * DAY), 'enforce'));
      assert.equal((await row(t.id)).retentionStatus, 'tombstone');
      const vImage = jpeg({ width: 24, height: 24 });
      const v = await uploadPhoto(s.guard.token, s.run.id, vImage);
      const hImage = png();
      const h = await uploadPhoto(s.guard.token, s.run.id, hImage, { contentType: 'image/png' });
      expect(await api('POST', '/patrols/holds', s.co.token, { scope: 'evidence', evidenceId: h.id, reason: 'Keep for the incident file' }), 201);
      const qd = await uploadPhoto(s.guard.token, s.run.id, jpeg());
      expect(await api('POST', `/patrols/evidence/${qd.id}/delete`, s.co.token, { reason: 'Blurred' }), 200);
      const rjBytes = Buffer.concat([jpeg(), zipTail()]);
      const rj = await intent(s.guard.token, s.run.id, body(rjBytes));
      await put(rj.body.upload, rjBytes);
      await complete(s.guard.token, rj.body.evidence.id);
      const pd = await intent(s.guard.token, s.run.id, body(jpeg()));

      const req = await api('POST', '/patrols/exports', s.co.token, { purpose: 'incident', runIds: [Number(s.run.id)] });
      expect(req, 202);
      assert.deepEqual([req.body.status, req.body.itemCount], ['queued', 6]);
      await exportsSvc.whenIdle();
      await exportsSvc.processPending();
      const ready = await api('GET', `/patrols/exports/${req.body.id}`, s.co.token);
      expect(ready, 200);
      assert.equal(ready.body.status, 'ready', JSON.stringify(ready.body.error));
      assert.deepEqual([ready.body.itemCount, ready.body.includedCount, ready.body.excludedCount], [6, 2, 4]);
      const dl = await api('GET', `/patrols/exports/${req.body.id}/download`, s.co.token);
      expect(dl, 200);
      const du = new URL(dl.body.url);
      assert.ok(Number(du.searchParams.get('X-Amz-Expires')) <= 300);
      assert.match(du.pathname, new RegExp(`/patrol-exports/${s.co.id}/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.zip$`));
      const zip = Buffer.from(await (await fetch(dl.body.url)).arrayBuffer());
      assert.equal(sha256(zip), ready.body.zipSha256, 'the ZIP is the one recorded');
      const dir = readZipDirectory(zip);
      const names = dir.map((e) => e.name);
      const vName = `photos/run-${s.run.id}/evidence-${v.id}.jpg`;
      const hName = `photos/run-${s.run.id}/evidence-${h.id}.png`;
      assert.deepEqual(names.sort(), [vName, hName, 'manifest.csv', 'manifest.json', 'manifest.json.sha256'].sort());
      const entry = (n: string) => readZipEntry(zip, dir.find((e) => e.name === n)!);
      assert.equal(sha256(entry(vName)), sha256(vImage), 'photo bytes are exact');
      assert.equal(sha256(entry(hName)), sha256(hImage));
      const manifestBytes = entry('manifest.json');
      assert.equal(sha256(manifestBytes), ready.body.manifestSha256, 'manifest hash recorded');
      assert.equal(entry('manifest.json.sha256').toString().trim(), `${ready.body.manifestSha256}  manifest.json`);
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      assert.deepEqual([manifest.schema, manifest.exportId, manifest.companyId, manifest.purpose, manifest.counts], [
        's4.patrol-evidence-export/1', req.body.id, s.co.id, 'incident', { items: 6, included: 2, excluded: 4, held: 1 }]);
      const byId = new Map(manifest.items.map((i: any) => [i.evidenceId, i]));
      const item = (id: number) => byId.get(id) as any;
      assert.deepEqual([item(v.id).included, item(v.id).integrity, item(v.id).sha256, item(v.id).fileName, item(v.id).held], [true, 'ok', sha256(vImage), vName, false]);
      assert.deepEqual([item(h.id).included, item(h.id).held], [true, true], 'held evidence is included and marked held');
      assert.deepEqual([item(qd.id).included, item(qd.id).exclusionReason], [false, 'deleted_in_quarantine']);
      assert.deepEqual([item(rj.body.evidence.id).included, item(rj.body.evidence.id).exclusionReason, item(rj.body.evidence.id).rejectionReason], [false, 'rejected_upload', 'trailing_data']);
      assert.deepEqual([item(pd.body.evidence.id).included, item(pd.body.evidence.id).exclusionReason], [false, 'not_verified']);
      assert.deepEqual([item(t.id).included, item(t.id).exclusionReason, item(t.id).sha256], [false, 'purged', sha256(tombImage)], 'a purged photo is listed with its hash');
      for (const field of ['runId', 'checkpointId', 'siteId', 'siteName', 'capturedAtDevice', 'serverReceivedAt', 'verificationStatus', 'syncFlags']) {
        assert.ok(field in item(v.id), `manifest carries ${field}`);
      }
      noSecretsIn(manifest, 'the manifest');
      const csv = entry('manifest.csv').toString('utf8').trim().split('\r\n');
      assert.equal(csv.length, 7, 'header + 6 rows');
      assert.match(csv[0], /^evidenceId,runId,visitId,kind,/);
      const zipFile = path.join(os.tmpdir(), `pe-export-${randomUUID()}.zip`);
      fs.writeFileSync(zipFile, zip);
      try {
        console.log(`      (independent ZIP reader on the export: ${independentZipCheck(zipFile)})`);
      } finally {
        fs.rmSync(zipFile, { force: true });
      }
      const downloads = await q(`SELECT * FROM audit_logs WHERE action = 'patrol.evidence_export_downloaded' AND "entityId" = $1`, [req.body.id]);
      assert.equal(downloads.length, 1);
      noSecretsIn(downloads, 'export download audit');
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action IN ('patrol.evidence_export_requested','patrol.evidence_export_ready') AND "entityId" = $1`, [req.body.id]), 2);
      await usageMatches(s.co.id, 'with a ready export');
      assert.equal((await storedUsage(ds, s.co.id)).exportObjects, 1);
      // Cross-tenant reads of the export.
      expect(await api('GET', `/patrols/exports/${req.body.id}`, B.co.token), 404, 'PATROL_NOT_FOUND');
      expect(await api('GET', `/patrols/exports/${req.body.id}/download`, B.co.token), 404, 'PATROL_NOT_FOUND');
      assert.ok(!(await api('GET', '/patrols/exports', B.co.token)).body.some((e: any) => e.id === req.body.id));
      // 24 h later the ZIP is gone, the record stays.
      const exp = await one(`SELECT * FROM patrol_evidence_exports WHERE id = $1`, [req.body.id]);
      await exportsSvc.expire(new Date(new Date(exp.expiresAt).getTime() + 1));
      const expired = await api('GET', `/patrols/exports/${req.body.id}`, s.co.token);
      assert.deepEqual([expired.body.status, expired.body.zipSha256], ['expired', ready.body.zipSha256]);
      assert.ok(!fake.objects.has(exp.storageKey));
      expect(await api('GET', `/patrols/exports/${req.body.id}/download`, s.co.token), 409, 'PATROL_EXPORT_NOT_READY');
      await usageMatches(s.co.id, 'after export expiry');
    });

    await test('PE-E03-A-FAILED-EXPORT-IS-RECORDED-SAFELY-AND-RETRIED-LATER-NOT-IMMEDIATELY', async () => {
      const s = exportCo;
      await exportsSvc.whenIdle();
      fake.failures.push({ method: 'GET', keyPrefix: `patrol/${s.co.id}/`, status: 500, times: 1 });
      const req = await api('POST', '/patrols/exports', s.co.token, { purpose: 'investigation', runIds: [Number(s.run.id)] });
      expect(req, 202);
      await exportsSvc.whenIdle();
      const failed = await one(`SELECT * FROM patrol_evidence_exports WHERE id = $1`, [req.body.id]);
      assert.deepEqual([failed.status, failed.attempts, failed.storageKey], ['failed', 1, null]);
      assert.ok(failed.error && !/https?:|X-Amz/.test(failed.error), 'a safe error is recorded');
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.evidence_export_failed' AND "entityId" = $1`, [req.body.id]), 1);
      await exportsSvc.processPending(new Date());
      assert.equal((await one(`SELECT status FROM patrol_evidence_exports WHERE id = $1`, [req.body.id])).status, 'failed', 'not retried immediately');
      await exportsSvc.processPending(new Date(Date.now() + 6 * MIN));
      const retried = await one(`SELECT * FROM patrol_evidence_exports WHERE id = $1`, [req.body.id]);
      assert.deepEqual([retried.status, retried.attempts], ['ready', 2], 'retried on a later pass');
      await usageMatches(s.co.id, 'after a retried export');
    });

    // ═══════════════════ Metering, late sync, recovery, tenancy ═══════════════════

    await test('PE-M01-METERING-PERMISSIONS-AND-TENANCY', async () => {
      const ops = await mkMember(A.co.id, 'm01', 'operations');
      expect(await api('GET', '/patrols/storage-usage', ops.token), 403, 'PATROL_FORBIDDEN');
      expect(await api('GET', '/patrols/storage-usage', staffA.control_room.token), 403);
      expect(await api('GET', '/patrols/storage-usage', A.guard.token), 403);
      const a = await api('GET', '/patrols/storage-usage', staffA.admin.token);
      const b = await api('GET', '/patrols/storage-usage', B.co.token);
      expect(a, 200);
      expect(b, 200);
      assert.ok(a.body.sites.every((x: any) => x.siteId === A.site), 'only its own sites');
      assert.ok(b.body.sites.every((x: any) => x.siteId === B.site));
      assert.equal(a.body.retentionMode, 'report', 'retention ships report-only');
      for (const co of testCompanies) await usageMatches(co, `company ${co}`);
      const snapshot = await maintRun(new Date(), 'report');
      assert.ok(snapshot.snapshots >= 1);
      assert.ok(await count(`SELECT count(*) FROM patrol_storage_usage_daily WHERE "companyId" = $1 AND day = CURRENT_DATE`, [A.co.id]) >= 1, 'daily snapshot');
    });

    await test('PE-L01-LATE-SYNC-WITH-P1-B-AND-ALERTS-ARE-NEVER-CLOSED', async () => {
      // After Book Off, inside the 24 h window: accepted and flagged.
      const s = await scenario('l01');
      const now = Date.now();
      await bookOff(s.shift, s.guard.id, new Date(now - 3 * HOUR));
      const late = await uploadPhoto(s.guard.token, s.run.id, jpeg());
      assert.deepEqual([late.uploadStatus, late.syncFlags], ['verified', ['synced_after_book_off']]);
      // A URL issued inside the window can be completed after it closes (the bytes reached storage while it was valid).
      const pend = await intent(s.guard.token, s.run.id, body(jpeg()));
      const pendBytes = (() => jpeg())();
      const pendBody = body(pendBytes);
      const p2 = await intent(s.guard.token, s.run.id, pendBody);
      assert.equal((await put(p2.body.upload, pendBytes)).status, 200);
      const later = await evidenceSvc.completeUpload({ sub: s.guard.userId, role: 'guard' } as never, p2.body.evidence.id, new Date(now + 22 * HOUR));
      assert.equal(later.uploadStatus, 'verified');
      // After the window: a new photo, or a new URL for one never uploaded, is refused.
      await q(`UPDATE attendance_events SET "occurredAt" = $2, "recordedAt" = $2 WHERE "shiftId" = $1 AND type = 'check-out'`, [s.shift, new Date(now - 25 * HOUR)]);
      expect(await intent(s.guard.token, s.run.id, body(jpeg())), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'new photo after the window');
      const stale = await row(pend.body.evidence.id);
      expect(await intent(s.guard.token, s.run.id, { ...body(jpeg()), clientEvidenceId: stale.clientEvidenceId, sha256: stale.sha256Client,
        sizeBytes: Number(stale.declaredSizeBytes), capturedAtDevice: new Date(stale.capturedAtDevice).toISOString() }), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'no new URL after the window');
      const replay = await intent(s.guard.token, s.run.id, { ...body(jpeg()), clientEvidenceId: (await row(late.id)).clientEvidenceId, sha256: late.sha256Client,
        sizeBytes: late.declaredSizeBytes, capturedAtDevice: late.capturedAtDevice });
      assert.deepEqual([replay.status, replay.body.upload, replay.body.evidence.uploadStatus], [201, null, 'verified'], 'replay of an accepted photo still succeeds');

      // A photo arriving after the "evidence missing" alert annotates it and downgrades it — never closes it.
      const m = await scenario('l01m');
      const cp = await one(`INSERT INTO patrol_checkpoints ("companyId","siteId","publicId",label,"photoRequired") VALUES ($1,$2,$3,'Rear door',true) RETURNING *`,
        [m.co.id, m.site, require('node:crypto').randomBytes(16).toString('hex')]);
      await setPolicy(m.co.id, m.site, { escalateUnverified: true });
      const started = new Date(Date.now() - 3 * HOUR);
      const run = await insRun(m.co.id, m.site, m.shift, m.guard, started, 'completed');
      const visit = await one(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","checkpointId","scannedPublicId",result,"scannedAtDevice","clientVisitId")
        VALUES ($1,$2,$3,$4,'verified',$5,$6) RETURNING id`, [m.co.id, run.id, cp.id, cp.publicId, new Date(started.getTime() + 5 * MIN), cid('visit')]);
      const photo = jpeg();
      const pi = await intent(m.guard.token, Number(run.id), body(photo, { kind: 'checkpoint_photo', visitId: Number(visit.id) }));
      expect(pi, 201);
      await only(m.co.id, () => sweeper.sweep(new Date()));
      const exception = await one(`SELECT * FROM patrol_exceptions WHERE "runId" = $1 AND type = 'evidence_unverified'`, [run.id]);
      assert.ok(exception && exception.safetyAlertId, 'the sweep raised evidence_unverified with an alert (policy escalates)');
      const alertBefore = await one(`SELECT * FROM safety_alerts WHERE id = $1`, [exception.safetyAlertId]);
      assert.equal(alertBefore.status, 'open');
      assert.equal((await put(pi.body.upload, photo)).status, 200);
      expect(await complete(m.guard.token, pi.body.evidence.id), 200);
      const ex = await one(`SELECT * FROM patrol_exceptions WHERE id = $1`, [exception.id]);
      const alert = await one(`SELECT * FROM safety_alerts WHERE id = $1`, [exception.safetyAlertId]);
      assert.ok(ex.lateEvidenceAt, 'the exception records the late evidence');
      assert.deepEqual(ex.annotations.map((a: any) => a.kind), ['photo_after_alert']);
      assert.equal(ex.status, 'open', 'the exception is NOT resolved');
      assert.deepEqual([alert.status, alert.priority, Boolean(alert.patrolLateSyncAt)], ['open', 'low', true], 'the alert is downgraded and annotated, never closed');
      assert.ok((await row(pi.body.evidence.id)).syncFlags.includes('evidence_after_alert'));
      assert.ok((await one(`SELECT "syncFlags" FROM patrol_runs WHERE id = $1`, [run.id])).syncFlags.includes('evidence_after_alert'));
      const reasons = await api('GET', `/alerts/${alert.id}/resolution-reasons`, m.co.token);
      assert.ok(reasons.body.reasons.some((r: any) => r.value === 'patrol_completed_late_sync'), 'now resolvable as a late sync, by a person');
    });

    await test('PE-O01-AN-UPLOAD-WHOSE-COMPLETION-NEVER-ARRIVED-IS-VERIFIED-BY-MAINTENANCE', async () => {
      const s = await scenario('o01');
      const image = jpeg();
      const r = await intent(s.guard.token, s.run.id, body(image));
      assert.equal((await put(r.body.upload, image)).status, 200);
      await only(s.co.id, () => maintRun(new Date(Date.now() + 5 * MIN), 'report'));
      assert.equal((await row(r.body.evidence.id)).uploadStatus, 'pending', 'not before 10 minutes (the app may still complete it)');
      const c = await only(s.co.id, () => maintRun(new Date(Date.now() + 11 * MIN), 'report'));
      assert.equal(c.orphansCompleted, 1);
      const done = await row(r.body.evidence.id);
      assert.deepEqual([done.uploadStatus, done.sha256Stored], ['verified', sha256(image)]);
      const [audit] = await q(`SELECT * FROM audit_logs WHERE action = 'patrol.evidence_verified' AND "entityId" = $1`, [r.body.evidence.id]);
      assert.deepEqual([audit.afterData.via, audit.userId], ['maintenance', null]);
      expect(await complete(s.guard.token, r.body.evidence.id), 200, undefined, 'the app\'s late completion just returns the result');
    });

    await test('PE-W01-SWITCH-OFF-NEVER-SUSPENDS-RETENTION-HOLDS-DELETION-OR-EXPORTS', async () => {
      // Owner decision (#71): switching Patrols off stops new patrol activity; the evidence that exists keeps its lifecycle.
      const s = await scenario('w01');
      const admin = await mkMember(s.co.id, 'w01', 'admin');
      const ops = await mkMember(s.co.id, 'w01', 'operations');
      const cr = await mkMember(s.co.id, 'w01', 'control_room');
      const expiring = await uploadPhoto(s.guard.token, s.run.id, jpeg());
      const held = await uploadPhoto(s.guard.token, s.run.id, jpeg());
      const toDelete = await uploadPhoto(s.guard.token, s.run.id, jpeg());
      const toRestore = await uploadPhoto(s.guard.token, s.run.id, jpeg());
      const orphanImage = jpeg();
      const orphan = await intent(s.guard.token, s.run.id, body(orphanImage));
      expect(orphan, 201);
      assert.equal((await put(orphan.body.upload, orphanImage)).status, 200, 'the bytes reached storage; the completion never came');
      await exportsSvc.whenIdle();
      // An export requested before the switch-off and not yet built.
      const queued = await one(`INSERT INTO patrol_evidence_exports ("companyId","requestedByUserId","purpose","runIds","itemCount") VALUES ($1,$2,'incident',$3::jsonb,5) RETURNING *`,
        [s.co.id, s.co.ownerId, JSON.stringify([Number(s.run.id)])]);
      const none = await mkCompany('w01none'); // a company that never had patrol evidence
      expect(await api('PUT', `/admin/patrols/companies/${s.co.id}`, platform, { patrolsEnabled: false }), 200, undefined, 'switch off');
      expect(await api('PUT', `/admin/patrols/companies/${none.id}`, platform, { patrolsEnabled: false }), 200, undefined, 'switch off (no evidence)');
      try {
        // New patrol activity stays blocked, and so does everything that is not evidence lifecycle management.
        expect(await intent(s.guard.token, s.run.id, body(jpeg())), 404, 'PATROLS_NOT_ENABLED', 'no new upload');
        expect(await complete(s.guard.token, orphan.body.evidence.id), 404, 'PATROLS_NOT_ENABLED', 'no Guard completion');
        for (const p of ['/patrols/schedules', '/patrols/runs', `/patrols/runs/${s.run.id}/evidence`, `/patrols/evidence/${expiring.id}/download?purpose=review`]) {
          expect(await api('GET', p, s.co.token), 404, 'PATROLS_NOT_ENABLED', p);
        }
        // Evidence lifecycle management: Owner / Admin only; everyone else still sees no Patrols at all (404, not 403).
        for (const [who, tok] of [['operations', ops.token], ['control room', cr.token]] as Array<[string, string]>) {
          expect(await api('GET', '/patrols/holds', tok), 404, 'PATROLS_NOT_ENABLED', who);
          expect(await api('POST', '/patrols/holds', tok, { scope: 'evidence', evidenceId: held.id, reason: 'Not my call' }), 404, 'PATROLS_NOT_ENABLED', who);
          expect(await api('GET', '/patrols/exports', tok), 404, 'PATROLS_NOT_ENABLED', who);
          expect(await api('POST', `/patrols/evidence/${toDelete.id}/delete`, tok, { reason: 'Not my call' }), 404, 'PATROLS_NOT_ENABLED', who);
        }
        expect(await api('GET', '/patrols/holds', none.token), 404, 'PATROLS_NOT_ENABLED', 'a switched-off company without evidence sees nothing');
        expect(await api('GET', '/patrols/storage-usage', none.token), 404, 'PATROLS_NOT_ENABLED');
        expect(await api('GET', '/patrols/holds', s.co.token), 200, undefined, 'owner lists holds');
        const hold = await api('POST', '/patrols/holds', admin.token, { scope: 'evidence', evidenceId: held.id, reason: 'Client complaint after switch-off' });
        expect(hold, 201, undefined, 'admin places a hold');
        expect(await api('POST', `/patrols/evidence/${held.id}/delete`, s.co.token, { reason: 'try' }), 409, 'PATROL_EVIDENCE_HELD', 'the hold protects');
        const del = await api('POST', `/patrols/evidence/${toDelete.id}/delete`, s.co.token, { reason: 'Photo of the wrong site' });
        expect(del, 200, undefined, 'manual deletion');
        assert.equal(del.body.retentionStatus, 'quarantined');
        expect(await api('POST', `/patrols/evidence/${toRestore.id}/delete`, s.co.token, { reason: 'Deleted by mistake' }), 200);
        expect(await api('POST', `/patrols/evidence/${toRestore.id}/restore`, admin.token, { reason: 'Deleted by mistake' }), 200, undefined, 'restore');
        assert.equal((await row(toRestore.id)).retentionStatus, 'active');
        expect(await api('GET', '/patrols/storage-usage', s.co.token), 200, undefined, 'metering');
        // The export requested before the switch-off is built; a new one can be requested and downloaded.
        assert.ok(await exportsSvc.processPending() >= 1);
        const built = await api('GET', `/patrols/exports/${queued.id}`, s.co.token);
        expect(built, 200);
        assert.equal(built.body.status, 'ready', JSON.stringify(built.body.error));
        expect(await api('GET', `/patrols/exports/${queued.id}/download`, admin.token), 200, undefined, 'download the export');
        const fresh = await api('POST', '/patrols/exports', s.co.token, { purpose: 'legal', runIds: [Number(s.run.id)] });
        expect(fresh, 202, undefined, 'a new export of existing evidence');
        await exportsSvc.whenIdle();
        await exportsSvc.processPending();
        assert.equal((await one(`SELECT status FROM patrol_evidence_exports WHERE id = $1`, [fresh.body.id])).status, 'ready');
        assert.ok((await api('GET', '/patrols/exports', s.co.token)).body.some((e: any) => e.id === Number(queued.id)));

        // Maintenance keeps running for the switched-off company (and only where evidence exists).
        const scope = { companyIds: [s.co.id, none.id] };
        const first = await maint.run(new Date(Date.now() + 11 * MIN), 'report', scope);
        assert.equal(first.companies, 1, 'the switched-off company with evidence is processed; the one without is not');
        assert.equal(first.orphansCompleted, 1, 'an upload that reached storage is still verified');
        assert.equal((await row(orphan.body.evidence.id)).uploadStatus, 'verified');
        const deleted = await row(toDelete.id);
        await maint.run(new Date(new Date(deleted.purgeAfter).getTime() + 1000), 'enforce', scope);
        assert.equal((await row(toDelete.id)).retentionStatus, 'tombstone', 'the deletion state machine finishes: quarantine → purge → tombstone');
        assert.ok(!fake.objects.has(deleted.quarantineKey));
        const exp = await row(expiring.id);
        const expiry = new Date(exp.expiresAt).getTime();
        assert.equal((await maint.run(new Date(expiry - 1), 'enforce', scope)).claimed, 0, 'not before expiry');
        const atExpiry = await maint.run(new Date(expiry), 'enforce', scope);
        assert.ok(atExpiry.claimed >= 1 && atExpiry.quarantined >= 1, JSON.stringify(atExpiry));
        assert.deepEqual([(await row(expiring.id)).retentionStatus, (await row(expiring.id)).deletionReason], ['quarantined', 'retention_expired'], 'retention expiry continues');
        assert.equal((await row(held.id)).retentionStatus, 'active', 'held evidence is never claimed');
        assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.evidence_retention_claimed' AND "entityId" = $1`, [expiring.id]), 1);
        const quarantined = await row(expiring.id);
        await maint.run(new Date(new Date(quarantined.purgeAfter).getTime()), 'enforce', scope);
        assert.equal((await row(expiring.id)).retentionStatus, 'tombstone', 'and is purged after the quarantine period');
        assert.equal((await row(held.id)).retentionStatus, 'active', 'still held');
        // Releasing the hold (switch still off) lets retention proceed.
        expect(await api('POST', `/patrols/holds/${hold.body.id}/release`, s.co.token, { reason: 'Complaint withdrawn' }), 200);
        await maint.run(new Date(new Date(quarantined.purgeAfter).getTime() + 1000), 'enforce', scope);
        assert.equal((await row(held.id)).retentionStatus, 'quarantined', 'released: retention proceeds');
        await usageMatches(s.co.id, 'switched off');
        assert.equal(await count(`SELECT count(*) FROM patrol_runs WHERE "companyId" = $1`, [s.co.id]), 1, 'no new patrol activity was recorded');
      } finally {
        await q(`UPDATE companies SET "patrolsEnabled" = true WHERE id = ANY($1::int[])`, [[s.co.id, none.id]]);
      }
    });

    await test('PE-T01-CROSS-TENANT-EVERY-NEW-ROUTE', async () => {
      const ev = await uploadPhoto(A.guard.token, A.run.id, jpeg());
      const holdA = await api('POST', '/patrols/holds', A.co.token, { scope: 'evidence', evidenceId: ev.id, reason: 'Tenancy probe hold' });
      expect(holdA, 201);
      const probes: Array<[string, string, unknown?]> = [
        ['GET', `/patrols/evidence/${ev.id}/download?purpose=review`],
        ['POST', `/patrols/evidence/${ev.id}/delete`, { reason: 'probe' }],
        ['POST', `/patrols/evidence/${ev.id}/restore`, { reason: 'probe' }],
        ['POST', '/patrols/holds', { scope: 'evidence', evidenceId: ev.id, reason: 'probe' }],
        ['POST', `/patrols/holds/${holdA.body.id}/release`, { reason: 'probe' }],
        ['POST', '/patrols/exports', { purpose: 'audit', runIds: [Number(A.run.id)] }],
      ];
      const snapshot = JSON.stringify(await q(`SELECT * FROM patrol_evidence WHERE "companyId" = $1 ORDER BY id`, [A.co.id]));
      for (const [method, p, b] of probes) expect(await api(method, p, B.co.token, b), 404, undefined, `${method} ${p}`);
      expect(await intent(B.guard.token, A.run.id, body(jpeg())), 404, 'PATROL_NOT_FOUND');
      expect(await complete(B.guard.token, ev.id), 404, 'PATROL_NOT_FOUND');
      assert.equal(JSON.stringify(await q(`SELECT * FROM patrol_evidence WHERE "companyId" = $1 ORDER BY id`, [A.co.id])), snapshot, 'nothing of A changed');
      assert.equal(await count(`SELECT count(*) FROM patrol_evidence_exports WHERE "requestedByUserId" = $1`, [B.co.ownerId]), 0);
      const holds = await q(`SELECT * FROM patrol_evidence_holds WHERE id = $1`, [holdA.body.id]);
      assert.equal(holds[0].releasedAt, null);
      // The database refuses a cross-tenant hold or evidence link even if the service were bypassed (composite keys, M68).
      await assert.rejects(() => q(`INSERT INTO patrol_evidence_holds ("companyId",scope,"evidenceId",reason,source,"createdByUserId") VALUES ($1,'evidence',$2,'x','manual',$3)`,
        [B.co.id, ev.id, B.co.ownerId]), /FK_patrol_evidence_holds_evidence/);
      await assert.rejects(() => q(`INSERT INTO patrol_evidence ("companyId","siteId","runId","guardId","shiftId","sha256Client","capturedAtDevice","clientEvidenceId")
        VALUES ($1,$2,$3,$4,$5,$6,now(),'xtenant-0001')`, [B.co.id, B.site, A.run.id, B.guard.id, B.shift, 'e'.repeat(64)]), /FK_patrol_evidence_run/);
      expect(await api('POST', `/patrols/holds/${holdA.body.id}/release`, A.co.token, { reason: 'done with probe' }), 200);
    });

    await test('PE-X01-COMPLIANCE-STORAGE-UNTOUCHED-AND-NO-SECRET-ANYWHERE-IN-THE-DATABASE', async () => {
      const { S3CompatibleEvidenceStorageService } = await import('../src/compliance/evidence-storage.service');
      const compliance = new S3CompatibleEvidenceStorageService();
      process.env.EVIDENCE_STORAGE_ENDPOINT = 'https://compliance.example';
      process.env.EVIDENCE_STORAGE_REGION = 'auto';
      process.env.EVIDENCE_STORAGE_BUCKET = 'c';
      process.env.EVIDENCE_STORAGE_ACCESS_KEY_ID = 'k';
      process.env.EVIDENCE_STORAGE_SECRET_ACCESS_KEY = 's';
      try {
        await assert.rejects(() => Promise.resolve().then(() => compliance.createSignedDownloadUrl({ key: `patrol/1/2026/10/${randomUUID()}`, mimeType: 'image/jpeg', originalFileName: 'x' })), /Invalid evidence object key/,
          'the compliance store never signs a patrol key');
        const ok = await compliance.createSignedDownloadUrl({ key: `compliance/guard/1/${randomUUID()}`, mimeType: 'application/pdf', originalFileName: 'x' });
        assert.ok(ok.url.startsWith('https://compliance.example/c/compliance/guard/1/'), 'compliance keys behave as before');
      } finally {
        for (const k of ['ENDPOINT', 'REGION', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) delete process.env[`EVIDENCE_STORAGE_${k}`];
      }
      const store = app.get((await import('../src/patrol/evidence/patrol-object-store')).PatrolObjectStore);
      assert.throws(() => store.presignDownload(`compliance/guard/1/${randomUUID()}`, { contentType: 'application/pdf', fileName: 'x.pdf' }), /invalid_key/,
        'the patrol store never signs a compliance key');
      const audits = await q(`SELECT action, "beforeData", "afterData" FROM audit_logs WHERE action LIKE 'patrol.%'`);
      assert.ok(audits.length > 50);
      noSecretsIn(audits, 'patrol audit entries');
      noSecretsIn(await q(`SELECT "lastDeletionError", "rejectionReason" FROM patrol_evidence`), 'evidence error columns');
      noSecretsIn(await q(`SELECT error FROM patrol_evidence_exports`), 'export errors');
      assert.ok(fake.log.every((l) => !('url' in l)), 'the storage server logs no URLs either');
    });
  } finally {
    await exportsSvc.whenIdle().catch(() => undefined);
    await app.close();
    await fake.stop();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  console.log(JSON.stringify({ event: 'patrol_evidence_certified', tests: passed }));
  if (failures.length) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

/** Tests a ZIP with whatever independent reader this machine has (unzip, Python's zipfile, or .NET's ZipFile). */
function independentZipCheck(file: string): string {
  const unzip = spawnSync('unzip', ['-tq', file], { encoding: 'utf8' });
  if (!unzip.error) {
    assert.equal(unzip.status, 0, `unzip -t: ${unzip.stdout} ${unzip.stderr}`);
    return 'unzip -t OK';
  }
  for (const py of ['python3', 'python']) {
    const r = spawnSync(py, ['-I', '-m', 'zipfile', '-t', file], { encoding: 'utf8' });
    if (!r.error && r.status !== 9009 && !/not found|Microsoft Store/i.test(`${r.stdout}${r.stderr}`)) {
      assert.equal(r.status, 0, `python zipfile -t: ${r.stdout} ${r.stderr}`);
      return `${py} zipfile -t OK`;
    }
  }
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead('${file.replace(/'/g, "''")}'); ` +
      `foreach ($e in $z.Entries) { $s = $e.Open(); $b = New-Object byte[] 65536; while ($s.Read($b, 0, $b.Length) -gt 0) {}; $s.Close() }; $z.Entries.Count; $z.Dispose()`], { encoding: 'utf8' });
    if (!ps.error) {
      assert.equal(ps.status, 0, `.NET ZipFile: ${ps.stderr}`);
      return `.NET ZipFile OK (${ps.stdout.trim()} entries)`;
    }
  }
  return 'no independent reader on this machine (own parser only)';
}

main().catch((error) => {
  console.error(String(error?.stack ?? error).replace(/https?:\/\/\S+/g, '[url]'));
  process.exit(1);
});
