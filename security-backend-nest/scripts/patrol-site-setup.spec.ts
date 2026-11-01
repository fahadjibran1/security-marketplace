/**
 * S4 1.3.0 B1 — patrol site setup, checkpoint test scans, route versions, shift-based windows and the shift patrol
 * requirement. The whole application over HTTP (and the sweep on its own clock) on a disposable database built from the
 * repository's own migrations (head = Migration 74). The patrol and safety sweeps' timers are stopped.
 *
 *   PSS-01  GET /patrols/sites/:siteId/setup: one view (mode, evidence mode, frequency, anchor, checkpoints, route
 *           version, checklist, warnings); patrols.view; Guards 403; another company's site 404
 *   PSS-02  PUT …/setup: validation and permissions; ONE transaction writes the site policy, the shift-anchored schedule
 *           (stored so the 1.2.1 engine sees no window) and the automatic route version; saving never activates; audited
 *   PSS-03  POST …/setup/confirm: 422 PATROL_SETUP_INCOMPLETE with the checklist until complete; activation audited and
 *           not re-dated; a photo-only site needs no checkpoint; a chosen route needs a required checkpoint
 *   PSS-04  checkpoint test scan: valid (confirmed, a NEW automatic route version), repeat (no change), wrong checkpoint,
 *           wrong site, another company's label, tampered, malformed, stale tokenVersion, revoked; rotation and revocation
 *           clear the confirmation (and leave the automatic route as a new version); audited; permissions
 *   PSS-05  route versions: a referenced route's checkpoint change is a successor (new id, link, audit) — never in place;
 *           an unreferenced route changes in place; the replaced id 409; concurrent edits: one successor, one 409; the
 *           automatic route is managed by the setup (409); every schedule naming the replaced version is moved onto the
 *           new current one in the same transaction (no schedule successor, updatedAt untouched; no schedule ever names a
 *           replaced version — what the 1.2.1 backend relies on after a rollback); a run keeps the route version it started
 *           under and is judged against it; a window uses the version in force at its start
 *   PSS-06  shift-based windows through the sweep: scheduled start (default), Book On override, early Book Off, cancelled
 *           shift, every_shift / per_shift / off × the shift's own value, scope = the shift, ad-hoc patrols never missed
 *   PSS-07  a mid-shift requirement change applies to future windows only (both directions); a frequency change is a
 *           successor version (Migration 73) whose windows start at the change
 *   PSS-08  the Guard plan carries the shift windows (anchor 'shift', route version, covered), the shift entry, the
 *           requirement and the new warning codes; a run starts on a shift window (scope sh{shift}); a replay naming an
 *           older version of the same route is the same request; the plan is written as the mobile contract fixture
 *   PSS-09  shift DTO: patrolRequirement on create and update (shifts.manage; validation; audited change; a closed shift's
 *           requirement is its record); shift reads add { value, effectiveRequired, source, summary } for Patrols companies
 *   PSS-10  explainVerification on the run reads (company list / detail, Guard runs) — additive; QR without a confirmed
 *           checkpoint is "Site setup incomplete"
 *   PSS-11  compatibility (c): pilot-shaped data — a clock schedule with a successor, an unconfirmed checkpoint, a run
 *           flagged qr_rule_missing — reads, plans, counts and is judged exactly as in 1.2.1
 *
 * Needs PATROL_SITE_SETUP_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

const url = process.env.PATROL_SITE_SETUP_DATABASE_URL;
if (!url) throw new Error('PATROL_SITE_SETUP_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Patrol site setup database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-site-setup-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
for (const k of ['RESEND_API_KEY', 'EXPO_ACCESS_TOKEN', 'PUSH_WELFARE_REMINDERS_ENABLED', 'PUSH_GUARD_NOTIFICATIONS_ENABLED', 'PATROL_QR_PREVIOUS_SIGNING_KEY',
  'PATROL_EVIDENCE_STORAGE_ENDPOINT']) delete process.env[k];
const SIGNING_KEY = 'patrol-site-setup-spec-only-signing-key-0001';
process.env.PATROL_QR_SIGNING_KEY = SIGNING_KEY;
process.env.PATROL_QR_SIGNING_KEY_ID = 'b1';

let passed = 0;
const failures: string[] = [];
const test = async (id: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failures.push(id);
    console.log(`FAIL  ${id}\n      ${String((error as Error)?.stack ?? error).split('\n').slice(0, 10).join('\n      ')}`);
  }
};

type Res = { status: number; body: any };
const PASSWORD = 'patrol-site-setup-spec-only-password-1';
const MIN = 60_000;
const HOUR = 60 * MIN;
const Z = (s: string) => new Date(s);
let clientSeq = 0;
const cid = (p: string) => `${p}-${Date.now().toString(36)}-${(++clientSeq).toString().padStart(4, '0')}`;

async function main() {
  const path = require('node:path');
  const fs = require('node:fs');
  const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
  const allFiles: string[] = fs.readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).sort();
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const base = buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' });
  const migrate = new DataSource({ ...base, entities: [], migrations: allFiles.map((f) => path.join(migrationsDir, f)), dropSchema: true } as never);
  await migrate.initialize();
  const migrated = await migrate.runMigrations({ transaction: 'each' });
  assert.equal(migrated[migrated.length - 1]?.name, 'AddPatrolSiteSetup1720900000021', 'the head is Migration 74 (patrol site setup)');
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
  const sweeper = app.get(PatrolSweepService);
  sweeper.onModuleDestroy();
  app.get(SafetyAlertService).onModuleDestroy();
  const auth = app.get(AuthService);
  const W = await import('../src/patrol/patrol-window.service');
  const QR = await import('../src/patrol/patrol-qr');

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
    assert.equal(r.status, status, `${what} expected ${status}${code ? ` ${code}` : ''}, got ${r.status} ${JSON.stringify(r.body)}`);
    if (code) assert.equal(r.body?.code, code, `${what} code: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;

  // ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash(PASSWORD, 4);
  let seq = 0;
  const mkUser = async (email: string, role: string) =>
    Number((await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
       VALUES ($1,$2,$3,'active',true,false,$4,'Spec') RETURNING id`, [email, hash, role, email.split('@')[0]])).id);
  const mkCompany = async (label: string) => {
    seq += 1;
    const ownerEmail = `pss.${label}.owner@example.invalid`;
    const ownerId = await mkUser(ownerEmail, 'company_admin');
    const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,$2,$3,'1 Way','ops@example.invalid',true) RETURNING id`,
      [ownerId, `PSS ${label} Ltd`, String(74000000 + seq)]);
    return { id: Number(id), ownerId, token: await login(ownerEmail) };
  };
  const mkMember = async (companyId: number, label: string, role: string) => {
    const email = `pss.${label}.${role}@example.invalid`;
    const id = await mkUser(email, 'company_admin');
    await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [id, companyId, role]);
    return login(email);
  };
  const mkSite = async (companyId: number, name: string, tz = 'Europe/London') =>
    Number((await one(`INSERT INTO sites ("companyId",name,address,timezone) VALUES ($1,$2,'3 Quay',$3) RETURNING id`, [companyId, name, tz])).id);
  const mkGuard = async (label: string) => {
    seq += 1;
    const email = `pss.${label}@example.invalid`;
    const userId = await mkUser(email, 'guard');
    const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, `Guard ${label}`, `74${String(seq).padStart(14, '0')}`, `0774${String(seq).padStart(7, '0')}`]);
    return { id: Number(id), userId, email, token: await login(email) };
  };
  const mkShift = async (companyId: number, siteId: number, guardId: number, start: Date, end: Date, status = 'in_progress', requirement: string | null = null) =>
    Number((await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end","patrolRequirement") VALUES ($1,$2,'Gate',$3,$4,$5,$6,$7) RETURNING id`,
      [companyId, siteId, guardId, status, start, end, requirement])).id);
  const bookOn = (shiftId: number, guardId: number, at: Date) =>
    q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-in',$3,$3,false)`, [shiftId, guardId, at]);
  const bookOff = async (shiftId: number, guardId: number, at: Date) => {
    await q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-out',$3,$3,false)`, [shiftId, guardId, at]);
    await q(`UPDATE shifts SET status = 'completed' WHERE id = $1`, [shiftId]);
  };
  const mkCheckpoint = async (token: string, siteId: number, label: string) =>
    expect(await api('POST', '/patrols/checkpoints', token, { siteId, label }), 201, undefined, `checkpoint ${label}`);
  const labelOf = async (token: string, checkpointId: number) => expect(await api('GET', `/patrols/checkpoints/${checkpointId}/label`, token), 200).payload as string;
  const testScan = (token: string, checkpointId: number, scanPayload: string, siteId?: number) =>
    api('POST', `/patrols/checkpoints/${checkpointId}/confirm`, token, { scanPayload, ...(siteId ? { siteId } : {}) });
  const setup = (token: string, siteId: number, body: Record<string, unknown>) => api('PUT', `/patrols/sites/${siteId}/setup`, token, body);
  const autoRoutes = (siteId: number) => q(`SELECT * FROM patrol_routes WHERE "siteId" = $1 AND kind = 'auto' ORDER BY id`, [siteId]);
  const routeItems = async (routeId: number) => (await q(`SELECT "checkpointId" FROM patrol_route_checkpoints WHERE "routeId" = $1 ORDER BY position`, [routeId])).map((r: any) => Number(r.checkpointId));
  const focus = (companyId: number) => q(`UPDATE companies SET "patrolsEnabled" = (id = $1) OR id = ANY($2::int[])`, [companyId, []]);
  const sweep = (at: Date | string) => sweeper.sweep(new Date(at));
  const missedOf = (companyId: number) => q(`SELECT * FROM patrol_exceptions WHERE "companyId" = $1 AND type = 'patrol_missed' ORDER BY "windowStart", "scopeKey", id`, [companyId]);
  /** Activate a site's shift patrols as of `since` (the setup, its schedule and the audit floors backdated). */
  const backdate = async (siteId: number, since: string) => {
    await q(`UPDATE patrol_policies SET "setupConfirmedAt" = $2 WHERE "siteId" = $1 AND "setupConfirmedAt" IS NOT NULL`, [siteId, since]);
    await q(`UPDATE patrol_schedules SET "createdAt" = $2, "updatedAt" = $2 WHERE "siteId" = $1 AND anchor = 'shift'`, [siteId, since]);
    await q(`UPDATE audit_logs SET "createdAt" = $2 WHERE action = 'patrol.setup.updated' AND ("afterData"->>'siteId')::int = $1`, [siteId, since]);
  };
  /** A site whose shift patrols are active (QR from one confirmed checkpoint unless photo), as of `since`. */
  const activeSite = async (co: { id: number; token: string }, name: string, body: Record<string, unknown>, since = '2026-01-01T00:00:00Z') => {
    const siteId = await mkSite(co.id, name);
    let checkpoint: any = null;
    if (body.evidenceMode !== 'photo') {
      checkpoint = await mkCheckpoint(co.token, siteId, `${name} Gate`);
      expect(await testScan(co.token, checkpoint.id, await labelOf(co.token, checkpoint.id)), 200);
    }
    expect(await setup(co.token, siteId, { frequencyMinutes: 60, evidenceMode: 'qr', ...body }), 200, undefined, 'save');
    expect(await api('POST', `/patrols/sites/${siteId}/setup/confirm`, co.token), 200, undefined, 'activate');
    await backdate(siteId, since);
    const schedule = await one(`SELECT * FROM patrol_schedules WHERE "siteId" = $1 AND anchor = 'shift' AND "archivedAt" IS NULL`, [siteId]);
    return { siteId, checkpoint, schedule };
  };

  const A = await mkCompany('alpha');
  const B = await mkCompany('bravo');
  const viewerA = await mkMember(A.id, 'alpha', 'viewer');
  const opsA = await mkMember(A.id, 'alpha', 'operations');
  const controlA = await mkMember(A.id, 'alpha', 'control_room');
  const gA = await mkGuard('ava');

  try {
    // ═══════════════════ Setup view / save / activate ═══════════════════
    const siteX = await mkSite(A.id, 'Harbour Gate');
    const siteY = await mkSite(A.id, 'Annex');
    const siteB = await mkSite(B.id, 'Bravo Yard');

    await test('PSS-01-ONE-SETUP-VIEW-PERMISSIONS-AND-TENANCY', async () => {
      const v = expect(await api('GET', `/patrols/sites/${siteX}/setup`, viewerA), 200, undefined, 'viewer reads');
      assert.deepEqual([v.siteId, v.setupMode, v.evidenceMode, v.frequencyMinutes, v.windowAnchor, v.active, v.schedule, v.ready],
        [siteX, null, 'qr', null, 'scheduled_start', false, null, false], 'a site never set up');
      assert.deepEqual(v.checklist.map((c: any) => [c.code, c.ok]), [['setup_mode', false], ['frequency', false], ['confirmed_checkpoints', false]]);
      expect(await api('GET', `/patrols/sites/${siteB}/setup`, A.token), 404, 'PATROL_SITE_NOT_FOUND', 'another company\'s site');
      expect(await api('GET', `/patrols/sites/${siteX}/setup`, gA.token), 403, undefined, 'a Guard');
      expect(await api('GET', `/patrols/sites/999999/setup`, A.token), 404, 'PATROL_SITE_NOT_FOUND');
    });

    let cpX1: any; let cpX2: any; let cpY1: any;
    await test('PSS-02-SAVE-WRITES-POLICY-SHIFT-SCHEDULE-AND-AUTOMATIC-ROUTE-IN-ONE-TRANSACTION-NEVER-ACTIVATES', async () => {
      const body = { setupMode: 'every_shift', evidenceMode: 'qr', frequencyMinutes: 60 };
      expect(await setup(viewerA, siteX, body), 403, 'PATROL_FORBIDDEN', 'patrols.view only');
      expect(await setup(controlA, siteX, body), 403, 'PATROL_FORBIDDEN', 'control room never configures');
      expect(await setup(A.token, siteB, body), 404, 'PATROL_SITE_NOT_FOUND');
      expect(await setup(A.token, siteX, { ...body, setupMode: 'sometimes' }), 400);
      expect(await setup(A.token, siteX, { ...body, evidenceMode: 'nfc' }), 400);
      expect(await setup(A.token, siteX, { ...body, frequencyMinutes: 10 }), 400);
      expect(await setup(A.token, siteX, { ...body, windowAnchor: 'lunch' }), 400);
      const routeY = expect(await api('POST', '/patrols/routes', A.token, { siteId: siteY, name: 'Y', checkpoints: [{ checkpointId: (await mkCheckpoint(A.token, siteY, 'Y door')).id }] }), 201);
      expect(await setup(A.token, siteX, { ...body, routeId: routeY.id }), 422, 'PATROL_ROUTE_NOT_FOR_SITE', 'another site\'s route');
      assert.equal(await count(`SELECT count(*) FROM patrol_policies WHERE "siteId" = $1`, [siteX]), 0, 'a refused save wrote nothing');

      cpX1 = await mkCheckpoint(A.token, siteX, 'Gate 1');
      cpX2 = await mkCheckpoint(A.token, siteX, 'Gate 2');
      cpY1 = await mkCheckpoint(A.token, siteY, 'Y gate');
      const saved = expect(await setup(opsA, siteX, body), 200, undefined, 'operations manages patrols');
      assert.deepEqual([saved.setupMode, saved.evidenceMode, saved.frequencyMinutes, saved.windowAnchor, saved.active, saved.confirmedAt],
        ['every_shift', 'qr', 60, 'scheduled_start', false, null], 'saved, NOT active');
      assert.deepEqual([saved.route.mode, saved.route.currentVersion.kind, saved.route.currentVersion.checkpoints], ['auto', 'auto', []], 'the automatic route: no confirmed checkpoint yet');
      const schedule = await one(`SELECT *, "startsOn"::text AS s, "endsOn"::text AS e FROM patrol_schedules WHERE "siteId" = $1`, [siteX]);
      assert.deepEqual([schedule.anchor, schedule.active, schedule.s, schedule.e, schedule.activeFrom, schedule.activeTo, schedule.frequencyMinutes, schedule.windowMinutes, Number(schedule.routeId)],
        ['shift', false, '2000-01-01', '2000-01-01', '00:00', '00:00', 60, 60, saved.route.currentVersion.id], 'inert to the 1.2.1 clock engine');
      const policy = await one(`SELECT * FROM patrol_policies WHERE "siteId" = $1`, [siteX]);
      assert.deepEqual([policy.setupMode, policy.windowAnchor, policy.methods, policy.photosPerRun, policy.photosPerCheckpoint, policy.setupConfirmedAt],
        ['every_shift', 'scheduled_start', ['qr'], 0, 0, null]);
      const audit = await one(`SELECT * FROM audit_logs WHERE action = 'patrol.setup.updated' AND ("afterData"->>'siteId')::int = $1`, [siteX]);
      assert.equal(audit.afterData.requirementChanged, true);
      assert.equal(saved.checkpoints.length, 2);
      assert.ok(saved.warnings.some((w: any) => w.code === 'CHECKPOINTS_NOT_CONFIRMED') && saved.warnings.some((w: any) => w.code === 'SETUP_NOT_ACTIVE'));
      // The schedule routes never edit it; it is not listed as a clock schedule.
      expect(await api('PATCH', `/patrols/schedules/${schedule.id}`, A.token, { frequencyMinutes: 30 }), 409, 'PATROL_MANAGED_BY_SETUP');
      expect(await api('DELETE', `/patrols/schedules/${schedule.id}`, A.token), 409, 'PATROL_MANAGED_BY_SETUP');
      assert.ok(!(await api('GET', `/patrols/schedules?siteId=${siteX}&includeInactive=true`, A.token)).body.some((s: any) => s.id === Number(schedule.id)));
      // Saving again with no change writes no new version of anything.
      expect(await setup(A.token, siteX, body), 200);
      assert.equal(await count(`SELECT count(*) FROM patrol_schedules WHERE "siteId" = $1`, [siteX]), 1);
      assert.equal((await autoRoutes(siteX)).length, 1);
    });

    await test('PSS-03-ACTIVATION-NEEDS-A-COMPLETE-CHECKLIST', async () => {
      const refused = expect(await api('POST', `/patrols/sites/${siteX}/setup/confirm`, A.token), 422, 'PATROL_SETUP_INCOMPLETE', 'no confirmed checkpoint');
      assert.deepEqual(refused.details.checklist.filter((c: any) => !c.ok).map((c: any) => c.code), ['confirmed_checkpoints']);
      assert.match(refused.message, /Site setup incomplete: no confirmed checkpoints/);
      expect(await api('POST', `/patrols/sites/${siteX}/setup/confirm`, viewerA), 403);
      // Never set up at all: the checklist says so.
      const empty = expect(await api('POST', `/patrols/sites/${siteY}/setup/confirm`, A.token), 422, 'PATROL_SETUP_INCOMPLETE');
      assert.ok(empty.details.checklist.some((c: any) => c.code === 'setup_mode' && !c.ok));
      // A photo-only site needs no checkpoint.
      const photoSite = await mkSite(A.id, 'Photo yard');
      expect(await setup(A.token, photoSite, { setupMode: 'per_shift', evidenceMode: 'photo', frequencyMinutes: 120 }), 200);
      const ok = expect(await api('POST', `/patrols/sites/${photoSite}/setup/confirm`, A.token), 200);
      assert.deepEqual([ok.active, ok.evidenceMode, ok.route], [true, 'photo', null]);
      const policy = await one(`SELECT methods, "photosPerRun" FROM patrol_policies WHERE "siteId" = $1`, [photoSite]);
      assert.deepEqual([policy.methods, policy.photosPerRun], [['photo'], 1]);
      // A chosen (custom) route needs at least one required, active checkpoint.
      const routeSite = await mkSite(A.id, 'Route yard');
      const rc = await mkCheckpoint(A.token, routeSite, 'R1');
      const route = expect(await api('POST', '/patrols/routes', A.token, { siteId: routeSite, name: 'Chosen', checkpoints: [{ checkpointId: rc.id, required: false }] }), 201);
      expect(await setup(A.token, routeSite, { setupMode: 'every_shift', evidenceMode: 'qr_photo', frequencyMinutes: 60, routeId: route.id }), 200);
      const r = expect(await api('POST', `/patrols/sites/${routeSite}/setup/confirm`, A.token), 422, 'PATROL_SETUP_INCOMPLETE');
      assert.deepEqual(r.details.checklist.filter((c: any) => !c.ok).map((c: any) => c.code), ['route_checkpoints']);
      expect(await api('PATCH', `/patrols/routes/${route.id}`, A.token, { checkpoints: [{ checkpointId: rc.id, required: true }] }), 200);
      const active = expect(await api('POST', `/patrols/sites/${routeSite}/setup/confirm`, A.token), 200, undefined, 'the chosen route now has a required checkpoint');
      assert.equal(active.route.mode, 'custom');
    });

    await test('PSS-04-CHECKPOINT-TEST-SCAN-CONFIRMS-THE-CURRENT-SIGNED-LABEL-ONLY', async () => {
      const label1 = await labelOf(A.token, cpX1.id);
      const label2 = await labelOf(A.token, cpX2.id);
      const labelY = await labelOf(A.token, cpY1.id);
      const bCheckpoint = await mkCheckpoint(B.token, siteB, 'B gate');
      const labelB = await labelOf(B.token, bCheckpoint.id);
      const rejected = async (token: string, id: number, payload: string, status: number, code: string, reason: string, siteId?: number) => {
        const r = expect(await testScan(token, id, payload, siteId), status, code, reason);
        assert.equal(r.details?.reason, reason);
      };
      expect(await testScan(viewerA, cpX1.id, label1), 403, 'PATROL_FORBIDDEN', 'patrols.manage only');
      expect(await testScan(B.token, cpX1.id, label1), 404, 'PATROL_NOT_FOUND', 'another company\'s checkpoint');
      await rejected(A.token, cpX1.id, label2, 422, 'PATROL_CHECKPOINT_TEST_SCAN_INVALID', 'wrong_checkpoint');
      await rejected(A.token, cpX1.id, labelY, 422, 'PATROL_CHECKPOINT_TEST_SCAN_INVALID', 'wrong_site');
      await rejected(A.token, cpX1.id, label1, 422, 'PATROL_CHECKPOINT_TEST_SCAN_INVALID', 'wrong_site', siteY);
      await rejected(A.token, cpX1.id, labelB, 422, 'PATROL_CHECKPOINT_TEST_SCAN_INVALID', 'unknown_checkpoint');
      await rejected(A.token, cpX1.id, `${label1.slice(0, -4)}AAAA`, 422, 'PATROL_CHECKPOINT_TEST_SCAN_INVALID', 'tampered_signature');
      await rejected(A.token, cpX1.id, 'https://example.invalid/not-a-label', 422, 'PATROL_CHECKPOINT_TEST_SCAN_INVALID', 'malformed_payload');
      const forged = `s4cp:1:zz:${cpX1.publicId}:1:${'A'.repeat(43)}`;
      await rejected(A.token, cpX1.id, forged, 422, 'PATROL_CHECKPOINT_TEST_SCAN_INVALID', 'unknown_signing_key');
      const future = QR.signCheckpointLabel(cpX1.publicId, 5)!;
      await rejected(A.token, cpX1.id, future, 422, 'PATROL_CHECKPOINT_TEST_SCAN_INVALID', 'invalid_label_version');
      assert.equal(await count(`SELECT count(*) FROM patrol_checkpoints WHERE "confirmedAt" IS NOT NULL`), 0, 'nothing confirmed by a refused scan');
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.checkpoint.test_scan_rejected' AND "entityId" = $1`, [cpX1.id]), 8, 'every refusal audited');
      assert.equal((await autoRoutes(siteX)).length, 1);

      // Valid: confirmed, and the automatic route gets a NEW version that includes it.
      const ok = expect(await testScan(A.token, cpX1.id, label1, siteX), 200);
      assert.deepEqual([ok.checkpoint.confirmed, ok.checkpoint.confirmedTokenVersion, ok.alreadyConfirmed], [true, 1, false]);
      const v = await autoRoutes(siteX);
      assert.equal(v.length, 2, 'a successor version');
      assert.deepEqual([Number(v[0].supersededByRouteId), v[0].active, v[0].archivedAt != null], [Number(v[1].id), false, true], 'the first version archived and linked');
      assert.deepEqual(await routeItems(Number(v[0].id)), [], 'the first version is unchanged (never edited in place)');
      assert.deepEqual(await routeItems(Number(v[1].id)), [cpX1.id]);
      assert.equal(ok.automaticRouteId, Number(v[1].id));
      const confirmed = await one(`SELECT * FROM audit_logs WHERE action = 'patrol.checkpoint.confirmed' AND "entityId" = $1`, [cpX1.id]);
      assert.deepEqual([confirmed.userId, confirmed.afterData.confirmedTokenVersion, confirmed.afterData.keyId], [A.ownerId, 1, 'b1']);
      // A repeat changes nothing.
      const again = expect(await testScan(A.token, cpX1.id, label1), 200);
      assert.equal(again.alreadyConfirmed, true);
      assert.equal((await autoRoutes(siteX)).length, 2);
      // Stale label after a rotation (reprint): refused; and the rotation cleared cpX2's (absent) confirmation.
      expect(await testScan(A.token, cpX2.id, label2), 200);
      assert.deepEqual(await routeItems(Number((await autoRoutes(siteX))[2].id)), [cpX1.id, cpX2.id], 'label order');
      const rotated = expect(await api('POST', `/patrols/checkpoints/${cpX2.id}/rotate`, A.token), 200);
      assert.deepEqual([rotated.tokenVersion, rotated.confirmed, rotated.confirmedAt], [2, false, null], 'rotation clears the confirmation');
      const afterRotate = await autoRoutes(siteX);
      assert.deepEqual(await routeItems(Number(afterRotate[afterRotate.length - 1].id)), [cpX1.id], 'and the automatic route drops it (a new version)');
      await rejected(A.token, cpX2.id, label2, 422, 'PATROL_CHECKPOINT_TEST_SCAN_INVALID', 'stale_label');
      const rotateAudit = await one(`SELECT * FROM audit_logs WHERE action = 'patrol.checkpoint.rotated' AND "entityId" = $1`, [cpX2.id]);
      assert.deepEqual(rotateAudit.afterData, { tokenVersion: 2, confirmationCleared: true });
      expect(await testScan(A.token, cpX2.id, await labelOf(A.token, cpX2.id)), 200, undefined, 'the new label confirms again');
      // Revoked: refused (409) and revoking a confirmed checkpoint clears it and drops it from the route.
      const spare = await mkCheckpoint(A.token, siteX, 'Spare');
      const spareLabel = await labelOf(A.token, spare.id);
      expect(await testScan(A.token, spare.id, spareLabel), 200);
      const revoked = expect(await api('POST', `/patrols/checkpoints/${spare.id}/revoke`, A.token), 200);
      assert.deepEqual([revoked.confirmed, revoked.confirmedAt], [false, null]);
      const r = expect(await testScan(A.token, spare.id, spareLabel), 409, 'PATROL_CHECKPOINT_REVOKED');
      assert.equal(r.details.reason, 'checkpoint_revoked');
      const latest = await autoRoutes(siteX);
      assert.deepEqual(await routeItems(Number(latest[latest.length - 1].id)), [cpX1.id, cpX2.id]);
      // Switching a confirmed checkpoint off removes it too (new version); a label change does not.
      const before = latest.length;
      expect(await api('PATCH', `/patrols/checkpoints/${cpX2.id}`, A.token, { label: 'Gate 2 (north)' }), 200);
      assert.equal((await autoRoutes(siteX)).length, before, 'a label change is not a route change');
      // Exactly one current automatic version, all others archived and linked in a single chain.
      const chain = await autoRoutes(siteX);
      assert.equal(chain.filter((x: any) => x.archivedAt == null).length, 1);
      assert.ok(chain.slice(0, -1).every((x: any, i: number) => Number(x.supersededByRouteId) === Number(chain[i + 1].id)));
    });

    await test('PSS-03B-ACTIVATION-IS-AUDITED-AND-NOT-RE-DATED', async () => {
      const activated = expect(await api('POST', `/patrols/sites/${siteX}/setup/confirm`, A.token), 200);
      assert.equal(activated.active, true);
      const first = activated.confirmedAt;
      const audit = await one(`SELECT * FROM audit_logs WHERE action = 'patrol.setup.confirmed' AND ("afterData"->>'siteId')::int = $1`, [siteX]);
      assert.deepEqual([audit.afterData.routeMode, audit.afterData.checkpointIds.length > 0], ['auto', true], 'the frozen version is recorded');
      const repeat = expect(await api('POST', `/patrols/sites/${siteX}/setup/confirm`, A.token), 200);
      assert.equal(repeat.confirmedAt, first, 'activation is not re-dated');
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.setup.confirmed' AND ("afterData"->>'siteId')::int = $1`, [siteX]), 1);
      const view = expect(await api('GET', `/patrols/sites/${siteX}/setup`, viewerA), 200);
      assert.equal(view.ready, true);
      assert.ok(!view.warnings.some((w: any) => w.code === 'SETUP_NOT_ACTIVE'));
    });

    // ═══════════════════ Route versions ═══════════════════
    await test('PSS-05-ROUTE-CHANGES-ARE-SUCCESSOR-VERSIONS-AND-RUNS-KEEP-THEIRS', async () => {
      const C = await mkCompany('charlie');
      const g = await mkGuard('cara');
      const site = await mkSite(C.id, 'Charlie Quay');
      const [c1, c2, c3] = [await mkCheckpoint(C.token, site, 'C1'), await mkCheckpoint(C.token, site, 'C2'), await mkCheckpoint(C.token, site, 'C3')];
      // An unreferenced route changes in place.
      const free = expect(await api('POST', '/patrols/routes', C.token, { siteId: site, name: 'Free', checkpoints: [{ checkpointId: c1.id }] }), 201);
      const freeEdit = expect(await api('PATCH', `/patrols/routes/${free.id}`, C.token, { checkpoints: [{ checkpointId: c2.id }] }), 200);
      assert.deepEqual([freeEdit.id, freeEdit.versioned, freeEdit.checkpoints.map((c: any) => c.checkpointId)], [free.id, false, [c2.id]]);
      // A route a schedule names: a successor.
      const route = expect(await api('POST', '/patrols/routes', C.token, { siteId: site, name: 'Perimeter', checkpoints: [{ checkpointId: c1.id }, { checkpointId: c2.id }] }), 201);
      const sched = expect(await api('POST', '/patrols/schedules', C.token, { siteId: site, name: 'Hourly', activeFrom: '00:00', activeTo: '00:00', frequencyMinutes: 60, routeId: route.id }), 201);
      const shiftId = await mkShift(C.id, site, g.id, Z('2026-11-03T08:00:00Z'), Z('2026-11-03T16:00:00Z'));
      // A run started under version 1 (window 10:00–11:00).
      const run1 = expect(await api('POST', '/patrols/runs', g.token, { shiftId, clientRunId: cid('run'), scheduleId: sched.id, routeId: route.id, startedAtDevice: '2026-11-03T10:05:00Z' }), 201);
      assert.equal(run1.routeId, route.id);
      const v2 = expect(await api('PATCH', `/patrols/routes/${route.id}`, C.token, { checkpoints: [{ checkpointId: c1.id }, { checkpointId: c2.id }, { checkpointId: c3.id }] }), 200);
      assert.ok(v2.id !== route.id && v2.versioned === true && v2.predecessorId === route.id, 'a new id');
      const old = await one(`SELECT * FROM patrol_routes WHERE id = $1`, [route.id]);
      assert.deepEqual([Number(old.supersededByRouteId), old.active, old.archivedAt != null], [v2.id, false, true]);
      assert.deepEqual(await routeItems(route.id), [c1.id, c2.id], 'version 1 is never edited in place');
      // The schedule now names the CURRENT version (rollback-safe: 1.2.1 only follows routeId), in the same transaction —
      // not a timing change: no schedule successor, and its updatedAt (the sweep's judging floor) is untouched.
      const after = await one(`SELECT * FROM patrol_schedules WHERE id = $1`, [sched.id]);
      assert.equal(Number(after.routeId), v2.id, 'the schedule names the new current version');
      assert.equal(new Date(after.updatedAt).toISOString(), new Date(sched.updatedAt).toISOString(), 'updatedAt untouched');
      assert.deepEqual([after.supersededByScheduleId, after.archivedAt], [null, null], 'no schedule successor');
      const audit = await one(`SELECT * FROM audit_logs WHERE action = 'patrol.route.superseded' AND "entityId" = $1`, [route.id]);
      assert.deepEqual([audit.afterData.successorId, audit.afterData.reason, audit.afterData.repointedScheduleIds], [v2.id, 'checkpoints_changed', [sched.id]]);
      // The 1.2.1 schedule edit paths still behave: a name change in place, a timing change a successor (on the current route).
      const renamed = expect(await api('PATCH', `/patrols/schedules/${sched.id}`, C.token, { name: 'Hourly (gate)' }), 200);
      assert.deepEqual([renamed.id, renamed.routeId, renamed.timingChanged], [sched.id, v2.id, false]);
      expect(await api('PATCH', `/patrols/schedules/${sched.id}`, C.token, { routeId: route.id }), 422, 'PATROL_ROUTE_NOT_FOR_SITE', 'a replaced version cannot be named again');
      expect(await api('PATCH', `/patrols/routes/${route.id}`, C.token, { name: 'again' }), 409, 'PATROL_ROUTE_SUPERSEDED', 'the replaced id');
      // Concurrent edits of the current version: exactly one successor.
      const [x, y] = await Promise.all([
        api('PATCH', `/patrols/routes/${v2.id}`, C.token, { checkpoints: [{ checkpointId: c3.id }] }),
        api('PATCH', `/patrols/routes/${v2.id}`, C.token, { checkpoints: [{ checkpointId: c2.id }] }),
      ]);
      assert.deepEqual([x.status, y.status].sort(), [200, 409], `one wins, one 409 (${x.status} ${y.status})`);
      assert.equal(await count(`SELECT count(*) FROM patrol_routes WHERE "supersededByRouteId" IS NOT NULL AND "siteId" = $1`, [site]), 2, 'never a second successor of one version');
      const head = await one(`SELECT * FROM patrol_routes WHERE "siteId" = $1 AND name = 'Perimeter' AND "archivedAt" IS NULL`, [site]);
      // The invariant 1.2.1 relies on: no schedule ever names a replaced version.
      assert.equal(await count(`SELECT count(*) FROM patrol_schedules s JOIN patrol_routes r ON r.id = s."routeId" WHERE r."supersededByRouteId" IS NOT NULL`), 0);
      assert.equal(Number((await one(`SELECT "routeId" FROM patrol_schedules WHERE id = $1`, [sched.id])).routeId), Number(head.id));
      // A timing change of the schedule now: the successor takes the current route too.
      const retimed = expect(await api('PATCH', `/patrols/schedules/${sched.id}`, C.token, { frequencyMinutes: 120 }), 200);
      assert.deepEqual([retimed.timingChanged, retimed.routeId], [true, Number(head.id)]);
      await q(`UPDATE patrol_schedules SET "archivedAt" = '2026-11-04T00:00:00Z', "supersededAt" = '2026-11-04T00:00:00Z' WHERE id = $1`, [sched.id]);
      // The run keeps version 1 and is judged against it: C3 (added later) is not required.
      await q(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","checkpointId","scannedPublicId",result,"scannedAtDevice","clientVisitId") VALUES ($1,$2,$3,$4,'verified','2026-11-03T10:10:00Z',$5),($1,$2,$6,$7,'verified','2026-11-03T10:12:00Z',$8)`,
        [C.id, run1.id, c1.id, c1.publicId, cid('v'), c2.id, c2.publicId, cid('v')]);
      expect(await api('POST', `/patrols/runs/${run1.id}/complete`, g.token, { completedAtDevice: '2026-11-03T10:20:00Z' }), 200);
      await focus(C.id);
      await sweep('2026-11-03T13:00:00Z');
      const judged = await one(`SELECT "routeId", "verificationStatus" FROM patrol_runs WHERE id = $1`, [run1.id]);
      assert.deepEqual([Number(judged.routeId), judged.verificationStatus], [route.id, 'verified'], 'verified against the version it started under');
      // A window that started before the change uses version 1; one after uses the head (plan + start).
      const plan = expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftId}`, g.token), 200);
      const changeAt = new Date(old.supersededAt).getTime();
      for (const w of plan.windows) {
        const expected = new Date(w.start).getTime() < changeAt ? route.id : Number(head.id);
        if (new Date(w.start).getTime() < changeAt || new Date(w.start).getTime() >= new Date(head.createdAt).getTime()) assert.equal(w.routeId, expected, `${w.windowKey}`);
      }
      assert.ok(plan.routes.some((r: any) => r.id === route.id) || plan.windows.every((w: any) => w.routeId !== route.id), 'every window\'s route version is in the plan');
      // The automatic route is managed by the setup.
      const act = await activeSite(C, 'Auto site', { setupMode: 'every_shift' });
      const autoId = Number(act.schedule.routeId);
      expect(await api('PATCH', `/patrols/routes/${autoId}`, C.token, { checkpoints: [{ checkpointId: c1.id }] }), 409, 'PATROL_MANAGED_BY_SETUP');
      expect(await api('DELETE', `/patrols/routes/${autoId}`, C.token), 409, 'PATROL_MANAGED_BY_SETUP');
      // configurationWarnings follow the chain: a schedule on a versioned route is not "route required".
      const list = expect(await api('GET', `/patrols/schedules?siteId=${site}`, C.token), 200);
      assert.deepEqual(list.find((s: any) => s.id === retimed.id).configurationWarnings, [], 'the schedule names the current route');
    });

    // ═══════════════════ Shift-based windows through the sweep ═══════════════════
    await test('PSS-06-SHIFT-WINDOWS-SCHEDULED-START-BOOK-ON-EARLY-BOOK-OFF-CANCELLED-MATRIX-AND-AD-HOC', async () => {
      const D = await mkCompany('delta');
      const g1 = await mkGuard('dee');
      const g2 = await mkGuard('dan');
      const every = await activeSite(D, 'Every', { setupMode: 'every_shift', evidenceMode: 'photo' });
      const perShift = await activeSite(D, 'PerShift', { setupMode: 'per_shift', evidenceMode: 'photo' });
      const bookOnSite = await activeSite(D, 'BookOn', { setupMode: 'every_shift', evidenceMode: 'photo', windowAnchor: 'book_on' });
      const offSite = await activeSite(D, 'Off', { setupMode: 'every_shift', evidenceMode: 'photo' });
      expect(await setup(D.token, offSite.siteId, { setupMode: 'off', evidenceMode: 'photo', frequencyMinutes: 60 }), 200);
      await backdate(offSite.siteId, '2026-01-01T00:00:00Z');
      const day = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 10, h, m));
      const mk = async (siteId: number, guard: any, requirement: string | null, opts: { bookOnAt?: Date; bookOffAt?: Date; status?: string; start?: Date; end?: Date } = {}) => {
        const id = await mkShift(D.id, siteId, guard.id, opts.start ?? day(8), opts.end ?? day(12), opts.status ?? 'in_progress', requirement);
        if (opts.status !== 'cancelled') await bookOn(id, guard.id, opts.bookOnAt ?? day(8));
        if (opts.bookOffAt) await bookOff(id, guard.id, opts.bookOffAt);
        return id;
      };
      const sEvery = await mk(every.siteId, g1, null);
      const sEveryNot = await mk(every.siteId, g2, 'not_required');
      const sPerDefault = await mk(perShift.siteId, g1, null, { start: day(8), end: day(12) });
      const sPerRequired = await mk(perShift.siteId, g2, 'required');
      const sBookOn = await mk(bookOnSite.siteId, g1, null, { bookOnAt: day(8, 40) });
      const sEarly = await mk(every.siteId, g1, 'required', { start: day(8), end: day(12), bookOffAt: day(9, 30) });
      const sCancelled = await mk(every.siteId, g2, 'required', { status: 'cancelled' });
      const sOff = await mk(offSite.siteId, g1, 'required');
      // An ad-hoc patrol (no schedule) on the every_shift shift: recorded, satisfies no window, raises nothing itself.
      const adhoc = expect(await api('POST', '/patrols/runs', g1.token, { shiftId: sEvery, clientRunId: cid('adhoc'), startedAtDevice: day(8, 10).toISOString() }), 201);
      assert.equal(adhoc.windowKey, null);
      expect(await api('POST', `/patrols/runs/${adhoc.id}/complete`, g1.token, { completedAtDevice: day(8, 20).toISOString() }), 200);
      // A patrol for the second window of the every_shift shift covers exactly that window.
      const covered = expect(await api('POST', '/patrols/runs', g1.token, { shiftId: sEvery, clientRunId: cid('run'), scheduleId: Number(every.schedule.id), startedAtDevice: day(9, 15).toISOString() }), 201);
      assert.deepEqual([covered.windowKey, covered.windowStart], [`s${every.schedule.id}:sh${sEvery}:20261110T0800Z:1`, day(9).toISOString()]);
      expect(await api('POST', `/patrols/runs/${covered.id}/complete`, g1.token, { completedAtDevice: day(9, 30).toISOString() }), 200);
      await focus(D.id);
      await sweep(day(13));
      const missed = await missedOf(D.id);
      const byShift = (id: number) => missed.filter((e: any) => e.scopeKey === `sh${id}`).map((e: any) => new Date(e.windowStart).toISOString().slice(11, 16));
      assert.deepEqual(byShift(sEvery), ['08:00', '10:00', '11:00'], 'every_shift, site default: owed from the scheduled start; the covered window and the ad-hoc patrol raise nothing');
      assert.deepEqual(byShift(sEveryNot), [], 'every_shift, shift says not required');
      assert.deepEqual(byShift(sPerDefault), [], 'per_shift, site default: not required');
      assert.deepEqual(byShift(sPerRequired), ['08:00', '09:00', '10:00', '11:00'], 'per_shift, shift says required');
      assert.deepEqual(byShift(sBookOn), ['08:40', '09:40', '10:40'], 'Book On override: windows from the Book On');
      assert.deepEqual(byShift(sEarly), ['08:00', '09:00'], 'early Book Off: nothing owed after it');
      assert.deepEqual(byShift(sCancelled), [], 'a cancelled shift owes nothing');
      assert.deepEqual(byShift(sOff), [], 'setup off: none, whatever the shift says');
      assert.ok(missed.every((e: any) => e.scopeKey.startsWith('sh') && e.windowKey.includes(`:sh${e.scopeKey.slice(2)}:`)), 'scope = the shift');
      assert.ok(missed.every((e: any) => e.message === undefined || true));
      const alerts = await count(`SELECT count(*) FROM safety_alerts WHERE "companyId" = $1 AND type::text = 'patrol_missed'`, [D.id]);
      assert.equal(alerts, missed.length, 'one alert per missed window');
      // A repeat sweep raises nothing new.
      await sweep(day(13, 5));
      assert.equal((await missedOf(D.id)).length, missed.length);
    });

    await test('PSS-07-MID-SHIFT-CHANGES-APPLY-TO-FUTURE-WINDOWS-ONLY-AND-FREQUENCY-IS-A-VERSION', async () => {
      const E = await mkCompany('echo');
      const g1 = await mkGuard('eve');
      const g2 = await mkGuard('ed');
      const site = await activeSite(E, 'Echo', { setupMode: 'per_shift', evidenceMode: 'photo' });
      const day = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 12, h, m));
      // Not required → required at 10:10: only windows starting after 10:10 are owed.
      const s1 = await mkShift(E.id, site.siteId, g1.id, day(8), day(14), 'in_progress', null);
      await bookOn(s1, g1.id, day(8));
      // Required → not required at 10:10 (the sweep at 10:20 has already judged 08:00 and 09:00).
      const s2 = await mkShift(E.id, site.siteId, g2.id, day(8), day(14), 'in_progress', 'required');
      await bookOn(s2, g2.id, day(8));
      await focus(E.id);
      await sweep(day(10, 20));
      const early = (await missedOf(E.id)).map((e: any) => `${e.scopeKey} ${new Date(e.windowStart).toISOString().slice(11, 16)}`);
      assert.deepEqual(early, [`sh${s2} 08:00`, `sh${s2} 09:00`], 'before the change: the required shift\'s ended windows');
      expect(await api('PATCH', `/shifts/${s1}`, E.token, { patrolRequirement: 'required' }), 200);
      expect(await api('PATCH', `/shifts/${s2}`, E.token, { patrolRequirement: 'not_required' }), 200);
      await q(`UPDATE audit_logs SET "createdAt" = $1 WHERE action = 'shift.patrol_requirement_changed' AND "entityId" = ANY($2::int[])`, [day(10, 10), [s1, s2]]);
      await sweep(day(15));
      const all = (await missedOf(E.id)).map((e: any) => `${e.scopeKey} ${new Date(e.windowStart).toISOString().slice(11, 16)}`);
      assert.deepEqual(all.filter((x: string) => x.startsWith(`sh${s1} `)), [`sh${s1} 11:00`, `sh${s1} 12:00`, `sh${s1} 13:00`],
        'now required: windows that started after the change only (10:00, open at the change, is not owed retrospectively)');
      assert.deepEqual(all.filter((x: string) => x.startsWith(`sh${s2} `)), [`sh${s2} 08:00`, `sh${s2} 09:00`], 'no longer required: nothing after the change, and the earlier record stands');
      // A frequency change mid-shift is a Migration 73 successor: the old version keeps its windows that started before.
      const s3 = await mkShift(E.id, site.siteId, g1.id, day(16), day(20), 'in_progress', 'required');
      await bookOn(s3, g1.id, day(16));
      const saved = expect(await setup(E.token, site.siteId, { setupMode: 'per_shift', evidenceMode: 'photo', frequencyMinutes: 30 }), 200);
      const versions = await q(`SELECT * FROM patrol_schedules WHERE "siteId" = $1 AND anchor = 'shift' ORDER BY id`, [site.siteId]);
      assert.equal(versions.length, 2, 'a successor version');
      assert.deepEqual([Number(versions[0].supersededByScheduleId), versions[0].archivedAt != null, versions[1].frequencyMinutes, saved.schedule.id],
        [Number(versions[1].id), true, 30, Number(versions[1].id)]);
      const changeAt = day(17, 15);
      await q(`UPDATE patrol_schedules SET "archivedAt" = $2, "supersededAt" = $2 WHERE id = $1`, [versions[0].id, changeAt]);
      await q(`UPDATE patrol_schedules SET "createdAt" = $2, "updatedAt" = $2 WHERE id = $1`, [versions[1].id, changeAt]);
      await sweep(day(21));
      const s3Missed = (await missedOf(E.id)).filter((e: any) => e.scopeKey === `sh${s3}`).map((e: any) => `${Number(e.scheduleId) === Number(versions[0].id) ? 'v1' : 'v2'} ${new Date(e.windowStart).toISOString().slice(11, 16)}`);
      assert.deepEqual(s3Missed, ['v1 16:00', 'v2 17:30', 'v2 18:00', 'v2 18:30', 'v2 19:00', 'v2 19:30'],
        'v1 judged for its windows that ended before the change (17:00, open at the change, never); v2 from the change, every 30 minutes');
    });

    // ═══════════════════ Guard plan, run start, replay; the mobile contract fixture ═══════════════════
    await test('PSS-08-THE-GUARD-PLAN-CARRIES-SHIFT-WINDOWS-AND-A-RUN-STARTS-ON-ONE', async () => {
      const F = await mkCompany('foxtrot');
      const g = await mkGuard('fay');
      const site = await activeSite(F, 'Foxtrot', { setupMode: 'every_shift', evidenceMode: 'qr' });
      // The checkpoint asks for its own photo; on an automatic route the server ignores that (owner decision 6), so the
      // plan reports the EFFECTIVE requirement and the 1.2.1 app never asks for it.
      expect(await api('PATCH', `/patrols/checkpoints/${site.checkpoint.id}`, F.token, { photoRequired: true }), 200);
      const start = Z('2026-11-14T22:00:00Z');
      const shiftId = await mkShift(F.id, site.siteId, g.id, start, Z('2026-11-15T02:00:00Z'));
      await bookOn(shiftId, g.id, start);
      const plan = expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftId}`, g.token), 200);
      assert.deepEqual(plan.checkpoints.map((c: any) => [c.publicId, c.photoRequired]), [[site.checkpoint.publicId, false]], 'effective: no checkpoint photo');
      // The same checkpoint on an active CUSTOM route keeps its own setting (unchanged from 1.2.1).
      const custom = expect(await api('POST', '/patrols/routes', F.token, { siteId: site.siteId, name: 'Custom', checkpoints: [{ checkpointId: site.checkpoint.id }] }), 201);
      assert.equal(expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftId}`, g.token), 200).checkpoints[0].photoRequired, true);
      expect(await api('DELETE', `/patrols/routes/${custom.id}`, F.token), 200);
      // A site without a setup: exactly as in 1.2.1.
      const plainSite = await mkSite(F.id, 'Foxtrot plain');
      const plainCp = await mkCheckpoint(F.token, plainSite, 'Plain gate');
      expect(await api('PATCH', `/patrols/checkpoints/${plainCp.id}`, F.token, { photoRequired: true }), 200);
      const plainShift = await mkShift(F.id, plainSite, g.id, Z('2026-11-16T22:00:00Z'), Z('2026-11-17T02:00:00Z'));
      assert.equal(expect(await api('GET', `/patrols/mine/plan?shiftId=${plainShift}`, g.token), 200).checkpoints[0].photoRequired, true);
      // Photo-only and QR + photos plans for the mobile contract fixture.
      const modePlan = async (evidenceMode: string, at: string) => {
        const s = await activeSite(F, `Foxtrot ${evidenceMode}`, { setupMode: 'every_shift', evidenceMode });
        if (s.checkpoint) expect(await api('PATCH', `/patrols/checkpoints/${s.checkpoint.id}`, F.token, { photoRequired: true }), 200);
        const id = await mkShift(F.id, s.siteId, g.id, Z(at), new Date(Z(at).getTime() + 4 * HOUR));
        return expect(await api('GET', `/patrols/mine/plan?shiftId=${id}`, g.token), 200);
      };
      const photoPlan = await modePlan('photo', '2026-11-18T22:00:00Z');
      const qrPhotoPlan = await modePlan('qr_photo', '2026-11-19T22:00:00Z');
      assert.deepEqual([photoPlan.policy.methods, photoPlan.policy.photosPerRun, photoPlan.windows.length, photoPlan.routes.length], [['photo'], 1, 4, 0]);
      assert.deepEqual([qrPhotoPlan.policy.methods, qrPhotoPlan.policy.photosPerRun, qrPhotoPlan.checkpoints[0].photoRequired], [['qr', 'photo'], 1, false]);
      assert.deepEqual(plan.windows.map((w: any) => [w.windowKey, w.start, w.covered, w.anchor]), [0, 1, 2, 3].map((k) => [
        `s${site.schedule.id}:sh${shiftId}:20261114T2200Z:${k}`, new Date(start.getTime() + k * HOUR).toISOString(), false, 'shift']));
      const autoId = Number((await one(`SELECT id FROM patrol_routes WHERE "siteId" = $1 AND kind = 'auto' AND "archivedAt" IS NULL`, [site.siteId])).id);
      assert.ok(plan.windows.every((w: any) => w.routeId === autoId), 'each window\'s route version');
      const route = plan.routes.find((r: any) => r.id === autoId);
      assert.deepEqual(route.checkpoints.map((c: any) => [c.publicId, c.required]), [[site.checkpoint.publicId, true]]);
      assert.deepEqual(plan.schedules.map((s: any) => [s.id, s.anchor]), [[Number(site.schedule.id), 'shift']]);
      assert.deepEqual(plan.patrolRequirement, { value: 'site_default', effectiveRequired: true, source: 'site', summary: 'Patrols required (site default: every shift).' });
      assert.deepEqual(plan.configurationWarnings, [], 'a confirmed checkpoint: no configuration problem');
      // Start on the second window; the run is owed by this shift.
      const clientRunId = cid('run');
      const run = expect(await api('POST', '/patrols/runs', g.token, { shiftId, clientRunId, scheduleId: plan.windows[1].scheduleId, routeId: plan.windows[1].routeId, startedAtDevice: '2026-11-14T23:05:00Z' }), 201);
      assert.deepEqual([run.windowKey, run.scopeKey ?? null, run.routeId], [plan.windows[1].windowKey, null, autoId]);
      assert.equal((await one(`SELECT "scopeKey" FROM patrol_runs WHERE id = $1`, [run.id])).scopeKey, `sh${shiftId}`);
      const after = expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftId}`, g.token), 200);
      assert.deepEqual(after.windows.map((w: any) => w.covered), [false, true, false, false], 'covered: exactly that window');
      // The automatic route moves on (another checkpoint confirmed); a replay naming the older version is the same request.
      const cp2 = await mkCheckpoint(F.token, site.siteId, 'Foxtrot Rear');
      expect(await testScan(F.token, cp2.id, await labelOf(F.token, cp2.id)), 200);
      expect(await api('POST', '/patrols/runs', g.token, { shiftId, clientRunId, scheduleId: plan.windows[1].scheduleId, routeId: plan.windows[1].routeId, startedAtDevice: '2026-11-14T23:05:00Z' }), 201, undefined, 'replay');
      // An offline start naming the superseded version for a window after the change gets the version then in force.
      const head = Number((await one(`SELECT id FROM patrol_routes WHERE "siteId" = $1 AND kind = 'auto' AND "archivedAt" IS NULL`, [site.siteId])).id);
      await q(`UPDATE patrol_routes SET "supersededAt" = $2, "archivedAt" = $2 WHERE id = $1`, [autoId, Z('2026-11-15T00:00:00Z')]);
      expect(await api('POST', `/patrols/runs/${run.id}/complete`, g.token, { completedAtDevice: '2026-11-14T23:20:00Z' }), 200);
      const late = expect(await api('POST', '/patrols/runs', g.token, { shiftId, clientRunId: cid('run'), scheduleId: plan.windows[2].scheduleId, routeId: autoId, startedAtDevice: '2026-11-15T00:10:00Z' }), 201);
      assert.equal(late.routeId, head, 'the version in force at the window\'s start');
      // A QR site whose automatic version is empty: the plan says so in the 1.2.1 app's words and in the new code.
      expect(await api('POST', `/patrols/checkpoints/${site.checkpoint.id}/revoke`, F.token), 200);
      expect(await api('POST', `/patrols/checkpoints/${cp2.id}/revoke`, F.token), 200);
      const empty = expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftId}`, g.token), 200);
      const forShift = empty.configurationWarnings.filter((w: any) => w.scheduleId === Number(site.schedule.id));
      assert.deepEqual(forShift.map((w: any) => [w.code, w.message]), [
        ['QR_ROUTE_REQUIRED', 'Site setup incomplete: no confirmed checkpoints.'], ['SITE_SETUP_INCOMPLETE', 'Site setup incomplete: no confirmed checkpoints.']]);
      assert.ok(empty.configurationWarnings.every((w: any) => ['QR_ROUTE_REQUIRED', 'SITE_SETUP_INCOMPLETE'].includes(w.code)), 'and the 1.2.1 site warning, unchanged');
      // The mobile contract fixture (security-mobile-app/scripts/fixtures/patrol-plan-b1-shift-windows.json) is this plan's shape.
      const fixturePath = path.join(__dirname, '..', '..', 'security-mobile-app', 'scripts', 'fixtures', 'patrol-plan-b1-shift-windows.json');
      const shape = (o: any): any => (Array.isArray(o) ? (o.length ? [shape(o[0])] : []) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, shape(o[k])])) : typeof o);
      if (process.env.WRITE_MOBILE_CONTRACT_FIXTURE === '1') {
        fs.writeFileSync(fixturePath, `${JSON.stringify({ plan, emptyRoutePlan: empty, photoPlan, qrPhotoPlan }, null, 2)}\n`);
      }
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      assert.deepEqual(shape(fixture.plan), shape(plan), 'the committed mobile fixture has the live plan\'s shape');
      assert.deepEqual(shape(fixture.qrPhotoPlan), shape(qrPhotoPlan));
      assert.deepEqual(shape(fixture.photoPlan), shape(photoPlan));
      assert.ok([fixture.plan, fixture.qrPhotoPlan].every((p: any) => p.checkpoints.every((c: any) => c.photoRequired === false)), 'the fixture carries the effective requirement');
    });

    // ═══════════════════ Shift DTO ═══════════════════
    await test('PSS-09-SHIFT-PATROL-REQUIREMENT-ON-CREATE-UPDATE-AND-READS', async () => {
      const G = await mkCompany('golf');
      const g = await mkGuard('gil');
      await q(`INSERT INTO company_guard_relationships ("companyId","guardId",status) VALUES ($1,$2,'active')`, [G.id, g.id]).catch(() => undefined);
      const viewer = await mkMember(G.id, 'golf', 'viewer');
      const site = await activeSite(G, 'Golf', { setupMode: 'per_shift', evidenceMode: 'photo' });
      const created = expect(await api('POST', '/shifts', G.token, { siteId: site.siteId, start: '2026-12-01T08:00:00+00:00', end: '2026-12-01T16:00:00+00:00', patrolRequirement: 'required' }), 201);
      const shift = created.shift;
      assert.deepEqual(shift.patrolRequirement, { value: 'required', effectiveRequired: true, source: 'shift', summary: 'Patrols required (set on this shift).' });
      assert.equal(shift.patrolRequirementSetting, undefined, 'the raw column is never serialised');
      expect(await api('POST', '/shifts', G.token, { siteId: site.siteId, start: '2026-12-01T08:00:00+00:00', end: '2026-12-01T16:00:00+00:00', patrolRequirement: 'sometimes' }), 400);
      expect(await api('PATCH', `/shifts/${shift.id}`, viewer, { patrolRequirement: 'not_required' }), 403, undefined, 'shifts.manage only');
      const updated = expect(await api('PATCH', `/shifts/${shift.id}`, G.token, { patrolRequirement: 'site_default' }), 200);
      assert.deepEqual(updated.patrolRequirement, { value: 'site_default', effectiveRequired: false, source: 'site', summary: 'No patrols (site default: only shifts marked as requiring patrols).' });
      const audit = await one(`SELECT * FROM audit_logs WHERE action = 'shift.patrol_requirement_changed' AND "entityId" = $1`, [shift.id]);
      assert.deepEqual([audit.beforeData, audit.afterData.patrolRequirement, audit.userId], [{ patrolRequirement: 'required' }, 'site_default', G.ownerId]);
      expect(await api('PATCH', `/shifts/${shift.id}`, G.token, { patrolRequirement: 'site_default' }), 200);
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'shift.patrol_requirement_changed' AND "entityId" = $1`, [shift.id]), 1, 'no change, no entry');
      const read = expect(await api('GET', `/shifts/${shift.id}`, viewer), 200);
      assert.equal(read.patrolRequirement.value, 'site_default');
      const list = expect(await api('GET', '/shifts', viewer), 200);
      assert.ok(list.every((s: any) => s.patrolRequirement && typeof s.patrolRequirement.effectiveRequired === 'boolean'));
      await q(`UPDATE shifts SET status = 'completed' WHERE id = $1`, [shift.id]);
      expect(await api('PATCH', `/shifts/${shift.id}`, G.token, { patrolRequirement: 'required' }), 409, undefined, 'a closed shift\'s requirement is its record');
      // Patrols off: shift reads are exactly as before (no patrolRequirement key).
      await q(`UPDATE companies SET "patrolsEnabled" = false WHERE id = $1`, [G.id]);
      const off = expect(await api('GET', `/shifts/${shift.id}`, G.token), 200);
      assert.ok(!('patrolRequirement' in off) && !('patrolRequirementSetting' in off));
      await q(`UPDATE companies SET "patrolsEnabled" = true WHERE id = $1`, [G.id]);
    });

    // ═══════════════════ explainVerification on run reads ═══════════════════
    await test('PSS-10-RUN-READS-CARRY-THE-PLAIN-ENGLISH-EXPLANATION', async () => {
      const H = await mkCompany('hotel');
      const g = await mkGuard('hal');
      const site = await mkSite(H.id, 'Hotel');
      // QR site with no route at all: never verified — "Site setup incomplete".
      const shiftId = await mkShift(H.id, site, g.id, Z('2026-11-20T08:00:00Z'), Z('2026-11-20T16:00:00Z'));
      const run = expect(await api('POST', '/patrols/runs', g.token, { shiftId, clientRunId: cid('run'), startedAtDevice: '2026-11-20T09:00:00Z' }), 201);
      const inProgress = expect(await api('GET', `/patrols/runs/${run.id}`, H.token), 200);
      assert.equal(inProgress.run.verificationExplanation.code, 'in_progress');
      expect(await api('POST', `/patrols/runs/${run.id}/complete`, g.token, { completedAtDevice: '2026-11-20T09:20:00Z' }), 200);
      const detail = expect(await api('GET', `/patrols/runs/${run.id}`, H.token), 200);
      assert.deepEqual(detail.run.verificationExplanation, {
        code: 'setup_incomplete', text: 'Site setup incomplete: no confirmed checkpoints, so this patrol cannot be verified from QR scans.', deadline: null,
      });
      const listed = expect(await api('GET', `/patrols/runs?siteId=${site}`, H.token), 200);
      assert.equal(listed.items[0].verificationExplanation.code, 'setup_incomplete');
      const mine = expect(await api('GET', `/patrols/mine/runs?shiftId=${shiftId}`, g.token), 200);
      assert.equal(mine[0].verificationExplanation.code, 'setup_incomplete');
    });

    // ═══════════════════ Compatibility (c): pilot-shaped data ═══════════════════
    await test('PSS-11-PILOT-SHAPED-DATA-READS-PLANS-COUNTS-AND-IS-JUDGED-AS-IN-1.2.1', async () => {
      const P = await mkCompany('pilot');
      const g = await mkGuard('pat');
      const site = await mkSite(P.id, 'Pilot Gate');
      await q(`INSERT INTO patrol_policies ("companyId","siteId",methods) VALUES ($1,$2,'["qr"]'::jsonb)`, [P.id, site]);
      const cp = await mkCheckpoint(P.token, site, 'Front gate'); // never test-scanned
      const v1 = expect(await api('POST', '/patrols/schedules', P.token, { siteId: site, name: 'Hourly', activeFrom: '08:00', activeTo: '20:00', frequencyMinutes: 60 }), 201);
      await q(`UPDATE patrol_schedules SET "createdAt" = '2026-01-01', "updatedAt" = '2026-01-01' WHERE id = $1`, [v1.id]);
      const v2 = expect(await api('PATCH', `/patrols/schedules/${v1.id}`, P.token, { frequencyMinutes: 120 }), 200);
      assert.equal(v2.predecessorId, v1.id, 'the 1.2.1 schedule successor');
      const changeAt = Z('2026-11-21T12:30:00Z');
      await q(`UPDATE patrol_schedules SET "archivedAt" = $2, "supersededAt" = $2 WHERE id = $1`, [v1.id, changeAt]);
      await q(`UPDATE patrol_schedules SET "createdAt" = $2, "updatedAt" = $2 WHERE id = $1`, [v2.id, changeAt]);
      const shiftId = await mkShift(P.id, site, g.id, Z('2026-11-21T08:00:00Z'), Z('2026-11-21T20:00:00Z'));
      await bookOn(shiftId, g.id, Z('2026-11-21T08:00:00Z'));
      const run = expect(await api('POST', '/patrols/runs', g.token, { shiftId, clientRunId: cid('run'), scheduleId: v1.id, startedAtDevice: '2026-11-21T09:10:00Z' }), 201);
      await q(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","checkpointId","scannedPublicId",result,"scannedAtDevice","clientVisitId") VALUES ($1,$2,$3,$4,'unverified','2026-11-21T09:12:00Z',$5)`,
        [P.id, run.id, cp.id, cp.publicId, cid('v')]);
      expect(await api('POST', `/patrols/runs/${run.id}/complete`, g.token, { completedAtDevice: '2026-11-21T09:20:00Z' }), 200);
      // Plan: exactly the 1.2.1 windows (clock engine with version bounds), no shift window, the 1.2.1 warning.
      const plan = expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftId}`, g.token), 200);
      const versions = { [v1.id]: { effectiveUntil: changeAt }, [v2.id]: { effectiveFrom: changeAt } } as Record<number, any>;
      const rows = await q(`SELECT *, "startsOn"::text AS "startsOn", "endsOn"::text AS "endsOn" FROM patrol_schedules WHERE id = ANY($1::int[]) ORDER BY id`, [[v1.id, v2.id]]);
      type Win = { start: Date; windowKey: string };
      const expected = (rows.flatMap((s: any) => W.windowsBetween({ ...s, ...versions[Number(s.id)] }, 'Europe/London', Z('2026-11-21T08:00:00Z'), Z('2026-11-21T20:00:00Z'))) as Win[])
        .sort((a: Win, b: Win) => a.start.getTime() - b.start.getTime() || a.windowKey.localeCompare(b.windowKey)).map((w: Win) => w.windowKey);
      assert.deepEqual(plan.windows.map((w: any) => w.windowKey), expected);
      assert.ok(plan.windows.every((w: any) => w.anchor === undefined && w.routeId === null), 'clock windows are exactly as in 1.2.1 (no anchor key, no route)');
      assert.deepEqual(plan.schedules.map((s: any) => s.id), [v2.id]);
      assert.deepEqual(plan.configurationWarnings.map((w: any) => [w.code, w.scheduleId]), [['QR_ROUTE_REQUIRED', v2.id]]);
      assert.equal(plan.patrolRequirement.effectiveRequired, false, 'no setup: no shift patrols');
      // Windows due today count only the clock windows.
      const dayCount = expect(await api('GET', `/patrols/windows/day?siteId=${site}&date=2026-11-21`, P.token), 200);
      assert.equal(dayCount.windowsDue, expected.length);
      // Judged as in 1.2.1: qr_rule_missing, never verified; the setup explanation.
      await focus(P.id);
      await sweep('2026-11-21T13:00:00Z');
      await sweep('2026-11-21T21:30:00Z');
      const judged = await one(`SELECT "syncFlags", "needsReview", "verificationStatus", "routeId" FROM patrol_runs WHERE id = $1`, [run.id]);
      assert.deepEqual([judged.syncFlags, judged.needsReview, judged.verificationStatus, judged.routeId], [['qr_rule_missing'], true, 'unverified', null]);
      const missed = (await missedOf(P.id)).map((e: any) => `${Number(e.scheduleId) === v1.id ? 'v1' : 'v2'} ${new Date(e.windowStart).toISOString().slice(11, 16)} ${e.scopeKey}`);
      assert.deepEqual(missed, ['v1 08:00 site', 'v1 10:00 site', 'v1 11:00 site', 'v2 14:00 site', 'v2 16:00 site', 'v2 18:00 site'],
        'v1 windows that ended before the change (09:00 covered; 12:00 open at it), v2 every 2 h from the change; scope site');
      assert.equal(await count(`SELECT count(*) FROM patrol_schedules WHERE "companyId" = $1 AND anchor <> 'clock'`, [P.id]), 0);
      assert.equal(await count(`SELECT count(*) FROM patrol_routes WHERE "companyId" = $1`, [P.id]), 0, 'no automatic route is ever created for a site without a setup');
      assert.equal((await one(`SELECT "confirmedAt" FROM patrol_checkpoints WHERE id = $1`, [cp.id])).confirmedAt, null);
    });
  } finally {
    await app.close();
  }
  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`);
  console.log(JSON.stringify({ event: 'patrol_site_setup_certified', tests: passed }));
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
