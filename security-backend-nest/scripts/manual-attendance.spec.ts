/**
 * Manual attendance management (S4 Part B, Migration 67) certification: the whole application over HTTP, on a
 * disposable database built from the repository's own migrations.
 *
 *   MA-01  permission matrix: attendance.manage is Owner / Admin / Operations by role; Control Room only by grant
 *   MA-02  capabilities (feature detection) per role; Guards and platform admins refused
 *   MA-03  manual Book On from Ready: event, actual vs recorded time, recorder, method, shift in progress, audit
 *   MA-04  manual Book On from Missed (late arrival) — the only way missed → in_progress; the Guard app still cannot
 *   MA-05  refused for offered / cancelled / unfilled / completed shifts and for a shift with no Guard
 *   MA-06  time rules: future; before start − 12 h; after end + 12 h; > 24 h old needs Owner/Admin (Operations and
 *          Control Room refused with their own code); the Owner may
 *   MA-07  input validation (reason, method, 'other' note, explicit zone, lengths)
 *   MA-08  no duplicate Book On / Book Off (manual or app)
 *   MA-09  no overlapping attendance with the Guard's other shifts (Book On point, Book Off interval, corrections)
 *   MA-10  company isolation: another company's shift / event / history is 404
 *   MA-11  role refusals: Guard, platform admin, HR, Finance, Viewer, ungranted Control Room; granted Control Room works
 *   MA-12  the Control Room grant: Owner/Admin only, audited, Control Room only, company-scoped, shown in staff list
 *          and the session permissions, revocable
 *   MA-13  the start-of-work compliance gate applies to a manual Book On (refusal audited, nothing written)
 *   MA-14  race: Guard-app Book On vs manual Book On — exactly one wins, the other gets 409, one row
 *   MA-15  manual Book Off of an in-progress shift: completed, actuals stamped (verifiedSource manual), open extension
 *          voided, open Missing Book Off closed in the same transaction
 *   MA-16  manual Book Off after Close without Book Off; refused (409) when that timesheet is approved
 *   MA-17  Book Off refusals: not in progress, before the Book On, already booked off, in the future
 *   MA-18  corrections: append-only (original byte-identical), chain of any length with one effective value, only the
 *          tip, unchanged refused, order kept; timesheet restamped in draft / submitted / returned (Guard-edited hours
 *          kept), refused (409, nothing written) when approved or in a payroll batch
 *   MA-19  a correction of a time more than 24 h old needs Owner/Admin
 *   MA-20  every switched reader follows the effective chain: Live Ops projection (+ sources), shift-attendance export
 *          (+ recorded-by columns, early Book Off), incident analytics lateness and windows, welfare push resolution,
 *          reconciliation, amendments, /attendance/company and /attendance/mine
 *   MA-21  welfare: a late manual Book On creates NO retrospective missed checks (control: an app-time Book On does)
 *   MA-22  Missing Book Off: raised by the sweep, closed by a manual Book Off at once, never reopened by the sweep
 *   MA-23  no deadlock with the welfare sweep (sweep holds its lock and inserts an alert while a manual Book Off waits)
 *   MA-24  Mark Missed: optional reason (≤ 500) recorded in the audit; no reason still works (Part A web compatibility)
 *   MA-25  timesheets: verifiedSource shown; approval of a manual-attendance timesheet uses the unchanged workflow
 *          (no extra note, no recorder ≠ approver rule — owner decision 27 Oct 2026)
 *   MA-26  Guard app after a manual entry: app Book On of a manually booked-on shift is a 409; app Book Off after a
 *          manual Book On stamps verifiedSource manual
 *   MA-27  static: append-only (no UPDATE/DELETE of attendance_events in src), lock order, the start-of-work gate
 *   MA-28  the 24-hour Owner/Admin rule is the AGE OF THE ATTENDANCE TIME (now − occurredAt), never the shift start:
 *          old shift + recent time → Operations / Control Room allowed; recent shift + time > 24 h → refused for them,
 *          allowed for Owner/Admin; Book Off likewise; a correction counts BOTH the new time and the replaced time
 *   MA-29  existing missed-check records are never deleted or rewritten by manual Book On / Book Off or corrections
 *   MA-30  the actual time (occurredAt) and the server recording time (recordedAt) are stored separately, Book On and Off
 *
 * Needs MANUAL_ATTENDANCE_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { complianceToday } from '../src/compliance/compliance-dates';

const url = process.env.MANUAL_ATTENDANCE_DATABASE_URL;
if (!url) throw new Error('MANUAL_ATTENDANCE_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Manual attendance database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'manual-attendance-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.RESEND_API_KEY;
delete process.env.EXPO_ACCESS_TOKEN;
delete process.env.PUSH_WELFARE_REMINDERS_ENABLED;
delete process.env.PUSH_GUARD_NOTIFICATIONS_ENABLED;

let passed = 0;
const failures: string[] = [];
const test = async (id: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failures.push(id);
    console.log(`FAIL  ${id}\n      ${String((error as Error)?.stack ?? error).split('\n').slice(0, 8).join('\n      ')}`);
  }
};

type Res = { status: number; body: any };
const MIN = 60_000;
const HOUR = 60 * MIN;
const PASSWORD = 'manual-attendance-spec-only-password-1';
const REASON = 'Guard phone battery failed; confirmed by phone call';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ukDay = (n: number) => {
  const [y, m, d] = complianceToday().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const iso = (ms: number) => new Date(ms).toISOString();
const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const minute = (ms: number) => Math.floor(ms / MIN) * MIN;

async function main() {
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const migrator = new DataSource({
    ...buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' }),
    dropSchema: true,
  } as never);
  await migrator.initialize();
  const migrated = await migrator.runMigrations({ transaction: 'each' });
  assert.equal(migrated[migrated.length - 1]?.name, 'AddManualAttendance1720900000013', 'the head is Migration 67');
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

  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const { GuardNotificationService } = await import('../src/guard-notification/guard-notification.service');
  const { ShiftAmendmentService } = await import('../src/shift-amendment/shift-amendment.service');
  const { OperationsProjectionService } = await import('../src/coverage/operations-projection.service');
  const { OperationsExportService } = await import('../src/report/operations-export.service');
  const { IncidentAnalyticsService } = await import('../src/report/incident-analytics.service');
  const { WelfarePushService } = await import('../src/welfare-push/welfare-push.service');
  const { AuthService } = await import('../src/auth/auth.service');
  const { Shift } = await import('../src/shift/entities/shift.entity');
  const { AttendanceEvent } = await import('../src/attendance/entities/attendance.entity');
  const { CompanyPermission, CompanyMembershipRole, hasPermission } = await import('../src/company-membership/company-membership-types');
  const { mayManageAttendance } = await import('../src/attendance/manual-attendance-policy');
  const sweep = app.get(SafetyAlertService);
  // This process drives the sweep explicitly; the app's own timers must not race the assertions.
  clearInterval((sweep as any).welfareInterval);
  clearInterval((app.get(GuardNotificationService) as any).retryInterval);
  clearInterval((app.get(ShiftAmendmentService) as any).expiryInterval);
  const auth = app.get(AuthService);

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
  const expect = (r: Res, status: number, code?: string, what = '') => {
    assert.equal(r.status, status, `${what} expected ${status}${code ? ` ${code}` : ''}, got ${r.status} ${JSON.stringify(r.body)}`);
    if (code) assert.equal(r.body?.code, code, `${what} code: ${JSON.stringify(r.body)}`);
  };

  try {
    const hash = await bcrypt.hash(PASSWORD, 4);
    const user = async (email: string, role: string) =>
      (await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired",
          "firstName","lastName") VALUES ($1,$2,$3,'active',true,false,$4,'Spec') RETURNING id`, [email, hash, role, email.split('@')[0]])).id as number;
    const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;

    type Co = { id: number; ownerId: number; siteId: number; token: string };
    const company = async (label: string, number: string): Promise<Co> => {
      const ownerEmail = `${label}.owner@example.invalid`;
      const ownerId = await user(ownerEmail, 'company_admin');
      const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,$2,$3,'1 Way','ops@example.invalid') RETURNING id`, [ownerId, `${label} Security Ltd`, number]);
      const siteId = (await one(`INSERT INTO sites ("companyId",name,address,timezone,"welfareCheckIntervalMinutes") VALUES ($1,'Harbour Gate','3 Quay','Europe/London',60) RETURNING id`, [id])).id as number;
      return { id: id as number, ownerId, siteId, token: await login(ownerEmail) };
    };
    const A = await company('maalpha', '67111111');
    const B = await company('mabeta', '67222222');
    const staff = async (label: string, role: string, co = A) => {
      const email = `${label}@example.invalid`;
      const id = await user(email, 'company_admin');
      await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [id, co.id, role]);
      return { id, token: await login(email), role };
    };
    const admin = await staff('ma.admin', 'admin');
    const ops = await staff('ma.ops', 'operations');
    const control = await staff('ma.control', 'control_room');
    const controlGranted = await staff('ma.control2', 'control_room');
    const hr = await staff('ma.hr', 'hr_compliance');
    const finance = await staff('ma.finance', 'finance');
    const viewer = await staff('ma.viewer', 'viewer');
    const bControl = await staff('mb.control', 'control_room', B);
    await user('ma.platform@example.invalid', 'admin');
    const platform = await login('ma.platform@example.invalid');

    let n = 0;
    type G = { id: number; userId: number; token: string };
    const guard = async (co = A, opts: { compliant?: boolean } = {}): Promise<G> => {
      n += 1;
      const email = `ma.guard${n}@example.invalid`;
      const userId = await user(email, 'guard');
      const licence = `86000000000000${String(n).padStart(2, '0')}`;
      const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","siaExpiryDate","rightToWorkStatus",phone) VALUES ($1,$2,$3,$4,'british',$5) RETURNING id`,
        [userId, `Guard ${n} Fullname`, licence, ukDay(500), `0771080${String(n).padStart(4, '0')}`]);
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [co.id, id]);
      if (opts.compliant !== false) {
        for (const type of ['sia_licence', 'right_to_work']) {
          await q(`INSERT INTO guard_documents ("guardId","companyId",type,"storageProvider","storageKey","originalFileName","mimeType","sizeBytes","uploadCompletedAt",verified,"uploadedByUserId","verifiedByUserId","verifiedAt")
            VALUES ($1,$2,$3,'s3-compatible',$4,'e.pdf','application/pdf','1024',now(),true,null,null,now())`, [id, co.id, type, `ma/${co.id}/${id}/${type}`]);
        }
        for (const body of [
          { guardId: id, kind: 'sia', outcome: 'confirmed', checkDate: ukDay(0), checkedByName: 'Spec Checker', evidenceReference: 'HR/spec', method: 'sia_public_register', licenceNumber: licence, expiryDate: ukDay(400) },
          { guardId: id, kind: 'right_to_work', outcome: 'confirmed', checkDate: ukDay(0), checkedByName: 'Spec Checker', evidenceReference: 'HR/spec', method: 'manual_document', rightToWorkExcuse: 'continuous' },
        ]) {
          const r = await api('POST', '/compliance/checks', co.token, body);
          assert.equal(r.status, 201, `record ${body.kind}: ${r.status} ${JSON.stringify(r.body)}`);
        }
      }
      return { id: id as number, userId, token: await login(email) };
    };

    /** A shift of `co` for `g`, starting `startH` hours from now (negative: in the past). */
    const mkShift = async (g: G | null, status: string, startH: number, hours = 8, co: Co = A) => {
      const start = minute(Date.now() + startH * HOUR);
      const end = start + hours * HOUR;
      const { id } = await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end","checkCallIntervalMinutes")
          VALUES ($1,$2,'Harbour Gate',$3,$4,$5,$6,60) RETURNING id`, [co.id, co.siteId, g?.id ?? null, status, ts(start), ts(end)]);
      return { id: id as number, start, end };
    };
    /** A Guard-app row as the app writes it (recordedAt = occurredAt). */
    const appEvent = async (shiftId: number, g: G, type: 'check-in' | 'check-out', atMs: number) =>
      (await one(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,$3,$4,$4,true) RETURNING id`,
        [shiftId, g.id, type, ts(atMs)])).id as number;
    const timesheet = async (shiftId: number, g: G, status: string, actuals?: { on: number; off: number }, co: Co = A) => {
      const minutes = actuals ? Math.round((actuals.off - actuals.on) / MIN) : null;
      return (await one(`INSERT INTO timesheets ("shiftId","guardId","companyId","hoursWorked","workedMinutes","roundedMinutes","approvalStatus",
            "actualCheckInAt","actualCheckOutAt","verifiedMinutes") VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9) RETURNING id`,
        [shiftId, g.id, co.id, minutes === null ? 0 : Number((minutes / 60).toFixed(2)), minutes ?? 0, status,
          actuals ? ts(actuals.on) : null, actuals ? ts(actuals.off) : null, minutes])).id as number;
    };
    const body = (shiftId: number, atMs: number, over: Record<string, unknown> = {}) =>
      ({ shiftId, occurredAt: iso(atMs), reason: REASON, verificationMethod: 'phone_call', ...over });
    const fix = (atMs: number, over: Record<string, unknown> = {}) =>
      ({ occurredAt: iso(atMs), reason: 'Corrected from CCTV review', verificationMethod: 'cctv', ...over });
    const bookOn = (tok: string, shiftId: number, atMs: number, over: Record<string, unknown> = {}) =>
      api('POST', '/attendance/manual/book-on', tok, body(shiftId, atMs, over));
    const bookOff = (tok: string, shiftId: number, atMs: number, over: Record<string, unknown> = {}) =>
      api('POST', '/attendance/manual/book-off', tok, body(shiftId, atMs, over));
    const correct = (tok: string, eventId: number, atMs: number, over: Record<string, unknown> = {}) =>
      api('POST', `/attendance/events/${eventId}/corrections`, tok, fix(atMs, over));
    const rows = (shiftId: number) => q(`SELECT id, type::text, source, "occurredAt", "recordedAt", "recordedByUserId", "correctionOfEventId" FROM attendance_events WHERE "shiftId" = $1 ORDER BY id`, [shiftId]);
    const status = async (shiftId: number) => (await one(`SELECT status FROM shifts WHERE id = $1`, [shiftId])).status as string;
    const audits = (action: string, entityId: number) => q(`SELECT "userId", "companyId", "beforeData", "afterData" FROM audit_logs WHERE action = $1 AND "entityId" = $2 ORDER BY id`, [action, entityId]);
    const rowHash = async (id: number) => (await one(`SELECT md5(to_jsonb(a)::text) h FROM attendance_events a WHERE id = $1`, [id])).h as string;
    const jwt = (id: number, role = 'company_admin') => ({ sub: id, role } as never);

    // ═══════════════════ permissions ═══════════════════

    await test('MA-01-PERMISSION-MATRIX', async () => {
      const expected: Record<string, boolean> = { owner: true, admin: true, operations: true, control_room: false, hr_compliance: false, finance: false, viewer: false };
      for (const role of Object.values(CompanyMembershipRole)) {
        assert.equal(hasPermission(role, CompanyPermission.ATTENDANCE_MANAGE), expected[role], `${role} by role`);
        assert.equal(mayManageAttendance(role, true), expected[role] || role === CompanyMembershipRole.CONTROL_ROOM, `${role} with a grant`);
      }
      assert.equal(mayManageAttendance(CompanyMembershipRole.CONTROL_ROOM, false), false);
      assert.equal(Object.values(CompanyPermission).length, 37, '36 + attendance.manage');
    });

    await test('MA-02-CAPABILITIES-PER-ROLE', async () => {
      const caps = async (tok: string) => (await api('GET', '/attendance/manual/capabilities', tok)).body;
      const own = await caps(A.token);
      assert.equal(own.manualAttendance, true);
      assert.deepEqual(own.verificationMethods, ['phone_call', 'supervisor_on_site', 'cctv', 'client_confirmation', 'radio', 'other']);
      assert.deepEqual([own.windowBeforeStartHours, own.windowAfterEndHours, own.ownerAdminOnlyOlderThanHours], [12, 12, 24]);
      assert.deepEqual([own.canManage, own.canRecordOlderThan24h], [true, true]);
      assert.deepEqual([(await caps(admin.token)).canManage, (await caps(admin.token)).canRecordOlderThan24h], [true, true]);
      assert.deepEqual([(await caps(ops.token)).canManage, (await caps(ops.token)).canRecordOlderThan24h], [true, false]);
      for (const s of [control, hr, finance, viewer]) assert.equal((await caps(s.token)).canManage, false, s.role);
      const g = await guard();
      assert.equal((await api('GET', '/attendance/manual/capabilities', g.token)).status, 403, 'Guard');
      assert.equal((await api('GET', '/attendance/manual/capabilities', platform)).status, 403, 'platform admin');
    });

    // ═══════════════════ manual Book On ═══════════════════

    await test('MA-03-MANUAL-BOOK-ON-FROM-READY', async () => {
      const g = await guard();
      const s = await mkShift(g, 'ready', -1);
      const at = s.start + 7 * MIN;
      const before = Date.now();
      const r = await bookOn(ops.token, s.id, at);
      expect(r, 201, undefined, 'book on');
      const e = r.body.event;
      assert.equal(e.source, 'manual');
      assert.equal(e.type, 'check-in');
      assert.equal(e.occurredAt, iso(at), 'the actual time is stored exactly as stated (UTC)');
      assert.ok(Date.parse(e.recordedAt) >= before - 1000 && Date.parse(e.recordedAt) <= Date.now() + 1000, 'recorded at the server time');
      assert.equal(e.recordedByUserId, ops.id);
      assert.match(e.recordedByName, /ma\.ops/);
      assert.equal(e.verificationMethod, 'phone_call');
      assert.equal(e.reason, REASON);
      assert.deepEqual([e.effective, e.isCorrection, e.gpsVerified, e.nfcVerified], [true, false, false, false]);
      assert.deepEqual(r.body.shift, { id: s.id, status: 'in_progress' });
      assert.equal(await status(s.id), 'in_progress');
      const [audit] = await audits('attendance.manual_book_on', s.id);
      assert.equal(audit.userId, ops.id);
      assert.equal(audit.companyId, A.id);
      assert.equal(audit.afterData.occurredAt, iso(at));
      assert.equal(audit.afterData.reason, REASON);
      assert.equal(audit.afterData.verificationMethod, 'phone_call');
      assert.equal(audit.beforeData.status, 'ready');
      const h = await api('GET', `/attendance/shifts/${s.id}/history`, viewer.token);
      expect(h, 200, undefined, 'history (attendance.view is enough to read)');
      assert.equal(h.body.events.length, 1);
      assert.equal(h.body.effective.bookOn.id, e.id);
      assert.ok(Date.parse(h.body.effective.monitoredFrom) >= before - 1000, 'monitored from when S4 learned of it, not the actual time');
    });

    await test('MA-04-MANUAL-BOOK-ON-FROM-MISSED-LATE-ARRIVAL', async () => {
      const g = await guard();
      const s = await mkShift(g, 'missed', -2);
      const app = await api('POST', '/attendance/check-in', g.token, { shiftId: s.id });
      assert.equal(app.status, 400, 'the Guard app still cannot start a missed shift');
      const r = await bookOn(control.token, s.id, s.start + 70 * MIN);
      expect(r, 403, 'MANUAL_ATTENDANCE_FORBIDDEN', 'ungranted control room');
      const ok = await bookOn(admin.token, s.id, s.start + 70 * MIN, { verificationMethod: 'supervisor_on_site' });
      expect(ok, 201, undefined, 'late arrival');
      assert.equal(await status(s.id), 'in_progress', 'missed → in_progress through the manual path only');
      const [audit] = await audits('attendance.manual_book_on', s.id);
      assert.equal(audit.afterData.lateArrivalFromMissed, true);
      assert.equal(audit.afterData.fromStatus, 'missed');
    });

    await test('MA-05-REFUSED-FOR-OFFERED-CANCELLED-UNFILLED-COMPLETED-AND-NO-GUARD', async () => {
      const g = await guard();
      for (const st of ['offered', 'cancelled', 'rejected']) {
        const s = await mkShift(g, st, -1 - Math.random());
        expect(await bookOn(A.token, s.id, s.start + MIN), 409, 'MANUAL_BOOK_ON_STATUS', st);
        assert.equal((await rows(s.id)).length, 0);
      }
      const unfilled = await mkShift(null, 'unfilled', -1);
      expect(await bookOn(A.token, unfilled.id, unfilled.start + MIN), 409, 'MANUAL_BOOK_ON_STATUS', 'unfilled');
      const done = await mkShift(g, 'completed', -30);
      expect(await bookOn(A.token, done.id, done.start + MIN), 409, 'ATTENDANCE_ALREADY_BOOKED_ON', 'completed');
      const noGuard = await mkShift(null, 'ready', -1);
      expect(await bookOn(A.token, noGuard.id, noGuard.start + MIN), 409, 'ATTENDANCE_NO_GUARD');
    });

    await test('MA-06-TIME-RULES', async () => {
      const g = await guard();
      const s = await mkShift(g, 'ready', -1);
      expect(await bookOn(A.token, s.id, Date.now() + 5 * MIN), 422, 'ATTENDANCE_TIME_IN_FUTURE');
      const early = await mkShift(await guard(), 'ready', 10); // starts in 10 h: start − 12 h is 2 h ago
      expect(await bookOn(A.token, early.id, early.start - 13 * HOUR), 422, 'ATTENDANCE_TIME_OUTSIDE_WINDOW', 'before start − 12 h');
      expect(await bookOn(A.token, early.id, early.start - 11 * HOUR), 201, undefined, 'inside start − 12 h');
      const old = await mkShift(await guard(), 'ready', -40, 8); // ended 32 h ago
      const tooLate = await bookOn(A.token, old.id, old.end + 13 * HOUR);
      expect(tooLate, 422, 'ATTENDANCE_TIME_OUTSIDE_WINDOW', 'after end + 12 h');
      assert.ok(tooLate.body.details.earliest && tooLate.body.details.latest);
      for (const s2 of [ops, controlGranted]) {
        if (s2 === controlGranted) await api('PUT', `/attendance/control-room/${controlGranted.id}`, A.token, { canManageAttendance: true });
        expect(await bookOn(s2.token, old.id, old.start + 10 * MIN), 403, 'ATTENDANCE_OLD_ENTRY_REQUIRES_OWNER_OR_ADMIN', s2.role);
      }
      expect(await bookOn(admin.token, old.id, old.start + 10 * MIN), 201, undefined, 'an Admin may record a time more than 24 h old');
      assert.equal((await rows(s.id)).length, 0, 'nothing written by the refusals');
    });

    await test('MA-07-INPUT-VALIDATION', async () => {
      const s = await mkShift(await guard(), 'ready', -1);
      const at = s.start + MIN;
      expect(await bookOn(A.token, s.id, at, { reason: '   ' }), 400, 'ATTENDANCE_VALIDATION', 'blank reason');
      expect(await bookOn(A.token, s.id, at, { reason: 'x'.repeat(501) }), 400, 'ATTENDANCE_VALIDATION', 'long reason');
      expect(await bookOn(A.token, s.id, at, { verificationMethod: 'gut_feeling' }), 400, 'ATTENDANCE_VALIDATION', 'unknown method');
      expect(await bookOn(A.token, s.id, at, { verificationMethod: 'other' }), 400, 'ATTENDANCE_VALIDATION', "'other' without a note");
      expect(await bookOn(A.token, s.id, at, { occurredAt: iso(at).replace('Z', '') }), 400, 'ATTENDANCE_VALIDATION', 'no zone');
      expect(await bookOn(A.token, s.id, at, { occurredAt: 'yesterday' }), 400, 'ATTENDANCE_VALIDATION');
      assert.equal((await bookOn(A.token, s.id, at, { extra: 1 })).status, 400, 'unknown fields are refused');
      assert.equal((await rows(s.id)).length, 0);
      const r = await bookOn(A.token, s.id, at, { verificationMethod: 'other', verificationNote: 'Client duty manager saw him arrive' });
      expect(r, 201);
      assert.equal(r.body.event.verificationNote, 'Client duty manager saw him arrive');
    });

    await test('MA-08-NO-DUPLICATES', async () => {
      const g = await guard();
      const s = await mkShift(g, 'ready', -1);
      expect(await bookOn(A.token, s.id, s.start + MIN), 201);
      expect(await bookOn(admin.token, s.id, s.start + 2 * MIN), 409, 'ATTENDANCE_ALREADY_BOOKED_ON', 'second manual Book On');
      const g2 = await guard();
      const s2 = await mkShift(g2, 'in_progress', -1);
      await appEvent(s2.id, g2, 'check-in', s2.start);
      expect(await bookOn(A.token, s2.id, s2.start + MIN), 409, 'ATTENDANCE_ALREADY_BOOKED_ON', 'after an app Book On');
      expect(await bookOff(A.token, s.id, Date.now() - MIN), 201);
      expect(await bookOff(A.token, s.id, Date.now()), 409, 'ATTENDANCE_ALREADY_BOOKED_OFF');
      assert.equal((await rows(s.id)).length, 2);
    });

    await test('MA-09-NO-OVERLAPPING-ATTENDANCE', async () => {
      const g = await guard();
      const first = await mkShift(g, 'completed', -10, 4); // worked -10h .. -6h
      await appEvent(first.id, g, 'check-in', first.start);
      await appEvent(first.id, g, 'check-out', first.end);
      const second = await mkShift(g, 'missed', -7, 6);
      const r = await bookOn(A.token, second.id, first.start + HOUR);
      expect(r, 409, 'ATTENDANCE_OVERLAP', 'Book On inside the other shift');
      assert.equal(r.body.details.shiftId, first.id);
      expect(await bookOn(A.token, second.id, first.end), 201, undefined, 'touching ends do not overlap');
      const third = await mkShift(g, 'completed', -20, 4);
      await appEvent(third.id, g, 'check-in', third.start);
      const [thirdOff] = [await appEvent(third.id, g, 'check-out', third.end)];
      expect(await correct(A.token, thirdOff, first.start + 30 * MIN), 409, 'ATTENDANCE_OVERLAP', 'a correction into another shift');
      const fourth = await mkShift(g, 'in_progress', -30, 4);
      await appEvent(fourth.id, g, 'check-in', fourth.start);
      expect(await bookOff(admin.token, fourth.id, third.start + 30 * MIN), 409, 'ATTENDANCE_OVERLAP', 'a Book Off spanning another shift');
    });

    await test('MA-10-COMPANY-ISOLATION', async () => {
      const g = await guard();
      const s = await mkShift(g, 'ready', -1);
      const own = await bookOn(A.token, s.id, s.start + MIN);
      expect(await bookOn(B.token, s.id, s.start + MIN), 404, 'MANUAL_ATTENDANCE_NOT_FOUND', "another company's shift");
      expect(await bookOff(B.token, s.id, Date.now()), 404, 'MANUAL_ATTENDANCE_NOT_FOUND');
      expect(await correct(B.token, own.body.event.id, s.start + 2 * MIN), 404, 'MANUAL_ATTENDANCE_NOT_FOUND', "another company's event");
      expect(await api('GET', `/attendance/shifts/${s.id}/history`, B.token), 404, 'MANUAL_ATTENDANCE_NOT_FOUND');
      expect(await api('PUT', `/attendance/control-room/${bControl.id}`, A.token, { canManageAttendance: true }), 404, 'MANUAL_ATTENDANCE_NOT_FOUND', "another company's staff");
      assert.equal((await rows(s.id)).length, 1);
    });

    await test('MA-11-ROLE-REFUSALS', async () => {
      const g = await guard();
      const s = await mkShift(g, 'ready', -1);
      assert.equal((await bookOn(g.token, s.id, s.start + MIN)).status, 403, 'the Guard');
      assert.equal((await bookOn(platform, s.id, s.start + MIN)).status, 403, 'the S4 platform administrator');
      for (const s2 of [hr, finance, viewer, control]) expect(await bookOn(s2.token, s.id, s.start + MIN), 403, 'MANUAL_ATTENDANCE_FORBIDDEN', s2.role);
      assert.equal((await rows(s.id)).length, 0);
      expect(await bookOn(controlGranted.token, s.id, s.start + MIN), 201, undefined, 'a granted Control Room member');
    });

    await test('MA-12-CONTROL-ROOM-GRANT', async () => {
      const membership = (await one(`SELECT id FROM company_memberships WHERE "userId" = $1`, [control.id])).id as number;
      expect(await api('PUT', `/attendance/control-room/${control.id}`, ops.token, { canManageAttendance: true }), 403, 'MANUAL_ATTENDANCE_FORBIDDEN', 'Operations cannot grant');
      expect(await api('PUT', `/attendance/control-room/${ops.id}`, A.token, { canManageAttendance: true }), 422, 'MANUAL_ATTENDANCE_FORBIDDEN', 'Control Room only');
      const perms = async () => auth.computeCompanyPermissions(control.id, 'company_admin' as never);
      assert.ok(!(await perms()).includes('attendance.manage'));
      const r = await api('PUT', `/attendance/control-room/${control.id}`, admin.token, { canManageAttendance: true });
      expect(r, 200);
      assert.deepEqual(r.body, { userId: control.id, canManageAttendance: true });
      assert.ok((await perms()).includes('attendance.manage'), 'the session shows the grant');
      assert.ok(!(await perms()).includes('shifts.manage'), 'and nothing else');
      const [audit] = await audits('company_membership.attendance_authorisation', membership);
      assert.deepEqual([audit.userId, audit.beforeData.canManageAttendance, audit.afterData.canManageAttendance], [admin.id, false, true]);
      const list = await api('GET', '/shift-amendments/staff', A.token);
      assert.equal(list.body.staff.find((x: any) => x.userId === control.id).canManageAttendance, true);
      assert.equal((await api('GET', '/shift-amendments/staff', ops.token)).body.staff.find((x: any) => x.userId === control.id).canManageAttendance, undefined, 'only Owner/Admin see grants');
      const s = await mkShift(await guard(), 'ready', -1);
      expect(await bookOn(control.token, s.id, s.start + MIN), 201, undefined, 'granted');
      expect(await api('PUT', `/attendance/control-room/${control.id}`, A.token, { canManageAttendance: false }), 200);
      const s2 = await mkShift(await guard(), 'ready', -1);
      expect(await bookOn(control.token, s2.id, s2.start + MIN), 403, 'MANUAL_ATTENDANCE_FORBIDDEN', 'revoked');
      assert.equal((await audits('company_membership.attendance_authorisation', membership)).length, 2);
    });

    await test('MA-13-THE-START-OF-WORK-GATE-APPLIES', async () => {
      const g = await guard(A, { compliant: false });
      const s = await mkShift(g, 'ready', -1);
      const r = await bookOn(A.token, s.id, s.start + MIN);
      expect(r, 403, 'ATTENDANCE_GUARD_INELIGIBLE');
      assert.match(r.body.message, /The Guard cannot be booked on: /);
      assert.equal((await rows(s.id)).length, 0);
      assert.equal(await status(s.id), 'ready');
      assert.equal((await audits('attendance.manual_book_on_refused', s.id)).length, 1);
    });

    await test('MA-14-RACE-GUARD-APP-VS-MANUAL-ONE-WINS', async () => {
      for (let i = 0; i < 4; i += 1) {
        const g = await guard();
        const s = await mkShift(g, 'ready', -0.5);
        const [app, manual] = await Promise.all([
          api('POST', '/attendance/check-in', g.token, { shiftId: s.id }),
          bookOn(A.token, s.id, Date.now() - MIN),
        ]);
        const wins = [app, manual].filter((r) => r.status === 201 || r.status === 200);
        assert.equal(wins.length, 1, `exactly one wins: app ${app.status} ${JSON.stringify(app.body)}, manual ${manual.status} ${JSON.stringify(manual.body)}`);
        const loser = app === wins[0] ? manual : app;
        assert.equal(loser.status, 409, `the other is a 409: ${JSON.stringify(loser.body)}`);
        assert.ok(['ATTENDANCE_ALREADY_BOOKED_ON', 'ATTENDANCE_CONFLICT'].includes(loser.body.code), loser.body.code);
        assert.equal((await rows(s.id)).length, 1, 'exactly one Book On row');
        assert.equal(await status(s.id), 'in_progress');
      }
    });

    // ═══════════════════ manual Book Off ═══════════════════

    await test('MA-15-MANUAL-BOOK-OFF-OF-AN-IN-PROGRESS-SHIFT', async () => {
      const g = await guard();
      const s = await mkShift(g, 'in_progress', -9, 8); // ended 1 h ago
      await appEvent(s.id, g, 'check-in', s.start + 3 * MIN);
      const ts1 = await timesheet(s.id, g, 'draft');
      const [mbo] = await q(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message) VALUES ($1,$2,$3,'missing_book_off','medium','open','Shift ended - no Book Off recorded.') RETURNING id`, [A.id, g.id, s.id]);
      const [amend] = await q(`INSERT INTO shift_amendments ("shiftId","companyId","guardId",sequence,status,"originalEnd","previousEnd","proposedEnd",reason,"proposedByUserId","proposedAt","expiresAt","fatigueAssessment")
          VALUES ($1,$2,$3,1,'pending',$4,$4,$5,'cover',$6,now(),$5,'{}') RETURNING id`, [s.id, A.id, g.id, ts(s.end), ts(s.end + HOUR), A.ownerId]);
      const off = s.end - 4 * MIN;
      const r = await bookOff(ops.token, s.id, off);
      expect(r, 201);
      assert.equal(r.body.event.type, 'check-out');
      assert.equal(await status(s.id), 'completed');
      const t = await one(`SELECT "actualCheckInAt", "actualCheckOutAt", "verifiedMinutes", "verifiedSource", "approvalStatus" FROM timesheets WHERE id = $1`, [ts1]);
      assert.equal(new Date(t.actualCheckOutAt).getTime(), off);
      assert.equal(t.verifiedMinutes, Math.round((off - (s.start + 3 * MIN)) / MIN));
      assert.equal(t.verifiedSource, 'manual');
      assert.equal(t.approvalStatus, 'draft', 'the ordinary workflow continues: the Guard submits, the company approves');
      assert.equal((await one(`SELECT status FROM safety_alerts WHERE id = $1`, [mbo.id])).status, 'closed', 'Missing Book Off closed at once');
      assert.equal((await audits('shift.missing_book_off_resolved', mbo.id))[0].afterData.closedBy, 'manual_book_off');
      assert.equal((await one(`SELECT status, "voidedReason" FROM shift_amendments WHERE id = $1`, [amend.id])).status, 'voided');
      assert.equal((await audits('attendance.manual_book_off', s.id)).length, 1);
    });

    await test('MA-16-MANUAL-BOOK-OFF-AFTER-CLOSE-WITHOUT-BOOK-OFF', async () => {
      const g = await guard();
      const s = await mkShift(g, 'in_progress', -10, 8);
      await appEvent(s.id, g, 'check-in', s.start);
      await timesheet(s.id, g, 'draft');
      expect(await api('POST', `/shifts/${s.id}/reconcile-without-book-off`, A.token, { reason: 'guard_forgot_book_off' }), 201, undefined, 'reconcile');
      assert.equal(await status(s.id), 'completed');
      const r = await bookOff(admin.token, s.id, s.end - 2 * MIN, { verificationMethod: 'client_confirmation' });
      expect(r, 201, undefined, 'a reconciled shift can still get its real Book Off');
      assert.equal(await status(s.id), 'completed', 'stays completed');
      assert.equal((await audits('attendance.manual_book_off', s.id))[0].afterData.afterReconciliation, true);
      // The same, but the company already approved the timesheet: locked.
      const g2 = await guard();
      const s2 = await mkShift(g2, 'in_progress', -12, 8);
      await appEvent(s2.id, g2, 'check-in', s2.start);
      await timesheet(s2.id, g2, 'approved');
      expect(await api('POST', `/shifts/${s2.id}/reconcile-without-book-off`, A.token, { reason: 'guard_forgot_book_off' }), 201);
      expect(await bookOff(admin.token, s2.id, s2.end - 2 * MIN), 409, 'ATTENDANCE_TIMESHEET_LOCKED');
      assert.equal((await rows(s2.id)).length, 1, 'nothing written');
    });

    await test('MA-17-BOOK-OFF-REFUSALS', async () => {
      const g = await guard();
      const ready = await mkShift(g, 'ready', -1);
      expect(await bookOff(A.token, ready.id, Date.now() - MIN), 409, 'MANUAL_BOOK_OFF_STATUS');
      const g2 = await guard();
      const s = await mkShift(g2, 'in_progress', -2);
      await appEvent(s.id, g2, 'check-in', s.start + 30 * MIN);
      expect(await bookOff(A.token, s.id, s.start + 10 * MIN), 422, 'ATTENDANCE_BOOK_OFF_BEFORE_BOOK_ON');
      expect(await bookOff(A.token, s.id, s.start + 30 * MIN), 422, 'ATTENDANCE_BOOK_OFF_BEFORE_BOOK_ON', 'equal is not after');
      expect(await bookOff(A.token, s.id, Date.now() + 2 * MIN), 422, 'ATTENDANCE_TIME_IN_FUTURE');
      const g3 = await guard();
      const odd = await mkShift(g3, 'in_progress', -2);
      expect(await bookOff(A.token, odd.id, Date.now() - MIN), 409, 'ATTENDANCE_NOT_BOOKED_ON');
      assert.equal((await rows(s.id)).length, 1);
    });

    // ═══════════════════ corrections ═══════════════════

    await test('MA-18-CORRECTIONS-APPEND-ONLY-CHAIN-AND-TIMESHEET-RESTAMP', async () => {
      const g = await guard();
      const s = await mkShift(g, 'completed', -10, 8);
      const on = await appEvent(s.id, g, 'check-in', s.start);
      const off = await appEvent(s.id, g, 'check-out', s.end);
      const sheet = await timesheet(s.id, g, 'draft', { on: s.start, off: s.end });
      const originalOn = await rowHash(on);
      const c1 = await correct(ops.token, on, s.start + 20 * MIN);
      expect(c1, 201);
      assert.equal(c1.body.correctedEventId, on);
      assert.deepEqual(c1.body.timesheet, { restamped: true, approvalStatus: 'draft' });
      assert.equal(c1.body.event.correctionOfEventId, on);
      assert.equal(c1.body.event.isCorrection, true);
      assert.equal(await rowHash(on), originalOn, 'the original row is byte-identical');
      const again = await correct(ops.token, on, s.start + 25 * MIN);
      expect(again, 409, 'ATTENDANCE_CORRECTION_NOT_TIP', 'the original can never be corrected twice');
      assert.equal(again.body.details.latestEventId, c1.body.event.id);
      expect(await correct(ops.token, c1.body.event.id, s.start + 20 * MIN), 422, 'ATTENDANCE_CORRECTION_UNCHANGED');
      expect(await correct(ops.token, c1.body.event.id, s.end + MIN), 422, 'ATTENDANCE_BOOK_OFF_BEFORE_BOOK_ON', 'a Book On after the Book Off');
      const c2 = await correct(admin.token, c1.body.event.id, s.start + 15 * MIN, { verificationMethod: 'radio' });
      expect(c2, 201, undefined, 'the tip can be corrected again');
      const c3 = await correct(A.token, c2.body.event.id, s.start + 12 * MIN, { verificationMethod: 'other', verificationNote: 'Site sign-in sheet' });
      expect(c3, 201, undefined, 'and again: a chain of any length');
      const h = (await api('GET', `/attendance/shifts/${s.id}/history`, A.token)).body;
      assert.equal(h.events.length, 5);
      assert.deepEqual(h.events.filter((e: any) => e.effective).map((e: any) => e.id).sort(), [off, c3.body.event.id].sort(), 'exactly one effective value per type');
      assert.equal(h.effective.bookOn.occurredAt, iso(s.start + 12 * MIN));
      assert.equal(h.events.find((e: any) => e.id === on).correctedByEventId, c1.body.event.id);
      let t = await one(`SELECT "actualCheckInAt", "verifiedMinutes", "verifiedSource", "hoursWorked", "workedMinutes" FROM timesheets WHERE id = $1`, [sheet]);
      assert.equal(new Date(t.actualCheckInAt).getTime(), s.start + 12 * MIN);
      assert.equal(t.verifiedMinutes, 8 * 60 - 12);
      assert.equal(t.verifiedSource, 'corrected');
      assert.equal(t.workedMinutes, 8 * 60 - 12, 'claimed hours untouched by the Guard follow the correction');
      // Submitted and returned are still in the ordinary workflow; a Guard-edited claim is kept.
      await q(`UPDATE timesheets SET "approvalStatus" = 'submitted', "workedMinutes" = 400, "hoursWorked" = 6.67 WHERE id = $1`, [sheet]);
      const offFix = await correct(ops.token, off, s.end - 30 * MIN);
      expect(offFix, 201);
      assert.deepEqual(offFix.body.timesheet, { restamped: true, approvalStatus: 'submitted' });
      t = await one(`SELECT "verifiedMinutes", "workedMinutes" FROM timesheets WHERE id = $1`, [sheet]);
      assert.equal(t.verifiedMinutes, 8 * 60 - 12 - 30);
      assert.equal(t.workedMinutes, 400, "the Guard's own claim is never overwritten");
      await q(`UPDATE timesheets SET "approvalStatus" = 'returned' WHERE id = $1`, [sheet]);
      expect(await correct(ops.token, offFix.body.event.id, s.end - 20 * MIN), 201, undefined, 'returned');
      // Approved: locked, nothing written.
      await q(`UPDATE timesheets SET "approvalStatus" = 'approved' WHERE id = $1`, [sheet]);
      const before = (await rows(s.id)).length;
      const tip = (await api('GET', `/attendance/shifts/${s.id}/history`, A.token)).body.effective.bookOff.id;
      expect(await correct(A.token, tip, s.end - 10 * MIN), 409, 'ATTENDANCE_TIMESHEET_LOCKED', 'approved');
      // In a payroll batch: locked too.
      const [batch] = await q(`INSERT INTO payroll_batches ("periodStart","periodEnd","companyId") VALUES (now() - interval '7 days', now(), $1) RETURNING id`, [A.id]);
      await q(`UPDATE timesheets SET "approvalStatus" = 'submitted', "payrollBatchId" = $2 WHERE id = $1`, [sheet, batch.id]);
      expect(await correct(A.token, tip, s.end - 10 * MIN), 409, 'ATTENDANCE_TIMESHEET_LOCKED', 'in a payroll batch');
      assert.equal((await rows(s.id)).length, before, 'nothing written by the refusals');
      assert.equal((await audits('attendance.corrected', c1.body.event.id)).length, 1);
    });

    await test('MA-19-OLD-CORRECTIONS-NEED-OWNER-OR-ADMIN', async () => {
      const g = await guard();
      const s = await mkShift(g, 'completed', -40, 8);
      const on = await appEvent(s.id, g, 'check-in', s.start);
      await appEvent(s.id, g, 'check-out', s.end);
      expect(await correct(ops.token, on, s.start + 5 * MIN), 403, 'ATTENDANCE_OLD_ENTRY_REQUIRES_OWNER_OR_ADMIN');
      expect(await correct(admin.token, on, s.start + 5 * MIN), 201);
    });

    // ═══════════════════ readers ═══════════════════

    await test('MA-20-EVERY-SWITCHED-READER-FOLLOWS-THE-EFFECTIVE-CHAIN', async () => {
      const g = await guard();
      const s = await mkShift(g, 'completed', -10, 8);
      const on = await appEvent(s.id, g, 'check-in', s.start);
      const off = await appEvent(s.id, g, 'check-out', s.end);
      const onFix = await correct(A.token, on, s.start + 90 * MIN);
      const offFix = await correct(A.token, off, s.end - 90 * MIN);
      expect(onFix, 201); expect(offFix, 201);
      const shiftEntity = await ds.getRepository(Shift).findOne({ where: { id: s.id }, relations: { site: true, company: true, guard: true } });
      const events = await ds.getRepository(AttendanceEvent).find({ where: { shift: { id: s.id } }, relations: { shift: true }, loadEagerRelations: false });

      // Live Operations projection.
      const view = (await app.get(OperationsProjectionService).projectForShifts([shiftEntity!], new Date())).get(s.id)!;
      assert.equal(view.bookOnAt, iso(s.start + 90 * MIN));
      assert.equal(view.bookOffAt, iso(s.end - 90 * MIN));
      assert.deepEqual(view.attendance, {
        bookOnSource: 'manual', bookOffSource: 'manual', bookOnCorrected: true, bookOffCorrected: true, monitoredFrom: iso(s.start + 90 * MIN),
      });
      assert.equal(view.welfare.windows[0].applicable, false, 'the first window is before the effective Book On');
      const live = await api('GET', `/coverage/operations?shiftIds=${s.id}`, A.token);
      expect(live, 200);
      assert.ok(JSON.stringify(live.body).includes('"bookOnCorrected":true'), 'Live Ops carries the sources');

      // Shift attendance export.
      const day = new Date(s.start).toISOString().slice(0, 10);
      const sheet = await app.get(OperationsExportService).shiftAttendance(A.ownerId, 'company_admin' as never, { from: day, to: day } as never);
      const col = (name: string) => sheet.columns.indexOf(name);
      const row = sheet.rows.find((r) => r[col('Shift ID')] === String(s.id))!;
      assert.equal(row[col('Book On (UTC)')], `${iso(s.start + 90 * MIN).slice(0, 19)}Z`);
      assert.equal(row[col('Book Off (UTC)')], `${iso(s.end - 90 * MIN).slice(0, 19)}Z`);
      assert.equal(row[col('Book On recorded by')], 'Manual (corrected)');
      assert.equal(row[col('Book Off recorded by')], 'Manual (corrected)');
      assert.match(row[col('Early Book Off')], /^Yes — 90 min before scheduled end/, 'early Book Off from the effective time');

      // Incident analytics: lateness and windows.
      const analytics = app.get(IncidentAnalyticsService) as any;
      const [welfareRow] = analytics.buildWelfareRows({ company: null, incidents: [], alerts: [], shifts: [shiftEntity], attendance: events, logs: [] }, new Date());
      assert.equal(welfareRow.lateCheckIn, true, 'late by the effective Book On (raw earliest would be on time)');

      // Welfare push resolution.
      const resolution = (app.get(WelfarePushService) as any).resolve(shiftEntity, { logs: [], attendance: events }, new Date());
      assert.equal(resolution.windows[0].applicable, false);

      // /attendance/company and /attendance/mine.
      const company = (await api('GET', '/attendance/company', A.token)).body.filter((e: any) => e.shift?.id === s.id || e.shiftId === s.id);
      assert.equal(company.length, 4);
      assert.deepEqual(company.filter((e: any) => e.effective).map((e: any) => e.id).sort(), [onFix.body.event.id, offFix.body.event.id].sort());
      assert.equal(company.find((e: any) => e.id === on).source, 'guard_app');
      const mine = (await api('GET', '/attendance/mine', g.token)).body;
      assert.equal(mine.length, 4);
      assert.ok(mine.every((e: any) => !('recordedByUserId' in e)), 'the Guard is not told which staff member recorded it');
      assert.equal(mine.find((e: any) => e.id === onFix.body.event.id).source, 'manual');

      // Reconciliation and amendments read the effective chain.
      const g2 = await guard();
      const live2 = await mkShift(g2, 'in_progress', -10, 8);
      const on2 = await appEvent(live2.id, g2, 'check-in', live2.start);
      expect(await correct(A.token, on2, live2.start + 10 * MIN), 201);
      const recon = await api('POST', `/shifts/${live2.id}/reconcile-without-book-off`, A.token, { reason: 'guard_forgot_book_off' });
      expect(recon, 201);
      assert.equal((await audits('shift.reconciled_without_book_off', live2.id))[0].beforeData.bookOnAt, iso(live2.start + 10 * MIN), 'the effective Book On');
      const g3 = await guard();
      const live3 = await mkShift(g3, 'ready', -1, 8);
      expect(await bookOn(A.token, live3.id, live3.start + 5 * MIN), 201);
      const assess = await api('POST', `/shifts/${live3.id}/amendments/assessment`, A.token, { proposedEnd: iso(live3.end + HOUR) });
      assert.equal(assess.status, 200, `a manually booked-on shift can be extended: ${JSON.stringify(assess.body)}`);
    });

    // ═══════════════════ welfare ═══════════════════

    await test('MA-21-NO-RETROSPECTIVE-MISSED-WELFARE-CHECKS', async () => {
      const g = await guard();
      const late = await mkShift(g, 'missed', -5, 8);
      expect(await bookOn(A.token, late.id, late.start + 10 * MIN), 201);
      // Control: the same Book On time, known at the time (as the Guard app would have recorded it).
      const g2 = await guard();
      const control2 = await mkShift(g2, 'in_progress', -5, 8);
      await appEvent(control2.id, g2, 'check-in', control2.start + 10 * MIN);
      await sweep.runMissedWelfareChecks();
      const misses = async (id: number) => Number((await one(`SELECT count(*)::int n FROM safety_alerts WHERE "shiftId" = $1 AND type = 'missed_checkcall' AND "welfareWindowIndex" IS NOT NULL`, [id])).n);
      assert.equal(await misses(late.id), 0, 'nothing before S4 knew the Guard was on duty is a miss');
      assert.ok((await misses(control2.id)) >= 3, 'the control shift does record its misses');
      assert.equal(Number((await one(`SELECT count(*)::int n FROM safety_alerts WHERE "shiftId" = $1 AND "welfareWindowIndex" IS NULL AND status = 'open'`, [late.id])).n), 0, 'no summary alert');
      const view = (await app.get(OperationsProjectionService).projectForShifts([(await ds.getRepository(Shift).findOne({ where: { id: late.id }, relations: { site: true } }))!], new Date())).get(late.id)!;
      assert.equal(view.welfare.missedCount, 0);
      assert.equal(view.bookOnAt, iso(late.start + 10 * MIN), 'the actual time is still the Book On shown');
      assert.ok(view.welfare.windows.slice(0, 4).every((w: any) => !w.applicable), 'windows before monitoring are not applicable');
    });

    await test('MA-22-MISSING-BOOK-OFF-CLOSES-ON-A-MANUAL-BOOK-OFF', async () => {
      const g = await guard();
      const s = await mkShift(g, 'in_progress', -10, 8); // ended 2 h ago
      await appEvent(s.id, g, 'check-in', s.start);
      await sweep.runMissedWelfareChecks();
      const [mbo] = await q(`SELECT id, status FROM safety_alerts WHERE "shiftId" = $1 AND type = 'missing_book_off'`, [s.id]);
      assert.equal(mbo?.status, 'open', 'the sweep raised Missing Book Off');
      expect(await bookOff(ops.token, s.id, s.end - 5 * MIN), 201);
      assert.equal((await one(`SELECT status FROM safety_alerts WHERE id = $1`, [mbo.id])).status, 'closed');
      for (let i = 0; i < 2; i += 1) await sweep.runMissedWelfareChecks();
      const after = await q(`SELECT id, status FROM safety_alerts WHERE "shiftId" = $1 AND type = 'missing_book_off'`, [s.id]);
      assert.deepEqual(after.map((a: any) => [a.id, a.status]), [[mbo.id, 'closed']], 'never reopened or raised again');
    });

    await test('MA-23-NO-DEADLOCK-WITH-THE-WELFARE-SWEEP', async () => {
      const { WELFARE_SWEEP_LOCK_NAMESPACE } = await import('../src/operations/advisory-locks');
      for (const kind of ['book-off', 'correction'] as const) {
        const g = await guard();
        const s = await mkShift(g, 'in_progress', -9, 8);
        const on = await appEvent(s.id, g, 'check-in', s.start);
        const runner = ds.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
          await runner.query('SELECT pg_advisory_xact_lock($1, $2)', [WELFARE_SWEEP_LOCK_NAMESPACE, s.id]);
          const pending = kind === 'book-off' ? bookOff(A.token, s.id, s.end - MIN) : correct(A.token, on, s.start + MIN);
          await sleep(600); // the manual write now holds its row lock and waits for the sweep's lock
          await runner.query(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message) VALUES ($1,$2,$3,'other','high','open','sweep insert during manual write')`, [A.id, g.id, s.id]);
          await runner.commitTransaction();
          const r = await Promise.race([pending, sleep(30_000).then(() => ({ status: 0, body: 'timeout (deadlock?)' }))]);
          expect(r as Res, 201, undefined, `${kind} completes after the sweep commits`);
        } finally {
          if (runner.isTransactionActive) await runner.rollbackTransaction();
          await runner.release();
        }
        assert.equal(Number((await one(`SELECT count(*)::int n FROM safety_alerts WHERE "shiftId" = $1 AND type = 'other'`, [s.id])).n), 1, "the sweep's insert is recorded");
      }
    });

    // ═══════════════════ Mark Missed, timesheets, the Guard app ═══════════════════

    await test('MA-24-MARK-MISSED-OPTIONAL-REASON-AUDITED', async () => {
      const s1 = await mkShift(await guard(), 'ready', -1);
      expect(await api('PATCH', `/shifts/${s1.id}`, A.token, { status: 'missed', reason: 'No answer on phone or radio' }), 200);
      const [a1] = await audits('shift.marked_missed', s1.id);
      assert.equal(a1.afterData.reason, 'No answer on phone or radio');
      assert.equal(a1.beforeData.status, 'ready');
      assert.equal(a1.userId, A.ownerId);
      const s2 = await mkShift(await guard(), 'ready', -1);
      expect(await api('PATCH', `/shifts/${s2.id}`, A.token, { status: 'missed' }), 200, undefined, 'no reason (Part A web) still works');
      assert.equal((await audits('shift.marked_missed', s2.id))[0].afterData.reason, null);
      const s3 = await mkShift(await guard(), 'ready', -1);
      assert.equal((await api('PATCH', `/shifts/${s3.id}`, A.token, { status: 'missed', reason: 'x'.repeat(501) })).status, 400);
      assert.equal(await status(s3.id), 'ready');
      // A shift with a manual Book On can never be marked missed (it is in progress).
      const s4 = await mkShift(await guard(), 'ready', -1);
      expect(await bookOn(A.token, s4.id, s4.start + MIN), 201);
      assert.notEqual((await api('PATCH', `/shifts/${s4.id}`, A.token, { status: 'missed', reason: 'x' })).status, 200);
    });

    await test('MA-25-TIMESHEETS-VERIFIED-SOURCE-AND-UNCHANGED-APPROVAL', async () => {
      const g = await guard();
      const s = await mkShift(g, 'in_progress', -9, 8);
      await appEvent(s.id, g, 'check-in', s.start);
      const sheet = await timesheet(s.id, g, 'draft');
      expect(await bookOff(ops.token, s.id, s.end - MIN), 201);
      const listed = (await api('GET', '/timesheets/company', A.token)).body.find((t: any) => t.id === sheet);
      assert.equal(listed.verifiedSource, 'manual');
      await q(`UPDATE timesheets SET "approvalStatus" = 'submitted', "submittedAt" = now() WHERE id = $1`, [sheet]);
      // The recorder (Operations) approves with no extra note: the owner removed both proposed rules.
      const approve = await api('PATCH', `/timesheets/${sheet}`, ops.token, { approvalStatus: 'approved' });
      expect(approve, 200, undefined, 'the unchanged approval workflow');
      assert.equal(approve.body.approvalStatus, 'approved');
      const src = readFileSync(join(__dirname, '..', 'src', 'timesheet', 'timesheet.service.ts'), 'utf8');
      const review = src.split('private validateCompanyReviewRequest(')[1]?.split('private async getGuardOwnedEditableTimesheet(')[0] ?? '';
      assert.doesNotMatch(review, /verifiedSource|recordedByUserId|attendanceReviewNote/, 'no new approval rule');
    });

    await test('MA-26-THE-GUARD-APP-AFTER-A-MANUAL-ENTRY', async () => {
      const g = await guard();
      const s = await mkShift(g, 'ready', -1);
      expect(await bookOn(A.token, s.id, s.start + MIN), 201);
      expect(await api('POST', '/attendance/check-in', g.token, { shiftId: s.id }), 409, 'ATTENDANCE_ALREADY_BOOKED_ON', 'app Book On after a manual one');
      const sheet = await timesheet(s.id, g, 'draft');
      const appOff = await api('POST', '/attendance/check-out', g.token, { shiftId: s.id });
      assert.ok(appOff.status === 201 || appOff.status === 200, JSON.stringify(appOff.body));
      assert.equal((await one(`SELECT "verifiedSource" FROM timesheets WHERE id = $1`, [sheet])).verifiedSource, 'manual');
      const g2 = await guard();
      const s2 = await mkShift(g2, 'in_progress', -2);
      await appEvent(s2.id, g2, 'check-in', s2.start);
      expect(await bookOff(A.token, s2.id, Date.now() - MIN), 201);
      expect(await api('POST', '/attendance/check-out', g2.token, { shiftId: s2.id }), 409, 'ATTENDANCE_ALREADY_BOOKED_OFF', 'app Book Off after a manual one');
    });

    await test('MA-28-THE-24-HOUR-RULE-IS-THE-AGE-OF-THE-ATTENDANCE-TIME-NOT-THE-SHIFT-START', async () => {
      // An old shift start (30 h ago, a 20-hour shift) with a RECENT actual time (20 h ago): Operations and a granted
      // Control Room member may record it.
      await api('PUT', `/attendance/control-room/${controlGranted.id}`, A.token, { canManageAttendance: true });
      const oldStart = await mkShift(await guard(), 'ready', -30, 20);
      expect(await bookOn(ops.token, oldStart.id, Date.now() - 20 * HOUR), 201, undefined, 'old shift start, recent time: Operations allowed');
      const oldStart2 = await mkShift(await guard(), 'ready', -30, 20);
      expect(await bookOn(controlGranted.token, oldStart2.id, Date.now() - 20 * HOUR), 201, undefined, 'old shift start, recent time: Control Room allowed');
      // A recent shift (started 20 h ago, inside its start − 12 h window) with an actual time 26 h ago: refused for them,
      // allowed for Owner / Admin.
      const recent = await mkShift(await guard(), 'ready', -20, 8);
      const old = Date.now() - 26 * HOUR;
      expect(await bookOn(ops.token, recent.id, old), 403, 'ATTENDANCE_OLD_ENTRY_REQUIRES_OWNER_OR_ADMIN', 'recent shift, old time: Operations');
      expect(await bookOn(controlGranted.token, recent.id, old), 403, 'ATTENDANCE_OLD_ENTRY_REQUIRES_OWNER_OR_ADMIN', 'recent shift, old time: Control Room');
      expect(await bookOn(A.token, recent.id, old), 201, undefined, 'recent shift, old time: Owner');
      // Book Off: the same rule on the Book Off time.
      const g = await guard();
      const live = await mkShift(g, 'in_progress', -30, 4);
      await appEvent(live.id, g, 'check-in', live.start);
      expect(await bookOff(ops.token, live.id, live.end), 403, 'ATTENDANCE_OLD_ENTRY_REQUIRES_OWNER_OR_ADMIN', 'Book Off time 26 h ago');
      expect(await bookOff(admin.token, live.id, live.end), 201);
      // Corrections: BOTH the new time's age and the replaced (original) time's age count, so a sub-24-hour role can
      // neither move a recent time into the old past nor rewrite an old time with a recent one.
      const g2 = await guard();
      const c = await mkShift(g2, 'completed', -30, 20);
      const oldOn = await appEvent(c.id, g2, 'check-in', c.start + 10 * MIN); // ~30 h ago
      const recentOff = await appEvent(c.id, g2, 'check-out', c.end - 10 * MIN); // ~10 h ago
      expect(await correct(ops.token, oldOn, Date.now() - 20 * HOUR), 403, 'ATTENDANCE_OLD_ENTRY_REQUIRES_OWNER_OR_ADMIN', 'original > 24 h, new recent');
      expect(await correct(ops.token, recentOff, Date.now() - 25 * HOUR), 403, 'ATTENDANCE_OLD_ENTRY_REQUIRES_OWNER_OR_ADMIN', 'original recent, new > 24 h');
      expect(await correct(ops.token, recentOff, c.end - 30 * MIN), 201, undefined, 'both recent: Operations allowed');
      expect(await correct(A.token, oldOn, Date.now() - 20 * HOUR), 201, undefined, 'the Owner may correct an old time');
    });

    await test('MA-29-EXISTING-MISSED-CHECK-RECORDS-ARE-NEVER-DELETED-OR-REWRITTEN', async () => {
      const g = await guard();
      const s = await mkShift(g, 'in_progress', -6, 8);
      const on = await appEvent(s.id, g, 'check-in', s.start + 2 * MIN);
      await sweep.runMissedWelfareChecks();
      const snapshot = async () => q(`SELECT id, md5(to_jsonb(a)::text) h FROM safety_alerts a WHERE "shiftId" = $1 AND type = 'missed_checkcall' ORDER BY id`, [s.id]);
      const before = await snapshot();
      assert.ok(before.length >= 4, `genuine misses were recorded (${before.length})`);
      // Correct the Book On later (the misses before it are now outside attendance) and earlier, then book off manually.
      const later = await correct(A.token, on, s.start + 3 * HOUR);
      expect(later, 201);
      await sweep.runMissedWelfareChecks();
      expect(await correct(A.token, later.body.event.id, s.start + MIN), 201);
      await sweep.runMissedWelfareChecks();
      expect(await bookOff(A.token, s.id, Date.now() - MIN), 201);
      await sweep.runMissedWelfareChecks();
      const after = await snapshot();
      assert.deepEqual(after.filter((r: any) => before.some((b: any) => b.id === r.id)), before, 'every existing missed-check record is byte-identical');
      assert.equal(after.length, before.length, 'none deleted, none invented');
    });

    await test('MA-30-ACTUAL-TIME-AND-RECORDED-TIME-ARE-STORED-SEPARATELY-FOR-BOOK-ON-AND-BOOK-OFF', async () => {
      const g = await guard();
      const s = await mkShift(g, 'ready', -6, 8);
      const actualOn = s.start + 4 * MIN;
      const actualOff = Date.now() - 37 * MIN;
      const t0 = Date.now();
      expect(await bookOn(ops.token, s.id, actualOn), 201);
      expect(await bookOff(ops.token, s.id, actualOff), 201);
      const t1 = Date.now();
      const stored = await q(`SELECT type::text, "occurredAt", "recordedAt", "recordedByUserId", source FROM attendance_events WHERE "shiftId" = $1 ORDER BY id`, [s.id]);
      assert.equal(new Date(stored[0].occurredAt).getTime(), actualOn, 'Book On: the stated actual time');
      assert.equal(new Date(stored[1].occurredAt).getTime(), actualOff, 'Book Off: the stated actual time');
      for (const row of stored) {
        const rec = new Date(row.recordedAt).getTime();
        assert.ok(rec >= t0 - 1000 && rec <= t1 + 1000, `${row.type}: recordedAt is the server time of recording`);
        assert.ok(rec - new Date(row.occurredAt).getTime() > 30 * MIN, `${row.type}: recorded well after it occurred, and both are kept`);
        assert.deepEqual([row.recordedByUserId, row.source], [ops.id, 'manual']);
      }
    });

    await test('MA-27-STATIC-APPEND-ONLY-LOCK-ORDER-AND-THE-GATE', async () => {
      const { readdirSync, statSync } = await import('node:fs');
      const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? (f === 'migrations' ? [] : walk(p)) : p.endsWith('.ts') ? [p] : [];
      });
      for (const file of walk(join(__dirname, '..', 'src'))) {
        const text = readFileSync(file, 'utf8');
        assert.doesNotMatch(text, /UPDATE\s+"?attendance_events"?|DELETE\s+FROM\s+"?attendance_events"?/i, `${file} rewrites attendance`);
        if (/AttendanceEvent\)/.test(text)) assert.doesNotMatch(text, /getRepository\(AttendanceEvent\)\.(update|delete|remove)\(|attendanceRepo\.(update|delete|remove)\(/, `${file} rewrites attendance`);
      }
      const svc = readFileSync(join(__dirname, '..', 'src', 'attendance', 'manual-attendance.service.ts'), 'utf8');
      assert.doesNotMatch(svc, /FROM "shifts"[^`]*FOR UPDATE/, 'never locks a shift FOR UPDATE (it would deadlock with the sweep)');
      const lock = svc.split('private async lockShift(')[1].split('private async events(')[0];
      assert.ok(lock.indexOf('lockGuardsForAssignment') < lock.indexOf('FOR NO KEY UPDATE') && lock.indexOf('FOR NO KEY UPDATE') < lock.indexOf('WELFARE_SWEEP_LOCK_NAMESPACE'),
        'Guard lock → shift row FOR NO KEY UPDATE → welfare-sweep lock');
      assert.match(svc.split('async bookOn(')[1].split('async bookOff(')[0], /this\.shiftService\.assertGuardMayStartWork\(/, 'the start-of-work gate');
      assert.doesNotMatch(svc, /SET "guardId"|shift\.guard = /, 'manual attendance never assigns a Guard');
      assert.match(svc, /shiftLocked: true/, 'the timesheet write never re-locks the shift FOR UPDATE');
    });
  } finally {
    await app.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  console.log(JSON.stringify({ event: 'manual_attendance_certified', tests: passed }));
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
