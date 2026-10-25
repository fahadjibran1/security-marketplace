/**
 * Welfare Check push notifications — certification over real HTTP with real authorisation, on a disposable database
 * built from the repository's own migrations (head 65), with a local fake of the Expo Push Service. Nothing leaves
 * this machine.
 *
 *   WPN-01  off by default: with PUSH_WELFARE_REMINDERS_ENABLED unset the job sends nothing
 *   WPN-02  devices: Guard-only, shape-checked, one row per token (moves between accounts), own-token unregister only,
 *           at most five active per account
 *   WPN-03  timing: one reminder when the window the Guard owes opens, one follow-up before it ends, the next window's
 *           reminder when it opens; nothing for a window not yet open; repeated runs send nothing twice
 *   WPN-04  payload: identifiers only — no access token, credential or Guard detail; channel, category and TTL to the
 *           window end
 *   WPN-05  a check recorded (in the app or from the notification) stops the follow-up; a check made before the window
 *           opened (early tolerance) means no reminder at all
 *   WPN-06  I'm Safe records exactly one welfare_check daily log at the server's time, graded by the same engine, audited
 *           with its source; the reminder alone never marks the Guard safe
 *   WPN-07  idempotent: repeated and concurrent I'm Safe for one window record one check
 *   WPN-08  stale: a reminder whose window has closed is refused (reminder_expired); no check is due → no_check_due
 *   WPN-09  authorisation: no session → 401; another Guard's shift → 400; another Guard's reminder → 404; a company
 *           account → 403; the shift and Guard come from the server, never the notification
 *   WPN-10  Book Off: no further reminders; I'm Safe and Need Help are refused
 *   WPN-11  Live Shift Amendment extension: reminders continue to the new effective end
 *   WPN-12  Need Help raises the existing CRITICAL panic alert to the Control Room once (repeat taps return the same
 *           alert), audited, and is never a Welfare Check
 *   WPN-13  provider failures: no device → no_device; DeviceNotRegistered revokes the device; transport failure →
 *           failed and retried (at most three attempts) while the window is still due; receipts recorded
 *   WPN-14  Control Room: GET /coverage/operations carries each reminder's provider status beside the unchanged window
 *           state; company-isolated
 *   WPN-15  regression: the safety sweep still runs and records nothing new for a due window; reminders create no alert
 *   WPN-16  the reminder timer is single-flight
 *   WPN-17  a password reset revokes the account's devices and account deletion removes them, in the same transactions
 *   WPN-18  company allowlist: with PUSH_WELFARE_REMINDER_COMPANY_IDS=9 company 9's Guards are reminded and company 8's
 *           are not; a missing, empty or invalid allowlist reminds no company even with reminders switched on
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { complianceToday } from '../src/compliance/compliance-dates';

const url = process.env.WELFARE_PUSH_DATABASE_URL;
if (!url) throw new Error('WELFARE_PUSH_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Welfare push database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'welfare-push-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.RESEND_API_KEY;
delete process.env.EXPO_ACCESS_TOKEN;
process.env.PUSH_WELFARE_REMINDERS_ENABLED = 'true';
// The pilot allowlist: company A below is created as company 9 and company B as company 8, as in production.
process.env.PUSH_WELFARE_REMINDER_COMPANY_IDS = '9';
delete process.env.WELFARE_REMINDER_FOLLOW_UP_MINUTES_BEFORE_END;

let passed = 0;
const failures: string[] = [];
const test = async (id: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failures.push(id);
    console.log(`FAIL  ${id}\n      ${String((error as Error)?.stack ?? error).split('\n').slice(0, 5).join('\n      ')}`);
  }
};

type Res = { status: number; body: any };
const MIN = 60_000;
const PASSWORD = 'welfare-push-spec-only-password-1';
const ukDay = (n: number) => {
  const [y, m, d] = complianceToday().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const iso = (ms: number) => new Date(ms).toISOString();
const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const token = (n: number) => `ExponentPushToken[spec${String(n).padStart(8, '0')}abcdef]`;

// ── The fake Expo Push Service ─────────────────────────────────────────────────────────────────────────
type Mode = 'ok' | 'http500' | { notRegistered: string[] };
const fake = { mode: 'ok' as Mode, sends: [] as any[][], receiptMode: 'ok' as 'ok' | { notRegisteredTicket: string }, receiptCalls: 0, seq: 0 };
const expoServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.url === '/--/api/v2/push/send') {
      fake.sends.push(body);
      if (fake.mode === 'http500') return reply(500, { errors: [{ code: 'INTERNAL' }] });
      const mode = fake.mode;
      return reply(200, {
        data: (body as any[]).map((m) =>
          typeof mode === 'object' && mode.notRegistered.includes(m.to)
            ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } }
            : { status: 'ok', id: `ticket-${++fake.seq}` },
        ),
      });
    }
    if (req.url === '/--/api/v2/push/getReceipts') {
      fake.receiptCalls += 1;
      const data: Record<string, unknown> = {};
      for (const id of body.ids as string[]) {
        const rm = fake.receiptMode;
        data[id] = typeof rm === 'object' && rm.notRegisteredTicket === id
          ? { status: 'error', details: { error: 'DeviceNotRegistered' } }
          : { status: 'ok' };
      }
      return reply(200, { data });
    }
    reply(404, {});
  });
});

async function main() {
  await new Promise<void>((resolve) => expoServer.listen(0, '127.0.0.1', resolve));
  const expoAddress = expoServer.address();
  if (!expoAddress || typeof expoAddress === 'string') throw new Error('No fake Expo port');
  process.env.EXPO_PUSH_API_BASE = `http://127.0.0.1:${expoAddress.port}`;

  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const migrator = new DataSource({
    ...buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' }),
    dropSchema: true,
  } as never);
  await migrator.initialize();
  const migrated = await migrator.runMigrations({ transaction: 'each' });
  assert.equal(migrated[migrated.length - 1]?.name, 'AddGuardNotificationDispatches1720900000012', 'the head is Migration 66');
  await migrator.destroy();

  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const base = `http://127.0.0.1:${address.port}`;
  const ds = app.get(DataSource);
  const [{ current_database: actualDatabase }] = await ds.query('SELECT current_database()');
  if (actualDatabase !== new URL(url!).pathname.slice(1)) throw new Error(`Refusing: connected to ${actualDatabase}`);
  const { WelfarePushService } = await import('../src/welfare-push/welfare-push.service');
  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const push = app.get(WelfarePushService);
  const sweep = app.get(SafetyAlertService);
  // This process drives the job explicitly, at chosen instants; its own timer must not race the assertions.
  clearInterval((push as any).reminderInterval);

  const api = async (method: string, path: string, tok: string | null, body?: unknown): Promise<Res> => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params);
  const one = async <T = any>(sql: string, params: unknown[] = []): Promise<T> => (await q<T>(sql, params))[0];

  try {
    const hash = await bcrypt.hash(PASSWORD, 4);
    const user = async (email: string, role: string) =>
      (await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired") VALUES ($1,$2,$3,'active',true,false) RETURNING id`, [email, hash, role])).id as number;
    const { AuthService } = await import('../src/auth/auth.service');
    const auth = app.get(AuthService);
    const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;

    const company = async (companyId: number, label: string, number: string) => {
      const ownerEmail = `${label}.owner@example.invalid`;
      const ownerId = await user(ownerEmail, 'company_admin');
      const { id } = await one(`INSERT INTO companies (id,"userId",name,"companyNumber",address,"contactDetails") VALUES ($1,$2,$3,$4,'1 Way','ops@example.invalid') RETURNING id`, [companyId, ownerId, `${label} Security Ltd`, number]);
      const siteId = (await one(`INSERT INTO sites ("companyId",name,address,timezone) VALUES ($1,'Harbour Gate','2 Way','Europe/London') RETURNING id`, [id])).id as number;
      return { id: id as number, ownerId, siteId, token: await login(ownerEmail) };
    };
    const A = await company(9, 'wpnalpha', '77555555');
    const B = await company(8, 'wpnbeta', '77666666');
    const adminEmail = 'wpn.platform.admin@example.invalid';
    await user(adminEmail, 'admin');
    const adminToken = await login(adminEmail);

    let n = 0;
    const guard = async (label: string, co = A) => {
      n += 1;
      const email = `${label}@example.invalid`;
      const userId = await user(email, 'guard');
      const licence = `83000000000000${String(n).padStart(2, '0')}`;
      const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","siaExpiryDate","rightToWorkStatus",phone) VALUES ($1,$2,$3,$4,'british','07000000000') RETURNING id`,
        [userId, `${label} Guard`, licence, ukDay(500)]);
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [co.id, id]);
      for (const type of ['sia_licence', 'right_to_work']) {
        await q(`INSERT INTO guard_documents ("guardId","companyId",type,"storageProvider","storageKey","originalFileName","mimeType","sizeBytes","uploadCompletedAt",verified,"uploadedByUserId","verifiedByUserId","verifiedAt")
          VALUES ($1,$2,$3,'s3-compatible',$4,'e.pdf','application/pdf','1024',now(),true,null,null,now())`, [id, co.id, type, `wpn/${co.id}/${id}/${type}`]);
      }
      for (const body of [
        { guardId: id, kind: 'sia', outcome: 'confirmed', checkDate: ukDay(0), checkedByName: 'Spec Checker', evidenceReference: 'HR/spec', method: 'sia_public_register', licenceNumber: licence, expiryDate: ukDay(400) },
        { guardId: id, kind: 'right_to_work', outcome: 'confirmed', checkDate: ukDay(0), checkedByName: 'Spec Checker', evidenceReference: 'HR/spec', method: 'manual_document', rightToWorkExcuse: 'continuous' },
      ]) {
        const r = await api('POST', '/compliance/checks', co.token, body);
        assert.equal(r.status, 201, `record ${body.kind}: ${r.status} ${JSON.stringify(r.body)}`);
      }
      return { id: id as number, userId, token: await login(email) };
    };
    const device = async (g: { token: string }, t: string, platform = 'android') => {
      const r = await api('POST', '/push-devices', g.token, { token: t, platform, appVersion: '1.2.0' });
      assert.equal(r.status, 200, `register: ${r.status} ${JSON.stringify(r.body)}`);
    };

    /**
     * A booked-on shift of the company: starts `startAgo` ms ago, ends `endIn` ms from now. Returns its id and its
     * stored start (the grid anchor), so instants can be chosen relative to the windows.
     */
    const liveShift = async (g: { id: number; token: string }, startAgo: number, endIn: number, interval = 60, co = A) => {
      const now = Date.now();
      const { id } = await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end","checkCallIntervalMinutes") VALUES ($1,$2,'Harbour Gate',$3,'ready',$4::timestamp,$5::timestamp,$6) RETURNING id`,
        [co.id, co.siteId, g.id, ts(now - startAgo), ts(now + endIn), interval]);
      const on = await api('POST', '/attendance/check-in', g.token, { shiftId: id });
      assert.equal(on.status, 201, `book on: ${on.status} ${JSON.stringify(on.body)}`);
      const row = await one(`SELECT start FROM shifts WHERE id = $1`, [id]);
      return { id: id as number, S: new Date(row.start).getTime() };
    };
    const reminders = (shiftId: number) =>
      q(`SELECT id, "windowIndex" w, kind, status, attempts, "deviceCount" dc, "receiptStatus" rs, error, "ticketIds" t FROM welfare_reminders WHERE "shiftId" = $1 ORDER BY id`, [shiftId]);
    const welfareLogs = (shiftId: number) => q(`SELECT id, message, "createdAt" FROM daily_logs WHERE "shiftId" = $1 AND "logType" = 'welfare_check' ORDER BY id`, [shiftId]);
    const sentTo = (shiftId: number) => fake.sends.flat().filter((m) => m.data?.shiftId === shiftId);
    const run = (at: number) => push.runReminderJob(new Date(at));

    // ════════════════ flag and devices ════════════════

    await test('WPN-01-OFF-BY-DEFAULT', async () => {
      const off = Object.create(WelfarePushService.prototype) as InstanceType<typeof WelfarePushService>;
      (off as any).config = { get: () => undefined };
      assert.equal(off.remindersEnabled(), false, 'unset is off');
      (off as any).config = { get: () => 'false' };
      assert.equal(off.remindersEnabled(), false);
      const counters = await off.runReminderJob(new Date());
      assert.equal(counters.shiftsChecked, 0, 'a disabled run reads nothing and sends nothing');
      assert.equal(push.remindersEnabled(), true, 'this suite turns it on explicitly');
    });

    await test('WPN-02-DEVICES', async () => {
      const g1 = await guard('wpn-dev1');
      const g2 = await guard('wpn-dev2');
      assert.equal((await api('POST', '/push-devices', g1.token, { token: 'not-a-token', platform: 'android' })).status, 400, 'shape-checked');
      assert.equal((await api('POST', '/push-devices', g1.token, { token: token(1), platform: 'windows' })).status, 400, 'platform checked');
      assert.equal((await api('POST', '/push-devices', A.token, { token: token(1), platform: 'ios' })).status, 403, 'Guard-only');
      assert.equal((await api('POST', '/push-devices', null, { token: token(1), platform: 'ios' })).status, 401);
      await device(g1, token(1));
      await device(g1, token(1));
      assert.equal(Number((await one(`SELECT count(*) n FROM push_devices WHERE token = $1`, [token(1)])).n), 1, 'one row per token');
      await device(g2, token(1));
      const moved = await one(`SELECT "userId" u, "revokedAt" r FROM push_devices WHERE token = $1`, [token(1)]);
      assert.equal(moved.u, g2.userId, 'the same phone signing in as another Guard moves the token');
      const other = await api('POST', '/push-devices/unregister', g1.token, { token: token(1) });
      assert.equal(other.status, 200);
      assert.equal((await one(`SELECT "revokedAt" r FROM push_devices WHERE token = $1`, [token(1)])).r, null, "another account's token is untouched");
      await api('POST', '/push-devices/unregister', g2.token, { token: token(1) });
      const revoked = await one(`SELECT "revokedAt" r, "revokedReason" why FROM push_devices WHERE token = $1`, [token(1)]);
      assert.ok(revoked.r, 'own token revoked on sign-out');
      assert.equal(revoked.why, 'signed_out');
      for (let i = 10; i < 17; i += 1) await device(g1, token(i));
      assert.equal(Number((await one(`SELECT count(*) n FROM push_devices WHERE "userId" = $1 AND "revokedAt" IS NULL`, [g1.userId])).n), 5, 'at most five active');
      assert.equal((await one(`SELECT "revokedAt" r FROM push_devices WHERE token = $1`, [token(16)])).r, null, 'the newest stays');
      await q(`UPDATE push_devices SET "revokedAt" = now(), "revokedReason" = 'spec_cleanup' WHERE "userId" = $1`, [g1.userId]);
    });

    // ════════════════ timing, payload, completion ════════════════

    const g = await guard('wpn-main');
    await device(g, token(100), 'android');
    await device(g, token(101), 'ios');
    const main = await liveShift(g, 10 * MIN, 50 * MIN + 60 * MIN); // windows [S, S+60), [S+60, S+120)
    const S = main.S;

    await test('WPN-03-TIMING-ONE-PER-WINDOW-AND-ONE-FOLLOW-UP', async () => {
      await run(S + 11 * MIN);
      let rows = await reminders(main.id);
      assert.deepEqual(rows.map((r: any) => [r.w, r.kind, r.status, r.dc]), [[0, 'window_open', 'provider_accepted', 2]]);
      await run(S + 12 * MIN);
      await Promise.all([run(S + 13 * MIN), run(S + 13 * MIN)]);
      assert.equal((await reminders(main.id)).length, 1, 'repeated and concurrent runs send nothing twice');
      assert.equal(sentTo(main.id).length, 2, 'one message per device, once');
      await run(S + 49 * MIN);
      assert.equal((await reminders(main.id)).length, 1, 'no follow-up before ten minutes from the end');
      await run(S + 50 * MIN);
      await run(S + 51 * MIN);
      rows = await reminders(main.id);
      assert.deepEqual(rows.map((r: any) => [r.w, r.kind]), [[0, 'window_open'], [0, 'follow_up']], 'exactly one follow-up');
      assert.match(sentTo(main.id).at(-1).body, /still due/);
      await run(S + 61 * MIN);
      rows = await reminders(main.id);
      assert.deepEqual(rows.map((r: any) => [r.w, r.kind]).at(-1), [1, 'window_open'], 'the next window when it opens');
      assert.equal(rows.length, 3, 'nothing for a window not yet open');
    });

    await test('WPN-04-PAYLOAD-HOLDS-IDENTIFIERS-ONLY', async () => {
      const messages = sentTo(main.id);
      const first = messages[0];
      assert.equal(first.title, 'S4 — Welfare Check');
      assert.equal(first.body, 'Time for your Welfare Check at Harbour Gate. Please confirm that you are safe and on duty.');
      assert.deepEqual(Object.keys(first.data).sort(), ['kind', 'reminderId', 'shiftId', 'windowEnd', 'windowIndex']);
      assert.equal(first.data.kind, 'welfare_check');
      assert.equal(first.channelId, 'welfare-checks');
      assert.equal(first.categoryId, 'welfare_check');
      assert.equal(first.priority, 'high');
      assert.ok(first.ttl > 0 && first.ttl <= 49 * 60 + 1, `ttl to the window end: ${first.ttl}`);
      const everything = JSON.stringify(fake.sends);
      assert.doesNotMatch(everything, /Bearer|accessToken|refreshToken|password|eyJ[A-Za-z0-9_-]{10,}/, 'no credential anywhere');
      assert.ok(!everything.includes(g.token), "the Guard's access token is never sent");
      assert.doesNotMatch(everything, /wpn-main|07000000000|83000000/, 'no Guard name, phone or licence');
    });

    await test('WPN-05-A-RECORDED-CHECK-STOPS-THE-FOLLOW-UP-AND-EARLY-CHECKS-COUNT', async () => {
      const g5 = await guard('wpn-stop');
      await device(g5, token(200));
      const s5 = await liveShift(g5, 5 * MIN, 115 * MIN);
      await run(s5.S + 6 * MIN);
      const manual = await api('POST', '/daily-logs', g5.token, { shiftId: s5.id, message: 'All quiet', logType: 'welfare_check' });
      assert.equal(manual.status, 201, 'the in-app form, unchanged');
      await run(s5.S + 50 * MIN);
      await run(s5.S + 55 * MIN);
      assert.deepEqual((await reminders(s5.id)).map((r: any) => r.kind), ['window_open'], 'no follow-up once the check is recorded');
      // A check in the last five minutes of window 0 (already met) counts for window 1: no reminder for window 1.
      await q(`INSERT INTO daily_logs ("companyId","guardId","shiftId",message,"logType","createdAt","updatedAt") VALUES ($1,$2,$3,'early','welfare_check',$4::timestamp,$4::timestamp)`,
        [A.id, g5.id, s5.id, ts(s5.S + 57 * MIN)]);
      await run(s5.S + 61 * MIN);
      assert.deepEqual((await reminders(s5.id)).map((r: any) => r.w), [0], 'window 1 already met by the early check');
    });

    await test('WPN-06-IM-SAFE-RECORDS-ONE-WELFARE-CHECK-AT-SERVER-TIME', async () => {
      const g6 = await guard('wpn-safe');
      await device(g6, token(300));
      const s6 = await liveShift(g6, 10 * MIN, 50 * MIN);
      await run(Date.now());
      const [rem] = await reminders(s6.id);
      const ops = async () => (await api('GET', `/coverage/operations?shiftIds=${s6.id}`, A.token)).body[0].operations;
      assert.equal((await ops()).welfare.windows[0].state, 'due', 'a reminder sent is not a check: still due');
      assert.equal((await welfareLogs(s6.id)).length, 0);
      const before = Date.now();
      const r = await api('POST', '/welfare-checks/confirm', g6.token, { shiftId: s6.id, reminderId: rem.id });
      assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.result, 'recorded');
      assert.equal(r.body.windowIndex, 0);
      const logs = await welfareLogs(s6.id);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].message, 'Confirmed safe and on duty from the Welfare Check notification.');
      const at = new Date(logs[0].createdAt).getTime();
      assert.ok(at >= before - 1000 && at <= Date.now() + 1000, 'stamped by the server clock');
      assert.equal((await ops()).welfare.windows[0].state, 'completed', 'graded by the same engine');
      const audit = await q(`SELECT "afterData" a FROM audit_logs WHERE action = 'daily_log.created' AND "entityId" = $1`, [logs[0].id]);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].a.source, 'welfare_notification');
      assert.equal(audit[0].a.reminderId, rem.id);
    });

    await test('WPN-07-IDEMPOTENT-AND-CONCURRENCY-SAFE', async () => {
      const g7 = await guard('wpn-idem');
      const s7 = await liveShift(g7, 10 * MIN, 50 * MIN);
      const results = await Promise.all([1, 2, 3, 4].map(() => api('POST', '/welfare-checks/confirm', g7.token, { shiftId: s7.id })));
      assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200]);
      assert.deepEqual(results.map((r) => r.body.result).sort(), ['already_recorded', 'already_recorded', 'already_recorded', 'recorded']);
      assert.equal((await welfareLogs(s7.id)).length, 1, 'one check for one window');
      const again = await api('POST', '/welfare-checks/confirm', g7.token, { shiftId: s7.id });
      assert.equal(again.body.result, 'already_recorded');
      assert.ok(again.body.recordedAt, 'with the time it was recorded');
    });

    await test('WPN-08-STALE-AND-NOT-DUE-ARE-REFUSED', async () => {
      const g8 = await guard('wpn-stale');
      await device(g8, token(400));
      const s8 = await liveShift(g8, 10 * MIN, 110 * MIN);
      await run(Date.now());
      const [rem] = await reminders(s8.id);
      await assert.rejects(
        () => push.confirmSafe(g8.userId, { shiftId: s8.id, reminderId: rem.id }, new Date(s8.S + 61 * MIN)),
        (e: any) => e?.getStatus?.() === 409 && e.getResponse().code === 'reminder_expired',
      );
      assert.equal((await welfareLogs(s8.id)).length, 0, 'nothing recorded for a stale action');
      // Without a reminder, the CURRENT window is confirmed (the in-app fallback after a stale reminder).
      const current = await push.confirmSafe(g8.userId, { shiftId: s8.id }, new Date(s8.S + 61 * MIN));
      assert.equal(current.windowIndex, 1);
      // Before Book On's first window opens there is nothing due.
      const g8b = await guard('wpn-early');
      const s8b = await liveShift(g8b, -10 * MIN, 120 * MIN); // starts in ten minutes; Booked On early
      const early = await api('POST', '/welfare-checks/confirm', g8b.token, { shiftId: s8b.id });
      assert.equal(early.status, 409, `${early.status} ${JSON.stringify(early.body)}`);
      assert.equal(early.body.code, 'no_check_due');
    });

    await test('WPN-09-AUTHORISATION-COMES-FROM-THE-SERVER', async () => {
      const other = await guard('wpn-other');
      const s9 = await liveShift(other, 10 * MIN, 50 * MIN);
      const [mainRem] = await reminders(main.id);
      assert.equal((await api('POST', '/welfare-checks/confirm', null, { shiftId: main.id })).status, 401, 'no session');
      assert.equal((await api('POST', '/welfare-checks/confirm', 'not.a.jwt', { shiftId: main.id })).status, 401, 'expired or bad session');
      const foreign = await api('POST', '/welfare-checks/confirm', other.token, { shiftId: main.id });
      assert.equal(foreign.status, 400, `another Guard's shift: ${foreign.status}`);
      const borrowed = await api('POST', '/welfare-checks/confirm', other.token, { shiftId: s9.id, reminderId: mainRem.id });
      assert.equal(borrowed.status, 404, "another Guard's reminder");
      assert.equal((await api('POST', '/welfare-checks/need-help', other.token, { shiftId: main.id })).status, 400);
      assert.equal((await api('POST', '/welfare-checks/confirm', A.token, { shiftId: main.id })).status, 403, 'company accounts cannot confirm');
      assert.equal((await api('POST', '/welfare-checks/confirm', g.token, { shiftId: main.id, guardId: other.id })).status, 400, 'no guard id is accepted');
      assert.equal((await welfareLogs(s9.id)).length, 0);
    });

    await test('WPN-10-BOOK-OFF-STOPS-EVERYTHING', async () => {
      const g10 = await guard('wpn-off');
      await device(g10, token(500));
      const s10 = await liveShift(g10, 10 * MIN, 110 * MIN);
      await run(Date.now());
      const off = await api('POST', '/attendance/check-out', g10.token, { shiftId: s10.id });
      assert.ok([200, 201].includes(off.status), `book off: ${off.status} ${JSON.stringify(off.body)}`);
      await run(s10.S + 50 * MIN);
      await run(s10.S + 61 * MIN);
      assert.equal((await reminders(s10.id)).length, 1, 'nothing after Book Off');
      const [rem] = await reminders(s10.id);
      assert.equal((await api('POST', '/welfare-checks/confirm', g10.token, { shiftId: s10.id, reminderId: rem.id })).status, 400);
      assert.equal((await api('POST', '/welfare-checks/need-help', g10.token, { shiftId: s10.id })).status, 400);
    });

    await test('WPN-11-REMINDERS-FOLLOW-AN-EXTENSION', async () => {
      const g11 = await guard('wpn-ext');
      await device(g11, token(600));
      const s11 = await liveShift(g11, 10 * MIN, 50 * MIN); // one window: [S, S+60)
      await run(s11.S + 61 * MIN);
      assert.equal((await reminders(s11.id)).length, 0, 'no window after the scheduled end');
      const enable = await api('PUT', `/admin/shift-amendments/companies/${A.id}`, adminToken, { enabled: true });
      assert.equal(enable.status, 200, `enable: ${enable.status}`);
      const proposal = await api('POST', `/shifts/${s11.id}/amendments`, A.token, { proposedEnd: iso(s11.S + 120 * MIN), reason: 'Relief Guard delayed' });
      assert.equal(proposal.status, 201, `propose: ${proposal.status} ${JSON.stringify(proposal.body)}`);
      const accept = await api('PATCH', `/shift-amendments/${proposal.body.amendment.id}/respond`, g11.token, { response: 'accepted' });
      assert.equal(accept.status, 200, `accept: ${accept.status} ${JSON.stringify(accept.body)}`);
      await run(s11.S + 61 * MIN);
      assert.deepEqual((await reminders(s11.id)).map((r: any) => [r.w, r.kind]), [[1, 'window_open']], 'the new window reminds');
      await api('PUT', `/admin/shift-amendments/companies/${A.id}`, adminToken, { enabled: false });
    });

    await test('WPN-12-NEED-HELP-RAISES-THE-PANIC-ALERT-ONCE', async () => {
      const g12 = await guard('wpn-help');
      await device(g12, token(700));
      const s12 = await liveShift(g12, 10 * MIN, 50 * MIN);
      await run(Date.now());
      const [rem] = await reminders(s12.id);
      const taps = await Promise.all([1, 2, 3].map(() => api('POST', '/welfare-checks/need-help', g12.token, { shiftId: s12.id, reminderId: rem.id })));
      assert.deepEqual(taps.map((t) => t.status), [200, 200, 200], JSON.stringify(taps.map((t) => t.body)));
      assert.deepEqual(taps.map((t) => t.body.result).sort(), ['already_raised', 'already_raised', 'raised']);
      assert.equal(new Set(taps.map((t) => t.body.alertId)).size, 1, 'one alert');
      const alerts = await q(`SELECT type, priority, status, message FROM safety_alerts WHERE "shiftId" = $1`, [s12.id]);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].type, 'panic');
      assert.equal(alerts[0].priority, 'critical');
      assert.equal(alerts[0].status, 'open');
      assert.equal((await welfareLogs(s12.id)).length, 0, 'Need Help is never a Welfare Check');
      assert.equal(Number((await one(`SELECT count(*) n FROM audit_logs WHERE action = 'safety_alert.created' AND "entityId" = $1`, [taps[0].body.alertId])).n), 1);
      assert.ok(Number((await one(`SELECT count(*) n FROM notifications WHERE "userId" = $1 AND title LIKE 'CRITICAL%'`, [A.ownerId])).n) >= 1, 'the Control Room is told');
      assert.doesNotMatch(JSON.stringify(taps.map((t) => t.body)), /emergency services|999|police/i, 'no claim that emergency services were contacted');
    });

    await test('WPN-13-PROVIDER-FAILURES-RETRIES-AND-RECEIPTS', async () => {
      const lone = await guard('wpn-nodevice');
      const sNo = await liveShift(lone, 10 * MIN, 50 * MIN);
      await run(Date.now());
      assert.deepEqual((await reminders(sNo.id)).map((r: any) => [r.status, r.dc]), [['no_device', 0]]);

      const g13 = await guard('wpn-fail');
      await device(g13, token(800));
      await device(g13, token(801));
      const s13 = await liveShift(g13, 10 * MIN, 50 * MIN);
      fake.mode = { notRegistered: [token(800)] };
      await run(Date.now());
      let [rem] = await reminders(s13.id);
      assert.equal(rem.status, 'provider_accepted', 'one device still took it');
      assert.equal(rem.error, 'DeviceNotRegistered');
      assert.equal((await one(`SELECT "revokedReason" why FROM push_devices WHERE token = $1`, [token(800)])).why, 'device_not_registered');

      const g13b = await guard('wpn-down');
      await device(g13b, token(900));
      const s13b = await liveShift(g13b, 10 * MIN, 50 * MIN);
      fake.mode = 'http500';
      const t0 = Date.now();
      await run(t0);
      [rem] = await reminders(s13b.id);
      assert.deepEqual([rem.status, rem.attempts, rem.error], ['failed', 1, 'http_500']);
      await run(t0 + 30_000);
      assert.equal((await reminders(s13b.id))[0].attempts, 1, 'not retried within a minute');
      await run(t0 + 61_000);
      assert.equal((await reminders(s13b.id))[0].attempts, 2);
      fake.mode = 'ok';
      await run(t0 + 122_000);
      [rem] = await reminders(s13b.id);
      assert.deepEqual([rem.status, rem.attempts], ['provider_accepted', 3]);
      await run(t0 + 183_000);
      assert.equal((await reminders(s13b.id)).length, 1, 'still one reminder row');

      // Receipts: the provider's report of handing the message on, recorded truthfully (still not the phone).
      fake.receiptMode = { notRegisteredTicket: (await reminders(s13.id))[0].t[0].id };
      await q(`UPDATE welfare_reminders SET "sentAt" = now() - interval '16 minutes' WHERE "shiftId" IN ($1, $2)`, [s13.id, s13b.id]);
      await run(Date.now());
      const r13 = (await reminders(s13.id))[0];
      const r13b = (await reminders(s13b.id))[0];
      assert.equal(r13b.rs, 'provider_delivery_ok');
      assert.equal(r13.rs, 'provider_delivery_error');
      assert.equal((await one(`SELECT "revokedReason" why FROM push_devices WHERE token = $1`, [token(801)])).why, 'device_not_registered');
      fake.receiptMode = 'ok';
    });

    await test('WPN-14-CONTROL-ROOM-SEES-PROVIDER-STATUS-BESIDE-THE-WINDOW-STATE', async () => {
      const r = await api('GET', `/coverage/operations?shiftIds=${main.id}`, A.token);
      assert.equal(r.status, 200);
      const view = r.body[0].operations;
      assert.deepEqual(view.welfareReminders.map((x: any) => [x.windowIndex, x.kind, x.status]),
        [[0, 'window_open', 'provider_accepted'], [0, 'follow_up', 'provider_accepted'], [1, 'window_open', 'provider_accepted']]);
      assert.equal(view.welfare.windows[0].state, 'due', 'the window state is unchanged by any reminder');
      assert.ok(!JSON.stringify(view.welfareReminders).includes('ExponentPushToken'), 'no tokens');
      const foreign = await api('GET', `/coverage/operations?shiftIds=${main.id}`, B.token);
      assert.equal(foreign.status, 200);
      assert.deepEqual(foreign.body.map((x: any) => x.operations), [], "another company sees nothing of A's shift");
    });

    await test('WPN-15-THE-SAFETY-SWEEP-IS-UNCHANGED', async () => {
      const before = await q(`SELECT type, count(*)::int n FROM safety_alerts GROUP BY type ORDER BY type`);
      await sweep.runMissedWelfareChecks();
      const after = await q(`SELECT type, count(*)::int n FROM safety_alerts GROUP BY type ORDER BY type`);
      assert.deepEqual(after, before, 'due windows with reminders raise nothing; reminders are not alerts');
      assert.equal(Number((await one(`SELECT count(*) n FROM safety_alerts WHERE "shiftId" = $1`, [main.id])).n), 0);
    });

    await test('WPN-16-THE-TIMER-IS-SINGLE-FLIGHT', async () => {
      const [a, b] = await Promise.all([push.triggerReminderJob(), push.triggerReminderJob()]);
      assert.equal([a, b].filter((o: any) => o.ran).length, 1);
    });

    await test('WPN-17-PASSWORD-RESET-REVOKES-AND-ACCOUNT-DELETION-REMOVES-DEVICES', async () => {
      const { revokePushDevicesForUser, removePushDevicesForUser } = await import('../src/welfare-push/push-device-lifecycle');
      const g17 = await guard('wpn-lifecycle');
      await device(g17, token(1700));
      await device(g17, token(1701));
      await ds.transaction((m) => revokePushDevicesForUser(m, g17.userId, 'password_change'));
      const rows = await q(`SELECT "revokedReason" why FROM push_devices WHERE "userId" = $1`, [g17.userId]);
      assert.deepEqual(rows.map((r: any) => r.why), ['password_change', 'password_change']);
      await ds.transaction((m) => removePushDevicesForUser(m, g17.userId));
      assert.equal((await q(`SELECT id FROM push_devices WHERE "userId" = $1`, [g17.userId])).length, 0);
      // Wired inside the same transactions that revoke every session.
      const src = (rel: string) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', rel), 'utf8');
      assert.match(src('src/auth/account-recovery.service.ts'),
        /await this\.sessions\.revokeAllForUser\(user\.id, 'password_change', manager\);\s*await revokePushDevicesForUser\(manager, user\.id, 'password_change'\);/);
      assert.match(src('src/auth/account-deletion.service.ts'),
        /await this\.sessions\.revokeAllForUser\(userId, 'account_deleted', manager\);\s*await removePushDevicesForUser\(manager, userId\);/);
    });

    await test('WPN-18-ONLY-ALLOWLISTED-COMPANIES-ARE-REMINDED-AND-THE-ALLOWLIST-FAILS-CLOSED', async () => {
      const { parseReminderCompanyIds } = await import('../src/welfare-push/welfare-push.service');
      assert.deepEqual(parseReminderCompanyIds('9'), [9]);
      assert.deepEqual(parseReminderCompanyIds(' 8, 9 ,9'), [8, 9]);
      for (const bad of [undefined, null, '', '   ', ',', 'all', '*', '9,abc', '9;8', '0', '-9', '9.5', '09', '1e3', '99999999999']) {
        assert.deepEqual(parseReminderCompanyIds(bad as never), [], `${JSON.stringify(bad)} names no company`);
      }

      // Switched on with no usable allowlist: the run reads no shift and sends nothing. The stub has no repositories, so
      // any read would throw.
      for (const ids of [undefined, '', 'all', '9,x']) {
        const closed = Object.create(WelfarePushService.prototype) as InstanceType<typeof WelfarePushService>;
        (closed as any).config = { get: (key: string) => (key === 'PUSH_WELFARE_REMINDERS_ENABLED' ? 'true' : ids) };
        assert.equal(closed.remindersEnabled(), true);
        assert.deepEqual(closed.reminderCompanyIds(), []);
        const counters = await closed.runReminderJob(new Date());
        assert.equal(counters.shiftsChecked, 0, `allowlist ${JSON.stringify(ids)} reminds no company`);
      }
      assert.deepEqual(push.reminderCompanyIds(), [9], 'this suite allows company 9 only');

      // Live: a Guard of company 9 and a Guard of company 8, both Booked On with a Welfare window open and a phone.
      const g9 = await guard('wpn-co9', A);
      const g8 = await guard('wpn-co8', B);
      await device(g9, token(1800));
      await device(g8, token(1801));
      const s9 = await liveShift(g9, 10 * MIN, 50 * MIN, 60, A);
      const s8 = await liveShift(g8, 10 * MIN, 50 * MIN, 60, B);
      assert.equal(A.id, 9);
      assert.equal(B.id, 8);
      await run(s9.S + 11 * MIN);
      assert.deepEqual((await reminders(s9.id)).map((r: any) => [r.kind, r.status]), [['window_open', 'provider_accepted']], 'company 9 is reminded');
      assert.equal(sentTo(s9.id).length, 1);
      assert.equal((await reminders(s8.id)).length, 0, 'company 8 gets no reminder row');
      assert.equal(sentTo(s8.id).length, 0, 'and nothing is sent to its Guard');
      // Company 8's Welfare Check itself is unchanged: still due, and the Guard can still record it in the app.
      const ops8 = (await api('GET', `/coverage/operations?shiftIds=${s8.id}`, B.token)).body[0];
      assert.equal(ops8.operations.welfareReminders?.length ?? 0, 0);
      const check = await api('POST', '/daily-logs', g8.token, { shiftId: s8.id, message: 'All quiet.', logType: 'welfare_check' });
      assert.equal(check.status, 201, `in-app check: ${check.status} ${JSON.stringify(check.body)}`);
    });
  } finally {
    await app.close();
    expoServer.close();
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
