/**
 * Database performance stabilisation — equivalence and safety certification.
 *
 * Three hot paths were rewritten to take fewer pooled connections. Each rewrite must decide and return
 * EXACTLY what the code it replaced did. Proven here against the REAL application on a local,
 * disposable PostgreSQL, by running the previous algorithm (reproduced below from ea85cd4) and the new
 * one over the same rows and comparing the results, and by counting the connections each takes.
 *
 *   PS-01..03  company context: one membership query instead of three, identical decisions
 *   PS-04..05  session subject: one query for the account and its last password reset
 *   PS-06..07  a database failure during authentication is never reported as 401
 *   PS-08..10  /compliance/statuses: batched reads, identical summaries, tenant isolation
 *
 * Requires PERF_STABILISATION_DATABASE_URL (localhost).
 */
import 'reflect-metadata';
import * as assert from 'assert';
import { ForbiddenException, NotFoundException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

const url = process.env.PERF_STABILISATION_DATABASE_URL ?? '';
if (!url) throw new Error('PERF_STABILISATION_DATABASE_URL is required');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
delete process.env.DB_POOL_DIAGNOSTICS;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'perf-stabilisation-local-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

let passed = 0;
const pass = (name: string) => {
  passed += 1;
  console.log(`PASS ${name}`);
};

/** A comparable description of a resolution: the company and role, or the refusal. */
const outcome = async (work: () => Promise<{ company: { id: number }; membershipRole: string }>) => {
  try {
    const ctx = await work();
    return { companyId: ctx.company.id, role: ctx.membershipRole };
  } catch (error) {
    return { error: (error as Error).constructor.name, message: (error as Error).message };
  }
};

async function main() {
  const { buildTypeOrmOptions, poolIdleTimeoutMillis } = await import('../src/database/typeorm.config');
  // PS-00: the idle timeout is unchanged unless configured, bounded when it is, and max never moves.
  assert.equal(poolIdleTimeoutMillis(undefined), 30000);
  assert.equal(poolIdleTimeoutMillis(''), 30000);
  assert.equal(poolIdleTimeoutMillis('abc'), 30000);
  assert.equal(poolIdleTimeoutMillis('120000'), 120000);
  assert.equal(poolIdleTimeoutMillis('5'), 10000);
  assert.equal(poolIdleTimeoutMillis('99999999'), 600000);
  const defaults = buildTypeOrmOptions({ DATABASE_URL: url, DATABASE_SSL: 'false', NODE_ENV: 'test' }) as any;
  const tuned = buildTypeOrmOptions({ DATABASE_URL: url, DATABASE_SSL: 'false', NODE_ENV: 'test', DATABASE_POOL_IDLE_TIMEOUT_MS: '120000' }) as any;
  assert.deepEqual(defaults.extra, { connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, max: 10, keepAlive: true });
  assert.deepEqual(tuned.extra, { connectionTimeoutMillis: 10000, idleTimeoutMillis: 120000, max: 10, keepAlive: true });
  pass('PS-00 pool: idle timeout 30 s unless DATABASE_POOL_IDLE_TIMEOUT_MS is set (bounded 10 s-10 min); max stays 10');

  const migrator = new DataSource(buildTypeOrmOptions({ DATABASE_URL: url, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' }));
  await migrator.initialize();
  await migrator.runMigrations({ transaction: 'each' });
  await migrator.destroy();

  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as any).port}`;
  const ds = app.get(DataSource);
  const [{ current_database: db }] = await ds.query('SELECT current_database()');
  assert.equal(db, new URL(url).pathname.slice(1));

  const { AuthService } = await import('../src/auth/auth.service');
  const { AccountRecoveryService } = await import('../src/auth/account-recovery.service');
  const { TransactionalEmailService } = await import('../src/email/transactional-email.service');
  const { CompanyMembershipService } = await import('../src/company-membership/company-membership.service');
  const { CompanyMembership } = await import('../src/company-membership/entities/company-membership.entity');
  const { CompanyMembershipRole, CompanyMembershipStatus, CompanyPermission } = await import('../src/company-membership/company-membership-types');
  const { CompanyService } = await import('../src/company/company.service');
  const { UserService } = await import('../src/user/user.service');
  const { UserRole } = await import('../src/user/entities/user.entity');
  const { JwtStrategy } = await import('../src/auth/jwt.strategy');
  const { GuardComplianceService } = await import('../src/compliance/guard-compliance.service');
  const { CompanyGuard, CompanyGuardStatus } = await import('../src/company-guard/entities/company-guard.entity');
  const { PoolDiagnostics } = await import('../src/database/pool-diagnostics/pool-diagnostics');
  const { readPoolDiagnosticsConfig } = await import('../src/database/pool-diagnostics/pool-diagnostics.config');
  const { newDbRequestContext, runWithDbRequestContext } = await import('../src/database/pool-diagnostics/request-context');

  // Connections taken by a piece of work, counted by the pool diagnostics themselves.
  const diag = new PoolDiagnostics((ds.driver as any).master, readPoolDiagnosticsConfig({ DB_POOL_DIAGNOSTICS: 'true' }), () => undefined).attach();
  const connectionsFor = async <T>(work: () => Promise<T>): Promise<{ result: T; connections: number }> => {
    const ctx = newDbRequestContext('count', 'TEST', '/count');
    const result = await runWithDbRequestContext(ctx, work);
    return { result, connections: ctx.acquisitions };
  };

  const auth = app.get(AuthService);
  const recovery = app.get(AccountRecoveryService);
  const memberships = app.get(CompanyMembershipService);
  const membershipRepo = ds.getRepository(CompanyMembership);
  const companies = app.get(CompanyService);
  const users = app.get(UserService);
  const compliance = app.get(GuardComplianceService);

  const RUN = Date.now().toString(36);
  const password = 'Str0ng-pass-1!';
  const verify = async (email: string) => {
    const message = [...app.get(TransactionalEmailService).capturedMessages()].reverse().find((m: any) => m.kind === 'email_verification' && m.to === email);
    const token = message && /verify-email\?token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
    assert.ok(token);
    await recovery.verifyEmail(token);
  };
  const registerCompany = async (label: string) => {
    const email = `${label}.${RUN}@perf.test`;
    await auth.register({
      email, password, role: 'company' as any, fullName: `${label} Owner`, phone: '02000000000',
      companyName: `${label} ${RUN} Ltd`, companyNumber: String(10000000 + Math.floor(Math.random() * 8999999)),
      address: '1 High St, London', contactDetails: `ops@${label}.test`,
    } as any);
    await verify(email);
    const s: any = await auth.login({ email, password });
    return { userId: s.user.id as number, companyId: s.user.companyId as number, token: s.accessToken as string, role: UserRole.COMPANY };
  };
  let sia = 6200000000000000 + Math.floor(Math.random() * 1e9);
  const registerGuard = async (label: string) => {
    const email = `${label}.${RUN}@perf.test`;
    const siaNumber = String((sia += 7919));
    await auth.register({ email, password, role: 'guard' as any, fullName: `${label} Guard`, phone: '07700000000', siaLicenseNumber: siaNumber } as any);
    await verify(email);
    const s: any = await auth.login({ email, password });
    return { userId: s.user.id as number, guardId: s.user.guardId as number, siaNumber };
  };

  // ── the previous resolveCompanyContext, verbatim in behaviour (ea85cd4) ───────────────────────
  const { hasPermission } = await import('../src/company-membership/company-membership-types');
  const previousResolve = async (userId: number, userRole: string, requiredPermission?: string) => {
    const active = await membershipRepo.findOne({ where: { userId, status: CompanyMembershipStatus.ACTIVE }, relations: ['company'] });
    if (active) {
      if (requiredPermission && !hasPermission(active.membershipRole, requiredPermission as any)) throw new ForbiddenException('Insufficient permissions.');
      return { company: active.company, membershipRole: active.membershipRole };
    }
    if (await membershipRepo.findOne({ where: { userId, status: CompanyMembershipStatus.SUSPENDED } })) throw new ForbiddenException('Your company access has been suspended.');
    if (await membershipRepo.findOne({ where: { userId, status: CompanyMembershipStatus.REVOKED } })) throw new ForbiddenException('Your company access has been revoked.');
    if (!(userRole === UserRole.COMPANY || userRole === UserRole.COMPANY_ADMIN)) throw new NotFoundException('Company not found.');
    const company = await companies.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found.');
    if (company.user?.id !== userId) throw new ForbiddenException('Company ownership mismatch.');
    if (requiredPermission && !hasPermission(CompanyMembershipRole.OWNER, requiredPermission as any)) throw new ForbiddenException('Insufficient permissions.');
    return { company, membershipRole: CompanyMembershipRole.OWNER };
  };

  try {
    const A = await registerCompany('coa');
    const B = await registerCompany('cob');
    const member = async (userId: number, companyId: number, membershipRole: any, status: any) =>
      membershipRepo.save(membershipRepo.create({ userId, companyId, membershipRole, status }));

    // Every membership shape the policy distinguishes, on users who also own a company of their own
    // (so a wrong fall-through to legacy ownership would be visible).
    const u = {
      activeAdmin: await registerCompany('u1'),
      suspended: await registerCompany('u2'),
      revoked: await registerCompany('u3'),
      legacyOwner: await registerCompany('u4'),
      suspendedAndRevoked: await registerCompany('u5'),
      activeAndRevokedElsewhere: await registerCompany('u6'),
      operationsMember: await registerCompany('u7'),
      revokedThenActive: await registerCompany('u8'),
    };
    await member(u.activeAdmin.userId, A.companyId, CompanyMembershipRole.ADMIN, CompanyMembershipStatus.ACTIVE);
    await member(u.suspended.userId, A.companyId, CompanyMembershipRole.ADMIN, CompanyMembershipStatus.SUSPENDED);
    await member(u.revoked.userId, A.companyId, CompanyMembershipRole.ADMIN, CompanyMembershipStatus.REVOKED);
    await member(u.suspendedAndRevoked.userId, A.companyId, CompanyMembershipRole.ADMIN, CompanyMembershipStatus.REVOKED);
    await member(u.suspendedAndRevoked.userId, B.companyId, CompanyMembershipRole.ADMIN, CompanyMembershipStatus.SUSPENDED);
    await member(u.activeAndRevokedElsewhere.userId, A.companyId, CompanyMembershipRole.ADMIN, CompanyMembershipStatus.REVOKED);
    await member(u.activeAndRevokedElsewhere.userId, B.companyId, CompanyMembershipRole.CONTROL_ROOM, CompanyMembershipStatus.ACTIVE);
    await member(u.operationsMember.userId, A.companyId, CompanyMembershipRole.OPERATIONS, CompanyMembershipStatus.ACTIVE);
    await member(u.revokedThenActive.userId, B.companyId, CompanyMembershipRole.ADMIN, CompanyMembershipStatus.REVOKED);
    await member(u.revokedThenActive.userId, A.companyId, CompanyMembershipRole.ADMIN, CompanyMembershipStatus.ACTIVE);
    const guardUser = await registerGuard('gx');

    const cases: Array<[string, number, string]> = [
      ...Object.entries(u).map(([k, v]) => [k, v.userId, v.role] as [string, number, string]),
      ['company owner A', A.userId, UserRole.COMPANY],
      ['owner as company_admin role', u.legacyOwner.userId, UserRole.COMPANY_ADMIN],
      ['guard without membership', guardUser.userId, UserRole.GUARD],
      ['unknown user', 987654321, UserRole.COMPANY],
    ];
    const permissions = [undefined, CompanyPermission.COMPLIANCE_VIEW, CompanyPermission.COMPLIANCE_MANAGE, CompanyPermission.COMPANY_MANAGE];
    let compared = 0;
    for (const [label, userId, role] of cases) {
      for (const permission of permissions) {
        const before = await outcome(() => previousResolve(userId, role, permission));
        const after = await outcome(() => memberships.resolveCompanyContext(userId, role as any, permission));
        assert.deepEqual(after, before, `${label} / ${permission ?? 'no permission'}`);
        compared += 1;
      }
    }
    // Sanity: the matrix really exercises every branch.
    const kinds = new Set<string>();
    for (const [, userId, role] of cases) kinds.add(JSON.stringify(await outcome(() => memberships.resolveCompanyContext(userId, role as any))).replace(/\d+/g, 'N'));
    assert.ok([...kinds].some((k) => k.includes('suspended')) && [...kinds].some((k) => k.includes('revoked')) && [...kinds].some((k) => k.includes('"owner"')) && [...kinds].some((k) => k.includes('NotFoundException')));
    pass(`PS-01 company context: ${compared} user/permission cases decide identically to the previous algorithm`);

    const asMember = await connectionsFor(() => memberships.resolveCompanyContext(u.activeAdmin.userId, UserRole.COMPANY));
    const asLegacyOwner = await connectionsFor(() => memberships.resolveCompanyContext(u.legacyOwner.userId, UserRole.COMPANY));
    const previousLegacy = await connectionsFor(() => previousResolve(u.legacyOwner.userId, UserRole.COMPANY));
    assert.equal(asMember.connections, 1, 'a member resolves in one query');
    assert.equal(asLegacyOwner.connections, 2, 'a legacy owner resolves in two queries');
    assert.equal(previousLegacy.connections, 4, 'the previous algorithm took four');
    pass('PS-02 company context: legacy owner 4 -> 2 connections, member 1');

    // Tenant isolation over HTTP: each company sees only its own Guards' compliance, both ways round.
    const gA = await registerGuard('ga');
    const gB = await registerGuard('gb');
    const link = async (owner: { token: string; companyId: number }, guardId: number) => {
      const r = await fetch(`${base}/company-guards`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
        body: JSON.stringify({ companyId: owner.companyId, guardId }),
      });
      assert.equal(r.status, 201);
    };
    await link(A, gA.guardId);
    await link(B, gB.guardId);
    const statusesOf = async (token: string) =>
      (await (await fetch(`${base}/compliance/statuses`, { headers: { authorization: `Bearer ${token}` } })).json()).map((s: any) => s.guardId);
    assert.deepEqual(await statusesOf(A.token), [gA.guardId]);
    assert.deepEqual(await statusesOf(B.token), [gB.guardId]);
    pass('PS-03 tenant isolation: each company lists only its own Guards');

    // ── session subject ───────────────────────────────────────────────────────────────────────────
    const tokenRow = (userId: number, purpose: string, usedAt: Date | null) =>
      ds.query(`INSERT INTO user_verification_tokens ("userId", purpose, "tokenHash", "expiresAt", "usedAt") VALUES ($1, $2, $3, now() + interval '1 day', $4)`,
        [userId, purpose, `${RUN}${Math.random().toString(16).slice(2)}`.slice(0, 64), usedAt]);
    const t1 = new Date('2026-01-02T10:00:00.000Z');
    const t2 = new Date('2026-03-04T11:22:33.000Z');
    const t3 = new Date('2026-05-06T12:00:00.000Z');
    const withResets = u.activeAdmin.userId;
    await tokenRow(withResets, 'password_reset', t1);
    await tokenRow(withResets, 'password_reset', t2);
    await tokenRow(withResets, 'password_reset', null); // unused: ignored
    await tokenRow(withResets, 'email_verification', t3); // other purpose: ignored
    const onlyOtherPurpose = u.suspended.userId;
    await tokenRow(onlyOtherPurpose, 'email_verification', t3);
    for (const userId of [withResets, onlyOtherPurpose, u.legacyOwner.userId, guardUser.userId]) {
      const before = { user: await users.findById(userId), lastPasswordResetAt: await recovery.lastPasswordResetAt(userId) };
      const { result: after, connections } = await connectionsFor(() => recovery.findSessionSubject(userId));
      assert.deepEqual(after, before, `session subject for user ${userId}`);
      assert.equal(connections, 1, 'one query');
    }
    assert.equal((await recovery.findSessionSubject(withResets)).lastPasswordResetAt?.toISOString(), t2.toISOString(), 'the latest used reset');
    assert.deepEqual(await recovery.findSessionSubject(987654321), { user: null, lastPasswordResetAt: null });
    pass('PS-04 session subject: identical account and last password reset as the two separate lookups, in one query');

    const strategy = app.get(JwtStrategy);
    const iatBefore = Math.floor(t2.getTime() / 1000) - 5;
    await assert.rejects(strategy.validate({ sub: withResets, iat: iatBefore } as any), (e: any) => e instanceof UnauthorizedException && /no longer valid/.test(e.message));
    const ok = await strategy.validate({ sub: withResets, iat: Math.floor(Date.now() / 1000) } as any);
    assert.equal(ok.sub, withResets);
    await assert.rejects(strategy.validate({ sub: 987654321, iat: Math.floor(Date.now() / 1000) } as any), (e: any) => e instanceof UnauthorizedException);
    const viaHttp = await fetch(`${base}/compliance/statuses`, { headers: { authorization: `Bearer ${A.token}` } });
    assert.equal(viaHttp.status, 200);
    pass('PS-05 JWT: tokens before a reset rejected, current accepted, missing account 401 — through the real strategy');

    // ── a database failure is not "unauthorised" ─────────────────────────────────────────────────
    const config = { get: () => 'secret' } as any;
    const dbDown = new Error('timeout exceeded when trying to connect');
    const failing = new JwtStrategy(config, { findById: async () => { throw dbDown; } } as any, { findSessionSubject: async () => { throw dbDown; } } as any);
    await assert.rejects(failing.validate({ sub: 1 } as any), (e: any) => e === dbDown, 'user lookup failure surfaces as itself, not 401');
    await assert.rejects(failing.validate({ sub: 1, principalType: 'client_portal' } as any), (e: any) => e === dbDown, 'client portal lookup failure surfaces as itself, not 401');
    const missingClient = new JwtStrategy(config, { findById: async () => { throw new NotFoundException('Client portal user not found'); } } as any, {} as any);
    await assert.rejects(missingClient.validate({ sub: 1, principalType: 'client_portal' } as any), (e: any) => e instanceof UnauthorizedException);
    // PassportStrategy registers every instance it constructs as THE 'jwt' strategy; put the app's back.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('passport').use(strategy);
    pass('PS-06 a database failure during authentication is thrown as itself; only a missing account is 401');

    // Over HTTP: with the session lookup failing, the API answers 500, never 401.
    const original = recovery.findSessionSubject.bind(recovery);
    (recovery as any).findSessionSubject = async () => { throw dbDown; };
    try {
      const during = await fetch(`${base}/compliance/statuses`, { headers: { authorization: `Bearer ${A.token}` } });
      assert.equal(during.status, 500, `a server error, so clients keep the session (got ${during.status} ${await during.text()})`);
    } finally {
      (recovery as any).findSessionSubject = original;
    }
    assert.equal((await fetch(`${base}/compliance/statuses`, { headers: { authorization: `Bearer ${A.token}` } })).status, 200);
    pass('PS-07 over HTTP a database failure during authentication is 500, and recovers to 200');

    // ── /compliance/statuses batched ─────────────────────────────────────────────────────────────
    // Six Guards in company A with every kind of row, plus the same Guards' rows in company B that
    // must never appear in A's view.
    const guards = [gA, ...(await Promise.all(['g1', 'g2', 'g3', 'g4', 'g5'].map((l) => registerGuard(l))))];
    for (const g of guards.slice(1)) await link(A, g.guardId);
    await link(B, guards[2].guardId);
    await link(B, guards[3].guardId);
    const ukDay = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const record = async (owner: { token: string }, body: object) => {
      const r = await fetch(`${base}/compliance/checks`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` }, body: JSON.stringify(body) });
      const text = await r.text();
      assert.ok(r.status === 201, `check recorded (${r.status} ${text})`);
      return JSON.parse(text);
    };
    const siaCheck = (g: { guardId: number; siaNumber: string }, over: object = {}) => ({ guardId: g.guardId, kind: 'sia', outcome: 'confirmed', method: 'sia_public_register', licenceNumber: g.siaNumber, checkDate: ukDay(-1), expiryDate: ukDay(400), checkedByName: 'Pat Checker', evidenceReference: 'HR SIA', ...over });
    const rtwCheck = (g: { guardId: number }, over: object = {}) => ({ guardId: g.guardId, kind: 'right_to_work', outcome: 'confirmed', method: 'manual_document', rightToWorkExcuse: 'continuous', checkDate: ukDay(-1), checkedByName: 'Pat Checker', evidenceReference: 'HR RTW', ...over });
    await record(A, siaCheck(guards[0]));
    await record(A, rtwCheck(guards[0]));
    await record(A, siaCheck(guards[1], { expiryDate: ukDay(20) })); // expiring
    await record(A, rtwCheck(guards[1]));
    await record(A, rtwCheck(guards[2], { method: 'home_office_online', rightToWorkExcuse: 'time_limited', expiryDate: ukDay(200) }));
    await record(B, siaCheck(guards[2]));
    await record(B, rtwCheck(guards[3]));
    await record(A, siaCheck(guards[4], { outcome: 'not_confirmed', expiryDate: null }));
    // A superseded check: only the current one may count.
    const first = await record(A, siaCheck(guards[5]));
    await record(A, siaCheck(guards[5], { replacesCheckId: first.id, changeType: 'new_check', expiryDate: ukDay(10) }));
    const docRepo = ds.getRepository((await import('../src/compliance/entities/guard-document.entity')).GuardDocument);
    const recRepo = ds.getRepository((await import('../src/compliance/entities/compliance-record.entity')).ComplianceRecord);
    for (const [i, g] of guards.entries()) {
      if (i % 2 === 0) await docRepo.save(docRepo.create({ guard: { id: g.guardId } as any, company: { id: A.companyId } as any, type: 'sia_licence' as any, originalFileName: `a${i}.pdf`, uploadCompletedAt: new Date(), verified: i === 0 }));
      if (i % 3 === 0) await docRepo.save(docRepo.create({ guard: { id: g.guardId } as any, company: { id: A.companyId } as any, type: 'right_to_work' as any, originalFileName: `r${i}.pdf`, uploadCompletedAt: i === 0 ? new Date() : null, verified: false }));
      await docRepo.save(docRepo.create({ guard: { id: g.guardId } as any, company: { id: B.companyId } as any, type: 'sia_licence' as any, originalFileName: `b${i}.pdf`, uploadCompletedAt: new Date(), verified: true }));
      if (i % 2 === 1) await recRepo.save(recRepo.create({ guard: { id: g.guardId } as any, company: { id: A.companyId } as any, type: 'TRAINING' as any, documentName: `Training ${i}`, expiryDate: ukDay(30 + i), status: 'valid' as any }));
      await recRepo.save(recRepo.create({ guard: { id: g.guardId } as any, company: { id: B.companyId } as any, type: 'SIA' as any, documentName: `B record ${i}`, expiryDate: ukDay(5), status: 'expiring' as any }));
    }
    // Guards 0 and 1 hold verified SIA and Right to Work evidence in A: with their checks, valid / expiring.
    for (const g of guards.slice(0, 2)) {
      for (const type of ['sia_licence', 'right_to_work']) {
        await docRepo.save(docRepo.create({ guard: { id: g.guardId } as any, company: { id: A.companyId } as any, type: type as any, originalFileName: `v-${type}.pdf`, uploadCompletedAt: new Date(), verified: true }));
      }
    }
    // A BLOCKED link is listed too; an ended one is not (as before).
    await ds.query('UPDATE company_guards SET status = $1 WHERE "companyId" = $2 AND "guardId" = $3', [CompanyGuardStatus.BLOCKED, A.companyId, guards[5].guardId]);

    const links = await ds.getRepository(CompanyGuard).find({ where: { company: { id: A.companyId } }, order: { id: 'DESC' } });
    const listed = links.filter((l) => [CompanyGuardStatus.ACTIVE, CompanyGuardStatus.BLOCKED].includes(l.status) && l.guard);
    const normalise = (value: unknown) => JSON.parse(JSON.stringify(value));
    const perGuard = normalise(await Promise.all(listed.map((l) => compliance.getGuardSummary(l.guard.id, A.companyId))));
    const { result: batched, connections } = await connectionsFor(() => compliance.listStatusesForCompanyUser(A.userId, UserRole.COMPANY));
    assert.deepEqual(normalise(batched), perGuard, 'identical summaries, in the same order');
    assert.equal(perGuard.length, 6);
    const statuses = new Set(perGuard.map((s: any) => s.complianceStatus));
    assert.ok(statuses.size >= 3, `the fixture covers several statuses (${[...statuses].join(', ')})`);
    assert.ok(perGuard.some((s: any) => s.documents.length > 1) && perGuard.some((s: any) => s.companyChecks?.sia?.expiryDate === ukDay(10)), 'documents and the CURRENT superseding check are present');
    for (const s of perGuard) {
      for (const d of s.documents) assert.ok(!String(d.originalFileName ?? '').startsWith('b'), 'company B documents never appear in A');
    }
    for (const status of ['valid', 'expiring', 'invalid', 'unknown'] as const) {
      const filtered = normalise(await compliance.listStatusesForCompanyUser(A.userId, UserRole.COMPANY, status as any));
      assert.deepEqual(filtered, perGuard.filter((s: any) => s.complianceStatus === status), `status filter ${status}`);
    }
    pass('PS-08 /compliance/statuses: batched summaries are identical to per-Guard summaries, including the status filter');

    const perGuardConnections = (await connectionsFor(() => Promise.all(listed.map((l) => compliance.getGuardSummary(l.guard.id, A.companyId))))).connections;
    assert.equal(perGuardConnections, 24, 'per Guard: four queries each');
    assert.ok(connections <= 2 + 1 + 4, `batched: company context + links + four batched reads (took ${connections})`);
    pass(`PS-09 /compliance/statuses connections for 6 Guards: ${4 + 1 + perGuardConnections} before -> ${connections} after`);

    const bView = normalise(await compliance.listStatusesForCompanyUser(B.userId, UserRole.COMPANY));
    const bPerGuard = normalise(await Promise.all(
      (await ds.getRepository(CompanyGuard).find({ where: { company: { id: B.companyId } }, order: { id: 'DESC' } }))
        .filter((l) => [CompanyGuardStatus.ACTIVE, CompanyGuardStatus.BLOCKED].includes(l.status))
        .map((l) => compliance.getGuardSummary(l.guard.id, B.companyId)),
    ));
    assert.deepEqual(bView, bPerGuard);
    assert.deepEqual(bView.map((s: any) => s.guardId).sort(), [gB.guardId, guards[2].guardId, guards[3].guardId].sort());
    for (const s of bView) for (const d of s.documents) assert.ok(String(d.originalFileName ?? '').startsWith('b'), 'only company B documents in B');
    assert.deepEqual(normalise(await compliance.getGuardSummariesForCompany([], A.companyId)), []);
    pass('PS-10 tenant isolation: the same Guards seen by company B show only B\'s documents, records and checks');
  } finally {
    diag.detach();
    await app.close();
  }

  console.log(JSON.stringify({ event: 'perf_stabilisation_certified', tests: passed }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
