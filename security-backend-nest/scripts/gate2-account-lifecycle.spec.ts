/**
 * S4 Pilot Gate 2 certification — account deletion, password reset, email verification, and the auth
 * properties they must not weaken.
 *
 * Boots the REAL application (AppModule, the production ValidationPipe, JwtStrategy, throttling) against a
 * real PostgreSQL schema built by the repository's own migrations — not synchronize — and drives it over
 * HTTP. Email is captured by the transactional email service's development outbox, which is the only way
 * a test can read a token: nothing is sent anywhere and no API response ever carries one.
 *
 * Every line the application logs during the run is captured and checked for plaintext tokens.
 *
 * Needs GATE2_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { INestApplication, LoggerService, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { DataSource, Repository } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.GATE2_DATABASE_URL;
if (!url) throw new Error('GATE2_DATABASE_URL is required (use a disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw new Error('GATE2_DATABASE_URL must point at a local disposable database');
}

const JWT_SECRET = 'gate2-certification-only-secret-not-for-production';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = url;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.JWT_SECRET = JWT_SECRET;
// The development outbox is the transport under test; make sure a stray key cannot select Resend.
delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_FROM;
delete process.env.SENTRY_DSN;
delete process.env.S4_WEB_APP_URL;
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

// ── log capture ──────────────────────────────────────────────────────────────────────────────────────
const captured: string[] = [];
const record = (...parts: unknown[]) => captured.push(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '));
const captureLogger: LoggerService = {
  log: record, error: record, warn: record, debug: record, verbose: record, fatal: record,
};
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => { record(...args); original(...args); };
}

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
let ipCounter = 0;
/** A fresh client address per call unless one is given, so per-IP throttles only bite where intended. */
const freshIp = () => `198.51.100.${(ipCounter = (ipCounter % 250) + 1)}, 10.0.0.${ipCounter}`;

