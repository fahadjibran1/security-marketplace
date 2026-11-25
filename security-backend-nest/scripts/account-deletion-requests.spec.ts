/**
 * S4 public release — the Platform Admin account-deletion queue.
 *
 * Boots the REAL application (AppModule, the production ValidationPipe, JwtStrategy, RolesGuard, the company capability
 * interceptor) against a real PostgreSQL schema built by the repository's migrations, and drives it over HTTP.
 *
 *   DEL-01  non-admins (Guard, company owner, company staff, client portal) and anonymous callers are refused every admin
 *           route, including the preview
 *   DEL-02  a company owner's in-app request is recorded (requestedVia in_app; self-service still 409) and queued, blocked
 *   DEL-03  completion refused (409 ACCOUNT_DELETION_OWNER_HAS_ACTIVE_COMPANY) while the company is approved: company
 *           unchanged, members still active, no session ended, no row changed
 *   DEL-04  the preview is ids and counts only (incl. an unpaid payroll batch), writes nothing, 404 for an unknown user
 *   DEL-05  closed through the verification decide route; still refused while a shift is in progress, then while a
 *           future shift exists
 *   DEL-06  after closure and with no shifts outstanding, completion anonymises the owner only: company status and note
 *           as the verification decision left them, memberships and members' sessions untouched, no row deleted
 *   DEL-06B cross-tenant: another company, its owner and its members are untouched
 *   DEL-06C pending company with an emailed owner request: 400 without identityConfirmed, 409 while pending, completes
 *           only after a separate rejection through the verification route
 *   DEL-07  client portal login: status, request (recorded once, in_app), confirm still refused, shown in the queue
 *   DEL-08  client portal completion: login anonymised and cut off at once, the company's client record kept, audited
 *   DEL-09  Platform Admin: in-app request recorded but refused; never completed by itself; another admin completes it;
 *           never the last active admin
 *   DEL-10  emailed request: 400 without valid verificationMethod / verificationNote, both audited; completion 400 without
 *           identityConfirmed: true (users and client logins), then completed
 *   DEL-11  no completion without a recorded request; a completed account cannot be completed or recorded again
 *   DEL-12  deletion audit entries carry ids only: no former email, name or phone
 *
 * Needs ACCOUNT_DELETION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as bcrypt from 'bcrypt';
import { DataSource, Repository } from 'typeorm';
import { appEntities } from '../src/database/entities';
import { CompanyVerificationStatus } from '../src/company/company-verification';

const url = process.env.ACCOUNT_DELETION_DATABASE_URL;
if (!url) throw new Error('ACCOUNT_DELETION_DATABASE_URL is required (use a disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw new Error('ACCOUNT_DELETION_DATABASE_URL must point at a local disposable database');
}

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = url;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.JWT_SECRET = 'account-deletion-certification-only-secret';
delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_FROM;
delete process.env.SENTRY_DSN;
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

let ipCounter = 0;
const freshIp = () => `198.51.100.${(ipCounter = (ipCounter % 250) + 1)}, 10.0.0.${ipCounter}`;

async function main() {
  const migrationsGlob = require('node:path').join(__dirname, '..', 'src', 'database', 'migrations', '*.ts');
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: true,
    migrations: [migrationsGlob], migrationsTableName: 'typeorm_migrations', logging: false,
  });
  await ds.initialize();
  await ds.runMigrations({ transaction: 'each' });

  const { User, UserRole, UserStatus } = await import('../src/user/entities/user.entity');
  const { Company } = await import('../src/company/entities/company.entity');
  const { Site } = await import('../src/site/entities/site.entity');
  const { Shift } = await import('../src/shift/entities/shift.entity');
  const { Client } = await import('../src/client/entities/client.entity');
  const { ClientPortalUser } = await import('../src/client-portal-user/entities/client-portal-user.entity');
  const { CompanyMembership } = await import('../src/company-membership/entities/company-membership.entity');
  const { CompanyMembershipRole, CompanyMembershipStatus } = await import('../src/company-membership/company-membership-types');
  const { AuditLog } = await import('../src/audit-log/entities/audit-log.entity');
  const { AuthSession } = await import('../src/auth/entities/auth-session.entity');
  const { AppModule } = await import('../src/app.module');
  const { deletedAccountEmail, deletedClientPortalEmail } = await import('../src/auth/account-deletion.service');
  const { AccountDeletionAdminService, ACCOUNT_DELETION_ADMIN_CODES: CODES } = await import('../src/auth/account-deletion-admin.service');
  const { DELETED_ACCOUNT_PASSWORD_SENTINEL } = await import('../src/auth/password-policy');

  const repo = <T extends object>(entity: new () => T): Repository<T> => ds.getRepository(entity);

  const app: INestApplication = await NestFactory.create(AppModule, { logger: false });
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;

  type Reply = { status: number; body: any; text: string };
  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: response.status, body: parsed, text };
  }
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const PASSWORD = 'Delete-pass-1';
  const hash = await bcrypt.hash(PASSWORD, 4);

  async function makeUser(email: string, role: string, extra: Record<string, unknown> = {}) {
    return repo(User).save(repo(User).create({
      email, passwordHash: hash, role: role as never, status: UserStatus.ACTIVE, emailVerificationRequired: false,
      firstName: 'Fname', lastName: `Lname-${email.split('@')[0]}`, phone: '07700900555', ...extra,
    }));
  }
  async function login(email: string, mobile = false) {
    const r = await call('POST', '/auth/login', { email, password: PASSWORD }, mobile ? { 'x-s4-client': 'mobile' } : {});
    assert.equal(r.status, 201, r.text);
    return r.body as { accessToken: string; refreshToken?: string };
  }
  async function clientLogin(email: string) {
    const r = await call('POST', '/auth/client-login', { email, password: PASSWORD });
    assert.equal(r.status, 201, r.text);
    return r.body.accessToken as string;
  }
  async function makeCompany(owner: { id: number }, name: string, status: CompanyVerificationStatus) {
    const company = await repo(Company).save(repo(Company).create({
      verificationStatus: status, user: owner as never, name, companyNumber: String(10000000 + Math.floor(Math.random() * 8999999)),
      address: '1 Test Street', contactDetails: 'ops@example.invalid',
    }));
    await repo(CompanyMembership).save(repo(CompanyMembership).create({
      userId: owner.id, companyId: company.id, membershipRole: CompanyMembershipRole.OWNER, status: CompanyMembershipStatus.ACTIVE,
    }));
    return company;
  }
  async function addMember(user: { id: number }, company: { id: number }, role = CompanyMembershipRole.OPERATIONS) {
    return repo(CompanyMembership).save(repo(CompanyMembership).create({
      userId: user.id, companyId: company.id, membershipRole: role, status: CompanyMembershipStatus.ACTIVE,
    }));
  }
  const auditsFor = (action: string, entityType: string, entityId: number) =>
    repo(AuditLog).find({ where: { action, entityType, entityId }, order: { id: 'ASC' } });

  try {
    // ── fixtures ────────────────────────────────────────────────────────────────────────────────────────
    const adminA = await makeUser('del.admin.a@example.invalid', UserRole.ADMIN);
    const adminB = await makeUser('del.admin.b@example.invalid', UserRole.ADMIN);
    const adminC = await makeUser('del.admin.c@example.invalid', UserRole.ADMIN);

    const owner = await makeUser('del.owner@example.invalid', UserRole.COMPANY_ADMIN);
    const company = await makeCompany(owner, 'Deletion Owner Security Ltd', CompanyVerificationStatus.APPROVED);
    const staff = await makeUser('del.staff@example.invalid', UserRole.COMPANY_STAFF);
    await addMember(staff, company);
    const site = await repo(Site).save(repo(Site).create({ company, name: 'DEL SITE', address: '2 Test Street', timezone: 'Europe/London' }));
    const liveShift = await repo(Shift).save(repo(Shift).create({
      company, site, siteName: site.name, start: new Date(Date.now() - 3600_000), end: new Date(Date.now() + 3600_000), status: 'in_progress',
    }));
    const client = await repo(Client).save({ company, name: 'Deletion Client Ltd' } as InstanceType<typeof Client>);
    const clientLoginRow = await repo(ClientPortalUser).save(repo(ClientPortalUser).create({
      client, email: 'del.client@example.invalid', passwordHash: hash, firstName: 'Clara', lastName: 'Client', role: UserRole.CLIENT_ADMIN, isActive: true,
    }));
    const emailedClientRow = await repo(ClientPortalUser).save(repo(ClientPortalUser).create({
      client, email: 'del.client.two@example.invalid', passwordHash: hash, firstName: 'Cliff', lastName: 'Second', role: UserRole.CLIENT_VIEWER, isActive: true,
    }));

    const otherOwner = await makeUser('del.other.owner@example.invalid', UserRole.COMPANY_ADMIN);
    const otherCompany = await makeCompany(otherOwner, 'Other Tenant Security Ltd', CompanyVerificationStatus.APPROVED);
    const otherStaff = await makeUser('del.other.staff@example.invalid', UserRole.COMPANY_STAFF);
    await addMember(otherStaff, otherCompany);

    const pendingOwner = await makeUser('del.pending.owner@example.invalid', UserRole.COMPANY_ADMIN);
    const pendingCompany = await makeCompany(pendingOwner, 'Never Approved Ltd', CompanyVerificationStatus.PENDING_VERIFICATION);

    const guard = await makeUser('del.guard@example.invalid', UserRole.GUARD);

    const adminAAuth = bearer((await login(adminA.email)).accessToken);
    const ownerSession = await login(owner.email);
    const ownerAuth = bearer(ownerSession.accessToken);
    const staffMobile = await login(staff.email, true);
    const staffAuth = bearer(staffMobile.accessToken);
    const guardAuth = bearer((await login(guard.email)).accessToken);
    const clientAuth = bearer(await clientLogin(clientLoginRow.email));

    // ═══════════════════════════════════ DEL-01 ═════════════════════════════════════════════════════════
    const VERIFIED = { verificationMethod: 'request_from_registered_email', verificationNote: 'Sent from the registered address' };
    await test('DEL-01-NON-ADMINS-AND-ANONYMOUS-ARE-REFUSED', async () => {
      const routes: Array<[string, string, unknown?]> = [
        ['GET', '/admin/account-deletion-requests'],
        ['POST', '/admin/account-deletion-requests', { email: guard.email, ...VERIFIED }],
        ['GET', `/admin/account-deletion-requests/users/${owner.id}/preview`],
        ['POST', `/admin/account-deletion-requests/users/${guard.id}/complete`, {}],
        ['POST', `/admin/account-deletion-requests/client-portal-users/${clientLoginRow.id}/complete`, {}],
      ];
      for (const [method, path, body] of routes) {
        assert.equal((await call(method, path, body)).status, 401, `${method} ${path} anonymous`);
        for (const [label, auth] of [['guard', guardAuth], ['owner', ownerAuth], ['staff', staffAuth], ['client', clientAuth]] as const) {
          const r = await call(method, path, body, auth);
          assert.equal(r.status, 403, `${label} ${method} ${path}: ${r.text}`);
        }
      }
      assert.equal((await repo(User).findOneByOrFail({ id: guard.id })).deletionRequestedAt, null, 'nothing was recorded');
      assert.equal(await repo(AuditLog).count({ where: { action: 'account.deletion_requested_by_admin' } }), 0);
    });

    // ═══════════════════════════════════ DEL-02 … DEL-06 company owners ═════════════════════════════════
    await test('DEL-02-OWNER-REQUEST-RECORDED-IN-APP-AND-QUEUED', async () => {
      const requested = await call('POST', '/account/deletion/request', {}, ownerAuth);
      assert.equal(requested.status, 200, requested.text);
      assert.equal(requested.body.blocker, 'company_owner');
      assert.match(requested.body.blockerMessage, /support@sfour\.co\.uk/, 'the message names the support address');
      assert.match(requested.body.blockerMessage, /stays pending/);
      assert.match(requested.body.blockerMessage, /never closes the company/);
      assert.equal((await call('POST', '/account/deletion/confirm', { password: PASSWORD }, ownerAuth)).status, 409, 'still not self-service');
      const audit = await auditsFor('account.deletion_requested', 'user', owner.id);
      assert.equal(audit.length, 1);
      assert.equal((audit[0].afterData as any).requestedVia, 'in_app', 'an in-app request is authenticated by the session');
      const queue = await call('GET', '/admin/account-deletion-requests', undefined, adminAAuth);
      assert.equal(queue.status, 200, queue.text);
      const row = queue.body.find((r: any) => r.kind === 'user' && r.id === owner.id);
      assert.ok(row, 'the owner is in the queue');
      assert.equal(row.accountType, 'company_owner');
      assert.equal(row.requestedBy, 'self');
      assert.deepEqual(row.companies.map((c: any) => [c.id, c.verificationStatus, c.closed, c.shiftsInProgress]), [[company.id, 'approved', false, 1]]);
      assert.equal(row.blockedCode, CODES.OWNER_HAS_ACTIVE_COMPANY, 'the queue says why it cannot be completed yet');
      assert.match(row.blockedReason, /Company verification/);
    });

    const retainedCounts = async () => ({
      companies: await repo(Company).count(),
      memberships: await repo(CompanyMembership).count(),
      activeMemberships: await repo(CompanyMembership).count({ where: { status: CompanyMembershipStatus.ACTIVE } }),
      shifts: await repo(Shift).count(),
      sites: await repo(Site).count(),
      clients: await repo(Client).count(),
      clientLogins: await repo(ClientPortalUser).count(),
      users: await repo(User).count(),
      payrollBatches: Number((await ds.query('SELECT count(*) AS n FROM payroll_batches'))[0].n),
      revokedSessions: await repo(AuthSession).createQueryBuilder('s').where('s.revokedAt IS NOT NULL').getCount(),
    });
    const staffSessionsUnrevoked = () => repo(AuthSession).createQueryBuilder('s')
      .where('s.userId = :id AND s.revokedAt IS NULL', { id: staff.id }).getCount();

    await test('DEL-03-OWNER-COMPLETION-REFUSED-WHILE-COMPANY-IS-APPROVED', async () => {
      const before = await retainedCounts();
      const liveStaffSessions = await staffSessionsUnrevoked();
      const r = await call('POST', `/admin/account-deletion-requests/users/${owner.id}/complete`, {}, adminAAuth);
      assert.equal(r.status, 409, r.text);
      assert.equal(r.body.code, CODES.OWNER_HAS_ACTIVE_COMPANY);
      assert.match(r.body.message, /never closes a company/);
      assert.match(r.body.message, /Company verification screen/, '(a) a separate, authorised closure decision');
      assert.match(r.body.message, /transfer of ownership with S4 support at support@sfour\.co\.uk/, '(b) a transfer of ownership');
      assert.match(r.body.message, /stays pending/);
      assert.deepEqual(r.body.details.companies, [{ id: company.id, verificationStatus: 'approved' }]);
      const row = await repo(User).findOneByOrFail({ id: owner.id });
      assert.equal(row.deletionCompletedAt, null);
      assert.ok(row.deletionRequestedAt, 'the request stays pending');
      assert.equal(row.email, owner.email);
      const unchanged = await repo(Company).findOneByOrFail({ id: company.id });
      assert.equal(unchanged.verificationStatus, CompanyVerificationStatus.APPROVED, 'company not closed');
      assert.equal(unchanged.verificationNote ?? null, company.verificationNote ?? null);
      assert.equal((await repo(CompanyMembership).findOneByOrFail({ userId: staff.id })).status, CompanyMembershipStatus.ACTIVE, 'members still active');
      assert.equal(await staffSessionsUnrevoked(), liveStaffSessions, 'no member session ended');
      assert.equal((await call('GET', '/companies/me/verification', undefined, staffAuth)).status, 200, 'the team keeps working');
      assert.deepEqual(await retainedCounts(), before);
      assert.equal(await repo(AuditLog).count({ where: { action: 'company.verification_changed', entityId: company.id } }), 0, 'no closure decision was made');
      assert.equal((await auditsFor('account.deletion_completed_by_admin', 'user', owner.id)).length, 0);
    });

    await test('DEL-04-PREVIEW-IS-ADMIN-ONLY-IDS-AND-COUNTS', async () => {
      await ds.query(`INSERT INTO payroll_batches ("companyId", "periodStart", "periodEnd") VALUES ($1, now() - interval '7 days', now())`, [company.id]);
      const before = await retainedCounts();
      const r = await call('GET', `/admin/account-deletion-requests/users/${owner.id}/preview`, undefined, adminAAuth);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(Object.keys(r.body).sort(), ['accountType', 'blockedCode', 'canComplete', 'companies', 'identityConfirmationRequired', 'kind', 'requestedVia', 'userId']);
      assert.equal(r.body.userId, owner.id);
      assert.equal(r.body.requestedVia, 'in_app');
      assert.equal(r.body.identityConfirmationRequired, false);
      assert.equal(r.body.blockedCode, CODES.OWNER_HAS_ACTIVE_COMPANY);
      assert.equal(r.body.canComplete, false);
      assert.deepEqual(r.body.companies, [{
        companyId: company.id, verificationStatus: 'approved', closed: false, shiftsInProgress: 1, futureShifts: 0,
        timesheetsAwaitingApproval: 0, approvedTimesheetsNotPaid: 0, invoiceBatchesNotPaid: 0, payrollBatchesNotPaid: 1,
        clientWeeklyApprovalsOpen: 0, clientShiftDisputesOpen: 0,
      }]);
      for (const value of Object.values(r.body.companies[0])) assert.ok(['number', 'string', 'boolean'].includes(typeof value));
      for (const forbidden of [owner.email, company.name, 'Fname', 'Lname-', '07700900555']) {
        assert.ok(!r.text.includes(forbidden), `the preview carries ids and counts only, not ${forbidden}`);
      }
      assert.deepEqual(await retainedCounts(), before, 'the preview writes nothing');
      assert.equal((await call('GET', '/admin/account-deletion-requests/users/999999/preview', undefined, adminAAuth)).status, 404);
    });

    await test('DEL-05-CLOSED-THROUGH-VERIFICATION-THEN-SHIFTS-STILL-BLOCK', async () => {
      // (a) A separate, authorised closure decision through the existing Company verification route, audited there.
      const decided = await call('PUT', `/admin/companies/${company.id}/verification`, { status: 'suspended', reason: 'Closing at the owner\'s request' }, adminAAuth);
      assert.equal(decided.status, 200, decided.text);
      const decisions = await repo(AuditLog).find({ where: { action: 'company.verification_changed', entityId: company.id } });
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].user?.id, adminA.id);

      // Closed, but a shift is still in progress.
      const inProgress = await call('POST', `/admin/account-deletion-requests/users/${owner.id}/complete`, {}, adminAAuth);
      assert.equal(inProgress.status, 409, inProgress.text);
      assert.equal(inProgress.body.code, CODES.COMPANY_SHIFTS_OUTSTANDING);
      assert.deepEqual(inProgress.body.details.companies, [{ id: company.id, shiftsInProgress: 1, futureShifts: 0 }]);

      // The shift finishes, but a future shift is scheduled.
      await repo(Shift).update({ id: liveShift.id }, { status: 'completed' });
      const future = await repo(Shift).save(repo(Shift).create({
        company, site, siteName: site.name, start: new Date(Date.now() + 86_400_000), end: new Date(Date.now() + 90_000_000), status: 'ready',
      }));
      const futureRefusal = await call('POST', `/admin/account-deletion-requests/users/${owner.id}/complete`, {}, adminAAuth);
      assert.equal(futureRefusal.status, 409, futureRefusal.text);
      assert.equal(futureRefusal.body.code, CODES.COMPANY_SHIFTS_OUTSTANDING);
      assert.match(futureRefusal.body.message, /scheduled to start in the future/);
      assert.deepEqual(futureRefusal.body.details.companies, [{ id: company.id, shiftsInProgress: 0, futureShifts: 1 }]);
      const queue = await call('GET', '/admin/account-deletion-requests', undefined, adminAAuth);
      assert.equal(queue.body.find((r: any) => r.kind === 'user' && r.id === owner.id).blockedCode, CODES.COMPANY_SHIFTS_OUTSTANDING);
      assert.equal((await repo(User).findOneByOrFail({ id: owner.id })).deletionCompletedAt, null);
      await repo(Shift).update({ id: future.id }, { status: 'cancelled' });
    });

    const beforeOwnerCompletion = await retainedCounts();
    const staffLiveBeforeCompletion = await staffSessionsUnrevoked();
    const otherSessionsBefore = await repo(AuthSession).count({ where: { user: { id: otherStaff.id } } });
    const ownerCompletion = await call('POST', `/admin/account-deletion-requests/users/${owner.id}/complete`, {}, adminAAuth);

    await test('DEL-06-OWNER-COMPLETION-AFTER-CLOSURE-LEAVES-COMPANY-AND-MEMBERS-UNTOUCHED', async () => {
      assert.equal(ownerCompletion.status, 200, ownerCompletion.text);
      assert.equal(ownerCompletion.body.accountType, 'company_owner');
      assert.deepEqual(ownerCompletion.body.ownedCompanyIds, [company.id]);
      assert.equal(ownerCompletion.body.closedCompanyIds, undefined, 'deletion closes nothing');

      const closed = await repo(Company).findOneByOrFail({ id: company.id });
      assert.equal(closed.verificationStatus, CompanyVerificationStatus.SUSPENDED, 'still exactly as the verification decision left it');
      assert.equal(closed.verificationNote, 'Closing at the owner\'s request');
      assert.equal(await repo(AuditLog).count({ where: { action: 'company.verification_changed', entityId: company.id } }), 1, 'no second decision');
      assert.equal(await repo(AuditLog).count({ where: { action: 'company.closed_for_owner_deletion' } }), 0);

      const memberships = await repo(CompanyMembership).find({ where: { companyId: company.id }, order: { id: 'ASC' } });
      assert.equal(memberships.length, 2, 'membership rows kept');
      assert.ok(memberships.every((m) => m.status === CompanyMembershipStatus.ACTIVE && !m.disabledAt), 'memberships untouched by the deletion');
      assert.equal(await staffSessionsUnrevoked(), staffLiveBeforeCompletion, 'no member session ended');
      const refreshed = await call('POST', '/auth/refresh', { refreshToken: staffMobile.refreshToken });
      assert.ok(refreshed.status >= 200 && refreshed.status < 300, `member session still works: ${refreshed.text}`);
      assert.equal((await repo(User).findOneByOrFail({ id: staff.id })).email, staff.email, 'a member\'s own account is not deleted');

      const ownerRow = await repo(User).createQueryBuilder('u').addSelect('u.passwordHash').where('u.id = :id', { id: owner.id }).getOneOrFail();
      assert.equal(ownerRow.email, deletedAccountEmail(owner.id), 'the shared anonymisation ran');
      assert.equal(ownerRow.firstName, null);
      assert.equal(ownerRow.lastName, null);
      assert.equal(ownerRow.phone, null);
      assert.equal(ownerRow.passwordHash, DELETED_ACCOUNT_PASSWORD_SENTINEL);
      assert.equal(ownerRow.status, UserStatus.INACTIVE);
      assert.ok(ownerRow.deletionCompletedAt);
      assert.ok((await repo(AuthSession).find({ where: { user: { id: owner.id } } })).every((s) => s.revokedAt));
      assert.equal((await call('POST', '/auth/login', { email: owner.email, password: PASSWORD })).status, 401);
      assert.equal((await call('GET', '/auth/me', undefined, ownerAuth)).status, 401);

      const after = await retainedCounts();
      assert.deepEqual({ ...after, revokedSessions: 0 }, { ...beforeOwnerCompletion, revokedSessions: 0 }, 'no row deleted, no membership changed');
      assert.ok(after.revokedSessions > beforeOwnerCompletion.revokedSessions, 'only the owner\'s own sessions ended');

      const completed = await auditsFor('account.deletion_completed_by_admin', 'user', owner.id);
      assert.equal(completed.length, 1);
      assert.equal(completed[0].user?.id, adminA.id);
      const data = completed[0].afterData as any;
      assert.equal(data.requestedVia, 'in_app');
      assert.equal(data.identityConfirmed, null);
      assert.deepEqual(data.ownedCompanies, [{ id: company.id, verificationStatus: 'suspended' }]);

      const queue = await call('GET', '/admin/account-deletion-requests', undefined, adminAAuth);
      assert.ok(!queue.body.some((r: any) => r.kind === 'user' && r.id === owner.id), 'completed requests leave the queue');
    });

    await test('DEL-06B-OTHER-TENANTS-UNTOUCHED', async () => {
      assert.equal((await repo(Company).findOneByOrFail({ id: otherCompany.id })).verificationStatus, CompanyVerificationStatus.APPROVED);
      const rows = await repo(CompanyMembership).find({ where: { companyId: otherCompany.id } });
      assert.ok(rows.length === 2 && rows.every((m) => m.status === CompanyMembershipStatus.ACTIVE));
      assert.equal((await repo(User).findOneByOrFail({ id: otherOwner.id })).email, otherOwner.email);
      assert.equal(await repo(AuthSession).count({ where: { user: { id: otherStaff.id } } }), otherSessionsBefore);
      const otherAuth = bearer((await login(otherStaff.email)).accessToken);
      assert.equal((await call('GET', '/companies/me/verification', undefined, otherAuth)).status, 200, 'the other company still works');
    });

    await test('DEL-06C-PENDING-COMPANY-EMAILED-OWNER-NEEDS-IDENTITY-AND-A-SEPARATE-REJECTION', async () => {
      const recorded = await call('POST', '/admin/account-deletion-requests', { email: pendingOwner.email, ...VERIFIED }, adminAAuth);
      assert.equal(recorded.status, 200, recorded.text);
      const path = `/admin/account-deletion-requests/users/${pendingOwner.id}/complete`;
      const noIdentity = await call('POST', path, {}, adminAAuth);
      assert.equal(noIdentity.status, 400, noIdentity.text);
      assert.equal(noIdentity.body.code, CODES.IDENTITY_NOT_CONFIRMED);
      const pending = await call('POST', path, { identityConfirmed: true }, adminAAuth);
      assert.equal(pending.status, 409, pending.text);
      assert.equal(pending.body.code, CODES.OWNER_HAS_ACTIVE_COMPANY, 'pending verification is not closed');
      assert.equal((await repo(Company).findOneByOrFail({ id: pendingCompany.id })).verificationStatus, CompanyVerificationStatus.PENDING_VERIFICATION, 'not rejected by the deletion');
      const preview = await call('GET', `/admin/account-deletion-requests/users/${pendingOwner.id}/preview`, undefined, adminAAuth);
      assert.equal(preview.body.requestedVia, 'admin_recorded');
      assert.equal(preview.body.identityConfirmationRequired, true);

      const rejected = await call('PUT', `/admin/companies/${pendingCompany.id}/verification`, { status: 'rejected', reason: 'Registration withdrawn' }, adminAAuth);
      assert.equal(rejected.status, 200, rejected.text);
      const done = await call('POST', path, { identityConfirmed: true }, adminAAuth);
      assert.equal(done.status, 200, done.text);
      const row = await repo(Company).findOneByOrFail({ id: pendingCompany.id });
      assert.equal(row.verificationStatus, CompanyVerificationStatus.REJECTED);
      assert.equal(row.verificationNote, 'Registration withdrawn');
      assert.equal((await repo(User).findOneByOrFail({ id: pendingOwner.id })).email, deletedAccountEmail(pendingOwner.id));
      const audit = (await auditsFor('account.deletion_completed_by_admin', 'user', pendingOwner.id))[0].afterData as any;
      assert.equal(audit.requestedVia, 'admin_recorded');
      assert.equal(audit.identityConfirmed, true);
    });

    // ═══════════════════════════════════ DEL-07 / 08 client portal ═══════════════════════════════════════
    await test('DEL-07-CLIENT-PORTAL-REQUEST-RECORDED-ONCE-AND-QUEUED', async () => {
      const status = await call('GET', '/account/deletion', undefined, clientAuth);
      assert.equal(status.status, 200, status.text);
      assert.equal(status.body.deletionRequestedAt, null);
      assert.equal(status.body.selfServiceAvailable, false);
      assert.equal(status.body.blocker, 'client_portal');
      const first = await call('POST', '/account/deletion/request', {}, clientAuth);
      assert.equal(first.status, 200, first.text);
      assert.ok(first.body.deletionRequestedAt);
      const second = await call('POST', '/account/deletion/request', {}, clientAuth);
      assert.equal(second.body.deletionRequestedAt, first.body.deletionRequestedAt, 'the first request is kept');
      const requestAudits = await auditsFor('account.deletion_requested', 'client_portal_user', clientLoginRow.id);
      assert.equal(requestAudits.length, 1);
      assert.equal((requestAudits[0].afterData as any).requestedVia, 'in_app');
      assert.equal((await call('POST', '/account/deletion/confirm', { password: PASSWORD }, clientAuth)).status, 403, 'a client login never self-completes');
      const queue = await call('GET', '/admin/account-deletion-requests', undefined, adminAAuth);
      const row = queue.body.find((r: any) => r.kind === 'client_portal_user' && r.id === clientLoginRow.id);
      assert.ok(row);
      assert.equal(row.accountType, 'client_portal');
      assert.equal(row.client.companyId, company.id);
      assert.equal(row.blockedCode, null);
    });

    await test('DEL-08-CLIENT-PORTAL-COMPLETION', async () => {
      const r = await call('POST', `/admin/account-deletion-requests/client-portal-users/${clientLoginRow.id}/complete`, {}, adminAAuth);
      assert.equal(r.status, 200, r.text);
      const row = await repo(ClientPortalUser).createQueryBuilder('c').addSelect('c.passwordHash').where('c.id = :id', { id: clientLoginRow.id }).getOneOrFail();
      assert.equal(row.email, deletedClientPortalEmail(clientLoginRow.id));
      assert.equal(row.firstName, '');
      assert.equal(row.lastName, '');
      assert.equal(row.passwordHash, DELETED_ACCOUNT_PASSWORD_SENTINEL);
      assert.equal(row.isActive, false);
      assert.equal((await call('GET', '/account/deletion', undefined, clientAuth)).status, 401, 'the live token stops working at once');
      assert.equal((await call('POST', '/auth/client-login', { email: clientLoginRow.email, password: PASSWORD })).status, 401);
      assert.equal((await call('POST', '/auth/client-login', { email: row.email, password: DELETED_ACCOUNT_PASSWORD_SENTINEL })).status, 401);
      assert.ok(await repo(Client).findOneBy({ id: client.id }), 'the company\'s client record is kept');
      const audit = await auditsFor('account.deletion_completed_by_admin', 'client_portal_user', clientLoginRow.id);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].company?.id, company.id);
      const again = await call('POST', `/admin/account-deletion-requests/client-portal-users/${clientLoginRow.id}/complete`, {}, adminAAuth);
      assert.equal(again.status, 409);
      assert.equal(again.body.code, CODES.ALREADY_DELETED);
    });

    // ═══════════════════════════════════ DEL-09 platform admins ══════════════════════════════════════════
    await test('DEL-09-PLATFORM-ADMIN-NEVER-SELF-NEVER-LAST', async () => {
      const bAuth = bearer((await login(adminB.email)).accessToken);
      const own = await call('POST', '/account/deletion/request', {}, bAuth);
      assert.equal(own.status, 200);
      assert.equal(own.body.blocker, 'platform_admin', 'in-app: recorded but refused');
      assert.equal((await call('POST', '/account/deletion/confirm', { password: PASSWORD }, bAuth)).status, 409);

      const bQueue = await call('GET', '/admin/account-deletion-requests', undefined, bAuth);
      assert.equal(bQueue.body.find((r: any) => r.id === adminB.id).blockedCode, CODES.SELF, 'the queue tells an admin it cannot complete its own');
      const self = await call('POST', `/admin/account-deletion-requests/users/${adminB.id}/complete`, {}, bAuth);
      assert.equal(self.status, 403, self.text);
      assert.equal(self.body.code, CODES.SELF);
      assert.equal((await repo(User).findOneByOrFail({ id: adminB.id })).deletionCompletedAt, null);

      const byA = await call('POST', `/admin/account-deletion-requests/users/${adminB.id}/complete`, {}, adminAAuth);
      assert.equal(byA.status, 200, byA.text);
      assert.equal(byA.body.accountType, 'platform_admin');
      assert.equal((await repo(User).findOneByOrFail({ id: adminB.id })).status, UserStatus.INACTIVE);
      assert.equal((await call('GET', '/admin/account-deletion-requests', undefined, bAuth)).status, 401, 'the deleted admin is cut off');

      // Leave A as the only active admin, then prove A can never be removed — not by itself, and not by anyone.
      await repo(User).update({ id: adminC.id }, { status: UserStatus.SUSPENDED });
      await call('POST', '/account/deletion/request', {}, adminAAuth);
      const last = await call('POST', `/admin/account-deletion-requests/users/${adminA.id}/complete`, {}, adminAAuth);
      assert.equal(last.status, 403, 'self first');
      const service = app.get(AccountDeletionAdminService);
      await assert.rejects(
        service.completeUser({ sub: adminC.id, role: UserRole.ADMIN } as never, adminA.id),
        (error: any) => error.getResponse().code === CODES.LAST_PLATFORM_ADMIN,
      );
      assert.equal((await repo(User).findOneByOrFail({ id: adminA.id })).status, UserStatus.ACTIVE);
      const queue = await call('GET', '/admin/account-deletion-requests', undefined, adminAAuth);
      assert.equal(queue.body.find((r: any) => r.id === adminA.id).blockedCode, CODES.SELF);
      await repo(User).update({ id: adminC.id }, { status: UserStatus.ACTIVE });
    });


    // ═══════════════════════════════════ DEL-10 emailed requests ═════════════════════════════════════════
    await test('DEL-10-EMAILED-REQUEST-NEEDS-VERIFICATION-AND-IDENTITY-CONFIRMATION', async () => {
      const record = (body: Record<string, unknown>) => call('POST', '/admin/account-deletion-requests', body, adminAAuth);
      for (const [label, body] of [
        ['no verification fields', { email: guard.email }],
        ['no note', { email: guard.email, verificationMethod: 'other_verified' }],
        ['no method', { email: guard.email, verificationNote: 'Called back' }],
        ['unknown method', { email: guard.email, verificationMethod: 'trust_me', verificationNote: 'Called back' }],
        ['blank note', { email: guard.email, verificationMethod: 'other_verified', verificationNote: '   ' }],
        ['note too long', { email: guard.email, verificationMethod: 'other_verified', verificationNote: 'x'.repeat(201) }],
        ['spaces around the email', { email: '  DEL.Guard@Example.invalid ', ...VERIFIED }],
      ] as const) {
        const r = await record(body);
        assert.equal(r.status, 400, `${label}: ${r.text}`);
      }
      assert.equal((await repo(User).findOneByOrFail({ id: guard.id })).deletionRequestedAt, null, 'nothing recorded by a refused request');
      assert.equal((await auditsFor('account.deletion_requested_by_admin', 'user', guard.id)).length, 0);

      const ok = await record({ email: 'DEL.Guard@Example.invalid', verificationMethod: 'confirmed_in_app_by_user', verificationNote: 'User confirmed in the app' });
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.body.alreadyRequested, false);
      assert.equal(ok.body.request.requestedBy, 'admin');
      assert.equal(ok.body.request.accountType, 'guard');
      assert.ok((await repo(User).findOneByOrFail({ id: guard.id })).deletionRequestedAt);
      const again = await record({ email: guard.email, ...VERIFIED });
      assert.equal(again.body.alreadyRequested, true);
      const audits = await auditsFor('account.deletion_requested_by_admin', 'user', guard.id);
      assert.equal(audits.length, 1, 'recorded once');
      assert.equal(audits[0].user?.id, adminA.id);
      const data = audits[0].afterData as any;
      assert.equal(data.requestedVia, 'admin_recorded');
      assert.equal(data.verificationMethod, 'confirmed_in_app_by_user');
      assert.equal(data.verificationNote, 'User confirmed in the app');

      const unknown = await record({ email: 'nobody.here@example.invalid', ...VERIFIED });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.code, CODES.NOT_FOUND);

      const clientRecorded = await record({ email: emailedClientRow.email, ...VERIFIED });
      assert.equal(clientRecorded.status, 200, clientRecorded.text);
      assert.equal(clientRecorded.body.request.kind, 'client_portal_user');
      assert.equal(clientRecorded.body.request.requestedBy, 'admin');
      const clientAudit = (await auditsFor('account.deletion_requested_by_admin', 'client_portal_user', emailedClientRow.id))[0].afterData as any;
      assert.equal(clientAudit.verificationMethod, VERIFIED.verificationMethod);

      // Completion of an emailed request needs identityConfirmed: true.
      const guardPath = `/admin/account-deletion-requests/users/${guard.id}/complete`;
      for (const body of [{}, { identityConfirmed: false }]) {
        const refused = await call('POST', guardPath, body, adminAAuth);
        assert.equal(refused.status, 400, refused.text);
        assert.equal(refused.body.code, CODES.IDENTITY_NOT_CONFIRMED);
      }
      assert.equal((await call('POST', guardPath, { identityConfirmed: 'yes' }, adminAAuth)).status, 400, 'a boolean only');
      assert.equal((await repo(User).findOneByOrFail({ id: guard.id })).email, guard.email, 'nothing changed');
      const guardDone = await call('POST', guardPath, { identityConfirmed: true }, adminAAuth);
      assert.equal(guardDone.status, 200, guardDone.text);
      assert.equal((await repo(User).findOneByOrFail({ id: guard.id })).email, deletedAccountEmail(guard.id));
      assert.equal((await call('GET', '/auth/me', undefined, guardAuth)).status, 401);
      const guardAudit = (await auditsFor('account.deletion_completed_by_admin', 'user', guard.id))[0].afterData as any;
      assert.equal(guardAudit.requestedVia, 'admin_recorded');
      assert.equal(guardAudit.identityConfirmed, true);

      const clientPath = `/admin/account-deletion-requests/client-portal-users/${emailedClientRow.id}/complete`;
      const clientRefused = await call('POST', clientPath, {}, adminAAuth);
      assert.equal(clientRefused.status, 400, clientRefused.text);
      assert.equal(clientRefused.body.code, CODES.IDENTITY_NOT_CONFIRMED);
      assert.equal((await repo(ClientPortalUser).findOneByOrFail({ id: emailedClientRow.id })).email, emailedClientRow.email, 'nothing changed');
      const clientDone = await call('POST', clientPath, { identityConfirmed: true }, adminAAuth);
      assert.equal(clientDone.status, 200, clientDone.text);
    });

    await test('DEL-11-NO-REQUEST-NO-COMPLETION-AND-NO-REPEAT', async () => {
      const r = await call('POST', `/admin/account-deletion-requests/users/${otherStaff.id}/complete`, {}, adminAAuth);
      assert.equal(r.status, 409);
      assert.equal(r.body.code, CODES.NOT_REQUESTED);
      assert.equal((await repo(User).findOneByOrFail({ id: otherStaff.id })).deletionCompletedAt, null);
      const again = await call('POST', `/admin/account-deletion-requests/users/${guard.id}/complete`, {}, adminAAuth);
      assert.equal(again.status, 409);
      assert.equal(again.body.code, CODES.ALREADY_DELETED);
      const reRecord = await call('POST', '/admin/account-deletion-requests', { email: deletedAccountEmail(guard.id), ...VERIFIED }, adminAAuth);
      assert.equal(reRecord.status, 409);
      const missing = await call('POST', '/admin/account-deletion-requests/users/999999/complete', {}, adminAAuth);
      assert.equal(missing.status, 404);
      const noClientRequest = await repo(ClientPortalUser).save(repo(ClientPortalUser).create({
        client, email: 'del.client.three@example.invalid', passwordHash: hash, firstName: 'No', lastName: 'Request', role: UserRole.CLIENT_VIEWER, isActive: true,
      }));
      const c = await call('POST', `/admin/account-deletion-requests/client-portal-users/${noClientRequest.id}/complete`, {}, adminAAuth);
      assert.equal(c.status, 409);
      assert.equal(c.body.code, CODES.NOT_REQUESTED);
    });

    await test('DEL-12-DELETION-AUDITS-CARRY-IDS-ONLY', async () => {
      const entries = await repo(AuditLog).createQueryBuilder('a')
        .where('a.action IN (:...actions)', { actions: ['account.deletion_requested', 'account.deletion_requested_by_admin', 'account.deletion_completed_by_admin'] })
        .getMany();
      assert.ok(entries.length >= 10, `found ${entries.length} entries`);
      const dump = JSON.stringify(entries.map((e) => [e.beforeData, e.afterData]));
      for (const forbidden of [owner.email, guard.email, pendingOwner.email, adminB.email, clientLoginRow.email, emailedClientRow.email, '07700900555', 'Clara', 'Cliff', 'Lname-']) {
        assert.ok(!dump.includes(forbidden), `audit data contains ${forbidden}`);
      }
    });
  } finally {
    await app.close();
    await ds.destroy();
  }

  console.log(JSON.stringify({ event: 'account_deletion_requests_passed', tests: passed }));
}

main().catch((error) => {
  console.error('FAIL ', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
