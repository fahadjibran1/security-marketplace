/**
 * S4 Pilot Blocker Fix Pack 1 — core shift lifecycle certification (real PostgreSQL, real Nest app, real HTTP).
 *
 *   P0-1  Book Off / Timesheet    Rota Shift → offer → accept → Book On → Book Off completes AND has exactly one
 *                                 Timesheet carrying the attendance-authoritative actual check-in / check-out.
 *                                 Book Off is atomic and retry-safe. Non-Rota Shifts are unchanged.
 *   P0-2  Authentication          missing / malformed / expired / forged JWT → 401. A valid principal that lacks the
 *                                 permission stays 403.
 *   P0-3  Missed check-call scan  a Guard's `check_call` log (the event the app records) counts as contact; a Shift
 *                                 with no contact still raises exactly one alert.
 *
 * Requires PILOT_CORE_DATABASE_URL (a LOCAL, disposable PostgreSQL; migrations are applied, nothing is dropped).
 * Users are created through AuthService.register/login (the real registration + session code) and every product
 * action goes over HTTP. SQL is used only where the product has no API in a test environment: compliance evidence
 * rows (no object storage), the platform-Admin VETTED review, time travel of already-recorded timestamps, and a
 * trigger that injects a Timesheet write failure to prove Book Off rollback.
 *
 * Guard approval is a Platform Admin action (it writes platform-global state on the shared GuardProfile, so no one
 * Company may do it), and public registration deliberately cannot mint an Admin. The Platform Admin identity is
 * therefore created through the product's own operator provisioning path, AdminOperatorService — the same code the
 * `admin:bootstrap` CLI runs — and then logged in normally, so the approval call itself still crosses real HTTP
 * and real authorization.
 */
process.env.TZ = 'UTC'; // DB `timestamp` columns are UTC; keep Node in the same zone so event times round-trip exactly.

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
// AppModule is imported dynamically inside main(), NOT here. Importing it evaluates
// ConfigModule.forRoot({ validate }), which snapshots process.env at that moment, and
// @nestjs/config gives that snapshot precedence over later process.env writes. A static import is
// hoisted above the assignments below, so the app would bind to whatever DATABASE_URL the
// surrounding environment already had — the release-gate database rather than this spec's own.
import { AuthService } from '../src/auth/auth.service';
import { SafetyAlertService } from '../src/safety-alert/safety-alert.service';
import { AdminOperatorService } from '../src/admin-operator/admin-operator.service';

const url = process.env.PILOT_CORE_DATABASE_URL;
if (!url) throw new Error('PILOT_CORE_DATABASE_URL is required');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Pilot core database must be local');
process.env.DATABASE_URL = url;
// DATABASE_POOLER_URL wins over DATABASE_URL wherever the app builds its connection, so an ambient
// pooler URL would silently redirect this spec away from its disposable database. Clear it.
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'pilot-core-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

let passed = 0;
const pass = (name: string) => {
  passed += 1;
  console.log(`PASS ${name}`);
};

type Res = { status: number; body: any };
type Session = { token: string; userId: number; companyId?: number; guardId?: number; email: string };

const RUN = Date.now().toString(36);
const HOUR = 3_600_000;
const MIN = 60_000;
const day = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};
const at = (d: Date, h: number, m = 0) => {
  const x = new Date(d);
  x.setUTCHours(h, m, 0, 0);
  return x;
};
const iso = (d: Date) => d.toISOString();
const ymd = (d: Date) => iso(d).slice(0, 10);
const positionsOf = (slot: any): any[] => slot.positions || slot.shifts || [];
const positionId = (p: any): number => p.shiftId ?? p.id;
const errText = (r: Res) => (Array.isArray(r.body?.message) ? r.body.message.join('; ') : r.body?.message) || '';

