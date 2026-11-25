/**
 * Platform Admin two-step verification (authenticator app, RFC 6238 TOTP), over real HTTP against the real AppModule,
 * the production ValidationPipe and `trust proxy` setting, and a LOCAL, disposable PostgreSQL built by the migrations.
 *
 *   MFA-00-TOTP-RFC6238          the TOTP primitive reproduces the RFC 6238 SHA-1 test vectors; base32 round-trips; the
 *                                otpauth:// URI carries issuer S4, SHA1, 6 digits, 30 s
 *   MFA-01-BASELINE-UNCHANGED    flag off, not enrolled: a Platform Admin's password sign-in is exactly today's response
 *                                (web: accessToken + user; mobile: + refreshToken, refreshExpiresAt), no `mfa` claim
 *   MFA-02-ENROL                 start enrolment (secret + otpauth URI, stored only encrypted), a wrong code is refused
 *                                (403, the session survives), a right code activates it and returns a fresh session; the
 *                                admin's earlier access token and refresh session stop working; enrolling again is 409
 *   MFA-03-PASSWORD-ONLY-BLOCKED an enrolled admin's correct password yields only a challenge: no token, no user, no
 *                                refresh token, no session row
 *   MFA-04-CODE-COMPLETES        challenge + current code → exactly the sign-in response; the token works; refresh keeps
 *                                the two-step claim
 *   MFA-05-REPLAY-REFUSED        the same code (same time step) cannot be used twice, nor an earlier step's code
 *   MFA-06-CONCURRENT-SAME-CODE  two simultaneous sign-ins with one code: exactly one succeeds
 *   MFA-07-WRONG-CODE-THROTTLED  wrong codes are 401 and audited; the 6th attempt from one source is 429 even with the
 *                                right code; another source still signs in; 10 failures from 10 new sources hold new
 *                                sources (429) but never a source the admin has signed in from
 *   MFA-08-CHALLENGE-NOT-A-SESSION  a challenge token is refused as a bearer token everywhere; an access token, a forged
 *                                challenge (signed with JWT_SECRET) and garbage are refused as challenges
 *   MFA-09-CHALLENGE-EXPIRES     a challenge is refused after 5 minutes, even with a valid code
 *   MFA-10-FLAG-FORCES-ENROLMENT PLATFORM_ADMIN_MFA_REQUIRED=true: an unenrolled admin's existing token and refresh
 *                                session stop working; password sign-in yields only an enrolment token, which reaches the
 *                                enrolment routes and nothing else; enrolling completes sign-in; turning it off is refused
 *   MFA-11-NON-ADMIN-UNAFFECTED  with the flag on: Guard, company and client-portal sign-in, refresh and /auth/me are
 *                                exactly as before (no `mfa` claim, no extra fields, no rows); they cannot reach the
 *                                two-step routes (403)
 *   MFA-12-DISABLE               flag off: turning it off needs a current code (wrong → 403); afterwards the password signs
 *                                in directly again
 *   MFA-13-RECOVERY              the operator CLI recovery (admin-operator recover) resets two-step verification with the
 *                                password: flag on → enrolment, flag off → a session; audited with mfaReset
 *   MFA-14-SECRET-NEVER-EXPOSED  after each confirmation no response carries the secret or its envelope; no audit row
 *                                carries a secret, envelope, code or token; the stored values are AES-GCM envelopes
 *   MFA-15-AUDITED               enrolment started, enabled, sign-in verified, code rejected (wrong / replayed), disabled,
 *                                with the admin and the source address
 *
 * Requires ADMIN_MFA_DATABASE_URL (a DISPOSABLE local database: the migrations run on it). Every account is synthetic
 * and every password is generated per run and never printed.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import { base32Decode, base32Encode, hotp, otpauthUri, totpAt, totpStep } from '../src/auth/totp';

const url = process.env.ADMIN_MFA_DATABASE_URL;
if (!url) throw new Error('ADMIN_MFA_DATABASE_URL is required (a disposable local database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('The admin MFA database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
const JWT_SECRET = 'admin-mfa-local-certification-secret-not-production';
process.env.JWT_SECRET = JWT_SECRET;
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.PLATFORM_ADMIN_MFA_REQUIRED;

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

type Res = { status: number; body: any; text: string };
const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
const keys = (o: object) => Object.keys(o).sort();
/** A generated password that satisfies the operator policy; never printed. */
const newPassword = () => `${randomBytes(12).toString('base64url')}Aa1!`;

