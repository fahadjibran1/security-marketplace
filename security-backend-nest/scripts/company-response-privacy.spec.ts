/**
 * Company-facing response minimisation, over real HTTP against a real Nest app and a LOCAL, disposable PostgreSQL.
 *
 * Company users (every membership role) read workforce, shifts, attendance, timesheets, incidents, logs, alerts,
 * leave, availability, compliance, notifications, attachments, audit and finance records. Those responses must carry
 * what the role needs for its work and nothing about a guard's or the company owner's account.
 *
 *   WORKFORCE-ALLOWLIST   GET /company-guards: exact field set per membership role and relationship status
 *                         (ACTIVE / INACTIVE / BLOCKED); relationship fields id, status, relationshipType, acceptedAt,
 *                         createdAt, company {id, name}
 *   GUARDS-ALLOWLIST      GET /guards and /guards/:id for company users: the same role/status rules
 *   NESTED-GUARD          every guard nested in another company record is {id, fullName}
 *   ACTOR                 nested user accounts are an actor reference; a guard actor has no email
 *   NO-OWNER-ACCOUNT      no company object carries the owner's user account
 *   FORBIDDEN-KEYS        no account metadata, approval flags, location sharing or guard notes anywhere
 *   CONTACT               a guard's phone reaches only Owner/Admin/Operations/Control Room, only for an ACTIVE guard,
 *                         and only through the workforce list; never for INACTIVE, BLOCKED, applicant or unrelated guards
 *   TENANT                nothing from another company's guard appears in this company's responses
 *   APPLICANT             an applicant's account and contact details are not exposed through applications
 *   USABLE                the records still carry guard id and name, and every company route still answers
 *   ADMIN / GUARD-OWNED   Platform Admin and guard-owned responses keep their existing shape
 *   HIRE / INVITATION     invitation acceptance and hiring still create the ACTIVE relationship
 *   SCOPE                 the defence-in-depth projection is attached to exactly the listed company controllers,
 *                         is not global, and leaves admin, guard and non-entity responses untouched
 *
 * The spec collects every violation before failing, so a run against an unfixed build lists them all.
 *
 * Requires COMPANY_PRIVACY_DATABASE_URL; the host must be local. Migrations are applied, nothing is dropped. Every
 * account and record is synthetic.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { StreamableFile, ValidationPipe } from '@nestjs/common';
import { NestFactory, ModulesContainer, ModuleRef } from '@nestjs/core';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { AuthService } from '../src/auth/auth.service';
import { AdminOperatorService } from '../src/admin-operator/admin-operator.service';

const url = process.env.COMPANY_PRIVACY_DATABASE_URL;
if (!url) throw new Error('COMPANY_PRIVACY_DATABASE_URL is required');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Company privacy database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'company-privacy-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

const RUN = Date.now().toString(36);
type Res = { status: number; body: any; text: string };
type Session = { token: string; userId: number; companyId?: number; guardId?: number };
const errText = (r: Res) => (Array.isArray(r.body?.message) ? r.body.message.join('; ') : r.body?.message) || '';

// ── Violation collection: every group reports PASS or the list of what it found ──
const failures: string[] = [];
let groupsPassed = 0;
async function group(name: string, run: (fail: (msg: string) => void) => void | Promise<void>) {
  const found: string[] = [];
  try {
    await run((msg) => found.push(msg));
  } catch (e: any) {
    found.push(`threw: ${e?.message ?? e}`);
  }
  if (found.length === 0) {
    groupsPassed += 1;
    console.log(`PASS ${name}`);
  } else {
    const shown = [...new Set(found)];
    console.log(`FAIL ${name} (${shown.length})`);
    for (const f of shown.slice(0, 25)) console.log(`     - ${f}`);
    if (shown.length > 25) console.log(`     … ${shown.length - 25} more`);
    failures.push(name);
  }
}

const sorted = (o: object) => Object.keys(o).sort().join(',');
const sameKeys = (o: object, keys: string[]) => sorted(o) === [...keys].sort().join(',');

/** Every object in a JSON value, with the key it sits under (or the array key its element sits in). */
function walk(value: unknown, visit: (obj: Record<string, any>, key: string, path: string) => void, key = '', path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, visit, key, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    visit(value as Record<string, any>, key, path);
    for (const [k, v] of Object.entries(value)) walk(v, visit, k, `${path}.${k}`);
  }
}

