/**
 * Patrol Management P1-A (Migration 68) certification: the whole application over HTTP, on a disposable database built
 * from the repository's own migrations. The application is booted twice: once on the database at Migration 67 (the
 * "before" baseline of existing responses) and once after Migration 68 has been applied.
 *
 *   PF-01  switch off after the migration: a sample of existing responses (company, sites, shifts, attendance, the
 *          session) is byte-identical to the same responses before the migration
 *   PF-02  switch off: every company patrol route and every Guard patrol route answers 404 PATROLS_NOT_ENABLED
 *   PF-03  the switch: only an S4 platform admin changes it (audited once per change, 404 for an unknown company);
 *          existing responses stay identical with it on; the session gains exactly the role's patrols.* permissions
 *   PF-04  policy defaults are exactly the owner-approved ones; sites inherit the company default
 *   PF-05  policies: company default and per-site PUT (audited); 90-day retention only by Owner / Admin
 *          (PATROL_RETENTION_REQUIRES_OWNER_ADMIN), other edits by Operations allowed; validation
 *   PF-06  location verification disabled: enabling proximity, checkpoint coordinates and any Guard location field
 *          are refused with PATROL_LOCATION_VERIFICATION_DISABLED and nothing is written
 *   PF-07  schedules: frequency 15–1440, window ≤ frequency, site-local HH:mm, days of week; update, archive; audited
 *   PF-08  checkpoints: 128-bit random publicId, update, rotate (tokenVersion + 1), revoke (idempotent, final); audited
 *   PF-09  routes: ordered same-site checkpoints; cross-site (422), duplicate (422), revoked (422), another company's
 *          checkpoint (404); reorder; archive; schedule with another site's route refused
 *   PF-10  tenant isolation: company B gets 404 on every company A patrol resource and sees none in lists
 *   PF-11  permission matrix: every membership role × view / manage / evidence / holds; legacy owner; suspended member;
 *          Guard and platform admin refused on company routes; evidence metadata hidden from a Viewer
 *   PF-12  the Guard plan: own shift only (another Guard's / company's shift 404), publicIds and labels, never secrets
 *   PF-13  the Guard run lifecycle: start, scan, complete / incomplete; shift must be in progress; one open run
 *   PF-14  idempotent replay of every Guard write (same row, one DB row), also after the shift has ended; a NEW run after
 *          the shift ended is accepted only as P1-B's provisional, flagged post-shift creation (patrol-schedule.spec.ts)
 *   PF-15  concurrent duplicates (Promise.all) resolve to one row for start, scan and complete
 *   PF-16  same client id, different content → 409 PATROL_IDEMPOTENCY_CONFLICT; ids are per company
 *   PF-17  QR: valid label verified; tampered MAC, rotated (old) label, unknown publicId, another company's label,
 *          revoked checkpoint, wrong site, duplicate, malformed payload flagged (audited); publicId alone unverified;
 *          no server key → labels refused (503) and scans unverified
 *   PF-18  company reads: runs list (filters, pagination), run detail (visits, exceptions, evidence metadata), overview
 *   PF-19  switching off again hides everything at once and deletes nothing
 *
 * Needs PATROL_FOUNDATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

const url = process.env.PATROL_FOUNDATION_DATABASE_URL;
if (!url) throw new Error('PATROL_FOUNDATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Patrol foundation database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-foundation-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.RESEND_API_KEY;
delete process.env.EXPO_ACCESS_TOKEN;
delete process.env.PUSH_WELFARE_REMINDERS_ENABLED;
delete process.env.PUSH_GUARD_NOTIFICATIONS_ENABLED;
const SIGNING_KEY = 'patrol-foundation-spec-only-signing-key-0123456789';
const setKey = () => {
  process.env.PATROL_QR_SIGNING_KEY = SIGNING_KEY;
  process.env.PATROL_QR_SIGNING_KEY_ID = 't1';
};
delete process.env.PATROL_QR_PREVIOUS_SIGNING_KEY;
setKey();

let passed = 0;
const failures: string[] = [];
const test = async (id: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failures.push(id);
    console.log(`FAIL  ${id}\n      ${String((error as Error)?.stack ?? error).split('\n').slice(0, 8).join('\n      ')}`);
  }
};

type Res = { status: number; body: any };
const PASSWORD = 'patrol-foundation-spec-only-password-1';
const iso = (ms = Date.now()) => new Date(ms).toISOString();
let clientSeq = 0;
const cid = (p: string) => `${p}-${Date.now().toString(36)}-${(++clientSeq).toString().padStart(4, '0')}`;

async function main() {
  const path = require('node:path');
  const fs = require('node:fs');
  const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
  const allFiles: string[] = fs.readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).sort();
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const base = buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' });

  // ── Database at Migration 67 (before Patrols) ───────────────────────────────────────────────────────────────
  const to67 = new DataSource({
    ...base,
    entities: [],
    migrations: allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000013).map((f) => path.join(migrationsDir, f)),
    dropSchema: true,
  } as never);
  await to67.initialize();
  const at67 = await to67.runMigrations({ transaction: 'each' });
  assert.equal(at67[at67.length - 1]?.name, 'AddManualAttendance1720900000013');
  const hash = await bcrypt.hash(PASSWORD, 4);
  const one = async (sql: string, params: unknown[] = []) => (await to67.query(sql, params))[0];
  const mkUser = async (email: string, role: string) =>
    (await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
       VALUES ($1,$2,$3,'active',true,false,$4,'Spec') RETURNING id`, [email, hash, role, email.split('@')[0]])).id as number;
  const mkCompany = async (label: string, number: string) => {
    const ownerEmail = `${label}.owner@example.invalid`;
    const ownerId = await mkUser(ownerEmail, 'company_admin');
    const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,$2,$3,'1 Way','ops@example.invalid') RETURNING id`,
      [ownerId, `${label} Security Ltd`, number]);
    const site = async (name: string) => (await one(`INSERT INTO sites ("companyId",name,address,timezone) VALUES ($1,$2,'3 Quay','Europe/London') RETURNING id`, [id, name])).id as number;
    return { id: id as number, ownerId, ownerEmail, site1: await site(`${label} North Gate`), site2: await site(`${label} South Yard`) };
  };
  const A0 = await mkCompany('pfalpha', '68111111');
  const B0 = await mkCompany('pfbeta', '68222222');
  const memberEmails: Record<string, string> = {};
  for (const role of ['owner', 'admin', 'operations', 'control_room', 'viewer', 'finance', 'hr_compliance']) {
    const email = `pf.${role}@example.invalid`;
    const id = await mkUser(email, 'company_admin');
    await to67.query(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [id, A0.id, role]);
    memberEmails[role] = email;
  }
  const suspendedId = await mkUser('pf.suspended@example.invalid', 'company_admin');
  await to67.query(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,'operations','suspended')`, [suspendedId, A0.id]);
  await mkUser('pf.platform@example.invalid', 'admin');
  const mkGuard = async (label: string, n: number) => {
    const email = `pf.${label}@example.invalid`;
    const userId = await mkUser(email, 'guard');
    const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, `Guard ${label}`, `680000000000000${n}`, `0771068000${n}`]);
    return { id: id as number, userId, email };
  };
  const gA0 = await mkGuard('guarda', 1);
  const gA20 = await mkGuard('guarda2', 2);
  const gB0 = await mkGuard('guardb', 3);
  const mkShift = async (co: number, site: number, guardId: number, status: string) =>
    (await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Gate',$3,$4,now() - interval '1 hour',now() + interval '7 hours') RETURNING id`,
      [co, site, guardId, status])).id as number;
  const shiftA = await mkShift(A0.id, A0.site1, gA0.id, 'in_progress');
  const shiftAReady = await mkShift(A0.id, A0.site1, gA0.id, 'ready');
  const shiftA2 = await mkShift(A0.id, A0.site1, gA20.id, 'in_progress');
  const shiftASite2 = await mkShift(A0.id, A0.site2, gA20.id, 'ready');
  const shiftB = await mkShift(B0.id, B0.site1, gB0.id, 'in_progress');
  await to67.query(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","gpsVerified") VALUES ($1,$2,'check-in',now() - interval '1 hour',false)`, [shiftA, gA0.id]);
  await to67.destroy();

  // ── Boot helper ────────────────────────────────────────────────────────────────────────────────────────────
  const boot = async () => {
    const { AppModule } = await import('../src/app.module');
    const app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const ds = app.get(DataSource);
    const [{ current_database: db }] = await ds.query('SELECT current_database()');
    if (db !== new URL(url!).pathname.slice(1)) throw new Error(`Refusing: connected to ${db}`);
    // The P1-B patrol sweep's five-minute timer is stopped: these P1-A assertions count stored rows exactly, and the
    // sweep is certified on its own clock by patrol-schedule.spec.ts.
    const { PatrolSweepService } = await import('../src/patrol/patrol-sweep.service');
    app.get(PatrolSweepService).onModuleDestroy();
    const { AuthService } = await import('../src/auth/auth.service');
    return { app, ds, base: `http://127.0.0.1:${address.port}`, auth: app.get(AuthService) };
  };
  let ctx = await boot();
  const api = async (method: string, p: string, tok: string | null, body?: unknown): Promise<Res> => {
    const res = await fetch(ctx.base + p, {
      method,
      headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };
  const login = async (email: string) => ((await ctx.auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;
  const expect = (r: Res, status: number, code?: string, what = '') => {
    assert.equal(r.status, status, `${what} expected ${status}${code ? ` ${code}` : ''}, got ${r.status} ${JSON.stringify(r.body)}`);
    if (code) assert.equal(r.body?.code, code, `${what} code: ${JSON.stringify(r.body)}`);
  };

  /** A sample of EXISTING responses, compared before / after the migration and with the switch on. */
  const existingResponses = async (tokens: Record<string, string>) => {
    const out: Record<string, unknown> = {};
    for (const [who, tok] of Object.entries(tokens)) {
      for (const p of ['/companies/me', '/sites', '/shifts', '/attendance/company', '/auth/me', '/shifts/my']) {
        const r = await api('GET', p, tok);
        out[`${who} ${p}`] = { status: r.status, body: r.body };
      }
    }
    return out;
  };

  let tokens: Record<string, string> = {};
  // Every account signs in ONCE, before the baseline: a later sign-in would move users.lastLoginAt, which existing
  // responses embed. The same tokens are used after the second boot (same JWT secret).
  const loginAll = async () => {
    tokens = { ownerLegacy: await login(A0.ownerEmail), ownerB: await login(B0.ownerEmail), guardA: await login(gA0.email) };
    for (const [role, email] of Object.entries(memberEmails)) tokens[role] = await login(email);
    tokens.platform = await login('pf.platform@example.invalid');
    tokens.guardA2 = await login(gA20.email);
    tokens.guardB = await login(gB0.email);
    tokens.suspended = '';
    try { tokens.suspended = await login('pf.suspended@example.invalid'); } catch { tokens.suspended = ''; }
  };
  await loginAll();
  const before = await existingResponses({ ownerLegacy: tokens.ownerLegacy, viewer: tokens.viewer, operations: tokens.operations, guardA: tokens.guardA });
  await ctx.app.close();

  // ── Migrations 68 and 69 and the second boot ────────────────────────────────────────────────────────────────
  const to68 = new DataSource({ ...base, entities: [], migrations: allFiles.map((f) => path.join(migrationsDir, f)) } as never);
  await to68.initialize();
  const migrated = await to68.runMigrations({ transaction: 'each' });
  assert.deepEqual(migrated.map((m) => m.name), ['AddPatrolManagement1720900000014', 'AddPatrolScheduling1720900000015'],
    'only Migrations 68 (P1-A) and 69 (P1-B scheduling) apply');
  await to68.destroy();
  ctx = await boot();
  const q = async (sql: string, params: unknown[] = []) => ctx.ds.query(sql, params);
  const scalar = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0];

  try {
    const { PATROL_POLICY_DEFAULTS } = await import('../src/patrol/patrol-constants');
    const { CompanyMembershipRole, CompanyPermission, hasPermission, PATROL_PERMISSIONS } = await import('../src/company-membership/company-membership-types');
    const { signCheckpointLabel, patrolQrKeyring } = await import('../src/patrol/patrol-qr');
    const tA = tokens.ownerLegacy;
    const tB = tokens.ownerB;
    const gA = { ...gA0, token: tokens.guardA };
    const gA2 = { ...gA20, token: tokens.guardA2 };
    const gB = { ...gB0, token: tokens.guardB };
    const A = A0;
    const B = B0;
    const setSwitch = (companyId: number, on: boolean) => api('PUT', `/admin/patrols/companies/${companyId}`, tokens.platform, { patrolsEnabled: on });

    const companyRoutes = (ids: { schedule: number; checkpoint: number; route: number; run: number; site: number }) => [
      ['GET', '/patrols/policies'], ['PUT', '/patrols/policies/default', {}], ['PUT', `/patrols/policies/sites/${ids.site}`, {}],
      ['GET', '/patrols/schedules'], ['GET', `/patrols/schedules/${ids.schedule}`],
      ['POST', '/patrols/schedules', { siteId: ids.site, name: 'x', activeFrom: '08:00', activeTo: '18:00', frequencyMinutes: 60 }],
      ['PATCH', `/patrols/schedules/${ids.schedule}`, { name: 'y' }], ['DELETE', `/patrols/schedules/${ids.schedule}`],
      ['GET', '/patrols/checkpoints'], ['GET', `/patrols/checkpoints/${ids.checkpoint}`], ['POST', '/patrols/checkpoints', { siteId: ids.site, label: 'x' }],
      ['PATCH', `/patrols/checkpoints/${ids.checkpoint}`, { label: 'y' }], ['POST', `/patrols/checkpoints/${ids.checkpoint}/rotate`],
      ['POST', `/patrols/checkpoints/${ids.checkpoint}/revoke`], ['GET', `/patrols/checkpoints/${ids.checkpoint}/label`],
      ['GET', '/patrols/routes'], ['GET', `/patrols/routes/${ids.route}`], ['POST', '/patrols/routes', { siteId: ids.site, name: 'x', checkpoints: [{ checkpointId: ids.checkpoint }] }],
      ['PATCH', `/patrols/routes/${ids.route}`, { name: 'y' }], ['DELETE', `/patrols/routes/${ids.route}`],
      ['GET', '/patrols/overview'], ['GET', '/patrols/runs'], ['GET', `/patrols/runs/${ids.run}`], ['GET', `/patrols/runs/${ids.run}/evidence`], ['GET', '/patrols/holds'],
    ] as Array<[string, string, unknown?]>;
    const guardRoutes = (shiftId: number, runId: number) => [
      ['GET', `/patrols/mine/plan?shiftId=${shiftId}`], ['GET', `/patrols/mine/runs?shiftId=${shiftId}`],
      ['POST', '/patrols/runs', { clientRunId: cid('off'), shiftId, startedAtDevice: iso() }],
      ['POST', `/patrols/runs/${runId}/visits`, { clientVisitId: cid('off'), checkpointPublicId: '0'.repeat(32), scannedAtDevice: iso() }],
      ['POST', `/patrols/runs/${runId}/complete`, { completedAtDevice: iso() }],
    ] as Array<[string, string, unknown?]>;
    const patrolRowCounts = async () => {
      const out: Record<string, number> = {};
      for (const t of ['patrol_policies', 'patrol_schedules', 'patrol_checkpoints', 'patrol_routes', 'patrol_route_checkpoints', 'patrol_runs', 'patrol_checkpoint_visits']) {
        out[t] = Number(await scalar(`SELECT count(*)::int FROM "${t}"`));
      }
      return out;
    };

    // ═══════════════════ switch off ═══════════════════

    await test('PF-01-SWITCH-OFF-EXISTING-RESPONSES-ARE-IDENTICAL-TO-BEFORE-THE-MIGRATION', async () => {
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM companies WHERE "patrolsEnabled"`)), 0, 'every company is off');
      const after = await existingResponses({ ownerLegacy: tA, viewer: tokens.viewer, operations: tokens.operations, guardA: gA.token });
      const differing = Object.keys(before).filter((k) => JSON.stringify((after as any)[k]) !== JSON.stringify((before as any)[k]));
      assert.deepEqual(differing, [], differing.map((k) => `${k}\n before ${JSON.stringify((before as any)[k])}\n after  ${JSON.stringify((after as any)[k])}`).join('\n'));
      assert.deepEqual(after, before, 'GET /companies/me, /sites, /shifts, /attendance/company, /auth/me and /shifts/my are unchanged');
      for (const [k, v] of Object.entries(after)) assert.ok(!JSON.stringify(v).includes('patrol'), `${k} mentions nothing about patrols`);
    });

    await test('PF-02-SWITCH-OFF-EVERY-PATROL-ROUTE-IS-404', async () => {
      const ids = { schedule: 1, checkpoint: 1, route: 1, run: 1, site: A.site1 };
      for (const tok of [tA, tokens.owner, tokens.viewer, tokens.finance]) {
        for (const [method, p, body] of companyRoutes(ids)) expect(await api(method, p, tok, body), 404, 'PATROLS_NOT_ENABLED', `${method} ${p}`);
      }
      for (const [method, p, body] of guardRoutes(shiftA, 1)) {
        const r = await api(method, p, gA.token, body);
        assert.equal(r.status, 404, `${method} ${p}: ${JSON.stringify(r.body)}`);
        assert.ok(['PATROLS_NOT_ENABLED', 'PATROL_NOT_FOUND'].includes(r.body?.code), `${method} ${p}: ${r.body?.code}`);
      }
      expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftA}`, gA.token), 404, 'PATROLS_NOT_ENABLED');
      assert.deepEqual(Object.values(await patrolRowCounts()).reduce((a, b) => a + b, 0), 0, 'nothing written');
    });

    await test('PF-03-THE-SWITCH-IS-PLATFORM-ADMIN-ONLY-AUDITED-AND-CHANGES-NO-EXISTING-RESPONSE', async () => {
      for (const tok of [tA, tokens.owner, gA.token]) expect(await api('PUT', `/admin/patrols/companies/${A.id}`, tok, { patrolsEnabled: true }), 403);
      expect(await api('PUT', `/admin/patrols/companies/999999`, tokens.platform, { patrolsEnabled: true }), 404, 'PATROL_NOT_FOUND');
      expect(await api('PUT', `/admin/patrols/companies/${A.id}`, tokens.platform, { patrolsEnabled: 'yes' }), 400);
      const r = await setSwitch(A.id, true);
      expect(r, 200);
      assert.deepEqual(r.body, { companyId: A.id, patrolsEnabled: true });
      expect(await setSwitch(A.id, true), 200, undefined, 'repeat');
      const audits = await q(`SELECT "userId", "companyId", "beforeData", "afterData" FROM audit_logs WHERE action = 'company.patrols_enabled_changed' ORDER BY id`);
      assert.equal(audits.length, 1, 'one audit entry per actual change');
      assert.deepEqual([audits[0].companyId, audits[0].beforeData, audits[0].afterData], [A.id, { patrolsEnabled: false }, { patrolsEnabled: true }]);
      assert.deepEqual((await api('GET', `/admin/patrols/companies/${A.id}`, tokens.platform)).body, { companyId: A.id, patrolsEnabled: true });
      expect(await setSwitch(B.id, true), 200);

      const after = await existingResponses({ ownerLegacy: tA, viewer: tokens.viewer, operations: tokens.operations, guardA: gA.token });
      const strip = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([k, v]) =>
        [k, k.endsWith('/auth/me') ? { ...v, body: { ...v.body, companyPermissions: undefined } } : v]));
      assert.deepEqual(strip(after), strip(before), 'with the switch on, existing responses are unchanged apart from the session permissions');
      for (const [who, role] of [['ownerLegacy', CompanyMembershipRole.OWNER], ['viewer', CompanyMembershipRole.VIEWER], ['operations', CompanyMembershipRole.OPERATIONS]] as const) {
        const prior = ((before as any)[`${who} /auth/me`].body.companyPermissions ?? []) as string[];
        const now = ((after as any)[`${who} /auth/me`].body.companyPermissions ?? []) as string[];
        assert.deepEqual(now.filter((p) => !prior.includes(p)).sort(), PATROL_PERMISSIONS.filter((p) => hasPermission(role, p)).sort(), `${who}: exactly the role's patrols.* permissions are added`);
        assert.deepEqual(prior.filter((p) => !now.includes(p)), [], `${who}: nothing removed`);
      }
      assert.ok(!JSON.stringify((after as any)['ownerLegacy /companies/me']).includes('patrolsEnabled'), 'the switch is never serialised with the company');
    });

    // ═══════════════════ configuration ═══════════════════

    await test('PF-04-POLICY-DEFAULTS-ARE-EXACTLY-THE-OWNER-APPROVED-ONES', async () => {
      const r = await api('GET', '/patrols/policies', tA);
      expect(r, 200);
      const expected = {
        methods: ['qr'], photosPerRun: 0, photosPerCheckpoint: 0, orderMode: 'any', startGraceMinutes: 15, maxPatrolDurationMinutes: 45,
        completionGraceMinutes: 30, syncGraceMinutes: 60, requirementScope: 'site', retentionDays: 30, incompleteNeedsAction: true,
        // P1-B (Migration 69): offline sync after Book Off, clock drift, unscheduled patrols, unverified escalation.
        postShiftSyncHours: 24, clockDriftThresholdMinutes: 5, allowUnscheduledPatrols: true, escalateUnverified: false,
        qrRequireProximity: false, proximityMeters: null,
      };
      assert.deepEqual({ ...PATROL_POLICY_DEFAULTS }, expected);
      assert.deepEqual(r.body.defaults, expected);
      assert.deepEqual(r.body.companyDefault, { ...expected, source: 'default' });
      assert.deepEqual(r.body.sites.map((s: any) => s.siteId), [A.site1, A.site2]);
      for (const s of r.body.sites) assert.deepEqual(s.policy, { ...expected, source: 'default' });
      assert.equal(r.body.locationVerificationAvailable, false);
      assert.equal(r.body.extendedRetentionAllowed, true);
      assert.equal((await api('GET', '/patrols/policies', tokens.operations)).body.extendedRetentionAllowed, false);
    });

    await test('PF-05-POLICIES-COMPANY-DEFAULT-AND-SITE-AND-90-DAY-RETENTION-ONLY-OWNER-ADMIN', async () => {
      const ops = tokens.operations;
      expect(await api('PUT', `/patrols/policies/sites/${A.site1}`, ops, { retentionDays: 90 }), 403, 'PATROL_RETENTION_REQUIRES_OWNER_ADMIN', 'operations');
      expect(await api('PUT', '/patrols/policies/default', ops, { retentionDays: 90 }), 403, 'PATROL_RETENTION_REQUIRES_OWNER_ADMIN', 'operations');
      expect(await api('PUT', '/patrols/policies/default', tokens.control_room, { startGraceMinutes: 10 }), 403, 'PATROL_FORBIDDEN', 'control room cannot manage');
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM patrol_policies`)), 0, 'nothing written by a refusal');
      const d = await api('PUT', '/patrols/policies/default', tA, { retentionDays: 90, startGraceMinutes: 20 });
      expect(d, 200, undefined, 'legacy owner');
      assert.deepEqual([d.body.policy.retentionDays, d.body.policy.startGraceMinutes, d.body.policy.source], [90, 20, 'company']);
      // A site inherits 90; Operations may change other settings without touching retention.
      const s = await api('PUT', `/patrols/policies/sites/${A.site1}`, ops, { photosPerRun: 2, requirementScope: 'per_guard' });
      expect(s, 200, undefined, 'operations edits a site inheriting 90');
      assert.deepEqual([s.body.policy.retentionDays, s.body.policy.photosPerRun, s.body.policy.requirementScope, s.body.policy.startGraceMinutes], [90, 2, 'per_guard', 20]);
      expect(await api('PUT', `/patrols/policies/sites/${A.site1}`, ops, { retentionDays: 30 }), 200, undefined, 'shortening for new evidence is allowed');
      expect(await api('PUT', `/patrols/policies/sites/${A.site1}`, ops, { retentionDays: 90 }), 403, 'PATROL_RETENTION_REQUIRES_OWNER_ADMIN');
      expect(await api('PUT', `/patrols/policies/sites/${A.site1}`, tokens.admin, { retentionDays: 90 }), 200, undefined, 'admin');
      expect(await api('PUT', `/patrols/policies/sites/${A.site2}`, tokens.owner, { retentionDays: 90 }), 200, undefined, 'membership owner');
      for (const bad of [{ retentionDays: 60 }, { methods: ['gps'] }, { methods: [] }, { requirementScope: 'all' }, { startGraceMinutes: -1 }, { syncGraceMinutes: 1441 }, { unknownField: 1 }]) {
        expect(await api('PUT', '/patrols/policies/default', tA, bad), 400, undefined, JSON.stringify(bad));
      }
      expect(await api('PUT', `/patrols/policies/sites/999999`, tA, {}), 404, 'PATROL_SITE_NOT_FOUND');
      const g = await api('GET', '/patrols/policies', tokens.viewer);
      expect(g, 200);
      assert.deepEqual(g.body.sites.map((x: any) => [x.siteId, x.policy.source, x.policy.retentionDays]), [[A.site1, 'site', 90], [A.site2, 'site', 90]]);
      const audits = await q(`SELECT "userId", "afterData" FROM audit_logs WHERE action = 'patrol.policy.updated' AND "companyId" = $1 ORDER BY id`, [A.id]);
      assert.equal(audits.length, 5, 'every successful policy write is audited');
    });

    await test('PF-06-LOCATION-VERIFICATION-IS-DISABLED-EVERYWHERE', async () => {
      const counts = await patrolRowCounts();
      expect(await api('PUT', '/patrols/policies/default', tA, { qrRequireProximity: true }), 400, 'PATROL_LOCATION_VERIFICATION_DISABLED');
      expect(await api('PUT', `/patrols/policies/sites/${A.site1}`, tA, { proximityMeters: 50 }), 400, 'PATROL_LOCATION_VERIFICATION_DISABLED');
      expect(await api('PUT', '/patrols/policies/default', tA, { qrRequireProximity: false, proximityMeters: null }), 200, undefined, 'explicitly off is fine');
      expect(await api('POST', '/patrols/checkpoints', tA, { siteId: A.site1, label: 'Gate', latitude: 51.5, longitude: -0.1 }), 400, 'PATROL_LOCATION_VERIFICATION_DISABLED');
      expect(await api('POST', '/patrols/checkpoints', tA, { siteId: A.site1, label: 'Gate', proximityMeters: 40 }), 400, 'PATROL_LOCATION_VERIFICATION_DISABLED');
      for (const extra of [{ latitude: 51.5, longitude: -0.1 }, { lat: 1 }, { accuracyMeters: 5 }, { location: { lat: 1, lng: 2 } }]) {
        expect(await api('POST', '/patrols/runs', gA.token, { clientRunId: cid('loc'), shiftId: shiftA, startedAtDevice: iso(), ...extra }), 400,
          'PATROL_LOCATION_VERIFICATION_DISABLED', JSON.stringify(extra));
      }
      const c = await patrolRowCounts();
      assert.deepEqual({ ...c, patrol_policies: counts.patrol_policies }, counts, 'nothing written');
    });

    let schedule: any;
    await test('PF-07-SCHEDULES', async () => {
      const body = { siteId: A.site1, name: 'Night perimeter', activeFrom: '22:00', activeTo: '06:00', frequencyMinutes: 60, daysOfWeek: [5, 1, 3] };
      for (const [bad, code] of [
        [{ frequencyMinutes: 14 }, undefined], [{ frequencyMinutes: 1441 }, undefined], [{ activeFrom: '25:00' }, undefined], [{ activeTo: '6:00' }, undefined],
        [{ daysOfWeek: [0] }, undefined], [{ daysOfWeek: [1, 1] }, undefined], [{ windowMinutes: 61 }, 'PATROL_VALIDATION_FAILED'],
        [{ startsOn: '2026-11-02', endsOn: '2026-11-01' }, 'PATROL_VALIDATION_FAILED'],
      ] as Array<[Record<string, unknown>, string | undefined]>) {
        expect(await api('POST', '/patrols/schedules', tA, { ...body, ...bad }), 400, code, JSON.stringify(bad));
      }
      expect(await api('POST', '/patrols/schedules', tokens.viewer, body), 403, 'PATROL_FORBIDDEN');
      expect(await api('POST', '/patrols/schedules', tA, { ...body, siteId: B.site1 }), 404, 'PATROL_SITE_NOT_FOUND');
      for (const f of [15, 1440]) expect(await api('POST', '/patrols/schedules', tA, { ...body, name: `Edge ${f}`, frequencyMinutes: f }), 201, undefined, `frequency ${f}`);
      const r = await api('POST', '/patrols/schedules', tA, body);
      expect(r, 201);
      schedule = r.body;
      assert.deepEqual([r.body.daysOfWeek, r.body.windowMinutes, r.body.timeBasis, r.body.activeFrom, r.body.activeTo, r.body.active],
        [[1, 3, 5], 60, 'site_local', '22:00', '06:00', true]);
      const p = await api('PATCH', `/patrols/schedules/${schedule.id}`, tokens.operations, { frequencyMinutes: 30 });
      expect(p, 200);
      assert.deepEqual([p.body.frequencyMinutes, p.body.windowMinutes], [30, 30], 'window follows frequency when it was equal');
      expect(await api('PATCH', `/patrols/schedules/${schedule.id}`, tA, { windowMinutes: 31 }), 400, 'PATROL_VALIDATION_FAILED');
      expect(await api('PATCH', `/patrols/schedules/${schedule.id}`, tA, { siteId: A.site2 }), 400, undefined, 'the site of a schedule never changes');
      expect(await api('GET', `/patrols/schedules/${schedule.id}`, tokens.viewer), 200);
      const ls = await api('GET', `/patrols/schedules?siteId=${A.site1}`, tokens.control_room);
      expect(ls, 200);
      assert.equal(ls.body.length, 3);
      const edge = ls.body.find((s: any) => s.name === 'Edge 15');
      const del = await api('DELETE', `/patrols/schedules/${edge.id}`, tA);
      expect(del, 200);
      assert.equal(del.body.active, false);
      assert.ok(del.body.archivedAt);
      expect(await api('DELETE', `/patrols/schedules/${edge.id}`, tA), 200, undefined, 'archiving twice changes nothing');
      expect(await api('PATCH', `/patrols/schedules/${edge.id}`, tA, { name: 'z' }), 409, 'PATROL_VALIDATION_FAILED');
      assert.equal((await api('GET', '/patrols/schedules', tA)).body.length, 2, 'archived schedules are hidden by default');
      assert.equal((await api('GET', '/patrols/schedules?includeInactive=true', tA)).body.length, 3);
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM patrol_schedules`)), 3, 'never deleted');
      const actions = (await q(`SELECT action FROM audit_logs WHERE "entityType" = 'patrol_schedule' ORDER BY id`)).map((a: any) => a.action);
      assert.deepEqual(actions, ['patrol.schedule.created', 'patrol.schedule.created', 'patrol.schedule.created', 'patrol.schedule.updated', 'patrol.schedule.archived']);
    });

    const checkpoints: Record<string, any> = {};
    await test('PF-08-CHECKPOINTS-RANDOM-PUBLIC-ID-ROTATE-AND-REVOKE', async () => {
      for (const [key, site, label] of [['gate', A.site1, 'Main gate'], ['yard', A.site1, 'Yard'], ['fence', A.site1, 'Fence'], ['south', A.site2, 'South door'], ['spare', A.site1, 'Spare']] as const) {
        const r = await api('POST', '/patrols/checkpoints', tA, { siteId: site, label });
        expect(r, 201, undefined, key);
        checkpoints[key] = r.body;
      }
      const bcp = await api('POST', '/patrols/checkpoints', tB, { siteId: B.site1, label: 'B gate' });
      expect(bcp, 201);
      checkpoints.b = bcp.body;
      const ids = Object.values(checkpoints).map((c: any) => c.publicId);
      for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/, '128 bits as 32 hex');
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(checkpoints.gate.tokenVersion, 1);
      expect(await api('POST', '/patrols/checkpoints', tokens.control_room, { siteId: A.site1, label: 'x' }), 403, 'PATROL_FORBIDDEN');
      expect(await api('POST', '/patrols/checkpoints', tA, { siteId: A.site1, label: '' }), 400);
      const u = await api('PATCH', `/patrols/checkpoints/${checkpoints.gate.id}`, tokens.operations, { label: 'Main gate (north)', photoRequired: true });
      expect(u, 200);
      assert.deepEqual([u.body.label, u.body.photoRequired, u.body.publicId], ['Main gate (north)', true, checkpoints.gate.publicId]);
      const rot = await api('POST', `/patrols/checkpoints/${checkpoints.spare.id}/rotate`, tA);
      expect(rot, 200);
      assert.equal(rot.body.tokenVersion, 2);
      const rev = await api('POST', `/patrols/checkpoints/${checkpoints.spare.id}/revoke`, tA);
      expect(rev, 200);
      assert.deepEqual([rev.body.active, Boolean(rev.body.revokedAt)], [false, true]);
      const again = await api('POST', `/patrols/checkpoints/${checkpoints.spare.id}/revoke`, tA);
      assert.deepEqual(again.body, rev.body, 'revoking twice changes nothing');
      expect(await api('POST', `/patrols/checkpoints/${checkpoints.spare.id}/rotate`, tA), 409, 'PATROL_CHECKPOINT_REVOKED');
      expect(await api('PATCH', `/patrols/checkpoints/${checkpoints.spare.id}`, tA, { active: true }), 409, 'PATROL_CHECKPOINT_REVOKED');
      expect(await api('GET', `/patrols/checkpoints/${checkpoints.spare.id}/label`, tA), 409, 'PATROL_CHECKPOINT_REVOKED');
      assert.equal((await api('GET', '/patrols/checkpoints', tokens.viewer)).body.length, 4, 'revoked hidden by default');
      assert.equal((await api('GET', '/patrols/checkpoints?includeInactive=true', tokens.viewer)).body.length, 5);
      const actions = (await q(`SELECT action, "beforeData", "afterData" FROM audit_logs WHERE "entityType" = 'patrol_checkpoint' AND "entityId" = $1 ORDER BY id`, [checkpoints.spare.id]));
      assert.deepEqual(actions.map((a: any) => a.action), ['patrol.checkpoint.created', 'patrol.checkpoint.rotated', 'patrol.checkpoint.revoked']);
      assert.deepEqual([actions[1].beforeData, actions[1].afterData], [{ tokenVersion: 1 }, { tokenVersion: 2 }]);
    });

    let route: any;
    await test('PF-09-ROUTES-SAME-SITE-ORDERED-CHECKPOINTS', async () => {
      const body = (cps: number[]) => ({ siteId: A.site1, name: 'Perimeter', orderMode: 'strict', checkpoints: cps.map((id) => ({ checkpointId: id })) });
      expect(await api('POST', '/patrols/routes', tA, body([checkpoints.gate.id, checkpoints.south.id])), 422, 'PATROL_ROUTE_CHECKPOINT_WRONG_SITE', 'cross-site');
      expect(await api('POST', '/patrols/routes', tA, body([checkpoints.gate.id, checkpoints.gate.id])), 422, 'PATROL_ROUTE_DUPLICATE_CHECKPOINT');
      expect(await api('POST', '/patrols/routes', tA, body([checkpoints.gate.id, checkpoints.spare.id])), 422, 'PATROL_ROUTE_CHECKPOINT_UNAVAILABLE', 'revoked');
      expect(await api('POST', '/patrols/routes', tA, body([checkpoints.gate.id, checkpoints.b.id])), 404, 'PATROL_NOT_FOUND', 'another company\'s checkpoint looks absent');
      expect(await api('POST', '/patrols/routes', tA, { ...body([]), checkpoints: [] }), 400);
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM patrol_routes`)), 0, 'nothing written by a refusal');
      const r = await api('POST', '/patrols/routes', tA, body([checkpoints.yard.id, checkpoints.gate.id]));
      expect(r, 201);
      route = r.body;
      assert.deepEqual(route.checkpoints.map((c: any) => [c.position, c.checkpointId, c.required]), [[1, checkpoints.yard.id, true], [2, checkpoints.gate.id, true]]);
      const p = await api('PATCH', `/patrols/routes/${route.id}`, tokens.operations, {
        checkpoints: [{ checkpointId: checkpoints.gate.id }, { checkpointId: checkpoints.yard.id, required: false }, { checkpointId: checkpoints.fence.id }],
      });
      expect(p, 200);
      assert.deepEqual(p.body.checkpoints.map((c: any) => [c.position, c.checkpointId, c.required]),
        [[1, checkpoints.gate.id, true], [2, checkpoints.yard.id, false], [3, checkpoints.fence.id, true]], 'reordered');
      expect(await api('PATCH', `/patrols/routes/${route.id}`, tA, { checkpoints: [{ checkpointId: checkpoints.south.id }] }), 422, 'PATROL_ROUTE_CHECKPOINT_WRONG_SITE');
      const s2 = await api('POST', '/patrols/routes', tA, { siteId: A.site2, name: 'South', checkpoints: [{ checkpointId: checkpoints.south.id }] });
      expect(s2, 201);
      expect(await api('PATCH', `/patrols/schedules/${schedule.id}`, tA, { routeId: s2.body.id }), 422, 'PATROL_ROUTE_NOT_FOR_SITE', 'a schedule cannot use another site\'s route');
      expect(await api('PATCH', `/patrols/schedules/${schedule.id}`, tA, { routeId: route.id }), 200);
      const arch = await api('DELETE', `/patrols/routes/${s2.body.id}`, tA);
      expect(arch, 200);
      assert.equal(arch.body.active, false);
      assert.equal((await api('GET', '/patrols/routes', tokens.viewer)).body.length, 1);
      const got = await api('GET', `/patrols/routes/${route.id}`, tokens.viewer);
      assert.deepEqual(got.body.checkpoints.map((c: any) => c.checkpointId), [checkpoints.gate.id, checkpoints.yard.id, checkpoints.fence.id]);
    });

    // ═══════════════════ Guard ═══════════════════

    let runA: any;
    await test('PF-12-GUARD-PLAN-OWN-SHIFT-ONLY-AND-NO-SECRETS', async () => {
      const r = await api('GET', `/patrols/mine/plan?shiftId=${shiftA}`, gA.token);
      expect(r, 200);
      assert.equal(r.body.site.id, A.site1);
      assert.equal(r.body.policy.retentionDays, 90);
      assert.equal(r.body.locationVerification, false);
      assert.deepEqual(r.body.checkpoints.map((c: any) => c.label).sort(), ['Fence', 'Main gate (north)', 'Yard'], 'active checkpoints of the shift\'s site only');
      for (const c of r.body.checkpoints) assert.deepEqual(Object.keys(c).sort(), ['description', 'label', 'photoRequired', 'publicId']);
      assert.deepEqual(r.body.routes.map((x: any) => x.checkpoints.map((c: any) => c.publicId)), [[checkpoints.gate.publicId, checkpoints.yard.publicId, checkpoints.fence.publicId]]);
      assert.deepEqual(r.body.schedules.map((s: any) => s.name).sort(), ['Edge 1440', 'Night perimeter']);
      const text = JSON.stringify(r.body);
      assert.ok(!text.includes(SIGNING_KEY) && !/s4cp:|tokenVersion|qrRequireProximity/.test(text), 'no key, no label payload, no token version');
      expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftA2}`, gA.token), 404, 'PATROL_SHIFT_NOT_FOUND', 'another Guard\'s shift');
      expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftA}`, gB.token), 404, 'PATROL_SHIFT_NOT_FOUND', 'company B Guard on company A shift');
      expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftB}`, gA.token), 404, 'PATROL_SHIFT_NOT_FOUND');
      expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftA}`, tA), 403, undefined, 'company accounts cannot use Guard routes');
      expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftA}`, tokens.platform), 403);
    });

    await test('PF-13-GUARD-RUN-LIFECYCLE', async () => {
      expect(await api('POST', '/patrols/runs', gA.token, { clientRunId: cid('ready'), shiftId: shiftAReady, startedAtDevice: iso() }), 409, 'PATROL_SHIFT_NOT_IN_PROGRESS');
      expect(await api('POST', '/patrols/runs', gB.token, { clientRunId: cid('x'), shiftId: shiftA, startedAtDevice: iso() }), 404, 'PATROL_SHIFT_NOT_FOUND', 'another company\'s shift');
      expect(await api('POST', '/patrols/runs', gA.token, { clientRunId: cid('x'), shiftId: shiftA2, startedAtDevice: iso() }), 404, 'PATROL_SHIFT_NOT_FOUND', 'another Guard\'s shift');
      expect(await api('POST', '/patrols/runs', gA.token, { clientRunId: 'short', shiftId: shiftA, startedAtDevice: iso() }), 400);
      expect(await api('POST', '/patrols/runs', gA.token, { clientRunId: cid('x'), shiftId: shiftA, startedAtDevice: '2026-10-28T10:00:00' }), 400, undefined, 'device time without offset');
      const other = await api('POST', '/patrols/schedules', tA, { siteId: A.site2, name: 'South hourly', activeFrom: '00:00', activeTo: '23:59', frequencyMinutes: 60 });
      expect(await api('POST', '/patrols/runs', gA.token, { clientRunId: cid('x'), shiftId: shiftA, scheduleId: other.body.id, startedAtDevice: iso() }), 422, 'PATROL_SCHEDULE_NOT_FOR_SITE');
      const device = Date.now() - 4000;
      const r = await api('POST', '/patrols/runs', gA.token, { clientRunId: cid('run'), shiftId: shiftA, scheduleId: schedule.id, startedAtDevice: iso(device) });
      expect(r, 201);
      runA = r.body;
      assert.deepEqual([runA.status, runA.verificationStatus, runA.routeId, runA.scheduleId, runA.siteId], ['in_progress', 'pending', route.id, schedule.id, A.site1],
        'the schedule\'s route is followed');
      assert.ok(runA.clockOffsetMs >= 3000 && runA.clockOffsetMs < 60000, `clock offset ${runA.clockOffsetMs}`);
      const second = await api('POST', '/patrols/runs', gA.token, { clientRunId: cid('run2'), shiftId: shiftA, startedAtDevice: iso() });
      expect(second, 409, 'PATROL_RUN_ALREADY_IN_PROGRESS');
      assert.equal(second.body.details.runId, runA.id);
      const lbl = await api('GET', `/patrols/checkpoints/${checkpoints.gate.id}/label`, tA);
      const v = await api('POST', `/patrols/runs/${runA.id}/visits`, gA.token, { clientVisitId: cid('v'), scanPayload: lbl.body.payload, scannedAtDevice: iso() });
      expect(v, 201);
      assert.deepEqual([v.body.result, v.body.flags, v.body.provisional, v.body.checkpointId], ['verified', [], true, checkpoints.gate.id]);
      expect(await api('POST', `/patrols/runs/${runA.id}/visits`, gA2.token, { clientVisitId: cid('v'), scanPayload: lbl.body.payload, scannedAtDevice: iso() }), 404, 'PATROL_NOT_FOUND', 'another Guard\'s run');
      expect(await api('POST', `/patrols/runs/${runA.id}/visits`, gA.token, { clientVisitId: cid('v'), scannedAtDevice: iso() }), 400, 'PATROL_VALIDATION_FAILED');
      const done = await api('POST', `/patrols/runs/${runA.id}/complete`, gA.token, { completedAtDevice: iso() });
      expect(done, 200);
      assert.deepEqual([done.body.status, done.body.verificationStatus, done.body.exceptionReason], ['completed', 'pending', null], 'completed, verification still pending (P1-B)');
      expect(await api('POST', `/patrols/runs/${runA.id}/visits`, gA.token, { clientVisitId: cid('late'), scanPayload: lbl.body.payload, scannedAtDevice: iso() }), 409, 'PATROL_RUN_NOT_IN_PROGRESS');
      const inc = await api('POST', '/patrols/runs', gA.token, { clientRunId: cid('inc'), shiftId: shiftA, startedAtDevice: iso() });
      expect(inc, 201);
      expect(await api('POST', `/patrols/runs/${inc.body.id}/complete`, gA.token, { completedAtDevice: iso(), exceptionReason: '   ' }), 400, 'PATROL_VALIDATION_FAILED');
      const incDone = await api('POST', `/patrols/runs/${inc.body.id}/complete`, gA.token, { completedAtDevice: iso(), exceptionReason: 'Gate blocked by delivery lorry' });
      expect(incDone, 200);
      assert.deepEqual([incDone.body.status, incDone.body.exceptionReason], ['incomplete', 'Gate blocked by delivery lorry']);
      const mine = await api('GET', `/patrols/mine/runs?shiftId=${shiftA}`, gA.token);
      expect(mine, 200);
      assert.deepEqual(mine.body.map((x: any) => [x.id, x.status, x.visits.length]), [[runA.id, 'completed', 1], [inc.body.id, 'incomplete', 0]]);
      expect(await api('GET', `/patrols/mine/runs?shiftId=${shiftA}`, gA2.token), 404, 'PATROL_SHIFT_NOT_FOUND');
    });

    await test('PF-14-IDEMPOTENT-REPLAY-OF-EVERY-GUARD-WRITE', async () => {
      const startBody = { clientRunId: cid('rep'), shiftId: shiftA, startedAtDevice: iso(Date.now() - 1000) };
      const s1 = await api('POST', '/patrols/runs', gA.token, startBody);
      const s2 = await api('POST', '/patrols/runs', gA.token, startBody);
      expect(s1, 201);
      expect(s2, 201);
      assert.deepEqual(s2.body, s1.body, 'the same run');
      const visitBody = { clientVisitId: cid('rep'), checkpointPublicId: checkpoints.yard.publicId, scannedAtDevice: iso() };
      const v1 = await api('POST', `/patrols/runs/${s1.body.id}/visits`, gA.token, visitBody);
      const v2 = await api('POST', `/patrols/runs/${s1.body.id}/visits`, gA.token, visitBody);
      expect(v1, 201);
      assert.deepEqual(v2.body, v1.body, 'the same scan');
      const doneBody = { completedAtDevice: iso(), exceptionReason: 'Rain' };
      const c1 = await api('POST', `/patrols/runs/${s1.body.id}/complete`, gA.token, doneBody);
      const c2 = await api('POST', `/patrols/runs/${s1.body.id}/complete`, gA.token, doneBody);
      expect(c1, 200);
      expect(c2, 200);
      assert.deepEqual(c2.body, c1.body, 'completing twice is a no-op');
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM patrol_runs WHERE "clientRunId" = $1`, [startBody.clientRunId])), 1);
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM patrol_checkpoint_visits WHERE "clientVisitId" = $1`, [visitBody.clientVisitId])), 1);
      // An offline outbox may retry after Book Off: an accepted write still replays.
      await q(`UPDATE shifts SET status = 'completed' WHERE id = $1`, [shiftA]);
      try {
        const replayed = (await api('POST', '/patrols/runs', gA.token, startBody)).body;
        assert.deepEqual([replayed.id, replayed.clientRunId, replayed.startedAtDevice, replayed.startedAtServer, replayed.status],
          [s1.body.id, s1.body.clientRunId, s1.body.startedAtDevice, s1.body.startedAtServer, 'incomplete'], 'the same run, in its current state');
        assert.deepEqual((await api('POST', `/patrols/runs/${s1.body.id}/visits`, gA.token, visitBody)).body, v1.body);
        assert.deepEqual((await api('POST', `/patrols/runs/${s1.body.id}/complete`, gA.token, doneBody)).body, c1.body);
        // P1-B: a NEW run reaching the server after the shift ended is never a plain on-shift run. This Guard booked on, so
        // it is accepted only as a provisional, flagged post-shift creation (the full matrix is patrol-schedule.spec.ts),
        // and completed here so the shift has no open run afterwards.
        const late = await api('POST', '/patrols/runs', gA.token, { ...startBody, clientRunId: cid('new') });
        expect(late, 201, undefined, 'a NEW run after the shift ended');
        assert.deepEqual([late.body.provisional, late.body.syncedLate, late.body.syncFlags.includes('post_shift_creation')], [true, true, true]);
        expect(await api('POST', `/patrols/runs/${late.body.id}/complete`, gA.token, { completedAtDevice: iso() }), 200);
        expect(await api('POST', '/patrols/runs', gA2.token, { ...startBody, clientRunId: cid('new') }), 404, 'PATROL_SHIFT_NOT_FOUND', 'never on another Guard\'s shift');
      } finally {
        await q(`UPDATE shifts SET status = 'in_progress' WHERE id = $1`, [shiftA]);
      }
    });

    await test('PF-15-CONCURRENT-DUPLICATES-RESOLVE-TO-ONE-ROW', async () => {
      const startBody = { clientRunId: cid('race'), shiftId: shiftA, startedAtDevice: iso() };
      const starts = await Promise.all(Array.from({ length: 8 }, () => api('POST', '/patrols/runs', gA.token, startBody)));
      for (const s of starts) expect(s, 201, undefined, 'every duplicate start succeeds');
      assert.equal(new Set(starts.map((s) => s.body.id)).size, 1, 'one run');
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM patrol_runs WHERE "clientRunId" = $1`, [startBody.clientRunId])), 1);
      const runId = starts[0].body.id;
      const visitBody = { clientVisitId: cid('race'), checkpointPublicId: checkpoints.fence.publicId, scannedAtDevice: iso() };
      const visits = await Promise.all(Array.from({ length: 8 }, () => api('POST', `/patrols/runs/${runId}/visits`, gA.token, visitBody)));
      for (const v of visits) expect(v, 201);
      assert.equal(new Set(visits.map((v) => v.body.id)).size, 1, 'one scan');
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM patrol_checkpoint_visits WHERE "clientVisitId" = $1`, [visitBody.clientVisitId])), 1);
      const doneBody = { completedAtDevice: iso() };
      const dones = await Promise.all(Array.from({ length: 8 }, () => api('POST', `/patrols/runs/${runId}/complete`, gA.token, doneBody)));
      for (const d of dones) expect(d, 200);
      assert.equal(new Set(dones.map((d) => d.body.completedAtServer)).size, 1, 'completed once');
      // Two DIFFERENT runs at once: exactly one opens.
      const pair = await Promise.all([1, 2].map(() => api('POST', '/patrols/runs', gA.token, { clientRunId: cid('pair'), shiftId: shiftA, startedAtDevice: iso() })));
      assert.deepEqual(pair.map((p) => p.status).sort(), [201, 409]);
      assert.equal(pair.find((p) => p.status === 409)!.body.code, 'PATROL_RUN_ALREADY_IN_PROGRESS');
      const open = pair.find((p) => p.status === 201)!.body;
      expect(await api('POST', `/patrols/runs/${open.id}/complete`, gA.token, { completedAtDevice: iso() }), 200);
    });

    await test('PF-16-SAME-CLIENT-ID-DIFFERENT-CONTENT-IS-409-AND-IDS-ARE-PER-COMPANY', async () => {
      const startBody = { clientRunId: cid('conf'), shiftId: shiftA, startedAtDevice: iso(Date.now() - 5000) };
      const s = await api('POST', '/patrols/runs', gA.token, startBody);
      expect(s, 201);
      expect(await api('POST', '/patrols/runs', gA.token, { ...startBody, startedAtDevice: iso() }), 409, 'PATROL_IDEMPOTENCY_CONFLICT', 'different start time');
      expect(await api('POST', '/patrols/runs', gA.token, { ...startBody, scheduleId: schedule.id }), 409, 'PATROL_IDEMPOTENCY_CONFLICT', 'different schedule');
      const visitBody = { clientVisitId: cid('conf'), checkpointPublicId: checkpoints.yard.publicId, scannedAtDevice: iso() };
      expect(await api('POST', `/patrols/runs/${s.body.id}/visits`, gA.token, visitBody), 201);
      expect(await api('POST', `/patrols/runs/${s.body.id}/visits`, gA.token, { ...visitBody, checkpointPublicId: checkpoints.gate.publicId }), 409, 'PATROL_IDEMPOTENCY_CONFLICT');
      expect(await api('POST', `/patrols/runs/${s.body.id}/visits`, gA.token, { ...visitBody, scannedAtDevice: iso(Date.now() + 1000) }), 409, 'PATROL_IDEMPOTENCY_CONFLICT');
      expect(await api('POST', `/patrols/runs/${s.body.id}/complete`, gA.token, { completedAtDevice: iso(), exceptionReason: 'Fog' }), 200);
      expect(await api('POST', `/patrols/runs/${s.body.id}/complete`, gA.token, { completedAtDevice: iso(), exceptionReason: 'Snow' }), 409, 'PATROL_IDEMPOTENCY_CONFLICT');
      // The same client id in another company is another record.
      const b = await api('POST', '/patrols/runs', gB.token, { ...startBody, shiftId: shiftB });
      expect(b, 201, undefined, 'company B, same clientRunId');
      assert.notEqual(b.body.id, s.body.id);
      expect(await api('POST', `/patrols/runs/${b.body.id}/complete`, gB.token, { completedAtDevice: iso() }), 200);
      assert.equal(Number(await scalar(`SELECT count(*)::int FROM patrol_runs WHERE "clientRunId" = $1`, [startBody.clientRunId])), 2);
    });

    await test('PF-17-QR-SIGNATURE-ROTATION-AND-FLAGS', async () => {
      const r = await api('POST', '/patrols/runs', gA.token, { clientRunId: cid('qr'), shiftId: shiftA, startedAtDevice: iso() });
      expect(r, 201);
      const scan = (body: Record<string, unknown>) => api('POST', `/patrols/runs/${r.body.id}/visits`, gA.token, { clientVisitId: cid('qr'), scannedAtDevice: iso(), ...body });
      const label = async (key: string) => (await api('GET', `/patrols/checkpoints/${checkpoints[key].id}/label`, tA)).body;
      const gate = await label('gate');
      assert.match(gate.payload, new RegExp(`^s4cp:1:t1:${checkpoints.gate.publicId}:1:[A-Za-z0-9_-]{43}$`));
      const ok = await scan({ scanPayload: gate.payload });
      assert.deepEqual([ok.body.result, ok.body.flags], ['verified', []], 'a valid label is verified');
      const dup = await scan({ scanPayload: gate.payload });
      assert.deepEqual([dup.body.result, dup.body.flags], ['flagged', ['duplicate_in_run']]);
      const yard = await label('yard');
      const last = yard.payload.slice(-1);
      const tampered = await scan({ scanPayload: yard.payload.slice(0, -1) + (last === 'A' ? 'B' : 'A') });
      assert.deepEqual([tampered.body.result, tampered.body.flags], ['flagged', ['tampered_signature']], 'a tampered MAC is flagged');
      const fenceOld = await label('fence');
      expect(await api('POST', `/patrols/checkpoints/${checkpoints.fence.id}/rotate`, tA), 200);
      const rotated = await scan({ scanPayload: fenceOld.payload });
      assert.deepEqual([rotated.body.result, rotated.body.flags], ['flagged', ['revoked_label']], 'an old (reprinted) label is flagged revoked');
      const fenceNew = await label('fence');
      assert.equal(fenceNew.tokenVersion, 2);
      assert.deepEqual((await scan({ scanPayload: fenceNew.payload })).body.flags, ['duplicate_in_run'], 'the new label is genuine (only the repeat is flagged)');
      const unknownId = 'f'.repeat(32);
      const unknown = await scan({ scanPayload: signCheckpointLabel(unknownId, 1, patrolQrKeyring())! });
      assert.deepEqual([unknown.body.result, unknown.body.flags, unknown.body.checkpointId], ['flagged', ['unknown_checkpoint'], null], 'unknown publicId flagged');
      const bLabel = (await api('GET', `/patrols/checkpoints/${checkpoints.b.id}/label`, tB)).body;
      const foreign = await scan({ scanPayload: bLabel.payload });
      assert.deepEqual([foreign.body.flags, foreign.body.checkpointId, foreign.body.checkpointLabel], [['unknown_checkpoint'], null, null], 'another company\'s label reveals nothing');
      const south = await label('south');
      assert.deepEqual((await scan({ scanPayload: south.payload })).body.flags, ['wrong_site'], 'another site of the company');
      const spareLabel = signCheckpointLabel(checkpoints.spare.publicId, 2, patrolQrKeyring())!;
      assert.deepEqual((await scan({ scanPayload: spareLabel })).body.flags, ['checkpoint_revoked'], 'a revoked checkpoint');
      for (const [key, name] of [['post', 'Post 1'], ['post2', 'Post 2'], ['post3', 'Post 3']]) {
        checkpoints[key] = (await api('POST', '/patrols/checkpoints', tA, { siteId: A.site1, label: name })).body;
      }
      const future = signCheckpointLabel(checkpoints.post3.publicId, 7, patrolQrKeyring())!;
      assert.deepEqual((await scan({ scanPayload: future })).body.flags, ['invalid_label_version'], 'a version the checkpoint never had');
      const bare = await scan({ checkpointPublicId: checkpoints.post2.publicId });
      assert.deepEqual([bare.body.result, bare.body.flags], ['unverified', ['unsigned_scan']], 'a publicId alone is unverified, not verified');
      const malformed = await scan({ scanPayload: 'https://example.invalid/not-a-label' });
      assert.deepEqual([malformed.body.result, malformed.body.flags], ['flagged', ['malformed_payload']]);
      expect(await scan({ scanPayload: yard.payload, checkpointPublicId: checkpoints.gate.publicId }), 400, 'PATROL_VALIDATION_FAILED', 'publicId must match the label');
      const flaggedAudits = Number(await scalar(`SELECT count(*)::int FROM audit_logs WHERE action = 'patrol.scan_flagged' AND "companyId" = $1`, [A.id]));
      assert.ok(flaggedAudits >= 8, `every flagged scan is audited (${flaggedAudits})`);
      const labelAudits = Number(await scalar(`SELECT count(*)::int FROM audit_logs WHERE action = 'patrol.checkpoint.label_issued'`));
      assert.ok(labelAudits >= 5);

      // No server key: labels are refused and scans are recorded unverified, never verified.
      const postLabel = await label('post');
      delete process.env.PATROL_QR_SIGNING_KEY;
      try {
        expect(await api('GET', `/patrols/checkpoints/${checkpoints.gate.id}/label`, tA), 503, 'PATROL_QR_SIGNING_KEY_UNAVAILABLE');
        const noKey = await scan({ scanPayload: postLabel.payload });
        assert.deepEqual([noKey.body.result, noKey.body.flags], ['unverified', ['signing_key_unavailable']]);
      } finally {
        setKey();
      }
      // A rotated KEY: the previous key still verifies its labels; an unknown key id is flagged.
      const oldGate = gate.payload;
      process.env.PATROL_QR_PREVIOUS_SIGNING_KEY = SIGNING_KEY;
      process.env.PATROL_QR_PREVIOUS_SIGNING_KEY_ID = 't1';
      process.env.PATROL_QR_SIGNING_KEY = 'patrol-foundation-spec-only-signing-key-SECOND-0001';
      process.env.PATROL_QR_SIGNING_KEY_ID = 't2';
      try {
        const r2 = await api('POST', `/patrols/runs/${r.body.id}/complete`, gA.token, { completedAtDevice: iso() });
        expect(r2, 200);
        const r3 = await api('POST', '/patrols/runs', gA.token, { clientRunId: cid('qr2'), shiftId: shiftA, startedAtDevice: iso() });
        const scan3 = (body: Record<string, unknown>) => api('POST', `/patrols/runs/${r3.body.id}/visits`, gA.token, { clientVisitId: cid('qr2'), scannedAtDevice: iso(), ...body });
        assert.deepEqual((await scan3({ scanPayload: oldGate })).body.flags, [], 'a label signed with the previous key still verifies');
        const fresh = await label('gate');
        assert.equal(fresh.keyId, 't2');
        delete process.env.PATROL_QR_PREVIOUS_SIGNING_KEY;
        assert.deepEqual((await scan3({ scanPayload: oldGate })).body.flags, ['duplicate_in_run', 'unknown_signing_key']);
        expect(await api('POST', `/patrols/runs/${r3.body.id}/complete`, gA.token, { completedAtDevice: iso() }), 200);
      } finally {
        delete process.env.PATROL_QR_PREVIOUS_SIGNING_KEY;
        delete process.env.PATROL_QR_PREVIOUS_SIGNING_KEY_ID;
        setKey();
      }
      const located = Number(await scalar(`SELECT count(*)::int FROM patrol_checkpoint_visits WHERE latitude IS NOT NULL OR longitude IS NOT NULL OR "accuracyMeters" IS NOT NULL`));
      assert.equal(located, 0, 'no location is ever stored');
    });

    // ═══════════════════ company reads, isolation, permissions ═══════════════════

    await test('PF-18-COMPANY-READS-RUNS-DETAIL-AND-OVERVIEW', async () => {
      const [evidenceRow] = await q(`INSERT INTO patrol_evidence ("companyId","siteId","runId","guardId","shiftId","sha256Client","capturedAtDevice","clientEvidenceId","mimeType","sizeBytes")
         VALUES ($1,$2,$3,$4,$5,$6,now(),'pf-evidence-0001','image/jpeg',512000) RETURNING id`, [A.id, A.site1, runA.id, gA.id, shiftA, 'b'.repeat(64)]);
      await q(`INSERT INTO patrol_exceptions ("companyId","siteId","runId","windowKey","type") VALUES ($1,$2,$3,'s1:2026-10-28:2','patrol_late')`, [A.id, A.site1, runA.id]);
      const list = await api('GET', '/patrols/runs?pageSize=2', tokens.viewer);
      expect(list, 200);
      const total = Number(await scalar(`SELECT count(*)::int FROM patrol_runs WHERE "companyId" = $1`, [A.id]));
      assert.deepEqual([list.body.total, list.body.items.length, list.body.page, list.body.pageSize], [total, 2, 1, 2]);
      const page2 = await api('GET', '/patrols/runs?pageSize=2&page=2', tokens.viewer);
      assert.equal(page2.body.items.length, 2);
      assert.ok(!page2.body.items.some((x: any) => list.body.items.some((y: any) => y.id === x.id)), 'pages do not overlap');
      const inc = await api('GET', '/patrols/runs?status=incomplete', tokens.viewer);
      assert.ok(inc.body.items.length >= 2 && inc.body.items.every((x: any) => x.status === 'incomplete'));
      assert.equal((await api(`GET`, `/patrols/runs?siteId=${A.site2}`, tokens.viewer)).body.total, 0);
      const today = iso().slice(0, 10);
      assert.equal((await api('GET', `/patrols/runs?from=${today}&to=${today}`, tokens.viewer)).body.total, total);
      assert.equal((await api('GET', `/patrols/runs?to=2020-01-01`, tokens.viewer)).body.total, 0);
      expect(await api('GET', '/patrols/runs?status=lost', tokens.viewer), 400);
      const item = list.body.items[0];
      assert.equal(item.guardName, item.guardId === gA.id ? 'Guard guarda' : item.guardName);
      const detail = await api('GET', `/patrols/runs/${runA.id}`, tokens.control_room);
      expect(detail, 200);
      assert.deepEqual([detail.body.run.id, detail.body.visits.length, detail.body.exceptions.map((e: any) => e.type), detail.body.evidenceCount, detail.body.evidenceRestricted],
        [runA.id, 1, ['patrol_late'], 1, false]);
      assert.deepEqual([detail.body.evidence[0].id, detail.body.evidence[0].sha256Client, detail.body.evidence[0].retentionStatus, detail.body.evidence[0].sizeBytes],
        [evidenceRow.id, 'b'.repeat(64), 'active', 512000]);
      assert.ok(!('storageKey' in detail.body.evidence[0]), 'no storage key or URL in P1-A');
      const viewerDetail = await api('GET', `/patrols/runs/${runA.id}`, tokens.viewer);
      assert.deepEqual([viewerDetail.body.evidence, viewerDetail.body.evidenceRestricted, viewerDetail.body.evidenceCount], [null, true, 1], 'a viewer sees only the count');
      const ov = await api('GET', '/patrols/overview', tokens.viewer);
      expect(ov, 200);
      assert.equal(ov.body.runsStarted, total);
      assert.equal(ov.body.runsByStatus.completed + ov.body.runsByStatus.incomplete + ov.body.runsByStatus.in_progress, total);
      assert.equal(ov.body.openExceptions, 1);
      assert.equal(ov.body.activeCheckpoints, Number(await scalar(`SELECT count(*)::int FROM patrol_checkpoints WHERE "companyId" = $1 AND active AND "revokedAt" IS NULL`, [A.id])));
      assert.equal(ov.body.activeCheckpoints, 7);
      assert.ok(ov.body.flaggedScans >= 8);
      assert.equal((await api('GET', '/patrols/overview?date=2020-01-01', tokens.viewer)).body.runsStarted, 0);
    });

    await test('PF-10-TENANT-ISOLATION-COMPANY-B-GETS-404-ON-EVERYTHING-OF-COMPANY-A', async () => {
      const ids = { schedule: schedule.id, checkpoint: checkpoints.gate.id, route: route.id, run: runA.id, site: A.site1 };
      const snapshot = await q(`SELECT md5(string_agg(to_jsonb(x)::text, '' ORDER BY x.id)) h FROM patrol_checkpoints x`);
      for (const [method, p, body] of companyRoutes(ids)) {
        const r = await api(method, p, tB, body);
        const listing = method === 'GET' && !/\/\d+/.test(p);
        if (listing) {
          expect(r, 200, undefined, `${method} ${p}`);
          assert.ok(!JSON.stringify(r.body).includes(checkpoints.gate.publicId), `${p} lists nothing of company A`);
          if (p === '/patrols/runs') assert.ok(r.body.items.every((x: any) => x.siteId === B.site1));
        } else if (method === 'POST' && !/\/\d+/.test(p)) {
          // Creating with company A's site / checkpoint: 404 (it does not exist for B).
          assert.equal(r.status, 404, `${method} ${p}: ${JSON.stringify(r.body)}`);
        } else if (method === 'PUT' && p === '/patrols/policies/default') {
          expect(r, 200, undefined, 'B edits its own default');
        } else {
          assert.equal(r.status, 404, `${method} ${p}: ${JSON.stringify(r.body)}`);
        }
      }
      assert.deepEqual(await q(`SELECT md5(string_agg(to_jsonb(x)::text, '' ORDER BY x.id)) h FROM patrol_checkpoints x`), snapshot, 'nothing of A changed');
      const bPolicies = await api('GET', '/patrols/policies', tB);
      assert.deepEqual(bPolicies.body.sites.map((s: any) => s.siteId), [B.site1, B.site2]);
    });

    await test('PF-11-PERMISSION-MATRIX', async () => {
      const expected: Record<string, [boolean, boolean, boolean, boolean]> = {
        // view, manage, evidence, holds
        owner: [true, true, true, true],
        admin: [true, true, true, true],
        operations: [true, true, true, false],
        control_room: [true, false, true, false],
        viewer: [true, false, false, false],
        finance: [false, false, false, false],
        hr_compliance: [false, false, false, false],
      };
      const perms = [CompanyPermission.PATROLS_VIEW, CompanyPermission.PATROLS_MANAGE, CompanyPermission.PATROLS_EVIDENCE, CompanyPermission.PATROLS_HOLDS];
      for (const role of Object.values(CompanyMembershipRole)) {
        assert.deepEqual(perms.map((p) => hasPermission(role, p)), expected[role], `${role} matrix`);
      }
      const probe = async (tok: string) => [
        (await api('GET', '/patrols/schedules', tok)).status,
        (await api('PATCH', `/patrols/checkpoints/${checkpoints.yard.id}`, tok, { description: 'probe' })).status,
        (await api('GET', `/patrols/runs/${runA.id}/evidence`, tok)).status,
        (await api('GET', '/patrols/holds', tok)).status,
      ];
      for (const [role, allowed] of Object.entries(expected)) {
        const got = await probe(tokens[role]);
        assert.deepEqual(got, allowed.map((a) => (a ? 200 : 403)), `${role}: view / manage / evidence / holds`);
      }
      assert.deepEqual(await probe(tA), [200, 200, 200, 200], 'legacy owner (companies.userId, no membership)');
      const forbidden = await api('GET', '/patrols/holds', tokens.viewer);
      assert.equal(forbidden.body.code, 'PATROL_FORBIDDEN');
      if (tokens.suspended) {
        for (const r of await probe(tokens.suspended)) assert.equal(r, 403, 'suspended member');
      } else {
        const id = Number(await scalar(`SELECT id FROM users WHERE email = 'pf.suspended@example.invalid'`));
        const jwt = ctx.app.get((await import('@nestjs/jwt')).JwtService).sign({ sub: id, email: 'pf.suspended@example.invalid', role: 'company_admin', status: 'active', principalType: 'user' });
        for (const r of await probe(jwt)) assert.equal(r, 403, 'suspended member');
      }
      for (const tok of [gA.token, tokens.platform]) {
        for (const r of await probe(tok)) assert.equal(r, 403, 'Guards and S4 platform admins never use company patrol routes');
      }
      // The session list carries exactly the role's patrol permissions (switch on).
      for (const [role, allowed] of Object.entries(expected)) {
        const me = await api('GET', '/auth/me', tokens[role]);
        const held = perms.filter((p) => (me.body.companyPermissions ?? []).includes(p));
        assert.deepEqual(held, perms.filter((_, i) => allowed[i]), `${role} session`);
      }
    });

    await test('PF-19-SWITCHING-OFF-AGAIN-HIDES-EVERYTHING-AND-DELETES-NOTHING', async () => {
      const counts = await patrolRowCounts();
      expect(await setSwitch(A.id, false), 200);
      const ids = { schedule: schedule.id, checkpoint: checkpoints.gate.id, route: route.id, run: runA.id, site: A.site1 };
      for (const [method, p, body] of companyRoutes(ids)) expect(await api(method, p, tA, body), 404, 'PATROLS_NOT_ENABLED', `${method} ${p}`);
      for (const [method, p, body] of guardRoutes(shiftA, runA.id)) expect(await api(method, p, gA.token, body), 404, 'PATROLS_NOT_ENABLED', `${method} ${p}`);
      assert.deepEqual(await patrolRowCounts(), counts, 'nothing deleted');
      const me = await api('GET', '/auth/me', tA);
      assert.ok(!(me.body.companyPermissions ?? []).some((p: string) => p.startsWith('patrols.')), 'the session no longer lists patrol permissions');
      expect(await api('GET', '/patrols/schedules', tB), 200, undefined, 'company B is unaffected');
      const audits = await q(`SELECT "afterData" FROM audit_logs WHERE action = 'company.patrols_enabled_changed' AND "companyId" = $1 ORDER BY id`, [A.id]);
      assert.deepEqual(audits.map((a: any) => a.afterData.patrolsEnabled), [true, false]);
    });
  } finally {
    await ctx.app.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  console.log(JSON.stringify({ event: 'patrol_foundation_certified', tests: passed }));
  if (failures.length) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
