/**
 * Public-launch security (SEC-PUBLIC-01 and SEC-PUBLIC-03), over real HTTP against the real AppModule and a LOCAL,
 * disposable PostgreSQL.
 *
 * SEC-PUBLIC-01 — what a Guard is shown about a job
 *   S01-GUARD-LIST          GET /jobs as a Guard: every item has exactly the Guard-view keys; no owner account, client
 *                           contact, site address / coordinates / instructions or billing rate anywhere in the response
 *   S01-GUARD-ONE           GET /jobs/:id the same
 *   S01-APPLY               POST /job-applications and /job-applications/self, GET /job-applications and
 *                           /job-applications/self: the Guard application view only, the same exclusions
 *   S01-OPEN-ONLY           a job that is not open is 404 for a Guard (unchanged)
 *   S01-COMPANY-UNCHANGED   the posting company still reads its own job in full (billing rate, site)
 *   S01-ADMIN-UNCHANGED     a platform administrator still reads the full job
 *   S01-TENANT              another company cannot read the job (404, unchanged)
 *
 * SEC-PUBLIC-03 — company verification
 *   S03-REGISTERS-PENDING   a self-registered company is pending_verification and can sign in and read its own status
 *   S03-PENDING-REFUSED     pending: creating a client, site, job or Guard invitation is 403 COMPANY_NOT_APPROVED, and
 *                           nothing is created
 *   S03-PENDING-ALLOWED     pending: correcting its details (PATCH /companies/me) and signing out still work
 *   S03-NO-SELF-APPROVAL    a company cannot set its own verification through PATCH /companies/me
 *   S03-ADMIN-ONLY          company users and Guards cannot reach the verification administration (403)
 *   S03-REASON-REQUIRED     rejecting or suspending without a reason is 400
 *   S03-TRANSITIONS         only permitted transitions apply (pending → suspended is 409)
 *   S03-REJECTED            rejected: details may be corrected, operations are refused (verificationStatus rejected)
 *   S03-APPROVED            approved: the same operations succeed
 *   S03-SUSPENDED           suspended: operations refused, details locked; its jobs disappear from Guard discovery, a
 *                           Guard can neither open nor apply for them, and its invitation codes are refused (generic 404)
 *   S03-REINSTATED          approved again: everything returns
 *   S03-UNAPPROVED-JOBS-HIDDEN  a pending company's job (inserted directly) is never shown to a Guard
 *   S03-AUDIT               every decision is audited as company.verification_changed with before and after
 *   S03-GUARD-REGISTRATION  Guard self-registration is unaffected (no verification step, no screening requirement)
 *
 * Requires SEC_PUBLIC_DATABASE_URL; the host must be local. Migrations are applied; every account is synthetic.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AuthService } from '../src/auth/auth.service';
import { AdminOperatorService } from '../src/admin-operator/admin-operator.service';

const url = process.env.SEC_PUBLIC_DATABASE_URL;
if (!url) throw new Error('SEC_PUBLIC_DATABASE_URL is required');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('The SEC-PUBLIC database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'sec-public-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

const RUN = Date.now().toString(36);
let passed = 0;
const pass = (name: string) => { passed += 1; console.log(`PASS ${name}`); };
type Res = { status: number; body: any; text: string };
type Session = { token: string; userId: number; companyId?: number; guardId?: number };
const errText = (r: Res) => (Array.isArray(r.body?.message) ? r.body.message.join('; ') : r.body?.message) || r.text;

/** Everything a Guard may be shown about a job, and nothing more. */
const GUARD_JOB_KEYS = ['company', 'description', 'endAt', 'guardsRequired', 'hourlyRate', 'id', 'site', 'startAt', 'status', 'title'];
const GUARD_APPLICATION_KEYS = ['appliedAt', 'hiredAt', 'id', 'job', 'jobId', 'status'];

// Distinctive synthetic values that must never reach a Guard.
const SECRET = {
  clientContactName: `Priya Private ${RUN}`,
  clientContactEmail: `priya.private.${RUN}@client-secret.test`,
  clientContactPhone: '02099990001',
  siteAddress: `77 Undisclosed Lane ${RUN}`,
  siteInstructions: `KEYSAFE-CODE-${RUN}`,
  latitude: 51.123457,
  billingRate: 31.57,
};

