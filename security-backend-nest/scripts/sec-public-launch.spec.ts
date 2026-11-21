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
 *   S03-PENDING-REFUSED     pending: new operations (job, Guard invitation, shift, rota slot) are 403 COMPANY_NOT_APPROVED
 *                           with the refused capability, and nothing is created
 *   S03-PENDING-SETUP       pending: account setup (clients, sites) is allowed by the capability policy (Phase 1
 *                           refused it too)
 *   S03-PENDING-TENANT      pending: its draft clients and sites are tenant-scoped; jobs, shifts, invitations, hires and
 *                           assignments stay refused until approval
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
 *   S03-RECONSIDERATION     rejected → asks for reconsideration → pending; only from rejected; Guards cannot; audited
 *   S03-SUSPENDED-SAFETY    suspended: safety and existing-obligation routes pass the policy (a missing record answers
 *                           404, never COMPANY_NOT_APPROVED); setup and new operations are refused
 *   S04-GUARD-RESPONSES     a Guard's shifts, timesheets, notifications and assignments never carry the company owner's
 *                           account, the client's contacts, the billing rate or the margin
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
    const expectNotApproved = (r: Res, status: string, what: string, capability?: string) => {
      assert.equal(r.status, 403, `${what}: ${r.status} ${r.text}`);
      assert.equal(r.body.code, 'COMPANY_NOT_APPROVED', what);
      assert.equal(r.body.verificationStatus, status, what);
      if (capability) assert.equal(r.body.capability, capability, `${what}: capability`);
    };
    /** The capability policy let the request through (whatever the route itself then answered). */
    const expectPolicyAllows = (r: Res, what: string) => {
      assert.notEqual(r.body?.code, 'COMPANY_NOT_APPROVED', `${what}: refused by the policy: ${r.text}`);
      assert.ok(r.status < 500, `${what}: ${r.status} ${r.text}`);
    };
    const counts = async (companyId: number) => (await q(
      `SELECT (SELECT count(*) FROM clients WHERE "companyId" = $1)::int AS clients,
              (SELECT count(*) FROM sites WHERE "companyId" = $1)::int AS sites,
              (SELECT count(*) FROM jobs WHERE "companyId" = $1)::int AS jobs,
              (SELECT count(*) FROM company_guard_invitations WHERE "companyId" = $1)::int AS invitations`, [companyId]))[0];

    const ops = operational(alpha);
    expectNotApproved(await ops.job(), 'pending_verification', 'pending: create job', 'new_operations');
    expectNotApproved(await ops.invitation(), 'pending_verification', 'pending: issue invitation', 'new_operations');
    expectNotApproved(await api('POST', '/shifts', alpha.token, { siteName: 'Nope', start: new Date(Date.now() + 864e5).toISOString(),
      end: new Date(Date.now() + 900e5).toISOString() }), 'pending_verification', 'pending: create shift', 'new_operations');
    expectNotApproved(await api('POST', '/rota-slots', alpha.token, {}), 'pending_verification', 'pending: create rota slot', 'new_operations');
    assert.deepEqual(await counts(alphaId), { clients: 0, sites: 0, jobs: 0, invitations: 0 }, 'nothing was created');
    assert.equal(Number((await q(`SELECT count(*) n FROM shifts WHERE "companyId" = $1`, [alphaId]))[0].n), 0, 'no shift was created');
    pass('S03-PENDING-REFUSED: pending companies cannot publish jobs, invite Guards or create shifts; nothing is created');

    const pendingClient = await api('POST', '/clients', alpha.token, { name: `Setup client ${RUN}` });
    assert.equal(pendingClient.status, 201, `pending: create client (setup): ${errText(pendingClient)}`);
    const pendingSite = await api('POST', '/sites', alpha.token, { name: `Setup site ${RUN}`, address: '1 Way', clientId: pendingClient.body.id });
    assert.equal(pendingSite.status, 201, `pending: create site (setup): ${errText(pendingSite)}`);
    assert.deepEqual(await counts(alphaId), { clients: 1, sites: 1, jobs: 0, invitations: 0 });
    pass('S03-PENDING-SETUP: a pending company may set up clients and sites');

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
    expectNotApproved(await ops.client(), 'rejected', 'rejected: create client', 'setup');
    pass('S03-REJECTED: a rejected company sees the reason, may correct its details and cannot operate');

    const ownStatus = await api('GET', '/companies/me/verification', alpha.token);
    assert.equal(ownStatus.status, 200, errText(ownStatus));
    assert.equal(ownStatus.body.verificationStatus, 'rejected');
    assert.deepEqual(Object.keys(ownStatus.body).sort(), ['verificationDecidedAt', 'verificationNote', 'verificationStatus'],
      'only the company\'s own status, S4\'s note to it and the decision time');
    assert.equal(ownStatus.body.verificationNote, 'Companies House number does not match the company name.');
    assert.equal((await api('GET', '/companies/me/verification', outsiderGuard.token)).status, 403, 'a Guard cannot read it');
    assert.equal((await api('POST', '/companies/me/verification/reconsideration', outsiderGuard.token, {})).status, 403, 'a Guard cannot');
    const reconsider = await api('POST', '/companies/me/verification/reconsideration', alpha.token, { message: 'Companies House number corrected.' });
    assert.equal(reconsider.status, 200, errText(reconsider));
    assert.equal(reconsider.body.verificationStatus, 'pending_verification');
    assert.equal(reconsider.body.verificationNote, null, 'the old reason is cleared from the company record');
    assert.equal(await verificationOf(alphaId), 'pending_verification');
    const again = await api('POST', '/companies/me/verification/reconsideration', alpha.token, {});
    assert.equal(again.status, 403, 'a pending company has nothing to reconsider (the capability is rejected-only)');
    assert.equal(again.body.capability, 'reconsideration');
    const [reconAudit] = await q(`SELECT "beforeData", "afterData", "userId" FROM audit_logs WHERE action = 'company.verification_reconsideration_requested' AND "entityId" = $1`, [alphaId]);
    assert.equal(reconAudit.afterData.message, 'Companies House number corrected.');
    assert.equal(reconAudit.beforeData.verificationNote, 'Companies House number does not match the company name.', 'the reason is kept in the audit log');
    assert.equal(Number(reconAudit.userId), alpha.userId);
    expectNotApproved(await ops.job(), 'pending_verification', 'reconsidering: still cannot operate', 'new_operations');
    pass('S03-RECONSIDERATION: a rejected company asks for reconsideration and waits as pending; audited');

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
    const betaStatus = await api('GET', '/companies/me/verification', beta.token);
    assert.equal(betaStatus.status, 200, errText(betaStatus));
    assert.equal(betaStatus.body.verificationStatus, 'approved', 'each company reads only its own verification');
    assert.ok(!betaStatus.text.includes('Companies House number'), 'never another company\'s note');
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
    expectNotApproved(await ops.job(), 'suspended', 'suspended: create job', 'new_operations');
    expectNotApproved(await ops.client(), 'suspended', 'suspended: create client', 'setup');
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

    const missing = 2147483000;
    const probes: Array<[string, string, unknown]> = [
      ['PATCH', `/alerts/${missing}/ack`, {}],
      ['PATCH', `/alerts/${missing}/close`, {}],
      ['PATCH', `/incidents/${missing}/status`, { status: 'resolved' }],
      ['POST', `/patrols/exceptions/${missing}/acknowledge`, {}],
      ['POST', '/attendance/manual/book-off', { shiftId: missing }],
      ['POST', `/shifts/${missing}/reconcile-without-book-off`, {}],
      ['DELETE', `/rota-slots/${missing}/positions/${missing}`, undefined],
      ['PATCH', `/timesheets/${missing}`, {}],
      ['PATCH', `/notifications/${missing}/read`, {}],
    ];
    for (const [method, path, body] of probes) expectPolicyAllows(await api(method, path, alpha.token, body), `suspended: ${method} ${path}`);
    expectNotApproved(await api('POST', '/rota-slots', alpha.token, {}), 'suspended', 'suspended: create rota slot', 'new_operations');
    expectNotApproved(await api('PUT', '/patrols/policies/default', alpha.token, {}), 'suspended', 'suspended: patrol policy', 'setup');
    pass('S03-SUSPENDED-SAFETY: a suspended company keeps safety handling and existing obligations, not setup or new work');

    const reinstated = await decide(alphaId, 'approved');
    assert.equal(reinstated.status, 200, errText(reinstated));
    assert.equal((await api('GET', `/jobs/${jobId}`, guard3.token)).status, 200);
    const accepted = await api('POST', '/guards/me/invitations/accept', guard3.token, { code: invitation.body.code });
    assert.ok(accepted.status === 200 || accepted.status === 201, `accept: ${accepted.status} ${accepted.text}`);
    assert.equal((await ops.job()).status, 201);
    pass('S03-REINSTATED: an approved company operates again and its jobs and invitations return');

    // ── S04: what a Guard is shown of its own work ──
    // guard3 now works for alpha. A shift at the client's site on the billed job, an invoiced timesheet and a notification
    // from the company: each loaded entity's eager relations reach the owner account, the client and the billing rate.
    const start = new Date(Date.now() + 864e5);
    const [{ id: shiftId }] = await q(
      `INSERT INTO shifts ("companyId", "guardId", "siteId", "jobId", "siteName", start, "end", status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready') RETURNING id`,
      [alphaId, guard3.guardId, site.body.id, jobId, `Riverside ${RUN}`, start, new Date(start.getTime() + 8 * 36e5)]);
    await q(
      `INSERT INTO timesheets ("shiftId", "guardId", "companyId", "approvalStatus", "hoursWorked", "billingRateSnapshot",
         "clientBilledHoursSnapshot", "billingStatus")
       VALUES ($1, $2, $3, 'approved', 8, $4, 8, 'invoiced')`, [shiftId, guard3.guardId, alphaId, SECRET.billingRate]);
    await q(`INSERT INTO notifications ("userId", "companyId", type, title, message) VALUES ($1, $2, 'job_assigned', 'New shift', $3)`,
      [guard3.userId, alphaId, `Shift ${RUN}`]);
    const NEVER_TO_A_GUARD = [ownerAddress, SECRET.clientContactName, SECRET.clientContactEmail, SECRET.clientContactPhone];
    const NEVER_KEYS = ['"billingRate"', '"billingRateSnapshot"', '"effectiveBillingRate"', '"revenueAmount"', '"marginAmount"',
      '"clientBilledHoursSnapshot"', '"billingStatus"', '"passwordHash"', '"email"', '"lastLoginAt"', '"companyNumber"',
      '"verificationNote"', '"contactEmail"', '"contactPhone"', '"contactName"', '"client"'];
    const assertGuardSafe = (r: Res, what: string) => {
      assert.equal(r.status, 200, `${what}: ${errText(r)}`);
      for (const v of NEVER_TO_A_GUARD) assert.ok(!r.text.includes(String(v)), `${what}: ${v} leaked`);
      for (const k of NEVER_KEYS) assert.ok(!r.text.includes(k), `${what}: ${k} present`);
    };
    const myShifts = await api('GET', '/shifts/my', guard3.token);
    assertGuardSafe(myShifts, 'GET /shifts/my');
    const mine = (Array.isArray(myShifts.body) ? myShifts.body : myShifts.body.items ?? []).find((x: any) => x.id === shiftId);
    assert.ok(mine, 'the Guard still sees its shift');
    assert.equal(mine.siteName, `Riverside ${RUN}`);
    assert.deepEqual(Object.keys(mine.company).sort(), ['id', 'name'], 'the employer is named, nothing more');
    assert.equal(mine.site.name, `Riverside ${RUN}`, 'the site it works at');
    assert.equal(mine.site.specialInstructions, SECRET.siteInstructions, 'and the site instructions it needs on shift');
    assert.equal(Number(mine.job.hourlyRate), 15.25, 'and its own pay rate');
    assertGuardSafe(await api('GET', '/shifts', guard3.token), 'GET /shifts');
    assertGuardSafe(await api('GET', `/shifts/${shiftId}`, guard3.token), 'GET /shifts/:id');
    const sheets = await api('GET', '/timesheets/mine', guard3.token);
    assertGuardSafe(sheets, 'GET /timesheets/mine');
    const sheet = sheets.body.find((t: any) => t.shift?.id === shiftId || t.shiftId === shiftId);
    assert.ok(sheet, 'the Guard still sees its timesheet');
    assert.equal(Number(sheet.hoursWorked), 8, 'with its hours');
    const notes = await api('GET', '/notifications/mine', guard3.token);
    assertGuardSafe(notes, 'GET /notifications/mine');
    const note = notes.body.find((n: any) => n.message === `Shift ${RUN}`);
    assert.ok(note, 'the Guard still sees its notification');
    assertGuardSafe(await api('PATCH', `/notifications/${note.id}/read`, guard3.token, {}), 'PATCH /notifications/:id/read');
    assertGuardSafe(await api('GET', '/assignments', guard3.token), 'GET /assignments');
    // The company still reads its own shift in full.
    const companyShift = await api('GET', `/shifts/${shiftId}`, alpha.token);
    assert.equal(companyShift.status, 200, errText(companyShift));
    assert.equal(Number(companyShift.body.job?.billingRate), SECRET.billingRate, 'the company still sees its billing rate');
    pass('S04-GUARD-RESPONSES: a Guard sees its shifts, timesheets and notifications without the owner account, client contacts or company money');

    const pendingCo = await registerCompany('gamma');
    await q(`INSERT INTO jobs ("companyId", title, "guardsRequired", "hourlyRate", status) VALUES ($1, $2, 1, 20, 'open')`,
      [pendingCo.companyId, `Pending-company job ${RUN}`]);
    const [{ id: pendingJobId }] = await q(`SELECT id FROM jobs WHERE "companyId" = $1`, [pendingCo.companyId]);
    assert.ok(!(await api('GET', '/jobs', guard.token)).body.some((j: any) => j.id === pendingJobId));
    assert.equal((await api('GET', `/jobs/${pendingJobId}`, guard.token)).status, 404);
    assert.equal((await api('POST', '/job-applications', guard.token, { jobId: pendingJobId })).status, 404);
    pass('S03-UNAPPROVED-JOBS-HIDDEN: a pending company\'s job is never shown to a Guard');

    // A pending company's setup records are its own drafts: tenant-scoped, invisible to other companies, unusable for
    // deploying anyone until approval.
    const gammaClient = await api('POST', '/clients', pendingCo.token, { name: `Gamma draft client ${RUN}` });
    assert.equal(gammaClient.status, 201, `pending: create client: ${errText(gammaClient)}`);
    const gammaSite = await api('POST', '/sites', pendingCo.token, { name: `Gamma draft site ${RUN}`, address: '3 Way', clientId: gammaClient.body.id });
    assert.equal(gammaSite.status, 201, `pending: create site: ${errText(gammaSite)}`);
    const [owned] = await q(`SELECT (SELECT "companyId" FROM clients WHERE id = $1) c, (SELECT "companyId" FROM sites WHERE id = $2) s`,
      [gammaClient.body.id, gammaSite.body.id]);
    assert.equal(Number(owned.c), pendingCo.companyId, 'the client belongs to the pending company');
    assert.equal(Number(owned.s), pendingCo.companyId, 'the site belongs to the pending company');
    for (const [path, id] of [['/clients', gammaClient.body.id], ['/sites', gammaSite.body.id]] as const) {
      const other = await api('GET', `${path}/${id}`, beta.token);
      assert.ok(other.status === 404 || other.status === 403, `another company reads ${path}/:id: ${other.status}`);
      const listed = await api('GET', path, beta.token);
      assert.equal(listed.status, 200);
      assert.ok(!JSON.stringify(listed.body).includes(`Gamma draft`), `another company lists the pending company's ${path}`);
    }
    const crossSite = await api('POST', '/sites', pendingCo.token, { name: `Cross-tenant site ${RUN}`, address: '4 Way', clientId: pendingClient.body.id });
    assert.ok(crossSite.status >= 400 && crossSite.status < 500, `a site on another company's client: ${crossSite.status} ${crossSite.text}`);
    assert.equal(Number((await q(`SELECT count(*) n FROM sites WHERE name = $1`, [`Cross-tenant site ${RUN}`]))[0].n), 0);
    const deploy: Array<[string, string, unknown]> = [
      ['POST', '/jobs', { title: `Gamma job ${RUN}`, guardsRequired: 1, hourlyRate: 15, siteId: gammaSite.body.id }],
      ['POST', '/shifts', { siteId: gammaSite.body.id, start: new Date(Date.now() + 864e5).toISOString(), end: new Date(Date.now() + 900e5).toISOString() }],
      ['POST', '/rota-slots', { siteId: gammaSite.body.id }],
      ['POST', '/company-guards/invitations', {}],
      ['POST', '/company-guards', {}],
      ['PUT', '/client-portal-users', { clientId: gammaClient.body.id }],
      ['POST', `/job-applications/${missing}/hire`, {}],
      ['POST', `/rota-slots/${missing}/assign`, {}],
      ['POST', `/rota-slots/${missing}/assign-multiple`, {}],
      ['POST', `/shifts/${missing}/replace-guard`, {}],
      ['PATCH', `/shifts/${missing}`, {}],
    ];
    for (const [method, path, body] of deploy) {
      expectNotApproved(await api(method, path, pendingCo.token, body), 'pending_verification', `pending: ${method} ${path}`, 'new_operations');
    }
    assert.equal(Number((await q(`SELECT count(*) n FROM shifts WHERE "companyId" = $1`, [pendingCo.companyId]))[0].n), 0);
    assert.equal(Number((await q(`SELECT count(*) n FROM company_guard_invitations WHERE "companyId" = $1`, [pendingCo.companyId]))[0].n), 0);
    pass('S03-PENDING-TENANT: a pending company\'s drafts are its own and cannot activate jobs, shifts, invitations or deployments');

    const audit = await q(
      `SELECT "beforeData", "afterData", "userId" FROM audit_logs WHERE action = 'company.verification_changed' AND "entityId" = $1 ORDER BY id`,
      [alphaId]);
    assert.deepEqual(audit.map((a: any) => [a.beforeData.verificationStatus, a.afterData.verificationStatus]),
      // (rejected → pending_verification in between is the company's own reconsideration request, audited separately)
      [['pending_verification', 'rejected'], ['pending_verification', 'approved'], ['approved', 'suspended'], ['suspended', 'approved']]);
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
