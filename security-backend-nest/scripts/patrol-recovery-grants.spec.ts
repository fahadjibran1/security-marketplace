/**
 * Patrols issue #68 (Migration 72) certification: exceptional offline recovery grants. The whole application over HTTP
 * against an in-process S3-compatible server (scripts/fixtures/fake-s3-server.ts) on a disposable database built from the
 * repository's own migrations. The patrol sweep's, the safety sweep's and the evidence maintenance timers are stopped, so
 * every pass is explicit.
 *
 * Issuing, revoking, listing (Owner / Admin only)
 *   PR-01  permissions: the company Owner and an Admin issue, list and revoke; Operations, Control Room, Viewer, Finance,
 *          HR / compliance, a Guard and the S4 platform admin cannot; with the switch off every route is 404
 *   PR-02  time box and validation: default 24 h, at most 72 h (73 refused, also by the database), 1 h minimum, a mandatory
 *          reason; one active grant per Guard and shift; the Guard must have been on the shift (a replaced Guard who
 *          worked it qualifies); a cancelled shift cannot be granted
 *   PR-03  tenant isolation: another company's shift or grant is 404 on every route, lists never cross, the database
 *          refuses a cross-tenant grant even if the service were bypassed
 *   PR-04  revocation: with a reason, audited, once; an expired grant cannot be revoked; a revoked grant shows as revoked
 * The sync paths
 *   PR-05  run start: no grant → 409 PATROL_SYNC_WINDOW_CLOSED; a grant for another Guard, another shift or another company,
 *          an expired or a revoked grant → still 409; under a grant → accepted, recovered_via_grant, needsReview,
 *          provisional, use counted and audited; Book On still required; a replay works after the grant ends
 *   PR-06  scan: the same matrix; the visit and its run are flagged; the run needsReview
 *   PR-07  completion: the same matrix; the sweep keeps a granted run open and closes it once the grant is revoked; a run
 *          the sweep already closed (closed_by_system) is completed under a grant with its settled verification untouched,
 *          and its abandonment exception and alert are annotated, never closed
 *   PR-08  photos: upload intent and a re-issued upload URL under a grant are accepted and flagged; completion verifies
 *          SHA-256 and the image exactly as P1-C (a mismatch is still rejected and quarantined); idempotent replays; the
 *          export manifest lists recovered_via_grant
 *   PR-09  late evidence under a grant never closes an alert: the "evidence missing" exception and alert are annotated and
 *          downgraded and stay open for a person
 *   PR-10  inside the standard window a grant is never consulted (no flag, no use); the audit trail of issue / use /
 *          revoke is complete and names who, which grant, which record and why
 *
 * Needs PATROL_RECOVERY_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { startFakeS3 } from './fixtures/fake-s3-server';
import { jpeg, sha256 } from './fixtures/patrol-test-images';

const url = process.env.PATROL_RECOVERY_DATABASE_URL;
if (!url) throw new Error('PATROL_RECOVERY_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Patrol recovery database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-recovery-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
for (const key of ['RESEND_API_KEY', 'EXPO_ACCESS_TOKEN', 'PUSH_WELFARE_REMINDERS_ENABLED', 'PUSH_GUARD_NOTIFICATIONS_ENABLED', 'PATROL_QR_SIGNING_KEY',
  'PATROL_QR_PREVIOUS_SIGNING_KEY', 'PATROL_EVIDENCE_STORAGE_PREFIX', 'PATROL_EVIDENCE_MAX_BYTES', 'PATROL_EVIDENCE_URL_TTL_SECONDS',
  'PATROL_EVIDENCE_STORAGE_CHECKSUM_HEADER', 'PATROL_EVIDENCE_STORAGE_SIGN_CONTENT_LENGTH', 'PATROL_EVIDENCE_RETENTION_MODE']) {
  delete process.env[key];
}
// Synthetic test-only credentials for the in-process storage server (not a real account, never used anywhere else).
const STORAGE = { accessKeyId: 'S4TESTACCESSKEY000068', secretAccessKey: 'synthetic-test-secret-not-a-real-credential-0068', bucket: 's4-patrol-recovery-test', region: 'auto' };

let passed = 0;
const failures: string[] = [];
const test = async (id: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failures.push(id);
    const text = String((error as Error)?.stack ?? error).replace(/https?:\/\/\S+/g, '[url]').replace(/X-Amz-[A-Za-z]+=[^&\s"]+/g, '[redacted]');
    console.log(`FAIL  ${id}\n      ${text.split('\n').slice(0, 12).join('\n      ')}`);
  }
};

type Res = { status: number; body: any };
const PASSWORD = 'patrol-recovery-spec-only-password-1';
const MIN = 60_000;
const HOUR = 60 * MIN;
let seqId = 0;
const cid = (p: string) => `${p}-${Date.now().toString(36)}-${(++seqId).toString().padStart(5, '0')}`;
const iso = (ms: number) => new Date(ms).toISOString();

async function main() {
  const fake = await startFakeS3(STORAGE);
  process.env.PATROL_EVIDENCE_STORAGE_ENDPOINT = fake.url;
  process.env.PATROL_EVIDENCE_STORAGE_REGION = STORAGE.region;
  process.env.PATROL_EVIDENCE_STORAGE_BUCKET = STORAGE.bucket;
  process.env.PATROL_EVIDENCE_STORAGE_ACCESS_KEY_ID = STORAGE.accessKeyId;
  process.env.PATROL_EVIDENCE_STORAGE_SECRET_ACCESS_KEY = STORAGE.secretAccessKey;

  const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
  const allFiles: string[] = fs.readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).sort();
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const base = buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' });
  const migrate = new DataSource({ ...base, entities: [], migrations: allFiles.map((f) => path.join(migrationsDir, f)), dropSchema: true } as never);
  await migrate.initialize();
  const migrated = await migrate.runMigrations({ transaction: 'each' });
  assert.equal(migrated[migrated.length - 1]?.name, 'AddPatrolSyncRecoveryGrants1720900000018', 'the head is Migration 72');
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
  const { PatrolRecoveryGrantService } = await import('../src/patrol/patrol-recovery-grant.service');
  const { readZipDirectory, readZipEntry } = await import('../src/patrol/evidence/patrol-zip-writer');
  const keys = await import('../src/patrol/evidence/patrol-evidence-keys');
  const sweeper = app.get(PatrolSweepService);
  const safety = app.get(SafetyAlertService);
  const maint = app.get(PatrolEvidenceMaintenanceService);
  const exportsSvc = app.get(PatrolEvidenceExportService);
  const grantsSvc = app.get(PatrolRecoveryGrantService);
  sweeper.onModuleDestroy();
  safety.onModuleDestroy();
  maint.onModuleDestroy();
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

  // ── Fixtures (fictional) ────────────────────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash(PASSWORD, 4);
  let seq = 0;
  const mkUser = async (email: string, role: string) =>
    Number((await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
       VALUES ($1,$2,$3,'active',true,false,$4,'Spec') RETURNING id`, [email, hash, role, email.split('@')[0]])).id);
  const testCompanies: number[] = [];
  const mkCompany = async (label: string) => {
    seq += 1;
    const ownerEmail = `pr.${label}.owner@example.invalid`;
    const ownerId = await mkUser(ownerEmail, 'company_admin');
    const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,$2,$3,'1 Way','ops@example.invalid',true) RETURNING id`,
      [ownerId, `PR ${label} Ltd`, String(68000000 + seq)]);
    testCompanies.push(Number(id));
    return { id: Number(id), ownerId, token: await login(ownerEmail) };
  };
  const mkSite = async (companyId: number, name: string) =>
    Number((await one(`INSERT INTO sites ("companyId",name,address,timezone) VALUES ($1,$2,'3 Quay','Europe/London') RETURNING id`, [companyId, name])).id);
  const mkGuard = async (label: string) => {
    seq += 1;
    const email = `pr.${label}@example.invalid`;
    const userId = await mkUser(email, 'guard');
    const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, `Guard ${label}`, `68${String(seq).padStart(14, '0')}`, `0768${String(seq).padStart(7, '0')}`]);
    return { id: Number(id), userId, token: await login(email) };
  };
  const mkMember = async (companyId: number, label: string, role: string) => {
    const email = `pr.${label}.${role}@example.invalid`;
    const userId = await mkUser(email, 'company_admin');
    await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [userId, companyId, role]);
    return { userId, token: await login(email) };
  };
  const mkShift = async (companyId: number, siteId: number, guardId: number, start: Date, end: Date, status: string) =>
    Number((await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Gate',$3,$4,$5,$6) RETURNING id`,
      [companyId, siteId, guardId, status, start, end])).id);
  const attend = (shiftId: number, guardId: number, type: 'check-in' | 'check-out', at: Date) =>
    q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,$3,$4,$4,false)`, [shiftId, guardId, type, at]);
  const insRun = async (companyId: number, siteId: number, shiftId: number, guard: { id: number; userId: number }, startedAt: Date) =>
    one(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId",status,"startedAtDevice","startedAtServer","clientRunId")
       VALUES ($1,$2,$3,$4,$5,'in_progress',$6,$6,$7) RETURNING *`, [companyId, siteId, shiftId, guard.id, guard.userId, startedAt, cid('run')]);
  /** Only this company has Patrols switched on while fn runs (so a sweep / export pass touches only it). */
  const only = async <T>(companyId: number, fn: () => Promise<T>): Promise<T> => {
    await q(`UPDATE companies SET "patrolsEnabled" = (id = $1) WHERE id = ANY($2::int[])`, [companyId, testCompanies]);
    try {
      return await fn();
    } finally {
      await q(`UPDATE companies SET "patrolsEnabled" = true WHERE id = ANY($1::int[])`, [testCompanies]);
    }
  };

  /**
   * A Guard whose shift ended (Booked Off) `hoursAgo` hours ago — 30 h by default, so the standard 24 h window has closed —
   * with a run started during the shift and still in progress on the server.
   */
  const closedShift = async (co: { id: number }, site: number, guard: { id: number; userId: number }, hoursAgo = 30, runStatus = 'in_progress') => {
    const now = Date.now();
    const start = new Date(now - (hoursAgo + 8) * HOUR);
    const end = new Date(now - hoursAgo * HOUR);
    const shift = await mkShift(co.id, site, guard.id, start, end, 'completed');
    await attend(shift, guard.id, 'check-in', start);
    await attend(shift, guard.id, 'check-out', end);
    const run = await insRun(co.id, site, shift, guard, new Date(start.getTime() + HOUR));
    if (runStatus === 'completed') {
      await q(`UPDATE patrol_runs SET status = 'completed', "completedAtDevice" = $2, "completedAtServer" = $2 WHERE id = $1`, [run.id, new Date(start.getTime() + 90 * MIN)]);
    }
    return { shift, run, start, end };
  };
  const checkpoint = async (companyId: number, siteId: number, label = 'Rear door', photoRequired = false) =>
    one(`INSERT INTO patrol_checkpoints ("companyId","siteId","publicId",label,"photoRequired") VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [companyId, siteId, randomBytes(16).toString('hex'), label, photoRequired]);

  const issue = (tok: string, b: Record<string, unknown>) => api('POST', '/patrols/recovery-grants', tok, b);
  const revoke = (tok: string, id: number, reason = 'Recovery finished') => api('POST', `/patrols/recovery-grants/${id}/revoke`, tok, { reason });
  const list = (tok: string, query = '') => api('GET', `/patrols/recovery-grants${query}`, tok);
  const startRun = (tok: string, b: Record<string, unknown>) => api('POST', '/patrols/runs', tok, b);
  const scan = (tok: string, runId: number, b: Record<string, unknown>) => api('POST', `/patrols/runs/${runId}/visits`, tok, b);
  const completeRun = (tok: string, runId: number, b: Record<string, unknown>) => api('POST', `/patrols/runs/${runId}/complete`, tok, b);
  const photoBody = (image: Buffer, extra: Record<string, unknown> = {}) => ({
    clientEvidenceId: cid('ev'), kind: 'run_photo', contentType: 'image/jpeg', sizeBytes: image.length, sha256: sha256(image),
    capturedAtDevice: iso(Date.now() - 29 * HOUR), ...extra,
  });
  const intent = (tok: string, runId: number, b: Record<string, unknown>) => api('POST', `/patrols/runs/${runId}/evidence`, tok, b);
  const put = (upload: any, bytes: Buffer) => fetch(upload.url, { method: 'PUT', headers: upload.headers, body: new Uint8Array(bytes) });
  const completePhoto = (tok: string, id: number) => api('POST', `/patrols/evidence/${id}/complete`, tok);
  const runRow = (id: number) => one(`SELECT * FROM patrol_runs WHERE id = $1`, [id]);
  const grantRow = (id: number) => one(`SELECT * FROM patrol_sync_recovery_grants WHERE id = $1`, [id]);
  const audits = (action: string, entityId: number) =>
    q(`SELECT a.*, a."userId" AS "actorId" FROM audit_logs a WHERE action = $1 AND "entityId" = $2 ORDER BY id`, [action, entityId]);
  /** An active grant for this Guard and shift, issued by the Owner through the API. */
  const grantFor = async (co: { token: string }, shiftId: number, guardId: number, extra: Record<string, unknown> = {}) => {
    const r = await issue(co.token, { shiftId, guardId, reason: 'Phone lost during the outage, recovered today', ...extra });
    expect(r, 201, undefined, 'issue grant');
    return r.body;
  };

  const A = await mkCompany('alpha');
  const B = await mkCompany('beta');
  const siteA = await mkSite(A.id, 'Alpha Gate');
  const siteB = await mkSite(B.id, 'Beta Gate');
  const gA = await mkGuard('ga');
  const gA2 = await mkGuard('ga2');
  const gB = await mkGuard('gb');
  const staff: Record<string, { userId: number; token: string }> = {};
  for (const role of ['admin', 'operations', 'control_room', 'viewer', 'finance', 'hr_compliance']) staff[role] = await mkMember(A.id, 'alpha', role);
  const platformEmail = 'pr.platform@example.invalid';
  await mkUser(platformEmail, 'admin');
  const platform = await login(platformEmail);

  try {
    // ═══════════════════ Issuing, revoking, listing ═══════════════════

    await test('PR-01-ONLY-OWNER-AND-ADMIN-ISSUE-LIST-AND-REVOKE', async () => {
      const s = await closedShift(A, siteA, gA);
      const reason = 'Storage outage on the night';
      // Owner (the company account) and an Admin member.
      const byOwner = await issue(A.token, { shiftId: s.shift, reason });
      expect(byOwner, 201, undefined, 'Owner issues');
      assert.deepEqual([byOwner.body.shiftId, byOwner.body.guardId, byOwner.body.status, byOwner.body.uses], [s.shift, gA.id, 'active', 0], 'defaults to the shift\'s Guard');
      expect(await list(A.token), 200, undefined, 'Owner lists');
      expect(await revoke(staff.admin.token, byOwner.body.id), 200, undefined, 'Admin revokes');
      const byAdmin = await issue(staff.admin.token, { shiftId: s.shift, reason });
      expect(byAdmin, 201, undefined, 'Admin issues');
      expect(await list(staff.admin.token), 200, undefined, 'Admin lists');
      // Everyone else: 403 (company roles without patrols.holds; the role guard refuses Guards and the platform admin).
      for (const role of ['operations', 'control_room', 'viewer', 'finance', 'hr_compliance']) {
        const tok = staff[role].token;
        const refused = 'PATROL_FORBIDDEN';
        expect(await issue(tok, { shiftId: s.shift, reason }), 403, refused, `${role} issues`);
        expect(await list(tok), 403, refused, `${role} lists`);
        expect(await revoke(tok, byAdmin.body.id), 403, refused, `${role} revokes`);
      }
      for (const [who, tok] of [['guard', gA.token], ['platform admin', platform]] as const) {
        expect(await issue(tok, { shiftId: s.shift, reason }), 403, undefined, `${who} issues`);
        expect(await list(tok), 403, undefined, `${who} lists`);
        expect(await revoke(tok, byAdmin.body.id), 403, undefined, `${who} revokes`);
      }
      assert.equal((await grantRow(byAdmin.body.id)).revokedAt, null, 'no refused call changed the grant');
      assert.equal(await count(`SELECT count(*) FROM patrol_sync_recovery_grants WHERE "shiftId" = $1`, [s.shift]), 2, 'no refused call issued one');
      // The switch off: the feature does not exist for anyone.
      await q(`UPDATE companies SET "patrolsEnabled" = false WHERE id = $1`, [A.id]);
      try {
        expect(await issue(A.token, { shiftId: s.shift, reason }), 404, 'PATROLS_NOT_ENABLED');
        expect(await list(A.token), 404, 'PATROLS_NOT_ENABLED');
        expect(await revoke(A.token, byAdmin.body.id), 404, 'PATROLS_NOT_ENABLED');
      } finally {
        await q(`UPDATE companies SET "patrolsEnabled" = true WHERE id = $1`, [A.id]);
      }
      expect(await revoke(A.token, byAdmin.body.id), 200);
    });

    await test('PR-02-TIME-BOX-REASON-ONE-ACTIVE-AND-THE-GUARD-MUST-HAVE-BEEN-ON-THE-SHIFT', async () => {
      const s = await closedShift(A, siteA, gA);
      const reason = 'Device recovered after a flood';
      for (const bad of [{ shiftId: s.shift }, { shiftId: s.shift, reason: '' }, { shiftId: s.shift, reason: 'ab' }, { shiftId: s.shift, reason, durationHours: 73 },
        { shiftId: s.shift, reason, durationHours: 0 }, { shiftId: s.shift, reason, durationHours: 2.5 }, { shiftId: 'x', reason }, { reason }]) {
        expect(await issue(A.token, bad), 400, undefined, JSON.stringify(bad));
      }
      expect(await issue(A.token, { shiftId: s.shift, reason: '    ab    ' }), 400, 'PATROL_VALIDATION_FAILED', 'a reason of spaces');
      const t0 = Date.now();
      const def = await grantFor(A, s.shift, gA.id, { reason });
      const lasts = new Date(def.expiresAt).getTime() - new Date(def.createdAt).getTime();
      assert.equal(lasts, 24 * HOUR, 'default 24 h');
      assert.ok(new Date(def.createdAt).getTime() >= t0 - 1000 && new Date(def.createdAt).getTime() <= Date.now() + 1000);
      assert.equal(def.reason, reason);
      expect(await issue(A.token, { shiftId: s.shift, guardId: gA.id, reason }), 409, 'PATROL_RECOVERY_GRANT_ALREADY_ACTIVE', 'one active grant per Guard and shift');
      expect(await revoke(A.token, def.id), 200);
      const max = await grantFor(A, s.shift, gA.id, { durationHours: 72 });
      assert.equal(new Date(max.expiresAt).getTime() - new Date(max.createdAt).getTime(), 72 * HOUR, 'at most 72 h');
      expect(await revoke(A.token, max.id), 200);
      const min = await grantFor(A, s.shift, gA.id, { durationHours: 1 });
      assert.equal(new Date(min.expiresAt).getTime() - new Date(min.createdAt).getTime(), HOUR);
      expect(await revoke(A.token, min.id), 200);
      // The database holds the maximum too.
      await assert.rejects(() => q(`UPDATE patrol_sync_recovery_grants SET "expiresAt" = "createdAt" + interval '72 hours 1 second' WHERE id = $1`, [min.id]),
        /CHK_patrol_sync_recovery_grants_time_box/);
      // The Guard must have been on the shift: a stranger is refused; a replaced Guard who worked it qualifies.
      expect(await issue(A.token, { shiftId: s.shift, guardId: gA2.id, reason }), 409, 'PATROL_RECOVERY_GRANT_INELIGIBLE', 'never on the shift');
      expect(await issue(A.token, { shiftId: s.shift, guardId: 999999, reason }), 409, 'PATROL_RECOVERY_GRANT_INELIGIBLE');
      const replaced = await closedShift(A, siteA, gA2);
      await q(`UPDATE shifts SET "guardId" = $2 WHERE id = $1`, [replaced.shift, gA.id]);
      const forReplaced = await grantFor(A, replaced.shift, gA2.id);
      assert.equal(forReplaced.guardId, gA2.id, 'the Guard who worked the shift, though since replaced');
      expect(await revoke(A.token, forReplaced.id), 200);
      // A shift that was never worked cannot carry patrol data.
      const cancelled = await mkShift(A.id, siteA, gA.id, new Date(Date.now() - 40 * HOUR), new Date(Date.now() - 32 * HOUR), 'cancelled');
      expect(await issue(A.token, { shiftId: cancelled, reason }), 409, 'PATROL_RECOVERY_GRANT_INELIGIBLE');
      expect(await issue(A.token, { shiftId: 99999999, reason }), 404, 'PATROL_SHIFT_NOT_FOUND');
    });

    await test('PR-03-TENANT-ISOLATION-ON-EVERY-ROUTE-AND-IN-THE-DATABASE', async () => {
      const a = await closedShift(A, siteA, gA);
      const b = await closedShift(B, siteB, gB);
      const ga = await grantFor(A, a.shift, gA.id);
      const gb = await grantFor(B, b.shift, gB.id);
      expect(await issue(B.token, { shiftId: a.shift, reason: 'Probe from another company' }), 404, 'PATROL_SHIFT_NOT_FOUND', 'another company\'s shift');
      expect(await issue(B.token, { shiftId: a.shift, guardId: gA.id, reason: 'Probe from another company' }), 404, 'PATROL_SHIFT_NOT_FOUND');
      expect(await revoke(B.token, ga.id), 404, 'PATROL_NOT_FOUND', 'another company\'s grant');
      const listB = await list(B.token, '?status=all');
      expect(listB, 200);
      assert.ok(listB.body.length >= 1 && listB.body.every((g: any) => g.id !== ga.id), 'B never sees A\'s grants');
      expect(await list(B.token, `?status=all&shiftId=${a.shift}`), 200);
      assert.deepEqual((await list(B.token, `?status=all&shiftId=${a.shift}`)).body, [], 'filtering by A\'s shift shows nothing to B');
      assert.equal((await grantRow(ga.id)).revokedAt, null, 'A\'s grant untouched');
      // B's grant never opens A's data: B's Guard cannot reach A's run anyway, and A's Guard is not helped by B's grant.
      expect(await scan(gB.token, Number(a.run.id), { clientVisitId: cid('v'), checkpointPublicId: 'f'.repeat(32), scannedAtDevice: iso(Date.now() - 30 * HOUR) }), 404, 'PATROL_NOT_FOUND');
      // The database refuses a cross-tenant grant even if the service were bypassed (composite key to the company's shift).
      await assert.rejects(() => q(`INSERT INTO patrol_sync_recovery_grants ("companyId","guardId","shiftId",reason,"createdByUserId","expiresAt")
        VALUES ($1,$2,$3,'bypass attempt',$4,now() + interval '1 hour')`, [B.id, gA.id, a.shift, B.ownerId]), /FK_patrol_sync_recovery_grants_shift/);
      expect(await revoke(A.token, ga.id), 200);
      expect(await revoke(B.token, gb.id), 200);
    });

    await test('PR-04-REVOCATION-WITH-A-REASON-ONCE-AND-NEVER-OF-AN-EXPIRED-GRANT', async () => {
      const s = await closedShift(A, siteA, gA);
      const g = await grantFor(A, s.shift, gA.id);
      expect(await api('POST', `/patrols/recovery-grants/${g.id}/revoke`, A.token, {}), 400, undefined, 'a reason is required');
      expect(await revoke(A.token, g.id, 'no'), 400);
      const r = await revoke(A.token, g.id, 'Evidence received');
      expect(r, 200);
      assert.deepEqual([r.body.status, r.body.revokeReason, r.body.revokedByUserId], ['revoked', 'Evidence received', A.ownerId]);
      expect(await revoke(A.token, g.id), 409, 'PATROL_RECOVERY_GRANT_ENDED', 'once');
      const active = await list(A.token, `?shiftId=${s.shift}`);
      assert.deepEqual(active.body, [], 'a revoked grant is not active');
      const all = await list(A.token, `?status=all&shiftId=${s.shift}`);
      assert.deepEqual(all.body.map((x: any) => [x.id, x.status]), [[g.id, 'revoked']]);
      // An expired grant cannot be revoked (and is listed as expired).
      const [old] = await q(`INSERT INTO patrol_sync_recovery_grants ("companyId","guardId","shiftId",reason,"createdByUserId","createdAt","expiresAt")
        VALUES ($1,$2,$3,'Long ago',$4,now() - interval '30 hours',now() - interval '6 hours') RETURNING id`, [A.id, gA.id, s.shift, A.ownerId]);
      expect(await revoke(A.token, old.id), 409, 'PATROL_RECOVERY_GRANT_ENDED');
      assert.ok((await list(A.token, `?status=all&shiftId=${s.shift}`)).body.some((x: any) => x.id === old.id && x.status === 'expired'));
      // A new grant may be issued once the old one ended.
      const again = await grantFor(A, s.shift, gA.id);
      expect(await revoke(A.token, again.id), 200);
    });

    // ═══════════════════ The sync paths ═══════════════════

    await test('PR-05-RUN-START-ONLY-UNDER-THIS-GUARD-S-ACTIVE-GRANT-FOR-THIS-SHIFT', async () => {
      const s = await closedShift(A, siteA, gA, 30, 'completed'); // its earlier patrol finished; a second one arrives late
      const body = () => ({ clientRunId: cid('r'), shiftId: s.shift, startedAtDevice: iso(s.start.getTime() + 2 * HOUR) });
      expect(await startRun(gA.token, body()), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'no grant');
      // Grants that are not this Guard's, for this shift, active: all refused.
      const other = await closedShift(A, siteA, gA);
      const otherShift = await grantFor(A, other.shift, gA.id);
      const gA2Shift = await closedShift(A, siteA, gA2);
      const otherGuard = await grantFor(A, gA2Shift.shift, gA2.id);
      expect(await startRun(gA.token, body()), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'a grant for another shift / another Guard');
      const [expired] = await q(`INSERT INTO patrol_sync_recovery_grants ("companyId","guardId","shiftId",reason,"createdByUserId","createdAt","expiresAt")
        VALUES ($1,$2,$3,'Expired grant',$4,now() - interval '30 hours',now() - interval '1 minute') RETURNING id`, [A.id, gA.id, s.shift, A.ownerId]);
      expect(await startRun(gA.token, body()), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'an expired grant');
      const revoked = await grantFor(A, s.shift, gA.id);
      expect(await revoke(A.token, revoked.id), 200);
      expect(await startRun(gA.token, body()), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'a revoked grant');
      assert.deepEqual([(await grantRow(expired.id)).uses, (await grantRow(revoked.id)).uses], [0, 0]);
      // Another company's grant for "the same" Guard on its own shift never helps on this one.
      const bShift = await closedShift(B, siteB, gA);
      const bGrant = await grantFor(B, bShift.shift, gA.id);
      expect(await startRun(gA.token, body()), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'another company\'s grant');

      const g = await grantFor(A, s.shift, gA.id);
      const b = body();
      const r = await startRun(gA.token, b);
      expect(r, 201, undefined, 'under the grant');
      assert.ok(r.body.syncFlags.includes('recovered_via_grant') && r.body.syncFlags.includes('post_shift_creation'), JSON.stringify(r.body.syncFlags));
      assert.deepEqual([r.body.needsReview, r.body.provisional, r.body.syncedLate], [true, true, true]);
      const used = await grantRow(g.id);
      assert.equal(used.uses, 1);
      assert.ok(used.lastUsedAt);
      const [use] = await audits('patrol.recovery_grant_used', g.id);
      assert.deepEqual([use.afterData.step, use.afterData.entityType, use.afterData.entityId, use.afterData.runId, use.afterData.flag, use.actorId],
        ['run_start', 'patrol_run', r.body.id, r.body.id, 'recovered_via_grant', gA.userId]);
      assert.equal((await audits('patrol.late_sync_flagged', r.body.id)).length, 1, 'the flagged acceptance is audited as before');
      // A replay of the accepted write works after the grant ends; a new write does not.
      expect(await revoke(A.token, g.id), 200);
      const replay = await startRun(gA.token, b);
      expect(replay, 201, undefined, 'replay after revocation');
      assert.equal(replay.body.id, r.body.id);
      expect(await startRun(gA.token, { ...b, startedAtDevice: iso(s.start.getTime() + 3 * HOUR) }), 409, 'PATROL_IDEMPOTENCY_CONFLICT', 'same id, different content');
      expect(await startRun(gA.token, body()), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'a new run after revocation');
      assert.equal((await grantRow(g.id)).uses, 1, 'replays and refusals are not uses');
      // Book On is still required: a grant does not widen anything else.
      const noBookOn = await mkShift(A.id, siteA, gA.id, new Date(Date.now() - 40 * HOUR), new Date(Date.now() - 32 * HOUR), 'completed');
      const ng = await grantFor(A, noBookOn, gA.id);
      expect(await startRun(gA.token, { clientRunId: cid('r'), shiftId: noBookOn, startedAtDevice: iso(Date.now() - 35 * HOUR) }), 409, 'PATROL_SYNC_NOT_BOOKED_ON');
      // Another Guard holding no grant for the shift cannot use this one (the shift is not theirs: 404 as always).
      expect(await startRun(gA2.token, { clientRunId: cid('r'), shiftId: noBookOn, startedAtDevice: iso(Date.now() - 35 * HOUR) }), 404, 'PATROL_SHIFT_NOT_FOUND');
      for (const id of [otherShift.id, otherGuard.id, ng.id]) expect(await revoke(A.token, id), 200);
      expect(await revoke(B.token, bGrant.id), 200);
    });

    await test('PR-06-SCAN-UNDER-A-GRANT-FLAGS-THE-VISIT-AND-PUTS-THE-RUN-UP-FOR-REVIEW', async () => {
      const s = await closedShift(A, siteA, gA);
      const cp = await checkpoint(A.id, siteA);
      const body = () => ({ clientVisitId: cid('v'), checkpointPublicId: cp.publicId, scannedAtDevice: iso(s.start.getTime() + 70 * MIN) });
      const runId = Number(s.run.id);
      expect(await scan(gA.token, runId, body()), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'no grant');
      const otherShift = await closedShift(A, siteA, gA);
      const wrong = await grantFor(A, otherShift.shift, gA.id);
      expect(await scan(gA.token, runId, body()), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'a grant for another shift');
      expect(await revoke(A.token, wrong.id), 200);
      const g = await grantFor(A, s.shift, gA.id);
      const b = body();
      const v = await scan(gA.token, runId, b);
      expect(v, 201, undefined, 'under the grant');
      assert.deepEqual(v.body.syncFlags.sort(), ['recovered_via_grant', 'synced_after_book_off']);
      assert.equal(v.body.provisional, true);
      const run = await runRow(runId);
      assert.ok(run.syncFlags.includes('recovered_via_grant') && run.needsReview === true && run.syncedLate === true, JSON.stringify(run));
      assert.equal((await grantRow(g.id)).uses, 1);
      const [use] = await audits('patrol.recovery_grant_used', g.id);
      assert.deepEqual([use.afterData.step, use.afterData.entityType, use.afterData.entityId, use.afterData.runId], ['scan', 'patrol_checkpoint_visit', v.body.id, runId]);
      expect(await revoke(A.token, g.id), 200);
      const replay = await scan(gA.token, runId, b);
      expect(replay, 201, undefined, 'replay after revocation');
      assert.equal(replay.body.id, v.body.id);
      expect(await scan(gA.token, runId, body()), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'a new scan after revocation');
      // Another Guard's run stays 404, grant or not.
      expect(await scan(gA2.token, runId, body()), 404, 'PATROL_NOT_FOUND');
    });

    await test('PR-07-COMPLETION-UNDER-A-GRANT-AND-THE-SWEEP-NEVER-CLOSES-A-GRANTED-RUN', async () => {
      // A run in progress whose window closed: the sweep leaves it open while a grant lasts …
      const s = await closedShift(A, siteA, gA);
      const runId = Number(s.run.id);
      const body = { completedAtDevice: iso(s.start.getTime() + 2 * HOUR) };
      expect(await completeRun(gA.token, runId, body), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'no grant');
      const g = await grantFor(A, s.shift, gA.id);
      await only(A.id, () => sweeper.sweep(new Date()));
      assert.equal((await runRow(runId)).status, 'in_progress', 'not closed while the Guard holds a grant');
      const done = await completeRun(gA.token, runId, body);
      expect(done, 200, undefined, 'under the grant');
      assert.equal(done.body.status, 'completed');
      assert.ok(done.body.syncFlags.includes('recovered_via_grant') && done.body.syncFlags.includes('synced_after_book_off'), JSON.stringify(done.body.syncFlags));
      assert.equal(done.body.needsReview, true);
      const [use] = await audits('patrol.recovery_grant_used', g.id);
      assert.deepEqual([use.afterData.step, use.afterData.entityType, use.afterData.entityId], ['completion', 'patrol_run', runId]);
      expect(await revoke(A.token, g.id), 200);
      expect(await completeRun(gA.token, runId, body), 200, undefined, 'a replay of the completion after revocation');

      // … and closes it once the grant is revoked.
      const s2 = await closedShift(A, siteA, gA);
      const g2 = await grantFor(A, s2.shift, gA.id);
      await only(A.id, () => sweeper.sweep(new Date()));
      assert.equal((await runRow(Number(s2.run.id))).status, 'in_progress');
      expect(await revoke(A.token, g2.id), 200);
      await only(A.id, () => sweeper.sweep(new Date()));
      assert.equal((await runRow(Number(s2.run.id))).status, 'closed_by_system', 'closed once the grant ended');

      // A run the sweep already closed: completed under a grant, verification untouched, abandonment annotated not closed.
      const s3 = await closedShift(A, siteA, gA);
      const r3 = Number(s3.run.id);
      await only(A.id, () => sweeper.sweep(new Date()));
      const closed = await runRow(r3);
      assert.deepEqual([closed.status, closed.verificationStatus, Boolean(closed.verificationFinalAt)], ['closed_by_system', 'unverified', true]);
      const abandoned = await one(`SELECT * FROM patrol_exceptions WHERE "runId" = $1 AND type = 'patrol_abandoned'`, [r3]);
      assert.ok(abandoned, 'the sweep raised its abandonment');
      const cp = await checkpoint(A.id, siteA, 'Loading bay');
      const lateScan = { clientVisitId: cid('v'), checkpointPublicId: cp.publicId, scannedAtDevice: iso(s3.start.getTime() + 80 * MIN) };
      const lateDone = { completedAtDevice: iso(s3.start.getTime() + 2 * HOUR) };
      expect(await scan(gA.token, r3, lateScan), 409, 'PATROL_RUN_NOT_IN_PROGRESS', 'a closed run without a grant: unchanged');
      expect(await completeRun(gA.token, r3, lateDone), 409, 'PATROL_RUN_NOT_IN_PROGRESS');
      const g3 = await grantFor(A, s3.shift, gA.id);
      expect(await scan(gA.token, r3, lateScan), 201, undefined, 'a late scan of the system-closed run under the grant');
      const recovered = await completeRun(gA.token, r3, lateDone);
      expect(recovered, 200, undefined, 'its completion under the grant');
      assert.equal(recovered.body.status, 'completed');
      assert.ok(recovered.body.syncFlags.includes('recovered_via_grant'));
      const after = await runRow(r3);
      assert.deepEqual([after.verificationStatus, new Date(after.verificationFinalAt).getTime(), after.needsReview],
        ['unverified', new Date(closed.verificationFinalAt).getTime(), true], 'its settled verification is not reopened');
      const ex = await one(`SELECT * FROM patrol_exceptions WHERE id = $1`, [abandoned.id]);
      assert.equal(ex.status, 'open', 'the abandonment is NOT resolved by late evidence');
      assert.ok(ex.annotations.some((a: any) => a.kind === 'run_completed_after_alert'), JSON.stringify(ex.annotations));
      if (ex.safetyAlertId) {
        const alert = await one(`SELECT * FROM safety_alerts WHERE id = $1`, [ex.safetyAlertId]);
        assert.equal(alert.status, 'open', 'the alert is never closed by late evidence');
      }
      const [audit] = (await audits('patrol.late_sync_flagged', r3)).filter((a: any) => a.afterData.step === 'complete');
      assert.equal(audit.afterData.previousStatus, 'closed_by_system');
      assert.equal((await grantRow(g3.id)).uses, 2, 'the scan and the completion');
      expect(await completeRun(gA.token, r3, lateDone), 200, undefined, 'replay');
      expect(await revoke(A.token, g3.id), 200);
    });

    await test('PR-08-PHOTOS-UNDER-A-GRANT-ARE-VERIFIED-EXACTLY-AS-P1-C-AND-FLAGGED-IN-THE-MANIFEST', async () => {
      const s = await closedShift(A, siteA, gA);
      const runId = Number(s.run.id);
      const image = jpeg();
      expect(await intent(gA.token, runId, photoBody(image)), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'no grant');
      const g = await grantFor(A, s.shift, gA.id);
      const b = photoBody(image);
      const r = await intent(gA.token, runId, b);
      expect(r, 201, undefined, 'intent under the grant');
      assert.deepEqual([r.body.evidence.syncFlags.sort(), r.body.evidence.needsReview], [['recovered_via_grant', 'synced_after_book_off'], true]);
      assert.equal((await put(r.body.upload, image)).status, 200);
      const c = await completePhoto(gA.token, r.body.evidence.id);
      expect(c, 200);
      assert.deepEqual([c.body.uploadStatus, c.body.sha256Stored], ['verified', sha256(image)], 'hashed and verified exactly as P1-C');
      const run = await runRow(runId);
      assert.ok(run.syncFlags.includes('recovered_via_grant') && run.needsReview, 'its run is up for review too');
      const [verifiedAudit] = await audits('patrol.evidence_verified', r.body.evidence.id);
      assert.ok(verifiedAudit.afterData.syncFlags.includes('recovered_via_grant'), 'the verification audit carries the flag');
      // Integrity is unchanged under a grant: bytes that are not the declared ones are rejected and quarantined.
      const declared = jpeg();
      const other = jpeg();
      const bad = await intent(gA.token, runId, photoBody(declared));
      expect(bad, 201);
      assert.equal((await put(bad.body.upload, other)).status, 400, 'storage refuses bytes that do not match the signed checksum');
      const badRow = await one(`SELECT * FROM patrol_evidence WHERE id = $1`, [bad.body.evidence.id]);
      fake.objects.set(keys.siblingKey(badRow.storageKey, 'incoming'), { body: other, contentType: 'image/jpeg' });
      const rejected = await completePhoto(gA.token, bad.body.evidence.id);
      expect(rejected, 200);
      assert.deepEqual([rejected.body.uploadStatus, rejected.body.rejectionReason, rejected.body.retentionStatus], ['rejected', 'hash_mismatch', 'quarantined'],
        'a hash mismatch is never accepted, grant or not');
      // A pending photo whose URL expired gets a new one under the grant (flagged); without a grant it would not.
      const pendingImage = jpeg();
      const pb = photoBody(pendingImage);
      const pending = await intent(gA.token, runId, pb);
      expect(pending, 201);
      expect(await revoke(A.token, g.id), 200);
      expect(await intent(gA.token, runId, pb), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'no new URL once the grant is revoked');
      const g2 = await grantFor(A, s.shift, gA.id);
      const reissued = await intent(gA.token, runId, pb);
      expect(reissued, 201, undefined, 'a new URL under a new grant');
      assert.equal(reissued.body.evidence.id, pending.body.evidence.id, 'the same record (idempotent on clientEvidenceId)');
      assert.ok(reissued.body.upload, 'a fresh upload URL');
      const steps = (await audits('patrol.recovery_grant_used', g2.id)).map((a: any) => a.afterData.step);
      assert.deepEqual(steps, ['photo_upload_url_reissued']);
      assert.equal((await grantRow(g.id)).uses, 3, 'two photo intents and one pending intent under the first grant');
      // A replay of a verified photo returns it, no URL, no use.
      const replay = await intent(gA.token, runId, b);
      assert.deepEqual([replay.status, replay.body.upload, replay.body.evidence.uploadStatus], [201, null, 'verified']);
      assert.equal((await grantRow(g2.id)).uses, 1);
      expect(await revoke(A.token, g2.id), 200);

      // The export manifest lists the flag (holds, retention and exports treat the photo like any other).
      const req = await api('POST', '/patrols/exports', A.token, { purpose: 'incident', runIds: [runId] });
      expect(req, 202);
      await exportsSvc.whenIdle();
      await only(A.id, () => exportsSvc.processPending());
      const ready = await api('GET', `/patrols/exports/${req.body.id}`, A.token);
      assert.equal(ready.body.status, 'ready', JSON.stringify(ready.body.error));
      const dl = await api('GET', `/patrols/exports/${req.body.id}/download`, A.token);
      expect(dl, 200);
      const zip = Buffer.from(await (await fetch(dl.body.url)).arrayBuffer());
      const dir = readZipDirectory(zip);
      const manifest = JSON.parse(readZipEntry(zip, dir.find((e: any) => e.name === 'manifest.json')!).toString('utf8'));
      const item = manifest.items.find((i: any) => i.evidenceId === r.body.evidence.id);
      assert.deepEqual([item.included, item.integrity, item.sha256, item.needsReview], [true, 'ok', sha256(image), true]);
      assert.ok(item.syncFlags.includes('recovered_via_grant'), 'the manifest shows the photo was recovered under a grant');
      const hold = await api('POST', '/patrols/holds', A.token, { scope: 'evidence', evidenceId: r.body.evidence.id, reason: 'Keep the recovered photo' });
      expect(hold, 201, undefined, 'held like any other photo');
      expect(await api('POST', `/patrols/holds/${hold.body.id}/release`, A.token, { reason: 'Reviewed' }), 200);
    });

    await test('PR-09-LATE-EVIDENCE-UNDER-A-GRANT-NEVER-CLOSES-AN-ALERT', async () => {
      const co = await mkCompany('gamma');
      const site = await mkSite(co.id, 'Gamma Gate');
      const guard = await mkGuard('gg');
      const cp = await checkpoint(co.id, site, 'Server room', true);
      await q(`INSERT INTO patrol_policies ("companyId","siteId","escalateUnverified") VALUES ($1,$2,true)`, [co.id, site]);
      const now = Date.now();
      const shift = await mkShift(co.id, site, guard.id, new Date(now - 2 * HOUR), new Date(now + 6 * HOUR), 'in_progress');
      await attend(shift, guard.id, 'check-in', new Date(now - 2 * HOUR));
      const started = new Date(now - 3 * HOUR);
      const run = await one(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId",status,"startedAtDevice","startedAtServer","completedAtDevice","completedAtServer","clientRunId")
        VALUES ($1,$2,$3,$4,$5,'completed',$6,$6,$7,$7,$8) RETURNING *`, [co.id, site, shift, guard.id, guard.userId, started, new Date(started.getTime() + 10 * MIN), cid('run')]);
      const visit = await one(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","checkpointId","scannedPublicId",result,"scannedAtDevice","clientVisitId")
        VALUES ($1,$2,$3,$4,'verified',$5,$6) RETURNING id`, [co.id, run.id, cp.id, cp.publicId, new Date(started.getTime() + 5 * MIN), cid('visit')]);
      // The phone announced the photo during the shift, then lost it from view (an outage): the upload never happened.
      const photo = jpeg();
      const b = photoBody(photo, { kind: 'checkpoint_photo', visitId: Number(visit.id), capturedAtDevice: new Date(started.getTime() + 6 * MIN).toISOString() });
      expect(await intent(guard.token, Number(run.id), b), 201, undefined, 'intent during the shift');
      await only(co.id, () => sweeper.sweep(new Date()));
      const exception = await one(`SELECT * FROM patrol_exceptions WHERE "runId" = $1 AND type = 'evidence_unverified'`, [run.id]);
      assert.ok(exception && exception.safetyAlertId, 'the sweep raised "evidence missing" with an alert');
      // The shift ends; the window closes; the photo can only be sent under a grant.
      await q(`UPDATE attendance_events SET "occurredAt" = $2, "recordedAt" = $2 WHERE "shiftId" = $1 AND type = 'check-in'`, [shift, new Date(now - 34 * HOUR)]);
      await attend(shift, guard.id, 'check-out', new Date(now - 26 * HOUR));
      await q(`UPDATE shifts SET status = 'completed', start = $2, "end" = $3 WHERE id = $1`, [shift, new Date(now - 34 * HOUR), new Date(now - 26 * HOUR)]);
      expect(await intent(guard.token, Number(run.id), b), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'no new upload URL after the window');
      const g = await grantFor(co, shift, guard.id);
      const pi = await intent(guard.token, Number(run.id), b);
      expect(pi, 201, undefined, 'a new upload URL under the grant');
      assert.ok(pi.body.upload && pi.body.evidence.syncFlags.includes('recovered_via_grant') && pi.body.evidence.needsReview);
      assert.equal((await put(pi.body.upload, photo)).status, 200);
      expect(await completePhoto(guard.token, pi.body.evidence.id), 200);
      const ex = await one(`SELECT * FROM patrol_exceptions WHERE id = $1`, [exception.id]);
      const alert = await one(`SELECT * FROM safety_alerts WHERE id = $1`, [exception.safetyAlertId]);
      assert.ok(ex.lateEvidenceAt, 'the exception records the late evidence');
      assert.ok(ex.annotations.some((a: any) => a.kind === 'photo_after_alert'));
      assert.equal(ex.status, 'open', 'the exception is NOT resolved');
      assert.deepEqual([alert.status, alert.priority, Boolean(alert.patrolLateSyncAt)], ['open', 'low', true], 'the alert is downgraded and annotated, never closed');
      const reasons = await api('GET', `/alerts/${alert.id}/resolution-reasons`, co.token);
      assert.ok(reasons.body.reasons.some((r: any) => r.value === 'patrol_completed_late_sync'), 'a person resolves it');
      expect(await revoke(co.token, g.id), 200);
    });

    await test('PR-10-INSIDE-THE-WINDOW-A-GRANT-IS-NEVER-CONSULTED-AND-THE-AUDIT-TRAIL-IS-COMPLETE', async () => {
      // Booked off 2 h ago: inside the standard window. A grant exists but is neither needed nor used.
      const s = await closedShift(A, siteA, gA, 2);
      const g = await grantFor(A, s.shift, gA.id, { reason: 'Pre-emptive: known storage outage tonight', durationHours: 48 });
      const cp = await checkpoint(A.id, siteA, 'Fire exit');
      const v = await scan(gA.token, Number(s.run.id), { clientVisitId: cid('v'), checkpointPublicId: cp.publicId, scannedAtDevice: iso(s.start.getTime() + 70 * MIN) });
      expect(v, 201);
      assert.deepEqual(v.body.syncFlags, ['synced_after_book_off'], 'no recovered_via_grant inside the window');
      const done = await completeRun(gA.token, Number(s.run.id), { completedAtDevice: iso(s.start.getTime() + 2 * HOUR) });
      expect(done, 200);
      assert.ok(!done.body.syncFlags.includes('recovered_via_grant'));
      assert.equal((await grantRow(g.id)).uses, 0, 'not used');
      assert.equal((await audits('patrol.recovery_grant_used', g.id)).length, 0);
      // The service's own lookup: exactly this Guard, this shift, this company, unrevoked and unexpired.
      assert.equal((await grantsSvc.activeGrant(A.id, gA.id, s.shift, new Date()))?.id, g.id);
      assert.equal(await grantsSvc.activeGrant(A.id, gA2.id, s.shift, new Date()), null, 'another Guard');
      assert.equal(await grantsSvc.activeGrant(B.id, gA.id, s.shift, new Date()), null, 'another company');
      assert.equal(await grantsSvc.activeGrant(A.id, gA.id, s.shift, new Date(Date.now() + 49 * HOUR)), null, 'after it expires');
      expect(await revoke(A.token, g.id, 'Outage did not happen'), 200);
      assert.equal(await grantsSvc.activeGrant(A.id, gA.id, s.shift, new Date()), null, 'once revoked');
      // Issue and revoke: who, which shift and Guard, why, when.
      const [issued] = await audits('patrol.recovery_grant_issued', g.id);
      assert.deepEqual([issued.actorId, Number(issued.companyId), issued.entityType, issued.afterData.shiftId, issued.afterData.guardId, issued.afterData.reason, issued.afterData.durationHours],
        [A.ownerId, A.id, 'patrol_sync_recovery_grant', s.shift, gA.id, 'Pre-emptive: known storage outage tonight', 48]);
      assert.equal(new Date(issued.afterData.expiresAt).getTime() - new Date(issued.afterData.createdAt).getTime(), 48 * HOUR);
      const [revokedAudit] = await audits('patrol.recovery_grant_revoked', g.id);
      assert.deepEqual([revokedAudit.actorId, revokedAudit.afterData.reason, revokedAudit.beforeData.revokedAt, revokedAudit.beforeData.uses], [A.ownerId, 'Outage did not happen', null, 0]);
      // Every grant in this suite left exactly one issue entry, and every revoked grant exactly one revoke entry.
      const issuedTotal = await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.recovery_grant_issued'`);
      const viaApi = await count(`SELECT count(*) FROM patrol_sync_recovery_grants g WHERE EXISTS (SELECT 1 FROM audit_logs a WHERE a.action = 'patrol.recovery_grant_issued' AND a."entityId" = g.id)`);
      assert.equal(issuedTotal, viaApi, 'one issue entry per grant issued through the API');
      const revokedTotal = await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.recovery_grant_revoked'`);
      assert.equal(revokedTotal, await count(`SELECT count(*) FROM patrol_sync_recovery_grants WHERE "revokedAt" IS NOT NULL`));
      const usesTotal = await count(`SELECT COALESCE(sum(uses), 0) FROM patrol_sync_recovery_grants`);
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.recovery_grant_used'`), usesTotal, 'every use audited, every audited use counted');
    });
  } finally {
    await app.close();
    await fake.stop();
  }
  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`);
  console.log(JSON.stringify({ event: 'patrol_recovery_grants_certified', tests: passed }));
  if (failures.length) process.exit(1);
  process.exit(0);
}

main().catch((error) => {
  console.error(String(error?.stack ?? error).replace(/https?:\/\/\S+/g, '[url]'));
  process.exit(1);
});
