/**
 * Company–guard relationship controls, over real HTTP against a real Nest app and a LOCAL, disposable PostgreSQL.
 *
 * A company may not put a guard into its workforce by naming one, and may not bring back a relationship it ended:
 * a guard joins through an invitation they accept, or by being hired from their own application. Platform Admin keeps
 * a direct, audited support path.
 *
 *   LINK-REFUSED          a company POST /company-guards for a guard it has no relationship with → 403, nothing created,
 *                         and the guard's record and emergency contact stay closed to that company
 *   LINK-ENUMERATION      an id that matches no guard and an id that does get byte-identical 403 responses
 *   INVITATION            invitation + guard acceptance still creates the ACTIVE relationship
 *   LINK-IDEMPOTENT       POST for a guard already ACTIVE in this company is a harmless no-op
 *   NO-REACTIVATE-INACTIVE  INACTIVE → POST and PATCH ACTIVE refused; a fresh accepted invitation renews it
 *   NO-REACTIVATE-BLOCKED   BLOCKED → POST and PATCH ACTIVE refused, invitation refused while blocked; lifting the
 *                         block to INACTIVE then a fresh accepted invitation renews it
 *   HIRE                  hiring the guard's own application still creates the ACTIVE relationship
 *   ADMIN-LINK            Platform Admin direct create still works and writes company_guard.admin_linked
 *   TENANT                a company cannot change another company's relationship (404)
 *   AUDIT                 refused attempts are recorded as company_guard.link_refused; no company_guard.linked rows
 *   TIMESHEETS            /timesheets/company still answers the owner; timesheets.view is held by every membership role
 *
 * Requires COMPANY_GUARD_LINK_DATABASE_URL (or PILOT_CORE_DATABASE_URL); the host must be local. Migrations are applied,
 * nothing is dropped. Every account is synthetic.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
// AppModule is imported dynamically inside main(), after the environment below is in place (see pilot-core.spec.ts).
import { AuthService } from '../src/auth/auth.service';
import { AdminOperatorService } from '../src/admin-operator/admin-operator.service';
import {
  CompanyMembershipRole,
  CompanyPermission,
  hasPermission,
} from '../src/company-membership/company-membership-types';

const url = process.env.COMPANY_GUARD_LINK_DATABASE_URL || process.env.PILOT_CORE_DATABASE_URL;
if (!url) throw new Error('COMPANY_GUARD_LINK_DATABASE_URL is required');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Company guard link database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'company-guard-link-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

const RUN = Date.now().toString(36);
let passed = 0;
const pass = (name: string) => {
  passed += 1;
  console.log(`PASS ${name}`);
};
type Res = { status: number; body: any; text: string };
type Session = { token: string; userId: number; companyId?: number; guardId?: number };
const errText = (r: Res) => (Array.isArray(r.body?.message) ? r.body.message.join('; ') : r.body?.message) || '';

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
  const relationStatus = async (companyId: number, guardId: number): Promise<string | null> =>
    (await q(`SELECT status FROM company_guards WHERE "companyId" = $1 AND "guardId" = $2`, [companyId, guardId]))[0]?.status ?? null;
  const relationId = async (companyId: number, guardId: number): Promise<number> =>
    (await q(`SELECT id FROM company_guards WHERE "companyId" = $1 AND "guardId" = $2`, [companyId, guardId]))[0].id;

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
    const registerCompany = async (label: string) => {
      const email = `${label}.${RUN}@cg-link.test`;
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
      const email = `${label}.${RUN}@cg-link.test`;
      await auth.register({
        email, password, role: 'guard' as any, fullName: `${label} Guard`, phone: '07700000000',
        siaLicenseNumber: String(6100000000000000 + (siaSeq += 7919)),
      } as any);
      await verifyEmail(email);
      return session(email);
    };
    const invite = async (company: Session) => {
      const res = await api('POST', '/company-guards/invitations', company.token, {});
      assert.equal(res.status, 201, errText(res));
      return res.body.code as string;
    };
    const accept = (guard: Session, code: string) => api('POST', '/guards/me/invitations/accept', guard.token, { code });
    const link = (company: Session, guardId: number) =>
      api('POST', '/company-guards', company.token, { companyId: company.companyId, guardId });
    const setStatus = (company: Session, id: number, status: string) =>
      api('PATCH', `/company-guards/${id}`, company.token, { status });

    const outsider = await registerCompany('outsider');
    const employer = await registerCompany('employer');
    const hirer = await registerCompany('hirer');
    const guard = await registerGuard('target');
    const gid = guard.guardId!;
    const contact = await api('PATCH', '/guard-personnel/me/emergency-contact', guard.token, {
      contactName: 'Synthetic Contact', relationship: 'PARENT', primaryPhone: '07000000001',
    });
    assert.equal(contact.status, 200, errText(contact));

    // ── LINK-REFUSED ──
    const refused = await link(outsider, gid);
    assert.equal(refused.status, 403, `unlinked guard must be refused, got ${refused.status}`);
    assert.equal(await relationStatus(outsider.companyId!, gid), null, 'no relationship row created');
    assert.equal((await api('GET', `/guards/${gid}`, outsider.token)).status, 404, 'guard record stays closed');
    assert.equal(
      (await api('GET', `/guard-personnel/company/guard/${gid}/emergency-contact`, outsider.token)).status, 403,
      'emergency contact stays closed',
    );
    pass('LINK-REFUSED: unrelated company cannot link a guard; nothing created; personal data stays closed');

    // ── LINK-ENUMERATION ──
    const [{ max }] = await q(`SELECT COALESCE(MAX(id), 0) AS max FROM guard_profiles`);
    const unknown = await link(outsider, Number(max) + 100000);
    const known = await link(outsider, gid);
    assert.equal(unknown.status, 403, 'unknown id is 403, not 404');
    assert.equal(known.status, unknown.status, 'same status');
    assert.equal(known.text, unknown.text, 'byte-identical body');
    pass('LINK-ENUMERATION: unknown and existing guard ids get identical 403 responses');

    // ── INVITATION + LINK-IDEMPOTENT ──
    const firstJoin = await accept(guard, await invite(employer));
    assert.equal(firstJoin.status, 201, errText(firstJoin));
    assert.equal(await relationStatus(employer.companyId!, gid), 'ACTIVE');
    pass('INVITATION: invitation accepted by the guard creates the ACTIVE relationship');
    const again = await link(employer, gid);
    assert.equal(again.status, 201, errText(again));
    assert.equal(again.body.status, 'ACTIVE');
    assert.equal(Number((await q(`SELECT count(*) n FROM company_guards WHERE "companyId" = $1 AND "guardId" = $2`, [employer.companyId, gid]))[0].n), 1);
    pass('LINK-IDEMPOTENT: POST for a guard already ACTIVE in this company is a no-op');

    // ── NO-REACTIVATE-INACTIVE ──
    const relId = await relationId(employer.companyId!, gid);
    assert.equal((await setStatus(employer, relId, 'INACTIVE')).status, 200);
    assert.equal((await link(employer, gid)).status, 403, 'POST cannot reactivate INACTIVE');
    const patchInactive = await setStatus(employer, relId, 'ACTIVE');
    assert.equal(patchInactive.status, 403, 'PATCH cannot reactivate INACTIVE');
    assert.equal(await relationStatus(employer.companyId!, gid), 'INACTIVE', 'still INACTIVE');
    const renewed = await accept(guard, await invite(employer));
    assert.equal(renewed.status, 201, errText(renewed));
    assert.equal(await relationStatus(employer.companyId!, gid), 'ACTIVE', 'fresh accepted invitation renews it');
    pass('NO-REACTIVATE-INACTIVE: POST and PATCH refused; a fresh accepted invitation renews the relationship');

    // ── NO-REACTIVATE-BLOCKED ──
    assert.equal((await setStatus(employer, relId, 'BLOCKED')).status, 200);
    assert.equal((await setStatus(employer, relId, 'ACTIVE')).status, 403, 'PATCH cannot reactivate BLOCKED');
    assert.equal((await link(employer, gid)).status, 403, 'POST cannot reactivate BLOCKED');
    const blockedCode = await invite(employer);
    assert.equal((await accept(guard, blockedCode)).status, 403, 'invitation refused while blocked');
    assert.equal(await relationStatus(employer.companyId!, gid), 'BLOCKED', 'still BLOCKED');
    assert.equal((await setStatus(employer, relId, 'INACTIVE')).status, 200, 'block can be lifted to INACTIVE');
    const afterUnblock = await accept(guard, blockedCode);
    assert.equal(afterUnblock.status, 201, errText(afterUnblock));
    assert.equal(await relationStatus(employer.companyId!, gid), 'ACTIVE');
    pass('NO-REACTIVATE-BLOCKED: POST/PATCH refused; lifting the block then an accepted invitation renews it');

    // ── HIRE ──
    const job = await api('POST', '/jobs', hirer.token, { title: 'Synthetic static guard', guardsRequired: 1, hourlyRate: 15 });
    assert.equal(job.status, 201, errText(job));
    const application = await api('POST', '/job-applications/self', guard.token, { jobId: job.body.id });
    assert.equal(application.status, 201, errText(application));
    const hired = await api('POST', `/job-applications/${application.body.id}/hire`, hirer.token, {});
    assert.ok(hired.status === 201 || hired.status === 200, `hire: ${hired.status} ${errText(hired)}`);
    assert.equal(await relationStatus(hirer.companyId!, gid), 'ACTIVE', 'hire creates the ACTIVE relationship');
    pass('HIRE: hiring the guard\'s own application still creates the ACTIVE relationship');

    // ── ADMIN-LINK ──
    const adminEmail = 'platform.admin@cg-link.test';
    const adminPassword = 'Cg-Link-Admin-1!';
    const operator = new AdminOperatorService(ds);
    const adminCount = Number((await q(`SELECT count(*) n FROM users WHERE role = 'admin'`))[0].n);
    if (adminCount === 0) {
      await operator.bootstrap(adminEmail, adminPassword);
    } else if (Number((await q(`SELECT count(*) n FROM users WHERE role = 'admin' AND LOWER(email) = $1`, [adminEmail]))[0].n) === 1) {
      await operator.recover(adminEmail, adminPassword, true);
    } else {
      throw new Error('This database already has a Platform Admin this spec did not create; use a disposable database.');
    }
    const admin = await session(adminEmail, adminPassword);
    const adminGuard = await registerGuard('adminlinked');
    const adminLink = await api('POST', '/company-guards', admin.token, { companyId: outsider.companyId, guardId: adminGuard.guardId });
    assert.equal(adminLink.status, 201, errText(adminLink));
    assert.equal(await relationStatus(outsider.companyId!, adminGuard.guardId!), 'ACTIVE');
    const adminAudit = await q(
      `SELECT count(*) n FROM audit_logs WHERE action = 'company_guard.admin_linked' AND "entityId" = $1 AND "userId" = $2`,
      [adminLink.body.id, admin.userId],
    );
    assert.equal(Number(adminAudit[0].n), 1, 'admin link audited');
    pass('ADMIN-LINK: Platform Admin direct link still works and is audited');

    // ── TENANT ──
    const foreign = await setStatus(outsider, relId, 'BLOCKED');
    assert.equal(foreign.status, 404, 'another company\'s relationship is not found');
    assert.equal(await relationStatus(employer.companyId!, gid), 'ACTIVE', 'employer relationship untouched');
    pass('TENANT: a company cannot change another company\'s relationship');

    // ── AUDIT ──
    const linkedRows = await q(
      `SELECT count(*) n FROM audit_logs WHERE action = 'company_guard.linked' AND "companyId" = ANY($1)`,
      [[outsider.companyId, employer.companyId, hirer.companyId]],
    );
    assert.equal(Number(linkedRows[0].n), 0, 'no company_guard.linked events from company users');
    const refusedRows = await q(
      `SELECT count(*) n FROM audit_logs WHERE action = 'company_guard.link_refused' AND "companyId" = $1`,
      [outsider.companyId],
    );
    assert.equal(Number(refusedRows[0].n), 3, 'each refused outsider attempt recorded');
    pass('AUDIT: refused attempts recorded as company_guard.link_refused; no company user link events');

    // ── TIMESHEETS ──
    for (const role of Object.values(CompanyMembershipRole)) {
      assert.ok(hasPermission(role, CompanyPermission.TIMESHEETS_VIEW), `${role} keeps timesheets.view`);
    }
    const timesheets = await api('GET', '/timesheets/company', employer.token);
    assert.equal(timesheets.status, 200, errText(timesheets));
    const guardTimesheets = await api('GET', '/timesheets/company', guard.token);
    assert.equal(guardTimesheets.status, 403, 'guards cannot read company timesheets');
    pass('TIMESHEETS: /timesheets/company answers the owner; every membership role holds timesheets.view');

    console.log(`\n✓ company-guard link security: ${passed}/11 passed`);
    assert.equal(passed, 11);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