async function main() {
  // Apply migrations first (idempotent) so the app boots against a fully migrated, empty-or-existing database.
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const migrator = new DataSource(
    buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' }),
  );
  await migrator.initialize();
  await migrator.runMigrations({ transaction: 'each' });
  await migrator.destroy();

  // Imported here, after the environment above is in place, for the reason given at the import block.
  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const base = `http://127.0.0.1:${address.port}`;
  const ds = app.get(DataSource);

  // Prove the running app is on THIS spec's disposable database and not one it inherited. Without
  // this, a misdirected connection surfaces as a baffling "relation does not exist" much later.
  const expectedDatabase = new URL(url!).pathname.replace(/^\//, '');
  const [{ current_database: actualDatabase }] = await ds.query('SELECT current_database()');
  if (actualDatabase !== expectedDatabase) {
    throw new Error(`Refusing to run: the app is connected to "${actualDatabase}", not "${expectedDatabase}".`);
  }

  const auth = app.get(AuthService);
  const scanner = app.get(SafetyAlertService);
  const jwtSecret = process.env.JWT_SECRET!;

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
    return { status: res.status, body: json };
  };
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params);
  const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params))[0].n);
  const timesheetCount = (shiftId: number) => count('SELECT count(*) n FROM timesheets WHERE "shiftId" = $1', [shiftId]);
  const attendanceCount = (shiftId: number, type: string) =>
    count('SELECT count(*) n FROM attendance_events WHERE "shiftId" = $1 AND type = $2', [shiftId, type]);
  const shiftStatus = async (id: number) => (await q('SELECT status FROM shifts WHERE id = $1', [id]))[0]?.status;

  try {
    // ─────────────────────────── fixtures: real registration + real sessions ───────────────────────────
    const password = 'Str0ng-pass-1!';
    const session = async (email: string, secret = password): Promise<Session> => {
      const s: any = await auth.login({ email, password: secret });
      return { token: s.accessToken, userId: s.user.id, companyId: s.user.companyId, guardId: s.user.guardId, email };
    };
    // Gate 2: a self-registered account signs in only after verifying its address. Done the way a person
    // does it — the link from the (development outbox) email, spent through the real verification path.
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
      const email = `${label}.${RUN}@pilot-core.test`;
      await auth.register({
        email, password, role: 'company' as any, fullName: `${label} Owner`, phone: '02000000000',
        companyName: `${label} Security Ltd`, companyNumber: String(10000000 + Math.floor(Math.random() * 8999999)),
        address: '1 High St, London', contactDetails: `ops@${label}.test`,
      } as any);
      await verifyEmail(email);
      return session(email);
    };
    let siaSeq = Math.floor(Math.random() * 1e6);
    const registerGuard = async (label: string) => {
      const email = `${label}.${RUN}@pilot-core.test`;
      await auth.register({
        email, password, role: 'guard' as any, fullName: `${label} Guard`, phone: '07700000000',
        siaLicenseNumber: String(6000000000000000 + (siaSeq += 7919)),
      } as any);
      await verifyEmail(email);
      return session(email);
    };

    const co = await registerCompany('corea');
    const other = await registerCompany('coreb');
    const guards = { A: await registerGuard('ga'), B: await registerGuard('gb'), C: await registerGuard('gc'), D: await registerGuard('gd') };
    const gid = { A: guards.A.guardId!, B: guards.B.guardId!, C: guards.C.guardId!, D: guards.D.guardId! };
    assert.ok(co.companyId && guards.A.guardId, 'registration produced company + guard sessions');
    pass('SETUP: real registration + login produce Company and Guard sessions');

    const client = await api('POST', '/clients', co.token, { name: 'Acme Retail', contactName: 'Pat', contactEmail: 'pat@acme.test', contactPhone: '02011112222' });
    assert.equal(client.status, 201, errText(client));
    const site = await api('POST', '/sites', co.token, {
      name: 'Acme Store 1', clientId: client.body.id, address: '10 Market Sq, London', welfareCheckIntervalMinutes: 60, requireGpsCheckIn: false,
    });
    assert.equal(site.status, 201, errText(site));
    const siteId: number = site.body.id;
    for (const k of ['A', 'B', 'C', 'D'] as const) {
      const link = await api('POST', '/company-guards', co.token, { companyId: co.companyId, guardId: gid[k] });
      assert.equal(link.status, 201, errText(link));
    }

    // A non-compliant Guard cannot be offered work (compliance gate is untouched by this pack). The block is a
    // compliance one: at this point the Guards have no SIA expiry, no right-to-work status and no documents.
    const d1 = day(2);
    const slot1 = await api('POST', '/rota-slots', co.token, {
      siteId, startAt: iso(at(d1, 9)), endAt: iso(at(d1, 17)), requiredGuardCount: 1, checkCallIntervalMinutes: 30, title: 'Day cover', instructions: 'Front desk',
    });
    assert.equal(slot1.status, 201, errText(slot1));
    const slot1Id: number = slot1.body.id;
    const shift1Id = positionId(positionsOf((await api('GET', `/rota-slots/${slot1Id}`, co.token)).body)[0]);
    const blocked = await api('POST', `/rota-slots/${slot1Id}/assign`, co.token, { shiftId: shift1Id, guardId: gid.A });
    assert.equal(blocked.status, 403, 'non-compliant Guard must not be assignable');
    assert.match(errText(blocked), /compliance/i, `the block must be the compliance gate: ${errText(blocked)}`);
    pass('SETUP: non-compliant Guard is still blocked from assignment');

    // Platform Admin, provisioned through the product's own operator path because public registration cannot mint
    // one. A fixed identity keeps the spec re-runnable against a database it has already used.
    const adminEmail = 'platform.admin@pilot-core.test';
    const adminPassword = 'Pilot-Core-Admin-1!';
    const operator = new AdminOperatorService(ds);
    const adminCount = await count(`SELECT count(*) n FROM users WHERE role = 'admin'`);
    if (adminCount === 0) {
      await operator.bootstrap(adminEmail, adminPassword);
    } else if ((await count(`SELECT count(*) n FROM users WHERE role = 'admin' AND LOWER(email) = $1`, [adminEmail])) === 1) {
      // This spec's own Admin from an earlier run: reset its password through the documented recovery path.
      await operator.recover(adminEmail, adminPassword, true);
    } else {
      throw new Error('This database already has a Platform Admin this spec did not create; use a disposable database.');
    }
    const admin = await session(adminEmail, adminPassword);
    assert.ok(admin.token, 'Platform Admin session established');

    // Approval writes platform-global state on the shared GuardProfile, so a Company may not do it (Phase A).
    const companyAttempt = await api('PATCH', `/guards/${gid.A}/approve`, co.token);
    assert.equal(companyAttempt.status, 403, `a Company token must not approve a Guard: ${companyAttempt.status}`);
    pass('SETUP: Guard approval is refused to a Company token (Platform Admin only)');

    // Make every Guard eligible: approval (Platform Admin API), profile + evidence + VETTED (no storage / Admin UI
    // in this environment). Approval is platform record-keeping; assignability is decided by the compliance gate.
    for (const k of ['A', 'B', 'C', 'D'] as const) {
      const ap = await api('PATCH', `/guards/${gid[k]}/approve`, admin.token);
      assert.equal(ap.status, 200, errText(ap));
    }
    const ids = Object.values(gid).join(',');
    await q(`UPDATE guard_profiles SET "siaExpiryDate" = $1, "rightToWorkStatus" = 'permanent' WHERE id IN (${ids})`, [ymd(day(400))]);
    for (const k of ['A', 'B', 'C', 'D'] as const) {
      await q(
        `INSERT INTO guard_documents ("guardId","companyId",type,"storageProvider","storageKey","originalFileName","mimeType","sizeBytes","uploadCompletedAt","expiryDate",verified,"uploadedByUserId","verifiedByUserId","verifiedAt")
         SELECT $1,$2,t,'s3-compatible',$5||t||'/'||extract(epoch from clock_timestamp())::text,t||'.pdf','application/pdf',1000,now(),$3,true,$4,$4,now()
         FROM unnest(ARRAY['sia_licence','right_to_work']::guard_documents_type_enum[]) AS t`,
        [gid[k], co.companyId, ymd(day(400)), co.userId, `pilot-core/${RUN}/${gid[k]}/`],
      );
      await q(
        `INSERT INTO guard_screenings ("guardId",status,"vettedAt","reviewedAt") VALUES ($1,'VETTED',now(),now())
         ON CONFLICT ("guardId") DO UPDATE SET status = 'VETTED'`,
        [gid[k]],
      );
    }
    const availability = async (d: Date, g: Session) => {
      const r = await api('POST', '/availability/mine/rules', g.token, { weekday: at(d, 9).getUTCDay(), startTime: '00:00', endTime: '23:59', isAvailable: true });
      assert.ok(r.status === 200 || r.status === 201, errText(r));
    };
    for (const d of [d1, day(3), day(4), day(6), day(7)]) for (const k of ['A', 'B', 'C', 'D'] as const) await availability(d, guards[k]);
    pass('SETUP: Guards approved, compliant, vetted and available');

    // ═════════════════════════════════════ P0-2 AUTHENTICATION ═════════════════════════════════════
    const jwt = new JwtService({ secret: jwtSecret });
    const claims = (s: Session, role: string) => ({ sub: s.userId, email: s.email, role, status: 'active', principalType: 'user' });
    const probe = '/timesheets/company';

    let r = await api('GET', '/auth/me', null);
    assert.equal(r.status, 401, `NO-TOKEN /auth/me → ${r.status}`);
    r = await api('GET', probe, null);
    assert.equal(r.status, 401, `NO-TOKEN ${probe} → ${r.status}`);
    assert.match(errText(r), /Authentication required/);
    pass('AUTH NO-TOKEN → 401');

    for (const bad of ['not.a.jwt', 'garbage', 'a.b.c', '']) {
      r = await api('GET', probe, bad || 'x');
      assert.equal(r.status, 401, `MALFORMED "${bad}" → ${r.status}`);
    }
    pass('AUTH MALFORMED-TOKEN → 401');

    const expired = jwt.sign(claims(co, 'company_admin'), { expiresIn: '-1h' });
    r = await api('GET', '/auth/me', expired);
    assert.equal(r.status, 401, `EXPIRED /auth/me → ${r.status}`);
    r = await api('GET', probe, expired);
    assert.equal(r.status, 401, `EXPIRED ${probe} → ${r.status}`);
    pass('AUTH EXPIRED-TOKEN → 401');

    const forged = new JwtService({ secret: 'not-the-real-secret' }).sign(claims(co, 'company_admin'), { expiresIn: '1h' });
    r = await api('GET', probe, forged);
    assert.equal(r.status, 401, `FORGED → ${r.status}`);
    const ghost = jwt.sign({ ...claims(co, 'company_admin'), sub: 987654321 }, { expiresIn: '1h' });
    r = await api('GET', probe, ghost);
    assert.equal(r.status, 401, `UNKNOWN-USER → ${r.status}`);
    pass('AUTH FORGED-TOKEN / unknown principal → 401');

    r = await api('GET', '/auth/me', co.token);
    assert.equal(r.status, 200);
    r = await api('GET', probe, co.token);
    assert.equal(r.status, 200);
    pass('AUTH VALID-TOKEN → 200');

    r = await api('GET', probe, guards.A.token);
    assert.equal(r.status, 403, `VALID-WRONG-ROLE guard on ${probe} → ${r.status}`);
    r = await api('POST', '/attendance/check-in', co.token, { shiftId: shift1Id });
    assert.equal(r.status, 403, `VALID-WRONG-ROLE company on guard-only route → ${r.status}`);
    r = await api('GET', `/shifts/${shift1Id}`, other.token);
    assert.ok(r.status === 403 || r.status === 404, `other tenant → ${r.status}`);
    pass('AUTH VALID-WRONG-PERMISSION stays 403 (never downgraded to 401)');

    // ═══════════════════════ CORE E2E: Company → Rota → offer → accept → Book On → check call → Book Off ═══════════════════════
    const assign1 = await api('POST', `/rota-slots/${slot1Id}/assign`, co.token, { shiftId: shift1Id, guardId: gid.A });
    assert.ok(assign1.status === 200 || assign1.status === 201, errText(assign1));
    assert.equal(await shiftStatus(shift1Id), 'offered');
    const offer = (await api('GET', '/shifts/my', guards.A.token)).body.find((s: any) => s.id === shift1Id);
    assert.equal(offer?.status, 'offered');
    assert.equal(offer.checkCallIntervalMinutes, 30);
    const accept = await api('PATCH', `/shifts/${shift1Id}/respond`, guards.A.token, { response: 'accepted' });
    assert.equal(accept.status, 200, errText(accept));
    assert.equal(accept.body.status, 'ready');
    assert.equal((await api('GET', '/shifts/my', guards.A.token)).body.find((s: any) => s.id === shift1Id)?.status, 'ready');
    assert.equal(await timesheetCount(shift1Id), 0, 'no Timesheet exists for a Shift that has not been worked yet');
    pass('E2E: Rota position offered → Guard accepts → Home shows ready (no Timesheet before work)');

    const on = await api('POST', '/attendance/check-in', guards.A.token, { shiftId: shift1Id, latitude: 51.5, longitude: -0.12, gpsAccuracyMeters: 10 });
    assert.equal(on.status, 201, errText(on));
    assert.equal(await shiftStatus(shift1Id), 'in_progress');
    const onAgain = await api('POST', '/attendance/check-in', guards.A.token, { shiftId: shift1Id });
    assert.equal(onAgain.body.id, on.body.id, 'Book On retry returns the same event');
    pass('E2E: Guard Book On → in_progress (retry safe)');

    // Time travel: three hours have passed since the shift started; the Guard arrived 7 minutes late.
    const shiftStart = new Date(Date.now() - 3 * HOUR);
    const shiftEnd = new Date(shiftStart.getTime() + 8 * HOUR);
    const lateArrival = new Date(shiftStart.getTime() + 7 * MIN);
    await q('UPDATE shifts SET "start" = $1, "end" = $2 WHERE id = $3', [shiftStart, shiftEnd, shift1Id]);
    await q('UPDATE attendance_events SET "occurredAt" = $1 WHERE id = $2', [lateArrival, on.body.id]);

    // Control: with NO contact since Book On, the scan records evidence for each elapsed window and
    // raises exactly one actionable summary. This proves the scan really sees a Shift built by the API.
    const controlShift = shift1Id;
    const indexedFor = async (shiftId: number) =>
      (await q(`SELECT "welfareWindowIndex" i FROM safety_alerts WHERE "shiftId" = $1 AND "welfareWindowIndex" IS NOT NULL ORDER BY 1`, [shiftId]))
        .map((r: { i: number }) => Number(r.i));
    const summariesFor = (shiftId: number) =>
      count(`SELECT count(*) n FROM safety_alerts WHERE "shiftId" = $1 AND type = 'missed_checkcall' AND "welfareWindowIndex" IS NULL`, [shiftId]);

    await scanner.runMissedWelfareChecks();
    const controlEvidence = await indexedFor(controlShift);
    assert.ok(controlEvidence.length >= 1, `the scan must see this Shift: ${controlEvidence.length} evidence rows`);
    assert.equal(await summariesFor(controlShift), 1, 'and raise exactly one actionable summary');
    await q(`DELETE FROM safety_alerts WHERE "shiftId" = $1`, [controlShift]);
    pass('P0-3 CONTROL: no contact → per-window evidence plus one summary (scan is live for this Shift)');

    // Suppression, through the real Guard API: a check call completes the window that contains it.
    const cc = await api('POST', '/daily-logs', guards.A.token, { shiftId: shift1Id, message: 'Check call: all secure', logType: 'check_call' });
    assert.equal(cc.status, 201, errText(cc));
    // Place the API-created entry inside the first elapsed window.
    //
    // PHASE 3A-ii CHANGED WHICH INTERVAL APPLIES HERE. This site carries 60 minutes and the slot carries
    // an explicit 30, and the slot now wins — so the grid is 30-minute, not 60-minute. The entry used to
    // be placed at start+30, which sat inside the single 0-60 window; on a 30-minute grid that instant is
    // the half-open BOUNDARY and belongs to window 1, leaving window 0 correctly reported missed. Moved
    // to start+15 so it is unambiguously inside window 0, which is what this test is actually about: a
    // check call completes the window that contains it, and a later unanswered window is still recorded.
    await q(`UPDATE daily_logs SET "createdAt" = $1 WHERE id = $2`, [new Date(shiftStart.getTime() + 15 * MIN), cc.body.id]);
    await scanner.runMissedWelfareChecks();
    const afterCall = await indexedFor(shift1Id);
    assert.ok(!afterCall.includes(0), `the window holding the check call must not be reported missed: ${afterCall}`);
    assert.ok(afterCall.includes(1), `a genuinely unanswered later window is still recorded: ${afterCall}`);
    pass('P0-3 E2E: a Guard check call recorded through the API completes its own window');

    const off = await api('POST', '/attendance/check-out', guards.A.token, { shiftId: shift1Id });
    assert.equal(off.status, 201, `Book Off must succeed: ${off.status} ${errText(off)}`);
    assert.equal(await shiftStatus(shift1Id), 'completed');
    assert.equal(await timesheetCount(shift1Id), 1, 'exactly one Timesheet after Book Off');
    pass('P0-1 E2E: Book Off succeeds, Shift completed, exactly one Timesheet');

    // Timesheet holds the attendance-authoritative actuals (NOT the schedule).
    const [ts] = await q(`SELECT * FROM timesheets WHERE "shiftId" = $1`, [shift1Id]);
    const [checkIn] = await q(`SELECT "occurredAt" FROM attendance_events WHERE "shiftId" = $1 AND type = 'check-in'`, [shift1Id]);
    const [checkOut] = await q(`SELECT "occurredAt" FROM attendance_events WHERE "shiftId" = $1 AND type = 'check-out'`, [shift1Id]);
    assert.equal(new Date(ts.actualCheckInAt).getTime(), new Date(checkIn.occurredAt).getTime(), 'actual check-in = Book On event');
    assert.equal(new Date(ts.actualCheckOutAt).getTime(), new Date(checkOut.occurredAt).getTime(), 'actual check-out = Book Off event');
    assert.notEqual(new Date(ts.actualCheckInAt).getTime(), new Date(ts.scheduledStartAt).getTime(), 'actual check-in is not the scheduled start');
    assert.notEqual(new Date(ts.actualCheckOutAt).getTime(), new Date(ts.scheduledEndAt).getTime(), 'actual check-out is not the scheduled end');
    const expectedMinutes = Math.round((new Date(checkOut.occurredAt).getTime() - new Date(checkIn.occurredAt).getTime()) / MIN);
    assert.equal(ts.verifiedMinutes, expectedMinutes);
    assert.equal(ts.workedMinutes, expectedMinutes);
    assert.ok(Math.abs(expectedMinutes - (3 * 60 - 7)) <= 1, `verified ≈ 173 min, got ${expectedMinutes}`);
    assert.equal(ts.approvalStatus, 'draft');
    assert.equal(ts.guardId, gid.A);
    assert.equal(ts.companyId, co.companyId);
    pass('P0-1 ACTUALS: Timesheet stores the actual Book On / Book Off events and verified minutes');

    // Retry: same result, no duplicate Timesheet, hours untouched.
    const off2 = await api('POST', '/attendance/check-out', guards.A.token, { shiftId: shift1Id });
    assert.equal(off2.status, 201);
    assert.equal(off2.body.id, off.body.id, 'Book Off retry returns the original check-out');
    assert.equal(await attendanceCount(shift1Id, 'check-out'), 1);
    assert.equal(await timesheetCount(shift1Id), 1);
    const [ts2] = await q(`SELECT "hoursWorked","verifiedMinutes","actualCheckOutAt" FROM timesheets WHERE "shiftId" = $1`, [shift1Id]);
    assert.equal(ts2.verifiedMinutes, ts.verifiedMinutes);
    assert.equal(Number(ts2.hoursWorked), Number(ts.hoursWorked));
    pass('P0-1 RETRY: repeated Book Off → one check-out, one Timesheet, hours unchanged');

    // Once the Guard has edited/submitted, a late retry must not rewrite the hours.
    await q(`UPDATE timesheets SET "hoursWorked" = 2.5, "approvalStatus" = 'submitted' WHERE "shiftId" = $1`, [shift1Id]);
    await api('POST', '/attendance/check-out', guards.A.token, { shiftId: shift1Id });
    const [ts3] = await q(`SELECT "hoursWorked","approvalStatus" FROM timesheets WHERE "shiftId" = $1`, [shift1Id]);
    assert.equal(Number(ts3.hoursWorked), 2.5);
    assert.equal(ts3.approvalStatus, 'submitted');
    await q(`UPDATE timesheets SET "hoursWorked" = $1, "approvalStatus" = 'draft' WHERE "shiftId" = $2`, [ts.hoursWorked, shift1Id]);
    pass('P0-1 RETRY: a retried Book Off never overwrites Guard-edited Timesheet hours');

    // Guard Timesheet / History, Company Timesheet.
    const mine = (await api('GET', '/timesheets/mine', guards.A.token)).body.find((t: any) => t.shift?.id === shift1Id);
    assert.ok(mine, 'Guard Timesheet lists the worked Shift');
    assert.equal(mine.verifiedMinutes, expectedMinutes);
    assert.ok(mine.actualCheckInAt && mine.actualCheckOutAt);
    const history = (await api('GET', '/shifts/my', guards.A.token)).body.find((s: any) => s.id === shift1Id);
    assert.equal(history?.status, 'completed');
    const companyTs = (await api('GET', '/timesheets/company', co.token)).body.find((t: any) => t.shift?.id === shift1Id);
    assert.ok(companyTs, 'Company Timesheet lists the worked Shift');
    assert.equal(companyTs.guard?.id ?? companyTs.guardId, gid.A);
    assert.equal((await api('GET', '/timesheets/company', other.token)).body.some((t: any) => t.shift?.id === shift1Id), false, 'other tenant cannot see it');
    pass('P0-1 E2E: Guard History, Guard Timesheet and Company Timesheet all show the worked Shift');

    // Self-heal: a Shift completed by the pre-fix code (checked out, no Timesheet) is repaired by a Book Off retry.
    await q('DELETE FROM timesheets WHERE "shiftId" = $1', [shift1Id]);
    const heal = await api('POST', '/attendance/check-out', guards.A.token, { shiftId: shift1Id });
    assert.equal(heal.status, 201);
    assert.equal(await timesheetCount(shift1Id), 1);
    const [ts4] = await q(`SELECT "verifiedMinutes","actualCheckInAt" FROM timesheets WHERE "shiftId" = $1`, [shift1Id]);
    assert.equal(ts4.verifiedMinutes, expectedMinutes);
    assert.equal(new Date(ts4.actualCheckInAt).getTime(), new Date(checkIn.occurredAt).getTime());
    pass('P0-1 HEAL: Book Off retry repairs a completed Shift that has no Timesheet');

    // ─────────── Atomicity: a Timesheet write failure rolls back the WHOLE Book Off ───────────
    const d3 = day(3);
    const slotAtomic = await api('POST', '/rota-slots', co.token, { siteId, startAt: iso(at(d3, 9)), endAt: iso(at(d3, 17)), requiredGuardCount: 1, title: 'Atomic' });
    const atomicShift = positionId(positionsOf((await api('GET', `/rota-slots/${slotAtomic.body.id}`, co.token)).body)[0]);
    await api('POST', `/rota-slots/${slotAtomic.body.id}/assign`, co.token, { shiftId: atomicShift, guardId: gid.B });
    assert.equal((await api('PATCH', `/shifts/${atomicShift}/respond`, guards.B.token, { response: 'accepted' })).status, 200);
    assert.equal((await api('POST', '/attendance/check-in', guards.B.token, { shiftId: atomicShift })).status, 201);
    await q(`CREATE OR REPLACE FUNCTION pilot_core_block_timesheet() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'pilot-core injected timesheet failure'; END $$ LANGUAGE plpgsql`);
    await q(`CREATE TRIGGER pilot_core_block_timesheet BEFORE INSERT OR UPDATE ON timesheets FOR EACH ROW WHEN (NEW."shiftId" = ${atomicShift}) EXECUTE FUNCTION pilot_core_block_timesheet()`);
    try {
      const failed = await api('POST', '/attendance/check-out', guards.B.token, { shiftId: atomicShift });
      assert.ok(failed.status >= 500, `injected failure surfaces as a server error, got ${failed.status}`);
      assert.equal(await shiftStatus(atomicShift), 'in_progress', 'Shift must NOT be completed when the Timesheet write failed');
      assert.equal(await attendanceCount(atomicShift, 'check-out'), 0, 'no orphan check-out event');
      assert.equal(await timesheetCount(atomicShift), 0);
    } finally {
      await q('DROP TRIGGER IF EXISTS pilot_core_block_timesheet ON timesheets');
      await q('DROP FUNCTION IF EXISTS pilot_core_block_timesheet()');
    }
    const recovered = await api('POST', '/attendance/check-out', guards.B.token, { shiftId: atomicShift });
    assert.equal(recovered.status, 201, errText(recovered));
    assert.equal(await shiftStatus(atomicShift), 'completed');
    assert.equal(await timesheetCount(atomicShift), 1);
    pass('P0-1 ATOMIC: Timesheet failure rolls back Book Off entirely; the Guard can simply retry');

    // ─────────── Concurrency: simultaneous Book Offs → one check-out, one Timesheet ───────────
    const slotRace = await api('POST', '/rota-slots', co.token, { siteId, startAt: iso(at(d3, 18)), endAt: iso(at(d3, 23)), requiredGuardCount: 1, title: 'Race' });
    const raceShift = positionId(positionsOf((await api('GET', `/rota-slots/${slotRace.body.id}`, co.token)).body)[0]);
    await api('POST', `/rota-slots/${slotRace.body.id}/assign`, co.token, { shiftId: raceShift, guardId: gid.C });
    await api('PATCH', `/shifts/${raceShift}/respond`, guards.C.token, { response: 'accepted' });
    await api('POST', '/attendance/check-in', guards.C.token, { shiftId: raceShift });
    const race = await Promise.all([1, 2, 3, 4].map(() => api('POST', '/attendance/check-out', guards.C.token, { shiftId: raceShift })));
    assert.ok(race.every((x) => x.status === 201), `race statuses ${race.map((x) => x.status)}`);
    assert.equal(new Set(race.map((x) => x.body.id)).size, 1, 'all callers receive the same check-out event');
    assert.equal(await attendanceCount(raceShift, 'check-out'), 1);
    assert.equal(await timesheetCount(raceShift), 1);
    pass('P0-1 CONCURRENCY: four simultaneous Book Offs → one check-out, one Timesheet');

    // ─────────── Legacy (non-Rota) Shift path: Timesheet still created up front, exactly once ───────────
    const legacyDay = day(4);
    const legacy = await api('POST', '/shifts', co.token, { siteId, guardId: gid.D, start: iso(at(legacyDay, 9)), end: iso(at(legacyDay, 17)) });
    assert.equal(legacy.status, 201, errText(legacy));
    const legacyId: number = legacy.body.id ?? legacy.body.shift?.id;
    assert.equal(await timesheetCount(legacyId), 1, 'legacy Shift creation still creates the Timesheet immediately');
    if ((await shiftStatus(legacyId)) === 'offered') {
      assert.equal((await api('PATCH', `/shifts/${legacyId}/respond`, guards.D.token, { response: 'accepted' })).status, 200);
    }
    assert.equal(await timesheetCount(legacyId), 1);
    assert.equal((await api('POST', '/attendance/check-in', guards.D.token, { shiftId: legacyId })).status, 201);
    const legacyOff = await api('POST', '/attendance/check-out', guards.D.token, { shiftId: legacyId });
    assert.equal(legacyOff.status, 201, errText(legacyOff));
    assert.equal(await timesheetCount(legacyId), 1, 'Book Off reuses the existing Timesheet');
    const [lts] = await q(`SELECT "actualCheckInAt","actualCheckOutAt","verifiedMinutes" FROM timesheets WHERE "shiftId" = $1`, [legacyId]);
    assert.ok(lts.actualCheckInAt && lts.actualCheckOutAt && lts.verifiedMinutes !== null);
    assert.equal(await shiftStatus(legacyId), 'completed');
    pass('P0-1 LEGACY: non-Rota Shift keeps its up-front Timesheet; Book Off stamps it (no duplicate)');

    // ═══════════════════════════ P0-3 SCANNER SCENARIOS (interval 60 min) ═══════════════════════════
    const now = Date.now();
    const mkLiveShift = async (
      guardKey: 'A' | 'B' | 'C' | 'D',
      startedMinsAgo: number,
      opts: { intervalSite?: number; durationHours?: number; bookOnMinsAgo?: number | null } = {},
    ) => {
      const guardId = gid[guardKey];
      const start = new Date(now - startedMinsAgo * MIN);
      const [row] = await q(
        `INSERT INTO shifts ("companyId","guardId","siteId","siteName","start","end",status,"checkCallIntervalMinutes","createdByUserId")
         VALUES ($1,$2,$3,'Acme Store 1',$4,$5,'in_progress',$6,$7) RETURNING id`,
        [co.companyId, guardId, siteId, start, new Date(start.getTime() + (opts.durationHours ?? 12) * HOUR), opts.intervalSite ?? 60, co.userId],
      );
      const bookOn = opts.bookOnMinsAgo === undefined ? startedMinsAgo : opts.bookOnMinsAgo;
      if (bookOn !== null) {
        await q(
          `INSERT INTO attendance_events ("shiftId","guardId",type,"nfcVerified","gpsVerified","occurredAt") VALUES ($1,$2,'check-in',false,false,$3)`,
          [row.id, guardId, new Date(now - bookOn * MIN)],
        );
      }
      return row.id as number;
    };
    const callAt = async (shiftId: number, guardKey: 'A' | 'B' | 'C' | 'D', minsAgo: number, logType = 'check_call') => {
      await q(
        `INSERT INTO daily_logs ("shiftId","guardId","logType",message,"createdAt") VALUES ($1,$2,$3,'call',$4)`,
        [shiftId, gid[guardKey], logType, new Date(Date.now() - minsAgo * MIN)],
      );
    };
    // W2 tells the two roles of a missed_checkcall row apart by welfareWindowIndex: NOT NULL is durable
    // per-window evidence, NULL is the single actionable shift-level summary.
    const evidenceCount = (shiftId: number) =>
      count(`SELECT count(*) n FROM safety_alerts WHERE "shiftId" = $1 AND type = 'missed_checkcall' AND "welfareWindowIndex" IS NOT NULL`, [shiftId]);
    const evidenceIdx = async (shiftId: number) =>
      (await q(`SELECT "welfareWindowIndex" i FROM safety_alerts WHERE "shiftId" = $1 AND "welfareWindowIndex" IS NOT NULL ORDER BY 1`, [shiftId]))
        .map((r: { i: number }) => Number(r.i));
    const summaryRows = (shiftId: number) =>
      q(`SELECT id, status, priority, message FROM safety_alerts WHERE "shiftId" = $1 AND type = 'missed_checkcall' AND "welfareWindowIndex" IS NULL ORDER BY id`, [shiftId]);
    const scanAll = async () => {
      await scanner.runMissedWelfareChecks();
    };

    // Contact inside every elapsed window: nothing is owed.
    const okShift = await mkLiveShift('A', 5 * 60);
    for (const ago of [255, 200, 145, 90, 40]) await callAt(okShift, 'A', ago);
    // Booked on three hours ago and silent since: windows 0 and 1 have settled unmet.
    const missShift = await mkLiveShift('B', 3 * 60);
    // A supervisor welfare_check completes its own window just as a Guard check_call does.
    const welfareShift = await mkLiveShift('A', 70);
    await callAt(welfareShift, 'A', 40, 'welfare_check');
    // Contact logged against a DIFFERENT shift must not count for this one.
    const isolatedShift = await mkLiveShift('B', 3 * 60);
    await callAt(okShift, 'B', 10);
    // Scheduled end is the boundary: a four-hour shift left running for ten hours owes four windows.
    const endBoundaryShift = await mkLiveShift('C', 10 * 60, { durationHours: 4 });
    // Booked on two hours late: the windows before that carried no obligation.
    const lateBookOnShift = await mkLiveShift('D', 250, { bookOnMinsAgo: 130 });

    await scanAll();

    assert.equal(await evidenceCount(okShift), 0, 'contact in every elapsed window leaves no evidence');
    assert.equal((await summaryRows(okShift)).length, 0, 'and raises no summary');
    assert.equal(await evidenceCount(welfareShift), 0, 'welfare_check completes its window');
    assert.deepEqual(await evidenceIdx(missShift), [0, 1], 'one durable record per missed window');
    assert.deepEqual(await evidenceIdx(isolatedShift), [0, 1], "another Shift's call does not count");
    pass('P0-3 EVIDENCE: every missed window leaves its own indexed record; completions suppress');

    // The measured pre-W2 behaviour was ONE alert for any length of lapse. Now the count is the truth.
    assert.deepEqual(await evidenceIdx(endBoundaryShift), [0, 1, 2, 3], 'no window past the scheduled end');
    const lateIdx = await evidenceIdx(lateBookOnShift);
    assert.ok(!lateIdx.includes(0) && !lateIdx.includes(1), `no retrospective misses before Book On: ${lateIdx}`);
    assert.deepEqual(lateIdx, [2, 3], 'only windows overlapping actual duty');
    pass('P0-3 BOUNDARIES: obligation stops at scheduled end and starts at actual Book On');

    const missSummary = await summaryRows(missShift);
    assert.equal(missSummary.length, 1, 'exactly one actionable summary beside the evidence');
    assert.equal(missSummary[0].status, 'open');
    assert.equal(missSummary[0].priority, 'high');
    assert.match(missSummary[0].message, /2 consecutive checks missed/);
    const openOnMiss = await count(`SELECT count(*) n FROM safety_alerts WHERE "shiftId" = $1 AND status = 'open'`, [missShift]);
    assert.equal(openOnMiss, 1, 'the evidence rows do not flood the control room');
    pass('P0-3 SUMMARY: one escalating shift-level alert carries the action');

    await scanAll();
    await scanAll();
    assert.deepEqual(await evidenceIdx(missShift), [0, 1], 'repeated sweeps never duplicate evidence');
    assert.equal((await summaryRows(missShift)).length, 1, 'nor the summary');
    assert.equal(await evidenceCount(okShift), 0);
    pass('P0-3 IDEMPOTENT: repeated sweeps converge on the same evidence and summary');

    // Contact inside the latest settled window resolves the summary; the evidence stays.
    await callAt(missShift, 'B', 65);
    await scanAll();
    const resolved = await summaryRows(missShift);
    assert.equal(resolved.length, 1, 'the summary is closed, not deleted');
    assert.equal(resolved[0].status, 'closed');
    assert.deepEqual(await evidenceIdx(missShift), [0, 1], 'historical evidence is preserved');
    pass('P0-3 RESOLUTION: a later Welfare Check closes the summary and keeps the evidence');

    // Overnight: shift began 22:00 the previous UTC day; contact spans midnight and continues into today.
    //
    // The anchor must be a UTC midnight that is already comfortably behind us. nightMissed's last call
    // is 30 minutes before the anchor, so its 60-minute deadline falls 30 minutes after it; anchoring
    // to today's midnight therefore made this scenario fail whenever the suite ran within half an hour
    // of UTC midnight, because the lapse was not yet overdue. Stepping back a day when we are too close
    // keeps a genuine midnight crossing while making the outcome independent of the wall clock.
    const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
    if (Date.now() - midnight.getTime() < 90 * MIN) midnight.setTime(midnight.getTime() - 24 * HOUR);
    const nightStart = new Date(midnight.getTime() - 2 * HOUR);
    const minsSince = (t: Date) => Math.round((Date.now() - t.getTime()) / MIN);
    const nightStartedMins = minsSince(nightStart);
    // The shift must be long enough to hold every window that has elapsed since nightStart, which can
    // be as much as 27 hours ago once the 90-minute step-back applies. A 12-hour default would cap the
    // grid below the elapsed period and the expectation would over-count.
    const nightDurationHours = 28;
    // Windows that have fully elapsed, so the ones an overnight Guard owes by now, never more than the
    // grid actually contains.
    const elapsedNightWindows = Math.min(
      Math.floor((nightStartedMins - 5) / 60),
      nightDurationHours,
    );
    assert.ok(elapsedNightWindows >= 3, `the overnight fixture needs elapsed windows, got ${elapsedNightWindows}`);

    const nightOk = await mkLiveShift('C', nightStartedMins, { durationHours: nightDurationHours });
    for (let i = 0; i < elapsedNightWindows; i += 1) {
      await callAt(nightOk, 'C', nightStartedMins - i * 60 - 30); // mid-window, so attribution is unambiguous
    }
    const nightMissed = await mkLiveShift('D', nightStartedMins, { durationHours: nightDurationHours });
    await callAt(nightMissed, 'D', nightStartedMins - 30); // window 0 only, then silence

    await scanAll();
    assert.equal(
      await evidenceCount(nightOk),
      0,
      'a call in every elapsed window is honoured straight through midnight',
    );
    const missedNight = await evidenceIdx(nightMissed);
    assert.ok(!missedNight.includes(0), 'the window that was answered leaves no evidence');
    assert.equal(
      missedNight.length,
      elapsedNightWindows - 1,
      `every later unanswered window is recorded: ${missedNight}`,
    );
    pass('P0-3 OVERNIGHT: windows cross midnight correctly and each lapse is recorded once');

    // ═════════════════════ REGRESSIONS: decline → replacement, and a 3-Guard slot ═════════════════════
    const d5 = day(6);
    const slotDecline = await api('POST', '/rota-slots', co.token, { siteId, startAt: iso(at(d5, 9)), endAt: iso(at(d5, 17)), requiredGuardCount: 1, title: 'Replacement' });
    const declineShift = positionId(positionsOf((await api('GET', `/rota-slots/${slotDecline.body.id}`, co.token)).body)[0]);
    assert.ok((await api('POST', `/rota-slots/${slotDecline.body.id}/assign`, co.token, { shiftId: declineShift, guardId: gid.B })).status < 300);
    const declined = await api('PATCH', `/shifts/${declineShift}/respond`, guards.B.token, { response: 'rejected', reason: 'Not available' });
    assert.equal(declined.status, 200);
    assert.equal(declined.body.status, 'rejected');
    assert.equal((await api('POST', `/rota-slots/${slotDecline.body.id}/positions/${declineShift}/replace`, co.token)).status < 300, true);
    const reopened = positionsOf((await api('GET', `/rota-slots/${slotDecline.body.id}`, co.token)).body);
    const openPos = reopened.find((p) => positionId(p) !== declineShift && !(p.guard || p.guardId || p.guardName));
    assert.ok(openPos, 'a fresh open position exists after replacement');
    assert.ok((await api('POST', `/rota-slots/${slotDecline.body.id}/assign`, co.token, { shiftId: positionId(openPos), guardId: gid.C })).status < 300);
    const replAccept = await api('PATCH', `/shifts/${positionId(openPos)}/respond`, guards.C.token, { response: 'accepted' });
    assert.equal(replAccept.status, 200);
    assert.equal(replAccept.body.status, 'ready');
    assert.equal(await timesheetCount(positionId(openPos)), 0, 'accepting does not manufacture a Timesheet');
    pass('REGRESSION: Guard decline → Company replacement → replacement accepts');

    const d7 = day(7);
    const slot3 = await api('POST', '/rota-slots', co.token, { siteId, startAt: iso(at(d7, 9)), endAt: iso(at(d7, 17)), requiredGuardCount: 3, title: 'Three Guard cover' });
    const p3 = positionsOf((await api('GET', `/rota-slots/${slot3.body.id}`, co.token)).body).map(positionId);
    assert.equal(new Set(p3).size, 3);
    const multi = await api('POST', `/rota-slots/${slot3.body.id}/assign-multiple`, co.token, {
      assignments: [{ shiftId: p3[0], guardId: gid.A }, { shiftId: p3[1], guardId: gid.B }, { shiftId: p3[2], guardId: gid.C }],
    });
    assert.ok(multi.status < 300, errText(multi));
    assert.equal((await api('PATCH', `/shifts/${p3[0]}/respond`, guards.A.token, { response: 'accepted' })).status, 200);
    assert.equal((await api('PATCH', `/shifts/${p3[1]}/respond`, guards.B.token, { response: 'rejected', reason: 'Sick' })).status, 200);
    assert.equal((await api('PATCH', `/shifts/${p3[2]}/respond`, guards.C.token, { response: 'accepted' })).status, 200);
    const names = positionsOf((await api('GET', `/rota-slots/${slot3.body.id}`, co.token)).body).map((p) => p.guardName ?? p.guard?.fullName).filter(Boolean);
    assert.ok(new Set(names).size >= 2, `positions keep distinct Guards: ${names}`);
    pass('REGRESSION: 3-Guard slot → different Guards, one declines, others stay independent');

    console.log(JSON.stringify({ event: 'pilot_core_certified', tests: passed }));
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
