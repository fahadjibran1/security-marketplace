/**
 * Company staff management certification (owner-approved 27 Oct 2026): the whole application over HTTP, on a
 * disposable database built from the repository's own migrations. No migration is added by this feature.
 *
 *   CS-01  the pure rules: assignable roles, Owner-only senior roles, self / account-holder / last-Owner refusals,
 *          account role per membership role, which existing accounts may accept
 *   CS-02  who may use it: Owner and Admin only; Operations, Control Room, HR, Finance, Viewer, Guards, platform
 *          admins and unauthenticated callers refused
 *   CS-03  invite: the link is emailed only (never in a response), only its SHA-256 is stored, audited without it;
 *          Admin cannot invite an Owner or Admin; an existing member of this company is a 409
 *   CS-04  preview: company, role, address, whether an account exists; generic refusal; writes nothing
 *   CS-05  accept, new address: password required; the invitee's own password (bcrypt, via UserService.create),
 *          verified address, company_staff / company_admin account role, ACTIVE membership, invitation spent, session
 *          permissions exactly the membership's; the link is single-use
 *   CS-06  an address that belongs to a Guard: the inviting company sees the same response as for anyone; preview and
 *          accept refused generically; the Guard account is untouched; the refusal is never in the company's audit
 *   CS-07  an address that belongs to another company's member or holder: refused generically, nothing changes
 *   CS-08  an existing eligible account (removed elsewhere): linked without its password, sessions or other company
 *          rows changing — a password sent with the acceptance is ignored (no takeover)
 *   CS-09  roles: Owner promotes; Admin manages only non-senior roles; nobody changes themselves or the account holder;
 *          the account role follows; leaving Control Room clears the grants
 *   CS-10  Owners: co-Owner invited by the Owner; a company always keeps an active Owner
 *   CS-11  Control Room grants through the existing endpoints: Owner/Admin only, Control Room only, company-scoped,
 *          reflected in the staff list and in the member's session permissions
 *   CS-12  suspend: immediate loss of access (company routes 403, refresh session revoked, no permissions),
 *          reactivate restores it; Admin cannot suspend an Admin
 *   CS-13  remove: REVOKED, grants cleared, sessions revoked; re-invitation restores the same row
 *   CS-14  isolation: another company's member, invitation and history are 404 / absent
 *   CS-15  invitations: re-send replaces the link, withdraw kills it, a new invitation supersedes an older one, Admin
 *          cannot touch an Owner/Admin invitation, an expired link is refused, the hourly cap holds
 *   CS-16  history: ids, actions, actors, targets, timestamps; nothing but the whitelisted fields; Owner/Admin only
 *   CS-17  no invitation token in any response, audit row or table; the email escapes company-entered text
 *   CS-18  wiring: module, routes, release gate, CI database
 *   CS-19  the Control Room / Operations / Admin job as INVITED members (never the account holder): every dashboard
 *          load call, Live Operations projection, alerts, incidents, daily logs, Close without Book Off, manual Book
 *          On / Off, extensions, Mark Missed — the full status matrix, 403 only where the membership lacks the
 *          permission or under the documented owner-only rule for non-compliance alerts
 *   CS-20  the widened route guards (incident status, Mark Missed / shift edit, replace Guard) still refuse Viewer,
 *          Finance, HR, Guards, platform admins, Control Room (shifts.manage), suspended members and other companies
 *   CS-21  /notifications/company: an invited member sees only notifications addressed to them in their company
 *   CS-22  the actions took effect, recorded against the member who performed them
 *
 * Needs COMPANY_STAFF_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

const url = process.env.COMPANY_STAFF_DATABASE_URL;
if (!url) throw new Error('COMPANY_STAFF_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Company staff database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'company-staff-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
// The development outbox is the only way this suite can read an invitation link.
delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_FROM;
delete process.env.S4_WEB_APP_URL;
delete process.env.EXPO_ACCESS_TOKEN;
delete process.env.PUSH_WELFARE_REMINDERS_ENABLED;
delete process.env.PUSH_GUARD_NOTIFICATIONS_ENABLED;

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

type Res = { status: number; body: any; text: string };
const PASSWORD = 'company-staff-spec-only-password-1';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
let ip = 0;
/** A fresh client address per call, so the per-IP throttle on the public routes only bites where intended. */
const freshIp = () => `203.0.113.${(ip = (ip % 250) + 1)}`;

