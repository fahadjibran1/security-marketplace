/**
 * Replace Guard — certification over real HTTP with real authorisation, on a disposable database built from the
 * repository's own migrations (head 66, no new migration), with a local fake of the Expo Push Service. Nothing leaves
 * this machine.
 *
 *   RG-01  offered shift: one atomic move to the replacement as a fresh offer; the outgoing Guard gets shift_replaced and
 *          the replacement shift_offered, each one in-app notice and one push with the exact payload contract; the draft
 *          timesheet follows; the outgoing Guard can no longer answer the offer
 *   RG-02  accepted (ready) shift: back to offered for the replacement (never accepted on their behalf); they accept it
 *          themselves
 *   RG-03  a rota position: replaced under the slot lock; a later slot time change re-offers to the replacement only
 *   RG-04  the audit entry: actor, company, before / after Guard ids, status, reason, time; identifiers only
 *   RG-05  idempotent: a retried request answers with the shift and writes and notifies nothing; concurrent identical
 *          requests replace once
 *   RG-06  two concurrent replacements to different Guards: exactly one wins, nothing of the loser is written
 *   RG-07  replace racing the outgoing Guard's acceptance: exactly one decides; never both
 *   RG-08  atomicity: a failure late in the transaction rolls back everything (shift, timesheet, audit, amendment void,
 *          both notices, both dispatches) and sends nothing
 *   RG-09  every eligibility refusal, each with its code, changing nothing: same Guard, not linked (another company's
 *          Guard, an unknown id, an inactive relationship), blocked, not a Guard account, inactive account, compliance,
 *          approved leave, marked unavailable, overlapping shift; reason required; malformed body
 *   RG-10  tenant isolation: another company cannot see or replace the shift
 *   RG-11  a Guard (even the shift's own) and a platform administrator are refused
 *   RG-12  states: in progress refused (live attendance untouched), ended refused, accepted-and-started refused,
 *          unfilled / declined / cancelled / completed refused; an offered shift that has started may still be replaced
 *   RG-13  switch off: both in-app notices are still written; no push (skipped_disabled)
 *   RG-14  Live Shift Amendments: an open proposal of the outgoing Guard is voided (guard_replaced) with its audit entry;
 *          an in-progress shift's open proposal is left exactly as it was
 *   RG-15  a replaced Guard's undelivered push is not sent once the shift has been given back to them
 *   RG-16  no personal data on the lock screen or in the audit entry
 *   RG-17  no-show: an accepted shift that has started, with noShow: true, after the missed-shift grace, before the end,
 *          with no attendance; audit evidence; the Guard who did not show cannot Book On afterwards
 *   RG-18  no-show racing the outgoing Guard's Book On, both orders: exactly one wins, cleanly
 *   RG-19  a marketplace hire (assignment and/or job application) is refused; the hire records are untouched
 *   RG-20  Guards see only the neutral reason category (in the app, not on the lock screen); never the free text
 *   RG-21  fatigue and rest of the replacement: maximum shift refused, approval threshold needs an Owner / Admin
 *          acknowledgement, warnings returned and audited, minimum rest before and after refused (another company's
 *          figures withheld), weekly review warned
 *   RG-22  the replacement is not confirmed cover (rota counts, coverage) until they accept
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

const url = process.env.REPLACE_GUARD_DATABASE_URL;
if (!url) throw new Error('REPLACE_GUARD_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Replace Guard database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'replace-guard-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.RESEND_API_KEY;
delete process.env.EXPO_ACCESS_TOKEN;
delete process.env.PUSH_WELFARE_REMINDERS_ENABLED;
process.env.PUSH_GUARD_NOTIFICATIONS_ENABLED = 'true';

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
const PASSWORD = 'replace-guard-spec-only-password-1';
const SITE_NAME = 'Lanternfield Yard';
const SITE_ADDRESS = '42 Ropewalk Lane';
const REASON = 'Guard reported sick for this shift';
const ukDay = (n: number) => {
  const [y, m, d] = complianceToday().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const iso = (ms: number) => new Date(ms).toISOString();
const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const token = (n: number) => `ExponentPushToken[rgspec${String(n).padStart(8, '0')}abc]`;
const londonWhen = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(ms));

// ── The fake Expo Push Service ─────────────────────────────────────────────────────────────────────────
const fake = { mode: 'ok' as 'ok' | 'http500', sends: [] as any[][], seq: 0 };
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
      return reply(200, { data: (body as any[]).map(() => ({ status: 'ok', id: `ticket-${++fake.seq}` })) });
    }
    if (req.url === '/--/api/v2/push/getReceipts') {
      const data: Record<string, unknown> = {};
      for (const id of body.ids as string[]) data[id] = { status: 'ok' };
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
  // Replace Guard needs no schema change: Migration 66 already allows shift_replaced. Code at the #35 head runs over
  // exactly this database.
  assert.equal(migrated[migrated.length - 1]?.name, 'AddManualAttendance1720900000013', 'the head is Migration 67 (manual attendance); Replace Guard needs nothing from it');
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
  const { GuardNotificationService } = await import('../src/guard-notification/guard-notification.service');
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
    const A = await company('rgalpha', '79555555');
    const B = await company('rgbeta', '79666666');
    const adminEmail = 'rg.platform.admin@example.invalid';
    await user(adminEmail, 'admin');
    const adminToken = await login(adminEmail);
    await api('PUT', `/admin/shift-amendments/companies/${A.id}`, adminToken, { enabled: true });

    let n = 0;
    const guards: Array<{ label: string; phone: string; licence: string; email: string }> = [];
    type G = { id: number; userId: number; token: string; label: string };
    const guard = async (label: string, co = A, opts: { compliant?: boolean } = {}): Promise<G> => {
      n += 1;
      const email = `${label}@example.invalid`;
      const userId = await user(email, 'guard');
      const licence = `85000000000000${String(n).padStart(2, '0')}`;
      const phone = `0770080${String(n).padStart(4, '0')}`;
      guards.push({ label, phone, licence, email });
      const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","siaExpiryDate","rightToWorkStatus",phone) VALUES ($1,$2,$3,$4,'british',$5) RETURNING id`,
        [userId, `${label} Fullname`, licence, ukDay(500), phone]);
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [co.id, id]);
      if (opts.compliant !== false) {
        for (const type of ['sia_licence', 'right_to_work']) {
          await q(`INSERT INTO guard_documents ("guardId","companyId",type,"storageProvider","storageKey","originalFileName","mimeType","sizeBytes","uploadCompletedAt",verified,"uploadedByUserId","verifiedByUserId","verifiedAt")
            VALUES ($1,$2,$3,'s3-compatible',$4,'e.pdf','application/pdf','1024',now(),true,null,null,now())`, [id, co.id, type, `rg/${co.id}/${id}/${type}`]);
        }
        for (const body of [
          { guardId: id, kind: 'sia', outcome: 'confirmed', checkDate: ukDay(0), checkedByName: 'Spec Checker', evidenceReference: 'HR/spec', method: 'sia_public_register', licenceNumber: licence, expiryDate: ukDay(400) },
          { guardId: id, kind: 'right_to_work', outcome: 'confirmed', checkDate: ukDay(0), checkedByName: 'Spec Checker', evidenceReference: 'HR/spec', method: 'manual_document', rightToWorkExcuse: 'continuous' },
        ]) {
          const r = await api('POST', '/compliance/checks', co.token, body);
          assert.equal(r.status, 201, `record ${body.kind}: ${r.status} ${JSON.stringify(r.body)}`);
        }
      }
      return { id: id as number, userId, token: await login(email), label };
    };
    const device = async (g: { token: string }, t: string) => {
      const r = await api('POST', '/push-devices', g.token, { token: t, platform: 'android', appVersion: '1.2.0' });
      assert.equal(r.status, 200, `register: ${r.status} ${JSON.stringify(r.body)}`);
    };
    const notices = (userId: number, type?: string) =>
      q(`SELECT id, type, title, message, "companyId" c FROM notifications WHERE "userId" = $1 ${type ? 'AND type = $2' : ''} ORDER BY id`, type ? [userId, type] : [userId]);
    const dispatches = (where: string, params: unknown[]) =>
      q(`SELECT id, "userId" u, "guardId" g, "companyId" c, "notificationId" nid, "shiftId" sid, type, "eventKey" k, status, attempts
           FROM guard_notification_dispatches WHERE ${where} ORDER BY id`, params);
    const sentFor = (notificationId: number) => fake.sends.flat().filter((m) => m.data?.notificationId === notificationId);
    const counts = async () => one(`SELECT (SELECT count(*)::int FROM notifications) AS notices, (SELECT count(*)::int FROM guard_notification_dispatches) AS dispatches,
      (SELECT count(*)::int FROM audit_logs WHERE action = 'shift.guard_replaced') AS audits`);
    const shiftRow = (id: number) => one(`SELECT "guardId" g, status, start, "end" FROM shifts WHERE id = $1`, [id]);

    // Each shift gets its own window, 14 hours apart, so the Guards' shifts never overlap and never fall under the
    // minimum rest (11 h) by accident.
    let cursor = 24 * HOUR;
    const nextWindow = (hours = 6) => {
      const start = Date.now() + cursor;
      cursor += hours * HOUR + 14 * HOUR;
      return { start, end: start + hours * HOUR };
    };
    /** POST /shifts with a Guard: an offered shift of `co`. */
    const offer = async (g: { id: number }, co = A, w = nextWindow()) => {
      const r = await api('POST', '/shifts', co.token, { siteId: co.siteId, guardId: g.id, start: iso(w.start), end: iso(w.end) });
      assert.equal(r.status, 201, `create: ${r.status} ${JSON.stringify(r.body)}`);
      return { id: Number(r.body.shift?.id ?? r.body.id), ...w };
    };
    const accept = async (g: { token: string }, shiftId: number) => {
      const r = await api('PATCH', `/shifts/${shiftId}/respond`, g.token, { response: 'accepted' });
      assert.equal(r.status, 200, `accept: ${r.status} ${JSON.stringify(r.body)}`);
    };
    const replace = (
      shiftId: number,
      replacementGuardId: unknown,
      tok: string | null = A.token,
      reason: unknown = REASON,
      extra: Record<string, unknown> = {},
    ) => api('POST', `/shifts/${shiftId}/replace-guard`, tok, { replacementGuardId, reasonCategory: 'cover_rearranged', reason, ...extra });
    /** A shift inserted directly in `status` (start / end relative to now). */
    const planted = async (g: { id: number } | null, status: string, startIn: number, endIn: number, co = A) => {
      const now = Date.now();
      return (await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end","checkCallIntervalMinutes") VALUES ($1,$2,$3,$4,$5,$6::timestamp,$7::timestamp,60) RETURNING id`,
        [co.id, co.siteId, SITE_NAME, g?.id ?? null, status, ts(now + startIn), ts(now + endIn)])).id as number;
    };
    const plantAmendment = async (shiftId: number, guardId: number, endMs: number, status = 'pending') =>
      (await one(`INSERT INTO shift_amendments ("shiftId","companyId","guardId","sequence",status,"originalEnd","previousEnd","proposedEnd",reason,"proposedByUserId","proposedAt","expiresAt","fatigueAssessment")
        VALUES ($1,$2,$3,1,$4,$5::timestamp,$5::timestamp,$6::timestamp,'Cover the handover',$7,now() AT TIME ZONE 'UTC',$5::timestamp,'{}'::jsonb) RETURNING id`,
        [shiftId, A.id, guardId, status, ts(endMs), ts(endMs + HOUR), A.ownerId])).id as number;

    const ga = await guard('rg-outgoing');
    const gb = await guard('rg-replacement');
    const gc = await guard('rg-third');
    await device(ga, token(1));
    await device(gb, token(2));
    await device(gc, token(3));

    await test('RG-01-OFFERED-SHIFT-MOVES-ATOMICALLY-WITH-BOTH-NOTICES', async () => {
      const s = await offer(ga);
      const before = await counts();
      const r = await replace(s.id, gb.id);
      assert.equal(r.status, 201, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.guard?.id, gb.id);
      assert.equal(r.body.status, 'offered');
      const row = await shiftRow(s.id);
      assert.equal(row.g, gb.id);
      assert.equal(row.status, 'offered', 'a fresh offer: the replacement must accept');
      const tsRow = await one(`SELECT "guardId" g, "approvalStatus" st FROM timesheets WHERE "shiftId" = $1`, [s.id]);
      assert.equal(tsRow.g, gb.id, 'the draft timesheet follows the shift');
      assert.equal(tsRow.st, 'draft');

      // The outgoing Guard: one shift_replaced notice and one push.
      const [outD] = await dispatches(`"userId" = $1 AND type = 'shift_replaced' AND "shiftId" = $2`, [ga.userId, s.id]);
      assert.ok(outD, 'a shift_replaced dispatch');
      assert.equal(outD.status, 'provider_accepted', JSON.stringify(outD));
      const outNotice = (await notices(ga.userId, 'shift_replaced')).find((x: any) => x.id === outD.nid);
      assert.ok(outNotice);
      const body = `Your shift assignment for ${londonWhen(s.start)} has changed. Open S4 for details.`;
      assert.equal(outNotice.title, 'Your shift assignment has changed');
      // In the app: the push text plus the neutral reason category, never the free-text reason.
      assert.equal(outNotice.message, `Your shift assignment for ${londonWhen(s.start)} has changed. Reason: Cover rearranged. Open S4 for details.`);
      assert.equal(outNotice.c, A.id);
      const outMsgs = sentFor(outD.nid);
      assert.equal(outMsgs.length, 1);
      assert.equal(outMsgs[0].to, token(1));
      assert.equal(outMsgs[0].title, 'Your shift assignment has changed');
      assert.equal(outMsgs[0].body, body, 'the lock screen carries the shift time only');
      assert.deepEqual(outMsgs[0].data, { kind: 'guard_notification', notificationId: outNotice.id, type: 'shift_replaced', shiftId: s.id });
      assert.equal(outMsgs[0].channelId, 'shift-updates');
      assert.equal(outMsgs[0].priority, 'normal');
      assert.ok(!('categoryId' in outMsgs[0]));
      assert.match(outD.k, new RegExp(`^shift_replaced:shift:${s.id}:audit:\\d+$`));

      // The replacement: one shift_offered notice and one push.
      const [inD] = await dispatches(`"userId" = $1 AND type = 'shift_offered' AND "shiftId" = $2`, [gb.userId, s.id]);
      assert.ok(inD, 'a shift_offered dispatch to the replacement');
      assert.equal(inD.status, 'provider_accepted');
      const inMsgs = sentFor(inD.nid);
      assert.equal(inMsgs.length, 1);
      assert.equal(inMsgs[0].to, token(2));
      assert.equal(inMsgs[0].title, 'New shift offer');
      assert.equal(inMsgs[0].body, `You have a new shift offer for ${londonWhen(s.start)}. Open S4 to accept or decline.`);
      assert.deepEqual(inMsgs[0].data, { kind: 'guard_notification', notificationId: inD.nid, type: 'shift_offered', shiftId: s.id });

      const after = await counts();
      assert.equal(after.notices - before.notices, 2, 'exactly two notices');
      assert.equal(after.dispatches - before.dispatches, 2, 'exactly two dispatches');
      assert.equal(after.audits - before.audits, 1, 'one audit entry');
      // Nobody else is told anything (the third Guard has no shift_replaced or offer for this shift).
      assert.equal((await dispatches(`"userId" = $1 AND "shiftId" = $2`, [gc.userId, s.id])).length, 0);

      // The outgoing Guard can no longer answer, or see, the offer.
      const late = await api('PATCH', `/shifts/${s.id}/respond`, ga.token, { response: 'accepted' });
      assert.equal(late.status, 404, `${late.status} ${JSON.stringify(late.body)}`);
      assert.equal((await api('GET', `/shifts/${s.id}`, ga.token)).status, 404);
      assert.ok(!((await api('GET', '/shifts/my', ga.token)).body as any[]).some((x) => x.id === s.id));
      assert.ok(((await api('GET', '/shifts/my', gb.token)).body as any[]).some((x) => x.id === s.id));
    });

    await test('RG-02-ACCEPTED-SHIFT-BECOMES-A-FRESH-OFFER-FOR-THE-REPLACEMENT', async () => {
      const s = await offer(ga);
      await accept(ga, s.id);
      assert.equal((await shiftRow(s.id)).status, 'ready');
      const r = await replace(s.id, gb.id);
      assert.equal(r.status, 201, `${r.status} ${JSON.stringify(r.body)}`);
      const row = await shiftRow(s.id);
      assert.equal(row.g, gb.id);
      assert.equal(row.status, 'offered', 'never accepted on the replacement\'s behalf');
      assert.equal((await dispatches(`"userId" = $1 AND type = 'shift_replaced' AND "shiftId" = $2`, [ga.userId, s.id])).length, 1);
      assert.equal((await dispatches(`"userId" = $1 AND type = 'shift_offered' AND "shiftId" = $2`, [gb.userId, s.id])).length, 1);
      const audit = await one(`SELECT "beforeData" b, "afterData" a FROM audit_logs WHERE action = 'shift.guard_replaced' AND "entityId" = $1`, [s.id]);
      assert.deepEqual(audit.b, { guardId: ga.id, status: 'ready' });
      await accept(gb, s.id);
      assert.equal((await shiftRow(s.id)).status, 'ready', 'the replacement accepts it themselves');
    });

    await test('RG-03-ROTA-POSITION-UNDER-THE-SLOT-LOCK', async () => {
      const w = nextWindow(8);
      const slot = await api('POST', '/rota-slots', A.token, { siteId: A.siteId, startAt: iso(w.start), endAt: iso(w.end), requiredGuardCount: 1 });
      assert.equal(slot.status, 201, JSON.stringify(slot.body));
      const slotId = Number(slot.body.id ?? slot.body.slot?.id);
      const [{ id: shiftId }] = await q(`SELECT id FROM shifts WHERE "rotaSlotId" = $1`, [slotId]);
      const as = await api('POST', `/rota-slots/${slotId}/assign`, A.token, { shiftId, guardId: ga.id });
      assert.equal(as.status, 201, JSON.stringify(as.body));
      await accept(ga, shiftId);
      const r = await replace(shiftId, gb.id);
      assert.equal(r.status, 201, `${r.status} ${JSON.stringify(r.body)}`);
      const audit = await one(`SELECT "afterData" a FROM audit_logs WHERE action = 'shift.guard_replaced' AND "entityId" = $1`, [shiftId]);
      assert.equal(audit.a.rotaSlotId, slotId);
      await accept(gb, shiftId);
      // A slot time change now re-offers to the replacement, never to the Guard who was replaced.
      const moved = await api('PATCH', `/rota-slots/${slotId}/time`, A.token, { startAt: iso(w.start + 30 * MIN), endAt: iso(w.end + 30 * MIN) });
      assert.ok(moved.status === 200 || moved.status === 201, `${moved.status} ${JSON.stringify(moved.body)}`);
      assert.equal((await shiftRow(shiftId)).g, gb.id, 'the time change keeps the replacement');
      assert.equal((await dispatches(`"userId" = $1 AND type = 'shift_reacceptance_required' AND "shiftId" = $2`, [gb.userId, shiftId])).length, 1);
      assert.equal((await dispatches(`"userId" = $1 AND type = 'shift_reacceptance_required' AND "shiftId" = $2`, [ga.userId, shiftId])).length, 0);
    });

    await test('RG-04-THE-AUDIT-ENTRY', async () => {
      const s = await offer(ga);
      const before = Date.now();
      const r = await replace(s.id, gc.id);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const rows = await q(`SELECT "companyId" c, "userId" u, "entityType" et, "entityId" eid, "beforeData" b, "afterData" a, "createdAt" at
        FROM audit_logs WHERE action = 'shift.guard_replaced' AND "entityId" = $1`, [s.id]);
      assert.equal(rows.length, 1);
      const [row] = rows;
      assert.equal(row.c, A.id);
      assert.equal(row.u, A.ownerId, 'the actor');
      assert.equal(row.et, 'shift');
      assert.deepEqual(row.b, { guardId: ga.id, status: 'offered' });
      const { fatigue, ...after } = row.a;
      assert.deepEqual(after, { guardId: gc.id, status: 'offered', reasonCategory: 'cover_rearranged', reason: REASON });
      assert.equal(fatigue.basis, 'scheduled_hours');
      assert.equal(fatigue.totalScheduledHours, 6);
      assert.deepEqual(fatigue.warnings, []);
      assert.equal(r.body.replacementAssessment.totalScheduledHours, 6, 'the assessment is returned to the company');
      const at = new Date(row.at).getTime();
      assert.ok(at >= before - 5_000 && at <= Date.now() + 5_000, 'timestamped');
    });

    await test('RG-05-A-RETRIED-REQUEST-NOTIFIES-NOBODY-TWICE', async () => {
      const s = await offer(ga);
      const first = await replace(s.id, gb.id);
      assert.equal(first.status, 201);
      const mid = await counts();
      const sendsMid = fake.sends.length;
      for (let i = 0; i < 2; i += 1) {
        const again = await replace(s.id, gb.id);
        assert.equal(again.status, 201, `retry ${i}: ${again.status} ${JSON.stringify(again.body)}`);
        assert.equal(again.body.guard?.id, gb.id);
      }
      assert.deepEqual(await counts(), mid, 'a retry writes nothing');
      assert.equal(fake.sends.length, sendsMid, 'and sends nothing');

      // Concurrent identical requests: one replacement.
      const s2 = await offer(ga);
      const results = await Promise.all([replace(s2.id, gb.id), replace(s2.id, gb.id), replace(s2.id, gb.id)]);
      assert.ok(results.every((x) => x.status === 201 || (x.status === 409 && x.body.code === 'REPLACE_GUARD_SHIFT_CHANGED')),
        JSON.stringify(results.map((x) => [x.status, x.body?.code])));
      assert.ok(results.some((x) => x.status === 201));
      assert.equal((await q(`SELECT 1 FROM audit_logs WHERE action = 'shift.guard_replaced' AND "entityId" = $1`, [s2.id])).length, 1);
      assert.equal((await dispatches(`"shiftId" = $1 AND type = 'shift_replaced'`, [s2.id])).length, 1);
      assert.equal((await dispatches(`"shiftId" = $1 AND type = 'shift_offered' AND "userId" = $2`, [s2.id, gb.userId])).length, 1);
    });

    await test('RG-06-TWO-CONCURRENT-REPLACEMENTS-ONE-WINS', async () => {
      for (let i = 0; i < 3; i += 1) {
        const s = await offer(ga);
        const [toB, toC] = await Promise.all([replace(s.id, gb.id), replace(s.id, gc.id)]);
        const statuses = [toB.status, toC.status].sort();
        assert.deepEqual(statuses, [201, 409], `exactly one wins: ${JSON.stringify([toB.body?.code, toC.body?.code])}`);
        const loser = toB.status === 409 ? toB : toC;
        assert.equal(loser.body.code, 'REPLACE_GUARD_SHIFT_CHANGED');
        const winner = toB.status === 201 ? gb : gc;
        const other = winner === gb ? gc : gb;
        assert.equal((await shiftRow(s.id)).g, winner.id);
        assert.equal((await dispatches(`"shiftId" = $1 AND type = 'shift_replaced'`, [s.id])).length, 1, 'the outgoing Guard is told once');
        assert.equal((await dispatches(`"shiftId" = $1 AND type = 'shift_offered' AND "userId" = $2`, [s.id, winner.userId])).length, 1);
        assert.equal((await dispatches(`"shiftId" = $1 AND "userId" = $2`, [s.id, other.userId])).length, 0, 'nothing for the loser');
        assert.equal((await q(`SELECT 1 FROM audit_logs WHERE action = 'shift.guard_replaced' AND "entityId" = $1`, [s.id])).length, 1);
      }
    });

    await test('RG-07-REPLACE-RACING-ACCEPTANCE-EXACTLY-ONE-DECIDES', async () => {
      const outcomes = new Set<string>();
      for (let i = 0; i < 6; i += 1) {
        const s = await offer(ga);
        const [acc, rep] = await Promise.all([
          api('PATCH', `/shifts/${s.id}/respond`, ga.token, { response: 'accepted' }),
          replace(s.id, gb.id),
        ]);
        const row = await shiftRow(s.id);
        if (acc.status === 200) {
          assert.equal(rep.status, 409, `accept won, so replace is refused: ${rep.status} ${JSON.stringify(rep.body)}`);
          assert.equal(rep.body.code, 'REPLACE_GUARD_SHIFT_CHANGED');
          assert.equal(row.g, ga.id);
          assert.equal(row.status, 'ready');
          assert.equal((await dispatches(`"shiftId" = $1 AND type = 'shift_replaced'`, [s.id])).length, 0);
          assert.equal((await q(`SELECT 1 FROM audit_logs WHERE action = 'shift.guard_replaced' AND "entityId" = $1`, [s.id])).length, 0);
          outcomes.add('accept');
        } else {
          assert.equal(rep.status, 201, `replace won: ${rep.status} ${JSON.stringify(rep.body)}`);
          assert.ok([404, 409].includes(acc.status), `the acceptance is refused: ${acc.status} ${JSON.stringify(acc.body)}`);
          assert.equal(row.g, gb.id);
          assert.equal(row.status, 'offered');
          outcomes.add('replace');
        }
      }
      console.log(`      outcomes seen: ${[...outcomes].join(', ')}`);
      // Deterministic both ways: with the shift row held, each side waits and then sees the other's commit.
      for (const first of ['accept', 'replace'] as const) {
        const s = await offer(ga);
        const runner = ds.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        await runner.query(`SELECT 1 FROM shifts WHERE id = $1 FOR UPDATE`, [s.id]);
        const a = first === 'accept' ? api('PATCH', `/shifts/${s.id}/respond`, ga.token, { response: 'accepted' }) : replace(s.id, gb.id);
        await new Promise((r) => setTimeout(r, 300));
        const b = first === 'accept' ? replace(s.id, gb.id) : api('PATCH', `/shifts/${s.id}/respond`, ga.token, { response: 'accepted' });
        await new Promise((r) => setTimeout(r, 300));
        await runner.commitTransaction();
        await runner.release();
        const [ra, rb] = await Promise.all([a, b]);
        assert.ok(ra.status === 200 || ra.status === 201, `${first} first wins: ${ra.status} ${JSON.stringify(ra.body)}`);
        assert.ok(rb.status === 409 || rb.status === 404, `the other is refused: ${rb.status} ${JSON.stringify(rb.body)}`);
        const row = await shiftRow(s.id);
        assert.deepEqual([row.g, row.status], first === 'accept' ? [ga.id, 'ready'] : [gb.id, 'offered']);
      }
    });

    await test('RG-08-A-LATE-FAILURE-ROLLS-BACK-EVERYTHING', async () => {
      const s = await offer(ga);
      const amendmentId = await plantAmendment(s.id, ga.id, s.end);
      const before = await counts();
      const sends = fake.sends.length;
      const original = gn.shiftOffered.bind(gn);
      (gn as any).shiftOffered = async () => { throw new Error('forced failure after every other write'); };
      let r: Res;
      try {
        r = await replace(s.id, gb.id);
      } finally {
        (gn as any).shiftOffered = original;
      }
      assert.equal(r.status, 500, `${r.status} ${JSON.stringify(r.body)}`);
      const row = await shiftRow(s.id);
      assert.deepEqual([row.g, row.status], [ga.id, 'offered'], 'the shift is exactly as it was');
      assert.equal((await one(`SELECT "guardId" g FROM timesheets WHERE "shiftId" = $1`, [s.id])).g, ga.id);
      assert.equal((await one(`SELECT status FROM shift_amendments WHERE id = $1`, [amendmentId])).status, 'pending', 'the void rolled back');
      assert.deepEqual(await counts(), before, 'no notice, dispatch or audit entry survives');
      assert.equal((await q(`SELECT 1 FROM audit_logs WHERE action = 'shift_amendment.voided' AND "entityId" = $1`, [amendmentId])).length, 0);
      assert.equal(fake.sends.length, sends, 'nothing is sent');
      await gn.runRetryJob();
      assert.equal(fake.sends.length, sends, 'nothing is left for the retry job either');
      // Afterwards the same request succeeds normally.
      assert.equal((await replace(s.id, gb.id)).status, 201);
      assert.equal((await one(`SELECT status, "voidedReason" r FROM shift_amendments WHERE id = $1`, [amendmentId])).r, 'guard_replaced');
    });

    await test('RG-09-EVERY-ELIGIBILITY-REFUSAL-HAS-ITS-CODE', async () => {
      const s = await offer(ga);
      const refused = async (label: string, guardId: unknown, code: string | null, status = 422, reason: unknown = REASON) => {
        const before = await counts();
        const r = await replace(s.id, guardId, A.token, reason);
        assert.equal(r.status, status, `${label}: ${r.status} ${JSON.stringify(r.body)}`);
        if (code) assert.equal(r.body.code, code, `${label}: ${JSON.stringify(r.body)}`);
        const row = await shiftRow(s.id);
        assert.deepEqual([row.g, row.status], [ga.id, 'offered'], `${label}: unchanged`);
        assert.deepEqual(await counts(), before, `${label}: nothing written`);
      };
      await refused('same Guard', ga.id, 'REPLACE_GUARD_SAME_GUARD');
      const other = await guard('rg-other-company', B);
      await refused("another company's Guard", other.id, 'REPLACE_GUARD_NOT_LINKED');
      await refused('an unknown Guard id', 987654, 'REPLACE_GUARD_NOT_LINKED');
      const inactive = await guard('rg-inactive-link');
      await q(`UPDATE company_guards SET status = 'INACTIVE' WHERE "guardId" = $1`, [inactive.id]);
      await refused('inactive relationship', inactive.id, 'REPLACE_GUARD_NOT_LINKED');
      const blocked = await guard('rg-blocked');
      await q(`UPDATE company_guards SET status = 'BLOCKED' WHERE "guardId" = $1`, [blocked.id]);
      await refused('blocked', blocked.id, 'REPLACE_GUARD_BLOCKED');
      // A profile linked to the company whose account is company staff, not a Guard.
      const staffUser = await user('rg.staff@example.invalid', 'company_admin');
      const staffProfile = (await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'Staff Person','8599999999999999','07000000998') RETURNING id`, [staffUser])).id;
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [A.id, staffProfile]);
      await refused('not a Guard account', staffProfile, 'REPLACE_GUARD_NOT_A_GUARD');
      const suspended = await guard('rg-suspended');
      await q(`UPDATE users SET status = 'suspended' WHERE id = $1`, [suspended.userId]);
      await refused('inactive account', suspended.id, 'REPLACE_GUARD_ACCOUNT_INACTIVE');
      const noChecks = await guard('rg-no-checks', A, { compliant: false });
      await refused('compliance', noChecks.id, 'REPLACE_GUARD_COMPLIANCE_BLOCKED');
      const onLeave = await guard('rg-on-leave');
      await q(`INSERT INTO guard_leave ("companyId","guardId","leaveType","startAt","endAt",status) VALUES ($1,$2,'annual_leave',$3::timestamp,$4::timestamp,'approved')`,
        [A.id, onLeave.id, ts(s.start - HOUR), ts(s.end + HOUR)]);
      await refused('approved leave', onLeave.id, 'REPLACE_GUARD_ON_LEAVE');
      const unavailable = await guard('rg-unavailable');
      await q(`INSERT INTO guard_availability_overrides ("companyId","guardId",date,status) VALUES ($1,$2,$3,'unavailable')`,
        [A.id, unavailable.id, iso(s.start).slice(0, 10)]);
      await refused('marked unavailable', unavailable.id, 'REPLACE_GUARD_UNAVAILABLE');
      const busy = await guard('rg-busy');
      await planted(busy, 'ready', s.start - Date.now() + HOUR, s.end - Date.now() + HOUR);
      await refused('overlapping shift', busy.id, 'REPLACE_GUARD_OVERLAPPING_SHIFT');
      await refused('blank reason', gb.id, 'REPLACE_GUARD_REASON_REQUIRED', 400, '   ');
      await refused('malformed Guard id', 'abc', null, 400);
      const noReason = await api('POST', `/shifts/${s.id}/replace-guard`, A.token, { replacementGuardId: gb.id, reasonCategory: 'cover_rearranged' });
      assert.equal(noReason.status, 400, `missing reason: ${noReason.status}`);
      const noCategory = await api('POST', `/shifts/${s.id}/replace-guard`, A.token, { replacementGuardId: gb.id, reason: REASON });
      assert.equal(noCategory.status, 400, `missing reason category: ${noCategory.status}`);
      for (const bad of ['performance', 'Guard was rude', '']) {
        const r = await api('POST', `/shifts/${s.id}/replace-guard`, A.token, { replacementGuardId: gb.id, reason: REASON, reasonCategory: bad });
        assert.equal(r.status, 400, `category "${bad}" is not one of the neutral set: ${r.status}`);
      }
      assert.equal((await shiftRow(s.id)).g, ga.id);
      const extra = await api('POST', `/shifts/${s.id}/replace-guard`, A.token, { replacementGuardId: gb.id, reason: REASON, status: 'ready' });
      assert.equal(extra.status, 400, 'no other field is accepted (never "accept on their behalf")');
      // The overlap is repeated inside the transaction, under the Guard's lock: a clash committed after the pre-checks
      // passed is still refused there.
      const { ShiftService } = await import('../src/shift/shift.service');
      const shifts = app.get(ShiftService) as any;
      const preCheck = shifts.assertReplacementEligible;
      let clashId = 0;
      shifts.assertReplacementEligible = async (...args: unknown[]) => {
        await preCheck.apply(shifts, args);
        clashId = await planted(gb, 'offered', s.start - Date.now(), s.end - Date.now());
      };
      try {
        await refused('overlap committed after the pre-checks', gb.id, 'REPLACE_GUARD_OVERLAPPING_SHIFT');
      } finally {
        shifts.assertReplacementEligible = preCheck;
      }
      await q(`DELETE FROM shifts WHERE id = $1`, [clashId]);
      assert.equal((await replace(s.id, gb.id)).status, 201, 'a clean Guard then succeeds');
    });

    await test('RG-10-TENANT-ISOLATION', async () => {
      const s = await offer(ga);
      const before = await counts();
      const r = await replace(s.id, gb.id, B.token);
      assert.equal(r.status, 404, `another company sees no such shift: ${r.status} ${JSON.stringify(r.body)}`);
      const gbB = await guard('rg-beta-guard', B);
      const sb = await offer(gbB, B);
      const cross = await replace(sb.id, gb.id, B.token);
      assert.equal(cross.status, 422);
      assert.equal(cross.body.code, 'REPLACE_GUARD_NOT_LINKED', "A's Guard cannot be put on B's shift");
      assert.equal((await shiftRow(s.id)).g, ga.id);
      assert.equal((await shiftRow(sb.id)).g, gbB.id);
      const after = await counts();
      assert.equal(after.audits, before.audits);
      assert.equal(after.dispatches - before.dispatches, 1, "only B's own offer to its own Guard");
    });

    await test('RG-11-GUARDS-AND-PLATFORM-ADMINS-ARE-REFUSED', async () => {
      const s = await offer(ga);
      for (const [label, tok] of [['the shift\'s own Guard', ga.token], ['another Guard', gb.token], ['platform admin', adminToken]] as const) {
        const r = await replace(s.id, gc.id, tok);
        assert.equal(r.status, 403, `${label}: ${r.status} ${JSON.stringify(r.body)}`);
      }
      assert.equal((await replace(s.id, gc.id, null)).status, 401);
      assert.equal((await shiftRow(s.id)).g, ga.id);
    });

    await test('RG-12-STATES', async () => {
      const refusedState = async (label: string, shiftId: number, code: string) => {
        const before = await counts();
        const r = await replace(shiftId, gb.id);
        assert.equal(r.status, 409, `${label}: ${r.status} ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, code, `${label}: ${JSON.stringify(r.body)}`);
        assert.deepEqual(await counts(), before, `${label}: nothing written`);
      };
      // In progress: booked on. Refused; the attendance and the shift are untouched.
      const live = await planted(ga, 'ready', -30 * MIN, 5 * HOUR);
      const on = await api('POST', '/attendance/check-in', ga.token, { shiftId: live });
      assert.equal(on.status, 201, `book on: ${on.status} ${JSON.stringify(on.body)}`);
      const liveAmendment = await plantAmendment(live, ga.id, Date.now() + 5 * HOUR);
      const attendanceBefore = await q(`SELECT id, type, "guardId" g FROM attendance_events WHERE "shiftId" = $1 ORDER BY id`, [live]);
      await refusedState('in progress', live, 'REPLACE_GUARD_SHIFT_IN_PROGRESS');
      assert.deepEqual(await q(`SELECT id, type, "guardId" g FROM attendance_events WHERE "shiftId" = $1 ORDER BY id`, [live]), attendanceBefore);
      const liveRow = await shiftRow(live);
      assert.deepEqual([liveRow.g, liveRow.status], [ga.id, 'in_progress']);
      assert.equal((await one(`SELECT status FROM shift_amendments WHERE id = $1`, [liveAmendment])).status, 'pending', 'RG-14: left exactly as it was');
      await refusedState('offered, ended', await planted(ga, 'offered', -8 * HOUR, -MIN), 'REPLACE_GUARD_SHIFT_ENDED');
      await refusedState('accepted, ended', await planted(ga, 'ready', -8 * HOUR, -MIN), 'REPLACE_GUARD_SHIFT_ENDED');
      await refusedState('accepted, started, no no-show confirmation', await planted(ga, 'ready', -20 * MIN, 6 * HOUR), 'REPLACE_GUARD_NO_SHOW_CONFIRMATION_REQUIRED');
      for (const status of ['unfilled', 'rejected', 'cancelled', 'completed', 'missed']) {
        const id = await planted(status === 'unfilled' ? null : ga, status, 200 * HOUR, 206 * HOUR);
        await refusedState(status, id, 'REPLACE_GUARD_STATUS_NOT_REPLACEABLE');
      }
      // An offer that has started but not ended may still go to someone else (a late replacement).
      const lateOffer = await planted(ga, 'offered', -10 * MIN, 6 * HOUR);
      const r = await replace(lateOffer, gc.id);
      assert.equal(r.status, 201, `late offer: ${r.status} ${JSON.stringify(r.body)}`);
      // The ended-shift push rule is unchanged: a shift that ended is never pushed (proved by GN-12); here the
      // replacement's offer of a live window is pushed with a TTL to the end.
      assert.equal((await dispatches(`"shiftId" = $1 AND type = 'shift_offered' AND "userId" = $2`, [lateOffer, gc.userId]))[0].status, 'provider_accepted');
    });

    await test('RG-13-SWITCH-OFF-STILL-WRITES-BOTH-NOTICES', async () => {
      const s = await offer(ga);
      setSwitch('false');
      const sends = fake.sends.length;
      try {
        const r = await replace(s.id, gb.id);
        assert.equal(r.status, 201, JSON.stringify(r.body));
      } finally {
        restoreSwitch();
      }
      const out = await dispatches(`"shiftId" = $1 AND type = 'shift_replaced'`, [s.id]);
      const inn = await dispatches(`"shiftId" = $1 AND type = 'shift_offered' AND "userId" = $2`, [s.id, gb.userId]);
      assert.equal(out.length, 1);
      assert.equal(inn.length, 1);
      assert.equal(out[0].status, 'skipped_disabled');
      assert.equal(inn[0].status, 'skipped_disabled');
      assert.ok((await notices(ga.userId, 'shift_replaced')).some((x: any) => x.id === out[0].nid), 'the in-app notice is written');
      assert.ok((await notices(gb.userId, 'shift_offered')).some((x: any) => x.id === inn[0].nid));
      assert.equal(fake.sends.length, sends, 'no push');
    });

    await test('RG-14-OPEN-AMENDMENT-OF-THE-OUTGOING-GUARD-IS-VOIDED', async () => {
      const s = await offer(ga);
      const amendmentId = await plantAmendment(s.id, ga.id, s.end, 'awaiting_approval');
      const r = await replace(s.id, gb.id);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const a = await one(`SELECT status, "voidedReason" r, "voidedAt" at FROM shift_amendments WHERE id = $1`, [amendmentId]);
      assert.equal(a.status, 'voided');
      assert.equal(a.r, 'guard_replaced');
      assert.ok(a.at);
      const audit = await one(`SELECT "userId" u, "afterData" d FROM audit_logs WHERE action = 'shift_amendment.voided' AND "entityId" = $1`, [amendmentId]);
      assert.equal(audit.u, A.ownerId);
      assert.deepEqual(audit.d, { status: 'voided', reason: 'guard_replaced', shiftId: s.id });
      const replaced = await one(`SELECT "afterData" d FROM audit_logs WHERE action = 'shift.guard_replaced' AND "entityId" = $1`, [s.id]);
      assert.deepEqual(replaced.d.voidedAmendmentIds, [amendmentId]);
      // No amendment notice to anyone: the shift_replaced notice is the outgoing Guard's only news.
      assert.equal((await dispatches(`"shiftId" = $1 AND type LIKE 'shift_amendment%'`, [s.id])).length, 0);
    });

    await test('RG-15-A-STALE-REPLACED-PUSH-IS-NOT-SENT-AFTER-GIVE-BACK', async () => {
      const s = await offer(ga);
      fake.mode = 'http500';
      try {
        assert.equal((await replace(s.id, gb.id)).status, 201);
      } finally {
        fake.mode = 'ok';
      }
      const [d] = await dispatches(`"shiftId" = $1 AND type = 'shift_replaced'`, [s.id]);
      assert.equal(d.status, 'failed', 'the outage leaves it owed');
      // Before the retry, the shift is given back to the Guard who was replaced.
      const back = await replace(s.id, ga.id);
      assert.equal(back.status, 201, JSON.stringify(back.body));
      await q(`UPDATE guard_notification_dispatches SET "sentAt" = now() - interval '5 minutes' WHERE id = $1`, [d.id]);
      await gn.runRetryJob();
      const [after] = await dispatches(`id = $1`, [d.id]);
      assert.equal(after.status, 'skipped_ineligible', 'the old news is never pushed to the Guard who holds the shift again');
      // A replaced Guard whose shift is still not theirs IS retried.
      const s2 = await offer(ga);
      fake.mode = 'http500';
      try {
        assert.equal((await replace(s2.id, gb.id)).status, 201);
      } finally {
        fake.mode = 'ok';
      }
      const [d2] = await dispatches(`"shiftId" = $1 AND type = 'shift_replaced'`, [s2.id]);
      await q(`UPDATE guard_notification_dispatches SET "sentAt" = now() - interval '5 minutes' WHERE "shiftId" = $1`, [s2.id]);
      await gn.runRetryJob();
      assert.equal((await dispatches(`id = $1`, [d2.id]))[0].status, 'provider_accepted');
      assert.equal(sentFor(d2.nid).length >= 1, true);
    });

    await test('RG-16-NO-PERSONAL-DATA', async () => {
      const replacedMessages = fake.sends.flat().filter((m) => m.data?.type === 'shift_replaced');
      assert.ok(replacedMessages.length >= 5, `a sample: ${replacedMessages.length}`);
      const banned = [SITE_NAME, 'Lanternfield', SITE_ADDRESS, 'Ropewalk', A.name, B.name, 'Security Ltd', 'Fullname', '@example.invalid', 'Staff Person', REASON, 'sick'];
      for (const gd of guards) banned.push(gd.label, gd.phone, gd.licence, gd.email);
      for (const m of fake.sends.flat()) {
        for (const text of [m.title, m.body]) {
          for (const word of banned) assert.ok(!String(text).includes(word), `"${text}" contains "${word}"`);
          assert.doesNotMatch(String(text), /\b0\d{9,10}\b|\+44|\d{16}/);
        }
        const keys = Object.keys(m.data).sort();
        assert.ok(keys.every((k) => ['kind', 'notificationId', 'type', 'shiftId', 'amendmentId'].includes(k)), `identifiers only: ${keys}`);
      }
      for (const row of await q(`SELECT title, message FROM notifications WHERE type IN ('shift_replaced', 'shift_offered')`)) {
        for (const word of banned) assert.ok(!`${row.title} ${row.message}`.includes(word), `notice "${row.message}" contains "${word}"`);
      }
      for (const row of await q(`SELECT "beforeData" b, "afterData" a FROM audit_logs WHERE action = 'shift.guard_replaced'`)) {
        const allowed = ['guardId', 'status', 'reasonCategory', 'reason', 'noShow', 'fatigue', 'fatigueAcknowledged', 'rotaSlotId', 'voidedAmendmentIds'];
        for (const k of [...Object.keys(row.b), ...Object.keys(row.a)]) assert.ok(allowed.includes(k), `audit field ${k}`);
        const text = JSON.stringify(row);
        for (const gd of guards) for (const v of [gd.label, gd.phone, gd.licence, gd.email]) assert.ok(!text.includes(v), `audit contains ${v}`);
        assert.ok(!text.includes(SITE_NAME) && !text.includes(SITE_ADDRESS));
      }
      assert.doesNotMatch(JSON.stringify(fake.sends), /Bearer|accessToken|refreshToken|password|eyJ[A-Za-z0-9_-]{10,}/);
    });

    await test('RG-17-NO-SHOW-REPLACEMENT-AFTER-THE-GRACE-WITH-EXPLICIT-CONFIRMATION', async () => {
      const outgoing = await guard('rg-noshow-out');
      const cover = await guard('rg-noshow-cover');
      const before = await counts();
      // Started 20 minutes ago (past the 15-minute missed-shift grace), accepted, never booked on.
      const s = await planted(outgoing, 'ready', -20 * MIN, 6 * HOUR);
      const noFlag = await replace(s, cover.id);
      assert.equal(noFlag.status, 409);
      assert.equal(noFlag.body.code, 'REPLACE_GUARD_NO_SHOW_CONFIRMATION_REQUIRED');
      const early = await planted(outgoing, 'ready', -5 * MIN, 6 * HOUR);
      const tooEarly = await replace(early, cover.id, A.token, REASON, { noShow: true });
      assert.equal(tooEarly.status, 409);
      assert.equal(tooEarly.body.code, 'REPLACE_GUARD_NO_SHOW_TOO_EARLY', 'the existing missed-shift grace applies');
      const future = await planted(outgoing, 'ready', 900 * HOUR, 906 * HOUR);
      const notStarted = await replace(future, cover.id, A.token, REASON, { noShow: true });
      assert.equal(notStarted.status, 422);
      assert.equal(notStarted.body.code, 'REPLACE_GUARD_NO_SHOW_NOT_APPLICABLE', 'no no-show before the start');
      const offeredLive = await planted(outgoing, 'offered', -20 * MIN, 6 * HOUR);
      const notAccepted = await replace(offeredLive, cover.id, A.token, REASON, { noShow: true });
      assert.equal(notAccepted.body.code, 'REPLACE_GUARD_NO_SHOW_NOT_APPLICABLE', 'an offer was never accepted: not a no-show');
      const ended = await planted(outgoing, 'ready', -8 * HOUR, -MIN);
      assert.equal((await replace(ended, cover.id, A.token, REASON, { noShow: true })).body.code, 'REPLACE_GUARD_SHIFT_ENDED');
      assert.deepEqual(await counts(), before, 'no refusal writes anything');

      const startRow = await one(`SELECT start FROM shifts WHERE id = $1`, [s]);
      const ok = await replace(s, cover.id, A.token, REASON, { noShow: true });
      assert.equal(ok.status, 201, `${ok.status} ${JSON.stringify(ok.body)}`);
      const row = await shiftRow(s);
      assert.deepEqual([row.g, row.status], [cover.id, 'offered'], 'a fresh offer to the cover Guard');
      const audit = await one(`SELECT "userId" u, "beforeData" b, "afterData" a FROM audit_logs WHERE action = 'shift.guard_replaced' AND "entityId" = $1`, [s]);
      assert.equal(audit.u, A.ownerId, 'the actor');
      assert.deepEqual(audit.b, { guardId: outgoing.id, status: 'ready' });
      assert.equal(audit.a.noShow.scheduledStart, new Date(startRow.start).toISOString());
      assert.equal(audit.a.noShow.graceMinutes, 15);
      assert.equal(audit.a.noShow.attendanceEvents, 0);
      assert.ok(new Date(audit.a.noShow.checkedAt).getTime() >= new Date(startRow.start).getTime() + 15 * MIN, 'checked after the grace');
      // The Guard who did not show cannot Book On now: the shift is not theirs.
      const late = await api('POST', '/attendance/check-in', outgoing.token, { shiftId: s });
      // Book On's own pre-check answers "not assigned to the current guard" (403); under the lock it would be 404.
      assert.ok([403, 404].includes(late.status), `late Book On: ${late.status} ${JSON.stringify(late.body)}`);
      assert.equal((await q(`SELECT 1 FROM attendance_events WHERE "shiftId" = $1`, [s])).length, 0);
      // The cover Guard accepts the late offer themselves, then can Book On.
      await accept(cover, s);
      const on = await api('POST', '/attendance/check-in', cover.token, { shiftId: s });
      assert.equal(on.status, 201, `cover Book On: ${on.status} ${JSON.stringify(on.body)}`);
    });

    await test('RG-18-NO-SHOW-RACING-BOOK-ON-BOTH-ORDERS', async () => {
      for (const first of ['bookOn', 'replace'] as const) {
        const outgoing = await guard(`rg-race-out-${first}`);
        const cover = await guard(`rg-race-cover-${first}`);
        const s = await planted(outgoing, 'ready', -20 * MIN, 6 * HOUR);
        const bookOn = () => api('POST', '/attendance/check-in', outgoing.token, { shiftId: s });
        const rep = () => replace(s, cover.id, A.token, REASON, { noShow: true });
        // Hold the shift row so both requests pass their pre-checks and queue on the lock in a known order.
        const runner = ds.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        await runner.query(`SELECT 1 FROM shifts WHERE id = $1 FOR UPDATE`, [s]);
        const a = first === 'bookOn' ? bookOn() : rep();
        await new Promise((r) => setTimeout(r, 400));
        const b = first === 'bookOn' ? rep() : bookOn();
        await new Promise((r) => setTimeout(r, 400));
        await runner.commitTransaction();
        await runner.release();
        const [ra, rb] = await Promise.all([a, b]);
        const row = await shiftRow(s);
        const events = await q(`SELECT "guardId" g FROM attendance_events WHERE "shiftId" = $1`, [s]);
        if (first === 'bookOn') {
          assert.equal(ra.status, 201, `Book On first wins: ${ra.status} ${JSON.stringify(ra.body)}`);
          assert.equal(rb.status, 409, `then the replacement is refused: ${rb.status} ${JSON.stringify(rb.body)}`);
          assert.ok(['REPLACE_GUARD_SHIFT_CHANGED', 'REPLACE_GUARD_SHIFT_IN_PROGRESS', 'REPLACE_GUARD_ATTENDANCE_RECORDED'].includes(rb.body.code), rb.body.code);
          assert.deepEqual([row.g, row.status], [outgoing.id, 'in_progress']);
          assert.equal(events.length, 1);
          assert.equal((await dispatches(`"shiftId" = $1 AND type = 'shift_replaced'`, [s])).length, 0);
          assert.equal((await q(`SELECT 1 FROM audit_logs WHERE action = 'shift.guard_replaced' AND "entityId" = $1`, [s])).length, 0);
        } else {
          assert.equal(ra.status, 201, `replace first wins: ${ra.status} ${JSON.stringify(ra.body)}`);
          assert.equal(rb.status, 404, `then the Book On finds the shift is not theirs: ${rb.status} ${JSON.stringify(rb.body)}`);
          assert.deepEqual([row.g, row.status], [cover.id, 'offered']);
          assert.equal(events.length, 0, 'no attendance for the replaced Guard');
        }
      }
    });

    await test('RG-19-A-MARKETPLACE-HIRE-IS-REFUSED-AND-NEVER-REWRITTEN', async () => {
      const job = (await one(`INSERT INTO jobs ("companyId",title,"guardsRequired","hourlyRate") VALUES ($1,'Hire spec job',1,15) RETURNING id`, [A.id])).id;
      const application = (await one(`INSERT INTO job_applications ("jobId","guardId",status,"hiredAt") VALUES ($1,$2,'accepted',now()) RETURNING id`, [job, ga.id])).id;
      const assignment = (await one(`INSERT INTO assignments ("jobId","companyId","guardId","applicationId",status) VALUES ($1,$2,$3,$4,'assigned') RETURNING id`,
        [job, A.id, ga.id, application])).id;
      const snapshot = async () => q(`SELECT a.id, a."guardId", a.status, a."applicationId", j.status js, ja.status jas, ja."guardId" jag
        FROM assignments a JOIN jobs j ON j.id = a."jobId" JOIN job_applications ja ON ja.id = a."applicationId" WHERE a.id = $1`, [assignment]);
      const before = await snapshot();
      for (const link of [
        { assignmentId: assignment, jobApplicationId: application },
        { assignmentId: assignment, jobApplicationId: null },
        { assignmentId: null, jobApplicationId: application },
      ]) {
        const s = await offer(ga);
        await q(`UPDATE shifts SET "assignmentId" = $2, "jobApplicationId" = $3, "jobId" = $4 WHERE id = $1`, [s.id, link.assignmentId, link.jobApplicationId, job]);
        const c = await counts();
        const r = await replace(s.id, gb.id);
        assert.equal(r.status, 409, `${JSON.stringify(link)}: ${r.status} ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, 'REPLACE_GUARD_HIRE_LINKED');
        assert.deepEqual(await counts(), c, 'nothing written');
        const row = await one(`SELECT "guardId" g, status, "assignmentId" aid, "jobApplicationId" jid FROM shifts WHERE id = $1`, [s.id]);
        assert.deepEqual([row.g, row.status, row.aid, row.jid], [ga.id, 'offered', link.assignmentId, link.jobApplicationId]);
      }
      assert.deepEqual(await snapshot(), before, 'the hire records are exactly as they were');
    });

    await test('RG-20-GUARDS-SEE-ONLY-THE-NEUTRAL-REASON-CATEGORY', async () => {
      const labels: Record<string, string> = { operational_change: 'Operational change', cover_rearranged: 'Cover rearranged', schedule_change: 'Schedule change' };
      let i = 0;
      for (const [category, label] of Object.entries(labels)) {
        i += 1;
        const secret = `SECRET-FREE-TEXT-${i} the guard was late twice`;
        const s = await offer(ga);
        const r = await replace(s.id, gb.id, A.token, secret, { reasonCategory: category });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        const [d] = await dispatches(`"shiftId" = $1 AND type = 'shift_replaced'`, [s.id]);
        const notice = (await notices(ga.userId, 'shift_replaced')).find((x: any) => x.id === d.nid);
        assert.ok(notice.message.includes(`Reason: ${label}.`), notice.message);
        for (const m of sentFor(d.nid)) assert.ok(!m.body.includes(label) && !m.title.includes(label), 'not even the category on the lock screen');
        const audit = await one(`SELECT "afterData" a FROM audit_logs WHERE action = 'shift.guard_replaced' AND "entityId" = $1`, [s.id]);
        assert.equal(audit.a.reason, secret, 'the free text is kept in the authorised history');
        assert.equal(audit.a.reasonCategory, category);
      }
      assert.equal((await one(`SELECT count(*)::int n FROM notifications WHERE message LIKE '%SECRET-FREE-TEXT%' OR title LIKE '%SECRET-FREE-TEXT%'`)).n, 0,
        'no Guard (or anyone) is ever notified with the free text');
      assert.ok(!JSON.stringify(fake.sends).includes('SECRET-FREE-TEXT'), 'and no push carries it');
      // The Guard's own reads of their notices carry no free text either.
      const mine = await api('GET', '/notifications', ga.token);
      assert.ok(!JSON.stringify(mine.body).includes('SECRET-FREE-TEXT'));
    });

    await test('RG-21-FATIGUE-AND-REST-OF-THE-REPLACEMENT', async () => {
      const OFF = 2000 * HOUR; // far from every other window in this suite
      const opsEmail = 'rg.operations@example.invalid';
      const opsId = await user(opsEmail, 'company_admin');
      await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,'operations','active')`, [opsId, A.id]);
      const opsToken = await login(opsEmail);

      // Over the maximum shift length (16 h): refused.
      const f1 = await guard('rg-fatigue-1');
      const long17 = await planted(ga, 'offered', OFF, OFF + 17 * HOUR);
      let r = await replace(long17, f1.id);
      assert.equal(r.status, 422, JSON.stringify(r.body));
      assert.equal(r.body.code, 'REPLACE_GUARD_FATIGUE_LIMIT');
      assert.equal(r.body.details.assessment.totalScheduledHours, 17);

      // Over the approval threshold (14 h): an Owner / Admin acknowledges it explicitly; Operations may not.
      const long15 = await planted(ga, 'offered', OFF + 40 * HOUR, OFF + 55 * HOUR);
      r = await replace(long15, f1.id);
      assert.equal(r.status, 422);
      assert.equal(r.body.code, 'REPLACE_GUARD_FATIGUE_ACKNOWLEDGEMENT_REQUIRED');
      r = await replace(long15, f1.id, opsToken, REASON, { fatigueAcknowledged: true });
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.code, 'REPLACE_GUARD_FATIGUE_APPROVER_REQUIRED');
      assert.equal((await shiftRow(long15)).g, ga.id);
      r = await replace(long15, f1.id, A.token, REASON, { fatigueAcknowledged: true });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.replacementAssessment.approvalRequired, true);
      assert.ok(r.body.replacementAssessment.warnings.includes('LONG_SHIFT'));
      let audit = await one(`SELECT "afterData" a FROM audit_logs WHERE action = 'shift.guard_replaced' AND "entityId" = $1`, [long15]);
      assert.equal(audit.a.fatigueAcknowledged, true);
      assert.equal(audit.a.fatigue.approvalRequired, true);

      // Over the warning (12 h), under approval: replaced, the warning returned and audited, no acknowledgement needed.
      const f2 = await guard('rg-fatigue-2');
      const long13 = await planted(ga, 'offered', OFF + 100 * HOUR, OFF + 113 * HOUR);
      r = await replace(long13, f2.id);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(r.body.replacementAssessment.warnings, ['LONG_SHIFT']);
      assert.equal(r.body.replacementAssessment.approvalRequired, false);
      audit = await one(`SELECT "afterData" a FROM audit_logs WHERE action = 'shift.guard_replaced' AND "entityId" = $1`, [long13]);
      assert.deepEqual(audit.a.fatigue.warnings, ['LONG_SHIFT']);
      assert.ok(!('fatigueAcknowledged' in audit.a));

      // Under the minimum rest (11 h) BEFORE this shift, decided by this company's shift: refused, figure shown.
      const f3 = await guard('rg-fatigue-3');
      const restBefore = await planted(ga, 'offered', OFF + 160 * HOUR, OFF + 166 * HOUR);
      await planted(f3, 'ready', OFF + 149 * HOUR, OFF + 155 * HOUR);
      r = await replace(restBefore, f3.id);
      assert.equal(r.status, 422, JSON.stringify(r.body));
      assert.equal(r.body.code, 'REPLACE_GUARD_MIN_REST');
      assert.equal(r.body.details.assessment.restHoursBefore, 5);

      // Under the minimum rest AFTER this shift, decided by ANOTHER company's shift: refused, the figure withheld.
      const f4 = await guard('rg-fatigue-4');
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [B.id, f4.id]);
      const restAfter = await planted(ga, 'offered', OFF + 220 * HOUR, OFF + 226 * HOUR);
      await planted(f4, 'ready', OFF + 230 * HOUR, OFF + 236 * HOUR, B);
      r = await replace(restAfter, f4.id);
      assert.equal(r.status, 422, JSON.stringify(r.body));
      assert.equal(r.body.code, 'REPLACE_GUARD_MIN_REST');
      assert.equal(r.body.details.assessment.restHoursAfter, null, "another company's schedule is never revealed");
      assert.equal(r.body.details.assessment.restFiguresWithheld, true);
      assert.doesNotMatch(r.body.message, /\b4\b/, 'no gap figure in the message');

      // The rolling 7 days over the weekly review (48 h): replaced, with the WEEKLY_HOURS warning.
      const f5 = await guard('rg-fatigue-5');
      for (let k = 0; k < 6; k += 1) {
        await planted(f5, 'ready', OFF + (290 + 24 * k) * HOUR, OFF + (300 + 24 * k) * HOUR);
      }
      // Last one ends at +420 h: 12 h rest before this shift (432 h–442 h); the 7-day window starts at 274 h.
      const weekly = await planted(ga, 'offered', OFF + 432 * HOUR, OFF + 442 * HOUR);
      r = await replace(weekly, f5.id);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(r.body.replacementAssessment.warnings, ['WEEKLY_HOURS']);
      assert.equal(r.body.replacementAssessment.companySevenDayScheduledHours, 70, 'six 10-hour shifts plus this one');
      assert.equal(r.body.replacementAssessment.restHoursBefore, 12);
    });

    await test('RG-22-THE-REPLACEMENT-IS-NOT-CONFIRMED-COVER-UNTIL-THEY-ACCEPT', async () => {
      const w = nextWindow(8);
      const slot = await api('POST', '/rota-slots', A.token, { siteId: A.siteId, startAt: iso(w.start), endAt: iso(w.end), requiredGuardCount: 1 });
      const slotId = Number(slot.body.id ?? slot.body.slot?.id);
      const [{ id: shiftId }] = await q(`SELECT id FROM shifts WHERE "rotaSlotId" = $1`, [slotId]);
      assert.equal((await api('POST', `/rota-slots/${slotId}/assign`, A.token, { shiftId, guardId: ga.id })).status, 201);
      await accept(ga, shiftId);
      const ukDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(w.start));
      const coverage = async () => {
        const res = await api('GET', `/coverage/shifts?from=${ukDate}&to=${ukDate}&shiftId=${shiftId}`, A.token);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return (res.body as any[]).find((x) => x.id === shiftId || x.shiftId === shiftId);
      };
      const slotState = async () => (await api('GET', `/rota-slots/${slotId}`, A.token)).body;
      let st = await slotState();
      assert.equal(st.counts.confirmed, 1);
      assert.equal(st.coverageState, 'fully_planned');
      assert.equal((await coverage()).coverageState, 'confirmed');

      assert.equal((await replace(shiftId, gb.id)).status, 201);
      st = await slotState();
      assert.equal(st.counts.confirmed, 0, 'the replacement is not confirmed cover');
      assert.equal(st.counts.offered, 1);
      assert.equal(st.coverageState, 'offered_pending');
      assert.equal((await coverage()).coverageState, 'waiting_response', 'coverage waits for their response');

      await accept(gb, shiftId);
      st = await slotState();
      assert.equal(st.counts.confirmed, 1);
      assert.equal(st.coverageState, 'fully_planned');
      assert.equal((await coverage()).coverageState, 'confirmed', 'confirmed only once they accept');
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