async function main() {
  // ── schema from the repository's migrations ──────────────────────────────────────────────────────────
  const migrationsGlob = require('node:path').join(__dirname, '..', 'src', 'database', 'migrations', '*.ts');
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: true,
    migrations: [migrationsGlob], migrationsTableName: 'typeorm_migrations', logging: false,
  });
  await ds.initialize();
  const applied = await ds.runMigrations({ transaction: 'each' });
  assert.equal(applied[applied.length - 1]?.name, 'AddAccountLifecycleAndVerificationTokens1720900000007');

  const { User, UserRole, UserStatus } = await import('../src/user/entities/user.entity');
  const { GuardProfile } = await import('../src/guard-profile/entities/guard-profile.entity');
  const { Company } = await import('../src/company/entities/company.entity');
  const { Site } = await import('../src/site/entities/site.entity');
  const { Shift } = await import('../src/shift/entities/shift.entity');
  const { AttendanceEvent, AttendanceEventType } = await import('../src/attendance/entities/attendance.entity');
  const { DailyLog } = await import('../src/daily-log/entities/daily-log.entity');
  const { Incident, IncidentSeverity, IncidentStatus } = await import('../src/incident/entities/incident.entity');
  const { SafetyAlert, SafetyAlertPriority, SafetyAlertStatus, SafetyAlertType } = await import('../src/safety-alert/entities/safety-alert.entity');
  const { AuditLog } = await import('../src/audit-log/entities/audit-log.entity');
  const { AuthSession } = await import('../src/auth/entities/auth-session.entity');
  const { CompanyGuard } = await import('../src/company-guard/entities/company-guard.entity');
  const { UserVerificationToken } = await import('../src/auth/entities/user-verification-token.entity');
  const { AppModule } = await import('../src/app.module');
  const { TransactionalEmailService } = await import('../src/email/transactional-email.service');
  const { AccountDeletionService, deletedAccountEmail } = await import('../src/auth/account-deletion.service');
  const { UserService } = await import('../src/user/user.service');
  const { AdminOperatorService } = await import('../src/admin-operator/admin-operator.service');
  const { DELETED_ACCOUNT_PASSWORD_SENTINEL } = await import('../src/auth/password-policy');
  const { FORGOT_PASSWORD_RESPONSE, RESEND_VERIFICATION_RESPONSE, INVALID_RESET_LINK, INVALID_VERIFICATION_LINK } =
    await import('../src/auth/account-recovery.service');

  const repo = <T extends object>(entity: new () => T): Repository<T> => ds.getRepository(entity);

  // ── the real application ─────────────────────────────────────────────────────────────────────────────
  const app: INestApplication = await NestFactory.create(AppModule, { logger: captureLogger });
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  // Exactly the pipe main.ts installs.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const base = `http://127.0.0.1:${address.port}`;
  const outbox = app.get(TransactionalEmailService);
  const allTokens = new Set<string>();

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

  /** The token inside the most recent captured email of a kind for an address, and its link. */
  function lastLink(kind: 'password_reset' | 'email_verification', to: string) {
    const message = [...outbox.capturedMessages()].reverse().find((m) => m.kind === kind && m.to === to);
    if (!message) return null;
    const link = /https:\/\/[^\s"<]+\?token=([A-Za-z0-9_-]+)/.exec(message.text);
    assert.ok(link, 'the email carries a link');
    allTokens.add(link[1]);
    return { url: link[0], token: link[1], message };
  }
  const sentTo = (kind: string, to: string) => outbox.capturedMessages().filter((m) => m.kind === kind && m.to === to).length;
  const tokensFor = (userId: number, purpose: string) =>
    repo(UserVerificationToken).find({ where: { userId, purpose: purpose as never }, order: { id: 'ASC' } });
  /** Pretend every token for this user was issued long enough ago that the per-account limit allows another. */
  const ageTokens = (userId: number) =>
    ds.query(`UPDATE user_verification_tokens SET "createdAt" = now() - interval '2 hours' WHERE "userId" = $1`, [userId]);
  const userRow = (id: number) =>
    repo(User).createQueryBuilder('u').addSelect('u.passwordHash').where('u.id = :id', { id }).getOneOrFail();

  let seq = 0;
  const guardRegistration = (email: string) => ({
    email, password: 'Gate2-pass-1', role: 'guard',
    fullName: 'Gate Two Guard', phone: '07700900123', siaLicenseNumber: String(7400000000000000 + (seq += 1)),
  });

  /** Register through the API and verify through the emailed link: a normal, fully verified account. */
  async function verifiedGuard(email: string) {
    const reg = await call('POST', '/auth/register', guardRegistration(email));
    assert.equal(reg.status, 201, reg.text);
    const link = lastLink('email_verification', email)!;
    const verified = await call('POST', '/auth/verify-email', { token: link.token });
    assert.equal(verified.status, 200, verified.text);
    const user = await repo(User).findOneByOrFail({ email });
    return user;
  }
  async function mobileLogin(email: string, password: string) {
    const r = await call('POST', '/auth/login', { email, password }, { 'x-s4-client': 'mobile' });
    assert.equal(r.status, 201, r.text);
    assert.ok(r.body.refreshToken);
    allTokens.add(r.body.refreshToken);
    return r.body as { accessToken: string; refreshToken: string };
  }

  try {
    // ═══════════════════════════════════ EMAIL-VERIFY ═══════════════════════════════════════════════
    const newEmail = 'gate2.new.guard@example.invalid';
    const registered = await call('POST', '/auth/register', guardRegistration(newEmail));
    const newUser = await repo(User).findOneByOrFail({ email: newEmail });

    await test('EMAIL-VERIFY-01-NEW-SELF-REGISTRATION-REQUIRES-VERIFICATION', async () => {
      assert.equal(registered.status, 201, registered.text);
      assert.equal(registered.body.verificationRequired, true);
      assert.equal(registered.body.accessToken, undefined, 'registration must not issue a session');
      assert.equal(registered.body.refreshToken, undefined);
      assert.equal(newUser.emailVerificationRequired, true, 'new accounts default to required');
      assert.equal(newUser.isEmailVerified, false);
      assert.equal(newUser.status, UserStatus.ACTIVE, 'account status is unchanged by verification');
      const link = lastLink('email_verification', newEmail)!;
      assert.ok(link.url.startsWith('https://app.sfour.co.uk/verify-email?token='), link.url);
      assert.match(link.message.subject, /\bS4\b/);
      assert.doesNotMatch(link.message.text + link.message.html, /S4 Security|S4 Guard|Security Marketplace|securitymarketplace:\/\//);
      const [row] = await tokensFor(newUser.id, 'email_verification');
      assert.equal(row.tokenHash, sha(link.token), 'only the SHA-256 of the token is stored');
      assert.ok(!JSON.stringify(await repo(UserVerificationToken).find()).includes(link.token), 'plaintext never stored');
    });

    await test('EMAIL-VERIFY-02-LOGIN-BLOCKED-BEFORE-VERIFICATION', async () => {
      const r = await call('POST', '/auth/login', { email: newEmail, password: 'Gate2-pass-1' }, { 'x-s4-client': 'mobile' });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'EMAIL_VERIFICATION_REQUIRED');
      assert.equal(r.body.accessToken, undefined);
      assert.equal(await repo(AuthSession).count({ where: { user: { id: newUser.id } } }), 0, 'no session created');
      const wrong = await call('POST', '/auth/login', { email: newEmail, password: 'not-the-password' });
      assert.equal(wrong.status, 401, 'a wrong password still reads as invalid credentials, not "unverified"');
      // Even a correctly signed token for an unverified account is refused by the strategy.
      const forged = new JwtService({ secret: JWT_SECRET }).sign({ sub: newUser.id, email: newEmail, role: 'guard', status: 'active', principalType: 'user' });
      assert.equal((await call('GET', '/auth/me', undefined, bearer(forged))).status, 401);
    });

    await test('EMAIL-VERIFY-03-RESEND-IS-RATE-LIMITED-AND-GENERIC', async () => {
      const before = (await tokensFor(newUser.id, 'email_verification')).length;
      const immediate = await call('POST', '/auth/resend-verification', { email: newEmail });
      const unknown = await call('POST', '/auth/resend-verification', { email: 'nobody.at.all@example.invalid' });
      assert.equal(immediate.status, 202);
      assert.deepEqual(immediate.body, RESEND_VERIFICATION_RESPONSE);
      assert.equal(unknown.status, immediate.status, 'unknown address: same status');
      assert.equal(unknown.text, immediate.text, 'unknown address: byte-identical body');
      assert.equal((await tokensFor(newUser.id, 'email_verification')).length, before, 'a resend inside a minute issues nothing');
    });

    const firstVerification = lastLink('email_verification', newEmail)!;
    await ageTokens(newUser.id);
    const resent = await call('POST', '/auth/resend-verification', { email: newEmail });
    const secondVerification = lastLink('email_verification', newEmail)!;

    await test('EMAIL-VERIFY-04-RESEND-SUPERSEDES-THE-PREVIOUS-TOKEN', async () => {
      assert.equal(resent.status, 202);
      assert.notEqual(secondVerification.token, firstVerification.token);
      const rows = await tokensFor(newUser.id, 'email_verification');
      assert.ok(rows[0].invalidatedAt, 'the earlier token is invalidated');
      assert.equal(rows[rows.length - 1].invalidatedAt, null);
      const old = await call('POST', '/auth/verify-email', { token: firstVerification.token });
      assert.equal(old.status, 400);
      assert.equal(old.body.message, INVALID_VERIFICATION_LINK);
    });

    await test('EMAIL-VERIFY-05-EXPIRED-TOKEN-REJECTED', async () => {
      await ageTokens(newUser.id);
      await call('POST', '/auth/resend-verification', { email: newEmail });
      const expiring = lastLink('email_verification', newEmail)!;
      await ds.query(`UPDATE user_verification_tokens SET "expiresAt" = now() - interval '1 second' WHERE "tokenHash" = $1`, [sha(expiring.token)]);
      const r = await call('POST', '/auth/verify-email', { token: expiring.token });
      assert.equal(r.status, 400);
      assert.equal(r.body.message, INVALID_VERIFICATION_LINK, 'expired reads exactly like unknown');
      assert.equal((await repo(User).findOneByOrFail({ id: newUser.id })).isEmailVerified, false);
    });

    await ageTokens(newUser.id);
    await call('POST', '/auth/resend-verification', { email: newEmail });
    const valid = lastLink('email_verification', newEmail)!;

    await test('EMAIL-VERIFY-06-VALID-VERIFICATION-SUCCEEDS-THEN-LOGIN-WORKS', async () => {
      const r = await call('POST', '/auth/verify-email', { token: valid.token });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.emailVerified, true);
      const user = await repo(User).findOneByOrFail({ id: newUser.id });
      assert.equal(user.isEmailVerified, true);
      assert.equal(user.emailVerificationRequired, true, 'the requirement stays recorded; it is now met');
      const login = await call('POST', '/auth/login', { email: newEmail, password: 'Gate2-pass-1' });
      assert.equal(login.status, 201, login.text);
      assert.ok(login.body.accessToken);
      assert.equal((await call('GET', '/auth/me', undefined, bearer(login.body.accessToken))).status, 200);
    });

    await test('EMAIL-VERIFY-07-TOKEN-IS-SINGLE-USE', async () => {
      const again = await call('POST', '/auth/verify-email', { token: valid.token });
      assert.equal(again.status, 400);
      assert.equal(again.body.message, INVALID_VERIFICATION_LINK);
      const garbage = await call('POST', '/auth/verify-email', { token: 'x'.repeat(43) });
      assert.equal(garbage.text, again.text, 'used and unknown tokens are indistinguishable');
    });

    await test('EMAIL-VERIFY-08-VERIFIED-ACCOUNT-RESEND-SENDS-NOTHING', async () => {
      await ageTokens(newUser.id);
      const count = sentTo('email_verification', newEmail);
      const r = await call('POST', '/auth/resend-verification', { email: newEmail });
      assert.deepEqual(r.body, RESEND_VERIFICATION_RESPONSE);
      assert.equal(sentTo('email_verification', newEmail), count);
    });

    // A grandfathered account: exactly what Migration 61 leaves an existing row looking like — required
    // false, and isEmailVerified untouched (false here, as many legacy rows are).
    const legacy = await repo(User).save(repo(User).create({
      email: 'gate2.legacy@example.invalid', passwordHash: await bcrypt.hash('Legacy-pass-1', 4),
      role: UserRole.GUARD, status: UserStatus.ACTIVE, isEmailVerified: false, emailVerificationRequired: false,
    }));
    await test('EMAIL-VERIFY-09-GRANDFATHERED-ACCOUNT-STILL-WORKS', async () => {
      const r = await call('POST', '/auth/login', { email: legacy.email, password: 'Legacy-pass-1' }, { 'x-s4-client': 'mobile' });
      assert.equal(r.status, 201, r.text);
      assert.equal((await call('GET', '/auth/me', undefined, bearer(r.body.accessToken))).status, 200);
      const refreshed = await call('POST', '/auth/refresh', { refreshToken: r.body.refreshToken });
      assert.equal(refreshed.status, 201, 'refresh keeps working');
      allTokens.add(refreshed.body.refreshToken);
      assert.equal((await repo(User).findOneByOrFail({ id: legacy.id })).isEmailVerified, false, 'never mass-changed');
    });

    await test('EMAIL-VERIFY-10-ADMIN-OPERATOR-COMPATIBLE', async () => {
      const operator = new AdminOperatorService(ds);
      const created = await operator.bootstrap('gate2.admin@example.invalid', 'Gate2-Admin!Pass9');
      const admin = await repo(User).findOneByOrFail({ id: created.userId });
      assert.equal(admin.emailVerificationRequired, true, 'a new row gets the new default');
      assert.equal(admin.isEmailVerified, true, 'the trusted operator path establishes the address');
      const r = await call('POST', '/auth/login', { email: admin.email, password: 'Gate2-Admin!Pass9' });
      assert.equal(r.status, 201, r.text);
    });

    // ═══════════════════════════════════ PASSWORD-RESET ═════════════════════════════════════════════
    const resetEmail = 'gate2.reset@example.invalid';
    const resetUser = await verifiedGuard(resetEmail);
    const mobileBefore = await mobileLogin(resetEmail, 'Gate2-pass-1');
    const webBefore = (await call('POST', '/auth/login', { email: resetEmail, password: 'Gate2-pass-1' })).body.accessToken as string;

    const knownForgot = await call('POST', '/auth/forgot-password', { email: resetEmail });
    const unknownForgot = await call('POST', '/auth/forgot-password', { email: 'nobody.here@example.invalid' });
    const firstReset = lastLink('password_reset', resetEmail)!;

    await test('PASSWORD-RESET-01-GENERIC-RESPONSE-NO-ENUMERATION', async () => {
      assert.equal(knownForgot.status, 202);
      assert.deepEqual(knownForgot.body, FORGOT_PASSWORD_RESPONSE);
      assert.equal(unknownForgot.status, knownForgot.status);
      assert.equal(unknownForgot.text, knownForgot.text, 'byte-identical for an unknown address');
      assert.ok(!knownForgot.text.includes(firstReset.token), 'the token is never in a response');
      assert.equal(outbox.capturedMessages().filter((m) => m.to === 'nobody.here@example.invalid').length, 0);
    });

    await test('PASSWORD-RESET-02-EXISTING-ACCOUNT-GETS-AN-S4-LINK', async () => {
      assert.ok(firstReset.url.startsWith('https://app.sfour.co.uk/reset-password?token='), firstReset.url);
      assert.doesNotMatch(firstReset.message.text + firstReset.message.html, /securitymarketplace:\/\/|S4 Security|S4 Guard|Security Marketplace/);
      assert.equal(firstReset.message.subject, 'Reset your S4 password');
    });

    await test('PASSWORD-RESET-03-HASHED-TOKEN-ONLY-WITH-30-MINUTE-EXPIRY', async () => {
      const [row] = await tokensFor(resetUser.id, 'password_reset');
      assert.equal(row.purpose, 'password_reset');
      assert.equal(row.tokenHash, sha(firstReset.token));
      assert.ok(!JSON.stringify(row).includes(firstReset.token));
      const ttl = row.expiresAt.getTime() - row.createdAt.getTime();
      assert.ok(Math.abs(ttl - 30 * 60_000) < 5_000, `expiry is 30 minutes (was ${ttl}ms)`);
      assert.ok(firstReset.token.length >= 43, '>= 256 bits of entropy');
    });

    await test('PASSWORD-RESET-04-PER-ACCOUNT-ISSUING-LIMIT-IS-SILENT', async () => {
      const again = await call('POST', '/auth/forgot-password', { email: resetEmail });
      assert.equal(again.text, knownForgot.text);
      assert.equal((await tokensFor(resetUser.id, 'password_reset')).length, 1, 'no second token inside a minute');
    });

    await test('PASSWORD-RESET-05-PER-IP-THROTTLE', async () => {
      const ip = { 'x-forwarded-for': '203.0.113.77' };
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push((await call('POST', '/auth/forgot-password', { email: `probe${i}@example.invalid` }, ip)).status);
      }
      assert.deepEqual(statuses.slice(0, 5), [202, 202, 202, 202, 202]);
      assert.equal(statuses[5], 429, 'the sixth request in a minute from one address is throttled');
    });

    await ageTokens(resetUser.id);
    await call('POST', '/auth/forgot-password', { email: resetEmail });
    const secondReset = lastLink('password_reset', resetEmail)!;

    await test('PASSWORD-RESET-06-SUPERSEDED-TOKEN-REJECTED', async () => {
      const rows = await tokensFor(resetUser.id, 'password_reset');
      assert.equal(rows.length, 2);
      assert.ok(rows[0].invalidatedAt, 'reissue invalidates the earlier link');
      const r = await call('POST', '/auth/reset-password', { token: firstReset.token, newPassword: 'Never-used-1' });
      assert.equal(r.status, 400);
      assert.equal(r.body.message, INVALID_RESET_LINK);
    });

    await test('PASSWORD-RESET-07-EXPIRED-TOKEN-REJECTED', async () => {
      await ageTokens(resetUser.id);
      await call('POST', '/auth/forgot-password', { email: resetEmail });
      const expiring = lastLink('password_reset', resetEmail)!;
      await ds.query(`UPDATE user_verification_tokens SET "expiresAt" = now() - interval '1 second' WHERE "tokenHash" = $1`, [sha(expiring.token)]);
      const r = await call('POST', '/auth/reset-password', { token: expiring.token, newPassword: 'Never-used-2' });
      assert.equal(r.status, 400);
      assert.equal(r.body.message, INVALID_RESET_LINK);
    });

    await test('PASSWORD-RESET-08-WEAK-PASSWORD-REJECTED-TOKEN-KEPT', async () => {
      await ageTokens(resetUser.id);
      await call('POST', '/auth/forgot-password', { email: resetEmail });
      const link = lastLink('password_reset', resetEmail)!;
      const weak = await call('POST', '/auth/reset-password', { token: link.token, newPassword: '12345' });
      assert.equal(weak.status, 400);
      assert.ok(!weak.text.includes(link.token), 'the validation error never echoes the token');
      const row = await repo(UserVerificationToken).findOneByOrFail({ tokenHash: sha(link.token) });
      assert.equal(row.usedAt, null, 'a refused password does not spend the link');
    });

    const liveReset = lastLink('password_reset', resetEmail)!;
    // iat has one-second precision: make sure the pre-reset tokens are from an earlier second.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const resetReply = await call('POST', '/auth/reset-password', { token: liveReset.token, newPassword: 'Brand-new-pass-7' });

    await test('PASSWORD-RESET-09-PASSWORD-CHANGED', async () => {
      assert.equal(resetReply.status, 200, resetReply.text);
      assert.equal(resetReply.body.passwordReset, true);
      assert.equal((await call('POST', '/auth/login', { email: resetEmail, password: 'Gate2-pass-1' })).status, 401, 'old password dead');
      const fresh = await call('POST', '/auth/login', { email: resetEmail, password: 'Brand-new-pass-7' });
      assert.equal(fresh.status, 201, 'new password works');
      assert.equal((await call('GET', '/auth/me', undefined, bearer(fresh.body.accessToken))).status, 200, 'a post-reset session works');
      const stored = await userRow(resetUser.id);
      assert.match(stored.passwordHash, /^\$2[aby]\$10\$/, 'bcrypt');
    });

    await test('PASSWORD-RESET-10-ALL-SESSIONS-REVOKED', async () => {
      const sessions = await repo(AuthSession).find({ where: { user: { id: resetUser.id } } });
      assert.ok(sessions.length >= 1);
      assert.ok(sessions.every((s) => s.revokedAt), 'every refresh session revoked');
      assert.ok(sessions.some((s) => s.revokedReason === 'password_change'));
      assert.equal((await call('POST', '/auth/refresh', { refreshToken: mobileBefore.refreshToken })).status, 401, 'mobile must sign in again');
      assert.equal((await call('GET', '/auth/me', undefined, bearer(mobileBefore.accessToken))).status, 401, 'pre-reset mobile access token refused');
      assert.equal((await call('GET', '/auth/me', undefined, bearer(webBefore))).status, 401, 'pre-reset web access token refused');
    });

    await test('PASSWORD-RESET-11-SINGLE-USE-REPLAY-REJECTED', async () => {
      const replay = await call('POST', '/auth/reset-password', { token: liveReset.token, newPassword: 'Replay-attempt-9' });
      assert.equal(replay.status, 400);
      assert.equal(replay.body.message, INVALID_RESET_LINK);
      assert.equal((await call('POST', '/auth/login', { email: resetEmail, password: 'Replay-attempt-9' })).status, 401);
      const rows = await tokensFor(resetUser.id, 'password_reset');
      assert.equal(rows.filter((r) => r.usedAt).length, 1, 'exactly one reset token was ever spent');
      assert.ok(rows.filter((r) => !r.usedAt).every((r) => r.invalidatedAt), 'all others are invalidated');
    });

    await test('PASSWORD-RESET-12-CONCURRENT-USE-SPENDS-ONCE', async () => {
      await ageTokens(resetUser.id);
      await call('POST', '/auth/forgot-password', { email: resetEmail });
      const link = lastLink('password_reset', resetEmail)!;
      const [a, b] = await Promise.all([
        call('POST', '/auth/reset-password', { token: link.token, newPassword: 'Race-pass-A1' }),
        call('POST', '/auth/reset-password', { token: link.token, newPassword: 'Race-pass-B2' }),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [200, 400], 'one wins, one is refused');
    });

    await test('PASSWORD-RESET-13-RESET-PROVES-ADDRESS-FOR-UNVERIFIED-ACCOUNT', async () => {
      const email = 'gate2.unverified.reset@example.invalid';
      await call('POST', '/auth/register', guardRegistration(email));
      await call('POST', '/auth/forgot-password', { email });
      const link = lastLink('password_reset', email)!;
      assert.equal((await call('POST', '/auth/reset-password', { token: link.token, newPassword: 'Proven-pass-3' })).status, 200);
      assert.equal((await call('POST', '/auth/login', { email, password: 'Proven-pass-3' })).status, 201,
        'the reset link reached this exact address, which verifies it');
    });

    // ═══════════════════════════════════ ACCOUNT-DELETE ═════════════════════════════════════════════
    const owner = await repo(User).save(repo(User).create({
      email: 'gate2.owner@example.invalid', passwordHash: await bcrypt.hash('Owner-pass-1', 4),
      role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE, emailVerificationRequired: false,
    }));
    const company = await repo(Company).save(repo(Company).create({
      user: owner, name: 'Gate Two Security Ltd', companyNumber: '61616161', address: '1 Gate Street', contactDetails: 'ops@gate2.example.invalid',
    }));
    const site = await repo(Site).save(repo(Site).create({ company, name: 'GATE 2 SITE', address: '2 Gate Street', timezone: 'Europe/London' }));

    const doomedEmail = 'gate2.delete.me@example.invalid';
    const doomed = await verifiedGuard(doomedEmail);
    await repo(User).update({ id: doomed.id }, { firstName: 'Delete', lastName: 'Me', phone: '07700900999' });
    const doomedGuard = await repo(GuardProfile).findOneOrFail({ where: { user: { id: doomed.id } } });
    await repo(GuardProfile).update({ id: doomedGuard.id }, { locationSharingEnabled: true });
    await repo(CompanyGuard).save(repo(CompanyGuard).create({ company, guard: doomedGuard } as never));
    const shift = await repo(Shift).save(repo(Shift).create({
      company, guard: doomedGuard, site, siteName: site.name,
      start: new Date(Date.now() - 2 * 3600_000), end: new Date(Date.now() - 3600_000), status: 'completed',
    }));
    await repo(AttendanceEvent).save(repo(AttendanceEvent).create({
      shift, guard: doomedGuard, type: AttendanceEventType.CHECK_IN, occurredAt: new Date(Date.now() - 2 * 3600_000),
      latitude: 51.5, longitude: -0.12,
    } as never));
    await repo(DailyLog).save(repo(DailyLog).create({ company, shift, guard: doomedGuard, message: 'Patrol complete, all secure.', logType: 'log_book' } as never));
    await repo(Incident).save(repo(Incident).create({
      company, guard: doomedGuard, shift, site, title: 'Gate left open', notes: 'Closed and locked at 21:10.',
      severity: IncidentSeverity.LOW, status: IncidentStatus.OPEN, reportedAt: new Date(),
    }));
    await repo(SafetyAlert).save(repo(SafetyAlert).create({
      company, guard: doomedGuard, shift, type: SafetyAlertType.MISSED_CHECKCALL,
      priority: SafetyAlertPriority.MEDIUM, status: SafetyAlertStatus.OPEN, message: 'Welfare check missed',
    }));

    const evidenceCounts = async () => ({
      guardProfiles: await repo(GuardProfile).count({ where: { user: { id: doomed.id } } }),
      companyGuards: await repo(CompanyGuard).count({ where: { guard: { id: doomedGuard.id } } }),
      shifts: await repo(Shift).count({ where: { guard: { id: doomedGuard.id } } }),
      attendance: await repo(AttendanceEvent).count({ where: { guard: { id: doomedGuard.id } } }),
      dailyLogs: await repo(DailyLog).count({ where: { guard: { id: doomedGuard.id } } }),
      incidents: await repo(Incident).count({ where: { guard: { id: doomedGuard.id } } }),
      alerts: await repo(SafetyAlert).count({ where: { guard: { id: doomedGuard.id } } }),
      users: await repo(User).count({ where: { id: doomed.id } }),
    });
    const evidenceBefore = await evidenceCounts();
    const auditBefore = await repo(AuditLog).count();

    const doomedMobile = await mobileLogin(doomedEmail, 'Gate2-pass-1');
    const doomedAuth = bearer(doomedMobile.accessToken);
    // An outstanding reset link that deletion must kill.
    await call('POST', '/auth/forgot-password', { email: doomedEmail });
    const pendingResetLink = lastLink('password_reset', doomedEmail)!;

    await test('ACCOUNT-DELETE-01-STATUS-AND-CONFIRM-REQUIRES-REQUEST', async () => {
      const status = await call('GET', '/account/deletion', undefined, doomedAuth);
      assert.equal(status.status, 200, status.text);
      assert.equal(status.body.selfServiceAvailable, true);
      assert.equal(status.body.deletionRequestedAt, null);
      const early = await call('POST', '/account/deletion/confirm', { password: 'Gate2-pass-1' }, doomedAuth);
      assert.equal(early.status, 400, 'confirmation without a request is refused');
      assert.equal((await repo(User).findOneByOrFail({ id: doomed.id })).deletionCompletedAt, null);
    });

    let requestedAt = '';
    await test('ACCOUNT-DELETE-02-REQUEST-TIMESTAMP-RECORDED-ONCE', async () => {
      const first = await call('POST', '/account/deletion/request', {}, doomedAuth);
      assert.equal(first.status, 200, first.text);
      requestedAt = first.body.deletionRequestedAt;
      assert.ok(requestedAt);
      const row = await repo(User).findOneByOrFail({ id: doomed.id });
      assert.equal(row.deletionRequestedAt?.toISOString(), requestedAt);
      assert.equal(row.status, UserStatus.ACTIVE, 'a request alone changes nothing else');
      const second = await call('POST', '/account/deletion/request', {}, doomedAuth);
      assert.equal(second.body.deletionRequestedAt, requestedAt, 'a repeated request keeps the first timestamp');
    });

    await test('ACCOUNT-DELETE-03-WRONG-PASSWORD-CHANGES-NOTHING', async () => {
      const r = await call('POST', '/account/deletion/confirm', { password: 'wrong-password' }, doomedAuth);
      assert.equal(r.status, 400, 'not 401: the app must not treat it as a dead session');
      const row = await repo(User).findOneByOrFail({ id: doomed.id });
      assert.equal(row.deletionCompletedAt, null);
      assert.equal(row.email, doomedEmail);
    });

    const confirmed = await call('POST', '/account/deletion/confirm', { password: 'Gate2-pass-1' }, doomedAuth);
    const deletedRow = await userRow(doomed.id);

    await test('ACCOUNT-DELETE-04-COMPLETION-TIMESTAMP-AND-INACTIVE', async () => {
      assert.equal(confirmed.status, 200, confirmed.text);
      assert.equal(confirmed.body.deleted, true);
      assert.ok(deletedRow.deletionCompletedAt, 'completion recorded');
      assert.equal(deletedRow.deletionRequestedAt?.toISOString(), requestedAt, 'request timestamp preserved');
      assert.ok(deletedRow.deletionCompletedAt! >= deletedRow.deletionRequestedAt!);
      assert.equal(deletedRow.status, UserStatus.INACTIVE);
    });

    await test('ACCOUNT-DELETE-05-DIRECT-IDENTIFIERS-ANONYMISED', async () => {
      assert.equal(deletedRow.email, deletedAccountEmail(doomed.id));
      assert.match(deletedRow.email, /@deleted\.invalid$/, 'reserved .invalid domain');
      assert.equal(deletedRow.firstName, null);
      assert.equal(deletedRow.lastName, null);
      assert.equal(deletedRow.phone, null);
      const guard = await repo(GuardProfile).findOneOrFail({ where: { id: doomedGuard.id } });
      assert.equal(guard.phone, '', 'guard phone blanked (column is NOT NULL)');
      assert.equal(guard.locationSharingEnabled, false, 'location sharing stopped');
      assert.equal(guard.fullName, 'Gate Two Guard', 'name retained: it attributes operational evidence (retention-policy controlled)');
      assert.equal(guard.siaLicenseNumber, doomedGuard.siaLicenseNumber, 'SIA licence retained (retention-policy controlled)');
      // Other rows are untouched by anonymisation.
      assert.equal((await repo(User).findOneByOrFail({ id: owner.id })).email, owner.email);
    });

    await test('ACCOUNT-DELETE-06-PASSWORD-UNUSABLE', async () => {
      assert.equal(deletedRow.passwordHash, DELETED_ACCOUNT_PASSWORD_SENTINEL);
      assert.doesNotMatch(deletedRow.passwordHash, /^\$2/, 'not a bcrypt hash');
      assert.equal(await bcrypt.compare('Gate2-pass-1', deletedRow.passwordHash).catch(() => false), false);
    });

    await test('ACCOUNT-DELETE-07-SESSIONS-AND-TOKENS-REVOKED', async () => {
      const sessions = await repo(AuthSession).find({ where: { user: { id: doomed.id } } });
      assert.ok(sessions.length >= 1 && sessions.every((s) => s.revokedAt));
      assert.ok(sessions.some((s) => s.revokedReason === 'account_deleted'));
      const outstanding = await repo(UserVerificationToken).find({ where: { userId: doomed.id } });
      assert.ok(outstanding.every((t) => t.usedAt || t.invalidatedAt), 'no live emailed link survives deletion');
      const reset = await call('POST', '/auth/reset-password', { token: pendingResetLink.token, newPassword: 'Revive-pass-1' });
      assert.equal(reset.status, 400, 'a reset link issued before deletion cannot revive the account');
    });

    await test('ACCOUNT-DELETE-08-OPERATIONAL-EVIDENCE-PRESERVED', async () => {
      assert.deepEqual(await evidenceCounts(), evidenceBefore, 'no row removed');
      const log = await repo(DailyLog).findOneOrFail({ where: { guard: { id: doomedGuard.id } } });
      assert.equal(log.message, 'Patrol complete, all secure.', 'Log Book text untouched');
      const incident = await repo(Incident).findOneOrFail({ where: { guard: { id: doomedGuard.id } } });
      assert.equal(incident.notes, 'Closed and locked at 21:10.', 'incident report untouched');
      const attendance = await repo(AttendanceEvent).findOneOrFail({ where: { guard: { id: doomedGuard.id } } }) as any;
      assert.equal(Number(attendance.latitude), 51.5, 'GPS evidence untouched (retention-policy controlled)');
      assert.ok((await repo(AuditLog).count()) > auditBefore, 'deletion is itself audited');
    });

    await test('ACCOUNT-DELETE-09-AUDIT-ENTRY-HOLDS-NO-FORMER-IDENTIFIERS', async () => {
      const entry = await repo(AuditLog).findOneOrFail({ where: { action: 'account.deletion_completed', entityId: doomed.id } });
      const dump = JSON.stringify(entry.afterData);
      assert.ok(!dump.includes(doomedEmail) && !dump.includes('07700900999'), dump);
      assert.ok(Array.isArray((entry.afterData as any).retainedRecordCategories));
    });

    await test('ACCOUNT-DELETE-10-DELETED-USER-CANNOT-LOG-IN-REFRESH-OR-CALL-API', async () => {
      assert.equal((await call('POST', '/auth/login', { email: doomedEmail, password: 'Gate2-pass-1' })).status, 401);
      assert.equal((await call('POST', '/auth/login', { email: deletedRow.email, password: 'Gate2-pass-1' })).status, 401);
      assert.equal((await call('POST', '/auth/login', { email: deletedRow.email, password: DELETED_ACCOUNT_PASSWORD_SENTINEL })).status, 401);
      assert.equal((await call('POST', '/auth/refresh', { refreshToken: doomedMobile.refreshToken })).status, 401);
      assert.equal((await call('GET', '/auth/me', undefined, doomedAuth)).status, 401);
      assert.equal((await call('GET', '/account/deletion', undefined, doomedAuth)).status, 401);
    });

    await test('ACCOUNT-DELETE-11-SECOND-DELETION-IS-SAFE-AND-IDEMPOTENT', async () => {
      const http = await call('POST', '/account/deletion/confirm', { password: 'Gate2-pass-1' }, doomedAuth);
      assert.equal(http.status, 401, 'the deleted session cannot reach the endpoint again');
      const service = app.get(AccountDeletionService);
      const again = await service.completeDeletion(doomed.id, 'anything');
      assert.equal(again.deleted, true);
      const after = await userRow(doomed.id);
      assert.equal(after.deletionCompletedAt?.getTime(), deletedRow.deletionCompletedAt?.getTime(), 'completion time unchanged');
      assert.equal(after.email, deletedRow.email);
      assert.equal(await repo(AuditLog).count({ where: { action: 'account.deletion_completed', entityId: doomed.id } }), 1, 'audited once');
    });

    await test('ACCOUNT-DELETE-12-NO-PATH-REACTIVATES-A-DELETED-ACCOUNT', async () => {
      await app.get(UserService).updateStatus(doomed.id, UserStatus.ACTIVE);
      assert.equal((await repo(User).findOneByOrFail({ id: doomed.id })).status, UserStatus.INACTIVE);
      const forgot = await call('POST', '/auth/forgot-password', { email: doomedEmail });
      assert.deepEqual(forgot.body, FORGOT_PASSWORD_RESPONSE);
      assert.equal(sentTo('password_reset', doomedEmail), 1, 'no new reset email for the old address');
    });

    await test('ACCOUNT-DELETE-13-COMPANY-OWNER-CANNOT-ORPHAN-A-COMPANY', async () => {
      const login = await call('POST', '/auth/login', { email: owner.email, password: 'Owner-pass-1' });
      const auth = bearer(login.body.accessToken);
      const requested = await call('POST', '/account/deletion/request', {}, auth);
      assert.equal(requested.status, 200);
      assert.equal(requested.body.selfServiceAvailable, false);
      assert.equal(requested.body.blocker, 'company_owner');
      assert.ok(requested.body.deletionRequestedAt, 'the request is still recorded for support');
      const confirm = await call('POST', '/account/deletion/confirm', { password: 'Owner-pass-1' }, auth);
      assert.equal(confirm.status, 409);
      const row = await repo(User).findOneByOrFail({ id: owner.id });
      assert.equal(row.status, UserStatus.ACTIVE);
      assert.equal(row.deletionCompletedAt, null);
    });

    // ═══════════════════════════════════ INVITATION ═════════════════════════════════════════════════
    await test('EMAIL-VERIFY-11-INVITATION-NEITHER-PROVES-NOR-BYPASSES-EMAIL', async () => {
      const ownerLogin = await call('POST', '/auth/login', { email: owner.email, password: 'Owner-pass-1' });
      const invite = await call('POST', '/company-guards/invitations', {}, bearer(ownerLogin.body.accessToken));
      assert.equal(invite.status, 201, invite.text);
      const code = invite.body.code as string;
      assert.ok(code);
      allTokens.add(code);

      // An unverified guard has no way to hold a session, so cannot accept at all.
      const unverifiedEmail = 'gate2.invited.unverified@example.invalid';
      await call('POST', '/auth/register', guardRegistration(unverifiedEmail));
      assert.equal((await call('POST', '/auth/login', { email: unverifiedEmail, password: 'Gate2-pass-1' })).status, 403);

      // A verified guard accepts; the invitation is a company relationship, not proof of an address.
      const invitedEmail = 'gate2.invited@example.invalid';
      const invited = await verifiedGuard(invitedEmail);
      await repo(User).update({ id: invited.id }, { isEmailVerified: false, emailVerificationRequired: false });
      const login = await call('POST', '/auth/login', { email: invitedEmail, password: 'Gate2-pass-1' });
      const accepted = await call('POST', '/guards/me/invitations/accept', { code }, bearer(login.body.accessToken));
      assert.equal(accepted.status, 201, accepted.text);
      assert.equal((await repo(User).findOneByOrFail({ id: invited.id })).isEmailVerified, false,
        'accepting an invitation does not mark the email verified');
    });

    // ═══════════════════════════════════ AUTH-REGRESSION / SESSION-REVOCATION ══════════════════════
    await test('AUTH-REGRESSION-01-INACTIVE-AND-SUSPENDED-USERS-ARE-CUT-OFF', async () => {
      const email = 'gate2.suspend@example.invalid';
      const user = await verifiedGuard(email);
      const session = await mobileLogin(email, 'Gate2-pass-1');
      assert.equal((await call('GET', '/auth/me', undefined, bearer(session.accessToken))).status, 200);
      await repo(User).update({ id: user.id }, { status: UserStatus.SUSPENDED });
      assert.equal((await call('GET', '/auth/me', undefined, bearer(session.accessToken))).status, 401, 'status re-checked per request');
      assert.equal((await call('POST', '/auth/refresh', { refreshToken: session.refreshToken })).status, 401);
      assert.equal((await call('POST', '/auth/login', { email, password: 'Gate2-pass-1' })).status, 403);
    });

    await test('SESSION-REVOCATION-01-ROTATION-REUSE-AND-LOGOUT-STILL-AUTHORITATIVE', async () => {
      const email = 'gate2.sessions@example.invalid';
      await verifiedGuard(email);
      const first = await mobileLogin(email, 'Gate2-pass-1');
      const rotated = await call('POST', '/auth/refresh', { refreshToken: first.refreshToken });
      assert.equal(rotated.status, 201);
      allTokens.add(rotated.body.refreshToken);
      assert.equal((await call('POST', '/auth/refresh', { refreshToken: first.refreshToken })).status, 401, 'reuse detected');
      assert.equal((await call('POST', '/auth/refresh', { refreshToken: rotated.body.refreshToken })).status, 401, 'family burned');
      const second = await mobileLogin(email, 'Gate2-pass-1');
      assert.equal((await call('POST', '/auth/logout', { refreshToken: second.refreshToken }, bearer(second.accessToken))).status, 201);
      assert.equal((await call('POST', '/auth/refresh', { refreshToken: second.refreshToken })).status, 401, 'logout revokes');
      const rows = await repo(AuthSession).find();
      assert.ok(rows.every((r) => r.tokenHash.length === 64), 'refresh sessions remain hashed');
    });

    await test('AUTH-REGRESSION-02-CLIENT-PORTAL-PRINCIPAL-CANNOT-USE-ACCOUNT-ENDPOINTS', async () => {
      const forged = new JwtService({ secret: JWT_SECRET }).sign({ sub: 999, email: 'c@example.invalid', role: 'client_admin', status: 'active', principalType: 'client_portal', clientId: 1 });
      // No such client user exists, so the strategy refuses it before the controller is reached.
      assert.equal((await call('GET', '/account/deletion', undefined, bearer(forged))).status, 401);
    });

    // ═══════════════════════════════════ LOGS ════════════════════════════════════════════════════════
    await test('PASSWORD-RESET-14-NO-PLAINTEXT-TOKEN-IN-LOGS', async () => {
      assert.ok(captured.length > 0, 'logs were captured');
      assert.ok(allTokens.size >= 10, `collected ${allTokens.size} tokens to look for`);
      const joined = captured.join('\n');
      for (const token of allTokens) {
        assert.ok(!joined.includes(token), 'a plaintext token reached the logs');
      }
      assert.ok(!/reset-password\?token=|verify-email\?token=/.test(joined), 'no emailed link was logged');
      const audits = JSON.stringify(await repo(AuditLog).find());
      for (const token of allTokens) assert.ok(!audits.includes(token), 'a plaintext token reached the audit trail');
    });
  } finally {
    await app.close();
    await ds.destroy();
  }

  console.log(JSON.stringify({ event: 'gate2_account_lifecycle_passed', tests: passed }));
}

main().catch((error) => {
  console.error('FAIL ', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