async function main() {
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const migrator = new DataSource({
    ...buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' }),
    dropSchema: true,
  } as never);
  await migrator.initialize();
  const migrated = await migrator.runMigrations({ transaction: 'each' });
  // No migration of its own: company_memberships and company_invitations (Migration 1720800000005) carry everything.
  assert.ok(migrated.some((m) => m.name === 'AddCompanyMembershipAndInvitations1720800000005'), 'membership tables');
  assert.ok(migrated.some((m) => m.name === 'AddManualAttendance1720900000013'), 'the canManageAttendance column (Migration 67)');
  await migrator.destroy();

  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const base = `http://127.0.0.1:${address.port}`;
  const ds = app.get(DataSource);
  const [{ current_database: actualDatabase }] = await ds.query('SELECT current_database()');
  if (actualDatabase !== new URL(url!).pathname.slice(1)) throw new Error(`Refusing: connected to ${actualDatabase}`);

  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const { GuardNotificationService } = await import('../src/guard-notification/guard-notification.service');
  const { ShiftAmendmentService } = await import('../src/shift-amendment/shift-amendment.service');
  clearInterval((app.get(SafetyAlertService) as any).welfareInterval);
  clearInterval((app.get(GuardNotificationService) as any).retryInterval);
  clearInterval((app.get(ShiftAmendmentService) as any).expiryInterval);
  const { AuthService } = await import('../src/auth/auth.service');
  const { TransactionalEmailService } = await import('../src/email/transactional-email.service');
  const { companyStaffInvitationEmail } = await import('../src/email/company-staff-email.templates');
  const policy = await import('../src/company-staff/company-staff-policy');
  const {
    INVALID_STAFF_INVITATION, STAFF_INVITATION_NOT_ACCEPTABLE, STAFF_INVITATION_PASSWORD_REQUIRED, STAFF_INVITATIONS_PER_HOUR,
  } = await import('../src/company-staff/company-staff.service');
  const { CompanyMembershipRole: R, ROLE_PERMISSIONS } = await import('../src/company-membership/company-membership-types');
  const { UserRole } = await import('../src/user/entities/user.entity');
  const auth = app.get(AuthService);
  const outbox = app.get(TransactionalEmailService);
  assert.equal(outbox.transport, 'outbox', 'the suite reads links from the development outbox');

  const responses: string[] = [];
  const api = async (method: string, path: string, tok: string | null, body?: unknown): Promise<Res> => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp(), ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    responses.push(text);
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, text };
  };
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params);
  const one = async <T = any>(sql: string, params: unknown[] = []): Promise<T> => (await q<T>(sql, params))[0];
  const expect = (r: Res, status: number, what = '') =>
    assert.equal(r.status, status, `${what} expected ${status}, got ${r.status} ${r.text}`);

  const allTokens = new Set<string>();
  /** The token in the newest invitation email to an address. */
  const linkFor = (to: string) => {
    const message = [...outbox.capturedMessages()].reverse().find((m) => m.kind === 'company_staff_invitation' && m.to === to);
    if (!message) return null;
    const match = /https:\/\/[^\s"<]+\/accept-invitation\?token=([A-Za-z0-9_-]+)/.exec(message.text);
    assert.ok(match, 'the email carries an /accept-invitation link');
    allTokens.add(match[1]);
    return { token: match[1], message };
  };
  const preview = (token: string) => api('POST', '/auth/staff-invitations/preview', null, { token });
  const accept = (token: string, extra: Record<string, unknown> = {}) => api('POST', '/auth/staff-invitations/accept', null, { token, ...extra });

  try {
    const hash = await bcrypt.hash(PASSWORD, 4);
    const user = async (email: string, role: string) =>
      (await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
          VALUES ($1,$2,$3,'active',true,false,$4,'Spec') RETURNING id`, [email, hash, role, email.split('@')[0]])).id as number;
    const login = async (email: string, password = PASSWORD) => ((await auth.login({ email, password } as never)) as any).accessToken as string;
    const mobileLogin = async (email: string, password = PASSWORD) => (await auth.login({ email, password } as never, true)) as any;

    type Co = { id: number; ownerId: number; ownerEmail: string; token: string; name: string };
    const company = async (label: string, number: string, name = `${label} Security Ltd`): Promise<Co> => {
      const ownerEmail = `${label}.owner@example.invalid`;
      const ownerId = await user(ownerEmail, 'company_admin');
      const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,$2,$3,'1 Way','ops@example.invalid') RETURNING id`,
        [ownerId, name, number]);
      return { id: id as number, ownerId, ownerEmail, token: await login(ownerEmail), name };
    };
    const A = await company('csalpha', '68111111');
    const B = await company('csbeta', '68222222');
    const member = async (label: string, role: string, co: Co = A, status = 'active') => {
      const email = `${label}@example.invalid`;
      const id = await user(email, policy.userRoleForMembership(role as never));
      await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,$4)`, [id, co.id, role, status]);
      return { id, email, token: status === 'active' ? await login(email) : '', role };
    };
    const admin = await member('cs.admin', 'admin');
    const admin2 = await member('cs.admin2', 'admin');
    const ops = await member('cs.ops', 'operations');
    const control = await member('cs.control', 'control_room');
    const hr = await member('cs.hr', 'hr_compliance');
    const finance = await member('cs.finance', 'finance');
    const viewer = await member('cs.viewer', 'viewer');
    const bControl = await member('cs.b.control', 'control_room', B);
    const bAdmin = await member('cs.b.admin', 'admin', B);
    const guardEmail = 'cs.guard@example.invalid';
    const guardUserId = await user(guardEmail, 'guard');
    await q(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'Spec Guard','8600000000009901','07710800001')`, [guardUserId]);
    const guardToken = await login(guardEmail);
    await user('cs.platform@example.invalid', 'admin');
    const platform = await login('cs.platform@example.invalid');

    const membership = (userId: number, companyId = A.id) =>
      one(`SELECT id, "membershipRole"::text AS role, status::text AS status, "canAmendShifts", "canManageAttendance", "disabledByUserId"
             FROM company_memberships WHERE "userId" = $1 AND "companyId" = $2`, [userId, companyId]);
    const userRow = (id: number) => one(`SELECT id, email, role::text AS role, status::text AS status, "passwordHash", "isEmailVerified", "firstName" FROM users WHERE id = $1`, [id]);
    const activeOwners = async (co: Co) => {
      const rows = await q(`SELECT "userId" FROM company_memberships WHERE "companyId" = $1 AND "membershipRole" = 'owner' AND status = 'active'`, [co.id]);
      return new Set([co.ownerId, ...rows.map((r) => Number(r.userId))]).size;
    };

    // ═══ CS-01 ═══
    await test('CS-01-PURE-RULES', () => {
      assert.deepEqual(policy.assignableRoles(R.OWNER), Object.values(R), 'an Owner can give any role');
      assert.deepEqual(policy.assignableRoles(R.ADMIN), [R.OPERATIONS, R.CONTROL_ROOM, R.HR_COMPLIANCE, R.FINANCE, R.VIEWER], 'an Admin never Owner/Admin');
      for (const role of [R.OPERATIONS, R.CONTROL_ROOM, R.HR_COMPLIANCE, R.FINANCE, R.VIEWER]) assert.deepEqual(policy.assignableRoles(role), []);
      const owner = { userId: 1, role: R.OWNER };
      const adm = { userId: 2, role: R.ADMIN };
      const t = (userId: number, role: any, isPrimaryOwner = false) => ({ userId, role, isPrimaryOwner });
      assert.equal(policy.manageRefusal(adm, t(3, R.ADMIN)), 'senior_role_owner_only');
      assert.equal(policy.manageRefusal(adm, t(3, R.OWNER)), 'senior_role_owner_only');
      assert.equal(policy.manageRefusal(adm, t(3, R.VIEWER)), null);
      assert.equal(policy.manageRefusal(owner, t(3, R.ADMIN)), null);
      assert.equal(policy.manageRefusal(owner, t(1, R.OWNER)), 'self');
      assert.equal(policy.manageRefusal(owner, t(9, R.OWNER, true)), 'primary_owner');
      assert.equal(policy.manageRefusal({ userId: 4, role: R.OPERATIONS }, t(3, R.VIEWER)), 'not_a_manager');
      assert.equal(policy.roleChangeRefusal(adm, t(3, R.VIEWER), R.ADMIN, 1), 'role_not_assignable', 'Admin cannot promote to Admin');
      assert.equal(policy.roleChangeRefusal(owner, t(3, R.OWNER), R.ADMIN, 0), 'last_owner', 'the last Owner cannot be demoted');
      assert.equal(policy.roleChangeRefusal(owner, t(3, R.OWNER), R.ADMIN, 1), null);
      assert.equal(policy.accessChangeRefusal(owner, t(3, R.OWNER), 0), 'last_owner', 'nor suspended or removed');
      assert.equal(policy.accessChangeRefusal(owner, t(3, R.OWNER), 1), null);
      assert.equal(policy.userRoleForMembership(R.OWNER), UserRole.COMPANY_ADMIN);
      assert.equal(policy.userRoleForMembership(R.ADMIN), UserRole.COMPANY_ADMIN);
      for (const role of [R.OPERATIONS, R.CONTROL_ROOM, R.HR_COMPLIANCE, R.FINANCE, R.VIEWER]) assert.equal(policy.userRoleForMembership(role), UserRole.COMPANY_STAFF);
      const acct = (over: Record<string, unknown>) => policy.existingAccountRefusal({ role: UserRole.COMPANY_STAFF, status: 'active', deleted: false, ownsCompany: false, boundToCompany: false, ...over } as never);
      assert.equal(acct({}), null);
      for (const role of [UserRole.GUARD, UserRole.ADMIN, UserRole.CLIENT_ADMIN, UserRole.CLIENT_VIEWER]) assert.ok(acct({ role }), `${role} refused`);
      assert.ok(acct({ ownsCompany: true }) && acct({ boundToCompany: true }) && acct({ status: 'suspended' }) && acct({ deleted: true }));
      assert.equal(policy.normaliseStaffEmail('  New.Person@Example.INVALID '), 'new.person@example.invalid');
    });

    // ═══ CS-02 ═══
    await test('CS-02-OWNER-AND-ADMIN-ONLY', async () => {
      expect(await api('GET', '/company-staff', A.token), 200, 'owner');
      expect(await api('GET', '/company-staff', admin.token), 200, 'admin');
      for (const [who, tok] of [['ops', ops.token], ['control', control.token], ['hr', hr.token], ['finance', finance.token], ['viewer', viewer.token], ['guard', guardToken], ['platform', platform]] as const) {
        expect(await api('GET', '/company-staff', tok), 403, `${who} list`);
        expect(await api('GET', '/company-staff/audit', tok), 403, `${who} audit`);
        expect(await api('POST', '/company-staff/invitations', tok, { email: `x.${who}@example.invalid`, role: 'viewer' }), 403, `${who} invite`);
        expect(await api('POST', `/company-staff/members/${viewer.id}/suspend`, tok), 403, `${who} suspend`);
      }
      expect(await api('GET', '/company-staff', null), 401, 'unauthenticated');
      assert.equal(await one(`SELECT count(*)::int AS n FROM company_invitations`).then((r) => r.n), 0, 'nothing was written');
    });

    // ═══ CS-03 ═══
    const newEmail = 'new.operator@example.invalid';
    let inviteResponse: Res;
    await test('CS-03-INVITE-EMAILS-THE-LINK-ONLY', async () => {
      inviteResponse = await api('POST', '/company-staff/invitations', A.token, { email: '  New.Operator@Example.INVALID ', role: 'operations' });
      expect(inviteResponse, 201, 'invite');
      assert.equal(inviteResponse.body.invitation.email, newEmail, 'stored normalised');
      assert.equal(inviteResponse.body.invitation.state, 'PENDING');
      assert.equal(inviteResponse.body.emailSent, true);
      const link = linkFor(newEmail)!;
      assert.ok(link, 'emailed');
      assert.ok(link.message.text.includes('csalpha Security Ltd') && link.message.text.includes('Operations'));
      assert.ok(!inviteResponse.text.includes(link.token), 'the token is never in the response');
      const row = await one(`SELECT * FROM company_invitations WHERE id = $1`, [inviteResponse.body.invitation.id]);
      assert.equal(row.tokenDigest, sha(link.token), 'only the SHA-256 is stored');
      assert.equal(row.intendedMembershipRole, 'operations');
      assert.equal(row.invitedByUserId, A.ownerId);
      const audit = await one(`SELECT * FROM audit_logs WHERE action = 'company_staff_invitation.created' AND "entityId" = $1`, [row.id]);
      assert.equal(audit.companyId, A.id);
      assert.equal(audit.userId, A.ownerId);
      assert.ok(!JSON.stringify(audit).includes(link.token) && !JSON.stringify(audit).includes(row.tokenDigest), 'no token or digest in the audit');

      expect(await api('POST', '/company-staff/invitations', admin.token, { email: 'want.admin@example.invalid', role: 'admin' }), 403, 'Admin cannot invite an Admin');
      expect(await api('POST', '/company-staff/invitations', admin.token, { email: 'want.owner@example.invalid', role: 'owner' }), 403, 'Admin cannot invite an Owner');
      expect(await api('POST', '/company-staff/invitations', admin.token, { email: 'cr.one@example.invalid', role: 'control_room' }), 201, 'Admin can invite Control Room');
      expect(await api('POST', '/company-staff/invitations', A.token, { email: ops.email.toUpperCase(), role: 'viewer' }), 409, 'already a member');
      expect(await api('POST', '/company-staff/invitations', A.token, { email: A.ownerEmail, role: 'viewer' }), 409, 'the account holder');
      expect(await api('POST', '/company-staff/invitations', A.token, { email: 'not-an-email', role: 'viewer' }), 400, 'validation');
      expect(await api('POST', '/company-staff/invitations', A.token, { email: 'x@example.invalid', role: 'superuser' }), 400, 'unknown role');
    });

    // ═══ CS-04 ═══
    await test('CS-04-PREVIEW', async () => {
      const { token } = linkFor(newEmail)!;
      const before = await one(`SELECT (SELECT count(*) FROM audit_logs)::int AS a, (SELECT count(*) FROM users)::int AS u`);
      const r = await preview(token);
      expect(r, 200, 'preview');
      assert.deepEqual(
        { companyName: r.body.companyName, role: r.body.role, roleLabel: r.body.roleLabel, email: r.body.email, accountExists: r.body.accountExists },
        { companyName: 'csalpha Security Ltd', role: 'operations', roleLabel: 'Operations', email: newEmail, accountExists: false },
      );
      const bad = await preview('x'.repeat(43));
      expect(bad, 400, 'unknown');
      assert.equal(bad.body.message, INVALID_STAFF_INVITATION);
      const after = await one(`SELECT (SELECT count(*) FROM audit_logs)::int AS a, (SELECT count(*) FROM users)::int AS u`);
      assert.deepEqual(after, before, 'preview writes nothing');
    });

    // ═══ CS-05 ═══
    let newUserId = 0;
    let newUserToken = '';
    await test('CS-05-ACCEPT-NEW-ACCOUNT-WITH-OWN-PASSWORD', async () => {
      const { token } = linkFor(newEmail)!;
      const noPassword = await accept(token);
      expect(noPassword, 400, 'no password');
      assert.equal(noPassword.body.message, STAFF_INVITATION_PASSWORD_REQUIRED);
      assert.equal((await one(`SELECT "usedAt" FROM company_invitations WHERE "tokenDigest" = $1`, [sha(token)])).usedAt, null, 'not spent');
      expect(await accept(token, { newPassword: '123' }), 400, 'password policy');

      const r = await accept(token, { newPassword: 'Chosen-by-invitee-1', firstName: ' Nadia ', lastName: 'Operator' });
      expect(r, 200, 'accept');
      assert.equal(r.body.accepted, true);
      assert.equal(r.body.accountCreated, true);
      assert.match(r.body.message, /Sign in/);
      const u = await one(`SELECT id, role::text AS role, status::text AS status, "passwordHash", "isEmailVerified", "firstName", "lastName" FROM users WHERE email = $1`, [newEmail]);
      newUserId = u.id;
      assert.equal(u.role, 'company_staff');
      assert.equal(u.status, 'active');
      assert.equal(u.isEmailVerified, true, 'the emailed link proves the address');
      assert.equal(u.firstName, 'Nadia');
      assert.ok(await bcrypt.compare('Chosen-by-invitee-1', u.passwordHash), 'the password the invitee typed');
      assert.ok(!r.text.includes('Chosen-by-invitee-1'));
      const m = await membership(newUserId);
      assert.equal(m.role, 'operations');
      assert.equal(m.status, 'active');
      assert.equal((await one(`SELECT "usedAt" FROM company_invitations WHERE "tokenDigest" = $1`, [sha(token)])).usedAt !== null, true, 'spent');
      const again = await accept(token, { newPassword: 'Another-password-2' });
      expect(again, 400, 'single use');
      assert.equal(again.body.message, INVALID_STAFF_INVITATION);

      const session = (await auth.login({ email: newEmail, password: 'Chosen-by-invitee-1' } as never)) as any;
      newUserToken = session.accessToken;
      assert.deepEqual([...session.user.companyPermissions].sort(), [...ROLE_PERMISSIONS[R.OPERATIONS]].sort(), 'exactly the Operations permissions');
      expect(await api('GET', '/sites', newUserToken), 200, 'company routes work for the new member');
      const list = await api('GET', '/company-staff', A.token);
      const row = list.body.members.find((x: any) => x.userId === newUserId);
      assert.equal(row.role, 'operations');
      assert.equal(row.displayName, 'Nadia Operator');
      assert.ok(row.lastLoginAt, 'last activity shown');
      const accepted = await one(`SELECT * FROM audit_logs WHERE action = 'company_staff_invitation.accepted' AND "companyId" = $1`, [A.id]);
      assert.equal(accepted.userId, newUserId);
      assert.equal(accepted.afterData.accountCreated, true);
    });

    // ═══ CS-06 ═══
    await test('CS-06-GUARD-ADDRESS-NO-TAKEOVER-NO-LEAK', async () => {
      const guardBefore = await userRow(guardUserId);
      const strangerInvite = await api('POST', '/company-staff/invitations', A.token, { email: 'stranger.person@example.invalid', role: 'viewer' });
      const guardInvite = await api('POST', '/company-staff/invitations', A.token, { email: guardEmail, role: 'viewer' });
      expect(guardInvite, 201, 'the company is told nothing different');
      assert.equal(guardInvite.status, strangerInvite.status);
      assert.deepEqual(Object.keys(guardInvite.body).sort(), Object.keys(strangerInvite.body).sort());
      assert.deepEqual(Object.keys(guardInvite.body.invitation).sort(), Object.keys(strangerInvite.body.invitation).sort());
      assert.equal(guardInvite.body.invitation.state, strangerInvite.body.invitation.state);
      const { token } = linkFor(guardEmail)!;
      const p = await preview(token);
      expect(p, 403, 'preview');
      assert.equal(p.body.message, STAFF_INVITATION_NOT_ACCEPTABLE);
      const r = await accept(token, { newPassword: 'Attacker-chosen-1' });
      expect(r, 403, 'accept');
      assert.equal(r.body.message, STAFF_INVITATION_NOT_ACCEPTABLE);
      const guardAfter = await userRow(guardUserId);
      assert.deepEqual(guardAfter, guardBefore, 'the Guard account is untouched (role, status, password)');
      assert.equal(await one(`SELECT count(*)::int AS n FROM company_memberships WHERE "userId" = $1`, [guardUserId]).then((x) => x.n), 0);
      assert.equal((await one(`SELECT "usedAt" FROM company_invitations WHERE "tokenDigest" = $1`, [sha(token)])).usedAt, null, 'still pending for the company');
      const refused = await one(`SELECT * FROM audit_logs WHERE action = 'company_staff_invitation.accept_refused' ORDER BY id DESC LIMIT 1`);
      assert.equal(refused.companyId, null, 'the refusal is a platform-only record');
      assert.match(refused.afterData.reason, /guard/);
      const history = await api('GET', '/company-staff/audit', A.token);
      assert.ok(!history.text.includes('accept_refused') && !history.text.includes('account_role_guard'), 'never in the company history');
      const companyAudit = await api('GET', '/audit-logs/company', A.token);
      expect(companyAudit, 200);
      assert.ok(!companyAudit.text.includes('accept_refused'), 'nor the company audit trail');
      assert.ok(!(await api('GET', '/company-staff', A.token)).text.includes(`"userId":${guardUserId},`), 'the Guard is not listed as staff');
    });

    // ═══ CS-07 ═══
    await test('CS-07-OTHER-COMPANY-ACCOUNTS-REFUSED-GENERICALLY', async () => {
      for (const target of [{ email: bControl.email, id: bControl.id }, { email: B.ownerEmail, id: B.ownerId }]) {
        const before = await userRow(target.id);
        const before2 = await q(`SELECT * FROM company_memberships WHERE "userId" = $1 ORDER BY id`, [target.id]);
        const inv = await api('POST', '/company-staff/invitations', A.token, { email: target.email, role: 'viewer' });
        expect(inv, 201, 'same response as anyone');
        const { token } = linkFor(target.email)!;
        const r = await accept(token, { newPassword: 'Attacker-chosen-1' });
        expect(r, 403);
        assert.equal(r.body.message, STAFF_INVITATION_NOT_ACCEPTABLE, 'one generic message whatever the account is');
        assert.deepEqual(await userRow(target.id), before, 'account untouched');
        assert.deepEqual(await q(`SELECT * FROM company_memberships WHERE "userId" = $1 ORDER BY id`, [target.id]), before2, 'memberships untouched');
      }
    });

    // ═══ CS-08 ═══
    await test('CS-08-EXISTING-ELIGIBLE-ACCOUNT-LINKED-WITHOUT-PASSWORD-CHANGE', async () => {
      const moved = await member('cs.b.former', 'finance', B, 'revoked');
      const before = await userRow(moved.id);
      const session = await mobileLogin(moved.email);
      const inv = await api('POST', '/company-staff/invitations', A.token, { email: moved.email, role: 'viewer' });
      expect(inv, 201);
      const { token } = linkFor(moved.email)!;
      const p = await preview(token);
      expect(p, 200);
      assert.equal(p.body.accountExists, true);
      const r = await accept(token, { newPassword: 'Attacker-chosen-1' });
      expect(r, 200);
      assert.equal(r.body.accountCreated, false);
      assert.match(r.body.message, /existing password/);
      const after = await userRow(moved.id);
      assert.equal(after.passwordHash, before.passwordHash, 'the password is never changed');
      assert.equal(after.role, 'company_staff');
      assert.ok(await bcrypt.compare(PASSWORD, after.passwordHash));
      await assert.rejects(auth.login({ email: moved.email, password: 'Attacker-chosen-1' } as never), 'the sent password does not work');
      assert.equal((await membership(moved.id, A.id)).status, 'active');
      assert.equal((await membership(moved.id, B.id)).status, 'revoked', 'the other company row is untouched');
      expect(await api('POST', '/auth/refresh', null, { refreshToken: session.refreshToken }), 201, 'their own sessions are untouched');
    });

    // ═══ CS-09 ═══
    await test('CS-09-ROLE-RULES', async () => {
      const role = (tok: string, userId: number, next: string) => api('PATCH', `/company-staff/members/${userId}/role`, tok, { role: next });
      expect(await role(A.token, newUserId, 'admin'), 200, 'Owner promotes to Admin');
      assert.equal((await membership(newUserId)).role, 'admin');
      assert.equal((await userRow(newUserId)).role, 'company_admin', 'the account role follows');
      expect(await role(admin.token, newUserId, 'viewer'), 403, 'Admin cannot demote an Admin');
      expect(await role(A.token, newUserId, 'operations'), 200, 'Owner demotes');
      assert.equal((await userRow(newUserId)).role, 'company_staff');
      expect(await role(admin.token, newUserId, 'viewer'), 200, 'Admin manages Operations');
      expect(await role(admin.token, newUserId, 'admin'), 403, 'Admin cannot promote to Admin');
      expect(await role(admin.token, newUserId, 'owner'), 403, 'or Owner');
      expect(await role(admin.token, admin.id, 'operations'), 403, 'nobody changes themselves');
      expect(await role(admin.token, A.ownerId, 'viewer'), 403, 'the account holder is never changed');
      expect(await role(A.token, A.ownerId, 'viewer'), 403, 'not even by themselves');
      expect(await role(ops.token, viewer.id, 'finance'), 403, 'Operations cannot');
      const same = await role(admin.token, newUserId, 'viewer');
      expect(same, 200);
      assert.equal(same.body.changed, false, 'no-op');
      const audits = await q(`SELECT "afterData" FROM audit_logs WHERE action = 'company_staff.role_changed' AND "entityId" = $1 ORDER BY id`, [(await membership(newUserId)).id]);
      assert.deepEqual(audits.map((a) => a.afterData.role), ['admin', 'operations', 'viewer'], 'every change audited, the no-op not');
    });

    // ═══ CS-10 ═══
    let coOwner: { id: number; email: string; token: string };
    await test('CS-10-OWNERS-AND-THE-LAST-OWNER', async () => {
      const email = 'co.owner@example.invalid';
      expect(await api('POST', '/company-staff/invitations', A.token, { email, role: 'owner' }), 201, 'Owner invites a co-Owner');
      expect(await accept(linkFor(email)!.token, { newPassword: 'Co-owner-pass-1' }), 200);
      const id = (await one(`SELECT id FROM users WHERE email = $1`, [email])).id;
      coOwner = { id, email, token: await login(email, 'Co-owner-pass-1') };
      assert.equal((await userRow(id)).role, 'company_admin');
      expect(await api('GET', '/company-staff', coOwner.token), 200, 'a co-Owner manages staff');
      expect(await api('PATCH', `/company-staff/members/${A.ownerId}/role`, coOwner.token, { role: 'admin' }), 403, 'cannot demote the account holder');
      expect(await api('POST', `/company-staff/members/${A.ownerId}/suspend`, coOwner.token), 403, 'or suspend');
      expect(await api('POST', `/company-staff/members/${A.ownerId}/remove`, coOwner.token), 403, 'or remove');
      expect(await api('POST', `/company-staff/members/${coOwner.id}/suspend`, admin.token), 403, 'an Admin cannot suspend an Owner');
      expect(await api('PATCH', `/company-staff/members/${coOwner.id}/role`, coOwner.token, { role: 'admin' }), 403, 'nor demote themselves');
      assert.equal(await activeOwners(A), 2);
      expect(await api('PATCH', `/company-staff/members/${coOwner.id}/role`, A.token, { role: 'admin' }), 200, 'another Owner remains');
      assert.ok(await activeOwners(A) >= 1, 'the company always keeps an active Owner');
      expect(await api('PATCH', `/company-staff/members/${coOwner.id}/role`, A.token, { role: 'owner' }), 200);
      const list = await api('GET', '/company-staff', coOwner.token);
      const holder = list.body.members.find((x: any) => x.userId === A.ownerId);
      assert.equal(holder.isPrimaryOwner, true);
      assert.deepEqual(holder.actions, { changeRole: false, suspend: false, reactivate: false, remove: false, grants: false });
    });

    // ═══ CS-11 ═══
    await test('CS-11-CONTROL-ROOM-GRANTS-THROUGH-EXISTING-ENDPOINTS', async () => {
      expect(await api('PUT', `/shift-amendments/control-room/${control.id}`, A.token, { canAmendShifts: true }), 200, 'Owner grants extensions');
      expect(await api('PUT', `/attendance/control-room/${control.id}`, admin.token, { canManageAttendance: true }), 200, 'Admin grants attendance');
      expect(await api('PUT', `/attendance/control-room/${control.id}`, ops.token, { canManageAttendance: false }), 403, 'Operations cannot');
      expect(await api('PUT', `/attendance/control-room/${control.id}`, guardToken, { canManageAttendance: false }), 403, 'a Guard cannot');
      expect(await api('PUT', `/shift-amendments/control-room/${bControl.id}`, A.token, { canAmendShifts: true }), 404, "another company's member");
      expect(await api('PUT', `/attendance/control-room/${ops.id}`, A.token, { canManageAttendance: true }), 422, 'Control Room only');
      const row = (await api('GET', '/company-staff', A.token)).body.members.find((x: any) => x.userId === control.id);
      assert.equal(row.canAmendShifts, true);
      assert.equal(row.canManageAttendance, true);
      assert.equal(row.actions.grants, true);
      const perms = (await api('GET', '/auth/me', control.token)).body.companyPermissions as string[];
      assert.ok(perms.includes('shifts.amend') && perms.includes('attendance.manage'), 'the member session carries both grants');
      expect(await api('PUT', `/shift-amendments/control-room/${control.id}`, A.token, { canAmendShifts: false }), 200, 'revocable');
      assert.equal((await membership(control.id)).canAmendShifts, false);
      expect(await api('PUT', `/shift-amendments/control-room/${control.id}`, A.token, { canAmendShifts: true }), 200);
    });

    // ═══ CS-12 ═══
    await test('CS-12-SUSPEND-REVOKES-ACCESS-AT-ONCE', async () => {
      const session = await mobileLogin(control.email);
      const webToken = control.token;
      expect(await api('GET', '/shift-amendments/staff', webToken), 200, 'access before');
      expect(await api('POST', `/company-staff/members/${admin2.id}/suspend`, admin.token), 403, 'an Admin cannot suspend an Admin');
      expect(await api('POST', `/company-staff/members/${control.id}/suspend`, admin.token), 200, 'Admin suspends Control Room');
      const m = await membership(control.id);
      assert.equal(m.status, 'suspended');
      assert.equal(m.disabledByUserId, admin.id);
      const live = await q(`SELECT id FROM auth_sessions WHERE "userId" = $1 AND "revokedAt" IS NULL`, [control.id]);
      assert.equal(live.length, 0, 'every refresh session revoked');
      const reasons = await q(`SELECT DISTINCT "revokedReason" FROM auth_sessions WHERE "userId" = $1`, [control.id]);
      assert.ok(reasons.some((x) => x.revokedReason === 'membership_suspended'));
      expect(await api('POST', '/auth/refresh', null, { refreshToken: session.refreshToken }), 401, 'the mobile app cannot renew');
      const denied = await api('GET', '/shift-amendments/staff', webToken);
      expect(denied, 403, 'the existing web token loses company access on the next request');
      const caps = await api('GET', '/attendance/manual/capabilities', webToken);
      assert.equal(caps.body?.canManage ?? false, false, 'the attendance grant does nothing while suspended');
      const me = (await api('GET', '/auth/me', webToken)).body;
      assert.equal(me.companyPermissions, undefined, 'no company permissions');
      expect(await api('POST', `/company-staff/members/${control.id}/suspend`, admin.token), 409, 'already suspended');
      expect(await api('POST', `/company-staff/members/${control.id}/reactivate`, ops.token), 403);
      expect(await api('POST', `/company-staff/members/${control.id}/reactivate`, admin.token), 200, 'reactivate');
      expect(await api('GET', '/shift-amendments/staff', webToken), 200, 'access restored');
      assert.equal((await membership(control.id)).canAmendShifts, true, 'grants kept across a suspension');
      const actions = (await q(`SELECT action FROM audit_logs WHERE "companyId" = $1 AND action IN ('company_staff.suspended','company_staff.reactivated') ORDER BY id`, [A.id])).map((x) => x.action);
      assert.deepEqual(actions, ['company_staff.suspended', 'company_staff.reactivated']);
    });

    // ═══ CS-13 ═══
    await test('CS-13-REMOVE-AND-RE-INVITE', async () => {
      const session = await mobileLogin(control.email);
      const rowId = (await membership(control.id)).id;
      expect(await api('POST', `/company-staff/members/${control.id}/remove`, A.token), 200, 'remove');
      const m = await membership(control.id);
      assert.equal(m.status, 'revoked');
      assert.equal(m.canAmendShifts, false);
      assert.equal(m.canManageAttendance, false);
      expect(await api('POST', '/auth/refresh', null, { refreshToken: session.refreshToken }), 401);
      expect(await api('GET', '/shift-amendments/staff', control.token), 403, 'no access');
      expect(await api('POST', `/company-staff/members/${control.id}/reactivate`, A.token), 409, 'a removed member must be invited again');
      expect(await api('PATCH', `/company-staff/members/${control.id}/role`, A.token, { role: 'viewer' }), 409);
      expect(await api('POST', `/company-staff/members/${control.id}/remove`, A.token), 409, 'already removed');
      expect(await api('POST', '/company-staff/invitations', A.token, { email: control.email, role: 'control_room' }), 201, 'a removed member can be invited again');
      expect(await accept(linkFor(control.email)!.token), 200);
      const back = await membership(control.id);
      assert.equal(back.id, rowId, 'the same row is restored, never duplicated');
      assert.equal(back.status, 'active');
      assert.equal(back.canAmendShifts, false, 'grants start again from nothing');
      control.token = await login(control.email);
      expect(await api('GET', '/shift-amendments/staff', control.token), 200);
    });

    // ═══ CS-14 ═══
    await test('CS-14-COMPANY-ISOLATION', async () => {
      for (const [method, path, body] of [
        ['PATCH', `/company-staff/members/${bControl.id}/role`, { role: 'viewer' }],
        ['POST', `/company-staff/members/${bControl.id}/suspend`, undefined],
        ['POST', `/company-staff/members/${bControl.id}/reactivate`, undefined],
        ['POST', `/company-staff/members/${bControl.id}/remove`, undefined],
        ['PATCH', `/company-staff/members/${guardUserId}/role`, { role: 'viewer' }],
      ] as const) {
        expect(await api(method, path, A.token, body), 404, `${method} ${path}`);
      }
      assert.equal((await membership(bControl.id, B.id)).status, 'active', "B's member untouched");
      const bInvite = await api('POST', '/company-staff/invitations', B.token, { email: 'b.only@example.invalid', role: 'viewer' });
      expect(bInvite, 201);
      expect(await api('POST', `/company-staff/invitations/${bInvite.body.invitation.id}/resend`, A.token), 404);
      expect(await api('POST', `/company-staff/invitations/${bInvite.body.invitation.id}/revoke`, A.token), 404);
      const aList = await api('GET', '/company-staff', A.token);
      assert.ok(!aList.body.members.some((x: any) => [bControl.id, bAdmin.id, B.ownerId].includes(x.userId)), "no B staff in A's list");
      assert.ok(!aList.body.invitations.some((x: any) => x.email === 'b.only@example.invalid'));
      const aHistory = await api('GET', '/company-staff/audit', A.token);
      assert.ok(!aHistory.text.includes('b.only@example.invalid'), "no B history in A's");
      const bList = await api('GET', '/company-staff', bAdmin.token);
      assert.ok(!bList.text.includes(newEmail) && !bList.text.includes(admin.email), "and none of A's in B's");
    });

    // ═══ CS-15 ═══
    await test('CS-15-INVITATION-LIFECYCLE', async () => {
      const email = 'lifecycle@example.invalid';
      const first = await api('POST', '/company-staff/invitations', admin.token, { email, role: 'viewer' });
      const firstToken = linkFor(email)!.token;
      const resent = await api('POST', `/company-staff/invitations/${first.body.invitation.id}/resend`, admin.token);
      expect(resent, 200, 'resend');
      const secondToken = linkFor(email)!.token;
      assert.notEqual(secondToken, firstToken);
      expect(await preview(firstToken), 400, 'the old link is dead');
      expect(await preview(secondToken), 200, 'the new one works');
      const again = await api('POST', '/company-staff/invitations', admin.token, { email, role: 'finance' });
      expect(again, 201);
      expect(await preview(secondToken), 400, 'a new invitation supersedes the older one');
      const third = linkFor(email)!.token;
      expect(await api('POST', `/company-staff/invitations/${again.body.invitation.id}/revoke`, admin.token), 200, 'withdraw');
      expect(await preview(third), 400, 'a withdrawn link is dead');
      expect(await api('POST', `/company-staff/invitations/${again.body.invitation.id}/revoke`, admin.token), 409, 'already withdrawn');

      const senior = await api('POST', '/company-staff/invitations', A.token, { email: 'senior@example.invalid', role: 'admin' });
      expect(await api('POST', `/company-staff/invitations/${senior.body.invitation.id}/revoke`, admin.token), 403, 'Admin cannot withdraw an Admin invitation');
      expect(await api('POST', `/company-staff/invitations/${senior.body.invitation.id}/resend`, admin.token), 403, 'or re-send it');
      const pending = (await api('GET', '/company-staff', admin.token)).body.invitations.find((x: any) => x.id === senior.body.invitation.id);
      assert.equal(pending.canManage, false);

      const expiring = await api('POST', '/company-staff/invitations', A.token, { email: 'expired@example.invalid', role: 'viewer' });
      const expiredToken = linkFor('expired@example.invalid')!.token;
      await q(`UPDATE company_invitations SET "expiresAt" = '2001-01-01' WHERE id = $1`, [expiring.body.invitation.id]);
      expect(await accept(expiredToken, { newPassword: 'Late-person-1' }), 400, 'expired');
      assert.equal((await api('GET', '/company-staff', A.token)).body.invitations.find((x: any) => x.id === expiring.body.invitation.id).state, 'EXPIRED');
      expect(await api('POST', `/company-staff/invitations/${expiring.body.invitation.id}/resend`, A.token), 200, 'an expired invitation can be re-sent');
      expect(await preview(linkFor('expired@example.invalid')!.token), 200);

      const C = await company('csgamma', '68333333');
      await q(`INSERT INTO company_invitations ("companyId",email,"intendedMembershipRole","tokenDigest","expiresAt","invitedByUserId")
               SELECT $1, 'cap' || g || '@example.invalid', 'viewer', md5(random()::text) || md5(random()::text), '2099-01-01', $2 FROM generate_series(1, $3) g`,
        [C.id, C.ownerId, STAFF_INVITATIONS_PER_HOUR]);
      expect(await api('POST', '/company-staff/invitations', C.token, { email: 'one.too.many@example.invalid', role: 'viewer' }), 429, 'hourly cap');
    });

    // ═══ CS-16 ═══
    await test('CS-16-HISTORY', async () => {
      const r = await api('GET', '/company-staff/audit', A.token);
      expect(r, 200);
      const actions = new Set(r.body.entries.map((e: any) => e.action));
      for (const a of ['company_staff_invitation.created', 'company_staff_invitation.accepted', 'company_staff_invitation.resent',
        'company_staff_invitation.revoked', 'company_staff.role_changed', 'company_staff.suspended', 'company_staff.reactivated',
        'company_staff.removed', 'company_membership.amendment_authorisation', 'company_membership.attendance_authorisation']) {
        assert.ok(actions.has(a), `history has ${a}`);
      }
      const suspended = r.body.entries.find((e: any) => e.action === 'company_staff.suspended');
      assert.equal(suspended.actorUserId, admin.id);
      assert.equal(suspended.targetUserId, control.id);
      assert.equal(suspended.actorName, 'cs.admin Spec');
      assert.ok(suspended.createdAt && suspended.id);
      const times = r.body.entries.map((e: any) => new Date(e.createdAt).getTime());
      assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
      for (const forbidden of ['tokenDigest', 'passwordHash', 'ipAddress', 'userAgent', '"company"']) assert.ok(!r.text.includes(forbidden), `no ${forbidden}`);
      for (const e of r.body.entries) {
        assert.ok(/^company_staff|^company_membership\.(amendment|attendance)_authorisation$/.test(e.action), `only staff actions: ${e.action}`);
      }
      expect(await api('GET', '/company-staff/audit?limit=2', A.token).then((x) => { assert.equal(x.body.entries.length, 2); return x; }), 200);
      expect(await api('GET', '/company-staff/audit?limit=100000', A.token), 400, 'bounded');
    });

    // ═══ CS-17 ═══
    await test('CS-17-NO-TOKEN-ANYWHERE-AND-ESCAPED-EMAIL', async () => {
      assert.ok(allTokens.size >= 10, 'the suite read many links');
      const everything = responses.join('\n');
      const tables = JSON.stringify(await q(`SELECT * FROM audit_logs`)) + JSON.stringify(await q(`SELECT * FROM company_invitations`));
      for (const token of allTokens) {
        assert.ok(!everything.includes(token), 'no response carried an invitation token');
        assert.ok(!tables.includes(token), 'no table holds a plaintext token');
      }
      const mail = companyStaffInvitationEmail('a@example.invalid', 'https://app.sfour.co.uk', 'T'.repeat(43), '<script>alert(1)</script> & Co', 'Control Room', 7);
      assert.ok(!mail.html.includes('<script>'), 'company-entered text is escaped');
      assert.ok(mail.html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co'));
      assert.match(mail.subject, /\bS4\b/);
      assert.doesNotMatch(mail.text + mail.html, /S4 Security|S4 Guard|Security Marketplace/);
    });

    // ═══ CS-19..CS-22: the Control Room / Operations / Admin job, as INVITED members (never the account holder) ═══
    const { complianceToday } = await import('../src/compliance/compliance-dates');
    const MIN = 60_000;
    const HOUR = 60 * MIN;
    const ukDay = (n: number) => {
      const [y, m, d] = complianceToday().split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
    };
    const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
    const minute = (ms: number) => Math.floor(ms / MIN) * MIN;
    /** Invited through the real flow and accepted with their own password, then a normal web sign-in. */
    const invited = async (label: string, role: string) => {
      const email = `${label}@example.invalid`;
      expect(await api('POST', '/company-staff/invitations', A.token, { email, role }), 201, `invite ${label}`);
      expect(await accept(linkFor(email)!.token, { newPassword: `${label}-own-pass-1`, firstName: label, lastName: 'Job' }), 200, `accept ${label}`);
      const id = Number((await one(`SELECT id FROM users WHERE email = $1`, [email])).id);
      return { id, email, token: await login(email, `${label}-own-pass-1`) };
    };
    const jobControl = await invited('job.control', 'control_room');
    const jobOps = await invited('job.ops', 'operations');
    const jobAdmin = await invited('job.admin', 'admin');
    expect(await api('PUT', `/attendance/control-room/${jobControl.id}`, A.token, { canManageAttendance: true }), 200);
    expect(await api('PUT', `/shift-amendments/control-room/${jobControl.id}`, A.token, { canAmendShifts: true }), 200);
    jobControl.token = await login(jobControl.email, 'job.control-own-pass-1');

    const clientId = Number((await one(`INSERT INTO clients ("companyId", name) VALUES ($1, 'Job Client') RETURNING id`, [A.id])).id);
    const siteId = Number((await one(`INSERT INTO sites ("companyId","clientId",name,address,timezone,"welfareCheckIntervalMinutes")
      VALUES ($1,$2,'Job Site','3 Quay','Europe/London',60) RETURNING id`, [A.id, clientId])).id);
    let gn = 0;
    const jobGuard = async () => {
      gn += 1;
      const email = `job.guard${gn}@example.invalid`;
      const userId = await user(email, 'guard');
      const licence = `87000000000000${String(gn).padStart(2, '0')}`;
      const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","siaExpiryDate","rightToWorkStatus",phone)
        VALUES ($1,$2,$3,$4,'british',$5) RETURNING id`, [userId, `Job Guard ${gn}`, licence, ukDay(500), `0771090${String(gn).padStart(4, '0')}`]);
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [A.id, id]);
      for (const type of ['sia_licence', 'right_to_work']) {
        await q(`INSERT INTO guard_documents ("guardId","companyId",type,"storageProvider","storageKey","originalFileName","mimeType","sizeBytes","uploadCompletedAt",verified,"uploadedByUserId","verifiedByUserId","verifiedAt")
          VALUES ($1,$2,$3,'s3-compatible',$4,'e.pdf','application/pdf','1024',now(),true,null,null,now())`, [id, A.id, type, `job/${A.id}/${id}/${type}`]);
      }
      for (const body of [
        { guardId: id, kind: 'sia', outcome: 'confirmed', checkDate: ukDay(0), checkedByName: 'Spec Checker', evidenceReference: 'HR/spec', method: 'sia_public_register', licenceNumber: licence, expiryDate: ukDay(400) },
        { guardId: id, kind: 'right_to_work', outcome: 'confirmed', checkDate: ukDay(0), checkedByName: 'Spec Checker', evidenceReference: 'HR/spec', method: 'manual_document', rightToWorkExcuse: 'continuous' },
      ]) {
        expect(await api('POST', '/compliance/checks', A.token, body), 201, `compliance ${body.kind}`);
      }
      return Number(id);
    };
    const mkShift = async (guardId: number | null, status: string, startH: number, hours = 8) => {
      const start = minute(Date.now() + startH * HOUR);
      const end = start + hours * HOUR;
      const { id } = await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end","checkCallIntervalMinutes")
        VALUES ($1,$2,'Job Site',$3,$4,$5,$6,60) RETURNING id`, [A.id, siteId, guardId, status, ts(start), ts(end)]);
      return { id: Number(id), start, end };
    };
    const bookedOn = async (guardId: number, shiftId: number, atMs: number) =>
      q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-in',$3,$3,true)`, [shiftId, guardId, ts(atMs)]);

    /** One complete Control Room working set per actor, so one actor's actions never change another's fixtures. */
    const workingSet = async () => {
      const [g1, g2, g3, g4, g5] = [await jobGuard(), await jobGuard(), await jobGuard(), await jobGuard(), await jobGuard()];
      const ready = await mkShift(g1, 'ready', -0.25);
      const live = await mkShift(g2, 'in_progress', -2);
      await bookedOn(g2, live.id, live.start);
      const bookOff = await mkShift(g3, 'in_progress', -3);
      await bookedOn(g3, bookOff.id, bookOff.start);
      const overdue = await mkShift(g4, 'in_progress', -10, 8);
      await bookedOn(g4, overdue.id, overdue.start);
      const noShow = await mkShift(g5, 'ready', -0.75);
      const panic = Number((await one(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message)
        VALUES ($1,$2,$3,'panic','critical','open','SOS') RETURNING id`, [A.id, g2, live.id])).id);
      const welfare = Number((await one(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message)
        VALUES ($1,$2,$3,'missed_checkcall','high','open','Welfare Check missed') RETURNING id`, [A.id, g2, live.id])).id);
      const incident = Number((await one(`INSERT INTO incidents ("companyId","guardId","shiftId","siteId",title,notes)
        VALUES ($1,$2,$3,$4,'Gate damaged','Reported by guard') RETURNING id`, [A.id, g2, live.id, siteId])).id);
      await q(`INSERT INTO daily_logs ("companyId","guardId","shiftId",message,"logType") VALUES ($1,$2,$3,'All quiet','welfare_check')`, [A.id, g2, live.id]);
      return { ready, live, bookOff, overdue, noShow, panic, welfare, incident };
    };

    type Actor = { name: string; token: string };
    const actors: Actor[] = [
      { name: 'control_room', token: jobControl.token },
      { name: 'operations', token: jobOps.token },
      { name: 'admin', token: jobAdmin.token },
    ];
    const matrix: Record<string, Record<string, number>> = {};
    const record = (endpoint: string, actor: string, status: number) => {
      (matrix[endpoint] ??= {})[actor] = status;
    };
    const REASON = 'Guard phone battery failed; confirmed by phone call';
    for (const actor of actors) {
      const set = await workingSet();
      const ids = [set.ready.id, set.live.id, set.bookOff.id, set.overdue.id, set.noShow.id].join(',');
      const reads: Array<[string, string]> = [
        ['GET /auth/me', '/auth/me'],
        ['GET /clients', '/clients'],
        ['GET /sites', '/sites'],
        ['GET /shifts', '/shifts'],
        ['GET /coverage/shifts?uncoveredOnly', '/coverage/shifts?uncoveredOnly=true'],
        ['GET /guards', '/guards'],
        ['GET /company-guards', '/company-guards'],
        ['GET /company-guards/invitations', '/company-guards/invitations'],
        ['GET /screening/company/outcomes', '/screening/company/outcomes'],
        ['GET /coverage/operations', `/coverage/operations?shiftIds=${ids}`],
        ['GET /attendance/company', '/attendance/company'],
        ['GET /timesheets/company', '/timesheets/company'],
        ['GET /incidents/company', '/incidents/company'],
        ['GET /alerts/company', '/alerts/company'],
        ['GET /daily-logs/company', '/daily-logs/company'],
        ['GET /notifications/company', '/notifications/company'],
        ['GET /compliance/statuses', '/compliance/statuses'],
        ['GET /shifts/reconciliations', `/shifts/reconciliations?shiftIds=${ids}`],
        ['GET /shift-amendments/policy', '/shift-amendments/policy'],
        ['GET /shift-amendments/staff', '/shift-amendments/staff'],
        ['GET /attendance/manual/capabilities', '/attendance/manual/capabilities'],
        ['GET /shifts/:id', `/shifts/${set.live.id}`],
        ['GET /shifts/:id/amendments', `/shifts/${set.live.id}/amendments`],
        ['GET /attendance/shifts/:id/history', `/attendance/shifts/${set.live.id}/history`],
        ['GET /alerts/:id/resolution-reasons', `/alerts/${set.welfare}/resolution-reasons`],
        ['GET /incidents/resolution-reasons', '/incidents/resolution-reasons'],
      ];
      for (const [label, path] of reads) record(label, actor.name, (await api('GET', path, actor.token)).status);
      const writes: Array<[string, string, string, unknown]> = [
        ['PATCH /alerts/:id/ack (panic)', 'PATCH', `/alerts/${set.panic}/ack`, undefined],
        ['PATCH /alerts/:id/close (welfare)', 'PATCH', `/alerts/${set.welfare}/close`, { resolutionReason: 'guard_confirmed_safe', resolutionNote: 'Called the Guard, all well' }],
        ['PATCH /incidents/:id/status', 'PATCH', `/incidents/${set.incident}/status`, { status: 'in_review' }],
        ['POST reconcile-without-book-off', 'POST', `/shifts/${set.overdue.id}/reconcile-without-book-off`, { reason: 'guard_forgot_book_off' }],
        ['POST manual book-on', 'POST', '/attendance/manual/book-on', { shiftId: set.ready.id, occurredAt: new Date(Date.now() - MIN).toISOString(), reason: REASON, verificationMethod: 'phone_call' }],
        ['POST manual book-off', 'POST', '/attendance/manual/book-off', { shiftId: set.bookOff.id, occurredAt: new Date(Date.now() - MIN).toISOString(), reason: REASON, verificationMethod: 'phone_call' }],
        ['POST shift extension', 'POST', `/shifts/${set.live.id}/amendments`, { proposedEnd: new Date(set.live.end + HOUR).toISOString(), reason: 'Relief officer delayed by traffic' }],
        ['PATCH /shifts/:id (Mark Missed)', 'PATCH', `/shifts/${set.noShow.id}`, { status: 'missed', reason: 'Guard unreachable; client confirmed nobody on site' }],
      ];
      for (const [label, method, path, body] of writes) {
        const r = await api(method, path, actor.token, body);
        record(label, actor.name, r.status);
        if (r.status >= 400 && r.status !== 403) console.log(`      ${actor.name} ${label}: ${r.status} ${r.text.slice(0, 200)}`);
      }
    }
    console.log('\n      endpoint                                     control_room  operations  admin');
    for (const [endpoint, row] of Object.entries(matrix)) {
      console.log(`      ${endpoint.padEnd(45)} ${String(row.control_room).padEnd(13)} ${String(row.operations).padEnd(11)} ${row.admin}`);
    }

    await test('CS-19-CONTROL-ROOM-OPERATIONS-ADMIN-JOB-MATRIX', () => {
      // 403 entries are BY DESIGN: the membership lacks the permission (Control Room: screening.view, shifts.manage),
      // or the documented owner-only rule for non-compliance alerts (S4_COMPLIANCE_PHASE1_ACTIVATION.md §1a), which no
      // CompanyPermission grants. Everything else must work for an invited member.
      const ok = (cr: number, ops: number, adm: number) => ({ control_room: cr, operations: ops, admin: adm });
      const expected: Record<string, Record<string, number>> = {};
      for (const [label] of Object.entries(matrix)) expected[label] = ok(200, 200, 200);
      expected['GET /screening/company/outcomes'] = ok(403, 200, 200);
      expected['GET /alerts/:id/resolution-reasons'] = ok(403, 403, 403);
      expected['PATCH /alerts/:id/ack (panic)'] = ok(403, 403, 403);
      expected['PATCH /alerts/:id/close (welfare)'] = ok(403, 403, 403);
      for (const label of ['POST reconcile-without-book-off', 'POST manual book-on', 'POST manual book-off', 'POST shift extension']) expected[label] = ok(201, 201, 201);
      expected['PATCH /shifts/:id (Mark Missed)'] = ok(403, 200, 200);
      assert.deepEqual(matrix, expected);
    });

    await test('CS-20-WIDENED-GUARDS-STILL-REFUSE-WHAT-THE-MEMBERSHIP-DOES-NOT-GRANT', async () => {
      const set = await workingSet();
      const inc = () => one(`SELECT status::text AS status FROM incidents WHERE id = $1`, [set.incident]);
      const shiftStatus = () => one(`SELECT status FROM shifts WHERE id = $1`, [set.noShow.id]).then((r) => r.status);
      for (const [who, tok] of [['viewer', viewer.token], ['finance', finance.token], ['hr', hr.token], ['guard', guardToken]] as const) {
        expect(await api('PATCH', `/incidents/${set.incident}/status`, tok, { status: 'in_review' }), 403, `${who} incident status`);
        expect(await api('GET', '/incidents/resolution-reasons', tok), 403, `${who} incident reasons`);
        expect(await api('PATCH', `/shifts/${set.noShow.id}`, tok, { status: 'missed', reason: 'Guard unreachable; client confirmed' }), 403, `${who} Mark Missed`);
        expect(await api('POST', `/shifts/${set.noShow.id}/replace-guard`, tok, { replacementGuardId: 1, reasonCategory: 'cover_rearranged', reason: 'Cover rearranged' }), 403, `${who} replace guard`);
      }
      expect(await api('PATCH', `/shifts/${set.noShow.id}`, jobControl.token, { status: 'missed', reason: 'Guard unreachable; client confirmed' }), 403, 'Control Room has no shifts.manage');
      expect(await api('PATCH', `/shifts/${set.noShow.id}`, platform, { status: 'missed', reason: 'Guard unreachable; client confirmed' }), 403, 'platform admin');
      // Another company's Operations member cannot reach company A's shift or incident.
      const bOps = await member('cs.b.ops', 'operations', B);
      const bInc = await api('PATCH', `/incidents/${set.incident}/status`, bOps.token, { status: 'in_review' });
      assert.ok(bInc.status === 400 || bInc.status === 404, `another company's incident: ${bInc.status}`);
      expect(await api('PATCH', `/shifts/${set.noShow.id}`, bOps.token, { status: 'missed', reason: 'Guard unreachable; client confirmed' }), 404, "another company's shift");
      assert.equal((await inc()).status, 'open', 'the incident is untouched');
      assert.equal(await shiftStatus(), 'ready', 'the shift is untouched');
      // A suspended Operations member loses the widened routes too.
      const susp = await invited('job.ops.suspended', 'operations');
      expect(await api('POST', `/company-staff/members/${susp.id}/suspend`, A.token), 200);
      expect(await api('PATCH', `/incidents/${set.incident}/status`, susp.token, { status: 'in_review' }), 403, 'suspended');
      expect(await api('PATCH', `/shifts/${set.noShow.id}`, susp.token, { status: 'missed', reason: 'Guard unreachable; client confirmed' }), 403, 'suspended');
    });

    await test('CS-21-NOTIFICATIONS-A-MEMBER-SEES-ONLY-THEIR-OWN', async () => {
      const add = (userId: number, companyId: number, title: string) =>
        q(`INSERT INTO notifications ("userId","companyId",type,title,message) VALUES ($1,$2,'alert_raised',$3,'m')`, [userId, companyId, title]);
      await add(jobControl.id, A.id, 'for-control');
      await add(A.ownerId, A.id, 'for-owner');
      await add(jobOps.id, A.id, 'for-ops');
      await add(bControl.id, B.id, 'for-b');
      const titles = async (tok: string) => (await api('GET', '/notifications/company', tok)).body.map((n: any) => n.title).sort();
      assert.deepEqual(await titles(jobControl.token), ['for-control'], 'only their own');
      assert.deepEqual(await titles(jobOps.token), ['for-ops']);
      const owner = await titles(A.token);
      assert.ok(owner.includes('for-owner') && owner.includes('for-control') && !owner.includes('for-b'), 'the account holder: the whole company, as before');
      // A Guard has no company: "not found", exactly as before this change.
      expect(await api('GET', '/notifications/company', guardToken), 404, 'guard');
      const susp = await one(`SELECT id FROM users WHERE email = 'job.ops.suspended@example.invalid'`);
      expect(await api('GET', '/notifications/company', await login('job.ops.suspended@example.invalid', 'job.ops.suspended-own-pass-1')), 403, `suspended member ${susp.id}`);
    });

    await test('CS-22-THE-ACTIONS-TOOK-EFFECT-AS-THE-MEMBER', async () => {
      const audited = await q(`SELECT DISTINCT a."userId" FROM audit_logs a WHERE a."companyId" = $1 AND a."userId" = ANY($2)`,
        [A.id, [jobControl.id, jobOps.id, jobAdmin.id]]);
      assert.equal(audited.length, 3, 'every member is the recorded actor of their own actions');
      const reconciled = await q(`SELECT count(*)::int AS n FROM shifts WHERE "companyId" = $1 AND status = 'completed' AND "siteId" = $2`, [A.id, siteId]);
      assert.ok(reconciled[0].n >= 6, 'Close without Book Off and manual Book Off completed shifts for every actor');
      const events = await q(`SELECT DISTINCT "recordedByUserId" FROM attendance_events WHERE source = 'manual'`);
      const recorders = new Set(events.map((e) => Number(e.recordedByUserId)));
      for (const who of [jobControl, jobOps, jobAdmin]) assert.ok(recorders.has(who.id), `manual attendance recorded by ${who.email}`);
      const amendments = await q(`SELECT DISTINCT "proposedByUserId" FROM shift_amendments`);
      const proposers = new Set(amendments.map((a) => Number(a.proposedByUserId)));
      for (const who of [jobControl, jobOps, jobAdmin]) assert.ok(proposers.has(who.id), `extension proposed by ${who.email}`);
      const missed = await q(`SELECT count(*)::int AS n FROM shifts WHERE "companyId" = $1 AND status = 'missed'`, [A.id]);
      assert.equal(missed[0].n, 2, 'Mark Missed by Operations and Admin');
      const reviewed = await q(`SELECT DISTINCT "reviewedByUserId" FROM incidents WHERE status = 'in_review'`);
      const reviewers = new Set(reviewed.map((r) => Number(r.reviewedByUserId)));
      for (const who of [jobControl, jobOps, jobAdmin]) assert.ok(reviewers.has(who.id), `incident reviewed by ${who.email}`);
    });

    // ═══ CS-18 ═══
    await test('CS-18-WIRING', () => {
      const root = join(__dirname, '..');
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      assert.ok(pkg.scripts['test:release'].includes('scripts/company-staff.spec.ts'), 'in the release suite');
      assert.equal(pkg.scripts['test:company-staff'], 'ts-node -r tsconfig-paths/register scripts/company-staff.spec.ts');
      const workflow = readFileSync(join(root, '..', '.github', 'workflows', 's4-backend-release-gate.yml'), 'utf8');
      assert.ok(workflow.includes('COMPANY_STAFF_DATABASE_URL: postgresql://s4:s4_test_password@localhost:5432/s4_company_staff'));
      assert.ok(/for db in [^\n]*\bs4_company_staff\b/.test(workflow), 'the CI database is created');
      const appModule = readFileSync(join(root, 'src', 'app.module.ts'), 'utf8');
      assert.ok(appModule.includes('CompanyStaffModule'));
      const migrations = require('node:fs').readdirSync(join(root, 'src', 'database', 'migrations')) as string[];
      assert.ok(!migrations.some((f) => /CompanyStaff/i.test(f)), 'no migration of its own');
    });
  } finally {
    await app.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
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