async function main() {
  // ── schema from the repository's migrations ──
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const migrator = new DataSource({ ...buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' }), dropSchema: true } as never);
  await migrator.initialize();
  const applied = await migrator.runMigrations({ transaction: 'each' });
  assert.equal(applied.at(-1)?.name, 'AddPlatformAdminMfa1720900000024', 'the head is Migration 77');
  await migrator.destroy();

  // A controllable clock: TOTP steps, token expiry and the failure windows all read Date.now.
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const advance = (ms: number) => { offset += ms; };
  const nextStep = () => advance(30_000);

  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const base = `http://127.0.0.1:${address.port}`;
  const ds = app.get(DataSource);
  const [{ current_database: actual }] = await ds.query('SELECT current_database()');
  if (actual !== new URL(url!).pathname.replace(/^\//, '')) throw new Error(`Refusing: connected to "${actual}"`);
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  const responses: string[] = [];
  let ipSeq = 0;
  const freshIp = () => `198.51.100.${(ipSeq = (ipSeq % 250) + 1)}`;
  const call = async (method: string, path: string, opts: { token?: string | null; body?: unknown; ip?: string; mobile?: boolean } = {}): Promise<Res> => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': opts.ip ?? freshIp(),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.mobile ? { 'x-s4-client': 'mobile' } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    responses.push(text);
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, text };
  };
  const login = (email: string, password: string, opts: { ip?: string; mobile?: boolean } = {}) =>
    call('POST', '/auth/login', { body: { email, password }, ...opts });
  const verify = (challengeToken: string, code: string, opts: { ip?: string; mobile?: boolean } = {}) =>
    call('POST', '/auth/mfa/verify', { body: { challengeToken, code }, ...opts });
  const wrongCode = (secret: string) => {
    const valid = new Set([-1, 0, 1].map((d) => totpAt(secret, Date.now() + d * 30_000)));
    for (let n = 0; ; n += 1) { const c = String(n * 111_111 % 1_000_000).padStart(6, '0'); if (!valid.has(c)) return c; }
  };
  const sessionCount = async (userId: number) => Number((await q(`SELECT count(*) n FROM auth_sessions WHERE "userId" = $1`, [userId]))[0].n);
  const audits = (action: string, userId?: number) =>
    q(`SELECT action, "afterData", "ipAddress", "userId" FROM audit_logs WHERE action = $1 ${userId ? 'AND "userId" = $2' : ''} ORDER BY id`, userId ? [action, userId] : [action]);
  const mfaRow = async (userId: number) => (await q(`SELECT * FROM platform_admin_mfa WHERE "userId" = $1`, [userId]))[0] ?? null;

  // ── synthetic accounts ──
  const { AdminOperatorService } = await import('../src/admin-operator/admin-operator.service');
  const operator = new AdminOperatorService(ds);
  const adminEmail = 'mfa.admin.one@example.invalid';
  const adminPassword = newPassword();
  const admin = await operator.bootstrap(adminEmail, adminPassword);
  const mkUser = async (email: string, role: string, password: string) =>
    Number((await q(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired")
      VALUES ($1,$2,$3,'active',true,false) RETURNING id`, [email, await bcrypt.hash(password, 10), role]))[0].id);
  const admin2Email = 'mfa.admin.two@example.invalid';
  let admin2Password = newPassword();
  const admin2Id = await mkUser(admin2Email, 'admin', admin2Password);
  const otherPassword = newPassword();
  const guardEmail = 'mfa.guard@example.invalid';
  const guardId = await mkUser(guardEmail, 'guard', otherPassword);
  const ownerEmail = 'mfa.company@example.invalid';
  const ownerId = await mkUser(ownerEmail, 'company_admin', otherPassword);
  const [company] = await q(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","verificationStatus") VALUES ($1,'MFA Spec Ltd','77000001','1 Way','ops@example.invalid','approved') RETURNING id`, [ownerId]);
  const [client] = await q(`INSERT INTO clients ("companyId",name) VALUES ($1,'MFA Spec Client') RETURNING id`, [company.id]);
  const clientEmail = 'mfa.client@example.invalid';
  await q(`INSERT INTO client_portal_users ("clientId",email,"passwordHash","firstName","lastName","isActive",role) VALUES ($1,$2,$3,'Cli','Ent',true,'client_admin')`,
    [client.id, clientEmail, await bcrypt.hash(otherPassword, 10)]);

  const baseline: Record<string, { body: string[]; user: string[]; claims: string[] }> = {};
  let secret = '';
  let envelope = '';
  const secretsAfterConfirm: Array<{ secret: string; envelope: string; from: number }> = [];
  let homeIp = '';

  try {
    await test('MFA-00-TOTP-RFC6238', () => {
      // RFC 6238 Appendix B, SHA-1 seed "12345678901234567890"; 6-digit codes are the last six of the 8-digit vectors.
      const seed = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
      assert.equal(seed, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
      for (const [t, code8] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']] as const) {
        assert.equal(hotp(base32Decode(seed), totpStep(t * 1000), 8), code8, `T=${t}`);
        assert.equal(totpAt(seed, t * 1000), code8.slice(2), `T=${t} (6 digits)`);
      }
      const bytes = randomBytes(20);
      assert.ok(base32Decode(base32Encode(bytes)).equals(bytes), 'base32 round-trips');
      assert.equal(otpauthUri(seed, 'a@b.test'), `otpauth://totp/S4:a%40b.test?secret=${seed}&issuer=S4&algorithm=SHA1&digits=6&period=30`);
    });

    // ════════════════ flag off ════════════════
    let firstToken = '';
    let firstRefresh = '';
    await test('MFA-01-BASELINE-UNCHANGED', async () => {
      const web = await login(adminEmail, adminPassword);
      assert.equal(web.status, 201, web.text);
      assert.deepEqual(keys(web.body), ['accessToken', 'user']);
      assert.deepEqual(keys(web.body.user), ['email', 'id', 'role', 'status'], 'undefined companyId/guardId are omitted, as today');
      assert.equal(claims(web.body.accessToken).mfa, undefined, 'no two-step claim');
      const mobile = await login(adminEmail, adminPassword, { mobile: true });
      assert.deepEqual(keys(mobile.body), ['accessToken', 'refreshExpiresAt', 'refreshToken', 'user']);
      firstToken = mobile.body.accessToken;
      firstRefresh = mobile.body.refreshToken;
      assert.equal((await call('GET', '/auth/me', { token: firstToken })).status, 200);
      const status = await call('GET', '/auth/mfa/status', { token: firstToken });
      assert.equal(status.status, 200, status.text);
      assert.deepEqual(status.body, { enrolled: false, enabledAt: null, pending: false, required: false, method: 'totp' });
      // The shape every other role gets today, compared again with the flag on (MFA-11).
      for (const email of [guardEmail, ownerEmail]) {
        const r = await login(email, otherPassword);
        assert.equal(r.status, 201, r.text);
        baseline[email] = { body: keys(r.body), user: keys(r.body.user), claims: keys(claims(r.body.accessToken)) };
      }
      const cl = await call('POST', '/auth/client-login', { body: { email: clientEmail, password: otherPassword } });
      assert.equal(cl.status, 201, cl.text);
      baseline[clientEmail] = { body: keys(cl.body), user: keys(cl.body.user ?? {}), claims: keys(claims(cl.body.accessToken)) };
    });

    await test('MFA-02-ENROL', async () => {
      const started = await call('POST', '/auth/mfa/totp/enrol', { token: firstToken });
      assert.equal(started.status, 200, started.text);
      assert.deepEqual(keys(started.body), ['accountName', 'algorithm', 'digits', 'expiresAt', 'issuer', 'method', 'otpauthUri', 'period', 'secret']);
      secret = started.body.secret;
      assert.match(secret, /^[A-Z2-7]{32}$/, '160-bit base32 secret');
      assert.equal(started.body.otpauthUri, otpauthUri(secret, adminEmail));
      let row = await mfaRow(admin.userId);
      assert.equal(row.enabledAt, null);
      assert.equal(row.totpSecretEncrypted, null);
      assert.match(row.pendingSecretEncrypted, /^v1:[^:]+:[^:]+:[^:]+$/, 'stored as an AES-GCM envelope');
      assert.ok(!row.pendingSecretEncrypted.includes(secret), 'never in plain text');
      assert.equal((await call('GET', '/auth/mfa/status', { token: firstToken })).body.pending, true);

      const wrong = await call('POST', '/auth/mfa/totp/confirm', { token: firstToken, body: { code: wrongCode(secret) } });
      assert.equal(wrong.status, 403, 'a wrong code inside a session is 403, not 401 (clients sign out on 401)');
      assert.equal(wrong.body.code, 'MFA_CODE_INVALID');
      assert.equal((await call('GET', '/auth/me', { token: firstToken })).status, 200, 'the session survives a wrong code');
      assert.equal((await mfaRow(admin.userId)).enabledAt, null, 'not activated');

      const ok = await call('POST', '/auth/mfa/totp/confirm', { token: firstToken, body: { code: totpAt(secret, Date.now()) }, mobile: true });
      assert.equal(ok.status, 201, ok.text);
      assert.deepEqual(keys(ok.body), ['accessToken', 'refreshExpiresAt', 'refreshToken', 'user'], 'the normal sign-in response');
      assert.equal(claims(ok.body.accessToken).mfa, true);
      row = await mfaRow(admin.userId);
      assert.ok(row.enabledAt);
      assert.equal(row.pendingSecretEncrypted, null);
      assert.equal(row.pendingCreatedAt, null);
      assert.match(row.totpSecretEncrypted, /^v1:/);
      assert.ok(!row.totpSecretEncrypted.includes(secret));
      envelope = row.totpSecretEncrypted;
      secretsAfterConfirm.push({ secret, envelope, from: responses.length });

      const stale = await call('GET', '/auth/me', { token: firstToken });
      assert.equal(stale.status, 401, 'a token issued by a password alone no longer works');
      assert.equal(stale.body.code, 'MFA_REQUIRED');
      assert.equal((await call('POST', '/auth/refresh', { body: { refreshToken: firstRefresh } })).status, 401, 'pre-enrolment refresh sessions are revoked');
      assert.equal((await call('GET', '/auth/me', { token: ok.body.accessToken })).status, 200, 'the fresh two-step session works');
      const again = await call('POST', '/auth/mfa/totp/enrol', { token: ok.body.accessToken });
      assert.equal(again.status, 409);
      const status = await call('GET', '/auth/mfa/status', { token: ok.body.accessToken });
      assert.equal(status.body.enrolled, true);
      assert.ok(!status.text.includes(secret));
      nextStep();
    });

    await test('MFA-03-PASSWORD-ONLY-BLOCKED', async () => {
      const before = await sessionCount(admin.userId);
      for (const mobile of [false, true]) {
        const r = await login(adminEmail, adminPassword, { mobile });
        assert.equal(r.status, 201, r.text);
        assert.deepEqual(keys(r.body), ['challengeExpiresAt', 'challengeToken', 'method', 'mfaRequired']);
        assert.equal(r.body.mfaRequired, true);
        assert.equal(r.body.accessToken, undefined);
        assert.equal(r.body.user, undefined);
        assert.equal(r.body.refreshToken, undefined);
      }
      assert.equal(await sessionCount(admin.userId), before, 'no renewable session is created by the password alone');
      const wrongPassword = await login(adminEmail, 'not-the-password');
      assert.equal(wrongPassword.status, 401, 'a wrong password is still the ordinary 401');
      assert.equal(wrongPassword.body.challengeToken, undefined);
    });

    await test('MFA-04-CODE-COMPLETES', async () => {
      homeIp = freshIp();
      const challenge = (await login(adminEmail, adminPassword, { mobile: true, ip: homeIp })).body.challengeToken;
      const done = await verify(challenge, totpAt(secret, Date.now()), { mobile: true, ip: homeIp });
      assert.equal(done.status, 201, done.text);
      assert.deepEqual(keys(done.body), ['accessToken', 'refreshExpiresAt', 'refreshToken', 'user']);
      assert.deepEqual(keys(done.body.user), ['email', 'id', 'role', 'status']);
      assert.equal(done.body.user.role, 'admin');
      assert.equal(claims(done.body.accessToken).mfa, true);
      assert.equal((await call('GET', '/auth/me', { token: done.body.accessToken })).status, 200);
      assert.equal((await call('GET', '/admin/companies/verification', { token: done.body.accessToken })).status, 200);
      const renewed = await call('POST', '/auth/refresh', { body: { refreshToken: done.body.refreshToken } });
      assert.equal(renewed.status, 201, renewed.text);
      assert.equal(claims(renewed.body.accessToken).mfa, true, 'renewal keeps the two-step claim');
      assert.equal((await call('GET', '/auth/me', { token: renewed.body.accessToken })).status, 200);
      const web = await verify((await login(adminEmail, adminPassword)).body.challengeToken, totpAt(secret, Date.now() + 30_000));
      assert.equal(web.status, 201, 'the next step’s code is accepted (clock drift)');
      assert.deepEqual(keys(web.body), ['accessToken', 'user'], 'web: exactly today’s web response');
    });

    await test('MFA-05-REPLAY-REFUSED', async () => {
      // The last accepted step is now+1; its code, and the current step's code, are both refused.
      for (const code of [totpAt(secret, Date.now() + 30_000), totpAt(secret, Date.now())]) {
        const r = await verify((await login(adminEmail, adminPassword)).body.challengeToken, code, { ip: homeIp });
        assert.equal(r.status, 401, r.text);
        assert.equal(r.body.code, 'MFA_CODE_INVALID');
        assert.equal(r.body.accessToken, undefined);
      }
      const replays = await audits('platform_admin.mfa.code_rejected', admin.userId);
      assert.equal(replays.filter((a: any) => a.afterData.reason === 'replayed_code').length, 2);
      advance(60_000);
    });

    await test('MFA-06-CONCURRENT-SAME-CODE', async () => {
      const [c1, c2] = await Promise.all([login(adminEmail, adminPassword, { ip: homeIp }), login(adminEmail, adminPassword, { ip: homeIp })]);
      const code = totpAt(secret, Date.now());
      const results = await Promise.all([verify(c1.body.challengeToken, code, { ip: homeIp }), verify(c2.body.challengeToken, code, { ip: homeIp })]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 401], 'exactly one sign-in per code');
      nextStep();
    });

    await test('MFA-07-WRONG-CODE-THROTTLED', async () => {
      advance(16 * 60_000); // a fresh failure window; homeIp stays a known source
      const attacker = '203.0.113.7';
      const challenge = (await login(adminEmail, adminPassword, { ip: attacker })).body.challengeToken;
      const rejectedBefore = (await audits('platform_admin.mfa.code_rejected', admin.userId)).length;
      for (let i = 0; i < 5; i += 1) {
        const r = await verify(challenge, wrongCode(secret), { ip: attacker });
        assert.equal(r.status, 401, `attempt ${i + 1}`);
        assert.equal(r.body.code, 'MFA_CODE_INVALID');
      }
      const held = await verify(challenge, totpAt(secret, Date.now()), { ip: attacker });
      assert.equal(held.status, 429, 'the 6th attempt from that source is refused, even with the right code');
      assert.match(held.body.message, /Too many unsuccessful authentication codes/);
      const rejected = await audits('platform_admin.mfa.code_rejected', admin.userId);
      assert.equal(rejected.length - rejectedBefore, 5, 'every wrong code is audited');
      assert.ok(rejected.slice(rejectedBefore).every((a: any) => a.afterData.reason === 'wrong_code' && a.ipAddress === attacker));
      const other = await verify((await login(adminEmail, adminPassword, { ip: homeIp })).body.challengeToken, totpAt(secret, Date.now()), { ip: homeIp });
      assert.equal(other.status, 201, 'another source is not held by that source’s failures');
      nextStep();

      // Distributed guessing: 10 failures from 10 new sources hold every NEW source, never a known one.
      advance(16 * 60_000);
      const spray = (await login(adminEmail, adminPassword, { ip: '203.0.113.100' })).body.challengeToken;
      for (let i = 0; i < 10; i += 1) assert.equal((await verify(spray, wrongCode(secret), { ip: `203.0.113.${110 + i}` })).status, 401);
      assert.equal((await verify(spray, totpAt(secret, Date.now()), { ip: '203.0.113.200' })).status, 429, 'a new source is held');
      const home = await verify((await login(adminEmail, adminPassword, { ip: homeIp })).body.challengeToken, totpAt(secret, Date.now()), { ip: homeIp });
      assert.equal(home.status, 201, 'the admin is not locked out from a source they have signed in from');
      nextStep();
      advance(16 * 60_000);
    });

    await test('MFA-08-CHALLENGE-NOT-A-SESSION', async () => {
      const challenge = (await login(adminEmail, adminPassword)).body.challengeToken;
      for (const path of ['/auth/me', '/admin/companies/verification', '/auth/mfa/status']) {
        assert.equal((await call('GET', path, { token: challenge })).status, 401, `${path} refuses a challenge token`);
      }
      assert.equal((await call('POST', '/auth/mfa/totp/disable', { token: challenge, body: { code: '123456' } })).status, 401);
      const session = await verify(challenge, totpAt(secret, Date.now()), { ip: homeIp });
      assert.equal(session.status, 201);
      const asChallenge = await verify(session.body.accessToken, totpAt(secret, Date.now() + 30_000), { ip: homeIp });
      assert.equal(asChallenge.status, 401, 'an access token is not a challenge');
      assert.equal(asChallenge.body.code, 'MFA_CHALLENGE_INVALID');
      const forged = jwt.sign({ sub: admin.userId, purpose: 'admin_mfa_challenge' }, JWT_SECRET, { expiresIn: 300 });
      assert.equal((await verify(forged, totpAt(secret, Date.now() + 30_000), { ip: homeIp })).status, 401, 'signed with JWT_SECRET: refused');
      assert.equal((await call('GET', '/auth/me', { token: forged })).status, 401, 'a purpose token is never a session');
      assert.equal((await verify('x'.repeat(40), '123456', { ip: homeIp })).status, 401);
      assert.equal((await call('POST', '/auth/mfa/verify', { body: { code: '123456' }, ip: homeIp })).status, 401, 'no challenge');
      nextStep();
    });

    await test('MFA-09-CHALLENGE-EXPIRES', async () => {
      const challenge = (await login(adminEmail, adminPassword, { ip: homeIp })).body.challengeToken;
      assert.ok(claims(challenge).exp - claims(challenge).iat === 300, 'a 5-minute challenge');
      advance(5 * 60_000 + 1_000);
      const late = await verify(challenge, totpAt(secret, Date.now()), { ip: homeIp });
      assert.equal(late.status, 401, late.text);
      assert.equal(late.body.code, 'MFA_CHALLENGE_INVALID');
      assert.equal(late.body.accessToken, undefined);
    });

    // ════════════════ flag on ════════════════
    let admin2Secret = '';
    await test('MFA-10-FLAG-FORCES-ENROLMENT', async () => {
      const before = await login(admin2Email, admin2Password, { mobile: true });
      assert.equal(before.status, 201);
      assert.ok(before.body.accessToken, 'flag off: an unenrolled admin signs in as before');
      process.env.PLATFORM_ADMIN_MFA_REQUIRED = 'true';

      const oldToken = await call('GET', '/auth/me', { token: before.body.accessToken });
      assert.equal(oldToken.status, 401);
      assert.equal(oldToken.body.code, 'MFA_ENROLLMENT_REQUIRED');
      assert.equal((await call('GET', '/admin/companies/verification', { token: before.body.accessToken })).status, 401);
      assert.equal((await call('POST', '/auth/refresh', { body: { refreshToken: before.body.refreshToken } })).status, 401, 'no renewal without enrolling');

      const r = await login(admin2Email, admin2Password, { mobile: true });
      assert.equal(r.status, 201, r.text);
      assert.deepEqual(keys(r.body), ['enrollmentExpiresAt', 'enrollmentToken', 'mfaEnrollmentRequired']);
      const enrolment = r.body.enrollmentToken;
      assert.equal(claims(enrolment).exp - claims(enrolment).iat, 900, 'a 15-minute enrolment token');
      for (const [method, path] of [['GET', '/auth/me'], ['GET', '/admin/companies/verification'], ['GET', '/companies'], ['GET', '/audit-logs']] as const) {
        assert.equal((await call(method, path, { token: enrolment })).status, 401, `${path} refuses the enrolment token`);
      }
      assert.equal((await call('POST', '/auth/mfa/totp/disable', { token: enrolment, body: { code: '123456' } })).status, 401);
      assert.equal((await verify(enrolment, '123456')).status, 401, 'an enrolment token is not a challenge');
      const status = await call('GET', '/auth/mfa/status', { token: enrolment });
      assert.equal(status.status, 200, status.text);
      assert.deepEqual(status.body, { enrolled: false, enabledAt: null, pending: false, required: true, method: 'totp' });
      const started = await call('POST', '/auth/mfa/totp/enrol', { token: enrolment });
      assert.equal(started.status, 200, started.text);
      admin2Secret = started.body.secret;
      const done = await call('POST', '/auth/mfa/totp/confirm', { token: enrolment, body: { code: totpAt(admin2Secret, Date.now()) }, mobile: true });
      assert.equal(done.status, 201, done.text);
      assert.deepEqual(keys(done.body), ['accessToken', 'refreshExpiresAt', 'refreshToken', 'user']);
      secretsAfterConfirm.push({ secret: admin2Secret, envelope: (await mfaRow(admin2Id)).totpSecretEncrypted, from: responses.length });
      assert.equal((await call('GET', '/admin/companies/verification', { token: done.body.accessToken })).status, 200, 'enrolled: a full session');
      const off = await call('POST', '/auth/mfa/totp/disable', { token: done.body.accessToken, body: { code: totpAt(admin2Secret, Date.now() + 30_000) } });
      assert.equal(off.status, 403, 'cannot be turned off while required');
      assert.equal(off.body.code, 'MFA_REQUIRED_BY_POLICY');
      assert.ok(await mfaRow(admin2Id), 'still enrolled');
      // An enrolled admin under the flag signs in with the code as usual.
      nextStep();
      const c = (await login(admin2Email, admin2Password)).body;
      assert.equal(c.mfaRequired, true);
      assert.equal((await verify(c.challengeToken, totpAt(admin2Secret, Date.now()))).status, 201);
      nextStep();
    });

    await test('MFA-11-NON-ADMIN-UNAFFECTED', async () => {
      assert.equal(process.env.PLATFORM_ADMIN_MFA_REQUIRED, 'true', 'checked with the flag on');
      for (const email of [guardEmail, ownerEmail]) {
        const web = await login(email, otherPassword);
        assert.equal(web.status, 201, web.text);
        assert.deepEqual({ body: keys(web.body), user: keys(web.body.user), claims: keys(claims(web.body.accessToken)) }, baseline[email], 'exactly the flag-off response and token payload');
        assert.equal(claims(web.body.accessToken).mfa, undefined);
        const mobile = await login(email, otherPassword, { mobile: true });
        assert.deepEqual(keys(mobile.body), ['accessToken', 'refreshExpiresAt', 'refreshToken', 'user']);
        assert.equal((await call('GET', '/auth/me', { token: mobile.body.accessToken })).status, 200);
        const renewed = await call('POST', '/auth/refresh', { body: { refreshToken: mobile.body.refreshToken } });
        assert.equal(renewed.status, 201);
        assert.equal(claims(renewed.body.accessToken).mfa, undefined);
        assert.equal((await call('GET', '/auth/me', { token: renewed.body.accessToken })).status, 200);
        for (const path of ['/auth/mfa/totp/enrol', '/auth/mfa/totp/confirm', '/auth/mfa/totp/disable']) {
          assert.equal((await call('POST', path, { token: web.body.accessToken, body: { code: '123456' } })).status, 403, `${email} ${path}`);
        }
        assert.equal((await call('GET', '/auth/mfa/status', { token: web.body.accessToken })).status, 403);
      }
      const cl = await call('POST', '/auth/client-login', { body: { email: clientEmail, password: otherPassword } });
      assert.equal(cl.status, 201, cl.text);
      assert.deepEqual({ body: keys(cl.body), user: keys(cl.body.user ?? {}), claims: keys(claims(cl.body.accessToken)) }, baseline[clientEmail]);
      assert.equal(claims(cl.body.accessToken).mfa, undefined);
      // The client-portal token is accepted (authenticated) and refused only by role.
      assert.equal((await call('GET', '/auth/mfa/status', { token: cl.body.accessToken })).status, 403);
      const rows = await q(`SELECT "userId" FROM platform_admin_mfa ORDER BY 1`);
      assert.deepEqual(rows.map((r: any) => r.userId), [admin.userId, admin2Id].sort((a, b) => a - b), 'only Platform Admins have rows');
      assert.ok(rows.every((r: any) => ![guardId, ownerId].includes(r.userId)));
    });

    // ════════════════ flag off again ════════════════
    await test('MFA-12-DISABLE', async () => {
      delete process.env.PLATFORM_ADMIN_MFA_REQUIRED;
      const s = await verify((await login(adminEmail, adminPassword, { ip: homeIp })).body.challengeToken, totpAt(secret, Date.now()), { ip: homeIp });
      assert.equal(s.status, 201);
      nextStep();
      const wrong = await call('POST', '/auth/mfa/totp/disable', { token: s.body.accessToken, body: { code: wrongCode(secret) }, ip: homeIp });
      assert.equal(wrong.status, 403);
      assert.equal(wrong.body.code, 'MFA_CODE_INVALID');
      assert.ok(await mfaRow(admin.userId), 'still enrolled');
      const off = await call('POST', '/auth/mfa/totp/disable', { token: s.body.accessToken, body: { code: totpAt(secret, Date.now()) }, ip: homeIp });
      assert.equal(off.status, 200, off.text);
      assert.deepEqual(off.body, { enrolled: false });
      assert.equal(await mfaRow(admin.userId), null);
      const direct = await login(adminEmail, adminPassword);
      assert.deepEqual(keys(direct.body), ['accessToken', 'user'], 'the password signs in directly again');
      assert.equal((await call('GET', '/auth/me', { token: direct.body.accessToken })).status, 200);
    });

    await test('MFA-13-RECOVERY', async () => {
      assert.ok((await mfaRow(admin2Id))?.enabledAt, 'admin two is enrolled');
      process.env.PLATFORM_ADMIN_MFA_REQUIRED = 'true';
      admin2Password = newPassword();
      const result = await operator.recover(admin2Email, admin2Password, true);
      assert.equal(result.mfaReset, true);
      assert.equal(await mfaRow(admin2Id), null, 'two-step verification reset');
      // The operator acts as SYSTEM_OPERATOR (no user); the row names the admin as its entity.
      const [rec] = await q(`SELECT "afterData" FROM audit_logs WHERE action = 'platform_admin.recovered' AND "entityId" = $1 ORDER BY id DESC LIMIT 1`, [admin2Id]);
      assert.equal(rec.afterData.mfaReset, true);
      assert.equal(rec.afterData.actorType, 'SYSTEM_OPERATOR');
      const flagged = await login(admin2Email, admin2Password);
      assert.deepEqual(keys(flagged.body), ['enrollmentExpiresAt', 'enrollmentToken', 'mfaEnrollmentRequired'], 'flag on: straight to enrolment');
      delete process.env.PLATFORM_ADMIN_MFA_REQUIRED;
      const direct = await login(admin2Email, admin2Password);
      assert.deepEqual(keys(direct.body), ['accessToken', 'user'], 'flag off: a session');
    });

    await test('MFA-14-SECRET-NEVER-EXPOSED', async () => {
      for (const { secret: s, envelope: e, from } of secretsAfterConfirm) {
        const leaked = responses.slice(from).filter((text) => text.includes(s) || text.includes(e));
        assert.deepEqual(leaked, [], 'no response after confirmation carries the secret or its envelope');
      }
      const rows = JSON.stringify(await q(`SELECT * FROM audit_logs WHERE action LIKE 'platform_admin.%'`));
      for (const { secret: s, envelope: e } of secretsAfterConfirm) {
        assert.ok(!rows.includes(s) && !rows.includes(e), 'no audit row carries a secret or envelope');
      }
      assert.ok(!/secret|otpauth|challengeToken|enrollmentToken|accessToken|"code"/i.test(rows), 'no audit row carries a secret, URI, token or code');
    });

    await test('MFA-15-AUDITED', async () => {
      for (const action of ['enrolment_started', 'enabled', 'sign_in_verified', 'code_rejected', 'disabled']) {
        const rows = await audits(`platform_admin.mfa.${action}`, admin.userId);
        assert.ok(rows.length > 0, `${action} is audited`);
        assert.ok(rows.every((r: any) => r.userId === admin.userId && r.afterData.adminUserId === admin.userId && r.afterData.method === 'totp' && r.ipAddress));
      }
      assert.equal((await audits('platform_admin.mfa.enabled', admin2Id)).length, 1);
    });
  } finally {
    Date.now = realNow;
    delete process.env.PLATFORM_ADMIN_MFA_REQUIRED;
    await app.close();
  }

  console.log(JSON.stringify({ event: 'platform_admin_mfa_certified', passed }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
