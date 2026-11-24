/**
 * S4-EM-01 — the minimum reliable Emergency. Real PostgreSQL, the real Nest application, real HTTP, and a FAKE Expo
 * Push Service on 127.0.0.1 (no real notification can leave this machine).
 *
 *   EM-01  an Emergency needs no description: one request, CRITICAL, OPEN, the standard message, a receipt
 *   EM-02  the responsible people are notified in the alert's transaction: the owner account and ACTIVE Owner / Admin /
 *          Operations / Control Room members; never HR / Compliance, Finance, Viewer, a suspended member, another
 *          company or a Guard
 *   EM-03  a repeat press while the first is still OPEN returns the same alert (duplicate) and notifies nobody again
 *   EM-04  concurrent presses raise exactly one alert
 *   EM-05  once acknowledged, a new press is a genuinely new Emergency
 *   EM-06  responders see their company's Emergencies in /alerts/company; other roles and companies do not
 *   EM-07  Control Room acknowledges; the FIRST acknowledger is kept; the Guard can read the acknowledgement
 *   EM-08  resolving requires a reason and a note; the reason must be an Emergency reason
 *   EM-09  Finance, Viewer, HR / Compliance and another company cannot acknowledge or resolve
 *   EM-10  push is attempted to the responders' registered phones after the commit (emergency channel, high priority,
 *          identifiers only) and the outcome is audited separately from acknowledgement
 *   EM-11  a push provider outage never loses or delays the alert; the failure is audited
 *   EM-12  availability is unchanged: no live shift, another Guard's shift, or a company account: refused, nothing written
 *   EM-13  every other Guard-raised type still requires words; an older app's typed message is still accepted
 *   EM-14  the receipt never claims the Control Room received or acknowledged it, or that 999 was called
 *   EM-15  a process stop between the commit and the push: the alert and in-app notifications survive, and the owed
 *          push is visible in the audit trail as pending with no attempt
 *   EM-16  an ACTIVE Control Room membership whose own account is suspended, inactive or deleted is neither notified
 *          nor pushed (the same rule as sign-in)
 *   EM-17  request-level idempotency: a retry with the same Idempotency-Key is the same Emergency even after it was
 *          acknowledged; a new key is a new Emergency; another Guard's key matches nothing; a malformed key is ignored
 *   EM-18  owed-push recovery: an OPEN Emergency whose push was owed and never attempted is pushed once, between 60 s
 *          and 10 min old; too new, stale, acknowledged, already claimed or kill-switched ones are left alone
 *
 * Needs EMERGENCY_SPEC_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import * as http from 'node:http';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

const url = process.env.EMERGENCY_SPEC_DATABASE_URL;
if (!url) throw new Error('EMERGENCY_SPEC_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Emergency spec database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'emergency-spec-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.EXPO_ACCESS_TOKEN;
delete process.env.PUSH_EMERGENCY_ALERTS_ENABLED;
process.env.PUSH_WELFARE_REMINDERS_ENABLED = 'false';

let passed = 0;
const test = async (id: string, fn: () => Promise<void> | void) => {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
};

type Res = { status: number; body: any };
const HOUR = 3_600_000;
// Spec-only; never printed. The disposable database is dropped at the start of every run.
const PASSWORD = 'emergency-spec-only-password-1';
const pushToken = (n: number) => `ExponentPushToken[emspec${String(n).padStart(8, '0')}abcd]`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── The fake Expo Push Service ─────────────────────────────────────────────────────────────────────────
const fake = { mode: 'ok' as 'ok' | 'http500', sends: [] as any[][] };
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
      return reply(200, { data: (body as any[]).map((_, i) => ({ status: 'ok', id: `em-ticket-${fake.sends.length}-${i}` })) });
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
  await migrator.runMigrations({ transaction: 'each' });
  await migrator.destroy();

  const { AppModule } = await import('../src/app.module');
  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const { WelfarePushService } = await import('../src/welfare-push/welfare-push.service');
  const { AuthService } = await import('../src/auth/auth.service');
  const { EMERGENCY_DEFAULT_MESSAGE } = await import('../src/safety-alert/emergency-alert');
  const { EmergencyPushService } = await import('../src/safety-alert/emergency-push.service');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const base = `http://127.0.0.1:${address.port}`;
  const ds = app.get(DataSource);
  const [{ current_database: actualDatabase }] = await ds.query('SELECT current_database()');
  if (actualDatabase !== new URL(url!).pathname.slice(1)) throw new Error(`Refusing: connected to ${actualDatabase}`);
  app.get(SafetyAlertService).onModuleDestroy(); // no background sweeps in this spec
  app.get(WelfarePushService).onModuleDestroy();
  app.get(EmergencyPushService).onModuleDestroy(); // the owed-push recovery runs only when EM-18 calls it
  const auth = app.get(AuthService);

  const api = async (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params);
  const one = async <T = any>(sql: string, params: unknown[] = []): Promise<T> => (await q<T>(sql, params))[0];
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n);
  /** Wait for the after-commit push to settle (it is never awaited by the Guard's request). */
  const pushAudit = async (alertId: number) => {
    for (let i = 0; i < 100; i += 1) {
      const row = await one(`SELECT "afterData" FROM audit_logs WHERE action = 'safety_alert.emergency_push_attempted' AND "entityId" = $1`, [alertId]);
      if (row) return row.afterData;
      await sleep(50);
    }
    throw new Error(`no push audit for alert ${alertId}`);
  };

  try {
    const hash = await bcrypt.hash(PASSWORD, 4);
    const user = async (email: string, role: string) =>
      (await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName") VALUES ($1,$2,$3,'active',true,false,'Spec') RETURNING id`, [email, hash, role])).id as number;
    const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;
    const ROLES = ['admin', 'operations', 'control_room', 'hr_compliance', 'finance', 'viewer'] as const;
    const company = async (label: string, number: string) => {
      const ownerEmail = `${label}.owner@example.invalid`;
      const ownerId = await user(ownerEmail, 'company_admin');
      const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","verificationStatus") VALUES ($1,$2,$3,'1 Way','ops@example.invalid','approved') RETURNING id`, [ownerId, `${label} Ltd`, number]);
      const site = await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,$2,'2 Way') RETURNING id`, [id, `${label} Depot`]);
      const staff: Record<string, { userId: number; token: string }> = {};
      for (const role of ROLES) {
        const email = `${label}.${role}@example.invalid`;
        const userId = await user(email, 'company_staff');
        await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [userId, id, role]);
        staff[role] = { userId, token: await login(email) };
      }
      // A suspended Control Room member: responsible once, not now.
      const suspendedId = await user(`${label}.suspended@example.invalid`, 'company_staff');
      await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,'control_room','suspended')`, [suspendedId, id]);
      return { id: id as number, ownerId, siteId: site.id as number, token: await login(ownerEmail), staff, suspendedId };
    };
    const A = await company('emalpha', '81111111');
    const B = await company('embeta', '82222222');

    let n = 0;
    const guard = async (label: string, c: typeof A) => {
      n += 1;
      const email = `${label}@example.invalid`;
      const userId = await user(email, 'guard');
      const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,'07000000000') RETURNING id`,
        [userId, `${label} Guard`, `91000000000000${String(n).padStart(2, '0')}`]);
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [c.id, id]);
      return { id: id as number, userId, token: await login(email) };
    };
    type G = Awaited<ReturnType<typeof guard>>;
    const shift = async (c: typeof A, g: G, status = 'in_progress') => {
      const start = new Date(Date.now() - HOUR);
      const { id } = await one(`INSERT INTO shifts ("companyId","siteId","siteName",status,"guardId",start,"end","checkCallIntervalMinutes") VALUES ($1,$2,$3,$4,$5,$6,$7,60) RETURNING id`,
        [c.id, c.siteId, 'Depot', status, g.id, start, new Date(start.getTime() + 8 * HOUR)]);
      return id as number;
    };
    const emergency = (g: G, shiftId: number, extra: Record<string, unknown> = {}) =>
      api('POST', '/alerts', g.token, { shiftId, type: 'panic', priority: 'critical', ...extra });
    const panicsOn = (shiftId: number) => count(`SELECT count(*)::int n FROM safety_alerts WHERE "shiftId" = $1 AND type::text = 'panic'`, [shiftId]);
    const notesFor = (alertTitleLike: string) => q(`SELECT "userId", "companyId", title, message FROM notifications WHERE title LIKE $1 ORDER BY "userId"`, [alertTitleLike]);
    const RESPONDERS_A = () => [A.ownerId, A.staff.admin.userId, A.staff.operations.userId, A.staff.control_room.userId].sort((x, y) => x - y);

    const g1 = await guard('emg1', A);
    const s1 = await shift(A, g1);

    let first: any;
    await test('EM-01-AN-EMERGENCY-NEEDS-NO-DESCRIPTION', async () => {
      const r = await emergency(g1, s1);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      first = r.body;
      assert.equal(r.body.type, 'panic');
      assert.equal(r.body.priority, 'critical');
      assert.equal(r.body.status, 'open');
      assert.equal(r.body.message, EMERGENCY_DEFAULT_MESSAGE);
      assert.equal(r.body.emergencyReceipt.duplicate, false);
      assert.equal(r.body.emergencyReceipt.acknowledged, false);
      assert.ok(Date.parse(r.body.emergencyReceipt.receivedAt) > Date.now() - 60_000, 'received just now');
      assert.equal(r.body.emergencyReceipt.responsiblePeopleNotified, 4);
      assert.equal(r.body.emergencyReceipt.pushDevicesTargeted, 0, 'nobody has a registered phone yet');
      assert.equal(await panicsOn(s1), 1);
    });

    await test('EM-02-RESPONSIBLE-PEOPLE-ARE-NOTIFIED-IN-THE-SAME-TRANSACTION-AND-NOBODY-ELSE', async () => {
      const notes = await notesFor('EMERGENCY%');
      assert.deepEqual(notes.map((x: any) => x.userId), RESPONDERS_A(), 'owner, admin, operations, control room');
      assert.ok(notes.every((x: any) => x.companyId === A.id));
      for (const excluded of [A.staff.hr_compliance.userId, A.staff.finance.userId, A.staff.viewer.userId, A.suspendedId, g1.userId, B.ownerId, B.staff.control_room.userId]) {
        assert.ok(!notes.some((x: any) => x.userId === excluded), `user ${excluded} is not notified`);
      }
      assert.match(notes[0].message, /emg1 Guard raised an Emergency at emalpha Depot/);
      const audit = await one(`SELECT "userId","companyId","afterData" FROM audit_logs WHERE action = 'safety_alert.created' AND "entityId" = $1`, [first.id]);
      assert.equal(audit.userId, g1.userId);
      assert.equal(audit.companyId, A.id);
      assert.equal(audit.afterData.responsiblePeopleNotified, 4);
      const push = await pushAudit(first.id);
      assert.equal(push.skipped, 'no_devices');
    });

    await test('EM-03-A-REPEAT-PRESS-WHILE-OPEN-RETURNS-THE-SAME-EMERGENCY', async () => {
      const notesBefore = (await notesFor('EMERGENCY%')).length;
      const r = await emergency(g1, s1);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.id, first.id, 'the same alert');
      assert.equal(r.body.emergencyReceipt.duplicate, true);
      assert.equal(await panicsOn(s1), 1, 'no second alert');
      assert.equal((await notesFor('EMERGENCY%')).length, notesBefore, 'nobody notified again');
      assert.equal(await count(`SELECT count(*)::int n FROM audit_logs WHERE action = 'safety_alert.emergency_repeat_press' AND "entityId" = $1`, [first.id]), 1, 'the repeat is recorded');
    });

    await test('EM-04-CONCURRENT-PRESSES-RAISE-EXACTLY-ONE-EMERGENCY', async () => {
      const g4 = await guard('emg4', A);
      const s4 = await shift(A, g4);
      const taps = await Promise.all([1, 2, 3, 4, 5].map(() => emergency(g4, s4)));
      assert.deepEqual(taps.map((t) => t.status), [201, 201, 201, 201, 201], JSON.stringify(taps.map((t) => t.body)));
      assert.equal(new Set(taps.map((t) => t.body.id)).size, 1, 'one alert id');
      assert.equal(taps.filter((t) => !t.body.emergencyReceipt.duplicate).length, 1, 'exactly one raised');
      assert.equal(await panicsOn(s4), 1);
      assert.equal(await count(`SELECT count(*)::int n FROM audit_logs WHERE action = 'safety_alert.created' AND "entityId" = $1`, [taps[0].body.id]), 1);
    });

    await test('EM-05-ONCE-ACKNOWLEDGED-A-NEW-PRESS-IS-A-NEW-EMERGENCY', async () => {
      const g5 = await guard('emg5', A);
      const s5 = await shift(A, g5);
      const a = await emergency(g5, s5);
      assert.equal((await api('PATCH', `/alerts/${a.body.id}/ack`, A.staff.control_room.token)).status, 200);
      const b = await emergency(g5, s5);
      assert.equal(b.status, 201);
      assert.notEqual(b.body.id, a.body.id, 'a genuinely new Emergency');
      assert.equal(b.body.emergencyReceipt.duplicate, false);
      assert.equal(await panicsOn(s5), 2);
    });

    await test('EM-06-RESPONDERS-SEE-THEIR-COMPANYS-EMERGENCIES-AND-NOBODY-ELSE-DOES', async () => {
      for (const role of ['admin', 'operations', 'control_room'] as const) {
        const list = await api('GET', '/alerts/company', A.staff[role].token);
        assert.equal(list.status, 200, role);
        assert.ok(list.body.some((a: any) => a.id === first.id), `${role} sees the Emergency`);
        assert.ok(list.body.every((a: any) => a.company?.id === A.id), `${role} sees only its company`);
      }
      for (const role of ['hr_compliance', 'viewer'] as const) {
        const list = await api('GET', '/alerts/company', A.staff[role].token);
        assert.ok(list.status === 200 || list.status === 404, role);
        assert.ok(!(list.body ?? []).some?.((a: any) => a.type === 'panic'), `${role} does not see Emergencies`);
      }
      const other = await api('GET', '/alerts/company', B.staff.control_room.token);
      assert.ok(!(other.body ?? []).some((a: any) => a.id === first.id), 'another company never sees it');
    });

    await test('EM-07-CONTROL-ROOM-ACKNOWLEDGES-THE-FIRST-ACKNOWLEDGER-IS-KEPT-AND-THE-GUARD-CAN-SEE-IT', async () => {
      const mineBefore = await api('GET', '/alerts/mine', g1.token);
      assert.equal(mineBefore.body.find((a: any) => a.id === first.id).status, 'open', 'before: not acknowledged');
      const ack = await api('PATCH', `/alerts/${first.id}/ack`, A.staff.control_room.token);
      assert.equal(ack.status, 200, JSON.stringify(ack.body));
      assert.equal(ack.body.status, 'acknowledged');
      assert.equal(ack.body.acknowledgedByUserId, A.staff.control_room.userId);
      const again = await api('PATCH', `/alerts/${first.id}/ack`, A.staff.operations.token);
      assert.equal(again.status, 200);
      assert.equal(again.body.acknowledgedByUserId, A.staff.control_room.userId, 'the first acknowledger is kept');
      assert.equal(await count(`SELECT count(*)::int n FROM audit_logs WHERE action = 'safety_alert.acknowledged' AND "entityId" = $1`, [first.id]), 1);
      const mine = await api('GET', '/alerts/mine', g1.token);
      const seen = mine.body.find((a: any) => a.id === first.id);
      assert.equal(seen.status, 'acknowledged');
      assert.ok(seen.acknowledgedAt, 'the Guard can tell a person has taken it up');
    });

    await test('EM-08-RESOLVING-REQUIRES-A-REASON-AND-A-NOTE', async () => {
      const t = A.staff.operations.token;
      const bare = await api('PATCH', `/alerts/${first.id}/close`, t, {});
      assert.equal(bare.status, 400, 'no bare close');
      assert.match(bare.body.message, /resolution reason/i);
      assert.equal((await api('PATCH', `/alerts/${first.id}/close`, t, { resolutionReason: 'guard_confirmed_safe' })).status, 400, 'a note is mandatory');
      assert.equal((await api('PATCH', `/alerts/${first.id}/close`, t, { resolutionReason: 'request_completed', resolutionNote: 'x' })).status, 400, 'not an Emergency reason');
      const reasons = await api('GET', `/alerts/${first.id}/resolution-reasons`, t);
      assert.equal(reasons.status, 200);
      const closed = await api('PATCH', `/alerts/${first.id}/close`, t, { resolutionReason: 'guard_confirmed_safe', resolutionNote: 'Called the Guard; safe, intruder left.' });
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      assert.equal(closed.body.status, 'closed');
      assert.equal(closed.body.closedByUserId, A.staff.operations.userId);
      assert.equal(closed.body.acknowledgedByUserId, A.staff.control_room.userId, 'acknowledgement kept');
      const audits = await q(`SELECT action FROM audit_logs WHERE "entityType" = 'safety_alert' AND "entityId" = $1 AND action LIKE 'safety_alert.%' ORDER BY id`, [first.id]);
      assert.deepEqual(audits.map((a: any) => a.action).filter((a: string) => !a.startsWith('safety_alert.emergency_push_')),
        ['safety_alert.created', 'safety_alert.emergency_repeat_press', 'safety_alert.acknowledged', 'safety_alert.closed']);
    });

    await test('EM-09-OTHER-ROLES-AND-OTHER-COMPANIES-CANNOT-ACT', async () => {
      const g9 = await guard('emg9', A);
      const s9 = await shift(A, g9);
      const r = await emergency(g9, s9);
      for (const role of ['hr_compliance', 'finance', 'viewer'] as const) {
        assert.equal((await api('PATCH', `/alerts/${r.body.id}/ack`, A.staff[role].token)).status, 403, role);
        assert.equal((await api('PATCH', `/alerts/${r.body.id}/close`, A.staff[role].token, { resolutionReason: 'false_activation', resolutionNote: 'x' })).status, 403, role);
      }
      assert.equal((await api('PATCH', `/alerts/${r.body.id}/ack`, B.staff.control_room.token)).status, 400, 'another company');
      assert.equal((await api('PATCH', `/alerts/${r.body.id}/ack`, B.token)).status, 400, 'another company owner');
      assert.equal((await api('PATCH', `/alerts/${r.body.id}/ack`, g9.token)).status, 403, 'a Guard');
      assert.equal((await one(`SELECT status::text s FROM safety_alerts WHERE id = $1`, [r.body.id])).s, 'open', 'untouched');
      // Owner account and Admin membership keep acting.
      assert.equal((await api('PATCH', `/alerts/${r.body.id}/ack`, A.staff.admin.token)).status, 200);
      assert.equal((await api('PATCH', `/alerts/${r.body.id}/close`, A.token, { resolutionReason: 'false_activation', resolutionNote: 'Pressed by mistake; Guard confirmed by phone.' })).status, 200);
    });

    await test('EM-10-PUSH-IS-ATTEMPTED-TO-RESPONDERS-PHONES-AFTER-THE-COMMIT', async () => {
      // The Control Room member and the owner register their phones; HR registers too but is not responsible.
      assert.equal((await api('POST', '/push-devices', A.staff.control_room.token, { token: pushToken(1), platform: 'android' })).status, 200);
      assert.equal((await api('POST', '/push-devices', A.token, { token: pushToken(2), platform: 'ios' })).status, 200);
      assert.equal((await api('POST', '/push-devices', A.staff.hr_compliance.token, { token: pushToken(3), platform: 'android' })).status, 200);
      assert.equal((await api('POST', '/push-devices', A.staff.finance.token, { token: 'not-a-token', platform: 'android' })).status, 400, 'not a push token');
      fake.sends.length = 0;
      fake.mode = 'ok';
      const g10 = await guard('emg10', A);
      const s10 = await shift(A, g10);
      const r = await emergency(g10, s10);
      assert.equal(r.status, 201);
      assert.equal(r.body.emergencyReceipt.pushDevicesTargeted, 2);
      const outcome = await pushAudit(r.body.id);
      assert.deepEqual({ devices: outcome.devices, accepted: outcome.providerAccepted, failed: outcome.transportFailed }, { devices: 2, accepted: 2, failed: false });
      const sent = fake.sends.flat();
      assert.deepEqual(sent.map((m) => m.to).sort(), [pushToken(1), pushToken(2)].sort(), 'only responders’ phones');
      for (const m of sent) {
        assert.equal(m.channelId, 'emergency-alerts');
        assert.equal(m.priority, 'high');
        assert.deepEqual(m.data, { kind: 'emergency_alert', alertId: r.body.id }, 'identifiers only');
        assert.match(m.body, /emg10 Guard raised an Emergency/);
      }
      // A provider accepting a push is not a person acknowledging it.
      assert.equal((await one(`SELECT status::text s FROM safety_alerts WHERE id = $1`, [r.body.id])).s, 'open');
      const audit = JSON.stringify(outcome);
      assert.doesNotMatch(audit, /ExponentPushToken/, 'no token in the audit');
    });

    await test('EM-11-A-PUSH-OUTAGE-NEVER-LOSES-THE-EMERGENCY', async () => {
      fake.mode = 'http500';
      const g11 = await guard('emg11', A);
      const s11 = await shift(A, g11);
      const r = await emergency(g11, s11);
      assert.equal(r.status, 201, 'the Guard is told S4 received it');
      assert.equal(await panicsOn(s11), 1);
      const outcome = await pushAudit(r.body.id);
      assert.equal(outcome.transportFailed, true, 'the failure is recorded');
      assert.ok(await one(`SELECT 1 FROM audit_logs WHERE action = 'safety_alert.emergency_push_pending' AND "entityId" = $1`, [r.body.id]), 'owed before it was attempted');
      assert.equal((await notesFor('EMERGENCY%')).filter((x: any) => x.message.includes('emg11')).length, 4, 'in-app notifications committed regardless');
      fake.mode = 'ok';
    });

    await test('EM-12-AVAILABILITY-IS-UNCHANGED', async () => {
      const g12 = await guard('emg12', A);
      const scheduled = await shift(A, g12, 'scheduled');
      const other = await guard('emg12b', A);
      const otherShift = await shift(A, other);
      for (const [label, r] of [
        ['no live shift', await emergency(g12, scheduled)],
        ['another Guard’s shift', await emergency(g12, otherShift)],
        ['no shift at all', await api('POST', '/alerts', g12.token, { type: 'panic' })],
      ] as const) {
        assert.equal(r.status, 400, `${label}: ${r.status} ${JSON.stringify(r.body)}`);
      }
      assert.equal((await api('POST', '/alerts', A.token, { shiftId: otherShift, type: 'panic' })).status, 403, 'a company account cannot use the Guard route');
      assert.equal(await panicsOn(scheduled) + await panicsOn(otherShift), 0, 'nothing written');
    });

    await test('EM-13-OTHER-TYPES-STILL-NEED-WORDS-AND-AN-OLDER-APPS-TYPED-MESSAGE-IS-ACCEPTED', async () => {
      const g13 = await guard('emg13', A);
      const s13 = await shift(A, g13);
      assert.equal((await api('POST', '/alerts', g13.token, { shiftId: s13, type: 'site_request' })).status, 400, 'a Site Request needs words');
      assert.equal((await api('POST', '/alerts', g13.token, { shiftId: s13, type: 'site_request', message: '   ' })).status, 400);
      assert.equal((await api('POST', '/alerts', g13.token, { shiftId: s13, type: 'site_request', message: 'Fuel for the generator' })).status, 201);
      const legacy = await emergency(g13, s13, { message: 'Emergency alert raised by guard from the mobile app.' });
      assert.equal(legacy.status, 201);
      assert.equal(legacy.body.message, 'Emergency alert raised by guard from the mobile app.', 'kept as sent');
      assert.equal((await api('POST', '/alerts', g13.token, { shiftId: s13, type: 'panic', message: 'x'.repeat(1001) })).status, 400, 'bounded');
    });

    await test('EM-14-THE-RECEIPT-NEVER-OVERCLAIMS', async () => {
      const g14 = await guard('emg14', A);
      const s14 = await shift(A, g14);
      const r = await emergency(g14, s14);
      const text = JSON.stringify(r.body.emergencyReceipt);
      assert.doesNotMatch(text, /control room|acknowledged":true|999|police|ambulance|emergency services/i);
      assert.deepEqual(Object.keys(r.body.emergencyReceipt).sort(), ['acknowledged', 'duplicate', 'pushDevicesTargeted', 'receivedAt', 'responsiblePeopleNotified']);
    });

    await test('EM-15-A-PROCESS-STOP-AFTER-COMMIT-LOSES-NOTHING-AND-THE-OWED-PUSH-IS-VISIBLE', async () => {
      // Simulated: the dispatch after the commit never runs (the process stopped). Nothing in the request waits for it.
      const push = app.get(EmergencyPushService);
      const realDispatch = push.dispatch.bind(push);
      (push as any).dispatch = async () => undefined;
      try {
        const g15 = await guard('emg15', A);
        const s15 = await shift(A, g15);
        const r = await emergency(g15, s15);
        assert.equal(r.status, 201);
        assert.equal(await panicsOn(s15), 1, 'the alert is committed');
        assert.equal((await notesFor('EMERGENCY%')).filter((x: any) => x.message.includes('emg15')).length, 4, 'in-app notifications committed');
        const pending = await one(`SELECT "afterData" FROM audit_logs WHERE action = 'safety_alert.emergency_push_pending' AND "entityId" = $1`, [r.body.id]);
        assert.ok(pending, 'the owed push is recorded in the same transaction');
        assert.equal(pending.afterData.devices, r.body.emergencyReceipt.pushDevicesTargeted);
        await sleep(300);
        assert.equal(await count(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'safety_alert.emergency_push_attempted' AND "entityId" = $1`, [r.body.id]), 0,
          'pending with no attempt: detectable, not silent');
      } finally {
        (push as any).dispatch = realDispatch;
      }
    });

    await test('EM-16-AN-ACCOUNT-THAT-CANNOT-SIGN-IN-IS-NEVER-A-RECIPIENT', async () => {
      const C = await company('emgamma', '83333333');
      const blocked: number[] = [];
      for (const [label, sql] of [
        ['suspended', `UPDATE users SET status = 'suspended' WHERE id = $1`],
        ['inactive', `UPDATE users SET status = 'inactive' WHERE id = $1`],
        ['deleted', `UPDATE users SET "deletionCompletedAt" = now() WHERE id = $1`],
      ] as const) {
        const id = await user(`emgamma.${label}.cr@example.invalid`, 'company_staff');
        await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,'control_room','active')`, [id, C.id]);
        await q(`INSERT INTO push_devices ("userId",token,platform) VALUES ($1,$2,'android')`, [id, `ExponentPushToken[emgamma-${label}]`]);
        await q(sql, [id]);
        blocked.push(id);
      }
      const g16 = await guard('emg16', C);
      const s16 = await shift(C, g16);
      const r = await emergency(g16, s16);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.emergencyReceipt.responsiblePeopleNotified, 4, 'owner, admin, operations, control room only');
      assert.equal(r.body.emergencyReceipt.pushDevicesTargeted, 0, 'no blocked account’s phone is targeted');
      const got = (await q(`SELECT "userId" FROM notifications WHERE "companyId" = $1 AND title LIKE 'EMERGENCY%'`, [C.id])).map((x: any) => Number(x.userId));
      for (const id of blocked) assert.ok(!got.includes(id), `account ${id} cannot sign in, so is not notified`);
    });

    await test('EM-17-A-RETRY-WITH-THE-SAME-REQUEST-KEY-IS-NEVER-A-SECOND-EMERGENCY-A-NEW-KEY-IS', async () => {
      const g17 = await guard('emg17', A);
      const s17 = await shift(A, g17);
      const key = (n: number) => `em-spec-request-key-${String(n).padStart(4, '0')}`;
      const send = (k?: string) => api('POST', '/alerts', g17.token, { shiftId: s17, type: 'panic', priority: 'critical' }, k ? { 'Idempotency-Key': k } : {});
      const first = await send(key(1));
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.emergencyReceipt.duplicate, false);
      // Acknowledged before the Guard's retry arrives: the window rule alone would raise a second alert; the key does not.
      assert.equal((await api('PATCH', `/alerts/${first.body.id}/ack`, A.staff.control_room.token)).status, 200);
      const retry = await send(key(1));
      assert.equal(retry.status, 201);
      assert.equal(retry.body.id, first.body.id, 'the same Emergency');
      assert.equal(retry.body.emergencyReceipt.duplicate, true);
      assert.equal(retry.body.emergencyReceipt.acknowledged, true, 'and its real state');
      assert.equal(await panicsOn(s17), 1);
      const matched = await one(`SELECT "afterData" FROM audit_logs WHERE action = 'safety_alert.emergency_repeat_press' AND "entityId" = $1 ORDER BY id DESC LIMIT 1`, [first.body.id]);
      assert.equal(matched.afterData.matchedBy, 'request_key');
      // A genuinely new Emergency (new key) after the first was acknowledged: raised.
      const fresh = await send(key(2));
      assert.equal(fresh.body.emergencyReceipt.duplicate, false);
      assert.notEqual(fresh.body.id, first.body.id);
      assert.equal(await panicsOn(s17), 2);
      // A new key while the newest is still OPEN and inside the window: the window still answers (one open Emergency).
      const second = await send(key(3));
      assert.equal(second.body.id, fresh.body.id);
      // Another Guard cannot reach an Emergency through someone else's key.
      const gOther = await guard('emg17b', A);
      const sOther = await shift(A, gOther);
      const other = await api('POST', '/alerts', gOther.token, { shiftId: sOther, type: 'panic', priority: 'critical' }, { 'Idempotency-Key': key(1) });
      assert.equal(other.body.emergencyReceipt.duplicate, false);
      assert.notEqual(other.body.id, first.body.id);
      // A malformed key is ignored, never refused.
      const g17c = await guard('emg17c', A);
      const s17c = await shift(A, g17c);
      const bad = await api('POST', '/alerts', g17c.token, { shiftId: s17c, type: 'panic', priority: 'critical' }, { 'Idempotency-Key': 'bad key!' });
      assert.equal(bad.status, 201);
      assert.equal(bad.body.emergencyReceipt.duplicate, false);
      const created = await one(`SELECT "afterData" FROM audit_logs WHERE action = 'safety_alert.created' AND "entityId" = $1`, [bad.body.id]);
      assert.equal(created.afterData.requestKey, undefined);
    });

    await test('EM-18-AN-OWED-PUSH-IS-RECOVERED-ONCE-WITHIN-ITS-WINDOW-AND-NEVER-LATE-OR-TWICE', async () => {
      const push = app.get(EmergencyPushService);
      const realDispatch = push.dispatch.bind(push);
      const owed = async (label: string) => {
        (push as any).dispatch = async () => undefined; // the process "stops" before the dispatch
        try {
          const g = await guard(label, A);
          const s = await shift(A, g);
          const r = await emergency(g, s);
          assert.equal(r.status, 201);
          return r.body.id as number;
        } finally {
          (push as any).dispatch = realDispatch;
        }
      };
      const age = (id: number, seconds: number) => q(`UPDATE safety_alerts SET "createdAt" = now() - ($2 || ' seconds')::interval WHERE id = $1`, [id, String(seconds)]);
      const fresh = await owed('emg18a'); // 0 s old: a dispatch could still be in flight
      const due = await owed('emg18b'); await age(due, 90);
      const stale = await owed('emg18c'); await age(stale, 11 * 60);
      const acked = await owed('emg18d'); await age(acked, 90);
      assert.equal((await api('PATCH', `/alerts/${acked}/ack`, A.staff.control_room.token)).status, 200);
      // Earlier tests' Emergencies (EM-15's is owed too) are closed so only these four are candidates.
      await q(`UPDATE safety_alerts SET status = 'closed' WHERE type::text = 'panic' AND id NOT IN ($1,$2,$3,$4)`, [fresh, due, stale, acked]);
      fake.mode = 'ok';
      fake.sends.length = 0;
      const recovered = await push.recoverOwedPushes();
      assert.equal(recovered, 1, 'only the open, 90-second-old Emergency');
      const outcome = await pushAudit(due);
      assert.ok(outcome.devices >= 1 && outcome.providerAccepted === outcome.devices, JSON.stringify(outcome));
      const recoveryRow = await one(`SELECT "afterData" FROM audit_logs WHERE action = 'safety_alert.emergency_push_recovery' AND "entityId" = $1`, [due]);
      assert.ok(recoveryRow && recoveryRow.afterData.ageSeconds >= 60, 'the late recovery is recorded with its age');
      const sentOnce = fake.sends.flat().length;
      assert.equal(sentOnce, outcome.devices);
      for (const id of [fresh, stale, acked]) {
        assert.equal(await count(`SELECT count(*)::int n FROM audit_logs WHERE "entityId" = $1 AND action IN ('safety_alert.emergency_push_recovery','safety_alert.emergency_push_attempted')`, [id]), 0,
          `alert ${id}: not recovered (too new, stale or already acknowledged)`);
      }
      // Never twice: a second run, and a recovery claimed but interrupted before its dispatch, are both left alone.
      assert.equal(await push.recoverOwedPushes(), 0);
      assert.equal(fake.sends.flat().length, sentOnce);
      await age(fresh, 90);
      await q(`INSERT INTO audit_logs (action, "entityType", "entityId", "afterData") VALUES ('safety_alert.emergency_push_recovery', 'safety_alert', $1, '{}')`, [fresh]);
      assert.equal(await push.recoverOwedPushes(), 0, 'a claimed recovery is never repeated');
      // Kill switch: nothing is claimed while emergency push is off.
      const off = await owed('emg18e'); await age(off, 90);
      (push as any).enabled = () => false;
      try { assert.equal(await push.recoverOwedPushes(), 0); } finally { (push as any).enabled = EmergencyPushService.prototype.enabled.bind(push); }
      assert.equal(await count(`SELECT count(*)::int n FROM audit_logs WHERE "entityId" = $1 AND action = 'safety_alert.emergency_push_recovery'`, [off]), 0);
    });
  } finally {
    await app.close();
    expoServer.close();
  }

  console.log(JSON.stringify({ event: 'emergency_alert_certified', tests: passed }));
}

main().catch((error) => {
  console.error('FAIL ', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
