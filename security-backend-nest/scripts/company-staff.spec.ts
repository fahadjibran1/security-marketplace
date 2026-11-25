/**
 * Company staff management (Team): invite by email, accept, change role, revoke access. Real PostgreSQL (migrations
 * applied to a disposable database), the real Nest application and real HTTP.
 *
 *   STAFF-01  the Owner and staff.manage holders list the team and open invitations; other roles are refused
 *   STAFF-02  an invitation is emailed with a /join-company link; only the SHA-256 digest is stored; 7-day expiry; the
 *             token is never in the API response
 *   STAFF-03  duplicates are refused: a waiting invitation for the same address, or someone already on the team
 *   STAFF-04  escalation: nobody grants Owner; Admin is granted by the Owner only; a role without staff.manage cannot
 *             invite; nobody changes or revokes the Owner, themselves, or a member whose role they could not grant
 *   STAFF-05  accept: a new company_staff account (email verified by the link) with an ACTIVE membership; signs in with
 *             exactly the invited role's permissions
 *   STAFF-06  an accepted Control Room member is an Emergency recipient (and is notified, when S4-EM-01 is present)
 *   STAFF-07  used, unknown, expired and cancelled links are refused with one generic message
 *   STAFF-08  an address that already has an S4 account is refused clearly; nothing is created; the invitation stays
 *   STAFF-09  tenant isolation: another company can neither see nor act on this company's invitations or members
 *   STAFF-10  role change is audited and changes the member's permissions at their next sign-in
 *   STAFF-11  revoke: membership suspended, sessions ended (refresh fails), company routes refused, and no longer an
 *             Emergency recipient
 *   STAFF-12  capabilities: an unapproved company cannot invite; a suspended company can still revoke access and cancel;
 *             a link from a company that is no longer approved is refused
 *   STAFF-13  every action is audited; no token or digest appears in any response, audit entry or log line
 *   STAFF-14  accept validates its input
 *
 * Needs COMPANY_STAFF_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { LoggerService, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { assertDisposableTestDatabase, requireDisposableTestDatabaseUrl } from './test-database-guard';

const url = requireDisposableTestDatabaseUrl('COMPANY_STAFF_DATABASE_URL');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'company-staff-spec-local-certification-secret-not-production';
delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_FROM;
delete process.env.S4_WEB_APP_URL;
delete process.env.EXPO_ACCESS_TOKEN;
process.env.PUSH_WELFARE_REMINDERS_ENABLED = 'false';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

// ── log capture: no token may ever be logged ───────────────────────────────────────────────────────────
const captured: string[] = [];
const record = (...parts: unknown[]) => captured.push(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '));
const captureLogger: LoggerService = { log: record, error: record, warn: record, debug: record, verbose: record, fatal: record };
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => { record(...args); original(...args); };
}

let passed = 0;
const test = async (id: string, fn: () => Promise<void> | void) => {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
};

type Res = { status: number; body: any; text: string };
const HOUR = 3_600_000;
// Spec-only; never printed. The disposable database is dropped at the start of every run.
const PASSWORD = 'company-staff-spec-only-password-1';
const NEW_PASSWORD = 'company-staff-spec-only-password-2';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
let ipCounter = 0;
/** A fresh client address per call, so the per-IP throttles bite only where a test intends. */
const freshIp = () => `198.51.100.${(ipCounter = (ipCounter % 250) + 1)}, 10.0.0.${ipCounter}`;