async function main() {
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const migrator = new DataSource(buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' }));
  await migrator.initialize();
  await migrator.runMigrations({ transaction: 'each' });
  await migrator.destroy();

  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const base = `http://127.0.0.1:${address.port}`;
  const ds = app.get(DataSource);
  const [{ current_database: actual }] = await ds.query('SELECT current_database()');
  if (actual !== new URL(url!).pathname.replace(/^\//, '')) throw new Error(`Refusing: connected to "${actual}"`);

  const api = async (method: string, path: string, token: string | null, body?: unknown): Promise<Res> => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, text };
  };
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params);

  try {
    const auth = app.get(AuthService);
    const password = 'Str0ng-pass-1!';
    const session = async (email: string, secret = password): Promise<Session> => {
      const s: any = await auth.login({ email, password: secret });
      return { token: s.accessToken, userId: s.user.id, companyId: s.user.companyId, guardId: s.user.guardId };
    };
    const { TransactionalEmailService } = await import('../src/email/transactional-email.service');
    const { AccountRecoveryService } = await import('../src/auth/account-recovery.service');
    const verifyEmail = async (email: string) => {
      const message = [...app.get(TransactionalEmailService).capturedMessages()].reverse()
        .find((m) => m.kind === 'email_verification' && m.to === email);
      const token = message && /verify-email\?token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
      assert.ok(token, `a verification email was sent to ${email}`);
      await app.get(AccountRecoveryService).verifyEmail(token);
    };
    const ownerEmail = (label: string) => `${label}.${RUN}@sec-public.test`;
    const registerCompany = async (label: string) => {
      const email = ownerEmail(label);
      await auth.register({
        email, password, role: 'company' as any, fullName: `${label} Owner`, phone: '02000000000',
        companyName: `${label} ${RUN} Security Ltd`, companyNumber: String(10000000 + Math.floor(Math.random() * 8999999)),
        address: '1 High St, London', contactDetails: `ops@${label}.test`,
      } as any);
      await verifyEmail(email);
      return session(email);
    };
    let siaSeq = Math.floor(Math.random() * 1e6);
    const registerGuard = async (label: string) => {
      const email = `${label}.${RUN}@sec-public.test`;
      await auth.register({
        email, password, role: 'guard' as any, fullName: `${label} Guard`, phone: '07700000000',
        siaLicenseNumber: String(6200000000000000 + (siaSeq += 7919)),
      } as any);
      await verifyEmail(email);
      return session(email);
    };
    const verificationOf = async (companyId: number): Promise<string> =>
      (await q(`SELECT "verificationStatus" s FROM companies WHERE id = $1`, [companyId]))[0].s;

    // Platform administrator (operator CLI path, as in production).
    const adminEmail = `platform.admin.${RUN}@sec-public.test`;
    const adminPassword = 'Sec-Public-Admin-1!';
    const operator = new AdminOperatorService(ds);
    if (Number((await q(`SELECT count(*) n FROM users WHERE role = 'admin'`))[0].n) === 0) {
      await operator.bootstrap(adminEmail, adminPassword);
    } else {
      throw new Error('This database already has a Platform Admin; use a disposable database.');
    }
    const admin = await session(adminEmail, adminPassword);
    const decide = (companyId: number, status: string, reason?: string, token = admin.token) =>
      api('PUT', `/admin/companies/${companyId}/verification`, token, reason === undefined ? { status } : { status, reason });

    // ── S03: registration, pending ──
    const alpha = await registerCompany('alpha');
    const alphaId = alpha.companyId!;
    assert.ok(alphaId, 'the owner session carries the company');
    assert.equal(await verificationOf(alphaId), 'pending_verification');
    const me = await api('GET', '/companies/me', alpha.token);
    assert.equal(me.status, 200, errText(me));
    assert.equal(me.body.verificationStatus, 'pending_verification', 'the company can see its own status');
    pass('S03-REGISTERS-PENDING: a self-registered company is pending and can read its own status');

    const operational = (s: Session) => ({
      client: () => api('POST', '/clients', s.token, {
        name: `Client ${RUN}`, contactName: SECRET.clientContactName, contactEmail: SECRET.clientContactEmail, contactPhone: SECRET.clientContactPhone,
      }),
      job: () => api('POST', '/jobs', s.token, { title: `Static guard ${RUN}`, guardsRequired: 1, hourlyRate: 15 }),
      invitation: () => api('POST', '/company-guards/invitations', s.token, {}),
    });
    const expectNotApproved = (r: Res, status: string, what: string) => {
      assert.equal(r.status, 403, `${what}: ${r.status} ${r.text}`);
      assert.equal(r.body.code, 'COMPANY_NOT_APPROVED', what);
      assert.equal(r.body.verificationStatus, status, what);
    };
    const counts = async (companyId: number) => (await q(
      `SELECT (SELECT count(*) FROM clients WHERE "companyId" = $1)::int AS clients,
              (SELECT count(*) FROM sites WHERE "companyId" = $1)::int AS sites,
              (SELECT count(*) FROM jobs WHERE "companyId" = $1)::int AS jobs,
              (SELECT count(*) FROM company_guard_invitations WHERE "companyId" = $1)::int AS invitations`, [companyId]))[0];

    const ops = operational(alpha);
    expectNotApproved(await ops.client(), 'pending_verification', 'pending: create client');
    expectNotApproved(await ops.job(), 'pending_verification', 'pending: create job');
    expectNotApproved(await ops.invitation(), 'pending_verification', 'pending: issue invitation');
    // Site creation resolves the company by a direct owner lookup, not resolveCompanyContext: the global gate still holds.
    expectNotApproved(await api('POST', '/sites', alpha.token, { name: 'Nope', address: '1 Way' }), 'pending_verification', 'pending: create site');
    assert.deepEqual(await counts(alphaId), { clients: 0, sites: 0, jobs: 0, invitations: 0 }, 'nothing was created');
    pass('S03-PENDING-REFUSED: pending companies cannot create clients, sites, jobs or invitations; nothing is created');

    const rename = await api('PATCH', '/companies/me', alpha.token, { name: `Alpha ${RUN} Security Limited` });
    assert.equal(rename.status, 200, errText(rename));
    const logoutProbe = await registerCompany('logoutprobe');
    const logout = await api('POST', '/auth/logout', logoutProbe.token, { refreshToken: 'x'.repeat(43) });
    assert.ok(logout.status === 200 || logout.status === 201 || logout.status === 204, `logout: ${logout.status} ${logout.text}`);
    pass('S03-PENDING-ALLOWED: a pending company may correct its details and sign out');

    const selfApprove = await api('PATCH', '/companies/me', alpha.token, { verificationStatus: 'approved' });
    assert.equal(selfApprove.status, 400, 'the field is not accepted');
    assert.equal(await verificationOf(alphaId), 'pending_verification');
    pass('S03-NO-SELF-APPROVAL: a company cannot approve itself');

    const outsiderGuard = await registerGuard('outsider');
    for (const [who, token] of [['company owner', alpha.token], ['guard', outsiderGuard.token]] as const) {
      assert.equal((await decide(alphaId, 'approved', undefined, token)).status, 403, `${who}: decide`);
      assert.equal((await api('GET', '/admin/companies/verification', token)).status, 403, `${who}: list`);
      assert.equal((await api('GET', `/admin/companies/${alphaId}/verification`, token)).status, 403, `${who}: read`);
    }
    assert.equal((await decide(alphaId, 'approved', undefined, '')).status, 401, 'anonymous');
    assert.equal(await verificationOf(alphaId), 'pending_verification');
    pass('S03-ADMIN-ONLY: company users, Guards and anonymous callers cannot reach verification administration');

    const noReason = await decide(alphaId, 'rejected');
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.code, 'COMPANY_VERIFICATION_REASON_REQUIRED');
    assert.equal((await decide(alphaId, 'rejected', '   ')).status, 400, 'a blank reason is no reason');
    pass('S03-REASON-REQUIRED: rejecting needs a reason');

    const badTransition = await decide(alphaId, 'suspended', 'Not yet approved');
    assert.equal(badTransition.status, 409);
    assert.equal(badTransition.body.code, 'COMPANY_VERIFICATION_TRANSITION_NOT_ALLOWED');
    assert.equal((await decide(alphaId, 'pending_verification')).status, 409, 'pending → pending is not a transition');
    pass('S03-TRANSITIONS: only permitted transitions apply');

    const rejected = await decide(alphaId, 'rejected', 'Companies House number does not match the company name.');
    assert.equal(rejected.status, 200, errText(rejected));
    assert.equal(rejected.body.verificationStatus, 'rejected');
    const meRejected = await api('GET', '/companies/me', alpha.token);
    assert.equal(meRejected.body.verificationStatus, 'rejected');
    assert.equal(meRejected.body.verificationNote, 'Companies House number does not match the company name.', 'the company sees the reason');
    expectNotApproved(await ops.job(), 'rejected', 'rejected: create job');
    assert.equal((await api('PATCH', '/companies/me', alpha.token, { companyNumber: '12345678' })).status, 200, 'rejected: may correct details');
    pass('S03-REJECTED: a rejected company sees the reason, may correct its details and cannot operate');

    const approved = await decide(alphaId, 'approved');
    assert.equal(approved.status, 200, errText(approved));
    const client = await ops.client();
    assert.equal(client.status, 201, errText(client));
    const site = await api('POST', '/sites', alpha.token, {
      name: `Riverside ${RUN}`, clientId: client.body.id, address: SECRET.siteAddress, specialInstructions: SECRET.siteInstructions,
      latitude: SECRET.latitude, longitude: -0.123457, welfareCheckIntervalMinutes: 60, requireGpsCheckIn: false,
    });
    assert.equal(site.status, 201, errText(site));
    const job = await api('POST', '/jobs', alpha.token, {
      title: `Riverside night static ${RUN}`, description: 'Night static guarding', guardsRequired: 2, hourlyRate: 15.25,
      billingRate: SECRET.billingRate, siteId: site.body.id,
    });
    assert.equal(job.status, 201, errText(job));
    const jobId: number = job.body.id;
    const invitation = await ops.invitation();
    assert.equal(invitation.status, 201, errText(invitation));
    pass('S03-APPROVED: an approved company creates clients, sites, jobs and invitations');

    // ── S01: what a Guard sees ──
    const guard = await registerGuard('seeker');
    const ownerAddress = ownerEmail('alpha');
    const assertNoSecrets = (r: Res, what: string) => {
      const text = r.text;
      for (const [name, value] of Object.entries({ ...SECRET, ownerAddress })) {
        assert.ok(!text.includes(String(value)), `${what}: ${name} leaked`);
      }
      for (const key of ['"billingRate"', '"user"', '"email"', '"phone"', '"passwordHash"', '"client"', '"address"', '"latitude"', '"longitude"',
        '"specialInstructions"', '"contactDetails"', '"companyNumber"', '"contactEmail"', '"contactPhone"', '"lastLoginAt"', '"assignments"']) {
        assert.ok(!text.includes(key), `${what}: ${key} present`);
      }
    };
    const assertGuardJob = (j: any, what: string) => {
      assert.deepEqual(Object.keys(j).sort(), GUARD_JOB_KEYS, `${what}: keys`);
      assert.deepEqual(Object.keys(j.company ?? {}).sort(), ['id', 'name'], `${what}: company`);
      if (j.site) assert.deepEqual(Object.keys(j.site).sort(), ['id', 'name'], `${what}: site`);
    };

    const list = await api('GET', '/jobs', guard.token);
    assert.equal(list.status, 200, errText(list));
    const listed = list.body.find((j: any) => j.id === jobId);
    assert.ok(listed, 'the approved company\'s open job is listed');
    for (const j of list.body) assertGuardJob(j, `GET /jobs #${j.id}`);
    assert.equal(Number(listed.hourlyRate), 15.25);
    assert.equal(listed.site.name, `Riverside ${RUN}`);
    assert.equal(listed.company.name, `Alpha ${RUN} Security Limited`);
    assertNoSecrets(list, 'GET /jobs');
    pass('S01-GUARD-LIST: GET /jobs shows a Guard only the discovery fields');

    const one = await api('GET', `/jobs/${jobId}`, guard.token);
    assert.equal(one.status, 200, errText(one));
    assertGuardJob(one.body, 'GET /jobs/:id');
    assertNoSecrets(one, 'GET /jobs/:id');
    pass('S01-GUARD-ONE: GET /jobs/:id the same');

    const applied = await api('POST', '/job-applications', guard.token, { jobId });
    assert.equal(applied.status, 201, errText(applied));
    assert.deepEqual(Object.keys(applied.body).sort(), GUARD_APPLICATION_KEYS);
    assert.equal(applied.body.jobId, jobId);
    assertGuardJob(applied.body.job, 'POST /job-applications');
    assertNoSecrets(applied, 'POST /job-applications');
    const guard2 = await registerGuard('seeker2');
    const appliedSelf = await api('POST', '/job-applications/self', guard2.token, { jobId });
    assert.equal(appliedSelf.status, 201, errText(appliedSelf));
    assertNoSecrets(appliedSelf, 'POST /job-applications/self');
    for (const path of ['/job-applications', '/job-applications/self']) {
      const mine = await api('GET', path, guard.token);
      assert.equal(mine.status, 200, errText(mine));
      assert.equal(mine.body.length, 1, `${path}: only the Guard's own application`);
      assert.deepEqual(Object.keys(mine.body[0]).sort(), GUARD_APPLICATION_KEYS);
      assertGuardJob(mine.body[0].job, path);
      assertNoSecrets(mine, `GET ${path}`);
    }
    assert.equal((await api('POST', '/job-applications', guard.token, { jobId })).status, 409, 'a duplicate application is still refused');
    pass('S01-APPLY: applying and listing applications return the Guard view only');

    const companyView = await api('GET', `/jobs/${jobId}`, alpha.token);
    assert.equal(companyView.status, 200, errText(companyView));
    assert.equal(Number(companyView.body.billingRate), SECRET.billingRate, 'the company still sees its billing rate');
    assert.equal(companyView.body.site?.id, site.body.id, 'and its site');
    const companyApplications = await api('GET', '/job-applications', alpha.token);
    assert.equal(companyApplications.status, 200, errText(companyApplications));
    assert.equal(companyApplications.body.length, 2, 'the company pipeline is unchanged');
    pass('S01-COMPANY-UNCHANGED: the posting company still reads its own job in full');

    const adminView = await api('GET', `/jobs/${jobId}`, admin.token);
    assert.equal(adminView.status, 200, errText(adminView));
    assert.equal(Number(adminView.body.billingRate), SECRET.billingRate);
    assert.ok((await api('GET', '/jobs', admin.token)).body.some((j: any) => j.id === jobId));
    pass('S01-ADMIN-UNCHANGED: a platform administrator still reads the full job');

    const beta = await registerCompany('beta');
    assert.equal((await decide(beta.companyId!, 'approved')).status, 200);
    assert.equal((await api('GET', `/jobs/${jobId}`, beta.token)).status, 404, 'another company cannot read the job');
    assert.ok(!(await api('GET', '/jobs', beta.token)).body.some((j: any) => j.id === jobId), 'nor list it');
    pass('S01-TENANT: another company cannot read or list the job');

    const closedJob = await api('POST', '/jobs', alpha.token, { title: `Closed ${RUN}`, guardsRequired: 1, hourlyRate: 14 });
    assert.equal(closedJob.status, 201, errText(closedJob));
    await q(`UPDATE jobs SET status = 'closed' WHERE id = $1`, [closedJob.body.id]);
    assert.equal((await api('GET', `/jobs/${closedJob.body.id}`, guard.token)).status, 404);
    assert.ok(!(await api('GET', '/jobs', guard.token)).body.some((j: any) => j.id === closedJob.body.id));
    pass('S01-OPEN-ONLY: a job that is not open is not shown to a Guard');

    // ── S03: suspension ──
    const suspendNoReason = await decide(alphaId, 'suspended');
    assert.equal(suspendNoReason.status, 400);
    const suspended = await decide(alphaId, 'suspended', 'Insurance certificate expired.');
    assert.equal(suspended.status, 200, errText(suspended));
    expectNotApproved(await ops.job(), 'suspended', 'suspended: create job');
    expectNotApproved(await ops.client(), 'suspended', 'suspended: create client');
    expectNotApproved(await api('PATCH', '/companies/me', alpha.token, { name: 'Renamed' }), 'suspended', 'suspended: details locked');
    assert.equal((await api('GET', `/jobs/${jobId}`, alpha.token)).status, 200, 'suspended: still reads its own records');
    assert.ok(!(await api('GET', '/jobs', guard.token)).body.some((j: any) => j.company?.id === alphaId), 'hidden from discovery');
    assert.equal((await api('GET', `/jobs/${jobId}`, guard.token)).status, 404, 'a Guard cannot open it');
    const guard3 = await registerGuard('seeker3');
    const applySuspended = await api('POST', '/job-applications', guard3.token, { jobId });
    assert.equal(applySuspended.status, 404, `a Guard cannot apply: ${applySuspended.text}`);
    const preview = await api('POST', '/guards/me/invitations/preview', guard3.token, { code: invitation.body.code });
    assert.equal(preview.status, 404, `the invitation is refused: ${preview.text}`);
    assert.equal(preview.body.message, 'That invitation code is not valid.', 'with the generic message');
    const acceptSuspended = await api('POST', '/guards/me/invitations/accept', guard3.token, { code: invitation.body.code });
    assert.equal(acceptSuspended.status, 404);
    assert.equal(Number((await q(`SELECT count(*) n FROM company_guards WHERE "companyId" = $1 AND "guardId" = $2`, [alphaId, guard3.guardId]))[0].n), 0);
    pass('S03-SUSPENDED: a suspended company cannot operate; its jobs and invitations are closed to Guards');

    const reinstated = await decide(alphaId, 'approved');
    assert.equal(reinstated.status, 200, errText(reinstated));
    assert.equal((await api('GET', `/jobs/${jobId}`, guard3.token)).status, 200);
    const accepted = await api('POST', '/guards/me/invitations/accept', guard3.token, { code: invitation.body.code });
    assert.ok(accepted.status === 200 || accepted.status === 201, `accept: ${accepted.status} ${accepted.text}`);
    assert.equal((await ops.job()).status, 201);
    pass('S03-REINSTATED: an approved company operates again and its jobs and invitations return');

    const pendingCo = await registerCompany('gamma');
    await q(`INSERT INTO jobs ("companyId", title, "guardsRequired", "hourlyRate", status) VALUES ($1, $2, 1, 20, 'open')`,
      [pendingCo.companyId, `Pending-company job ${RUN}`]);
    const [{ id: pendingJobId }] = await q(`SELECT id FROM jobs WHERE "companyId" = $1`, [pendingCo.companyId]);
    assert.ok(!(await api('GET', '/jobs', guard.token)).body.some((j: any) => j.id === pendingJobId));
    assert.equal((await api('GET', `/jobs/${pendingJobId}`, guard.token)).status, 404);
    assert.equal((await api('POST', '/job-applications', guard.token, { jobId: pendingJobId })).status, 404);
    pass('S03-UNAPPROVED-JOBS-HIDDEN: a pending company\'s job is never shown to a Guard');

    const audit = await q(
      `SELECT "beforeData", "afterData", "userId" FROM audit_logs WHERE action = 'company.verification_changed' AND "entityId" = $1 ORDER BY id`,
      [alphaId]);
    assert.deepEqual(audit.map((a: any) => [a.beforeData.verificationStatus, a.afterData.verificationStatus]),
      [['pending_verification', 'rejected'], ['rejected', 'approved'], ['approved', 'suspended'], ['suspended', 'approved']]);
    assert.ok(audit.every((a: any) => Number(a.userId) === admin.userId), 'every decision is attributed to the administrator');
    pass('S03-AUDIT: every verification decision is audited with before and after');

    const listPending = await api('GET', '/admin/companies/verification?status=pending_verification', admin.token);
    assert.equal(listPending.status, 200, errText(listPending));
    assert.ok(listPending.body.some((c: any) => c.id === pendingCo.companyId) && !listPending.body.some((c: any) => c.id === alphaId));

    const freshGuard = await registerGuard('fresh');
    const guardMe = await api('GET', '/jobs', freshGuard.token);
    assert.equal(guardMe.status, 200, 'a newly registered Guard can discover jobs with no verification or screening step');
    pass('S03-GUARD-REGISTRATION: Guard self-registration is unaffected');

    console.log(JSON.stringify({ event: 'sec_public_launch_tests_passed', tests: passed }));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