// Keys that are account metadata or internal guard state and must never reach a company user.
const FORBIDDEN_KEYS = [
  'passwordHash', 'isEmailVerified', 'emailVerificationRequired', 'deletionRequestedAt', 'deletionCompletedAt',
  'isApproved', 'locationSharingEnabled', 'ninoEnc', 'ninoHmac', 'utrEnc',
];
// Forbidden on a guard object only: a timesheet's own approvalStatus is the company's review state and stays.
const FORBIDDEN_GUARD_KEYS = ['approvalStatus', 'notes', 'status', 'availability', 'user', 'email'];
const GUARD_KEYS = new Set(['guard', 'guards', 'applicant', 'guardProfile']);
const USER_KEYS = new Set(['user', 'uploadedBy', 'actor', 'createdBy', 'reviewedBy', 'acknowledgedBy', 'closedBy']);

async function main() {
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const migrator = new DataSource(
    buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' }),
  );
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
  const expectedDatabase = new URL(url!).pathname.replace(/^\//, '');
  const [{ current_database: actualDatabase }] = await ds.query('SELECT current_database()');
  if (actualDatabase !== expectedDatabase) {
    throw new Error(`Refusing to run: the app is connected to "${actualDatabase}", not "${expectedDatabase}".`);
  }

  const api = async (method: string, path: string, token: string | null, body?: unknown): Promise<Res> => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, text };
  };
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];

  try {
    // ───────────────────────────── Synthetic fixtures ─────────────────────────────
    const auth = app.get(AuthService);
    const password = 'Str0ng-pass-1!';
    const session = async (email: string): Promise<Session> => {
      const s: any = await auth.login({ email, password });
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
    const companyEmail = (label: string) => `${label}.owner.${RUN}@cg-privacy.test`;
    const registerCompany = async (label: string) => {
      const email = companyEmail(label);
      await auth.register({
        email, password, role: 'company' as any, fullName: `${label} Owner`, phone: '02000000000',
        companyName: `${label} ${RUN} Security Ltd`, companyNumber: String(10000000 + Math.floor(Math.random() * 8999999)),
        address: '1 High St, London', contactDetails: `ops@${label}.test`,
      } as any);
      await verifyEmail(email);
      return session(email);
    };
    let siaSeq = Math.floor(Math.random() * 1e6);
    let phoneSeq = 100;
    type GuardFixture = Session & { email: string; phone: string; sia: string; fullName: string };
    const registerGuard = async (label: string): Promise<GuardFixture> => {
      const email = `${label}.${RUN}@cg-privacy.test`;
      const phone = `07700${String(900000 + (phoneSeq += 11))}`;
      const sia = String(6200000000000000 + (siaSeq += 7919));
      const fullName = `${label[0].toUpperCase()}${label.slice(1)} Guard ${RUN}`;
      await auth.register({ email, password, role: 'guard' as any, fullName, phone, siaLicenseNumber: sia } as any);
      await verifyEmail(email);
      return { ...(await session(email)), email, phone, sia, fullName };
    };
    const join = async (company: Session, guard: Session) => {
      const inv = await api('POST', '/company-guards/invitations', company.token, {});
      assert.equal(inv.status, 201, errText(inv));
      const acc = await api('POST', '/guards/me/invitations/accept', guard.token, { code: inv.body.code });
      assert.equal(acc.status, 201, errText(acc));
    };
    const relationId = async (companyId: number, guardId: number): Promise<number> =>
      (await one(`SELECT id FROM company_guards WHERE "companyId" = $1 AND "guardId" = $2`, [companyId, guardId])).id;

    const owner = await registerCompany('alpha');
    const other = await registerCompany('beta');
    const ownerB = other;
    const A = owner.companyId!;
    const B = ownerB.companyId!;

    // Staff for every membership role, in company A. Named, so actor references can be checked.
    const staffHash = await bcrypt.hash(password, 10);
    const ROLES = ['admin', 'operations', 'control_room', 'hr_compliance', 'finance', 'viewer'] as const;
    type StaffRole = (typeof ROLES)[number];
    const staff = {} as Record<StaffRole, Session & { email: string }>;
    for (const role of ROLES) {
      const email = `${role}.${RUN}@cg-privacy.test`;
      const [{ id }] = await q(
        `INSERT INTO users (email, "passwordHash", role, status, "isEmailVerified", "firstName", "lastName")
         VALUES ($1, $2, 'company_staff', 'active', true, $3, 'Staff') RETURNING id`,
        [email, staffHash, role.replace('_', ' ')],
      );
      await q(
        `INSERT INTO company_memberships ("userId", "companyId", "membershipRole", status, "acceptedAt")
         VALUES ($1, $2, $3, 'active', now())`,
        [id, A, role],
      );
      staff[role] = { ...(await session(email)), email };
    }

    const gActive = await registerGuard('active');
    const gInactive = await registerGuard('inactive');
    const gBlocked = await registerGuard('blocked');
    const gApplicant = await registerGuard('applicant');
    const gHire = await registerGuard('hire');
    const gOther = await registerGuard('other');
    for (const g of [gActive, gInactive, gBlocked]) await join(owner, g);
    await join(ownerB, gOther);
    pass('SETUP/INVITATION: three guards joined company A and one joined company B by accepted invitation');

    assert.equal((await api('PATCH', `/company-guards/${await relationId(A, gInactive.guardId!)}`, owner.token, { status: 'INACTIVE' })).status, 200);
    assert.equal((await api('PATCH', `/company-guards/${await relationId(A, gBlocked.guardId!)}`, owner.token, { status: 'BLOCKED' })).status, 200);

    // Internal guard state that must never reach a company: notes, approval, compliance fields.
    const NOTE = `INTERNAL-NOTE-${RUN}`;
    for (const g of [gActive, gInactive, gBlocked, gApplicant, gHire, gOther]) {
      await q(
        `UPDATE guard_profiles SET notes = $2, "rightToWorkStatus" = 'permanent', "siaExpiryDate" = '2031-01-31',
           "locationSharingEnabled" = true WHERE id = $1`,
        [g.guardId, NOTE],
      );
      await q(`UPDATE users SET "lastLoginAt" = now() WHERE id = $1`, [g.userId]);
    }
    await q(`UPDATE users SET "lastLoginAt" = now() WHERE id = $1`, [owner.userId]);

    // Client and site via the API; operational records directly (they are only read here).
    const client = await api('POST', '/clients', owner.token, { name: 'Privacy Client', contactName: 'Pat', contactEmail: 'pat@privacy.test', contactPhone: '02011112222' });
    assert.equal(client.status, 201, errText(client));
    const site = await api('POST', '/sites', owner.token, {
      name: 'Privacy Site', clientId: client.body.id, address: '10 Market Sq, London', welfareCheckIntervalMinutes: 60, requireGpsCheckIn: false,
    });
    assert.equal(site.status, 201, errText(site));
    const siteId: number = site.body.id;

    const job = await one(
      `INSERT INTO jobs ("companyId", title, "guardsRequired", "hourlyRate", status, "siteId") VALUES ($1, 'Privacy job', 3, 15, 'open', $2) RETURNING id`,
      [A, siteId],
    );
    const jobB = await one(
      `INSERT INTO jobs ("companyId", title, "guardsRequired", "hourlyRate", status) VALUES ($1, 'Other job', 1, 15, 'open') RETURNING id`,
      [B],
    );
    for (const [g, j] of [[gApplicant, job.id], [gHire, job.id], [gOther, jobB.id]] as const) {
      const applied = await api('POST', '/job-applications/self', g.token, { jobId: j });
      assert.equal(applied.status, 201, errText(applied));
    }

    const seedOperational = async (companyId: number, g: GuardFixture, sId: number | null) => {
      const shift = await one(
        `INSERT INTO shifts ("companyId", "guardId", "siteId", "siteName", start, "end", status)
         VALUES ($1, $2, $3, 'Privacy Site', now() - interval '3 hours', now() + interval '5 hours', 'in_progress') RETURNING id`,
        [companyId, g.guardId, sId],
      );
      await q(`INSERT INTO attendance_events ("shiftId", "guardId", type) VALUES ($1, $2, 'check-in')`, [shift.id, g.guardId]);
      await q(`INSERT INTO timesheets ("shiftId", "guardId", "companyId") VALUES ($1, $2, $3)`, [shift.id, g.guardId, companyId]);
      const incident = await one(
        `INSERT INTO incidents ("companyId", "guardId", "shiftId", "siteId", title, notes) VALUES ($1, $2, $3, $4, 'Privacy incident', 'Synthetic') RETURNING id`,
        [companyId, g.guardId, shift.id, sId],
      );
      await q(`INSERT INTO daily_logs ("companyId", "guardId", "shiftId", message) VALUES ($1, $2, $3, 'Synthetic log')`, [companyId, g.guardId, shift.id]);
      await q(`INSERT INTO safety_alerts ("companyId", "guardId", "shiftId", message) VALUES ($1, $2, $3, 'Synthetic alert')`, [companyId, g.guardId, shift.id]);
      await q(
        `INSERT INTO guard_leave ("companyId", "guardId", "leaveType", "startAt", "endAt", status)
         VALUES ($1, $2, 'annual_leave', now() + interval '10 days', now() + interval '12 days', 'approved')`,
        [companyId, g.guardId],
      );
      await q(
        `INSERT INTO guard_availability_rules ("companyId", "guardId", weekday, "startTime", "endTime") VALUES ($1, $2, 1, '08:00', '18:00')`,
        [companyId, g.guardId],
      );
      await q(
        `INSERT INTO compliance_records ("companyId", "guardId", type, "documentName", "expiryDate") VALUES ($1, $2, 'SIA', 'SIA licence', '2031-01-31')`,
        [companyId, g.guardId],
      );
      // A notice addressed to the guard, filed under the company (decision 7 follow-up: scoping is not changed here).
      await q(
        `INSERT INTO notifications (type, title, message, "userId", "companyId") VALUES ('shift_offered', 'Offer', 'Synthetic', $1, $2)`,
        [g.userId, companyId],
      );
      await q(
        `INSERT INTO attachments ("entityType", "entityId", "fileName", "fileUrl", "mimeType", "sizeBytes", "companyId", "uploadedById")
         VALUES ('incident', $1, 'photo.jpg', 'private://synthetic/photo.jpg', 'image/jpeg', 10, $2, $3)`,
        [incident.id, companyId, g.userId],
      );
      await q(
        `INSERT INTO audit_logs (action, "entityType", "entityId", "companyId", "userId") VALUES ('attendance.check_in', 'shift', $1, $2, $3)`,
        [shift.id, companyId, g.userId],
      );
    };
    await seedOperational(A, gActive, siteId);
    await seedOperational(A, gInactive, siteId); // historical records of a former guard
    await seedOperational(A, gBlocked, siteId);
    await seedOperational(B, gOther, null);
    await q(
      `INSERT INTO audit_logs (action, "entityType", "entityId", "companyId", "userId") VALUES ('site.updated', 'site', $1, $2, $3)`,
      [siteId, A, staff.operations.userId],
    );

    // Hiring (decision: invitation and hiring workflows still pass).
    const hireApp = await one(`SELECT id FROM job_applications WHERE "guardId" = $1 AND "jobId" = $2`, [gHire.guardId, job.id]);
    const hired = await api('POST', `/job-applications/${hireApp.id}/hire`, owner.token, {});
    const hiredStatus = (await one(`SELECT status FROM company_guards WHERE "companyId" = $1 AND "guardId" = $2`, [A, gHire.guardId]))?.status;
    pass(`SETUP: synthetic operational records seeded for companies A and B`);

    const adminEmail = 'platform.admin@cg-privacy.test';
    const adminPassword = 'Cg-Privacy-Admin-1!';
    const operator = new AdminOperatorService(ds);
    const adminCount = Number((await one(`SELECT count(*) n FROM users WHERE role = 'admin'`)).n);
    if (adminCount === 0) {
      await operator.bootstrap(adminEmail, adminPassword);
    } else if (Number((await one(`SELECT count(*) n FROM users WHERE role = 'admin' AND LOWER(email) = $1`, [adminEmail])).n) === 1) {
      await operator.recover(adminEmail, adminPassword, true);
    } else {
      throw new Error('This database already has a Platform Admin this spec did not create; use a disposable database.');
    }
    const adminLogin: any = await auth.login({ email: adminEmail, password: adminPassword });
    const admin: Session = { token: adminLogin.accessToken, userId: adminLogin.user.id };

    const sessions: Array<{ role: string; s: Session }> = [
      { role: 'owner', s: owner },
      ...ROLES.map((role) => ({ role, s: staff[role] })),
    ];
    const CONTACT_ROLES = new Set(['owner', 'admin', 'operations', 'control_room']);
    const MINIMAL_ROLES = new Set(['finance', 'viewer']);

    // Every company-facing route that returns records involving guards or the company. Each is read by every role.
    const ROUTES = [
      '/company-guards', '/guards', `/guards/${gActive.guardId}`, `/guards/${gInactive.guardId}`,
      '/job-applications', '/job-slots', '/jobs', `/jobs/${job.id}`,
      '/shifts', '/assignments', '/attendance/company', '/timesheets', '/timesheets/company',
      '/incidents/company', '/daily-logs/company', '/alerts/company', '/leave',
      '/availability/rules', '/availability/overrides', '/compliance', '/notifications/company',
      '/attachments/company', '/audit-logs/company', '/companies/me', '/sites', '/clients',
      '/payroll-batches/company', '/invoice-batches/company', '/timesheets/weekly-approvals',
      '/contract-pricing', '/pay-rules', `/client-portal-users/client/${client.body.id}`,
    ];
    const reads: Array<{ role: string; route: string; res: Res }> = [];
    for (const { role, s } of sessions) {
      for (const route of ROUTES) reads.push({ role, route, res: await api('GET', route, s.token) });
    }
    if (hired.status === 201) reads.push({ role: 'owner', route: 'POST /job-applications/:id/hire', res: hired });

    const guardUserIds = new Set([gActive, gInactive, gBlocked, gApplicant, gHire, gOther].map((g) => g.userId));
    const guardEmails = [gActive, gInactive, gBlocked, gApplicant, gHire, gOther].map((g) => g.email);

    // ───────────────────────────── Checks ─────────────────────────────
    await group('USABLE: every company route answers the owner (200), and other roles get 200 or a permission 403', (fail) => {
      for (const r of reads) {
        if (r.role === 'owner' && r.res.status !== 200 && r.route !== 'POST /job-applications/:id/hire') fail(`owner ${r.route} → ${r.res.status} ${errText(r.res)}`);
        // A few older routes resolve the company from the owner's profile only and answer staff 404 "Company not
        // found"; that pre-dates this change and is reported, not hidden.
        const legacyOwnerOnly = r.res.status === 404 && errText(r.res) === 'Company not found';
        if (r.role !== 'owner' && ![200, 403].includes(r.res.status) && !legacyOwnerOnly) fail(`${r.role} ${r.route} → ${r.res.status} ${errText(r.res)}`);
      }
      const denied = reads.filter((r) => r.res.status === 403).map((r) => `${r.role} ${r.route}`);
      const ownerOnly = reads.filter((r) => r.res.status === 404).map((r) => `${r.role} ${r.route}`);
      console.log(`     (permission-denied reads, checked not skipped: ${denied.length ? denied.join('; ') : 'none'})`);
      console.log(`     (owner-only legacy routes answering staff 404: ${ownerOnly.length ? ownerOnly.join('; ') : 'none'})`);
    });

    await group('FORBIDDEN-KEYS: no account metadata, approval flags, location sharing, encrypted ids or guard notes', (fail) => {
      for (const r of reads.filter((x) => x.res.status < 300)) {
        if (r.res.text.includes(NOTE)) fail(`${r.role} ${r.route}: internal guard note text`);
        walk(r.res.body, (obj, key, path) => {
          for (const k of FORBIDDEN_KEYS) if (k in obj) fail(`${r.route} ${path}.${k}`);
          const isGuardObject = (GUARD_KEYS.has(key) || r.route.startsWith('/guards')) && typeof obj.id === 'number' && 'fullName' in obj;
          if (isGuardObject) for (const k of FORBIDDEN_GUARD_KEYS) if (k in obj) fail(`${r.route} ${path}.${k} (guard)`);
          if ('lastLoginAt' in obj && !r.route.startsWith('/client-portal-users')) fail(`${r.route} ${path}.lastLoginAt`);
        });
      }
    });

    await group('NO-OWNER-ACCOUNT: no company object carries a user account', (fail) => {
      for (const r of reads.filter((x) => x.res.status < 300)) {
        walk(r.res.body, (obj, key, path) => {
          if ((key === 'company' || r.route === '/companies/me' && path === '$') && 'user' in obj) fail(`${r.route} ${path}.user`);
        });
        if (r.route !== '/audit-logs/company' && r.res.text.includes(companyEmail('alpha'))) fail(`${r.role} ${r.route}: owner account email`);
      }
    });

    await group('ACTOR: nested accounts are an actor reference; a guard actor has no email and no account metadata', (fail) => {
      for (const r of reads.filter((x) => x.res.status < 300)) {
        for (const e of guardEmails) if (r.res.text.includes(e)) fail(`${r.role} ${r.route}: a guard account email`);
        walk(r.res.body, (obj, key, path) => {
          if (!USER_KEYS.has(key) || typeof obj.id !== 'number') return;
          if (key === 'user' && r.route.startsWith('/client-portal-users')) return;
          const allowed = guardUserIds.has(obj.id) ? ['id', 'firstName', 'lastName'] : ['id', 'email', 'firstName', 'lastName'];
          const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
          if (extra.length) fail(`${r.route} ${path} has ${extra.join(',')}`);
        });
      }
      const audit = reads.find((x) => x.role === 'owner' && x.route === '/audit-logs/company')!;
      const guardActor = (audit.res.body ?? []).find((l: any) => l.user?.id === gActive.userId);
      if (!guardActor || guardActor.user.firstName !== gActive.fullName) fail('audit log guard actor is not named by the guard profile name');
      const staffActor = (audit.res.body ?? []).find((l: any) => l.user?.id === staff.operations.userId);
      if (!staffActor || staffActor.user.email !== staff.operations.email) fail('audit log staff actor lost its email');
    });

    const workforceExpect = (role: string, status: string, withRtw: boolean): string[] => {
      if (MINIMAL_ROLES.has(role)) return ['id', 'fullName'];
      if (status !== 'ACTIVE') return ['id', 'fullName', 'siaLicenseNumber'];
      const base = ['id', 'fullName', 'siaLicenseNumber', 'siaExpiryDate', ...(withRtw ? ['rightToWorkStatus'] : [])];
      return CONTACT_ROLES.has(role) ? [...base, 'phone'] : base;
    };
    const statusOf: Record<number, string> = {
      [gActive.guardId!]: 'ACTIVE', [gInactive.guardId!]: 'INACTIVE', [gBlocked.guardId!]: 'BLOCKED',
      ...(hiredStatus ? { [gHire.guardId!]: hiredStatus } : {}),
    };

    await group('WORKFORCE-ALLOWLIST: /company-guards exact fields per role and relationship status', (fail) => {
      const REL_KEYS = ['id', 'status', 'relationshipType', 'acceptedAt', 'createdAt', 'company', 'guard'];
      for (const r of reads.filter((x) => x.route === '/company-guards')) {
        if (r.res.status !== 200) { fail(`${r.role} → ${r.res.status}`); continue; }
        const rows: any[] = r.res.body;
        const seen = new Set(rows.map((row) => row.guard?.id));
        for (const g of [gActive, gInactive, gBlocked]) if (!seen.has(g.guardId)) fail(`${r.role}: guard ${g.fullName} missing`);
        for (const row of rows) {
          if (!sameKeys(row, REL_KEYS)) fail(`${r.role} relation keys: ${sorted(row)}`);
          if (!row.company || !sameKeys(row.company, ['id', 'name'])) fail(`${r.role} relation.company keys: ${row.company && sorted(row.company)}`);
          const expected = workforceExpect(r.role, row.status, true);
          if (!row.guard || !sameKeys(row.guard, expected)) {
            fail(`${r.role} ${row.status} guard keys: ${row.guard && sorted(row.guard)} (expected ${[...expected].sort()})`);
          }
          if (row.guard?.fullName == null) fail(`${r.role}: guard name missing`);
        }
      }
    });

    await group('GUARDS-ALLOWLIST: /guards and /guards/:id exact fields per role and relationship status', (fail) => {
      for (const r of reads.filter((x) => x.route.startsWith('/guards'))) {
        if (r.res.status !== 200) { fail(`${r.role} ${r.route} → ${r.res.status}`); continue; }
        const rows: any[] = Array.isArray(r.res.body) ? r.res.body : [r.res.body];
        for (const g of rows) {
          const status = statusOf[g.id];
          if (!status) { fail(`${r.role} ${r.route}: unexpected guard ${g.id}`); continue; }
          const expected = workforceExpect(r.role, status, false);
          if (!sameKeys(g, expected)) fail(`${r.role} ${r.route} ${status}: ${sorted(g)} (expected ${[...expected].sort()})`);
        }
      }
    });

    await group('NESTED-GUARD: guards inside other company records are {id, fullName}', (fail) => {
      for (const r of reads.filter((x) => x.res.status < 300 && !x.route.startsWith('/company-guards') && !x.route.startsWith('/guards'))) {
        walk(r.res.body, (obj, key, path) => {
          if (!GUARD_KEYS.has(key) || typeof obj.id !== 'number' || !('fullName' in obj)) return;
          if (!sameKeys(obj, ['id', 'fullName'])) fail(`${r.route} ${path}: ${sorted(obj)}`);
        });
      }
    });

    await group('CONTACT: a guard phone reaches only contact roles, only for an ACTIVE guard, only via the workforce list', (fail) => {
      for (const r of reads.filter((x) => x.res.status < 300)) {
        for (const g of [gInactive, gBlocked, gApplicant, gOther]) if (r.res.text.includes(g.phone)) fail(`${r.role} ${r.route}: phone of ${g.fullName}`);
        if (r.res.text.includes(gActive.phone)) {
          const allowed = CONTACT_ROLES.has(r.role) && (r.route === '/company-guards' || r.route.startsWith('/guards'));
          if (!allowed) fail(`${r.role} ${r.route}: ACTIVE guard phone`);
        }
      }
      for (const role of CONTACT_ROLES) {
        const wf = reads.find((x) => x.role === role && x.route === '/company-guards');
        if (!wf?.res.text.includes(gActive.phone)) fail(`${role}: ACTIVE guard phone missing from the workforce list`);
      }
    });

    await group('INACTIVE/BLOCKED: no current phone, availability or right-to-work through workforce responses', (fail) => {
      for (const r of reads.filter((x) => x.res.status === 200 && (x.route === '/company-guards' || x.route.startsWith('/guards')))) {
        const rows: any[] = r.route === '/company-guards' ? r.res.body.map((x: any) => ({ status: x.status, guard: x.guard }))
          : (Array.isArray(r.res.body) ? r.res.body : [r.res.body]).map((g: any) => ({ status: statusOf[g.id], guard: g }));
        for (const { status, guard } of rows) {
          if (status === 'ACTIVE' || !guard) continue;
          for (const k of ['phone', 'availability', 'rightToWorkStatus', 'rightToWorkExpiryDate', 'siaExpiryDate', 'user']) {
            if (k in guard) fail(`${r.role} ${r.route} ${status}: ${k}`);
          }
        }
      }
    });

    await group('TENANT: nothing of company B\'s guard appears in company A responses', (fail) => {
      for (const r of reads.filter((x) => x.res.status < 300)) {
        if (r.res.text.includes(gOther.fullName) || r.res.text.includes(gOther.sia)) fail(`${r.role} ${r.route}: company B guard`);
        if (r.res.text.includes(`beta ${RUN} Security Ltd`)) fail(`${r.role} ${r.route}: company B name`);
      }
    });

    await group('APPLICANT: applications expose the applicant as {id, fullName}, with no account or contact data', (fail) => {
      for (const r of reads.filter((x) => x.route === '/job-applications' && x.res.status === 200)) {
        const app = (r.res.body as any[]).find((a) => a.guard?.id === gApplicant.guardId);
        if (!app) { fail(`${r.role}: applicant application missing`); continue; }
        if (!sameKeys(app.guard, ['id', 'fullName'])) fail(`${r.role}: applicant guard ${sorted(app.guard)}`);
        if (r.res.text.includes(gApplicant.sia)) fail(`${r.role}: applicant SIA number`);
      }
    });

    await group('USABLE: shifts, attendance, timesheets, compliance, incidents, logs, alerts, leave carry guard id and name', (fail) => {
      const need: Array<[string, (b: any) => any[]]> = [
        ['/shifts', (b) => b], ['/attendance/company', (b) => b], ['/timesheets/company', (b) => b.items ?? b.data ?? b],
        ['/compliance', (b) => b], ['/incidents/company', (b) => b], ['/daily-logs/company', (b) => b],
        ['/alerts/company', (b) => b], ['/leave', (b) => b], ['/availability/rules', (b) => b],
      ];
      for (const [route, rowsOf] of need) {
        const r = reads.find((x) => x.role === 'owner' && x.route === route)!;
        const rows = r.res.status === 200 ? rowsOf(r.res.body) : [];
        if (!Array.isArray(rows)) { fail(`${route}: not a list`); continue; }
        const forActive = rows.filter((row: any) => row?.guard?.id === gActive.guardId);
        if (!forActive.length) fail(`${route}: no record for the ACTIVE guard`);
        if (forActive.some((row: any) => row.guard.fullName !== gActive.fullName)) fail(`${route}: guard name missing`);
      }
    });

    await group('HIRE/INVITATION: hiring still creates the ACTIVE relationship and returns a minimised record', (fail) => {
      if (hired.status !== 201) fail(`hire → ${hired.status} ${errText(hired)}`);
      if (hiredStatus !== 'ACTIVE') fail(`hired relationship is ${hiredStatus}`);
      if (hired.text.includes(gHire.email)) fail('hire response carries the guard account email');
    });

    await group('ADMIN: Platform Admin guard responses keep their full shape', async (fail) => {
      const list = await api('GET', '/guards', admin.token);
      if (list.status !== 200) return fail(`admin /guards → ${list.status}`);
      const g = list.body.find((x: any) => x.id === gActive.guardId);
      for (const k of ['notes', 'isApproved', 'approvalStatus', 'rightToWorkStatus', 'user']) if (!g || !(k in g)) fail(`admin /guards lost ${k}`);
      if (g && !('lastLoginAt' in g.user && 'email' in g.user && 'role' in g.user)) fail('admin /guards user lost fields');
      const links = await api('GET', '/company-guards', admin.token);
      if (links.status !== 200) return fail(`admin /company-guards → ${links.status}`);
      const link = links.body.find((x: any) => x.guard?.id === gActive.guardId);
      if (!link?.guard?.user?.email || !link?.company?.user) fail('admin /company-guards shape changed');
    });

    await group('GUARD-OWNED: a guard\'s own responses keep their shape', async (fail) => {
      const me = await api('GET', '/guards/me', gActive.token);
      if (me.status !== 200 || me.body.user?.email !== gActive.email || me.body.phone !== gActive.phone) fail('/guards/me changed');
      const mine = await api('GET', '/company-guards/me', gActive.token);
      if (mine.status !== 200 || !sameKeys(mine.body[0] ?? {}, ['companyId', 'companyName', 'relationshipType', 'acceptedAt', 'since'])) fail('/company-guards/me changed');
      const shifts = await api('GET', '/shifts/my', gActive.token);
      if (shifts.status !== 200) fail(`/shifts/my → ${shifts.status}`);
      const own = await api('GET', `/guards/${gActive.guardId}`, gActive.token);
      if (own.status !== 200 || own.body.user?.email !== gActive.email) fail('guard GET /guards/:id (own) changed');
    });

    await group('SCOPE: the projection is attached to exactly the listed company controllers and is not global', async (fail) => {
      let mod: any = null;
      try {
        const modulePath = '../src/common/privacy/company-response-privacy';
        mod = require(modulePath);
      } catch {
        return fail('company response projection module is not present');
      }
      const { CompanyResponsePrivacyInterceptor, COMPANY_PRIVACY_SCOPED_ROUTES } = mod;
      const covered: string[] = [];
      for (const m of app.get(ModulesContainer).values()) {
        for (const wrapper of m.controllers.values()) {
          const metatype = wrapper.metatype as any;
          if (!metatype) continue;
          const path = Reflect.getMetadata('path', metatype);
          const interceptors: any[] = Reflect.getMetadata('__interceptors__', metatype) ?? [];
          if (interceptors.includes(CompanyResponsePrivacyInterceptor)) covered.push(String(path));
          // Never attached method by method: the scope is whole controllers, listed below.
          for (const name of Object.getOwnPropertyNames(metatype.prototype)) {
            if (name === 'constructor') continue;
            const fn = metatype.prototype[name];
            if (typeof fn === 'function' && (Reflect.getMetadata('__interceptors__', fn) ?? []).includes(CompanyResponsePrivacyInterceptor)) {
              fail(`attached to a single method ${path}.${name}`);
            }
          }
        }
      }
      const expected = [...COMPANY_PRIVACY_SCOPED_ROUTES].sort();
      if (covered.sort().join('|') !== expected.join('|')) fail(`covered ${covered.join(',')} ≠ listed ${expected.join(',')}`);
      for (const notCovered of ['rota', 'rota-slots', 'coverage', 'reports', 'patrols', 'patrols/monitor', 'finance', 'guard-personnel', 'company-guards/invitations', 'screening', 'auth', 'admin']) {
        if (covered.includes(notCovered)) fail(`unexpectedly covers ${notCovered}`);
      }
      const { APP_INTERCEPTOR } = await import('@nestjs/core');
      for (const m of app.get(ModulesContainer).values()) {
        for (const [token, provider] of m.providers) {
          if (typeof token === 'string' && token.startsWith(APP_INTERCEPTOR) && (provider as any).metatype === CompanyResponsePrivacyInterceptor) fail('registered globally');
        }
      }

      // Unit: who and what the projection may change.
      const { projectCompanyResponse } = mod;
      const dto = { id: 1, guard: { id: 2, fullName: 'X', phone: '1' }, user: { id: 3, email: 'x@y', lastLoginAt: null } };
      const projectedDto = await projectCompanyResponse(ds, dto);
      if (JSON.stringify(projectedDto) !== JSON.stringify(dto)) fail('plain DTO objects were altered');
      const file = new StreamableFile(Buffer.from('pdf'));
      if ((await projectCompanyResponse(ds, file)) !== file) fail('a non-entity class instance (StreamableFile) was altered');
      // Built the way Nest builds it: from the app's ModuleRef, so the lazy DataSource lookup is exercised too.
      const interceptor = new CompanyResponsePrivacyInterceptor(app.get(ModuleRef));
      const { GuardProfile } = await import('../src/guard-profile/entities/guard-profile.entity');
      const entity = Object.assign(new GuardProfile(), { id: 9, fullName: 'Y', phone: '2', notes: 'n' });
      const { lastValueFrom, of } = await import('rxjs');
      for (const role of ['admin', 'guard', 'client_admin', 'client_viewer', undefined]) {
        const ctx: any = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }) };
        const out = await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(entity) }));
        if (out !== entity) fail(`response altered for role ${role}`);
      }
      const ctx: any = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ user: { role: 'company_staff' } }) }) };
      const out: any = await lastValueFrom(interceptor.intercept(ctx, { handle: () => of([entity]) }));
      if (!sameKeys(out[0], ['id', 'fullName'])) fail('company response entity not projected');
    });

    console.log(`\nCompany response privacy: ${groupsPassed} groups passed, ${failures.length} failed`);
    if (failures.length) {
      console.log(`FAILED: ${failures.join(' | ')}`);
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

let setupPassed = 0;
function pass(name: string) {
  setupPassed += 1;
  console.log(`PASS ${name}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
