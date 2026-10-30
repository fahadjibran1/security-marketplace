/**
 * Patrols issue #79: permission-controlled, paginated, lazy-loaded evidence thumbnails for the company dashboard.
 *
 * Design under test: GET /patrols/runs/:id/evidence/thumbnails?page=&pageSize= issues, for ONE page of a run's photos
 * (≤ 24), the same short-lived presigned GET of the stored photo that GET /patrols/evidence/:id/download issues, and
 * writes ONE audit entry for the whole page (purpose 'browse'). No thumbnail object is ever written, so a thumbnail is
 * covered by exactly the original photo's retention, holds, deletion, quarantine and purge. The whole application over
 * HTTP against the in-process SigV4-verifying storage server (scripts/fixtures/fake-s3-server.ts), on a disposable
 * database built from the repository's own migrations.
 *
 *   PT-01  permissions and tenancy: patrols.evidence roles only (viewer / finance / HR / Guard / platform 403), another
 *          company's run 404, Patrols switched off 404 PATROLS_NOT_ENABLED, storage unconfigured 503 after authorisation
 *   PT-02  pagination: the run's photos in the metadata order, bounded page size (default 12, max 24), totals, beyond the
 *          last page empty; invalid page / pageSize refused
 *   PT-03  audit volume: exactly ONE audit entry per page view (purpose browse) naming only the photos it granted, and
 *          no per-photo access entries; a page with nothing viewable is not audited; no URL or secret in the audit trail
 *   PT-04  the links: short-lived (≤ 300 s) signed GETs of the exact stored bytes, never public, response not cacheable,
 *          never persisted in the database or the metadata
 *   PT-05  pending, rejected, quarantined (deleted) and retention-expired photos get no link; deleting a photo removes the
 *          object every earlier thumbnail link pointed at; a held photo past its retention keeps its thumbnail
 *
 * Needs PATROL_EVIDENCE_THUMBNAILS_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { startFakeS3 } from './fixtures/fake-s3-server';
import { jpeg, sha256, zipTail } from './fixtures/patrol-test-images';

const url = process.env.PATROL_EVIDENCE_THUMBNAILS_DATABASE_URL;
if (!url) throw new Error('PATROL_EVIDENCE_THUMBNAILS_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Patrol thumbnails database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-thumbnails-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
for (const key of ['RESEND_API_KEY', 'EXPO_ACCESS_TOKEN', 'PUSH_WELFARE_REMINDERS_ENABLED', 'PUSH_GUARD_NOTIFICATIONS_ENABLED', 'PATROL_QR_SIGNING_KEY',
  'PATROL_QR_PREVIOUS_SIGNING_KEY', 'PATROL_EVIDENCE_STORAGE_PREFIX', 'PATROL_EVIDENCE_MAX_BYTES', 'PATROL_EVIDENCE_URL_TTL_SECONDS',
  'PATROL_EVIDENCE_STORAGE_CHECKSUM_HEADER', 'PATROL_EVIDENCE_STORAGE_SIGN_CONTENT_LENGTH', 'PATROL_EVIDENCE_RETENTION_MODE']) {
  delete process.env[key];
}
// Synthetic test-only credentials for the in-process storage server (not a real account, never used anywhere else).
const STORAGE = { accessKeyId: 'S4TESTACCESSKEY000079', secretAccessKey: 'synthetic-test-secret-not-a-real-credential-0079', bucket: 's4-patrol-thumbs-test', region: 'auto' };

let passed = 0;
const failures: string[] = [];
const scrub = (text: string) => text.replace(/https?:\/\/\S+/g, '[url]').replace(/X-Amz-[A-Za-z]+=[^&\s"]+/g, '[redacted]');
const test = async (id: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failures.push(id);
    // Never print a presigned URL.
    console.log(`FAIL  ${id}\n      ${scrub(String((error as Error)?.stack ?? error)).split('\n').slice(0, 12).join('\n      ')}`);
  }
};

type Res = { status: number; body: any; headers: Headers };
const PASSWORD = 'patrol-thumbnails-spec-only-password-1';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
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
  await migrate.runMigrations({ transaction: 'each' });
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
  app.get(PatrolSweepService).onModuleDestroy();
  app.get(SafetyAlertService).onModuleDestroy();
  const maint = app.get(PatrolEvidenceMaintenanceService);
  maint.onModuleDestroy(); // every maintenance pass in this suite is explicit, on its own clock
  const exportsSvc = app.get(PatrolEvidenceExportService);
  const auth = app.get(AuthService);

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const api = async (method: string, p: string, tok: string | null, body?: unknown): Promise<Res> => {
    const res = await fetch(baseUrl + p, {
      method,
      headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  const expect = (r: Res, status: number, code?: string, what = '') => {
    const safeBody = scrub(JSON.stringify(r.body));
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
    const ownerEmail = `pt.${label}.owner@example.invalid`;
    const ownerId = await mkUser(ownerEmail, 'company_admin');
    const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,$2,$3,'1 Way','ops@example.invalid',true) RETURNING id`,
      [ownerId, `PT ${label} Ltd`, String(79000000 + seq)]);
    testCompanies.push(Number(id));
    return { id: Number(id), ownerId, token: await login(ownerEmail) };
  };
  const mkGuard = async (label: string) => {
    seq += 1;
    const email = `pt.${label}@example.invalid`;
    const userId = await mkUser(email, 'guard');
    const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, `Guard ${label}`, `79${String(seq).padStart(14, '0')}`, `0779${String(seq).padStart(7, '0')}`]);
    return { id: Number(id), userId, token: await login(email) };
  };
  const mkMember = async (companyId: number, label: string, role: string) => {
    const email = `pt.${label}.${role}@example.invalid`;
    const userId = await mkUser(email, 'company_admin');
    await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [userId, companyId, role]);
    return { userId, token: await login(email) };
  };
  /** A Guard on an in-progress shift with a run in progress. */
  const scenario = async (label: string) => {
    const co = await mkCompany(label);
    const site = Number((await one(`INSERT INTO sites ("companyId",name,address,timezone) VALUES ($1,$2,'3 Quay','Europe/London') RETURNING id`, [co.id, `${label} Gate`])).id);
    const guard = await mkGuard(`${label}g`);
    const now = Date.now();
    const shift = Number((await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Gate',$3,'in_progress',$4,$5) RETURNING id`,
      [co.id, site, guard.id, new Date(now - 2 * 60 * MIN), new Date(now + 6 * 60 * MIN)])).id);
    await q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-in',$3,$3,false)`, [shift, guard.id, new Date(now - 2 * 60 * MIN)]);
    const run = await one(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId",status,"startedAtDevice","startedAtServer","clientRunId")
       VALUES ($1,$2,$3,$4,$5,'in_progress',$6,$6,$7) RETURNING *`, [co.id, site, shift, guard.id, guard.userId, new Date(now - 30 * MIN), cid('run')]);
    return { co, site, guard, shift, run: { id: Number(run.id) } };
  };
  /** Only this company has Patrols switched on while fn runs (so a maintenance pass touches only it). */
  const only = async <T>(companyId: number, fn: () => Promise<T>): Promise<T> => {
    await q(`UPDATE companies SET "patrolsEnabled" = (id = $1) WHERE id = ANY($2::int[])`, [companyId, testCompanies]);
    try { return await fn(); } finally { await q(`UPDATE companies SET "patrolsEnabled" = true WHERE id = ANY($1::int[])`, [testCompanies]); }
  };

  let minute = 0;
  const body = (image: Buffer) => ({
    // Distinct, increasing capture times so the order is the capture order (as the dashboard lists it).
    clientEvidenceId: cid('ev'), kind: 'run_photo', contentType: 'image/jpeg', sizeBytes: image.length, sha256: sha256(image),
    capturedAtDevice: new Date(Date.now() - 25 * MIN + (++minute) * 1000).toISOString(),
  });
  const intent = (tok: string, runId: number, image: Buffer) => api('POST', `/patrols/runs/${runId}/evidence`, tok, body(image));
  const put = (upload: any, bytes: Buffer) => fetch(upload.url, { method: 'PUT', headers: upload.headers, body: new Uint8Array(bytes) });
  const uploadPhoto = async (tok: string, runId: number, image: Buffer) => {
    const r = await intent(tok, runId, image);
    expect(r, 201, undefined, 'intent');
    assert.equal((await put(r.body.upload, image)).status, 200, 'the signed PUT is accepted by storage');
    const c = await api('POST', `/patrols/evidence/${r.body.evidence.id}/complete`, tok);
    expect(c, 200, undefined, 'complete');
    return c.body;
  };
  const thumbs = (runId: number, tok: string, query = '') => api('GET', `/patrols/runs/${runId}/evidence/thumbnails${query}`, tok);
  const browseAudits = (runId: number) =>
    q(`SELECT * FROM audit_logs WHERE action = 'patrol.evidence_thumbnails_accessed' AND "entityType" = 'patrol_run' AND "entityId" = $1 ORDER BY id`, [runId]);
  const noSecretsIn = (value: unknown, what: string) => {
    const text = JSON.stringify(value);
    for (const needle of ['X-Amz-Signature', 'X-Amz-Credential', STORAGE.secretAccessKey, STORAGE.accessKeyId, fake.url]) {
      assert.ok(!text.includes(needle), `${what} must not contain a URL, signature or credential`);
    }
  };

  const A = await scenario('alpha');
  const B = await scenario('beta');
  const staffA: Record<string, { userId: number; token: string }> = {};
  for (const role of ['admin', 'operations', 'control_room', 'viewer', 'finance', 'hr_compliance']) staffA[role] = await mkMember(A.co.id, 'alpha', role);
  const platformEmail = 'pt.platform@example.invalid';
  await mkUser(platformEmail, 'admin');
  const platform = await login(platformEmail);

  // Run A: 27 verified photos, one pending (never uploaded), one rejected (polyglot), one deleted (quarantined) = 30.
  const images = new Map<number, Buffer>();
  const ids: number[] = [];
  for (let i = 0; i < 27; i += 1) {
    const image = jpeg({ nonce: `thumb-${i}` });
    const ev = await uploadPhoto(A.guard.token, A.run.id, image);
    images.set(ev.id, image);
    ids.push(ev.id);
  }
  const pending = (await intent(A.guard.token, A.run.id, jpeg({ nonce: 'pending' }))).body.evidence.id as number;
  ids.push(pending);
  const polyglot = Buffer.concat([jpeg({ nonce: 'poly' }), zipTail()]);
  const bad = await intent(A.guard.token, A.run.id, polyglot);
  await put(bad.body.upload, polyglot);
  await api('POST', `/patrols/evidence/${bad.body.evidence.id}/complete`, A.guard.token);
  const rejected = bad.body.evidence.id as number;
  ids.push(rejected);
  const deletedImage = jpeg({ nonce: 'to-delete' });
  const deleted = (await uploadPhoto(A.guard.token, A.run.id, deletedImage)).id as number;
  images.set(deleted, deletedImage);
  ids.push(deleted);

  try {
    await test('PT-01-PERMISSIONS-TENANCY-SWITCH-AND-STORAGE', async () => {
      for (const [who, tok, status, code] of [
        ['owner', A.co.token, 200], ['admin', staffA.admin.token, 200], ['operations', staffA.operations.token, 200], ['control room', staffA.control_room.token, 200],
        ['viewer', staffA.viewer.token, 403, 'PATROL_FORBIDDEN'], ['finance', staffA.finance.token, 403, 'PATROL_FORBIDDEN'], ['hr', staffA.hr_compliance.token, 403, 'PATROL_FORBIDDEN'],
        ['guard', A.guard.token, 403], ['platform', platform, 403], ['other company', B.co.token, 404, 'PATROL_NOT_FOUND'],
      ] as Array<[string, string, number, string?]>) {
        const r = await thumbs(A.run.id, tok);
        expect(r, status, code, who);
        if (status !== 200) noSecretsIn(r.body, `${who} refusal`);
      }
      expect(await api('GET', `/patrols/runs/${A.run.id}/evidence/thumbnails`, null), 401, undefined, 'anonymous');
      expect(await thumbs(999_999_999, A.co.token), 404, 'PATROL_NOT_FOUND', 'a run that does not exist');
      // Nothing was granted to anyone refused.
      const refusedUsers = [staffA.viewer.userId, staffA.finance.userId, staffA.hr_compliance.userId, B.co.ownerId];
      assert.equal((await q(`SELECT 1 FROM audit_logs WHERE action LIKE 'patrol.evidence_%accessed' AND "userId" = ANY($1::int[])`, [refusedUsers])).length, 0);

      await q(`UPDATE companies SET "patrolsEnabled" = false WHERE id = $1`, [A.co.id]);
      try {
        expect(await thumbs(A.run.id, A.co.token), 404, 'PATROLS_NOT_ENABLED', 'switch off');
        expect(await thumbs(A.run.id, staffA.viewer.token), 404, 'PATROLS_NOT_ENABLED', 'switch off (viewer)');
      } finally {
        await q(`UPDATE companies SET "patrolsEnabled" = true WHERE id = $1`, [A.co.id]);
      }

      clearStorageEnv();
      try {
        expect(await thumbs(A.run.id, A.co.token), 503, 'PATROL_EVIDENCE_STORAGE_UNAVAILABLE', 'storage unconfigured');
        expect(await thumbs(A.run.id, staffA.viewer.token), 403, 'PATROL_FORBIDDEN', 'authorisation first (viewer)');
        expect(await thumbs(A.run.id, B.co.token), 404, 'PATROL_NOT_FOUND', 'authorisation first (other company)');
      } finally {
        setStorageEnv();
      }
    });

    await test('PT-02-PAGINATION-ORDER-BOUNDS-AND-TOTALS', async () => {
      const meta = await api('GET', `/patrols/runs/${A.run.id}/evidence`, A.co.token);
      expect(meta, 200);
      const order = meta.body.map((e: any) => e.id);
      assert.deepEqual(order, ids, 'metadata lists the run in capture order');
      const p1 = await thumbs(A.run.id, A.co.token);
      expect(p1, 200);
      assert.deepEqual([p1.body.runId, p1.body.page, p1.body.pageSize, p1.body.total, p1.body.totalPages], [A.run.id, 1, 12, 30, 3], 'default page');
      const seen: number[] = [];
      for (const page of [1, 2, 3]) {
        const r = await thumbs(A.run.id, A.co.token, `?page=${page}&pageSize=12`);
        expect(r, 200, undefined, `page ${page}`);
        assert.equal(r.body.items.length, page === 3 ? 6 : 12);
        seen.push(...r.body.items.map((i: any) => i.evidenceId));
      }
      assert.deepEqual(seen, order, 'page N of the thumbnails is page N of the metadata, nothing missing or repeated');
      const max = await thumbs(A.run.id, A.co.token, '?pageSize=24');
      expect(max, 200);
      assert.deepEqual([max.body.items.length, max.body.totalPages], [24, 2]);
      const beyond = await thumbs(A.run.id, A.co.token, '?page=4&pageSize=12');
      expect(beyond, 200);
      assert.deepEqual([beyond.body.items, beyond.body.expiresAt], [[], null], 'beyond the last page');
      for (const bad of ['?pageSize=25', '?pageSize=0', '?page=0', '?page=-1', '?page=abc', '?purpose=review', '?pageSize=1000']) {
        expect(await thumbs(A.run.id, A.co.token, bad), 400, undefined, bad);
      }
      const empty = await scenario('empty');
      const none = await thumbs(empty.run.id, empty.co.token);
      expect(none, 200);
      assert.deepEqual([none.body.total, none.body.totalPages, none.body.items, none.body.expiresAt], [0, 1, [], null], 'a run without photos');
    });

    await test('PT-03-ONE-AUDIT-ENTRY-PER-PAGE-VIEW-PURPOSE-BROWSE', async () => {
      const before = (await browseAudits(A.run.id)).length;
      const perPhotoBefore = Number((await one(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.evidence_accessed' AND "entityId" = ANY($1::int[])`, [ids])).count);
      const r = await thumbs(A.run.id, staffA.operations.token, '?page=1&pageSize=24');
      expect(r, 200);
      const granted = r.body.items.filter((i: any) => i.url).map((i: any) => i.evidenceId);
      assert.equal(granted.length, 24, '24 previews');
      const after = await browseAudits(A.run.id);
      assert.equal(after.length, before + 1, 'ONE audit entry for 24 photos');
      const entry = after[after.length - 1];
      assert.deepEqual([Number(entry.userId), Number(entry.companyId), entry.afterData.purpose, entry.afterData.page, entry.afterData.pageSize],
        [staffA.operations.userId, A.co.id, 'browse', 1, 24]);
      assert.deepEqual(entry.afterData.evidenceIds, granted, 'names exactly the photos it granted');
      assert.ok(entry.afterData.ttlSeconds >= 60 && entry.afterData.ttlSeconds <= 300);
      assert.equal(entry.afterData.linkExpiresAt, r.body.expiresAt);
      noSecretsIn(after, 'browse audit');
      const perPhotoAfter = Number((await one(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.evidence_accessed' AND "entityId" = ANY($1::int[])`, [ids])).count);
      assert.equal(perPhotoAfter, perPhotoBefore, 'no per-photo access entries for previews');

      // The last three photos (page 10 of 3): pending, rejected, and one deleted now. A page with nothing viewable is not
      // audited (nothing was granted).
      expect(await api('POST', `/patrols/evidence/${deleted}/delete`, A.co.token, { reason: 'Photo of the wrong site' }), 200);
      const tail = await thumbs(A.run.id, A.co.token, '?page=10&pageSize=3');
      expect(tail, 200);
      assert.deepEqual(tail.body.items.map((i: any) => [i.evidenceId, i.url]), [[pending, null], [rejected, null], [deleted, null]]);
      assert.equal(tail.body.expiresAt, null);
      assert.equal((await browseAudits(A.run.id)).length, before + 1, 'nothing granted, nothing audited');
    });

    await test('PT-04-SHORT-LIVED-PRIVATE-LINKS-OF-THE-EXACT-BYTES-NEVER-PERSISTED', async () => {
      const r = await thumbs(A.run.id, staffA.control_room.token, '?page=1&pageSize=6');
      expect(r, 200);
      assert.match(String(r.headers.get('cache-control')), /no-store/, 'the response is never cached');
      for (const item of r.body.items) {
        const u = new URL(item.url);
        const expires = Number(u.searchParams.get('X-Amz-Expires'));
        assert.ok(expires >= 60 && expires <= 300, `≤ 300 s (${expires})`);
        assert.equal(item.expiresAt, r.body.expiresAt);
        const got = await fetch(item.url);
        assert.equal(got.status, 200);
        assert.equal(got.headers.get('content-type'), 'image/jpeg');
        assert.equal(sha256(Buffer.from(await got.arrayBuffer())), sha256(images.get(item.evidenceId)!), 'exact stored bytes');
        assert.equal((await fetch(`${u.origin}${u.pathname}`)).status, 403, 'the object is not public');
        const other = new URL(item.url);
        other.pathname = other.pathname.replace(`/${A.co.id}/`, `/${B.co.id}/`);
        assert.equal((await fetch(other)).status, 403, 'a link cannot be re-pointed at another object');
      }
      // Nothing durable holds a link: the evidence rows, every audit entry and the metadata.
      noSecretsIn(await q(`SELECT * FROM patrol_evidence WHERE "runId" = $1`, [A.run.id]), 'evidence rows');
      noSecretsIn(await q(`SELECT "beforeData", "afterData" FROM audit_logs WHERE action LIKE 'patrol.%'`), 'patrol audit entries');
      const meta = await api('GET', `/patrols/runs/${A.run.id}/evidence`, A.co.token);
      noSecretsIn(meta.body, 'evidence metadata');
      const detail = await api('GET', `/patrols/runs/${A.run.id}`, A.co.token);
      noSecretsIn(detail.body, 'run detail');
    });

    await test('PT-05-DELETION-QUARANTINE-RETENTION-AND-HOLDS-APPLY-TO-THUMBNAILS', async () => {
      const s = await scenario('retain');
      const keep = await uploadPhoto(s.guard.token, s.run.id, jpeg({ nonce: 'keep' }));
      const expire = await uploadPhoto(s.guard.token, s.run.id, jpeg({ nonce: 'expire' }));
      const remove = await uploadPhoto(s.guard.token, s.run.id, jpeg({ nonce: 'remove' }));
      const first = await thumbs(s.run.id, s.co.token);
      expect(first, 200);
      assert.equal(first.body.items.filter((i: any) => i.url).length, 3);
      const earlier = new Map<number, string>(first.body.items.map((i: any) => [i.evidenceId, i.url]));

      // Deleting a photo removes the object every earlier preview link pointed at; it gets no new link.
      expect(await api('POST', `/patrols/evidence/${remove.id}/delete`, s.co.token, { reason: 'Photo of the wrong site' }), 200);
      assert.equal((await fetch(earlier.get(remove.id)!)).status, 404, 'the deleted photo is gone from the verified area');
      const afterDelete = await thumbs(s.run.id, s.co.token);
      assert.equal(afterDelete.body.items.find((i: any) => i.evidenceId === remove.id).url, null, 'quarantined: no link');

      // Restoring a deleted photo brings its preview back (under its NEW key, through the same rule).
      expect(await api('POST', `/patrols/evidence/${remove.id}/restore`, s.co.token, { reason: 'Deleted by mistake' }), 200);
      const restored = await thumbs(s.run.id, s.co.token);
      const link = restored.body.items.find((i: any) => i.evidenceId === remove.id).url;
      assert.ok(link, 'restored photo has a preview again');
      assert.equal((await fetch(link)).status, 200);
      assert.equal((await fetch(earlier.get(remove.id)!)).status, 404, 'the pre-deletion link still reaches nothing');

      // Retention (enforce, 40 days on): the unheld photo is quarantined and loses its preview; the held one keeps it.
      expect(await api('POST', '/patrols/holds', s.co.token, { scope: 'evidence', evidenceId: keep.id, reason: 'Keep for the investigation' }), 201);
      await only(s.co.id, () => maint.run(new Date(Date.now() + 40 * DAY), 'enforce'));
      const [kept, expired] = await Promise.all([one(`SELECT * FROM patrol_evidence WHERE id = $1`, [keep.id]), one(`SELECT * FROM patrol_evidence WHERE id = $1`, [expire.id])]);
      assert.equal(kept.retentionStatus, 'active', 'held photo kept');
      assert.equal(expired.retentionStatus, 'quarantined', 'expired photo quarantined');
      assert.equal((await fetch(earlier.get(expire.id)!)).status, 404, 'its earlier preview link no longer reaches it');
      const later = await thumbs(s.run.id, s.co.token);
      expect(later, 200);
      const byId = new Map<number, string | null>(later.body.items.map((i: any) => [i.evidenceId, i.url]));
      assert.ok(byId.get(keep.id), 'the held photo still has a preview');
      assert.equal(byId.get(expire.id), null);
      assert.equal(byId.get(remove.id), null);
      const audit = (await browseAudits(s.run.id)).pop();
      assert.deepEqual(audit.afterData.evidenceIds, [keep.id], 'the audit names only what was granted');
    });
  } finally {
    await exportsSvc.whenIdle().catch(() => undefined);
    await app.close();
    await fake.stop();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  console.log(JSON.stringify({ event: 'patrol_evidence_thumbnails_certified', tests: passed }));
  if (failures.length) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(scrub(String(error?.stack ?? error)));
  process.exit(1);
});
