/**
 * SEC-001B Stage 2B — company membership, guard leave routing, leave integrity and company notification privacy, over
 * real HTTP against a real Nest app and a LOCAL, disposable PostgreSQL.
 *
 *   MEMBERSHIP     leave, company notifications, emergency contact, driving and employment resolve the company through
 *                  membership: the owner keeps access, a SUSPENDED or REVOKED membership is refused (owner included),
 *                  and no staff role gains access it did not have (same status and message as before)
 *   COMPANIES      GET /leave/mine/companies lists the guard's ACTIVE employers only
 *   ROUTING        guard leave: one ACTIVE employer is chosen automatically; several need an explicit companyId (stable
 *                  400 code LEAVE_COMPANY_REQUIRED); none is refused (LEAVE_NO_ACTIVE_EMPLOYER); never an INACTIVE or
 *                  BLOCKED employer; an unrelated, inactive, blocked or unknown companyId gets one identical 403
 *   INTEGRITY      a guard edits only their own PENDING, guard-created request at a company they still work for;
 *                  APPROVED, REJECTED and company-created leave is never changed by the guard
 *   NO-CHANGE      every refused write leaves guard_leave (and so every scheduling block) byte-for-byte unchanged
 *   HISTORY        the company still reads leave recorded for former guards; nothing is cancelled when a relationship ends
 *   NOTIFICATIONS  the company inbox excludes guard-addressed notifications; the guard's own inbox keeps them
 *   TENANT         another company can neither read nor change this company's leave, notifications or employment
 *   GUARD-COMPAT   the guard app's existing leave payload ({leaveType, startAt, endAt, reason}) still works
 *
 * Collects every violation before failing. Requires STAGE2B_DATABASE_URL (a disposable local s4_ database; see
 * test-database-guard.ts). Migrations are applied, nothing is dropped, every account and record is synthetic.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { AuthService } from '../src/auth/auth.service';
import { assertDisposableTestDatabase, requireDisposableTestDatabaseUrl } from './test-database-guard';

const url = requireDisposableTestDatabaseUrl('STAGE2B_DATABASE_URL');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'stage2b-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

const RUN = Date.now().toString(36);
type Res = { status: number; body: any; text: string };
type Session = { token: string; userId: number; companyId?: number; guardId?: number };
const errText = (r: Res) => (Array.isArray(r.body?.message) ? r.body.message.join('; ') : r.body?.message) || '';
const ok2xx = (r: Res) => r.status >= 200 && r.status < 300;
const show = (r: Res) => `${r.status} ${JSON.stringify(errText(r))}${r.body?.code ? ` code=${r.body.code}` : ''}`;

const failures: string[] = [];
let groupsPassed = 0;
async function group(name: string, run: (fail: (msg: string) => void) => void | Promise<void>) {
  const found: string[] = [];
  try {
    await run((msg) => found.push(msg));
  } catch (e: any) {
    found.push(`threw: ${e?.stack ?? e}`);
  }
  if (found.length === 0) {
    groupsPassed += 1;
    console.log(`PASS ${name}`);
  } else {
    const shown = [...new Set(found)];
    console.log(`FAIL ${name} (${shown.length})`);
    for (const f of shown.slice(0, 40)) console.log(`     - ${f}`);
    if (shown.length > 40) console.log(`     … ${shown.length - 40} more`);
    failures.push(name);
  }
}

async function main() {
  await assertDisposableTestDatabase(url);
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const migrator = new DataSource(
    buildTypeOrmOptions({ DATABASE_URL: url, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' }),
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
    const registerCompany = async (label: string) => {
      const email = `${label}.owner.${RUN}@stage2b.test`;
      await auth.register({
        email, password, role: 'company' as any, fullName: `${label} Owner`, phone: '02000000000',
        companyName: `${label} ${RUN} Security Ltd`, companyNumber: String(10000000 + Math.floor(Math.random() * 8999999)),
        address: '1 High St, London', contactDetails: `ops@${label}.test`,
      } as any);
      // SEC-PUBLIC-03: this spec exercises an operating company, so its fixture company is approved (as every pilot company is).
      await ds.query(`UPDATE companies SET "verificationStatus" = 'approved' WHERE "userId" = (SELECT id FROM users WHERE email = $1)`, [email]);
      await verifyEmail(email);
      return session(email);
    };
    let siaSeq = Math.floor(Math.random() * 1e6);
    let phoneSeq = 500;
    const registerGuard = async (label: string): Promise<Session> => {
      const email = `${label}.${RUN}@stage2b.test`;
      const phone = `07700${String(700000 + (phoneSeq += 17))}`;
      const sia = String(6400000000000000 + (siaSeq += 7919));
      await auth.register({ email, password, role: 'guard' as any, fullName: `${label} S2B Guard ${RUN}`, phone, siaLicenseNumber: sia } as any);
      await verifyEmail(email);
      return session(email);
    };
    const join = async (company: Session, guard: Session) => {
      const inv = await api('POST', '/company-guards/invitations', company.token, {});
      assert.equal(inv.status, 201, errText(inv));
      const acc = await api('POST', '/guards/me/invitations/accept', guard.token, { code: inv.body.code });
      assert.equal(acc.status, 201, errText(acc));
    };
    const setStatus = async (company: Session, guard: Session, status: 'INACTIVE' | 'BLOCKED') => {
      const rel = await one(`SELECT id FROM company_guards WHERE "companyId" = $1 AND "guardId" = $2`, [company.companyId, guard.guardId]);
      const res = await api('PATCH', `/company-guards/${rel.id}`, company.token, { status });
      assert.equal(res.status, 200, errText(res));
    };
    const setOwnerMembership = (owner: Session, status: 'suspended' | 'revoked') => q(
      `INSERT INTO company_memberships ("userId", "companyId", "membershipRole", status, "acceptedAt")
       VALUES ($1, $2, 'owner', $3, now())
       ON CONFLICT ("userId", "companyId") DO UPDATE SET status = EXCLUDED.status`,
      [owner.userId, owner.companyId, status],
    );

    const ownerA = await registerCompany('alpha');
    const ownerB = await registerCompany('beta');
    const ownerC = await registerCompany('gamma');
    const ownerS = await registerCompany('suspended');
    const ownerR = await registerCompany('revoked');
    const A = ownerA.companyId!;
    const B = ownerB.companyId!;
    const C = ownerC.companyId!;

    const staffHash = await bcrypt.hash(password, 10);
    const staff = async (label: string, role: string, status: 'active' | 'suspended' | 'revoked') => {
      const email = `${label}.${RUN}@stage2b.test`;
      const [{ id }] = await q(
        `INSERT INTO users (email, "passwordHash", role, status, "isEmailVerified", "firstName", "lastName")
         VALUES ($1, $2, 'company_staff', 'active', true, $3, 'Staff') RETURNING id`,
        [email, staffHash, label],
      );
      await q(
        `INSERT INTO company_memberships ("userId", "companyId", "membershipRole", status, "acceptedAt") VALUES ($1, $2, $3, $4, now())`,
        [id, A, role, status],
      );
      return session(email);
    };
    const ROLES = ['admin', 'operations', 'control_room', 'hr_compliance', 'finance', 'viewer'] as const;
    const staffSessions: Array<{ role: string; s: Session }> = [];
    for (const role of ROLES) staffSessions.push({ role, s: await staff(role, role, 'active') });
    const suspendedStaff = await staff('suspended-admin', 'admin', 'suspended');
    const revokedStaff = await staff('revoked-admin', 'admin', 'revoked');

    const gSingle = await registerGuard('single');          // ACTIVE at A only
    const gMulti = await registerGuard('multi');            // ACTIVE at A and B
    const gNewestBlocked = await registerGuard('newest');   // ACTIVE at A, newest relationship BLOCKED (C)
    const gNone = await registerGuard('none');              // INACTIVE at A, BLOCKED at C: no ACTIVE employer
    const gLeaver = await registerGuard('leaver');          // files leave at A, then A ends the relationship
    const gOutsider = await registerGuard('outsider');      // no relationship at all
    const gS = await registerGuard('suspended-co');         // ACTIVE at the suspended-owner company
    const gR = await registerGuard('revoked-co');           // ACTIVE at the revoked-owner company
    await join(ownerA, gSingle);
    await join(ownerA, gMulti);
    await join(ownerB, gMulti);
    await join(ownerA, gNewestBlocked);
    await join(ownerC, gNewestBlocked);
    await join(ownerA, gNone);
    await join(ownerC, gNone);
    await join(ownerA, gLeaver);
    await join(ownerS, gS);
    await join(ownerR, gR);

    // History: leave company A recorded for gNone while the relationship was ACTIVE.
    const noneHistory = await one(
      `INSERT INTO guard_leave ("companyId", "guardId", "leaveType", "startAt", "endAt", status)
       VALUES ($1, $2, 'annual_leave', now() + interval '20 days', now() + interval '21 days', 'approved') RETURNING id`,
      [A, gNone.guardId],
    );
    // gLeaver files a pending request while ACTIVE (one ACTIVE employer, so it goes to A on any build).
    const leaverLeave = await api('POST', '/leave/mine', gLeaver.token, { leaveType: 'annual_leave', startAt: '2031-07-01T09:00:00Z', endAt: '2031-07-03T09:00:00Z', reason: 'Family' });
    assert.ok(ok2xx(leaverLeave), `leaver files leave: ${show(leaverLeave)}`);
    assert.equal(leaverLeave.body.company?.id ?? (await one(`SELECT "companyId" FROM guard_leave WHERE id = $1`, [leaverLeave.body.id]))?.companyId, A);

    // Employment records, created through the API so they are encrypted as in production.
    const employmentBody = { engagementType: 'EMPLOYEE', jobRole: 'SECURITY_OFFICER', workingArrangement: 'FULL_TIME', startDate: '2026-01-05', payBasis: 'HOURLY', internalNote: `S2B-${RUN}` };
    for (const [owner, g] of [[ownerA, gSingle], [ownerS, gS], [ownerR, gR]] as const) {
      const created = await api('PATCH', `/guard-personnel/company/guard/${g.guardId}/employment`, owner.token, employmentBody);
      assert.ok(ok2xx(created), `employment for ${g.guardId}: ${show(created)}`);
    }

    // Relationships end only now.
    await setStatus(ownerC, gNewestBlocked, 'BLOCKED');
    await setStatus(ownerA, gNone, 'INACTIVE');
    await setStatus(ownerC, gNone, 'BLOCKED');
    await setStatus(ownerA, gLeaver, 'INACTIVE');
    // The owner memberships of S and R are suspended / revoked after their guards joined.
    await setOwnerMembership(ownerS, 'suspended');
    await setOwnerMembership(ownerR, 'revoked');

    // Notifications: one to company A's owner, one to a guard tagged with company A, one to company B's owner.
    const note = async (userId: number, companyId: number, type: string, title: string) =>
      (await one(`INSERT INTO notifications ("userId", "companyId", type, title, message, status) VALUES ($1, $2, $3, $4, 'Synthetic', 'unread') RETURNING id`, [userId, companyId, type, title])).id;
    const nOwnerA = await note(ownerA.userId, A, 'alert_raised', `Owner A alert ${RUN}`);
    const nGuardA = await note(gSingle.userId, A, 'job_assigned', `Guard-addressed ${RUN}`);
    const nOwnerB = await note(ownerB.userId, B, 'alert_raised', `Owner B alert ${RUN}`);
    console.log('PASS SETUP: companies A/B/C plus suspended- and revoked-owner companies, 6 staff roles, suspended and revoked staff, 8 guards');

    const leaveFingerprint = async () => one(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(concat_ws('|', id, "companyId", "guardId", "leaveType", "startAt", "endAt", reason, status, "updatedAt"), ';' ORDER BY id), '')) AS h FROM guard_leave`,
    );
    const approvedFingerprint = async () => one(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(concat_ws('|', id, "companyId", "guardId", "startAt", "endAt"), ';' ORDER BY id), '')) AS h FROM guard_leave WHERE status = 'approved'`,
    );
    const employmentFingerprint = async () => one(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(row_to_json(e)::text, ';' ORDER BY id), '')) AS h FROM company_guard_employment_records e`,
    );
    const leaveCompany = async (id: number) => (await one(`SELECT "companyId" FROM guard_leave WHERE id = $1`, [id]))?.companyId;

    // ───────────────────────────── MEMBERSHIP ─────────────────────────────
    await group('MEMBERSHIP: owner keeps access; suspended/revoked refused (owner included); no staff role gains access', async (fail) => {
      const g = gSingle.guardId!;
      const routes = (gid: number) => [
        { name: 'GET /leave', run: (t: string) => api('GET', '/leave', t) },
        { name: 'GET /notifications/company', run: (t: string) => api('GET', '/notifications/company', t) },
        { name: 'GET emergency-contact', run: (t: string) => api('GET', `/guard-personnel/company/guard/${gid}/emergency-contact`, t) },
        { name: 'GET driving-transport', run: (t: string) => api('GET', `/guard-personnel/company/guard/${gid}/driving-transport`, t) },
        { name: 'GET employment', run: (t: string) => api('GET', `/guard-personnel/company/guard/${gid}/employment`, t) },
        { name: 'GET company-staff employment', run: (t: string) => api('GET', `/guard-personnel/company-staff/guard/${gid}/employment`, t) },
        { name: 'PATCH employment', run: (t: string) => api('PATCH', `/guard-personnel/company/guard/${gid}/employment`, t, { endDate: '2031-12-31' }) },
        { name: 'POST /leave', run: (t: string) => api('POST', '/leave', t, { guardId: gid, leaveType: 'training', startAt: '2031-09-01T09:00:00Z', endAt: '2031-09-01T17:00:00Z' }) },
      ];
      // Owner A: everything except the COMPANY_STAFF-only route.
      for (const r of routes(g)) {
        const res = await r.run(ownerA.token);
        const expectOk = r.name !== 'GET company-staff employment';
        if (expectOk && !ok2xx(res)) fail(`owner ${r.name}: ${show(res)}`);
      }
      // Staff: refused exactly as before Stage 2B (owner-only parity; no new staff permissions).
      const before: Record<string, [number, string]> = {
        'GET /leave': [404, 'Company not found'],
        'GET /notifications/company': [404, 'Company not found'],
        'GET driving-transport': [403, 'No company profile associated with this account'],
        'GET company-staff employment': [403, 'No company profile associated with this account'],
      };
      for (const { role, s } of staffSessions) {
        for (const r of routes(g)) {
          const res = await r.run(s.token);
          if (ok2xx(res)) { fail(`${role} ${r.name} succeeded (${res.status}): staff must not gain access`); continue; }
          const expected = before[r.name];
          if (expected && (res.status !== expected[0] || errText(res) !== expected[1])) {
            fail(`${role} ${r.name}: ${show(res)}, expected the unchanged refusal ${expected[0]} "${expected[1]}"`);
          }
        }
      }
      // Suspended / revoked memberships, staff and owners alike.
      const empBefore = await employmentFingerprint();
      const leaveBefore = await leaveFingerprint();
      for (const [label, s, gid] of [
        ['suspended staff', suspendedStaff, g], ['revoked staff', revokedStaff, g],
        ['suspended owner', ownerS, gS.guardId!], ['revoked owner', ownerR, gR.guardId!],
      ] as const) {
        for (const r of routes(gid)) {
          const res = await r.run(s.token);
          if (ok2xx(res)) fail(`${label} ${r.name} succeeded (${res.status})`);
        }
      }
      const empAfter = await employmentFingerprint();
      const leaveAfter = await leaveFingerprint();
      if (empAfter.h !== empBefore.h) fail('a refused employment write changed company_guard_employments');
      if (leaveAfter.h !== leaveBefore.h) fail('a refused leave write changed guard_leave');
    });

    // ───────────────────────────── COMPANIES ─────────────────────────────
    await group('COMPANIES: GET /leave/mine/companies lists ACTIVE employers only', async (fail) => {
      const ids = async (g: Session) => {
        const res = await api('GET', '/leave/mine/companies', g.token);
        if (!ok2xx(res) || !Array.isArray(res.body)) { fail(`guard ${g.guardId}: ${show(res)}`); return null; }
        return res.body.map((c: any) => c.companyId).sort((a: number, b: number) => a - b);
      };
      const expect = async (label: string, g: Session, want: number[]) => {
        const got = await ids(g);
        if (got && JSON.stringify(got) !== JSON.stringify([...want].sort((a, b) => a - b))) fail(`${label}: ${JSON.stringify(got)} expected ${JSON.stringify(want)}`);
      };
      await expect('single', gSingle, [A]);
      await expect('multi', gMulti, [A, B]);
      await expect('newest-blocked', gNewestBlocked, [A]);
      await expect('none', gNone, []);
      await expect('outsider', gOutsider, []);
      const res = await api('GET', '/leave/mine/companies', gMulti.token);
      if (ok2xx(res) && res.body.some((c: any) => !c.name)) fail('each entry names the company');
      if ((await api('GET', '/leave/mine/companies', ownerA.token)).status !== 403) fail('a company account must not use the guard endpoint');
    });

    // ───────────────────────────── ROUTING ─────────────────────────────
    const leavePayload = (extra: Record<string, unknown> = {}) => ({ leaveType: 'annual_leave', startAt: '2031-08-04T09:00:00Z', endAt: '2031-08-05T09:00:00Z', reason: 'Holiday', ...extra });
    await group('ROUTING: one ACTIVE employer automatic; several need companyId; none refused; never INACTIVE/BLOCKED', async (fail) => {
      const single = await api('POST', '/leave/mine', gSingle.token, leavePayload());
      if (!ok2xx(single)) fail(`single, no companyId: ${show(single)}`);
      else if ((await leaveCompany(single.body.id)) !== A) fail('single: not routed to the only ACTIVE employer');
      else if (single.body.status !== 'pending') fail(`single: status ${single.body.status}`);

      const newest = await api('POST', '/leave/mine', gNewestBlocked.token, leavePayload());
      if (!ok2xx(newest)) fail(`newest-blocked, no companyId: ${show(newest)}`);
      else if ((await leaveCompany(newest.body.id)) !== A) fail(`newest-blocked: routed to company ${await leaveCompany(newest.body.id)} (BLOCKED employer), expected the ACTIVE employer`);

      const before = await leaveFingerprint();
      const multi = await api('POST', '/leave/mine', gMulti.token, leavePayload());
      if (multi.status !== 400 || multi.body?.code !== 'LEAVE_COMPANY_REQUIRED') fail(`multi, no companyId: ${show(multi)}, expected 400 LEAVE_COMPANY_REQUIRED`);
      const none = await api('POST', '/leave/mine', gNone.token, leavePayload());
      if (none.status !== 400 || none.body?.code !== 'LEAVE_NO_ACTIVE_EMPLOYER') fail(`no ACTIVE employer: ${show(none)}, expected 400 LEAVE_NO_ACTIVE_EMPLOYER`);
      const outsider = await api('POST', '/leave/mine', gOutsider.token, leavePayload());
      if (outsider.status !== 400 || outsider.body?.code !== 'LEAVE_NO_ACTIVE_EMPLOYER') fail(`outsider: ${show(outsider)}, expected 400 LEAVE_NO_ACTIVE_EMPLOYER`);

      // Refused companyId values all look the same.
      const refusals: Res[] = [];
      for (const [label, g, cid] of [
        ['multi → C (unrelated)', gMulti, C], ['none → A (INACTIVE)', gNone, A], ['none → C (BLOCKED)', gNone, C],
        ['newest → C (BLOCKED)', gNewestBlocked, C], ['single → B (unrelated)', gSingle, B], ['single → unknown', gSingle, 99999999],
      ] as const) {
        const res = await api('POST', '/leave/mine', g.token, leavePayload({ companyId: cid }));
        if (res.status !== 403) fail(`${label}: ${show(res)}, expected 403`);
        refusals.push(res);
      }
      const shapes = new Set(refusals.map((r) => `${r.status} ${errText(r)}`));
      if (shapes.size !== 1) fail(`refused companyId values are distinguishable: ${[...shapes].join(' | ')}`);
      const after = await leaveFingerprint();
      if (after.h !== before.h) fail('a refused leave request changed guard_leave');

      for (const cid of [A, B]) {
        const res = await api('POST', '/leave/mine', gMulti.token, leavePayload({ companyId: cid }));
        if (!ok2xx(res)) fail(`multi → ${cid}: ${show(res)}`);
        else if ((await leaveCompany(res.body.id)) !== cid) fail(`multi → ${cid}: routed to ${await leaveCompany(res.body.id)}`);
      }
      const explicitSingle = await api('POST', '/leave/mine', gSingle.token, leavePayload({ companyId: A }));
      if (!ok2xx(explicitSingle)) fail(`single → A explicitly: ${show(explicitSingle)}`);
      const forged = await api('POST', '/leave/mine', gSingle.token, leavePayload({ status: 'approved' }));
      if (ok2xx(forged) && forged.body.status !== 'pending') fail('a guard set their own leave status');
    });

    // ───────────────────────────── INTEGRITY ─────────────────────────────
    await group('INTEGRITY: guards edit only their own PENDING guard-created request at an ACTIVE employer', async (fail) => {
      const g = gSingle.guardId!;
      const companyLeave = async (status: string) => {
        const res = await api('POST', '/leave', ownerA.token, { guardId: g, leaveType: 'sick', startAt: '2031-10-01T09:00:00Z', endAt: '2031-10-02T09:00:00Z', reason: 'Company note', status });
        assert.ok(ok2xx(res), `company ${status} leave: ${show(res)}`);
        return res.body.id as number;
      };
      const guardLeave = async (decision?: string) => {
        const res = await api('POST', '/leave/mine', gSingle.token, leavePayload({ startAt: '2031-11-01T09:00:00Z', endAt: '2031-11-02T09:00:00Z' }));
        assert.ok(ok2xx(res), `guard leave: ${show(res)}`);
        if (decision) {
          const d = await api('PUT', '/leave', ownerA.token, { id: res.body.id, guardId: g, leaveType: 'annual_leave', startAt: '2031-11-01T09:00:00Z', endAt: '2031-11-02T09:00:00Z', status: decision });
          assert.ok(ok2xx(d), `company ${decision}: ${show(d)}`);
        }
        return res.body.id as number;
      };
      const targets: Array<[string, number]> = [
        ['company-created APPROVED', await companyLeave('approved')],
        ['company-created PENDING', await companyLeave('pending')],
        ['company-created REJECTED', await companyLeave('rejected')],
        ['guard-created APPROVED', await guardLeave('approved')],
        ['guard-created REJECTED', await guardLeave('rejected')],
      ];
      const ownPending = await guardLeave();
      const otherGuards = await api('POST', '/leave/mine', gNewestBlocked.token, leavePayload());
      assert.ok(ok2xx(otherGuards), show(otherGuards));

      const edit = { leaveType: 'other', startAt: '2031-12-24T09:00:00Z', endAt: '2031-12-27T09:00:00Z', reason: 'Edited by guard' };
      const before = await leaveFingerprint();
      const approvedBefore = await approvedFingerprint();
      const refusals: Res[] = [];
      for (const [label, id] of targets) {
        const res = await api('POST', '/leave/mine', gSingle.token, { id, ...edit });
        if (ok2xx(res)) fail(`guard overwrote ${label} leave (${res.status})`);
        refusals.push(res);
      }
      for (const [label, who, id] of [
        ["another guard's leave", gSingle, otherGuards.body.id], ['pending leave at a former employer', gLeaver, leaverLeave.body.id],
        ['own pending leave with a different companyId', gSingle, ownPending],
      ] as const) {
        const body = label.includes('different companyId') ? { id, ...edit, companyId: B } : { id, ...edit };
        const res = await api('POST', '/leave/mine', who.token, body);
        if (ok2xx(res)) fail(`guard edited ${label} (${res.status})`);
        refusals.push(res);
      }
      const shapes = new Set(refusals.map((r) => `${r.status} ${errText(r)}`));
      if (shapes.size !== 1) fail(`refused edits are distinguishable: ${[...shapes].join(' | ')}`);
      if ((await leaveFingerprint()).h !== before.h) fail('a refused guard edit changed guard_leave');
      if ((await approvedFingerprint()).h !== approvedBefore.h) fail('a refused guard edit changed an APPROVED (scheduling) leave');

      const allowed = await api('POST', '/leave/mine', gSingle.token, { id: ownPending, ...edit });
      if (!ok2xx(allowed)) fail(`guard could not edit their own pending request: ${show(allowed)}`);
      else {
        const row = await one(`SELECT status, reason, "companyId" FROM guard_leave WHERE id = $1`, [ownPending]);
        if (row.status !== 'pending' || row.reason !== 'Edited by guard' || row.companyId !== A) fail(`own pending edit stored ${JSON.stringify(row)}`);
        if ((await approvedFingerprint()).h !== approvedBefore.h) fail('editing a pending request changed APPROVED leave');
      }
    });

    // ───────────────────────────── HISTORY ─────────────────────────────
    await group('HISTORY: former guards\' leave stays readable and unchanged; nothing cancelled when a relationship ends', async (fail) => {
      const res = await api('GET', '/leave', ownerA.token);
      if (!ok2xx(res) || !Array.isArray(res.body)) { fail(`GET /leave: ${show(res)}`); return; }
      const ids = new Set(res.body.map((l: any) => l.id));
      if (!ids.has(noneHistory.id)) fail('approved leave recorded for a now-INACTIVE guard is missing');
      if (!ids.has(leaverLeave.body.id)) fail('pending leave filed by a now-INACTIVE guard is missing');
      const leaver = await one(`SELECT status FROM guard_leave WHERE id = $1`, [leaverLeave.body.id]);
      if (leaver.status !== 'pending') fail(`pending leave was changed to ${leaver.status} when the relationship ended`);
      const dbCount = Number((await one(`SELECT count(*) n FROM guard_leave WHERE "companyId" = $1`, [A])).n);
      if (res.body.length !== dbCount) fail(`company A sees ${res.body.length} of its ${dbCount} leave records`);
    });

    // ───────────────────────────── NOTIFICATIONS ─────────────────────────────
    await group('NOTIFICATIONS: company inbox excludes guard-addressed notifications; guard inbox keeps them', async (fail) => {
      const inbox = await api('GET', '/notifications/company', ownerA.token);
      if (!ok2xx(inbox)) { fail(`owner A inbox: ${show(inbox)}`); return; }
      const ids = new Set(inbox.body.map((n: any) => n.id));
      if (!ids.has(nOwnerA)) fail('owner A inbox lost its own notification');
      if (ids.has(nGuardA)) fail('owner A inbox shows a notification addressed to a guard');
      if (ids.has(nOwnerB)) fail('owner A inbox shows company B\'s notification');
      const mine = await api('GET', '/notifications/mine', gSingle.token);
      if (!ok2xx(mine) || !mine.body.some((n: any) => n.id === nGuardA)) fail(`guard inbox lost its notification: ${show(mine)}`);
      const read = await api('PATCH', `/notifications/${nGuardA}/read`, gSingle.token);
      if (!ok2xx(read)) fail(`guard cannot mark their notification read: ${show(read)}`);
      if (ok2xx(await api('PATCH', `/notifications/${nGuardA}/read`, ownerA.token))) fail('the company marked a guard\'s notification read');
      const inboxB = await api('GET', '/notifications/company', ownerB.token);
      if (!ok2xx(inboxB) || inboxB.body.some((n: any) => n.id === nOwnerA || n.id === nGuardA)) fail(`owner B inbox crosses tenants: ${show(inboxB)}`);
      if ((await api('GET', '/notifications/company', gSingle.token)).status < 400) fail('a guard read a company inbox');
    });

    // ───────────────────────────── TENANT ─────────────────────────────
    await group('TENANT: another company cannot read or change this company\'s leave or employment', async (fail) => {
      const listB = await api('GET', '/leave', ownerB.token);
      if (!ok2xx(listB)) fail(`owner B GET /leave: ${show(listB)}`);
      else if (listB.body.some((l: any) => (l.company?.id ?? l.companyId) === A)) fail('owner B sees company A leave');
      const before = await leaveFingerprint();
      const put = await api('PUT', '/leave', ownerB.token, { id: noneHistory.id, guardId: gMulti.guardId, leaveType: 'other', startAt: '2031-01-01T09:00:00Z', endAt: '2031-01-02T09:00:00Z', status: 'rejected' });
      if (ok2xx(put)) fail(`owner B changed company A leave (${put.status})`);
      if ((await leaveFingerprint()).h !== before.h) fail('a cross-tenant leave write changed guard_leave');
      const emp = await api('GET', `/guard-personnel/company/guard/${gSingle.guardId}/employment`, ownerB.token);
      if (ok2xx(emp)) fail('owner B read company A employment');
    });

    // ───────────────────────────── GUARD-COMPAT ─────────────────────────────
    await group('GUARD-COMPAT: existing guard leave API and payload unchanged for one ACTIVE employer', async (fail) => {
      const mine = await api('GET', '/leave/mine', gSingle.token);
      if (!ok2xx(mine) || !Array.isArray(mine.body) || !mine.body.length) fail(`GET /leave/mine: ${show(mine)}`);
      const res = await api('POST', '/leave/mine', gSingle.token, { leaveType: 'annual_leave', startAt: '2032-01-05T09:00:00Z', endAt: '2032-01-06T09:00:00Z', reason: null });
      if (res.status !== 201) fail(`old-app payload: ${show(res)}`);
      else if (res.body.status !== 'pending') fail(`old-app payload status ${res.body.status}`);
    });
  } finally {
    await app.close();
  }

  console.log(`\nStage 2B membership and leave: ${groupsPassed} groups passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
  console.log(JSON.stringify({ event: 'stage2b_membership_leave_passed', groups: groupsPassed }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
