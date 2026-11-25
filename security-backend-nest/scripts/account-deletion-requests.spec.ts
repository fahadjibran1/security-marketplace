/**
 * S4 public release — the Platform Admin account-deletion queue.
 *
 * Boots the REAL application (AppModule, the production ValidationPipe, JwtStrategy, RolesGuard, the company capability
 * interceptor) against a real PostgreSQL schema built by the repository's migrations, and drives it over HTTP.
 *
 *   DEL-01  non-admins (Guard, company owner, company staff, client portal) and anonymous callers are refused every admin route
 *   DEL-02  a company owner's in-app request is recorded (self-service still 409) and appears in the queue with its company
 *   DEL-03  completion is refused (409, reason) while the owner's company has a shift in progress; nothing changes
 *   DEL-04  owner completion: company suspended through the audited verification decision, every membership revoked and
 *           the members' sessions ended, owner anonymised by the shared routine, no row deleted, audits present
 *   DEL-05  cross-tenant: another company, its owner and its members are untouched
 *   DEL-06  a never-approved company is closed by rejection, not left pending
 *   DEL-07  client portal login: status, request (recorded once), confirm still refused, shown in the queue
 *   DEL-08  client portal completion: login anonymised and cut off at once, the company's client record kept, audited
 *   DEL-09  Platform Admin: in-app request recorded but refused; never completed by itself; another admin completes it;
 *           never the last active admin
 *   DEL-10  emailed request recorded by an admin (users and client logins), idempotent, unknown address 404, then completed
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
  const { AccountDeletionAdminService, ACCOUNT_DELETION_ADMIN_CODES: CODES, OWNER_DELETION_COMPANY_NOTE } =
    await import('../src/auth/account-deletion-admin.service');
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
    await test('DEL-01-NON-ADMINS-AND-ANONYMOUS-ARE-REFUSED', async () => {
      const routes: Array<[string, string, unknown?]> = [
        ['GET', '/admin/account-deletion-requests'],
        ['POST', '/admin/account-deletion-requests', { email: guard.email }],
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

    // ═══════════════════════════════════ DEL-02 / 03 / 04 / 05 ══════════════════════════════════════════
    await test('DEL-02-OWNER-REQUEST-RECORDED-AND-QUEUED', async () => {
      const requested = await call('POST', '/account/deletion/request', {}, ownerAuth);
      assert.equal(requested.status, 200, requested.text);
      assert.equal(requested.body.blocker, 'company_owner');
      assert.match(requested.body.blockerMessage, /info@vesoft\.co\.uk/, 'the message names the support address');
      assert.equal((await call('POST', '/account/deletion/confirm', { password: PASSWORD }, ownerAuth)).status, 409, 'still not self-service');
      const queue = await call('GET', '/admin/account-deletion-requests', undefined, adminAAuth);
      assert.equal(queue.status, 200, queue.text);
      const row = queue.body.find((r: any) => r.kind === 'user' && r.id === owner.id);
      assert.ok(row, 'the owner is in the queue');
      assert.equal(row.accountType, 'company_owner');
      assert.equal(row.requestedBy, 'self');
      assert.deepEqual(row.companies.map((c: any) => [c.id, c.shiftsInProgress]), [[company.id, 1]]);
      assert.equal(row.blockedCode, CODES.SHIFTS_IN_PROGRESS, 'the queue says why it cannot be completed yet');
    });

    const retainedCounts = async () => ({
      companies: await repo(Company).count(),
      memberships: await repo(CompanyMembership).count(),
      shifts: await repo(Shift).count(),
      sites: await repo(Site).count(),
      clients: await repo(Client).count(),
      clientLogins: await repo(ClientPortalUser).count(),
      users: await repo(User).count(),
    });

    await test('DEL-03-REFUSED-WHILE-A-SHIFT-IS-IN-PROGRESS', async () => {
      const before = await retainedCounts();
      const r = await call('POST', `/admin/account-deletion-requests/users/${owner.id}/complete`, {}, adminAAuth);
      assert.equal(r.status, 409, r.text);
      assert.equal(r.body.code, CODES.SHIFTS_IN_PROGRESS);
      assert.match(r.body.message, /in progress/);
      assert.deepEqual(r.body.details.companies, [{ id: company.id, shiftsInProgress: 1 }]);
      const row = await repo(User).findOneByOrFail({ id: owner.id });
      assert.equal(row.deletionCompletedAt, null);
      assert.equal(row.email, owner.email);
      assert.equal((await repo(Company).findOneByOrFail({ id: company.id })).verificationStatus, CompanyVerificationStatus.APPROVED, 'company not closed');
      assert.equal((await repo(CompanyMembership).findOneByOrFail({ userId: staff.id })).status, CompanyMembershipStatus.ACTIVE);
      assert.deepEqual(await retainedCounts(), before);
      assert.equal((await auditsFor('account.deletion_completed_by_admin', 'user', owner.id)).length, 0);
    });

    await repo(Shift).update({ id: liveShift.id }, { status: 'completed' });
    const beforeOwnerCompletion = await retainedCounts();
    const otherSessionsBefore = await repo(AuthSession).count({ where: { user: { id: otherStaff.id } } });
    const ownerCompletion = await call('POST', `/admin/account-deletion-requests/users/${owner.id}/complete`, {}, adminAAuth);

    await test('DEL-04-OWNER-COMPLETION-CLOSES-COMPANY-ENDS-ACCESS-AND-ANONYMISES', async () => {
      assert.equal(ownerCompletion.status, 200, ownerCompletion.text);
      assert.equal(ownerCompletion.body.accountType, 'company_owner');
      assert.deepEqual(ownerCompletion.body.closedCompanyIds, [company.id]);

      const closed = await repo(Company).findOneByOrFail({ id: company.id });
      assert.equal(closed.verificationStatus, CompanyVerificationStatus.SUSPENDED, 'company closed for operations');
      assert.equal(closed.verificationNote, OWNER_DELETION_COMPANY_NOTE);
      const decision = await repo(AuditLog).findOneOrFail({ where: { action: 'company.verification_changed', entityId: company.id } });
      assert.equal(decision.user?.id, adminA.id, 'the closure is an audited verification decision by the admin');

      const memberships = await repo(CompanyMembership).find({ where: { companyId: company.id } });
      assert.equal(memberships.length, 2, 'membership rows kept');
      assert.ok(memberships.every((m) => m.status === CompanyMembershipStatus.REVOKED && m.disabledByUserId === adminA.id && m.disabledAt));
      const staffSessions = await repo(AuthSession).find({ where: { user: { id: staff.id } } });
      assert.ok(staffSessions.length >= 1 && staffSessions.every((s) => s.revokedAt && s.revokedReason === 'company_closed'));
      assert.equal((await call('POST', '/auth/refresh', { refreshToken: staffMobile.refreshToken })).status, 401, 'member session ended');
      assert.equal((await call('GET', '/companies/me/verification', undefined, staffAuth)).status, 403, 'member access ended even with a live access token');
      const staffRow = await repo(User).findOneByOrFail({ id: staff.id });
      assert.equal(staffRow.email, staff.email, 'a member\'s own account is not deleted');

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

      assert.deepEqual(await retainedCounts(), beforeOwnerCompletion, 'no row deleted');
      assert.equal((await repo(Shift).findOneByOrFail({ id: liveShift.id })).status, 'completed', 'operational records untouched');

      const completed = await auditsFor('account.deletion_completed_by_admin', 'user', owner.id);
      assert.equal(completed.length, 1);
      assert.equal(completed[0].user?.id, adminA.id);
      assert.deepEqual((completed[0].afterData as any).closedCompanyIds, [company.id]);
      const closure = await auditsFor('company.closed_for_owner_deletion', 'company', company.id);
      assert.equal(closure.length, 1);
      assert.deepEqual((closure[0].afterData as any).memberUserIds, [staff.id]);

      const queue = await call('GET', '/admin/account-deletion-requests', undefined, adminAAuth);
      assert.ok(!queue.body.some((r: any) => r.kind === 'user' && r.id === owner.id), 'completed requests leave the queue');
    });

    await test('DEL-05-OTHER-TENANTS-UNTOUCHED', async () => {
      assert.equal((await repo(Company).findOneByOrFail({ id: otherCompany.id })).verificationStatus, CompanyVerificationStatus.APPROVED);
      const rows = await repo(CompanyMembership).find({ where: { companyId: otherCompany.id } });
      assert.ok(rows.length === 2 && rows.every((m) => m.status === CompanyMembershipStatus.ACTIVE));
      assert.equal((await repo(User).findOneByOrFail({ id: otherOwner.id })).email, otherOwner.email);
      assert.equal(await repo(AuthSession).count({ where: { user: { id: otherStaff.id } } }), otherSessionsBefore);
      const otherAuth = bearer((await login(otherStaff.email)).accessToken);
      assert.equal((await call('GET', '/companies/me/verification', undefined, otherAuth)).status, 200, 'the other company still works');
    });

    await test('DEL-06-NEVER-APPROVED-COMPANY-IS-CLOSED-BY-REJECTION', async () => {
      const recorded = await call('POST', '/admin/account-deletion-requests', { email: pendingOwner.email }, adminAAuth);
      assert.equal(recorded.status, 200, recorded.text);
      const done = await call('POST', `/admin/account-deletion-requests/users/${pendingOwner.id}/complete`, {}, adminAAuth);
      assert.equal(done.status, 200, done.text);
      const row = await repo(Company).findOneByOrFail({ id: pendingCompany.id });
      assert.equal(row.verificationStatus, CompanyVerificationStatus.REJECTED);
      assert.equal(row.verificationNote, OWNER_DELETION_COMPANY_NOTE);
      assert.equal((await repo(User).findOneByOrFail({ id: pendingOwner.id })).email, deletedAccountEmail(pendingOwner.id));
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
      assert.equal((await auditsFor('account.deletion_requested', 'client_portal_user', clientLoginRow.id)).length, 1);
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
    await test('DEL-10-EMAILED-REQUEST-RECORDED-BY-ADMIN-THEN-COMPLETED', async () => {
      const recorded = await call('POST', '/admin/account-deletion-requests', { email: '  DEL.Guard@Example.invalid ' }, adminAAuth);
      assert.equal(recorded.status, 400, 'surrounding spaces are not an email (validation)');
      const ok = await call('POST', '/admin/account-deletion-requests', { email: 'DEL.Guard@Example.invalid' }, adminAAuth);
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.body.alreadyRequested, false);
      assert.equal(ok.body.request.requestedBy, 'admin');
      assert.equal(ok.body.request.accountType, 'guard');
      assert.ok((await repo(User).findOneByOrFail({ id: guard.id })).deletionRequestedAt);
      const again = await call('POST', '/admin/account-deletion-requests', { email: guard.email }, adminAAuth);
      assert.equal(again.body.alreadyRequested, true);
      const audits = await auditsFor('account.deletion_requested_by_admin', 'user', guard.id);
      assert.equal(audits.length, 1, 'recorded once');
      assert.equal(audits[0].user?.id, adminA.id);

      const unknown = await call('POST', '/admin/account-deletion-requests', { email: 'nobody.here@example.invalid' }, adminAAuth);
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.code, CODES.NOT_FOUND);

      const clientRecorded = await call('POST', '/admin/account-deletion-requests', { email: emailedClientRow.email }, adminAAuth);
      assert.equal(clientRecorded.status, 200, clientRecorded.text);
      assert.equal(clientRecorded.body.request.kind, 'client_portal_user');
      assert.equal(clientRecorded.body.request.requestedBy, 'admin');

      const guardDone = await call('POST', `/admin/account-deletion-requests/users/${guard.id}/complete`, {}, adminAAuth);
      assert.equal(guardDone.status, 200, guardDone.text);
      assert.equal((await repo(User).findOneByOrFail({ id: guard.id })).email, deletedAccountEmail(guard.id));
      assert.equal((await call('GET', '/auth/me', undefined, guardAuth)).status, 401);
      const clientDone = await call('POST', `/admin/account-deletion-requests/client-portal-users/${emailedClientRow.id}/complete`, {}, adminAAuth);
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
      const reRecord = await call('POST', '/admin/account-deletion-requests', { email: deletedAccountEmail(guard.id) }, adminAAuth);
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
        .where('a.action IN (:...actions)', { actions: ['account.deletion_requested', 'account.deletion_requested_by_admin', 'account.deletion_completed_by_admin', 'company.closed_for_owner_deletion'] })
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