async function main() {
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  await assertDisposableTestDatabase(url);
  const migrator = new DataSource({
    ...buildTypeOrmOptions({ DATABASE_URL: url, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' }),
    dropSchema: true,
  } as never);
  await migrator.initialize();
  await migrator.runMigrations({ transaction: 'each' });
  await migrator.destroy();

  const { AppModule } = await import('../src/app.module');
  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const { WelfarePushService } = await import('../src/welfare-push/welfare-push.service');
  const { TransactionalEmailService } = await import('../src/email/transactional-email.service');
  const { INVALID_STAFF_INVITATION, STAFF_INVITATION_ACCOUNT_EXISTS, STAFF_INVITATION_TTL_MS } = await import('../src/company-staff/company-staff.service');
  const { ROLE_PERMISSIONS, CompanyPermission } = await import('../src/company-membership/company-membership-types');
  // S4-EM-01 (two-tap Emergency) may or may not be merged into this branch. When it is, its real recipient function and
  // notifications are checked too; the recipient RULE is always checked below.
  let emergency: { emergencyRecipientUserIds: (m: unknown, companyId: number) => Promise<number[]> } | null = null;
  try {
    const modulePath = '../src/safety-alert/emergency-alert';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    emergency = require(modulePath);
  } catch {
    emergency = null;
  }

  const app = await NestFactory.create(AppModule, { logger: captureLogger });
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const base = `http://127.0.0.1:${address.port}`;
  const ds = app.get(DataSource);
  app.get(SafetyAlertService).onModuleDestroy(); // no background sweeps in this spec
  app.get(WelfarePushService).onModuleDestroy();
  const outbox = app.get(TransactionalEmailService);

  const responses: string[] = [];
  const api = async (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp(), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
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
  const msg = (r: Res) => (Array.isArray(r.body?.message) ? r.body.message.join('; ') : r.body?.message) ?? r.text;

  const tokens: string[] = [];
  /** The token in the most recent invitation email to this address (and the link it sits in). */
  const tokenFor = (email: string) => {
    const mail = [...outbox.capturedMessages()].reverse().find((m) => m.kind === 'staff_invitation' && m.to === email);
    assert.ok(mail, `an invitation email was captured for ${email}`);
    const match = /\/join-company\?token=([A-Za-z0-9_-]+)/.exec(mail!.text);
    assert.ok(match, 'the email carries a /join-company link');
    tokens.push(match![1]);
    return { token: match![1], mail: mail! };
  };

  try {
    const hash = await bcrypt.hash(PASSWORD, 4);
    const user = async (email: string, role: string, firstName = 'Spec') =>
      (await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName") VALUES ($1,$2,$3,'active',true,false,$4) RETURNING id`, [email, hash, role, firstName])).id as number;
    const login = async (email: string, password = PASSWORD, mobile = false) =>
      api('POST', '/auth/login', null, { email, password }, mobile ? { 'x-s4-client': 'mobile' } : {});
    const tokenOf = async (email: string, password = PASSWORD) => {
      const r = await login(email, password);
      assert.equal(r.status, 201, `login ${email}: ${msg(r)}`);
      return r.body.accessToken as string;
    };
    const company = async (label: string, number: string, verificationStatus = 'approved') => {
      const ownerEmail = `${label}.owner@example.invalid`;
      const ownerId = await user(ownerEmail, 'company_admin', `${label}Owner`);
      const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","verificationStatus") VALUES ($1,$2,$3,'1 Way','ops@example.invalid',$4) RETURNING id`, [ownerId, `${label} Ltd`, number, verificationStatus]);
      const site = await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,$2,'2 Way') RETURNING id`, [id, `${label} Depot`]);
      return { id: id as number, ownerId, ownerEmail, siteId: site.id as number, token: await tokenOf(ownerEmail) };
    };
    const member = async (c: { id: number }, label: string, role: string, status = 'active') => {
      const email = `${label}@example.invalid`;
      const userId = await user(email, 'company_staff', label);
      await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,$4)`, [userId, c.id, role, status]);
      return { userId, email, token: status === 'active' ? await tokenOf(email) : '' };
    };

    const A = await company('stalpha', '71111111');
    const B = await company('stbeta', '72222222');
    const P = await company('stpending', '73333333', 'pending_verification');
    const S = await company('stsusp', '74444444');
    const adminA = await member(A, 'stalpha.admin', 'admin');
    const admin2A = await member(A, 'stalpha.admin2', 'admin');
    const opsA = await member(A, 'stalpha.ops', 'operations');
    const hrA = await member(A, 'stalpha.hr', 'hr_compliance');
    const viewerB = await member(B, 'stbeta.viewer', 'viewer');

    let n = 0;
    const guard = async (label: string, c: typeof A) => {
      n += 1;
      const email = `${label}@example.invalid`;
      const userId = await user(email, 'guard', label);
      const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,'07000000000') RETURNING id`,
        [userId, `${label} Guard`, `93000000000000${String(n).padStart(2, '0')}`]);
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [c.id, id]);
      const start = new Date(Date.now() - HOUR);
      const shift = await one(`INSERT INTO shifts ("companyId","siteId","siteName",status,"guardId",start,"end","checkCallIntervalMinutes") VALUES ($1,$2,'Depot','in_progress',$3,$4,$5,60) RETURNING id`,
        [c.id, c.siteId, id, start, new Date(start.getTime() + 8 * HOUR)]);
      return { id: id as number, userId, email, label, shiftId: shift.id as number, token: await tokenOf(email) };
    };

    /** The Emergency recipient rule (S4-EM-01): the owner, plus ACTIVE alerts.manage members, whose account is active. */
    const ALERT_ROLES = Object.entries(ROLE_PERMISSIONS).filter(([, set]) => set.has(CompanyPermission.ALERTS_MANAGE)).map(([role]) => role);
    const recipientsByRule = async (companyId: number) =>
      (await q(
        `SELECT u.id FROM users u
          WHERE u.status = 'active' AND u."deletionCompletedAt" IS NULL
            AND (u.id = (SELECT "userId" FROM companies WHERE id = $1)
                 OR EXISTS (SELECT 1 FROM company_memberships m WHERE m."userId" = u.id AND m."companyId" = $1
                             AND m.status = 'active' AND m."membershipRole"::text = ANY($2::text[])))
          ORDER BY u.id`,
        [companyId, ALERT_ROLES],
      )).map((r: any) => Number(r.id));
    const raiseEmergency = async (g: Awaited<ReturnType<typeof guard>>) => {
      const r = await api('POST', '/alerts', g.token, { shiftId: g.shiftId, type: 'panic', priority: 'critical', message: 'Need help now' });
      assert.equal(r.status, 201, `emergency raised: ${msg(r)}`);
      return r.body.id as number;
    };
    const emergencyNotified = async (userId: number, guardLabel: string) =>
      Number((await one(`SELECT count(*)::int n FROM notifications WHERE "userId" = $1 AND title LIKE 'EMERGENCY%' AND message LIKE $2`, [userId, `%${guardLabel}%`])).n) > 0;

    // ── STAFF-01 ───────────────────────────────────────────────────────────────────────────────────────
    await test('STAFF-01-OWNER-AND-STAFF-MANAGE-LIST-THE-TEAM-OTHERS-REFUSED', async () => {
      const r = await api('GET', '/company-staff', A.token);
      assert.equal(r.status, 200, msg(r));
      assert.equal(r.body.yourRole, 'owner');
      assert.deepEqual(r.body.grantableRoles, ['admin', 'operations', 'control_room', 'hr_compliance', 'finance', 'viewer']);
      const owner = r.body.members.find((m: any) => m.userId === A.ownerId);
      assert.equal(owner.role, 'owner');
      assert.equal(owner.isYou, true);
      assert.equal(owner.manageable, false, 'the owner is never manageable');
      assert.equal(owner.receivesEmergencyAlerts, true);
      assert.equal(owner.email, A.ownerEmail);
      const ops = r.body.members.find((m: any) => m.userId === opsA.userId);
      assert.deepEqual(Object.keys(ops).sort(), ['email', 'isYou', 'joinedAt', 'manageable', 'name', 'receivesEmergencyAlerts', 'role', 'status', 'userId']);
      assert.equal(ops.manageable, true);
      assert.equal(ops.receivesEmergencyAlerts, true);
      assert.equal(r.body.members.find((m: any) => m.userId === hrA.userId).receivesEmergencyAlerts, false, 'HR / Compliance does not get Emergencies');
      assert.ok(!r.body.members.some((m: any) => m.userId === viewerB.userId || m.userId === B.ownerId), 'no other company');

      const asAdmin = await api('GET', '/company-staff', adminA.token);
      assert.equal(asAdmin.status, 200);
      assert.equal(asAdmin.body.yourRole, 'admin');
      assert.deepEqual(asAdmin.body.grantableRoles, ['operations', 'control_room', 'hr_compliance', 'finance', 'viewer'], 'Admin cannot grant Admin');
      assert.equal(asAdmin.body.members.find((m: any) => m.userId === admin2A.userId).manageable, false, 'an Admin cannot manage another Admin');
      for (const s of [opsA, hrA, viewerB]) assert.equal((await api('GET', '/company-staff', s.token)).status, 403, 'no staff.manage, no team list');
    });

    // ── STAFF-02 ───────────────────────────────────────────────────────────────────────────────────────
    const crEmail = 'stalpha.newcr@example.invalid';
    let crToken = '';
    await test('STAFF-02-INVITATION-EMAILED-DIGEST-ONLY-7-DAYS-NO-TOKEN-IN-RESPONSE', async () => {
      const before = Date.now();
      const r = await api('POST', '/company-staff/invitations', A.token, { email: '  StAlpha.NewCR@Example.Invalid ', role: 'control_room' });
      assert.equal(r.status, 201, msg(r));
      assert.equal(r.body.emailSent, true);
      assert.deepEqual(Object.keys(r.body.invitation).sort(), ['createdAt', 'email', 'expiresAt', 'id', 'role', 'state']);
      assert.equal(r.body.invitation.email, crEmail, 'address normalised');
      assert.equal(r.body.invitation.state, 'PENDING');
      const { token, mail } = tokenFor(crEmail);
      crToken = token;
      assert.ok(token.length >= 40, 'a 256-bit token');
      assert.ok(mail.text.startsWith('You have been invited to join stalpha Ltd on S4'));
      assert.ok(mail.text.includes('as Control Room'));
      assert.ok(mail.text.includes('https://app.sfour.co.uk/join-company?token='), 'a web link on S4_WEB_APP_URL');
      assert.ok(!r.text.includes(token) && !r.text.includes(sha(token)), 'neither token nor digest in the response');
      const row = await one(`SELECT * FROM company_invitations WHERE id = $1`, [r.body.invitation.id]);
      assert.equal(row.tokenDigest, sha(token), 'only the SHA-256 digest is stored');
      assert.ok(!JSON.stringify(row).includes(token), 'no plaintext anywhere in the row');
      const ttl = new Date(row.expiresAt).getTime() - before;
      assert.ok(Math.abs(ttl - STAFF_INVITATION_TTL_MS) < 60_000, '7-day expiry');
      const list = await api('GET', '/company-staff', A.token);
      assert.ok(list.body.invitations.some((i: any) => i.email === crEmail && i.state === 'PENDING'));
      assert.ok(!list.text.includes(token) && !list.text.includes(sha(token)));
    });

    // ── STAFF-03 ───────────────────────────────────────────────────────────────────────────────────────
    await test('STAFF-03-DUPLICATES-REFUSED', async () => {
      assert.equal((await api('POST', '/company-staff/invitations', A.token, { email: crEmail, role: 'viewer' })).status, 409, 'already waiting');
      assert.equal((await api('POST', '/company-staff/invitations', A.token, { email: opsA.email.toUpperCase(), role: 'viewer' })).status, 409, 'already on the team');
      assert.equal((await api('POST', '/company-staff/invitations', A.token, { email: A.ownerEmail, role: 'viewer' })).status, 409, 'the owner');
      assert.equal((await api('POST', '/company-staff/invitations', A.token, { email: 'not-an-email', role: 'viewer' })).status, 400);
      assert.equal((await api('POST', '/company-staff/invitations', A.token, { email: 'x@example.invalid', role: 'superuser' })).status, 400);
    });

    // ── STAFF-04 ───────────────────────────────────────────────────────────────────────────────────────
    await test('STAFF-04-ESCALATION-REFUSED', async () => {
      const invite = (t: string, email: string, role: string) => api('POST', '/company-staff/invitations', t, { email, role });
      assert.equal((await invite(A.token, 'own1@example.invalid', 'owner')).status, 403, 'nobody grants Owner, not even the Owner');
      assert.equal((await invite(adminA.token, 'own2@example.invalid', 'owner')).status, 403);
      assert.equal((await invite(adminA.token, 'adm@example.invalid', 'admin')).status, 403, 'Admin is granted by the Owner only');
      assert.equal((await invite(opsA.token, 'v@example.invalid', 'viewer')).status, 403, 'no staff.manage, no invitations');
      assert.equal((await invite(hrA.token, 'v@example.invalid', 'viewer')).status, 403);
      assert.equal(Number((await one(`SELECT count(*)::int n FROM company_invitations WHERE email IN ('own1@example.invalid','own2@example.invalid','adm@example.invalid','v@example.invalid')`)).n), 0, 'nothing created');

      const role = (t: string, userId: number, r: string) => api('PATCH', `/company-staff/members/${userId}/role`, t, { role: r });
      const revoke = (t: string, userId: number) => api('POST', `/company-staff/members/${userId}/revoke`, t);
      assert.equal((await role(adminA.token, admin2A.userId, 'viewer')).status, 403, 'Admin cannot change another Admin');
      assert.equal((await revoke(adminA.token, admin2A.userId)).status, 403, 'Admin cannot revoke another Admin');
      assert.equal((await role(adminA.token, opsA.userId, 'admin')).status, 403, 'Admin cannot promote to Admin');
      assert.equal((await role(A.token, opsA.userId, 'owner')).status, 403, 'nobody grants Owner');
      assert.equal((await role(adminA.token, A.ownerId, 'viewer')).status, 403, 'the Owner cannot be changed');
      assert.equal((await revoke(adminA.token, A.ownerId)).status, 403, 'the Owner cannot be revoked');
      assert.equal((await role(adminA.token, adminA.userId, 'viewer')).status, 403, 'not yourself');
      assert.equal((await revoke(adminA.token, adminA.userId)).status, 403, 'not yourself');
      assert.equal((await revoke(A.token, A.ownerId)).status, 403, 'the Owner cannot revoke themselves');
      assert.equal((await role(opsA.token, hrA.userId, 'viewer')).status, 403, 'no staff.manage');
      assert.equal((await revoke(hrA.token, opsA.userId)).status, 403, 'no staff.manage');
      const rows = await q(`SELECT "userId", "membershipRole"::text AS role, status::text AS status FROM company_memberships WHERE "companyId" = $1 ORDER BY "userId"`, [A.id]);
      assert.deepEqual(rows.map((r: any) => `${r.role}:${r.status}`), ['admin:active', 'admin:active', 'operations:active', 'hr_compliance:active'], 'nothing changed');
      // Within their authority, an Admin can invite.
      const ok = await invite(adminA.token, 'stalpha.byadmin@example.invalid', 'viewer');
      assert.equal(ok.status, 201, msg(ok));
      tokenFor('stalpha.byadmin@example.invalid');
    });

    // ── STAFF-05 ───────────────────────────────────────────────────────────────────────────────────────
    let cr = { userId: 0, token: '' };
    await test('STAFF-05-ACCEPT-CREATES-A-VERIFIED-STAFF-ACCOUNT-WITH-THE-INVITED-ROLE', async () => {
      const r = await api('POST', '/company-staff-invitations/accept', null, { token: crToken, firstName: 'Casey', lastName: 'Control', password: NEW_PASSWORD });
      assert.equal(r.status, 200, msg(r));
      assert.deepEqual(Object.keys(r.body).sort(), ['accepted', 'companyName', 'email', 'message', 'role']);
      assert.equal(r.body.email, crEmail);
      assert.equal(r.body.role, 'control_room');
      assert.equal(r.body.companyName, 'stalpha Ltd');
      assert.ok(!r.text.includes(crToken));
      const u = await one(`SELECT id, role::text AS role, status::text AS status, "isEmailVerified", "firstName", "lastName", "passwordHash" FROM users WHERE email = $1`, [crEmail]);
      assert.equal(u.role, 'company_staff');
      assert.equal(u.status, 'active');
      assert.equal(u.isEmailVerified, true, 'the emailed link verified the address');
      assert.equal(`${u.firstName} ${u.lastName}`, 'Casey Control');
      assert.ok(await bcrypt.compare(NEW_PASSWORD, u.passwordHash), 'the chosen password, hashed');
      const m = await one(`SELECT "membershipRole"::text AS role, status::text AS status, "invitedByUserId" FROM company_memberships WHERE "userId" = $1 AND "companyId" = $2`, [u.id, A.id]);
      assert.deepEqual(m, { role: 'control_room', status: 'active', invitedByUserId: A.ownerId });
      assert.ok((await one(`SELECT "usedAt" FROM company_invitations WHERE "tokenDigest" = $1`, [sha(crToken)])).usedAt, 'spent');

      const signIn = await login(crEmail, NEW_PASSWORD, true);
      assert.equal(signIn.status, 201, msg(signIn));
      assert.equal(signIn.body.user.role, 'company_staff');
      const perms: string[] = signIn.body.user.companyPermissions;
      assert.deepEqual([...perms].sort(), [...ROLE_PERMISSIONS.control_room].filter((p) => !p.startsWith('patrols.')).sort(), 'exactly Control Room (patrols off)');
      assert.ok(perms.includes('alerts.manage') && !perms.includes('staff.manage'));
      cr = { userId: Number(u.id), token: signIn.body.accessToken };
      (cr as any).refreshToken = signIn.body.refreshToken;
      assert.equal((await api('GET', '/company-staff', cr.token)).status, 403, 'Control Room cannot manage staff');
      const list = await api('GET', '/company-staff', A.token);
      const row = list.body.members.find((x: any) => x.userId === cr.userId);
      assert.equal(row.name, 'Casey Control');
      assert.equal(row.receivesEmergencyAlerts, true);
      assert.ok(!list.body.invitations.some((i: any) => i.email === crEmail), 'no longer an open invitation');
    });

    // ── STAFF-06 ───────────────────────────────────────────────────────────────────────────────────────
    const g1 = await guard('stg1', A);
    await test('STAFF-06-AN-ACCEPTED-CONTROL-ROOM-MEMBER-RECEIVES-EMERGENCIES', async () => {
      const rule = await recipientsByRule(A.id);
      assert.ok(rule.includes(cr.userId), 'the new member fits the Emergency recipient rule');
      assert.ok(!rule.includes(hrA.userId));
      if (emergency) {
        assert.deepEqual(await emergency.emergencyRecipientUserIds(ds.manager, A.id), rule, 'S4-EM-01 recipients match the rule');
      }
      await raiseEmergency(g1);
      if (emergency) {
        assert.ok(await emergencyNotified(cr.userId, g1.label), 'the Control Room member was notified of the Emergency');
        assert.ok(!(await emergencyNotified(hrA.userId, g1.label)));
        console.log('     (S4-EM-01 present: real Emergency notification checked)');
      } else {
        console.log('     (S4-EM-01 not in this build: recipient rule checked; the notification check runs once it is merged)');
      }
    });

    // ── STAFF-07 ───────────────────────────────────────────────────────────────────────────────────────
    await test('STAFF-07-USED-UNKNOWN-EXPIRED-AND-CANCELLED-LINKS-REFUSED-GENERICALLY', async () => {
      const accept = (token: string, email = 'x') => api('POST', '/company-staff-invitations/accept', null, { token, firstName: 'A', lastName: email, password: NEW_PASSWORD });
      const reused = await accept(crToken);
      assert.equal(reused.status, 400);
      assert.equal(msg(reused), INVALID_STAFF_INVITATION, 'used');
      const unknown = await accept('not-a-real-token-at-all-0123456789abcdefghij');
      assert.equal(unknown.status, 400);
      assert.equal(msg(unknown), INVALID_STAFF_INVITATION, 'unknown');

      assert.equal((await api('POST', '/company-staff/invitations', A.token, { email: 'stalpha.expired@example.invalid', role: 'viewer' })).status, 201);
      const expired = tokenFor('stalpha.expired@example.invalid').token;
      await q(`UPDATE company_invitations SET "expiresAt" = now() - interval '1 minute' WHERE "tokenDigest" = $1`, [sha(expired)]);
      const e = await accept(expired);
      assert.equal(e.status, 400);
      assert.equal(msg(e), INVALID_STAFF_INVITATION, 'expired');
      const listed = await api('GET', '/company-staff', A.token);
      assert.equal(listed.body.invitations.find((i: any) => i.email === 'stalpha.expired@example.invalid').state, 'EXPIRED');

      const inv = await api('POST', '/company-staff/invitations', A.token, { email: 'stalpha.cancel@example.invalid', role: 'operations' });
      const cancelled = tokenFor('stalpha.cancel@example.invalid').token;
      const c = await api('POST', `/company-staff/invitations/${inv.body.invitation.id}/cancel`, A.token);
      assert.equal(c.status, 200, msg(c));
      assert.equal(c.body.state, 'CANCELLED');
      assert.equal((await api('POST', `/company-staff/invitations/${inv.body.invitation.id}/cancel`, A.token)).status, 409, 'already cancelled');
      const x = await accept(cancelled);
      assert.equal(x.status, 400);
      assert.equal(msg(x), INVALID_STAFF_INVITATION, 'cancelled');
      assert.equal(Number((await one(`SELECT count(*)::int n FROM users WHERE email IN ('stalpha.expired@example.invalid','stalpha.cancel@example.invalid')`)).n), 0, 'no account created');
      const fails = await q(`SELECT "afterData"->>'reason' AS reason FROM audit_logs WHERE action = 'company.staff.invitation_accept_failed' ORDER BY id`);
      assert.deepEqual(fails.map((f: any) => f.reason), ['accepted', 'unknown', 'expired', 'cancelled']);
    });

    // ── STAFF-08 ───────────────────────────────────────────────────────────────────────────────────────
    await test('STAFF-08-AN-EXISTING-ACCOUNT-IS-REFUSED-CLEARLY-AND-NOTHING-IS-CREATED', async () => {
      // A Guard elsewhere on S4, not on this team.
      const existing = 'stg1@example.invalid';
      const inv = await api('POST', '/company-staff/invitations', A.token, { email: existing, role: 'viewer' });
      assert.equal(inv.status, 201, msg(inv));
      const { token } = tokenFor(existing);
      const usersBefore = Number((await one(`SELECT count(*)::int n FROM users`)).n);
      const r = await api('POST', '/company-staff-invitations/accept', null, { token, firstName: 'Ex', lastName: 'Isting', password: NEW_PASSWORD });
      assert.equal(r.status, 409);
      assert.equal(msg(r), STAFF_INVITATION_ACCOUNT_EXISTS);
      assert.equal(r.body.code, 'STAFF_INVITATION_ACCOUNT_EXISTS');
      assert.equal(Number((await one(`SELECT count(*)::int n FROM users`)).n), usersBefore, 'no account created');
      assert.equal(Number((await one(`SELECT count(*)::int n FROM company_memberships m JOIN users u ON u.id = m."userId" WHERE u.email = $1`, [existing])).n), 0, 'no membership');
      const row = await one(`SELECT "usedAt" FROM company_invitations WHERE "tokenDigest" = $1`, [sha(token)]);
      assert.equal(row.usedAt, null, 'the invitation is not spent');
      const guardLogin = await login(existing);
      assert.equal(guardLogin.status, 201, 'the existing account is untouched');
      assert.equal(guardLogin.body.user.role, 'guard');
    });

    // ── STAFF-09 ───────────────────────────────────────────────────────────────────────────────────────
    await test('STAFF-09-ANOTHER-COMPANY-CANNOT-SEE-OR-ACT', async () => {
      const aInvite = await one(`SELECT id FROM company_invitations WHERE "companyId" = $1 AND "usedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt" > now() ORDER BY id LIMIT 1`, [A.id]);
      assert.equal((await api('POST', `/company-staff/invitations/${aInvite.id}/cancel`, B.token)).status, 404);
      assert.equal((await api('PATCH', `/company-staff/members/${opsA.userId}/role`, B.token, { role: 'viewer' })).status, 404);
      assert.equal((await api('POST', `/company-staff/members/${opsA.userId}/revoke`, B.token)).status, 404);
      assert.equal((await api('POST', `/company-staff/members/${viewerB.userId}/revoke`, A.token)).status, 404, 'and the reverse');
      const listB = await api('GET', '/company-staff', B.token);
      const ids = listB.body.members.map((m: any) => m.userId).sort((x: number, y: number) => x - y);
      assert.deepEqual(ids, [B.ownerId, viewerB.userId].sort((x, y) => x - y));
      assert.equal(listB.body.invitations.length, 0);
      for (const t of ['stalpha', 'Casey']) assert.ok(!listB.text.includes(t), `nothing of company A (${t})`);
      assert.equal((await one(`SELECT status::text AS s FROM company_memberships WHERE "userId" = $1`, [opsA.userId])).s, 'active', 'unchanged');
      assert.equal((await one(`SELECT "revokedAt" FROM company_invitations WHERE id = $1`, [aInvite.id])).revokedAt, null, 'unchanged');
    });

    // ── STAFF-10 ───────────────────────────────────────────────────────────────────────────────────────
    await test('STAFF-10-ROLE-CHANGE-IS-AUDITED-AND-TAKES-EFFECT', async () => {
      await q(`UPDATE company_memberships SET "canAmendShifts" = true WHERE "userId" = $1`, [cr.userId]);
      const r = await api('PATCH', `/company-staff/members/${cr.userId}/role`, adminA.token, { role: 'viewer' });
      assert.equal(r.status, 200, msg(r));
      assert.deepEqual(r.body, { userId: cr.userId, role: 'viewer', status: 'active' });
      const asViewer = await login(crEmail, NEW_PASSWORD);
      assert.ok(!asViewer.body.user.companyPermissions.includes('alerts.manage'), 'a Viewer has no alerts.manage');
      assert.ok(!(await recipientsByRule(A.id)).includes(cr.userId), 'a Viewer is not an Emergency recipient');
      assert.equal((await api('PATCH', `/company-staff/members/${cr.userId}/role`, adminA.token, { role: 'viewer' })).status, 409, 'no-op refused');
      const back = await api('PATCH', `/company-staff/members/${cr.userId}/role`, adminA.token, { role: 'control_room' });
      assert.equal(back.status, 200, msg(back));
      const m = await one(`SELECT "canAmendShifts" FROM company_memberships WHERE "userId" = $1`, [cr.userId]);
      assert.equal(m.canAmendShifts, false, 'a per-person authorisation never carries over a role change');
      const audit = await q(`SELECT "userId","companyId","beforeData","afterData" FROM audit_logs WHERE action = 'company.staff.role_changed' ORDER BY id`);
      assert.equal(audit.length, 2);
      assert.equal(audit[0].userId, adminA.userId);
      assert.equal(audit[0].companyId, A.id);
      assert.equal(audit[0].beforeData.role, 'control_room');
      assert.equal(audit[0].beforeData.canAmendShifts, true);
      assert.equal(audit[0].afterData.role, 'viewer');
    });

    // ── STAFF-11 ───────────────────────────────────────────────────────────────────────────────────────
    const g2 = await guard('stg2', A);
    await test('STAFF-11-REVOKE-ENDS-SESSIONS-ACCESS-AND-EMERGENCIES', async () => {
      const mobile = await login(crEmail, NEW_PASSWORD, true);
      assert.equal(mobile.status, 201);
      const refreshToken = mobile.body.refreshToken as string;
      assert.ok(refreshToken, 'a renewable session');
      const accessToken = mobile.body.accessToken as string;
      assert.equal((await api('GET', '/alerts/company', accessToken)).status, 200, 'before: Control Room reads alerts');

      const r = await api('POST', `/company-staff/members/${cr.userId}/revoke`, A.token);
      assert.equal(r.status, 200, msg(r));
      assert.deepEqual(r.body, { userId: cr.userId, role: 'control_room', status: 'suspended' });
      const m = await one(`SELECT status::text AS status, "disabledAt", "disabledByUserId" FROM company_memberships WHERE "userId" = $1`, [cr.userId]);
      assert.equal(m.status, 'suspended');
      assert.ok(m.disabledAt);
      assert.equal(m.disabledByUserId, A.ownerId);
      const live = Number((await one(`SELECT count(*)::int n FROM auth_sessions WHERE "userId" = $1 AND "revokedAt" IS NULL`, [cr.userId])).n);
      assert.equal(live, 0, 'every session ended');
      assert.equal((await one(`SELECT DISTINCT "revokedReason" AS r FROM auth_sessions WHERE "userId" = $1 AND "revokedReason" <> 'rotated'`, [cr.userId])).r, 'company_access_revoked');
      const refresh = await api('POST', '/auth/refresh', null, { refreshToken });
      assert.equal(refresh.status, 401, 'the refresh token is dead');
      const after = await api('GET', '/alerts/company', accessToken);
      assert.ok([403, 404].includes(after.status), `company data refused at once (${after.status})`);
      assert.equal((await api('GET', '/company-guards', accessToken)).status, 403, 'membership-resolved routes: 403 suspended');
      assert.equal((await api('POST', `/company-staff/members/${cr.userId}/revoke`, A.token)).status, 409, 'already revoked');
      assert.equal((await api('PATCH', `/company-staff/members/${cr.userId}/role`, A.token, { role: 'viewer' })).status, 409, 'no role change once revoked');

      assert.ok(!(await recipientsByRule(A.id)).includes(cr.userId), 'no longer an Emergency recipient');
      if (emergency) assert.ok(!(await emergency.emergencyRecipientUserIds(ds.manager, A.id)).includes(cr.userId));
      await raiseEmergency(g2);
      if (emergency) {
        assert.ok(!(await emergencyNotified(cr.userId, g2.label)), 'not notified after revocation');
        assert.ok(await emergencyNotified(opsA.userId, g2.label), 'responders still are');
      }
      const listed = await api('GET', '/company-staff', A.token);
      const row = listed.body.members.find((x: any) => x.userId === cr.userId);
      assert.equal(row.status, 'suspended');
      assert.equal(row.receivesEmergencyAlerts, false);
      assert.equal(row.manageable, true);
    });

    // ── STAFF-12 ───────────────────────────────────────────────────────────────────────────────────────
    await test('STAFF-12-CAPABILITIES-UNAPPROVED-CANNOT-INVITE-SUSPENDED-CAN-STILL-REVOKE', async () => {
      const pending = await api('POST', '/company-staff/invitations', P.token, { email: 'stpending.x@example.invalid', role: 'viewer' });
      assert.equal(pending.status, 403);
      assert.equal(pending.body.code, 'COMPANY_NOT_APPROVED');
      assert.equal(pending.body.capability, 'new_operations');

      const sMember = await member(S, 'stsusp.ops', 'operations');
      const inv = await api('POST', '/company-staff/invitations', S.token, { email: 'stsusp.new@example.invalid', role: 'viewer' });
      assert.equal(inv.status, 201);
      const { token } = tokenFor('stsusp.new@example.invalid');
      const inv2 = await api('POST', '/company-staff/invitations', S.token, { email: 'stsusp.new2@example.invalid', role: 'viewer' });
      tokenFor('stsusp.new2@example.invalid');
      await q(`UPDATE companies SET "verificationStatus" = 'suspended' WHERE id = $1`, [S.id]);

      const refused = await api('POST', '/company-staff/invitations', S.token, { email: 'stsusp.more@example.invalid', role: 'viewer' });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, 'COMPANY_NOT_APPROVED');
      assert.equal((await api('PATCH', `/company-staff/members/${sMember.userId}/role`, S.token, { role: 'viewer' })).body.code, 'COMPANY_NOT_APPROVED', 'role change is set-up');
      const accept = await api('POST', '/company-staff-invitations/accept', null, { token, firstName: 'Sus', lastName: 'Pended', password: NEW_PASSWORD });
      assert.equal(accept.status, 400);
      assert.equal(msg(accept), INVALID_STAFF_INVITATION, 'a suspended company\'s link is refused like any invalid link');
      const cancel = await api('POST', `/company-staff/invitations/${inv2.body.invitation.id}/cancel`, S.token);
      assert.equal(cancel.status, 200, `a suspended company can still cancel: ${msg(cancel)}`);
      const revoke = await api('POST', `/company-staff/members/${sMember.userId}/revoke`, S.token);
      assert.equal(revoke.status, 200, `a suspended company can still revoke access: ${msg(revoke)}`);
      assert.equal((await api('GET', '/company-staff', S.token)).status, 200, 'and read its team');
    });

    // ── STAFF-13 ───────────────────────────────────────────────────────────────────────────────────────
    await test('STAFF-13-EVERY-ACTION-AUDITED-NO-TOKEN-ANYWHERE', async () => {
      const actions = (await q(`SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'company.staff.%' ORDER BY action`)).map((r: any) => r.action);
      for (const a of ['company.staff.access_revoked', 'company.staff.invitation_accepted', 'company.staff.invitation_cancelled', 'company.staff.invited', 'company.staff.role_changed']) {
        assert.ok(actions.includes(a), `${a} audited`);
      }
      const invited = await one(`SELECT "userId","companyId","afterData" FROM audit_logs WHERE action = 'company.staff.invited' ORDER BY id LIMIT 1`);
      assert.deepEqual([invited.userId, invited.companyId, invited.afterData.email, invited.afterData.role], [A.ownerId, A.id, crEmail, 'control_room']);
      const accepted = await one(`SELECT "userId","companyId","afterData" FROM audit_logs WHERE action = 'company.staff.invitation_accepted' ORDER BY id LIMIT 1`);
      assert.deepEqual([accepted.userId, accepted.companyId, accepted.afterData.role], [cr.userId, A.id, 'control_room']);
      const revoked = await one(`SELECT "userId","afterData" FROM audit_logs WHERE action = 'company.staff.access_revoked' ORDER BY id LIMIT 1`);
      assert.equal(revoked.userId, A.ownerId);
      assert.equal(revoked.afterData.sessionsRevoked, true);

      assert.ok(tokens.length >= 7, `tokens collected (${tokens.length})`);
      const audit = JSON.stringify(await q(`SELECT * FROM audit_logs`));
      const logs = captured.join('\n');
      const bodies = responses.join('\n');
      for (const t of tokens) {
        assert.ok(!audit.includes(t) && !audit.includes(sha(t)) && !audit.includes(sha(t).slice(0, 8)), 'no token or digest in the audit trail');
        assert.ok(!logs.includes(t), 'no token in any log line');
        assert.ok(!bodies.includes(t) && !bodies.includes(sha(t)), 'no token or digest in any API response');
      }
    });

    // ── STAFF-14 ───────────────────────────────────────────────────────────────────────────────────────
    await test('STAFF-14-ACCEPT-VALIDATES-INPUT', async () => {
      assert.equal((await api('POST', '/company-staff/invitations', A.token, { email: 'stalpha.valid@example.invalid', role: 'finance' })).status, 201);
      const { token } = tokenFor('stalpha.valid@example.invalid');
      const accept = (body: Record<string, unknown>) => api('POST', '/company-staff-invitations/accept', null, body);
      assert.equal((await accept({ token, firstName: 'V', lastName: 'Alid', password: '123' })).status, 400, 'short password');
      assert.equal((await accept({ token, firstName: '   ', lastName: 'Alid', password: NEW_PASSWORD })).status, 400, 'blank name');
      assert.equal((await accept({ token, lastName: 'Alid', password: NEW_PASSWORD })).status, 400, 'missing name');
      assert.equal((await accept({ token, firstName: 'V', lastName: 'Alid', password: NEW_PASSWORD, role: 'owner' })).status, 400, 'no extra fields (cannot choose a role)');
      const ok = await accept({ token, firstName: 'V', lastName: 'Alid', password: NEW_PASSWORD });
      assert.equal(ok.status, 200, msg(ok));
      assert.equal(ok.body.role, 'finance', 'the invited role, nothing else');
      assert.equal((await one(`SELECT "isEmailVerified" FROM users WHERE email = 'stalpha.valid@example.invalid'`)).isEmailVerified, true);
    });

    // ── STAFF-15 ───────────────────────────────────────────────────────────────────────────────────────
    await test('STAFF-15-REVOKE-ENDS-COMPANY-ACCESS-BUT-NOT-AN-INDEPENDENT-ACCOUNT', async () => {
      // A person whose S4 account is not a company-staff account (here a Guard login) but who holds a membership:
      // revocation must end their access to THIS company at once without signing them out of their own account.
      const email = 'stalpha.indep@example.invalid';
      const userId = await user(email, 'guard', 'Indep');
      await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,'operations','active')`, [userId, A.id]);
      const session = await login(email, PASSWORD, true);
      assert.equal(session.status, 201, msg(session));
      const before = Number((await one(`SELECT count(*)::int n FROM auth_sessions WHERE "userId" = $1 AND "revokedAt" IS NULL`, [userId])).n);
      assert.ok(before >= 1);
      const r = await api('POST', `/company-staff/members/${userId}/revoke`, A.token);
      assert.equal(r.status, 200, msg(r));
      assert.equal((await one(`SELECT status::text AS s FROM company_memberships WHERE "userId" = $1 AND "companyId" = $2`, [userId, A.id])).s, 'suspended');
      const after = Number((await one(`SELECT count(*)::int n FROM auth_sessions WHERE "userId" = $1 AND "revokedAt" IS NULL`, [userId])).n);
      assert.equal(after, before, 'their own sessions are untouched');
      assert.ok(!(await recipientsByRule(A.id)).includes(userId), 'not an Emergency recipient');
      const audit = await one(`SELECT "afterData" FROM audit_logs WHERE action = 'company.staff.access_revoked' AND "afterData"::jsonb ->> 'userId' = $1`, [String(userId)]);
      assert.equal(audit.afterData.sessionsRevoked, false);
    });

    console.log(JSON.stringify({ event: 'company_staff_tests_passed', tests: passed, emergencyModule: !!emergency }));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
