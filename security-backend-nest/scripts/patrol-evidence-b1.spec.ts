/**
 * S4 1.3.0 B1 evidence reads and stamped photos, over HTTP against the in-process SigV4-verifying storage server
 * (scripts/fixtures/fake-s3-server.ts), on a disposable database built from the repository's own migrations.
 *
 *   PEB-01  GET /patrols/evidence/tree: clients → sites → site-local days with patrols (with / without photos); patrols.view;
 *           client and site filters; range validation; another company's client or site 404; Guards refused
 *   PEB-02  GET /patrols/evidence/patrols: cards (P-ref, run, window, Guard display name, QR scans, photo states, links to the
 *           existing thumbnail page and the stamped view, verification + explanation); QR-only patrols INCLUDED; photos=only
 *           keeps patrols with a photo; a viewer (no patrols.evidence) sees no photo detail; another company 404
 *   PEB-03  GET /patrols/evidence/:id/stamped: a JPEG derived per request (the stamp drawn on it), streamed with no-store;
 *           the stored original's bytes and SHA-256 are unchanged and nothing is written to storage (only a GET); audited
 *           patrol.evidence_stamped_accessed (never a URL); patrols.evidence only; another company 404; pending /
 *           rejected / quarantined / purged photos refused exactly as viewing the original (409 PATROL_EVIDENCE_NOT_AVAILABLE)
 *   PEB-04  a stored object that no longer matches its verified SHA-256, or cannot be decoded, is refused (409 / 422) and
 *           nothing is audited as accessed; storage unconfigured: 503 after authorisation
 *   PEB-05  the deployed 1.2.1 Guard app's request sequence on a shift-anchored window of a QR + photos site (plan → start
 *           with the window's scheduleId / routeId → signed scan → photo intent / PUT / complete → run complete) verifies;
 *           the plan never asks it for the checkpoint's own photo
 *   PEB-06  (B2 correction) the checkpoint photo follows the RUN's own route: at an overlap site (an automatic route,
 *           the checkpoint also on a spare custom route) the plan asks the 1.2.1 app for no photo and the run verifies;
 *           a declined-prompt reason there neither makes the run incomplete nor raises an exception (an unreached checkpoint
 *           still does); a custom route keeps its photo — supplied: verified, declined: incomplete + patrol_incomplete
 *   PEB-07  the excuse is STRUCTURAL: a reason completes the run only when the run needs no checkpoint photo, every
 *           required checkpoint has a non-flagged visit, the run's own photo is already verified, and a photo-flagged
 *           checkpoint's photo was really declined — cases 1–9 (run photo missing / rejected / quarantined, unreached or
 *           flagged checkpoint, free text, photo-only, custom route, nothing prompted) stay incomplete + patrol_incomplete
 *
 * Needs PATROL_EVIDENCE_B1_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { startFakeS3 } from './fixtures/fake-s3-server';

const url = process.env.PATROL_EVIDENCE_B1_DATABASE_URL;
if (!url) throw new Error('PATROL_EVIDENCE_B1_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Patrol evidence B1 database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-evidence-b1-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
for (const key of ['RESEND_API_KEY', 'EXPO_ACCESS_TOKEN', 'PUSH_WELFARE_REMINDERS_ENABLED', 'PUSH_GUARD_NOTIFICATIONS_ENABLED', 'PATROL_QR_SIGNING_KEY',
  'PATROL_QR_PREVIOUS_SIGNING_KEY', 'PATROL_EVIDENCE_STORAGE_PREFIX', 'PATROL_EVIDENCE_MAX_BYTES', 'PATROL_EVIDENCE_URL_TTL_SECONDS',
  'PATROL_EVIDENCE_STORAGE_CHECKSUM_HEADER', 'PATROL_EVIDENCE_STORAGE_SIGN_CONTENT_LENGTH', 'PATROL_EVIDENCE_RETENTION_MODE']) {
  delete process.env[key];
}
// Synthetic test-only credentials for the in-process storage server (not a real account, never used anywhere else).
const STORAGE = { accessKeyId: 'S4TESTACCESSKEY000074', secretAccessKey: 'synthetic-test-secret-not-a-real-credential-0074', bucket: 's4-patrol-b1-test', region: 'auto' };

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
    console.log(`FAIL  ${id}\n      ${scrub(String((error as Error)?.stack ?? error)).split('\n').slice(0, 12).join('\n      ')}`);
  }
};

type Res = { status: number; body: any; headers: Headers; bytes: Buffer };
const PASSWORD = 'patrol-evidence-b1-spec-only-password-1';
const MIN = 60_000;
let seqId = 0;
const cid = (p: string) => `${p}-${Date.now().toString(36)}-${(++seqId).toString().padStart(5, '0')}`;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function main() {
  const sharp = require('sharp');
  const fake = await startFakeS3(STORAGE);
  const setStorageEnv = () => {
    process.env.PATROL_EVIDENCE_STORAGE_ENDPOINT = fake.url;
    process.env.PATROL_EVIDENCE_STORAGE_REGION = STORAGE.region;
    process.env.PATROL_EVIDENCE_STORAGE_BUCKET = STORAGE.bucket;
    process.env.PATROL_EVIDENCE_STORAGE_ACCESS_KEY_ID = STORAGE.accessKeyId;
    process.env.PATROL_EVIDENCE_STORAGE_SECRET_ACCESS_KEY = STORAGE.secretAccessKey;
  };
  setStorageEnv();

  const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
  const allFiles: string[] = fs.readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).sort();
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const base = buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' });
  const migrate = new DataSource({ ...base, entities: [], migrations: allFiles.map((f) => path.join(migrationsDir, f)), dropSchema: true } as never);
  await migrate.initialize();
  const migrated = await migrate.runMigrations({ transaction: 'each' });
  assert.equal(migrated[migrated.length - 1]?.name, 'AddPatrolSiteSetup1720900000021');
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
  app.get(PatrolSweepService).onModuleDestroy();
  app.get(SafetyAlertService).onModuleDestroy();
  app.get(PatrolEvidenceMaintenanceService).onModuleDestroy();
  const auth = app.get(AuthService);
  const ST = await import('../src/patrol/evidence/patrol-evidence-stamp');

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const api = async (method: string, p: string, tok: string | null, body?: unknown): Promise<Res> => {
    const res = await fetch(baseUrl + p, {
      method,
      headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    let json: any = null;
    if (/json/.test(res.headers.get('content-type') ?? '')) {
      try { json = JSON.parse(bytes.toString('utf8')); } catch { json = null; }
    }
    return { status: res.status, body: json, headers: res.headers, bytes };
  };
  const expect = (r: Res, status: number, code?: string, what = '') => {
    const safeBody = scrub(JSON.stringify(r.body));
    assert.equal(r.status, status, `${what} expected ${status}${code ? ` ${code}` : ''}, got ${r.status} ${safeBody}`);
    if (code) assert.equal(r.body?.code, code, `${what} code: ${safeBody}`);
    return r.body;
  };
  const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;

  // ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash(PASSWORD, 4);
  let seq = 0;
  const mkUser = async (email: string, role: string) =>
    Number((await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
       VALUES ($1,$2,$3,'active',true,false,$4,'Spec') RETURNING id`, [email, hash, role, email.split('@')[0]])).id);
  const mkCompany = async (label: string, name: string) => {
    seq += 1;
    const ownerEmail = `peb.${label}.owner@example.invalid`;
    const ownerId = await mkUser(ownerEmail, 'company_admin');
    const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,$2,$3,'1 Way','ops@example.invalid',true) RETURNING id`,
      [ownerId, name, String(74100000 + seq)]);
    return { id: Number(id), ownerId, token: await login(ownerEmail) };
  };
  const mkMember = async (companyId: number, label: string, role: string) => {
    const email = `peb.${label}.${role}@example.invalid`;
    const userId = await mkUser(email, 'company_admin');
    await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [userId, companyId, role]);
    return login(email);
  };
  const mkGuard = async (label: string, fullName: string) => {
    seq += 1;
    const email = `peb.${label}@example.invalid`;
    const userId = await mkUser(email, 'guard');
    const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, fullName, `741${String(seq).padStart(13, '0')}`, `0774${String(seq).padStart(7, '1')}`]);
    return { id: Number(id), userId, token: await login(email) };
  };
  const mkClient = async (companyId: number, name: string) => Number((await one(`INSERT INTO clients ("companyId",name) VALUES ($1,$2) RETURNING id`, [companyId, name])).id);
  const mkSite = async (companyId: number, name: string, clientId: number | null, tz = 'Europe/London') =>
    Number((await one(`INSERT INTO sites ("companyId",name,address,timezone,"clientId") VALUES ($1,$2,'3 Quay',$3,$4) RETURNING id`, [companyId, name, tz, clientId])).id);
  const now = Date.now();
  const mkShift = async (companyId: number, siteId: number, guardId: number) => {
    const id = Number((await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Gate',$3,'in_progress',$4,$5) RETURNING id`,
      [companyId, siteId, guardId, new Date(now - 3 * 60 * MIN), new Date(now + 5 * 60 * MIN)])).id);
    await q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-in',$3,$3,false)`, [id, guardId, new Date(now - 3 * 60 * MIN)]);
    return id;
  };
  const startRun = async (guard: any, shiftId: number, minutesAgo: number) =>
    expect(await api('POST', '/patrols/runs', guard.token, { shiftId, clientRunId: cid('run'), startedAtDevice: new Date(now - minutesAgo * MIN).toISOString() }), 201, undefined, 'start');
  const photo = async (seed: number) => sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 120 + seed, g: 160, b: 200 } } }).jpeg({ quality: 80 }).toBuffer() as Promise<Buffer>;
  const upload = async (guard: any, runId: number, image: Buffer, complete = true) => {
    const r = expect(await api('POST', `/patrols/runs/${runId}/evidence`, guard.token, {
      clientEvidenceId: cid('ev'), kind: 'run_photo', contentType: 'image/jpeg', sizeBytes: image.length, sha256: sha256(image),
      capturedAtDevice: new Date(now - 20 * MIN).toISOString(),
    }), 201, undefined, 'intent');
    if (!complete) return r.evidence;
    assert.equal((await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body: new Uint8Array(image) })).status, 200);
    return expect(await api('POST', `/patrols/evidence/${r.evidence.id}/complete`, guard.token), 200, undefined, 'complete');
  };

  const A = await mkCompany('alpha', 'Harbour Watch Security Ltd');
  const B = await mkCompany('bravo', 'Bravo Guarding Ltd');
  const viewerA = await mkMember(A.id, 'alpha', 'viewer');
  const controlA = await mkMember(A.id, 'alpha', 'control_room');
  const clientA = await mkClient(A.id, 'Harbour Estates');
  const clientA2 = await mkClient(A.id, 'Dock Holdings');
  const clientB = await mkClient(B.id, 'Bravo Client');
  const siteA = await mkSite(A.id, 'Quay Gate', clientA);
  const siteA2 = await mkSite(A.id, 'Dock Yard', clientA2);
  const siteB = await mkSite(B.id, 'Bravo Yard', clientB);
  const gA = await mkGuard('ava', 'Ava Okafor');
  const gB = await mkGuard('ben', 'Ben Cole');
  const shiftA = await mkShift(A.id, siteA, gA.id);
  const shiftA2 = await mkShift(A.id, siteA2, gA.id);
  const shiftB = await mkShift(B.id, siteB, gB.id);
  await q(`UPDATE shifts SET status = 'completed' WHERE id = $1`, [shiftA2]); // the second site's shift is not the Guard's live one
  await q(`UPDATE shifts SET status = 'in_progress' WHERE id = $1`, [shiftA2]);

  // Site A today: a photo patrol (verified photo), a QR-only patrol (no photo), a patrol with only a rejected-free pending photo.
  const runPhoto = await startRun(gA, shiftA, 60);
  const original = await photo(1);
  const verified = await upload(gA, runPhoto.id, original);
  assert.equal(verified.uploadStatus, 'verified', 'the photo passed the server checks');
  expect(await api('POST', `/patrols/runs/${runPhoto.id}/complete`, gA.token, { completedAtDevice: new Date(now - 50 * MIN).toISOString() }), 200);
  const runQr = await startRun(gA, shiftA, 45);
  expect(await api('POST', `/patrols/runs/${runQr.id}/complete`, gA.token, { completedAtDevice: new Date(now - 40 * MIN).toISOString() }), 200);
  const runPending = await startRun(gA, shiftA, 30);
  const pending = await upload(gA, runPending.id, await photo(2), false);
  expect(await api('POST', `/patrols/runs/${runPending.id}/complete`, gA.token, { completedAtDevice: new Date(now - 25 * MIN).toISOString() }), 200);
  const runA2 = await startRun(gA, shiftA2, 20);
  const runB = await startRun(gB, shiftB, 20);
  const evB = await upload(gB, runB.id, await photo(3));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now - 60 * MIN));

  try {
    await test('PEB-01-THE-EVIDENCE-TREE', async () => {
      const tree = expect(await api('GET', `/patrols/evidence/tree?from=${today}&to=${today}`, viewerA), 200, undefined, 'patrols.view');
      assert.deepEqual([tree.from, tree.to, tree.dateBasis], [today, today, 'site_local']);
      const names = tree.clients.map((c: any) => [c.clientName, c.sites.map((s: any) => [s.siteName, s.patrols, s.withPhotos])]);
      assert.deepEqual(names, [['Dock Holdings', [['Dock Yard', 1, 0]]], ['Harbour Estates', [['Quay Gate', 3, 2]]]], 'every client and site of the company, never another company\'s');
      const quay = tree.clients[1].sites[0];
      assert.deepEqual(quay.days, [{ date: today, patrols: 3, withPhotos: 2, withoutPhotos: 1 }]);
      const filtered = expect(await api('GET', `/patrols/evidence/tree?clientId=${clientA}&from=${today}&to=${today}`, A.token), 200);
      assert.deepEqual(filtered.clients.map((c: any) => c.clientId), [clientA]);
      const bySite = expect(await api('GET', `/patrols/evidence/tree?siteId=${siteA2}`, A.token), 200, undefined, 'default range: the last 7 days');
      assert.deepEqual(bySite.clients.map((c: any) => c.sites.map((s: any) => s.siteId)), [[siteA2]]);
      expect(await api('GET', `/patrols/evidence/tree?clientId=${clientB}`, A.token), 404, 'PATROL_NOT_FOUND', 'another company\'s client');
      expect(await api('GET', `/patrols/evidence/tree?siteId=${siteB}`, A.token), 404, 'PATROL_SITE_NOT_FOUND', 'another company\'s site');
      expect(await api('GET', '/patrols/evidence/tree?from=2026-11-05&to=2026-11-01', A.token), 400, 'PATROL_VALIDATION_FAILED');
      expect(await api('GET', '/patrols/evidence/tree?from=2026-01-01&to=2026-12-31', A.token), 400, 'PATROL_VALIDATION_FAILED', 'at most 92 days');
      expect(await api('GET', '/patrols/evidence/tree?from=yesterday', A.token), 400);
      expect(await api('GET', '/patrols/evidence/tree', gA.token), 403, undefined, 'Guards');
    });

    await test('PEB-02-PATROL-CARDS-INCLUDE-QR-ONLY-AND-PHOTOS-ONLY-FILTERS', async () => {
      const all = expect(await api('GET', `/patrols/evidence/patrols?siteId=${siteA}&date=${today}`, controlA), 200, undefined, 'control room: view + evidence');
      assert.deepEqual([all.siteName, all.clientName, all.evidenceRestricted, all.photos], ['Quay Gate', 'Harbour Estates', false, 'all']);
      assert.deepEqual(all.patrols.map((p: any) => p.reference), [`P-${runPhoto.id}`, `P-${runQr.id}`, `P-${runPending.id}`], 'QR-only patrols are included');
      const card = all.patrols[0];
      assert.deepEqual([card.guard, card.photoCount, card.photosRestricted, card.window], [{ id: gA.id, displayName: 'Ava Okafor' }, 1, false, null]);
      assert.deepEqual(card.photos.map((p: any) => [p.id, p.uploadStatus, p.viewable, p.stampedPath]), [[verified.id, 'verified', true, `/patrols/evidence/${verified.id}/stamped`]]);
      assert.equal(card.thumbnailsPath, `/patrols/runs/${runPhoto.id}/evidence/thumbnails`, 'thumbnails through the existing audited page');
      assert.ok(card.verification.status && card.verification.code && card.verification.text, 'verification and its plain-English explanation');
      assert.ok(!JSON.stringify(all).includes(fake.url) && !/X-Amz-|storageKey/.test(JSON.stringify(all)), 'never a URL or storage key');
      const qrOnly = all.patrols[1];
      assert.deepEqual([qrOnly.photoCount, qrOnly.photos, qrOnly.thumbnailsPath, qrOnly.qrScans], [0, [], null, []]);
      const pendingCard = all.patrols[2];
      assert.deepEqual(pendingCard.photos.map((p: any) => [p.uploadStatus, p.viewable, p.stampedPath]), [['pending', false, null]]);
      const only = expect(await api('GET', `/patrols/evidence/patrols?siteId=${siteA}&date=${today}&photos=only`, A.token), 200);
      assert.deepEqual(only.patrols.map((p: any) => p.reference), [`P-${runPhoto.id}`, `P-${runPending.id}`], 'photos=only drops photo-free patrols');
      const viewer = expect(await api('GET', `/patrols/evidence/patrols?siteId=${siteA}&date=${today}`, viewerA), 200);
      assert.equal(viewer.evidenceRestricted, true);
      assert.ok(viewer.patrols.every((p: any) => p.photos === null && p.thumbnailsPath === null && p.photosRestricted === true), 'no photo detail without patrols.evidence');
      assert.equal(viewer.patrols[0].photoCount, 1, 'only how many');
      expect(await api('GET', `/patrols/evidence/patrols?siteId=${siteB}&date=${today}`, A.token), 404, 'PATROL_SITE_NOT_FOUND');
      expect(await api('GET', `/patrols/evidence/patrols?siteId=${siteA}`, A.token), 400, undefined, 'date required');
      expect(await api('GET', `/patrols/evidence/patrols?siteId=${siteA}&date=${today}&photos=some`, A.token), 400);
      const empty = expect(await api('GET', `/patrols/evidence/patrols?siteId=${siteA}&date=2026-01-01`, A.token), 200);
      assert.deepEqual(empty.patrols, []);
      void runA2;
    });

    await test('PEB-03-THE-STAMPED-VIEW-IS-DERIVED-STREAMED-NEVER-STORED-AND-AUDITED', async () => {
      const row = await one(`SELECT * FROM patrol_evidence WHERE id = $1`, [verified.id]);
      const storedBefore = Buffer.from(fake.objects.get(row.storageKey)!.body);
      const keysBefore = fake.keys();
      const logFrom = fake.log.length;
      const r = await api('GET', `/patrols/evidence/${verified.id}/stamped`, A.token);
      assert.equal(r.status, 200, scrub(r.bytes.toString('utf8').slice(0, 300)));
      assert.equal(r.headers.get('content-type'), 'image/jpeg');
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.match(r.headers.get('content-disposition') ?? '', /inline; filename="patrol-evidence-\d+-stamped\.jpg"/);
      assert.deepEqual([r.bytes[0], r.bytes[1], r.bytes[2]], [0xff, 0xd8, 0xff], 'a JPEG');
      assert.notEqual(sha256(r.bytes), sha256(original), 'a derived image, not the original');
      // The original is untouched: the same bytes, the same verified SHA-256, and storage saw only one GET.
      assert.ok(fake.objects.get(row.storageKey)!.body.equals(storedBefore) && storedBefore.equals(original));
      assert.equal(sha256(storedBefore), row.sha256Stored);
      assert.equal((await one(`SELECT "sha256Stored" FROM patrol_evidence WHERE id = $1`, [verified.id])).sha256Stored, row.sha256Stored);
      assert.deepEqual(fake.keys(), keysBefore, 'nothing new in storage');
      assert.deepEqual(fake.log.slice(logFrom).map((l) => [l.method, l.key === row.storageKey]), [['GET', true]], 'one read of the original, no write');
      // B2 correction: the stamp is a footer band APPENDED below the photo — 640 × (480 + band), the photo whole above it.
      const { data, info } = await sharp(r.bytes).raw().toBuffer({ resolveWithObject: true });
      const band = ST.stampSvg(640, 480, ST.stampLines({
        companyName: 'Harbour Watch Security Ltd', clientName: 'Harbour Estates', siteName: 'Quay Gate', guardName: 'Ava Okafor', capturedAtDevice: new Date(row.capturedAtDevice),
        receivedAtServer: new Date(row.receivedAt), timeZone: 'Europe/London', runId: runPhoto.id, window: null,
      }));
      assert.deepEqual([info.width, info.height], [640, 480 + band.bandHeight], 'output height = photo height + band');
      const px = (x: number, y: number) => data[(y * info.width + x) * info.channels];
      const src = await sharp(original).raw().toBuffer({ resolveWithObject: true });
      let diff = 0;
      for (let y = 0; y < 480; y += 4) for (let x = 0; x < 640; x += 4) diff = Math.max(diff, Math.abs(px(x, y) - src.data[(y * 640 + x) * src.info.channels]));
      assert.ok(diff < 40, `the whole photo, bottom rows included, is unchanged (worst ${diff})`);
      let dark = 0;
      let light = 0;
      for (let y = 481; y < 480 + band.bandHeight - 1; y += 1) for (let x = 0; x < 640; x += 2) (px(x, y) < 60 ? (dark += 1) : px(x, y) > 200 ? (light += 1) : 0);
      assert.ok(dark > 1000 && light > 150, `the stamp band and its text (${dark} dark, ${light} light)`);
      const audit = await one(`SELECT * FROM audit_logs WHERE action = 'patrol.evidence_stamped_accessed' AND "entityId" = $1 ORDER BY id DESC`, [verified.id]);
      assert.deepEqual([audit.userId, audit.companyId, audit.afterData.runId, audit.afterData.sha256, audit.afterData.stored, audit.afterData.derived],
        [A.ownerId, A.id, runPhoto.id, row.sha256Stored, false, true]);
      assert.ok(!JSON.stringify(audit).includes(fake.url), 'no URL in the audit');
      // The same permission as viewing an original; tenancy; availability.
      expect(await api('GET', `/patrols/evidence/${verified.id}/stamped`, viewerA), 403, 'PATROL_FORBIDDEN', 'no patrols.evidence');
      assert.equal((await api('GET', `/patrols/evidence/${verified.id}/stamped`, controlA)).status, 200, 'control room has patrols.evidence');
      expect(await api('GET', `/patrols/evidence/${verified.id}/stamped`, B.token), 404, 'PATROL_NOT_FOUND', 'another company');
      expect(await api('GET', `/patrols/evidence/${evB.id}/stamped`, A.token), 404, 'PATROL_NOT_FOUND', 'another company\'s photo');
      expect(await api('GET', `/patrols/evidence/${verified.id}/stamped`, gA.token), 403, undefined, 'a Guard');
      expect(await api('GET', `/patrols/evidence/${pending.id}/stamped`, A.token), 409, 'PATROL_EVIDENCE_NOT_AVAILABLE', 'pending');
      for (const state of ['quarantined', 'purged']) {
        // The states as the lifecycle leaves them (quarantined: moved aside with a purge date; purged: gone).
        await q(`UPDATE patrol_evidence SET "retentionStatus" = $2::varchar,
            "quarantinedAt" = CASE WHEN $2::varchar = 'quarantined' THEN now() ELSE "quarantinedAt" END,
            "purgeAfter" = CASE WHEN $2::varchar = 'quarantined' THEN now() + interval '7 days' ELSE "purgeAfter" END,
            "quarantineKey" = CASE WHEN $2::varchar = 'quarantined' THEN "storageKey" ELSE "quarantineKey" END,
            "purgedAt" = CASE WHEN $2::varchar = 'purged' THEN now() ELSE "purgedAt" END WHERE id = $1`, [verified.id, state]);
        const refused = expect(await api('GET', `/patrols/evidence/${verified.id}/stamped`, A.token), 409, 'PATROL_EVIDENCE_NOT_AVAILABLE', state);
        assert.equal(refused.details.retentionStatus, state);
        expect(await api('GET', `/patrols/evidence/${verified.id}/download?purpose=review`, A.token), 409, 'PATROL_EVIDENCE_NOT_AVAILABLE', `the original is refused alike (${state})`);
      }
      await q(`UPDATE patrol_evidence SET "retentionStatus" = 'active', "purgedAt" = NULL, "quarantinedAt" = NULL, "purgeAfter" = NULL, "quarantineKey" = NULL WHERE id = $1`, [verified.id]);
      await q(`UPDATE patrol_evidence SET "uploadStatus" = 'rejected' WHERE id = $1`, [verified.id]);
      expect(await api('GET', `/patrols/evidence/${verified.id}/stamped`, A.token), 409, 'PATROL_EVIDENCE_NOT_AVAILABLE', 'rejected');
      await q(`UPDATE patrol_evidence SET "uploadStatus" = 'verified' WHERE id = $1`, [verified.id]);
    });

    await test('PEB-04-A-CHANGED-OR-UNREADABLE-ORIGINAL-IS-NOT-STAMPED-AND-STORAGE-503', async () => {
      const row = await one(`SELECT * FROM patrol_evidence WHERE id = $1`, [verified.id]);
      const stored = fake.objects.get(row.storageKey)!;
      const real = Buffer.from(stored.body);
      const audits = async () => Number((await one(`SELECT count(*)::int n FROM audit_logs WHERE action = 'patrol.evidence_stamped_accessed'`)).n);
      const before = await audits();
      stored.body = Buffer.concat([real.subarray(0, real.length - 10), Buffer.alloc(10, 0)]);
      expect(await api('GET', `/patrols/evidence/${verified.id}/stamped`, A.token), 409, 'PATROL_EVIDENCE_STAMP_UNAVAILABLE', 'bytes no longer match the verified SHA-256');
      // Unreadable by the image library (bytes that match a recorded fingerprint but are not an image).
      const junk = Buffer.from('this is not an image at all, only text');
      stored.body = junk;
      await q(`UPDATE patrol_evidence SET "sha256Stored" = $2 WHERE id = $1`, [verified.id, sha256(junk)]);
      expect(await api('GET', `/patrols/evidence/${verified.id}/stamped`, A.token), 422, 'PATROL_EVIDENCE_STAMP_UNAVAILABLE');
      assert.equal(await audits(), before, 'a refused stamp is not recorded as accessed');
      stored.body = real;
      await q(`UPDATE patrol_evidence SET "sha256Stored" = $2 WHERE id = $1`, [verified.id, row.sha256Stored]);
      for (const k of ['ENDPOINT', 'REGION', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) delete process.env[`PATROL_EVIDENCE_STORAGE_${k}`];
      try {
        expect(await api('GET', `/patrols/evidence/${verified.id}/stamped`, viewerA), 403, 'PATROL_FORBIDDEN', 'authorisation first');
        expect(await api('GET', `/patrols/evidence/${verified.id}/stamped`, A.token), 503, 'PATROL_EVIDENCE_STORAGE_UNAVAILABLE');
      } finally {
        setStorageEnv();
      }
      assert.equal((await api('GET', `/patrols/evidence/${verified.id}/stamped`, A.token)).status, 200);
    });
    await test('PEB-05-THE-1.2.1-APP-REQUEST-SEQUENCE-ON-A-SHIFT-WINDOW-VERIFIES', async () => {
      // The deployed Guard app's exact calls (patrolOutbox.ts / patrolSync.ts): plan → start (the open window's scheduleId
      // and routeId) → scan (the signed label) → photo intent → PUT → complete upload → complete run; then the sweep.
      process.env.PATROL_QR_SIGNING_KEY = 'patrol-evidence-b1-spec-only-signing-key-0005';
      try {
        const C = await mkCompany('charlie', 'Charlie Patrols Ltd');
        const site = await mkSite(C.id, 'Charlie Gate', null);
        const cp = expect(await api('POST', '/patrols/checkpoints', C.token, { siteId: site, label: 'Front gate', photoRequired: true }), 201);
        const label = expect(await api('GET', `/patrols/checkpoints/${cp.id}/label`, C.token), 200).payload;
        expect(await api('POST', `/patrols/checkpoints/${cp.id}/confirm`, C.token, { scanPayload: label }), 200);
        expect(await api('PUT', `/patrols/sites/${site}/setup`, C.token, { setupMode: 'every_shift', evidenceMode: 'qr_photo', frequencyMinutes: 60 }), 200);
        expect(await api('POST', `/patrols/sites/${site}/setup/confirm`, C.token), 200);
        const g = await mkGuard('cal', 'Cal Reyes');
        const shiftId = await mkShift(C.id, site, g.id);
        const plan = expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftId}`, g.token), 200);
        const t = Date.now();
        const window = plan.windows.find((w: any) => !w.covered && new Date(w.start).getTime() <= t && t < new Date(w.end).getTime()); // dueWindow
        assert.ok(window && window.anchor === 'shift', 'an open shift window');
        assert.deepEqual(plan.checkpoints.map((c: any) => c.photoRequired), [false], 'the app is not asked for a checkpoint photo');
        const sent = () => new Date().toISOString();
        const run = expect(await api('POST', '/patrols/runs', g.token, {
          clientRunId: cid('run'), shiftId, startedAtDevice: new Date(t).toISOString(), scheduleId: window.scheduleId, routeId: window.routeId, sentAtDevice: sent(),
        }), 201, undefined, 'start');
        assert.equal(run.windowKey, window.windowKey);
        const visit = expect(await api('POST', `/patrols/runs/${run.id}/visits`, g.token, {
          clientVisitId: cid('visit'), scanPayload: label, scannedAtDevice: new Date(t + 5_000).toISOString(), sentAtDevice: sent(),
        }), 201, undefined, 'scan');
        assert.equal(visit.result, 'verified');
        const image = await photo(9);
        const intent = expect(await api('POST', `/patrols/runs/${run.id}/evidence`, g.token, {
          clientEvidenceId: cid('ev'), kind: 'run_photo', contentType: 'image/jpeg', sizeBytes: image.length, sha256: sha256(image),
          capturedAtDevice: new Date(t + 10_000).toISOString(), sentAtDevice: sent(),
        }), 201, undefined, 'photo intent');
        assert.equal((await fetch(intent.upload.url, { method: 'PUT', headers: intent.upload.headers, body: new Uint8Array(image) })).status, 200);
        assert.equal(expect(await api('POST', `/patrols/evidence/${intent.evidence.id}/complete`, g.token), 200).uploadStatus, 'verified');
        expect(await api('POST', `/patrols/runs/${run.id}/complete`, g.token, { completedAtDevice: new Date(t + 15_000).toISOString(), sentAtDevice: sent() }), 200, undefined, 'complete');
        await app.get(PatrolSweepService).sweep(new Date(t + 60_000));
        const mine = expect(await api('GET', `/patrols/mine/runs?shiftId=${shiftId}`, g.token), 200);
        const judged = mine.find((r: any) => r.id === run.id);
        assert.deepEqual([judged.status, judged.verificationStatus, judged.verificationExplanation.code], ['completed', 'verified', 'verified'],
          'scans + one photo verify; the checkpoint\'s own photo setting is not required on the automatic route');
      } finally {
        delete process.env.PATROL_QR_SIGNING_KEY;
      }
    });

    await test('PEB-06-CHECKPOINT-PHOTO-FOLLOWS-THE-RUNS-OWN-ROUTE-AUTO-NO-PROMPT-CUSTOM-REQUIRED', async () => {
      process.env.PATROL_QR_SIGNING_KEY = 'patrol-evidence-b1-spec-only-signing-key-0006';
      try {
        const D = await mkCompany('delta', 'Delta Patrols Ltd');
        const sent = () => new Date().toISOString();
        let gs = 0;
        // One patrol with the deployed 1.2.1 app's calls: plan → start on the open window → scan → photos → complete.
        const patrol = async (site: number, label: string, opts: { checkpointPhoto: boolean; reason?: string }) => {
          gs += 1;
          const g = await mkGuard(`d${gs}`, `Delta Guard ${gs}`);
          const shiftId = await mkShift(D.id, site, g.id);
          const plan = expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftId}`, g.token), 200);
          const t = Date.now();
          const window = plan.windows.find((w: any) => !w.covered && new Date(w.start).getTime() <= t && t < new Date(w.end).getTime());
          assert.ok(window && window.anchor === 'shift' && window.routeId !== null, 'an open shift window with a route');
          const run = expect(await api('POST', '/patrols/runs', g.token, {
            clientRunId: cid('run'), shiftId, startedAtDevice: new Date(t).toISOString(), scheduleId: window.scheduleId, routeId: window.routeId, sentAtDevice: sent(),
          }), 201, undefined, 'start');
          const visit = expect(await api('POST', `/patrols/runs/${run.id}/visits`, g.token, {
            clientVisitId: cid('visit'), scanPayload: label, scannedAtDevice: new Date(t + 5_000).toISOString(), sentAtDevice: sent(),
          }), 201, undefined, 'scan');
          const send = async (kind: 'run_photo' | 'checkpoint_photo', seed: number) => {
            const image = await photo(seed);
            const intent = expect(await api('POST', `/patrols/runs/${run.id}/evidence`, g.token, {
              clientEvidenceId: cid('ev'), kind, ...(kind === 'checkpoint_photo' ? { visitId: visit.id } : {}), contentType: 'image/jpeg', sizeBytes: image.length,
              sha256: sha256(image), capturedAtDevice: new Date(t + 10_000).toISOString(), sentAtDevice: sent(),
            }), 201, undefined, `${kind} intent`);
            assert.equal((await fetch(intent.upload.url, { method: 'PUT', headers: intent.upload.headers, body: new Uint8Array(image) })).status, 200);
            assert.equal(expect(await api('POST', `/patrols/evidence/${intent.evidence.id}/complete`, g.token), 200).uploadStatus, 'verified');
          };
          await send('run_photo', 11);
          if (opts.checkpointPhoto) await send('checkpoint_photo', 12);
          const done = expect(await api('POST', `/patrols/runs/${run.id}/complete`, g.token, {
            completedAtDevice: new Date(t + 15_000).toISOString(), sentAtDevice: sent(), ...(opts.reason ? { exceptionReason: opts.reason } : {}),
          }), 200, undefined, 'complete');
          await app.get(PatrolSweepService).sweep(new Date(Date.now() + 60_000));
          const judged = expect(await api('GET', `/patrols/mine/runs?shiftId=${shiftId}`, g.token), 200).find((r: any) => r.id === run.id);
          const exceptions = await q(`SELECT type FROM patrol_exceptions WHERE "companyId" = $1 AND "runId" = $2 ORDER BY id`, [D.id, run.id]);
          return { plan, done, judged, exceptions: exceptions.map((e: any) => e.type) };
        };
        const photoCheckpoint = async (site: number, name: string) => {
          const cp = expect(await api('POST', '/patrols/checkpoints', D.token, { siteId: site, label: name, photoRequired: true }), 201);
          const label = expect(await api('GET', `/patrols/checkpoints/${cp.id}/label`, D.token), 200).payload;
          expect(await api('POST', `/patrols/checkpoints/${cp.id}/confirm`, D.token, { scanPayload: label }), 200);
          return { cp, label };
        };

        // ── AUTOMATIC route at an OVERLAP site: the checkpoint asks for a photo and is also on an active custom route the
        //    site does not use (the former known limitation). The server requires no checkpoint photo on this run.
        const autoSite = await mkSite(D.id, 'Delta Gate', null);
        const a = await photoCheckpoint(autoSite, 'Front gate');
        expect(await api('PUT', `/patrols/sites/${autoSite}/setup`, D.token, { setupMode: 'every_shift', evidenceMode: 'qr_photo', frequencyMinutes: 60 }), 200);
        expect(await api('POST', `/patrols/sites/${autoSite}/setup/confirm`, D.token), 200);
        expect(await api('POST', '/patrols/routes', D.token, { siteId: autoSite, name: 'Spare route', checkpoints: [{ checkpointId: a.cp.id }] }), 201);
        const noPrompt = await patrol(autoSite, a.label, { checkpointPhoto: false });
        assert.deepEqual(noPrompt.plan.checkpoints.map((c: any) => c.photoRequired), [false], 'the 1.2.1 app is not asked for a checkpoint photo (no prompt)');
        assert.deepEqual([noPrompt.judged.status, noPrompt.judged.verificationStatus], ['completed', 'verified']);
        assert.deepEqual(noPrompt.exceptions, [], 'no exception');
        // The server's guarantee for a shift that DOES see a prompt (a mixed shift): the declined photo's reason box does not
        // make this run incomplete, raises nothing, and the Guard's words are kept on the run.
        const declined = await patrol(autoSite, a.label, { checkpointPhoto: false, reason: 'Camera would not focus.' });
        assert.deepEqual([declined.done.status, declined.judged.status, declined.judged.verificationStatus], ['completed', 'completed', 'verified']);
        assert.equal(declined.judged.exceptionReason, 'Camera would not focus.', 'the Guard\'s words are kept');
        assert.deepEqual(declined.exceptions, [], 'no patrol_incomplete for a photo the server does not require');
        // A reason about an unreached checkpoint is never excused (the 1.2.1 app writes "Checkpoint not reached — …").
        const unreached = await patrol(autoSite, a.label, { checkpointPhoto: false, reason: 'Checkpoint not reached — Front gate: blocked' });
        assert.equal(unreached.done.status, 'incomplete');
        assert.deepEqual(unreached.exceptions, ['patrol_incomplete']);

        // ── CUSTOM route chosen by the setup: the checkpoint's photo requirement is preserved.
        const customSite = await mkSite(D.id, 'Delta Yard', null);
        const c = await photoCheckpoint(customSite, 'Yard gate');
        const route = expect(await api('POST', '/patrols/routes', D.token, { siteId: customSite, name: 'Yard route', checkpoints: [{ checkpointId: c.cp.id, required: true }] }), 201);
        expect(await api('PUT', `/patrols/sites/${customSite}/setup`, D.token, { setupMode: 'every_shift', evidenceMode: 'qr_photo', frequencyMinutes: 60, routeId: route.id }), 200);
        expect(await api('POST', `/patrols/sites/${customSite}/setup/confirm`, D.token), 200);
        const supplied = await patrol(customSite, c.label, { checkpointPhoto: true });
        assert.deepEqual(supplied.plan.checkpoints.map((x: any) => x.photoRequired), [true], 'the 1.2.1 app is asked for the photo (prompt)');
        assert.deepEqual([supplied.judged.status, supplied.judged.verificationStatus], ['completed', 'verified'], 'photo supplied: verified');
        assert.deepEqual(supplied.exceptions, []);
        const missing = await patrol(customSite, c.label, { checkpointPhoto: false, reason: 'Camera would not focus.' });
        assert.equal(missing.done.status, 'incomplete', 'a required photo declined with a reason: incomplete, as today');
        assert.notEqual(missing.judged.verificationStatus, 'verified', 'and not verified (the photo is required)');
        assert.deepEqual(missing.exceptions, ['patrol_incomplete'], 'one patrol_incomplete, as today');
      } finally {
        delete process.env.PATROL_QR_SIGNING_KEY;
      }
    });

    await test('PEB-07-A-REASON-IS-EXCUSED-ONLY-WHEN-THE-SERVER-PROVES-THE-SOLE-GAP-IS-AN-UNREQUIRED-CHECKPOINT-PHOTO', async () => {
      process.env.PATROL_QR_SIGNING_KEY = 'patrol-evidence-b1-spec-only-signing-key-0007';
      try {
        const E = await mkCompany('echo', 'Echo Patrols Ltd');
        const sent = () => new Date().toISOString();
        let gs = 0;
        type Cp = { cp: any; label: string };
        const checkpointAt = async (site: number, name: string, photoRequired: boolean): Promise<Cp> => {
          const cp = expect(await api('POST', '/patrols/checkpoints', E.token, { siteId: site, label: name, photoRequired }), 201);
          const label = expect(await api('GET', `/patrols/checkpoints/${cp.id}/label`, E.token), 200).payload;
          expect(await api('POST', `/patrols/checkpoints/${cp.id}/confirm`, E.token, { scanPayload: label }), 200);
          return { cp, label };
        };
        const activate = async (site: number, body: Record<string, unknown>) => {
          expect(await api('PUT', `/patrols/sites/${site}/setup`, E.token, { setupMode: 'every_shift', frequencyMinutes: 60, ...body }), 200);
          expect(await api('POST', `/patrols/sites/${site}/setup/confirm`, E.token), 200);
        };
        type Opts = {
          scans: Cp[]; flag?: Cp[]; runPhoto: 'verified' | 'missing' | 'rejected' | 'quarantined'; checkpointPhoto?: Cp; reason?: string;
        };
        /** One patrol through the 1.2.1 app's calls; returns what the server recorded after the sweep. */
        const patrol = async (site: number, o: Opts) => {
          gs += 1;
          const g = await mkGuard(`e${gs}`, `Echo Guard ${gs}`);
          const shiftId = await mkShift(E.id, site, g.id);
          const plan = expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftId}`, g.token), 200);
          const t = Date.now();
          const window = plan.windows.find((w: any) => !w.covered && new Date(w.start).getTime() <= t && t < new Date(w.end).getTime());
          assert.ok(window, 'an open window');
          const run = expect(await api('POST', '/patrols/runs', g.token, {
            clientRunId: cid('run'), shiftId, startedAtDevice: new Date(t).toISOString(), scheduleId: window.scheduleId, routeId: window.routeId, sentAtDevice: sent(),
          }), 201, undefined, 'start');
          const visits = new Map<number, number>();
          let k = 0;
          for (const s of o.scans) {
            k += 1;
            const v = expect(await api('POST', `/patrols/runs/${run.id}/visits`, g.token, {
              clientVisitId: cid('visit'), scanPayload: s.label, scannedAtDevice: new Date(t + k * 1000).toISOString(), sentAtDevice: sent(),
            }), 201, undefined, 'scan');
            visits.set(Number(s.cp.id), Number(v.id));
          }
          // A flagged scan (as the server would flag an old, foreign or repeated label).
          for (const f of o.flag ?? []) await q(`UPDATE patrol_checkpoint_visits SET result = 'flagged' WHERE id = $1`, [visits.get(Number(f.cp.id))]);
          const upload = async (kind: 'run_photo' | 'checkpoint_photo', seed: number, visitId?: number) => {
            const image = await photo(seed);
            const intent = expect(await api('POST', `/patrols/runs/${run.id}/evidence`, g.token, {
              clientEvidenceId: cid('ev'), kind, ...(visitId ? { visitId } : {}), contentType: 'image/jpeg', sizeBytes: image.length,
              sha256: sha256(image), capturedAtDevice: new Date(t + 10_000).toISOString(), sentAtDevice: sent(),
            }), 201, undefined, `${kind} intent`);
            assert.equal((await fetch(intent.upload.url, { method: 'PUT', headers: intent.upload.headers, body: new Uint8Array(image) })).status, 200);
            expect(await api('POST', `/patrols/evidence/${intent.evidence.id}/complete`, g.token), 200);
            return Number(intent.evidence.id);
          };
          if (o.runPhoto !== 'missing') {
            const id = await upload('run_photo', 20 + gs);
            if (o.runPhoto === 'rejected') await q(`UPDATE patrol_evidence SET "uploadStatus" = 'rejected', "rejectionReason" = 'spec' WHERE id = $1`, [id]);
            if (o.runPhoto === 'quarantined') await q(`UPDATE patrol_evidence SET "retentionStatus" = 'quarantined', "quarantinedAt" = now(), "purgeAfter" = now() + interval '30 days', "quarantineKey" = 'quarantine/spec/' || id WHERE id = $1`, [id]);
          }
          if (o.checkpointPhoto) await upload('checkpoint_photo', 60 + gs, visits.get(Number(o.checkpointPhoto.cp.id)));
          const done = expect(await api('POST', `/patrols/runs/${run.id}/complete`, g.token, {
            completedAtDevice: new Date(t + 15_000).toISOString(), sentAtDevice: sent(), ...(o.reason ? { exceptionReason: o.reason } : {}),
          }), 200, undefined, 'complete');
          await app.get(PatrolSweepService).sweep(new Date(Date.now() + 60_000));
          const judged = expect(await api('GET', `/patrols/mine/runs?shiftId=${shiftId}`, g.token), 200).find((r: any) => r.id === run.id);
          const exceptions = (await q(`SELECT type FROM patrol_exceptions WHERE "companyId" = $1 AND "runId" = $2`, [E.id, run.id])).map((e: any) => e.type);
          return { plan, status: done.status, judged, exceptions, incomplete: exceptions.filter((x: string) => x === 'patrol_incomplete').length };
        };
        const NOTE = 'Camera would not focus.';

        // Automatic route, QR + photos: "Front gate" asks for its own photo (also on a spare custom route — the overlap).
        const auto = await mkSite(E.id, 'Echo Gate', null);
        const front = await checkpointAt(auto, 'Front gate', true);
        const rear = await checkpointAt(auto, 'Rear gate', false);
        await activate(auto, { evidenceMode: 'qr_photo' });
        expect(await api('POST', '/patrols/routes', E.token, { siteId: auto, name: 'Spare', checkpoints: [{ checkpointId: front.cp.id }] }), 201);

        // 1. everything required is there; only the (unrequired) checkpoint photo was declined → excused.
        const c1 = await patrol(auto, { scans: [front, rear], runPhoto: 'verified', reason: NOTE });
        assert.deepEqual([c1.status, c1.judged.status, c1.judged.verificationStatus, c1.exceptions.length], ['completed', 'completed', 'verified', 0], '1: excused');
        assert.equal(c1.judged.exceptionReason, NOTE, '1: the Guard\'s words are kept');
        assert.ok(c1.judged.verificationExplanation.text.includes(`Guard's note: "${NOTE}"`), '1: and shown with the explanation');
        // 2. THE GAP: the run photo is missing → incomplete + patrol_incomplete (never excused).
        const c2 = await patrol(auto, { scans: [front, rear], runPhoto: 'missing', reason: NOTE });
        assert.deepEqual([c2.status, c2.incomplete], ['incomplete', 1], '2: a missing run photo is never excused');
        assert.notEqual(c2.judged.verificationStatus, 'verified');
        // 4. a required checkpoint not scanned, said as the 1.2.1 app says it.
        const c4 = await patrol(auto, { scans: [rear], runPhoto: 'verified', reason: 'Checkpoint not reached — Front gate: blocked' });
        assert.deepEqual([c4.status, c4.incomplete], ['incomplete', 1], '4');
        // 5. a required checkpoint not scanned, free text WITHOUT the phrase: the records decide, not the text.
        const c5 = await patrol(auto, { scans: [rear], runPhoto: 'verified', reason: 'Gate was locked tonight.' });
        assert.deepEqual([c5.status, c5.incomplete], ['incomplete', 1], '5: text cannot excuse a missing checkpoint');
        // 6. the required checkpoint's only visit is flagged.
        const c6 = await patrol(auto, { scans: [front, rear], flag: [front], runPhoto: 'verified', reason: NOTE });
        assert.equal(c6.status, 'incomplete', '6: a flagged scan satisfies nothing');
        assert.equal(c6.incomplete, 1);
        // 7. the run photo rejected / quarantined at completion.
        const c7a = await patrol(auto, { scans: [front, rear], runPhoto: 'rejected', reason: NOTE });
        assert.deepEqual([c7a.status, c7a.incomplete], ['incomplete', 1], '7: rejected run photo');
        const c7b = await patrol(auto, { scans: [front, rear], runPhoto: 'quarantined', reason: NOTE });
        assert.deepEqual([c7b.status, c7b.incomplete], ['incomplete', 1], '7: quarantined run photo');

        // 3. photo-only automatic site, the run photo missing.
        const photoSite = await mkSite(E.id, 'Echo Yard', null);
        await activate(photoSite, { evidenceMode: 'photo' });
        const c3 = await patrol(photoSite, { scans: [], runPhoto: 'missing', reason: NOTE });
        assert.deepEqual([c3.status, c3.incomplete], ['incomplete', 1], '3');

        // 8. custom route that needs the checkpoint photo: declined → incomplete + exception; supplied → verified.
        const customSite = await mkSite(E.id, 'Echo Dock', null);
        const dock = await checkpointAt(customSite, 'Dock gate', true);
        const route = expect(await api('POST', '/patrols/routes', E.token, { siteId: customSite, name: 'Dock route', checkpoints: [{ checkpointId: dock.cp.id, required: true }] }), 201);
        await activate(customSite, { evidenceMode: 'qr_photo', routeId: route.id });
        const c8a = await patrol(customSite, { scans: [dock], runPhoto: 'verified', reason: NOTE });
        assert.deepEqual([c8a.status, c8a.incomplete], ['incomplete', 1], '8: required checkpoint photo declined');
        const c8b = await patrol(customSite, { scans: [dock], runPhoto: 'verified', checkpointPhoto: dock });
        assert.deepEqual([c8b.status, c8b.judged.verificationStatus, c8b.exceptions.length], ['completed', 'verified', 0], '8: supplied');

        // 9. nothing was prompted (no photo-flagged checkpoint scanned): a reason is incomplete exactly as in 1.2.1.
        const plainSite = await mkSite(E.id, 'Echo Lane', null);
        const lane = await checkpointAt(plainSite, 'Lane gate', false);
        await activate(plainSite, { evidenceMode: 'qr_photo' });
        const c9 = await patrol(plainSite, { scans: [lane], runPhoto: 'verified', reason: NOTE });
        assert.deepEqual([c9.status, c9.incomplete], ['incomplete', 1], '9');
      } finally {
        delete process.env.PATROL_QR_SIGNING_KEY;
      }
    });
  } finally {
    await app.close();
    await fake.stop();
  }
  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`);
  console.log(JSON.stringify({ event: 'patrol_evidence_b1_certified', tests: passed }));
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(scrub(String(error?.stack ?? error)));
  process.exit(1);
});
