/**
 * Guard shift notifications (in-app notice + OS push) — certification over real HTTP with real authorisation, on a
 * disposable database built from the repository's own migrations (head 66), with a local fake of the Expo Push
 * Service. Nothing leaves this machine.
 *
 *   GN-01  the switch: only exactly "true" (trimmed, any case) enables the push; default off
 *   GN-02  a rota assignment offers the shift: one in-app notice and one push per active device, with the exact payload
 *          contract (title, body, data, channel, no category, normal priority, TTL to the shift start); revoked
 *          devices are never used
 *   GN-03  the other offer paths: POST /shifts with a Guard, assign-multiple, PATCH reassignment of an unfilled shift
 *   GN-04  withdrawn: PATCH status cancelled ("Withdraw offer") on an offered shift, cancelling an accepted rota
 *          position, cancelling a slot with offered and accepted positions; unfilled positions notify nobody
 *   GN-05  re-acceptance: a material change to an accepted shift (PATCH, and a rota slot time change)
 *   GN-06  Live Shift Amendments: requested (directly, and when an approval-required proposal is approved), withdrawn,
 *          staff-recorded agreement, dispute reviewed — the Guard's existing notices unchanged, each pushed once with the
 *          amendment id; the confirmation email unchanged; notices to staff (declined, expired, disputed) never pushed;
 *          Book Off voiding writes no notice and pushes nothing
 *   GN-07  idempotent: concurrent and repeated calls for one event write one notice and send once; concurrent delivery
 *          of one dispatch sends once; a rolled-back transaction writes and sends nothing
 *   GN-08  switch off: the in-app notice is still written; no push (skipped_disabled)
 *   GN-09  no active device: no_device, nothing sent
 *   GN-10  DeviceNotRegistered (ticket and receipt) revokes the device
 *   GN-11  Expo outage: the business action still succeeds and stays committed; the push is failed, then retried by
 *          the retry job (at most three attempts); a push recorded but never sent is picked up by the retry job
 *   GN-12  a shift that has already ended is never pushed (notice written, skipped_ended)
 *   GN-13  tenant isolation: company A's events never reach company B's Guard; a mismatched company or Guard is refused
 *   GN-14  company staff are never pushed, even with a device row
 *   GN-15  no personal data on the lock screen: no Guard name, phone, licence, email, site name, address or company
 *          name in any title or body; data carries identifiers only
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

const url = process.env.GUARD_NOTIFICATIONS_DATABASE_URL;
if (!url) throw new Error('GUARD_NOTIFICATIONS_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Guard notifications database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'guard-notifications-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.RESEND_API_KEY;
delete process.env.EXPO_ACCESS_TOKEN;
delete process.env.PUSH_WELFARE_REMINDERS_ENABLED;
process.env.PUSH_GUARD_NOTIFICATIONS_ENABLED = ' True ';

let passed = 0;
const failures: string[] = [];
const test = async (id: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failures.push(id);
    console.log(`FAIL  ${id}\n      ${String((error as Error)?.stack ?? error).split('\n').slice(0, 6).join('\n      ')}`);
  }
};

type Res = { status: number; body: any };
const MIN = 60_000;
const HOUR = 60 * MIN;
const PASSWORD = 'guard-notifications-spec-only-password-1';
const SITE_NAME = 'Harbour Gate Depot';
const SITE_ADDRESS = '17 Quayside Road';
const ukDay = (n: number) => {
  const [y, m, d] = complianceToday().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const iso = (ms: number) => new Date(ms).toISOString();
const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const token = (n: number) => `ExponentPushToken[gnspec${String(n).padStart(8, '0')}abc]`;
const londonWhen = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(ms));

// ── The fake Expo Push Service ─────────────────────────────────────────────────────────────────────────
type Mode = 'ok' | 'http500' | { notRegistered: string[] };
const fake = { mode: 'ok' as Mode, sends: [] as any[][], receiptMode: 'ok' as 'ok' | { notRegisteredTicket: string }, seq: 0 };
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
  assert.equal(migrated[migrated.length - 1]?.name, 'AddPatrolEvidenceStorage1720900000016', 'the head is Migration 70');
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
  const { GuardNotificationService, guardPushEnabled } = await import('../src/guard-notification/guard-notification.service');
  const { ShiftAmendmentService } = await import('../src/shift-amendment/shift-amendment.service');
  const gn = app.get(GuardNotificationService);
  const amendments = app.get(ShiftAmendmentService);
  // This process drives the retry job explicitly; its own timers must not race the assertions.
  clearInterval((gn as any).retryInterval);
  clearInterval((amendments as any).expiryInterval);
  const realConfig = (gn as any).config;
  const setSwitch = (value: string | undefined) => {
    (gn as any).config = { get: (key: string) => (key === 'PUSH_GUARD_NOTIFICATIONS_ENABLED' ? value : realConfig.get(key)) };
  };
  const restoreSwitch = () => { (gn as any).config = realConfig; };

  const api = async (method: string, path: string, tok: string | null, body?: unknown): Promise<Res> => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    // Every push is sent after the business commit, in the background: wait for it before asserting.
    await gn.drain();
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

    const company = async (label: string, number: string) => {
      const ownerEmail = `${label}.owner@example.invalid`;
      const ownerId = await user(ownerEmail, 'company_admin');
      const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,$2,$3,'1 Way','ops@example.invalid') RETURNING id`, [ownerId, `${label} Security Ltd`, number]);
      const siteId = (await one(`INSERT INTO sites ("companyId",name,address,timezone) VALUES ($1,$2,$3,'Europe/London') RETURNING id`, [id, SITE_NAME, SITE_ADDRESS])).id as number;
      return { id: id as number, ownerId, siteId, token: await login(ownerEmail), name: `${label} Security Ltd` };
    };
    const A = await company('gnalpha', '78555555');
    const B = await company('gnbeta', '78666666');
    const adminEmail = 'gn.platform.admin@example.invalid';
    await user(adminEmail, 'admin');
    const adminToken = await login(adminEmail);
    await api('PUT', `/admin/shift-amendments/companies/${A.id}`, adminToken, { enabled: true });

    let n = 0;
    const guards: Array<{ label: string; phone: string; licence: string; email: string }> = [];
    const guard = async (label: string, co = A) => {
      n += 1;
      const email = `${label}@example.invalid`;
      const userId = await user(email, 'guard');
      const licence = `84000000000000${String(n).padStart(2, '0')}`;
      const phone = `0770090${String(n).padStart(4, '0')}`;
      guards.push({ label, phone, licence, email });
      const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","siaExpiryDate","rightToWorkStatus",phone) VALUES ($1,$2,$3,$4,'british',$5) RETURNING id`,
        [userId, `${label} Fullname`, licence, ukDay(500), phone]);
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [co.id, id]);
      for (const type of ['sia_licence', 'right_to_work']) {
        await q(`INSERT INTO guard_documents ("guardId","companyId",type,"storageProvider","storageKey","originalFileName","mimeType","sizeBytes","uploadCompletedAt",verified,"uploadedByUserId","verifiedByUserId","verifiedAt")
          VALUES ($1,$2,$3,'s3-compatible',$4,'e.pdf','application/pdf','1024',now(),true,null,null,now())`, [id, co.id, type, `gn/${co.id}/${id}/${type}`]);
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
    const notices = (userId: number, type?: string) =>
      q(`SELECT id, type, title, message, "companyId" c FROM notifications WHERE "userId" = $1 ${type ? 'AND type = $2' : ''} ORDER BY id`, type ? [userId, type] : [userId]);
    const dispatches = (where: string, params: unknown[]) =>
      q(`SELECT id, "userId" u, "guardId" g, "companyId" c, "notificationId" nid, "shiftId" sid, "amendmentId" aid, type, "eventKey" k, status, attempts, "deviceCount" dc, error, "ticketIds" t, "receiptStatus" rs
           FROM guard_notification_dispatches WHERE ${where} ORDER BY id`, params);
    const sentFor = (notificationId: number) => fake.sends.flat().filter((m) => m.data?.notificationId === notificationId);
    const sentTo = (tok: string) => fake.sends.flat().filter((m) => m.to === tok);
    const slot = async (co: typeof A, startIn: number, hours = 8, count = 1) => {
      const start = Date.now() + startIn;
      const r = await api('POST', '/rota-slots', co.token, { siteId: co.siteId, startAt: iso(start), endAt: iso(start + hours * HOUR), requiredGuardCount: count });
      assert.equal(r.status, 201, `slot: ${r.status} ${JSON.stringify(r.body)}`);
      const shifts = await q(`SELECT id, start FROM shifts WHERE "rotaSlotId" = $1 ORDER BY id`, [r.body.id ?? r.body.slot?.id]);
      return { id: (r.body.id ?? r.body.slot?.id) as number, shiftIds: shifts.map((s: any) => Number(s.id)), start };
    };
    const assign = async (co: typeof A, slotId: number, shiftId: number, guardId: number) => {
      const r = await api('POST', `/rota-slots/${slotId}/assign`, co.token, { shiftId, guardId });
      assert.equal(r.status, 201, `assign: ${r.status} ${JSON.stringify(r.body)}`);
    };
    const accept = async (g: { token: string }, shiftId: number) => {
      const r = await api('PATCH', `/shifts/${shiftId}/respond`, g.token, { response: 'accepted' });
      assert.equal(r.status, 200, `accept: ${r.status} ${JSON.stringify(r.body)}`);
    };
    /** A booked-on shift of company A: start and end relative to now (ms). */
    const liveShift = async (g: { id: number; token: string }, startIn: number, endIn: number) => {
      const now = Date.now();
      const { id } = await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end","checkCallIntervalMinutes") VALUES ($1,$2,$3,$4,'ready',$5::timestamp,$6::timestamp,60) RETURNING id`,
        [A.id, A.siteId, SITE_NAME, g.id, ts(now + startIn), ts(now + endIn)]);
      const on = await api('POST', '/attendance/check-in', g.token, { shiftId: id });
      assert.equal(on.status, 201, `book on: ${on.status} ${JSON.stringify(on.body)}`);
      return id as number;
    };
    /** Exactly one notice of `type` for this shift's Guard, one dispatch, and one message per device: returns them. */
    const exactlyOne = async (g: { userId: number }, type: string, shiftId: number, devices: number) => {
      const rows = await dispatches(`"userId" = $1 AND type = $2 AND "shiftId" = $3`, [g.userId, type, shiftId]);
      assert.equal(rows.length, 1, `one ${type} dispatch for shift ${shiftId}: ${JSON.stringify(rows)}`);
      const [d] = rows;
      const notice = (await notices(g.userId, type)).find((x: any) => x.id === d.nid);
      assert.ok(notice, 'the dispatch points at the in-app notice it wrote');
      assert.equal(d.status, 'provider_accepted', JSON.stringify(d));
      const messages = sentFor(d.nid);
      assert.equal(messages.length, devices, `one push per active device: ${messages.length}`);
      return { d, notice, messages };
    };

    // The main Guard: two active devices and one revoked.
    const g = await guard('gn-main');
    await device(g, token(1), 'android');
    await device(g, token(2), 'ios');
    await device(g, token(3), 'android');
    await api('POST', '/push-devices/unregister', g.token, { token: token(3) });

    await test('GN-01-THE-SWITCH-IS-OFF-UNLESS-EXACTLY-TRUE', () => {
      for (const off of [undefined, null, '', ' ', 'false', 'yes', '1', 'on', 'enabled', 'truee', 't']) {
        assert.equal(guardPushEnabled(off as never), false, `${JSON.stringify(off)} is off`);
      }
      for (const on of ['true', 'TRUE', ' True ', '\ttrue\n']) assert.equal(guardPushEnabled(on), true, `${JSON.stringify(on)} is on`);
      assert.equal(gn.pushEnabled(), true, 'this suite turns it on explicitly');
    });

    let offeredShift = 0;
    let offeredSlot = 0;
    await test('GN-02-ROTA-OFFER-IN-APP-AND-PUSH-WITH-THE-EXACT-CONTRACT', async () => {
      const s = await slot(A, 24 * HOUR);
      offeredSlot = s.id;
      offeredShift = s.shiftIds[0];
      const before = Date.now();
      await assign(A, s.id, offeredShift, g.id);
      const { d, notice, messages } = await exactlyOne(g, 'shift_offered', offeredShift, 2);
      assert.deepEqual(messages.map((m) => m.to).sort(), [token(1), token(2)].sort(), 'active devices only; the revoked one is never used');
      const startMs = new Date((await one(`SELECT start FROM shifts WHERE id = $1`, [offeredShift])).start).getTime();
      for (const m of messages) {
        assert.equal(m.title, 'New shift offer');
        assert.equal(m.body, `You have a new shift offer for ${londonWhen(startMs)}. Open S4 to accept or decline.`);
        assert.match(m.body, /^You have a new shift offer for (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}, \d\d:\d\d\. Open S4 to accept or decline\.$/);
        assert.deepEqual(m.data, { kind: 'guard_notification', notificationId: notice.id, type: 'shift_offered', shiftId: offeredShift });
        assert.equal(m.channelId, 'shift-updates');
        assert.equal(m.priority, 'normal');
        assert.equal(m.sound, 'default');
        assert.ok(!('categoryId' in m), 'no category: no action buttons');
        const untilStart = Math.floor((startMs - before) / 1000);
        assert.ok(m.ttl > untilStart - 120 && m.ttl <= untilStart + 1, `TTL to the shift start: ${m.ttl} vs ${untilStart}`);
      }
      assert.equal(notice.title, 'New shift offer', 'the in-app notice says the same');
      assert.equal(notice.message, messages[0].body);
      assert.equal(notice.c, A.id);
      assert.equal(d.c, A.id);
      assert.equal(d.k.startsWith(`shift_offered:shift:${offeredShift}:tx:`), true);
      assert.equal(d.attempts, 1);
      assert.equal(d.dc, 2);
    });

    await test('GN-03-EVERY-OFFER-PATH-NOTIFIES', async () => {
      const g3 = await guard('gn-paths');
      await device(g3, token(30));
      // POST /shifts with a Guard (the company's direct create).
      const start = Date.now() + 30 * HOUR;
      const created = await api('POST', '/shifts', A.token, { siteId: A.siteId, guardId: g3.id, start: iso(start), end: iso(start + 6 * HOUR) });
      assert.equal(created.status, 201, `${created.status} ${JSON.stringify(created.body)}`);
      const createdId = created.body.shift.id;
      assert.equal(created.body.shift.status, 'offered');
      await exactlyOne(g3, 'shift_offered', createdId, 1);
      // assign-multiple.
      const s = await slot(A, 50 * HOUR, 6, 2);
      const g3b = await guard('gn-paths-b');
      await device(g3b, token(31));
      const multi = await api('POST', `/rota-slots/${s.id}/assign-multiple`, A.token, {
        assignments: [{ shiftId: s.shiftIds[0], guardId: g3.id }, { shiftId: s.shiftIds[1], guardId: g3b.id }],
      });
      assert.ok([200, 201].includes(multi.status), `${multi.status} ${JSON.stringify(multi.body)}`);
      await exactlyOne(g3, 'shift_offered', s.shiftIds[0], 1);
      await exactlyOne(g3b, 'shift_offered', s.shiftIds[1], 1);
      // PATCH: an unfilled ad-hoc shift given a Guard becomes an offer.
      const start2 = Date.now() + 70 * HOUR;
      const unfilled = await api('POST', '/shifts', A.token, { siteId: A.siteId, start: iso(start2), end: iso(start2 + 6 * HOUR) });
      assert.equal(unfilled.body.shift.status, 'unfilled');
      const patched = await api('PATCH', `/shifts/${unfilled.body.shift.id}`, A.token, { guardId: g3.id });
      assert.equal(patched.status, 200, `${patched.status} ${JSON.stringify(patched.body)}`);
      assert.equal(patched.body.status, 'offered');
      await exactlyOne(g3, 'shift_offered', unfilled.body.shift.id, 1);
      // An edit that changes nothing material on an offer sends nothing new.
      await api('PATCH', `/shifts/${unfilled.body.shift.id}`, A.token, { instructions: 'Bring a torch' });
      assert.equal((await dispatches(`"shiftId" = $1`, [unfilled.body.shift.id])).length, 1);
    });

    await test('GN-04-WITHDRAWN-OFFERS-AND-CANCELLED-POSITIONS', async () => {
      // Web "Withdraw offer": PATCH status cancelled on the offered shift from GN-02.
      const w = await api('PATCH', `/shifts/${offeredShift}`, A.token, { status: 'cancelled' });
      assert.equal(w.status, 200, `${w.status} ${JSON.stringify(w.body)}`);
      const { messages } = await exactlyOne(g, 'shift_offer_withdrawn', offeredShift, 2);
      assert.equal(messages[0].title, 'Shift withdrawn');
      assert.match(messages[0].body, /^Your shift on .+ has been withdrawn\. Open S4 for details\.$/);
      assert.equal(messages[0].data.type, 'shift_offer_withdrawn');
      assert.equal(messages[0].data.shiftId, offeredShift);
      // An accepted rota position cancelled before Book On.
      const g4 = await guard('gn-withdraw');
      await device(g4, token(40));
      const s = await slot(A, 26 * HOUR);
      await assign(A, s.id, s.shiftIds[0], g4.id);
      await accept(g4, s.shiftIds[0]);
      const c = await api('DELETE', `/rota-slots/${s.id}/positions/${s.shiftIds[0]}`, A.token);
      assert.equal(c.status, 200, `${c.status} ${JSON.stringify(c.body)}`);
      await exactlyOne(g4, 'shift_offer_withdrawn', s.shiftIds[0], 1);
      // Cancelling it again changes nothing and sends nothing.
      await api('DELETE', `/rota-slots/${s.id}/positions/${s.shiftIds[0]}`, A.token);
      assert.equal((await dispatches(`"shiftId" = $1 AND type = 'shift_offer_withdrawn'`, [s.shiftIds[0]])).length, 1);
      // A whole slot: one offered, one accepted, one unfilled position.
      const s2 = await slot(A, 28 * HOUR, 8, 3);
      const g4b = await guard('gn-withdraw-b');
      await device(g4b, token(41));
      await assign(A, s2.id, s2.shiftIds[0], g4.id);
      await assign(A, s2.id, s2.shiftIds[1], g4b.id);
      await accept(g4b, s2.shiftIds[1]);
      const cancel = await api('POST', `/rota-slots/${s2.id}/cancel`, A.token);
      assert.ok([200, 201].includes(cancel.status), `${cancel.status} ${JSON.stringify(cancel.body)}`);
      await exactlyOne(g4, 'shift_offer_withdrawn', s2.shiftIds[0], 1);
      await exactlyOne(g4b, 'shift_offer_withdrawn', s2.shiftIds[1], 1);
      assert.equal((await dispatches(`"shiftId" = $1`, [s2.shiftIds[2]])).length, 0, 'an unfilled position notifies nobody');
    });

    await test('GN-05-MATERIAL-CHANGE-NEEDS-RE-ACCEPTANCE', async () => {
      const g5 = await guard('gn-reaccept');
      await device(g5, token(50));
      const start = Date.now() + 40 * HOUR;
      const created = await api('POST', '/shifts', A.token, { siteId: A.siteId, guardId: g5.id, start: iso(start), end: iso(start + 6 * HOUR) });
      const id = created.body.shift.id;
      await accept(g5, id);
      const r = await api('PATCH', `/shifts/${id}`, A.token, { start: iso(start + HOUR), end: iso(start + 7 * HOUR) });
      assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.status, 'offered', 'back to the Guard (b3c13db)');
      const { messages } = await exactlyOne(g5, 'shift_reacceptance_required', id, 1);
      assert.equal(messages[0].title, 'Shift changed');
      assert.equal(messages[0].body, `Your shift on ${londonWhen(start + HOUR)} has changed. Open S4 to review it and accept it again.`, 'the revised time');
      assert.equal((await dispatches(`"shiftId" = $1 AND type = 'shift_offered'`, [id])).length, 1, 'the re-offer is not also a new offer');
      // A rota slot time change re-offers an accepted position.
      const s = await slot(A, 60 * HOUR);
      await assign(A, s.id, s.shiftIds[0], g5.id);
      await accept(g5, s.shiftIds[0]);
      const t = await api('PATCH', `/rota-slots/${s.id}/time`, A.token, { startAt: iso(s.start + 30 * MIN), endAt: iso(s.start + 8 * HOUR) });
      assert.equal(t.status, 200, `${t.status} ${JSON.stringify(t.body)}`);
      await exactlyOne(g5, 'shift_reacceptance_required', s.shiftIds[0], 1);
    });

    await test('GN-06-LIVE-SHIFT-AMENDMENTS', async () => {
      const g6 = await guard('gn-lsa');
      await device(g6, token(60));
      // Proposed and awaiting the Guard.
      const s1 = await liveShift(g6, -HOUR, 2 * HOUR);
      const end1 = new Date((await one(`SELECT "end" FROM shifts WHERE id = $1`, [s1])).end).getTime();
      const p = await api('POST', `/shifts/${s1}/amendments`, A.token, { proposedEnd: iso(end1 + HOUR), reason: 'Relief Guard delayed' });
      assert.equal(p.status, 201, `${p.status} ${JSON.stringify(p.body)}`);
      const aId = p.body.amendment.id;
      const req = await exactlyOne(g6, 'shift_amendment_requested', s1, 1);
      assert.equal(req.notice.title, 'Shift extension request', 'the existing notice, unchanged');
      assert.equal(req.notice.message, `Your company asks you to extend your shift to ${iso(end1 + HOUR)}. Open S4 to accept or decline before ${iso(end1)}.`);
      assert.equal(req.messages[0].title, 'Shift extension request');
      assert.equal(req.messages[0].body, 'Your company asks you to extend your current shift. Open S4 to accept or decline.');
      assert.deepEqual(req.messages[0].data, { kind: 'guard_notification', notificationId: req.notice.id, type: 'shift_amendment_requested', shiftId: s1, amendmentId: aId });
      assert.equal(req.d.k, `shift_amendment_requested:amendment:${aId}`);
      // Withdrawn while pending.
      const wd = await api('POST', `/shift-amendments/${aId}/withdraw`, A.token, { reason: 'Relief arrived' });
      assert.ok([200, 201].includes(wd.status), `${wd.status} ${JSON.stringify(wd.body)}`);
      const wdn = await exactlyOne(g6, 'shift_amendment_responded', s1, 1);
      assert.equal(wdn.notice.title, 'Shift extension withdrawn');
      assert.equal(wdn.notice.message, 'Your company withdrew its shift extension request. Your shift end is unchanged.');
      assert.equal(wdn.messages[0].body, 'There is an update about a shift extension. Open S4 for details.');
      assert.equal(wdn.messages[0].data.amendmentId, aId);

      // Approval-required: nothing to the Guard until approved, then requested once.
      const g6b = await guard('gn-lsa-approval');
      await device(g6b, token(61));
      const s2 = await liveShift(g6b, -HOUR, 2 * HOUR);
      const ap = await api('POST', `/shifts/${s2}/amendments`, A.token, { proposedEnd: iso(Date.now() + 14.5 * HOUR), reason: 'No relief' });
      assert.equal(ap.body.amendment.status, 'awaiting_approval');
      assert.equal((await dispatches(`"shiftId" = $1`, [s2])).length, 0, 'the Guard is not asked before approval');
      assert.equal(sentTo(token(61)).length, 0);
      const ok = await api('POST', `/shift-amendments/${ap.body.amendment.id}/approve`, A.token, { statement: 'Approved: no relief available', confirmSelfApproval: true });
      assert.ok([200, 201].includes(ok.status), `${ok.status} ${JSON.stringify(ok.body)}`);
      await exactlyOne(g6b, 'shift_amendment_requested', s2, 1);
      // Approving again is idempotent: nothing new.
      await api('POST', `/shift-amendments/${ap.body.amendment.id}/approve`, A.token, { statement: 'Approved again', confirmSelfApproval: true });
      assert.equal((await dispatches(`"shiftId" = $1`, [s2])).length, 1);
      // The Guard declines: the proposer (staff) gets the existing notice, never a push.
      const dec = await api('PATCH', `/shift-amendments/${ap.body.amendment.id}/respond`, g6b.token, { response: 'declined' });
      assert.equal(dec.status, 200);
      assert.equal((await notices(A.ownerId, 'shift_amendment_responded')).length >= 1, true, 'the proposer is told in the app, as before');

      // Staff-recorded verbal agreement: the Guard's notice and the confirmation email exactly as before, plus a push.
      const g6c = await guard('gn-lsa-verbal');
      await device(g6c, token(62));
      const s3 = await liveShift(g6c, -HOUR, 2 * HOUR);
      const end3 = new Date((await one(`SELECT "end" FROM shifts WHERE id = $1`, [s3])).end).getTime();
      const p3 = await api('POST', `/shifts/${s3}/amendments`, A.token, { proposedEnd: iso(end3 + HOUR), reason: 'Cover' });
      const v = await api('POST', `/shift-amendments/${p3.body.amendment.id}/record-verbal-agreement`, A.token, {
        agreedEnd: iso(end3 + HOUR), contactMethod: 'telephone', contactAt: iso(Date.now()), confirmation: 'Phoned the Guard, who agreed.', reason: 'Relief delayed',
      });
      assert.ok([200, 201].includes(v.status), `${v.status} ${JSON.stringify(v.body)}`);
      assert.equal(v.body.confirmationEmailStatus, 'captured_outbox', 'the confirmation email outcome is unchanged');
      const rec = await exactlyOne(g6c, 'shift_amendment_responded', s3, 1);
      assert.equal(rec.notice.title, 'Shift extension recorded by your company');
      assert.equal(rec.notice.message, `Your company recorded that you agreed by telephone to extend your shift to ${iso(end3 + HOUR)}. If you did not agree, report it in S4 or contact your company.`);
      assert.equal(rec.d.k, `shift_amendment_responded:amendment:${p3.body.amendment.id}:recorded`);
      // The Guard disputes: Owners/Admins get the existing notice (never pushed); the review answer is pushed to the Guard.
      const dsp = await api('POST', `/shift-amendments/${p3.body.amendment.id}/dispute`, g6c.token, { reason: 'I said maybe' });
      assert.ok([200, 201].includes(dsp.status), `${dsp.status} ${JSON.stringify(dsp.body)}`);
      const rv = await api('POST', `/shift-amendments/${p3.body.amendment.id}/resolve-dispute`, A.token, { resolution: 'upheld', note: 'Call log reviewed' });
      assert.ok([200, 201].includes(rv.status), `${rv.status} ${JSON.stringify(rv.body)}`);
      const reviewed = await dispatches(`"amendmentId" = $1 AND "eventKey" LIKE '%dispute_reviewed'`, [p3.body.amendment.id]);
      assert.equal(reviewed.length, 1);
      assert.equal(reviewed[0].status, 'provider_accepted');

      // Expiry: the proposer's notice only. Book Off voiding: no notice, no push.
      const g6d = await guard('gn-lsa-expiry');
      await device(g6d, token(63));
      const s4 = await liveShift(g6d, -HOUR, 2 * HOUR);
      const end4 = new Date((await one(`SELECT "end" FROM shifts WHERE id = $1`, [s4])).end).getTime();
      const p4 = await api('POST', `/shifts/${s4}/amendments`, A.token, { proposedEnd: iso(end4 + HOUR), reason: 'Cover' });
      await q(`UPDATE shift_amendments SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1`, [p4.body.amendment.id]);
      const expiredBefore = (await notices(A.ownerId, 'shift_amendment_expired')).length;
      await amendments.expireLapsedProposals();
      await gn.drain();
      assert.equal((await notices(A.ownerId, 'shift_amendment_expired')).length, expiredBefore + 1, 'the proposer is told, as before');
      assert.equal((await dispatches(`"amendmentId" = $1 AND type = 'shift_amendment_expired'`, [p4.body.amendment.id])).length, 0, 'no Guard notice exists, so nothing is pushed');
      const g6e = await guard('gn-lsa-void');
      await device(g6e, token(64));
      const s5 = await liveShift(g6e, -HOUR, 2 * HOUR);
      const end5 = new Date((await one(`SELECT "end" FROM shifts WHERE id = $1`, [s5])).end).getTime();
      await api('POST', `/shifts/${s5}/amendments`, A.token, { proposedEnd: iso(end5 + HOUR), reason: 'Cover' });
      const sentBefore = sentTo(token(64)).length;
      const noticesBefore = (await notices(g6e.userId)).length;
      const off = await api('POST', '/attendance/check-out', g6e.token, { shiftId: s5 });
      assert.ok([200, 201].includes(off.status), `book off: ${off.status}`);
      assert.equal((await one(`SELECT status FROM shift_amendments WHERE "shiftId" = $1`, [s5])).status, 'voided');
      assert.equal((await notices(g6e.userId)).length, noticesBefore, 'voiding writes no notice');
      assert.equal(sentTo(token(64)).length, sentBefore, 'and pushes nothing');
    });

    await test('GN-07-IDEMPOTENT-AND-CONCURRENCY-SAFE', async () => {
      const g7 = await guard('gn-idem');
      await device(g7, token(70));
      const start = Date.now() + 80 * HOUR;
      const { id } = await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,$3,$4,'offered',$5::timestamp,$6::timestamp) RETURNING id`,
        [A.id, A.siteId, SITE_NAME, g7.id, ts(start), ts(start + 6 * HOUR)]);
      const event = { companyId: A.id, guardId: g7.id, shiftId: id };
      // Concurrent calls for one event, in separate transactions.
      const results = await Promise.all([1, 2, 3, 4].map(() => ds.transaction((m) => gn.shiftOfferWithdrawn(m, event))));
      await gn.drain();
      assert.equal(results.filter(Boolean).length, 1, 'one call wins');
      assert.equal((await notices(g7.userId, 'shift_offer_withdrawn')).length, 1, 'one in-app notice');
      const [d] = await dispatches(`"shiftId" = $1`, [id]);
      assert.equal(sentFor(d.nid).length, 1, 'one push');
      // Repeated afterwards: nothing.
      assert.equal(await ds.transaction((m) => gn.shiftOfferWithdrawn(m, event)), null);
      assert.equal(await gn.deliver(d.id), null, 'a delivered push is never sent again');
      assert.equal(await gn.deliver(d.id, true), null);
      await gn.drain();
      assert.equal(sentFor(d.nid).length, 1);
      // Twice inside one transaction (one offer transition): one notice.
      const twice = await ds.transaction(async (m) => [await gn.shiftOffered(m, event), await gn.shiftOffered(m, event)]);
      await gn.drain();
      assert.ok(twice[0] && twice[1] === null);
      // Concurrent delivery of one recorded push: claimed once.
      const deliverInBackground = (gn as any).deliverInBackground;
      (gn as any).deliverInBackground = () => undefined;
      let held: any;
      try {
        held = await ds.transaction((m) => gn.shiftReacceptanceRequired(m, event));
      } finally {
        (gn as any).deliverInBackground = deliverInBackground;
      }
      const outcomes = await Promise.all([1, 2, 3].map(() => gn.deliver(held.dispatchId)));
      assert.deepEqual(outcomes.filter(Boolean), ['provider_accepted'], JSON.stringify(outcomes));
      assert.equal(sentFor(held.notificationId).length, 1, 'one push');
      // A rolled-back transaction writes nothing and sends nothing.
      const sendsBefore = fake.sends.length;
      await assert.rejects(() => ds.transaction(async (m) => {
        await gn.shiftOffered(m, event);
        throw new Error('business refusal');
      }), /business refusal/);
      await gn.drain();
      assert.equal(fake.sends.length, sendsBefore);
      assert.equal((await dispatches(`"shiftId" = $1 AND type = 'shift_offered'`, [id])).length, 1, 'only the committed offer');
    });

    await test('GN-08-SWITCH-OFF-STILL-WRITES-THE-IN-APP-NOTICE', async () => {
      const g8 = await guard('gn-off');
      await device(g8, token(80));
      setSwitch('false');
      try {
        const s = await slot(A, 90 * HOUR);
        await assign(A, s.id, s.shiftIds[0], g8.id);
        assert.equal((await notices(g8.userId, 'shift_offered')).length, 1, 'the in-app notice is written regardless');
        const [d] = await dispatches(`"shiftId" = $1`, [s.shiftIds[0]]);
        assert.equal(d.status, 'skipped_disabled');
        assert.equal(sentTo(token(80)).length, 0, 'nothing is pushed');
        // The retry job does nothing while the switch is off, and a skipped push is never sent later.
        const counters = await gn.runRetryJob();
        assert.equal(counters.retried, 0);
        setSwitch(undefined);
        assert.equal(gn.pushEnabled(), false, 'unset is off');
      } finally {
        restoreSwitch();
      }
      await gn.runRetryJob();
      assert.equal(sentTo(token(80)).length, 0, 'not sent once the switch is back on either');
    });

    await test('GN-09-NO-ACTIVE-DEVICE', async () => {
      const g9 = await guard('gn-nodevice');
      await device(g9, token(90));
      await api('POST', '/push-devices/unregister', g9.token, { token: token(90) });
      const s = await slot(A, 92 * HOUR);
      await assign(A, s.id, s.shiftIds[0], g9.id);
      const [d] = await dispatches(`"shiftId" = $1`, [s.shiftIds[0]]);
      assert.deepEqual([d.status, d.dc], ['no_device', 0]);
      assert.equal(sentTo(token(90)).length, 0, 'a revoked device is never used');
      assert.equal((await notices(g9.userId, 'shift_offered')).length, 1);
    });

    await test('GN-10-DEVICE-NOT-REGISTERED-REVOKES', async () => {
      const g10 = await guard('gn-dead');
      await device(g10, token(100));
      await device(g10, token(101));
      fake.mode = { notRegistered: [token(100)] };
      try {
        const s = await slot(A, 94 * HOUR);
        await assign(A, s.id, s.shiftIds[0], g10.id);
        const [d] = await dispatches(`"shiftId" = $1`, [s.shiftIds[0]]);
        assert.equal(d.status, 'provider_accepted', 'the other device still took it');
        assert.equal(d.error, 'DeviceNotRegistered');
        assert.equal((await one(`SELECT "revokedReason" why FROM push_devices WHERE token = $1`, [token(100)])).why, 'device_not_registered');
        // Receipts: DeviceNotRegistered there revokes too.
        fake.mode = 'ok';
        fake.receiptMode = { notRegisteredTicket: d.t[0].id };
        await q(`UPDATE guard_notification_dispatches SET "sentAt" = now() - interval '16 minutes' WHERE id = $1`, [d.id]);
        const counters = await gn.runRetryJob();
        assert.ok(counters.receiptsChecked >= 1);
        const [after] = await dispatches(`id = $1`, [d.id]);
        assert.equal(after.rs, 'provider_delivery_error');
        assert.equal((await one(`SELECT "revokedReason" why FROM push_devices WHERE token = $1`, [token(101)])).why, 'device_not_registered');
      } finally {
        fake.mode = 'ok';
        fake.receiptMode = 'ok';
      }
    });

    await test('GN-11-EXPO-OUTAGE-NEVER-FAILS-OR-ROLLS-BACK-THE-BUSINESS-ACTION', async () => {
      const g11 = await guard('gn-outage');
      await device(g11, token(110));
      const s = await slot(A, 96 * HOUR);
      fake.mode = 'http500';
      try {
        const r = await api('POST', `/rota-slots/${s.id}/assign`, A.token, { shiftId: s.shiftIds[0], guardId: g11.id });
        assert.equal(r.status, 201, 'the assignment succeeds');
        assert.equal((await one(`SELECT status, "guardId" g FROM shifts WHERE id = $1`, [s.shiftIds[0]])).status, 'offered', 'and stays committed');
        assert.equal((await notices(g11.userId, 'shift_offered')).length, 1, 'with its in-app notice');
        let [d] = await dispatches(`"shiftId" = $1`, [s.shiftIds[0]]);
        assert.deepEqual([d.status, d.attempts, d.error], ['failed', 1, 'http_500']);
        await gn.runRetryJob();
        [d] = await dispatches(`id = $1`, [d.id]);
        assert.equal(d.attempts, 1, 'not retried within a minute');
        await q(`UPDATE guard_notification_dispatches SET "sentAt" = now() - interval '61 seconds' WHERE id = $1`, [d.id]);
        await gn.runRetryJob();
        [d] = await dispatches(`id = $1`, [d.id]);
        assert.deepEqual([d.status, d.attempts], ['failed', 2]);
        fake.mode = 'ok';
        await q(`UPDATE guard_notification_dispatches SET "sentAt" = now() - interval '61 seconds' WHERE id = $1`, [d.id]);
        await gn.runRetryJob();
        [d] = await dispatches(`id = $1`, [d.id]);
        assert.deepEqual([d.status, d.attempts], ['provider_accepted', 3]);
        assert.equal(sentTo(token(110)).filter((m) => m.data.notificationId === d.nid).length, 3, 'three attempts in all, the last accepted');
        await q(`UPDATE guard_notification_dispatches SET "sentAt" = now() - interval '61 seconds' WHERE id = $1`, [d.id]);
        await gn.runRetryJob();
        assert.equal((await dispatches(`id = $1`, [d.id]))[0].attempts, 3, 'an accepted push is not retried');
        // A push recorded with the change but never sent (the process stopped after the commit).
        const deliverInBackground = (gn as any).deliverInBackground;
        (gn as any).deliverInBackground = () => undefined;
        let lost: any;
        try {
          lost = await ds.transaction((m) => gn.shiftOfferWithdrawn(m, { companyId: A.id, guardId: g11.id, shiftId: s.shiftIds[0] }));
        } finally {
          (gn as any).deliverInBackground = deliverInBackground;
        }
        await gn.runRetryJob();
        assert.equal((await dispatches(`id = $1`, [lost.dispatchId]))[0].status, 'pending', 'left for a minute (the after-commit send normally takes it)');
        await q(`UPDATE guard_notification_dispatches SET "createdAt" = now() - interval '2 minutes' WHERE id = $1`, [lost.dispatchId]);
        await gn.runRetryJob();
        assert.equal((await dispatches(`id = $1`, [lost.dispatchId]))[0].status, 'provider_accepted', 'the retry job sends it');
        assert.equal(sentFor(lost.notificationId).length, 1);
      } finally {
        fake.mode = 'ok';
      }
    });

    await test('GN-12-AN-ENDED-SHIFT-IS-NEVER-PUSHED', async () => {
      const g12 = await guard('gn-ended');
      await device(g12, token(120));
      const now = Date.now();
      const { id } = await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,$3,$4,'offered',$5::timestamp,$6::timestamp) RETURNING id`,
        [A.id, A.siteId, SITE_NAME, g12.id, ts(now - 10 * HOUR), ts(now - 2 * HOUR)]);
      const r = await api('PATCH', `/shifts/${id}`, A.token, { status: 'cancelled' });
      assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
      const [d] = await dispatches(`"shiftId" = $1`, [id]);
      assert.equal(d.status, 'skipped_ended');
      assert.equal((await notices(g12.userId, 'shift_offer_withdrawn')).length, 1, 'the in-app notice is still written');
      assert.equal(sentTo(token(120)).length, 0);
      // A shift that ends while its push waits for a retry is dropped, not sent late.
      const { id: id2 } = await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,$3,$4,'offered',$5::timestamp,$6::timestamp) RETURNING id`,
        [A.id, A.siteId, SITE_NAME, g12.id, ts(now + HOUR), ts(now + 2 * HOUR)]);
      fake.mode = 'http500';
      try {
        await ds.transaction((m) => gn.shiftOfferWithdrawn(m, { companyId: A.id, guardId: g12.id, shiftId: id2 }));
        await gn.drain();
      } finally {
        fake.mode = 'ok';
      }
      await q(`UPDATE shifts SET start = start - interval '3 hours', "end" = "end" - interval '3 hours' WHERE id = $1`, [id2]);
      await q(`UPDATE guard_notification_dispatches SET "sentAt" = now() - interval '61 seconds' WHERE "shiftId" = $1`, [id2]);
      await gn.runRetryJob();
      assert.equal((await dispatches(`"shiftId" = $1`, [id2]))[0].status, 'skipped_ended');
      assert.equal(sentTo(token(120)).filter((m) => m.data.shiftId === id2).length, 1, 'only the failed first attempt ever left');
    });

    await test('GN-13-TENANT-ISOLATION', async () => {
      const gb = await guard('gn-beta-guard', B);
      await device(gb, token(130));
      // Company A cannot offer its shift to B's Guard (no relationship): refused, nothing written for that Guard.
      const s = await slot(A, 98 * HOUR);
      const r = await api('POST', `/rota-slots/${s.id}/assign`, A.token, { shiftId: s.shiftIds[0], guardId: gb.id });
      assert.ok(r.status >= 400, `refused: ${r.status}`);
      // A's event naming B's Guard, or B's shift, is refused by the service itself.
      const { id: bShift } = await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,$3,$4,'offered',$5::timestamp,$6::timestamp) RETURNING id`,
        [B.id, B.siteId, SITE_NAME, gb.id, ts(Date.now() + 99 * HOUR), ts(Date.now() + 105 * HOUR)]);
      assert.equal(await ds.transaction((m) => gn.shiftOffered(m, { companyId: A.id, guardId: gb.id, shiftId: bShift })), null, "A's company on B's shift");
      assert.equal(await ds.transaction((m) => gn.shiftOffered(m, { companyId: A.id, guardId: gb.id, shiftId: s.shiftIds[0] })), null, "B's Guard on A's shift");
      assert.equal(await ds.transaction((m) => gn.shiftOffered(m, { companyId: B.id, guardId: g.id, shiftId: bShift })), null, "A's Guard on B's shift");
      await gn.drain();
      assert.equal((await notices(gb.userId)).length, 0, "B's Guard has no notice from A");
      assert.equal((await dispatches(`"userId" = $1`, [gb.userId])).length, 0);
      assert.equal(sentTo(token(130)).length, 0, "nothing reaches B's Guard's phone");
      // B's own offer reaches B's Guard only.
      const sb = await slot(B, 120 * HOUR);
      await assign(B, sb.id, sb.shiftIds[0], gb.id);
      const { notice } = await exactlyOne(gb, 'shift_offered', sb.shiftIds[0], 1);
      assert.equal(notice.c, B.id);
      assert.ok(!sentFor(notice.id).some((m) => m.to !== token(130)), "B's push goes to B's Guard alone");
    });

    await test('GN-14-COMPANY-STAFF-ARE-NEVER-PUSHED', async () => {
      // A staff account with a device row (it cannot register one through the API; this one is planted).
      await q(`INSERT INTO push_devices ("userId",token,platform) VALUES ($1,$2,'ios')`, [A.ownerId, token(140)]);
      const staffGuardProfile = (await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'Staff Person','8499999999999999','07000000999') RETURNING id`, [A.ownerId])).id;
      const { id } = await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,$3,$4,'offered',$5::timestamp,$6::timestamp) RETURNING id`,
        [A.id, A.siteId, SITE_NAME, staffGuardProfile, ts(Date.now() + 101 * HOUR), ts(Date.now() + 107 * HOUR)]);
      assert.equal(await ds.transaction((m) => gn.shiftOffered(m, { companyId: A.id, guardId: staffGuardProfile, shiftId: id })), null,
        'a profile whose account is company staff gets nothing');
      await gn.drain();
      assert.equal((await dispatches(`"userId" = $1`, [A.ownerId])).length, 0, 'no dispatch to staff, ever (including amendment notices in GN-06)');
      assert.equal(sentTo(token(140)).length, 0, "nothing reaches a staff member's phone");
      await gn.runRetryJob();
      assert.equal(sentTo(token(140)).length, 0);
    });

    await test('GN-15-NO-PERSONAL-DATA-ON-THE-LOCK-SCREEN', async () => {
      const messages = fake.sends.flat();
      assert.ok(messages.length >= 20, `a broad sample: ${messages.length} messages`);
      const banned = [SITE_NAME, 'Harbour', SITE_ADDRESS, 'Quayside', A.name, B.name, 'Security Ltd', 'Fullname', '@example.invalid', 'Staff Person'];
      for (const gd of guards) banned.push(gd.label, gd.phone, gd.licence, gd.email);
      for (const m of messages) {
        for (const text of [m.title, m.body]) {
          for (const word of banned) assert.ok(!String(text).includes(word), `"${text}" contains "${word}"`);
          assert.doesNotMatch(String(text), /\b0\d{9,10}\b|\+44|\d{16}/, 'no phone or licence number');
        }
        assert.ok(m.title.length <= 40, `short title: ${m.title}`);
        assert.ok(m.body.length <= 120, `short body: ${m.body}`);
        const keys = Object.keys(m.data).sort();
        assert.ok(['kind', 'notificationId', 'type'].every((k) => keys.includes(k)));
        assert.ok(keys.every((k) => ['kind', 'notificationId', 'type', 'shiftId', 'amendmentId'].includes(k)), `identifiers only: ${keys}`);
        assert.equal(m.data.kind, 'guard_notification');
        assert.ok(['shift_offered', 'shift_offer_withdrawn', 'shift_reacceptance_required', 'shift_amendment_requested', 'shift_amendment_responded'].includes(m.data.type));
        assert.ok(Number.isInteger(m.data.notificationId));
      }
      const everything = JSON.stringify(fake.sends);
      assert.doesNotMatch(everything, /Bearer|accessToken|refreshToken|password|eyJ[A-Za-z0-9_-]{10,}/, 'no credential anywhere');
      assert.ok(!messages.some((m) => m.data.type === 'shift_replaced'), 'shift_replaced is reserved and never emitted');
    });
  } finally {
    await gn.drain();
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
