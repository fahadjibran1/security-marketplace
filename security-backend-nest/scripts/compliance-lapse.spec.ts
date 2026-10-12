/**
 * Compliance phase 1C: mid-shift compliance lapse alerts (Migration 63). Real PostgreSQL, the real Nest
 * application and real HTTP for every product action; the sweep itself is invoked directly
 * (SafetyAlertService.runComplianceLapseScan) with the application's own five-minute timer stopped.
 *
 *   LAPSE-01..05  detection: SIA expiry, time-limited RTW expiry, continuous RTW, not confirmed, missing
 *   LAPSE-06..07  multiple companies, multiple active shifts
 *   LAPSE-08..09  repeated and concurrent sweeps: exactly one alert per company + shift + category
 *   LAPSE-10      notification recipients and content: compliance people get the reason; Operations and
 *                 Control Room get an eligibility review notice only; nobody else
 *   LAPSE-11      audit: detection, acknowledgement and resolution, with who and when
 *   LAPSE-12      a closed lapse is not re-raised; a new lapse is
 *   LAPSE-13      shift safety: no Book Off, no change to the shift; Book Off stays available; no new start
 *   LAPSE-14      not an SOS; a Guard cannot raise one
 *   LAPSE-15      a stale abandoned shift is not paged about
 *   LAPSE-16      old client compatibility of the alert list
 *   LAPSE-17      static: the sweep only adds records, uses the shared assessment, no external channel
 *   LAPSE-18..23  company members: HR / Compliance (compliance.manage) acknowledge and resolve compliance
 *                 lapse alerts only, in their own company, with reason + note and a full audit trail;
 *                 other roles, other alert types and other companies are refused; the owner is unchanged
 *
 * Needs COMPLIANCE_LAPSE_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { complianceToday } from '../src/compliance/compliance-dates';

const url = process.env.COMPLIANCE_LAPSE_DATABASE_URL;
if (!url) throw new Error('COMPLIANCE_LAPSE_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Compliance lapse database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'compliance-lapse-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

let passed = 0;
const test = async (id: string, fn: () => Promise<void> | void) => {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
};

type Res = { status: number; body: any };
const HOUR = 3_600_000;
const PASSWORD = 'compliance-lapse-spec-only-password-1';
const ukDay = (n: number) => {
  const [y, m, d] = complianceToday().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

async function main() {
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
  const { AuthService } = await import('../src/auth/auth.service');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const base = `http://127.0.0.1:${address.port}`;
  const ds = app.get(DataSource);
  const [{ current_database: actualDatabase }] = await ds.query('SELECT current_database()');
  if (actualDatabase !== new URL(url!).pathname.slice(1)) throw new Error(`Refusing: connected to ${actualDatabase}`);
  const sweep = app.get(SafetyAlertService);
  // The application's own five-minute timer must not race the assertions; every sweep here is explicit.
  sweep.onModuleDestroy();
  const auth = app.get(AuthService);

  const api = async (method: string, path: string, token: string | null, body?: unknown): Promise<Res> => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
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
    const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;

    const company = async (label: string, number: string) => {
      const ownerEmail = `${label}.owner@example.invalid`;
      const ownerId = await user(ownerEmail, 'company_admin');
      const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,$2,$3,'1 Way','ops@example.invalid') RETURNING id`, [ownerId, `${label} Security Ltd`, number]);
      const site = await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'Main Site','2 Way') RETURNING id`, [id]);
      // One staff member per membership role, so recipients are checked against the real permission matrix.
      const staff: Record<string, number> = {};
      for (const role of ['owner', 'admin', 'operations', 'control_room', 'hr_compliance', 'finance', 'viewer']) {
        const staffId = await user(`${label}.staff.${role}@example.invalid`, 'company_staff');
        await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [staffId, id, role]);
        staff[role] = staffId;
      }
      return { id: id as number, ownerId, siteId: site.id as number, staff, token: await login(ownerEmail) };
    };
    const A = await company('lapsea', '61111111');
    const B = await company('lapseb', '62222222');

    let n = 0;
    const guard = async (label: string, companies: Array<typeof A>) => {
      n += 1;
      const email = `${label}@example.invalid`;
      const userId = await user(email, 'guard');
      const licence = `80000000000000${String(n).padStart(2, '0')}`;
      const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","siaExpiryDate","rightToWorkStatus",phone) VALUES ($1,$2,$3,$4,'british','07000000000') RETURNING id`,
        [userId, `${label} Guard`, licence, ukDay(500)]);
      for (const c of companies) {
        await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [c.id, id]);
        for (const type of ['sia_licence', 'right_to_work']) {
          await q(`INSERT INTO guard_documents ("guardId","companyId",type,"storageProvider","storageKey","originalFileName","mimeType","sizeBytes","uploadCompletedAt",verified,"verifiedAt")
            VALUES ($1,$2,$3,'s3-compatible',$4,'e.pdf','application/pdf','1024',now(),true,now())`, [id, c.id, type, `lapse/${c.id}/${id}/${type}`]);
        }
      }
      return { id: id as number, userId, licence, token: await login(email) };
    };
    type G = Awaited<ReturnType<typeof guard>>;

    const recordCheck = async (c: typeof A, g: G, kind: 'sia' | 'right_to_work', over: Record<string, unknown> = {}) => {
      const history = await api('GET', `/compliance/checks?guardId=${g.id}`, c.token);
      const current = (history.body as any[]).find((row) => row.kind === kind && !row.supersededAt);
      const r = await api('POST', '/compliance/checks', c.token, {
        guardId: g.id, kind, outcome: 'confirmed', checkDate: ukDay(0), checkedByName: 'Spec Checker', evidenceReference: 'HR/lapse-spec',
        ...(kind === 'sia'
          ? { method: 'sia_public_register', licenceNumber: g.licence, expiryDate: ukDay(400) }
          : { method: 'manual_document', rightToWorkExcuse: 'continuous' }),
        ...(current ? { replacesCheckId: current.id, changeType: 'new_check' } : {}),
        ...over,
      });
      assert.equal(r.status, 201, `record ${kind}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    };
    const fullChecks = async (c: typeof A, g: G, rtw: Record<string, unknown> = {}) => {
      await recordCheck(c, g, 'sia');
      await recordCheck(c, g, 'right_to_work', rtw);
    };
    /** Makes a recorded check's expiry yesterday: the passage of time, without moving the clock. */
    const expireCurrent = async (c: typeof A, g: G, kind: 'sia' | 'right_to_work') =>
      q(`UPDATE guard_compliance_checks SET "expiryDate" = $1, "checkDate" = $2 WHERE "companyId" = $3 AND "guardId" = $4 AND kind = $5 AND "supersededAt" IS NULL`,
        [ukDay(-1), ukDay(-200), c.id, g.id, kind]);

    const readyShift = async (c: typeof A, g: G, opts: { startOffset?: number } = {}) => {
      const start = new Date(Date.now() + (opts.startOffset ?? -HOUR));
      const { id } = await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end","checkCallIntervalMinutes") VALUES ($1,$2,'Main Site',$3,'ready',$4,$5,60) RETURNING id`,
        [c.id, c.siteId, g.id, start, new Date(start.getTime() + 8 * HOUR)]);
      return id as number;
    };
    /** A Guard booked on through the real Book On route. */
    const onShift = async (c: typeof A, g: G) => {
      const shiftId = await readyShift(c, g);
      const r = await api('POST', '/attendance/check-in', g.token, { shiftId });
      assert.equal(r.status, 201, `book on: ${JSON.stringify(r.body)}`);
      return shiftId;
    };
    const lapses = (shiftId: number) =>
      q(`SELECT id, "companyId", "guardId", "shiftId", type::text AS type, priority::text AS priority, status::text AS status, "complianceCategory" AS category,
           "complianceReason" AS reason, "lapseKey", message FROM safety_alerts WHERE type::text = 'compliance_lapse' AND "shiftId" = $1 ORDER BY id`, [shiftId]);
    const notificationsFor = (companyId: number) =>
      q(`SELECT "userId", title, message FROM notifications WHERE "companyId" = $1 AND type::text = 'compliance_alert' ORDER BY id`, [companyId]);
    const shiftState = (id: number) =>
      one(`SELECT status, "guardId", (SELECT count(*)::int FROM attendance_events a WHERE a."shiftId" = s.id AND a.type = 'check-out') AS checkouts FROM shifts s WHERE id = $1`, [id]);

    // ══ detection ══════════════════════════════════════════════════════════════════════════════════
    await test('LAPSE-01-SIA-EXPIRY-DURING-A-SHIFT-RAISES-ONE-CRITICAL-ALERT', async () => {
      const g = await guard('lapse01', [A]);
      await fullChecks(A, g);
      const shift = await onShift(A, g);
      assert.deepEqual(await lapses(shift), [], 'nothing before the lapse');
      await sweep.runComplianceLapseScan();
      assert.deepEqual(await lapses(shift), [], 'a compliant Guard raises nothing');
      await expireCurrent(A, g, 'sia');
      await sweep.runComplianceLapseScan();
      const [alert, ...rest] = await lapses(shift);
      assert.equal(rest.length, 0);
      assert.equal(alert.companyId, A.id);
      assert.equal(alert.guardId, g.id);
      assert.equal(alert.priority, 'critical');
      assert.equal(alert.status, 'open');
      assert.equal(alert.category, 'sia');
      assert.equal(alert.reason, 'expired');
      assert.match(alert.message, new RegExp(`^Urgent compliance review required: SIA licence check expired on ${ukDay(-1).slice(8, 10)}/${ukDay(-1).slice(5, 7)}/${ukDay(-1).slice(0, 4)} while the Guard is on shift`));
      assert.match(alert.message, /S4 has not ended the shift and Book Off remains available/);
    });

    await test('LAPSE-02-TIME-LIMITED-RIGHT-TO-WORK-EXPIRY-DURING-A-SHIFT', async () => {
      const g = await guard('lapse02', [A]);
      await fullChecks(A, g, { rightToWorkExcuse: 'time_limited', expiryDate: ukDay(30) });
      const shift = await onShift(A, g);
      await expireCurrent(A, g, 'right_to_work');
      await sweep.runComplianceLapseScan();
      const alerts = await lapses(shift);
      assert.deepEqual(alerts.map((a) => `${a.category}:${a.reason}`), ['right_to_work:expired']);
      assert.doesNotMatch(alerts[0].message, /time.limited|manual|PVN|visa|passport|share code|HR\/lapse-spec/i, 'no immigration or evidence detail');
    });

    await test('LAPSE-03-CONTINUOUS-RIGHT-TO-WORK-NEVER-EXPIRES', async () => {
      const g = await guard('lapse03', [A]);
      await fullChecks(A, g, { rightToWorkExcuse: 'continuous' });
      const shift = await onShift(A, g);
      for (let i = 0; i < 3; i += 1) await sweep.runComplianceLapseScan(new Date(Date.now() + i * HOUR));
      assert.deepEqual(await lapses(shift), []);
    });

    await test('LAPSE-04-A-CHECK-RECORDED-AS-NOT-CONFIRMED-DURING-A-SHIFT', async () => {
      const g = await guard('lapse04', [A]);
      await fullChecks(A, g);
      const shift = await onShift(A, g);
      await recordCheck(A, g, 'right_to_work', { outcome: 'not_confirmed', rightToWorkExcuse: undefined });
      await recordCheck(A, g, 'sia', { outcome: 'not_confirmed', expiryDate: undefined });
      await sweep.runComplianceLapseScan();
      assert.deepEqual((await lapses(shift)).map((a) => `${a.category}:${a.reason}`).sort(), ['right_to_work:not_confirmed', 'sia:not_confirmed']);
    });

    await test('LAPSE-05-MISSING-CHECKS-ON-A-LIVE-SHIFT-ARE-RAISED', async () => {
      // A shift already in progress with no company checks (for example one that started before
      // Migration 62 was activated): a missing mandatory check is a lapse, not a pass.
      const g = await guard('lapse05', [A]);
      const shift = await readyShift(A, g);
      await q(`UPDATE shifts SET status = 'in_progress' WHERE id = $1`, [shift]);
      await sweep.runComplianceLapseScan();
      const alerts = await lapses(shift);
      assert.deepEqual(alerts.map((a) => `${a.category}:${a.reason}:${a.lapseKey}`).sort(), [
        'right_to_work:missing:right_to_work:none:missing',
        'sia:missing:sia:none:missing',
      ]);
    });

    // ══ multiple companies and shifts ═══════════════════════════════════════════════════════════════
    await test('LAPSE-06-ONLY-THE-COMPANY-WHOSE-CHECK-LAPSED-IS-ALERTED', async () => {
      const g = await guard('lapse06', [A, B]);
      await fullChecks(A, g);
      await fullChecks(B, g);
      const shiftA = await onShift(A, g);
      await api('POST', '/attendance/check-out', g.token, { shiftId: shiftA });
      const shiftB = await onShift(B, g);
      await expireCurrent(A, g, 'sia'); // A's check lapses; B's own checks are still valid.
      const beforeB = (await notificationsFor(B.id)).length;
      await sweep.runComplianceLapseScan();
      assert.deepEqual(await lapses(shiftB), [], 'B is not alerted about A’s check');
      assert.equal((await notificationsFor(B.id)).length, beforeB, 'and none of B’s people are notified');
      // A's shift is completed (booked off), so it is no longer watched either.
      assert.deepEqual(await lapses(shiftA), []);
    });

    await test('LAPSE-07-SEVERAL-LIVE-SHIFTS-EACH-GET-THEIR-OWN-ALERT', async () => {
      const g1 = await guard('lapse07a', [A]);
      const g2 = await guard('lapse07b', [B]);
      await fullChecks(A, g1);
      await fullChecks(B, g2);
      const s1 = await onShift(A, g1);
      const s2 = await onShift(B, g2);
      await expireCurrent(A, g1, 'sia');
      await expireCurrent(B, g2, 'right_to_work');
      await q(`UPDATE guard_compliance_checks SET "rightToWorkExcuse" = 'time_limited' WHERE "companyId" = $1 AND "guardId" = $2 AND kind = 'right_to_work'`, [B.id, g2.id]);
      await sweep.runComplianceLapseScan();
      assert.deepEqual((await lapses(s1)).map((a) => [a.companyId, a.category]), [[A.id, 'sia']]);
      assert.deepEqual((await lapses(s2)).map((a) => [a.companyId, a.category]), [[B.id, 'right_to_work']]);
    });

    // ══ deduplication ══════════════════════════════════════════════════════════════════════════════
    const dedupeGuard = await guard('lapse08', [A]);
    await fullChecks(A, dedupeGuard);
    const dedupeShift = await onShift(A, dedupeGuard);
    await expireCurrent(A, dedupeGuard, 'sia');

    await test('LAPSE-08-REPEATED-SWEEPS-CREATE-NO-DUPLICATES', async () => {
      const notesBefore = (await notificationsFor(A.id)).length;
      const first = await sweep.runComplianceLapseScan();
      assert.equal(first.alertsRaised, 1);
      for (let i = 0; i < 4; i += 1) {
        const again = await sweep.runComplianceLapseScan();
        assert.equal(again.alertsRaised, 0);
        assert.equal(again.notificationsCreated, 0);
      }
      assert.equal((await lapses(dedupeShift)).length, 1);
      const audits = await q(`SELECT id FROM audit_logs WHERE action = 'shift.compliance_lapse_detected' AND "afterData"->>'shiftId' = $1`, [String(dedupeShift)]);
      assert.equal(audits.length, 1, 'one detection record');
      assert.equal((await notificationsFor(A.id)).length - notesBefore, first.notificationsCreated, 'notifications only for the new alert');
    });

    await test('LAPSE-09-CONCURRENT-SWEEPS-CONVERGE-ON-ONE-ALERT', async () => {
      const g = await guard('lapse09', [A]);
      await fullChecks(A, g);
      const shift = await onShift(A, g);
      await expireCurrent(A, g, 'sia');
      await expireCurrent(A, g, 'right_to_work');
      await q(`UPDATE guard_compliance_checks SET "rightToWorkExcuse" = 'time_limited' WHERE "companyId" = $1 AND "guardId" = $2 AND kind = 'right_to_work'`, [A.id, g.id]);
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => sweep.runComplianceLapseScan()));
      const alerts = await lapses(shift);
      assert.deepEqual(alerts.map((a) => a.category).sort(), ['right_to_work', 'sia'], 'exactly one per category');
      assert.equal(results.reduce((sum, r) => sum + r.alertsRaised, 0) >= 2, true);
      // And the database itself refuses a second ACTIVE alert for the same company + shift + category,
      // whatever writes it.
      await assert.rejects(
        () => q(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message,"complianceCategory","complianceReason","lapseKey")
                 VALUES ($1,$2,$3,'compliance_lapse','critical','open','dup','sia','expired','sia:other:expired')`, [A.id, g.id, shift]),
        /uq_safety_alerts_compliance_lapse_active/,
      );
    });

    // ══ notifications ══════════════════════════════════════════════════════════════════════════════
    await test('LAPSE-10-COMPLIANCE-PEOPLE-GET-THE-REASON-OPERATIONS-GET-A-REVIEW-NOTICE-NOBODY-ELSE', async () => {
      const g = await guard('lapse10', [A]);
      await fullChecks(A, g, { rightToWorkExcuse: 'time_limited', expiryDate: ukDay(30) });
      const shift = await onShift(A, g);
      await expireCurrent(A, g, 'right_to_work');
      const before = await notificationsFor(A.id);
      await sweep.runComplianceLapseScan();
      const fresh = (await notificationsFor(A.id)).slice(before.length);
      const ids = (rows: any[]) => rows.map((row) => row.userId).sort((a: number, b: number) => a - b);
      const compliance = fresh.filter((row) => row.title === 'Urgent compliance review required');
      const operational = fresh.filter((row) => row.title === 'Urgent eligibility review required');
      assert.equal(compliance.length + operational.length, fresh.length, 'no other kind of notification');
      assert.deepEqual(ids(compliance), [A.ownerId, A.staff.owner, A.staff.admin, A.staff.hr_compliance].sort((a, b) => a - b),
        'owner + members with compliance.manage');
      assert.deepEqual(ids(operational), [A.staff.operations, A.staff.control_room].sort((a, b) => a - b), 'Operations + Control Room');
      for (const role of ['finance', 'viewer']) assert.ok(!ids(fresh).includes(A.staff[role]), `${role} is not notified`);
      assert.ok(!ids(fresh).includes(g.userId), 'the Guard is not notified');
      for (const row of compliance) {
        assert.match(row.message, /lapse10 Guard is on shift at Main Site: Right to work check expired on /);
        assert.match(row.message, /S4 has not ended the shift/);
      }
      for (const row of operational) {
        assert.match(row.message, /^lapse10 Guard on the \d\d:\d\d-\d\d:\d\d shift at Main Site needs an urgent eligibility review by your compliance team\. S4 has not ended the shift; Book Off remains available\.$/);
        assert.doesNotMatch(row.message, /SIA|right to work|licence|expired|confirmed|missing|immigration|visa|permission/i,
          'no check category, reason, expiry or immigration detail');
      }
      for (const row of fresh) {
        assert.doesNotMatch(row.message, new RegExp(`${g.licence}|HR/lapse-spec|public register|manual document|time.limited|\\.pdf`), 'no licence number, method or evidence');
      }
      // Repeated sweeps notify nobody again.
      await sweep.runComplianceLapseScan();
      await sweep.runComplianceLapseScan();
      assert.equal((await notificationsFor(A.id)).length, before.length + fresh.length);
      // In-app only: the sweep writes rows to `notifications` and calls no email, SMS or push service
      // (asserted statically in LAPSE-17).
      assert.equal((await lapses(shift)).length, 1);
    });

    // ══ audit, acknowledgement, resolution ═════════════════════════════════════════════════════════
    await test('LAPSE-11-DETECTION-ACKNOWLEDGEMENT-AND-RESOLUTION-ARE-AUDITED-WITH-WHO-AND-WHEN', async () => {
      const [alert] = await lapses(dedupeShift);
      const [detected] = await q(`SELECT "userId", "afterData", "createdAt" FROM audit_logs WHERE action = 'shift.compliance_lapse_detected' AND "entityId" = $1`, [alert.id]);
      assert.equal(detected.userId, null, 'raised by the system');
      assert.deepEqual(Object.keys(detected.afterData).sort(), ['category', 'checkId', 'detectedAt', 'guardId', 'reason', 'shiftId', 'siteId']);
      assert.equal(detected.afterData.category, 'sia');
      assert.equal(detected.afterData.siteId, A.siteId);

      // A Guard cannot act on it.
      assert.equal((await api('PATCH', `/alerts/${alert.id}/ack`, dedupeGuard.token)).status, 403);
      // Another company cannot act on it.
      assert.equal((await api('PATCH', `/alerts/${alert.id}/ack`, B.token)).status, 400);

      const ack = await api('PATCH', `/alerts/${alert.id}/ack`, A.token);
      assert.equal(ack.status, 200, JSON.stringify(ack.body));
      const [acked] = await q(`SELECT "userId", "beforeData", "afterData" FROM audit_logs WHERE action = 'safety_alert.acknowledged' AND "entityId" = $1`, [alert.id]);
      assert.equal(acked.userId, A.ownerId);
      assert.equal(acked.beforeData.status, 'open');
      assert.equal(acked.afterData.acknowledgedByUserId, A.ownerId);

      // Closing needs a reason from this alert's own set, and a note; a bare close is refused.
      assert.equal((await api('PATCH', `/alerts/${alert.id}/close`, A.token, {})).status, 400);
      assert.equal((await api('PATCH', `/alerts/${alert.id}/close`, A.token, { resolutionReason: 'guard_confirmed_safe', resolutionNote: 'x' })).status, 400);
      assert.equal((await api('PATCH', `/alerts/${alert.id}/close`, A.token, { resolutionReason: 'guard_stood_down' })).status, 400);
      const reasons = await api('GET', `/alerts/${alert.id}/resolution-reasons`, A.token);
      assert.deepEqual(reasons.body.reasons.map((r: any) => r.value), ['guard_stood_down', 'valid_check_recorded', 'check_record_corrected', 'escalated_to_management', 'other']);
      assert.ok(reasons.body.reasons.every((r: any) => r.noteRequired), 'a note is always required');
      const closed = await api('PATCH', `/alerts/${alert.id}/close`, A.token, { resolutionReason: 'guard_stood_down', resolutionNote: 'Stood down at 14:10 pending licence renewal.' });
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      const [closeAudit] = await q(`SELECT "userId", "afterData" FROM audit_logs WHERE action = 'safety_alert.closed' AND "entityId" = $1`, [alert.id]);
      assert.equal(closeAudit.userId, A.ownerId);
      assert.equal(closeAudit.afterData.resolutionReason, 'guard_stood_down');
      const [row] = await q(`SELECT status::text AS status, "closedByUserId", "closedAt", "acknowledgedAt", "createdAt", message FROM safety_alerts WHERE id = $1`, [alert.id]);
      assert.equal(row.status, 'closed');
      assert.equal(row.closedByUserId, A.ownerId);
      assert.ok(row.createdAt && row.acknowledgedAt && row.closedAt, 'detection, acknowledgement and resolution times are all kept');
      assert.equal(row.message, alert.message, 'the alert as raised is never overwritten');
    });

    await test('LAPSE-12-A-CLOSED-LAPSE-IS-NOT-RE-RAISED-BUT-A-NEW-ONE-IS', async () => {
      await sweep.runComplianceLapseScan();
      assert.deepEqual((await lapses(dedupeShift)).map((a) => a.status), ['closed'], 'the same lapse stays decided');
      // The company records a new check, which then lapses in a different way: a new event.
      await recordCheck(A, dedupeGuard, 'sia', { outcome: 'not_confirmed', expiryDate: undefined });
      await sweep.runComplianceLapseScan();
      const after = await lapses(dedupeShift);
      assert.deepEqual(after.map((a) => `${a.status}:${a.reason}`), ['closed:expired', 'open:not_confirmed']);
      assert.equal(Number((await one(`SELECT count(*)::int n FROM safety_alerts WHERE type::text = 'compliance_lapse' AND "shiftId" = $1`, [dedupeShift])).n), 2, 'history kept; nothing erased');
    });

    // ══ shift safety ═══════════════════════════════════════════════════════════════════════════════
    await test('LAPSE-13-THE-SWEEP-NEVER-TOUCHES-THE-SHIFT-AND-BOOK-OFF-STAYS-AVAILABLE', async () => {
      const g = await guard('lapse13', [A]);
      await fullChecks(A, g);
      const shift = await onShift(A, g);
      await expireCurrent(A, g, 'sia');
      const before = await shiftState(shift);
      const shiftsBefore = Number((await one(`SELECT count(*)::int n FROM shifts`)).n);
      await sweep.runComplianceLapseScan();
      await sweep.runComplianceLapseScan();
      assert.deepEqual(await shiftState(shift), before, 'still in progress, same Guard, no Book Off written');
      assert.equal(before.status, 'in_progress');
      assert.equal(Number((await one(`SELECT count(*)::int n FROM shifts`)).n), shiftsBefore, 'no replacement shift');
      assert.equal(Number((await one(`SELECT count(*)::int n FROM company_guards WHERE "guardId" = $1 AND status = 'ACTIVE'`, [g.id])).n), 1, 'Guard not removed');
      const off = await api('POST', '/attendance/check-out', g.token, { shiftId: shift });
      assert.ok(off.status === 201 || off.status === 200, `Book Off must stay available: ${off.status} ${JSON.stringify(off.body)}`);
      assert.equal((await shiftState(shift)).status, 'completed');
      // But a new shift cannot start while the check is lapsed.
      const next = await readyShift(A, g);
      const refused = await api('POST', '/attendance/check-in', g.token, { shiftId: next });
      assert.equal(refused.status, 403);
      assert.match(refused.body.message, /SIA licence expired/);
    });

    // ══ not an SOS ═════════════════════════════════════════════════════════════════════════════════
    await test('LAPSE-14-NEVER-AN-SOS-AND-NEVER-RAISED-BY-A-GUARD', async () => {
      const panic = Number((await one(`SELECT count(*)::int n FROM safety_alerts WHERE type::text = 'panic'`)).n);
      assert.equal(panic, 0, 'no lapse is stored as a panic alert');
      const g = await guard('lapse14', [A]);
      await fullChecks(A, g);
      const shift = await onShift(A, g);
      const forged = await api('POST', '/alerts', g.token, { shiftId: shift, type: 'compliance_lapse', message: 'fake' });
      assert.equal(forged.status, 400);
      assert.match(forged.body.message, /raised by S4 only/);
      assert.deepEqual(await lapses(shift), []);
    });

    await test('LAPSE-15-AN-ABANDONED-SHIFT-PAST-ITS-WATCH-WINDOW-IS-NOT-PAGED-ABOUT', async () => {
      const g = await guard('lapse15', [A]);
      const shift = await readyShift(A, g, { startOffset: -40 * HOUR }); // ended 32 hours ago
      await q(`UPDATE shifts SET status = 'in_progress' WHERE id = $1`, [shift]);
      await sweep.runComplianceLapseScan();
      assert.deepEqual(await lapses(shift), [], 'covered by its Missing Book Off alert instead');
    });

    // ══ old clients ════════════════════════════════════════════════════════════════════════════════
    await test('LAPSE-16-THE-COMPANY-ALERT-LIST-KEEPS-ITS-SHAPE-FOR-OLD-CLIENTS', async () => {
      const list = await api('GET', '/alerts/company', A.token);
      assert.equal(list.status, 200);
      const lapse = (list.body as any[]).find((a) => a.type === 'compliance_lapse');
      assert.ok(lapse, 'compliance alerts are in the same list');
      for (const key of ['id', 'type', 'priority', 'message', 'status', 'createdAt', 'shift', 'guard']) assert.ok(key in lapse, key);
      assert.ok((list.body as any[]).every((a) => typeof a.type === 'string' && typeof a.message === 'string'));
    });
    // ══ company members acting on alerts ════════════════════════════════════════════════════════════
    const memberToken = async (c: typeof A, role: string) => login(`${c === A ? 'lapsea' : 'lapseb'}.staff.${role}@example.invalid`);
    const memberGuard = await guard('lapse18', [A]);
    await fullChecks(A, memberGuard);
    const memberShift = await onShift(A, memberGuard);
    await expireCurrent(A, memberGuard, 'sia');
    await sweep.runComplianceLapseScan();
    const [memberAlert] = await lapses(memberShift);
    // A panic and a Missing Book Off on the same company, which members must not be able to act on.
    const [{ id: panicId }] = await q(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message)
      VALUES ($1,$2,$3,'panic','critical','open','SOS') RETURNING id`, [A.id, memberGuard.id, memberShift]);
    const [{ id: bookOffId }] = await q(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message)
      VALUES ($1,$2,$3,'missing_book_off','medium','open','No Book Off') RETURNING id`, [A.id, memberGuard.id, memberShift]);

    await test('LAPSE-18-HR-COMPLIANCE-ACKNOWLEDGES-AND-RESOLVES-A-COMPLIANCE-LAPSE-WITH-REASON-AND-NOTE', async () => {
      const hr = await memberToken(A, 'hr_compliance');
      const reasons = await api('GET', `/alerts/${memberAlert.id}/resolution-reasons`, hr);
      assert.equal(reasons.status, 200, JSON.stringify(reasons.body));
      const ack = await api('PATCH', `/alerts/${memberAlert.id}/ack`, hr);
      assert.equal(ack.status, 200, JSON.stringify(ack.body));
      assert.equal((await api('PATCH', `/alerts/${memberAlert.id}/close`, hr, {})).status, 400, 'no bare close');
      assert.equal((await api('PATCH', `/alerts/${memberAlert.id}/close`, hr, { resolutionReason: 'valid_check_recorded' })).status, 400, 'a note is mandatory');
      const closed = await api('PATCH', `/alerts/${memberAlert.id}/close`, hr, {
        resolutionReason: 'valid_check_recorded', resolutionNote: 'Renewed licence checked on the SIA register and recorded.',
      });
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      const audits = await q(`SELECT action, "userId", "beforeData", "afterData", "createdAt" FROM audit_logs
        WHERE "entityType" = 'safety_alert' AND "entityId" = $1 AND action IN ('safety_alert.acknowledged','safety_alert.closed') ORDER BY id`, [memberAlert.id]);
      assert.deepEqual(audits.map((a) => [a.action, a.userId]), [
        ['safety_alert.acknowledged', A.staff.hr_compliance],
        ['safety_alert.closed', A.staff.hr_compliance],
      ], 'the actor is recorded');
      assert.equal(audits[0].beforeData.status, 'open');
      assert.equal(audits[0].afterData.status, 'acknowledged');
      assert.equal(audits[1].beforeData.status, 'acknowledged');
      assert.equal(audits[1].afterData.status, 'closed');
      assert.equal(audits[1].afterData.resolutionReason, 'valid_check_recorded');
      assert.equal(audits[1].afterData.resolutionNote, 'Renewed licence checked on the SIA register and recorded.');
      assert.ok(audits.every((a) => a.createdAt), 'with the time');
    });

    await test('LAPSE-19-HR-COMPLIANCE-CANNOT-ACT-ON-PANIC-MISSING-BOOK-OFF-OR-OTHER-ALERTS', async () => {
      const hr = await memberToken(A, 'hr_compliance');
      for (const id of [panicId, bookOffId]) {
        for (const [method, path, body] of [
          ['PATCH', `/alerts/${id}/ack`, undefined],
          ['PATCH', `/alerts/${id}/close`, { resolutionReason: 'other', resolutionNote: 'x' }],
          ['GET', `/alerts/${id}/resolution-reasons`, undefined],
        ] as const) {
          const r = await api(method, path, hr, body);
          assert.equal(r.status, 403, `${method} ${path}: ${r.status}`);
        }
      }
      const rows = await q(`SELECT status::text AS status FROM safety_alerts WHERE id IN ($1, $2)`, [panicId, bookOffId]);
      assert.ok(rows.every((r) => r.status === 'open'), 'untouched');
    });

    await test('LAPSE-20-ROLES-WITHOUT-COMPLIANCE-MANAGE-CANNOT-ACT-AND-OTHER-COMPANIES-ARE-ISOLATED', async () => {
      const g = await guard('lapse20', [A]);
      await fullChecks(A, g);
      const shift = await onShift(A, g);
      await expireCurrent(A, g, 'sia');
      await sweep.runComplianceLapseScan();
      const [alert] = await lapses(shift);
      for (const role of ['operations', 'control_room', 'finance', 'viewer']) {
        const r = await api('PATCH', `/alerts/${alert.id}/ack`, await memberToken(A, role));
        assert.equal(r.status, 403, `${role}: ${r.status}`);
      }
      const otherHr = await memberToken(B, 'hr_compliance');
      assert.equal((await api('PATCH', `/alerts/${alert.id}/ack`, otherHr)).status, 400, 'another company’s HR cannot act');
      assert.equal((await api('PATCH', `/alerts/${alert.id}/close`, otherHr, { resolutionReason: 'other', resolutionNote: 'x' })).status, 400);
      assert.equal((await api('PATCH', `/alerts/${alert.id}/ack`, g.token)).status, 403, 'nor the Guard');
      assert.equal((await one(`SELECT status::text AS s FROM safety_alerts WHERE id = $1`, [alert.id])).s, 'open');
    });

    await test('LAPSE-21-MEMBERS-SEE-ONLY-THEIR-OWN-COMPANYS-COMPLIANCE-ALERTS', async () => {
      for (const role of ['hr_compliance', 'operations', 'control_room', 'viewer']) {
        const list = await api('GET', '/alerts/company', await memberToken(A, role));
        assert.equal(list.status, 200, role);
        assert.ok(list.body.length > 0, `${role} sees the company's compliance alerts`);
        assert.ok(list.body.every((a: any) => a.type === 'compliance_lapse'), `${role} sees no other alert type`);
        assert.ok(list.body.every((a: any) => a.company?.id === A.id), `${role} sees no other company`);
      }
      assert.equal((await api('GET', '/alerts/company', await memberToken(A, 'finance'))).status, 404, 'finance has no compliance.view: unchanged');
      const bList = await api('GET', '/alerts/company', await memberToken(B, 'hr_compliance'));
      assert.ok(bList.body.every((a: any) => a.company?.id === B.id));
    });

    await test('LAPSE-22-THE-OWNER-ACCOUNT-KEEPS-ITS-EXISTING-POWERS', async () => {
      const list = await api('GET', '/alerts/company', A.token);
      const types = new Set((list.body as any[]).map((a) => a.type));
      assert.ok(types.has('panic') && types.has('missing_book_off') && types.has('compliance_lapse'), 'the owner sees every alert');
      assert.equal((await api('PATCH', `/alerts/${panicId}/ack`, A.token)).status, 200, 'and may still act on a panic alert');
      assert.equal((await api('PATCH', `/alerts/${panicId}/close`, A.token, { resolutionReason: 'guard_confirmed_safe', resolutionNote: 'Spoke to the guard.' })).status, 200);
    });

    await test('LAPSE-23-BOOK-OFF-STAYS-AVAILABLE-WHILE-A-MEMBER-HANDLES-THE-ALERT', async () => {
      const off = await api('POST', '/attendance/check-out', memberGuard.token, { shiftId: memberShift });
      assert.ok(off.status === 201 || off.status === 200, `Book Off: ${off.status} ${JSON.stringify(off.body)}`);
      assert.equal((await shiftState(memberShift)).status, 'completed');
      await sweep.runComplianceLapseScan();
      assert.equal((await lapses(memberShift)).length, 1, 'no new alert for the same lapse; nothing re-raised after resolution');
    });

    // ══ static guarantees ═══════════════════════════════════════════════════════════════════════════
    await test('LAPSE-17-THE-SWEEP-ONLY-ADDS-RECORDS-AND-USES-NO-EXTERNAL-CHANNEL', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const source = readFileSync(join(__dirname, '..', 'src', 'safety-alert', 'safety-alert.service.ts'), 'utf8');
      // Executable code only: the doc comments legitimately name the channels the sweep must NOT use.
      const scan = source.split('async runComplianceLapseScan(')[1].split('private formatWindowLabel(')[0]
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(scan, /email|sms|whatsapp|push|resend|twilio|fetch\(/i, 'in-app notifications only');
      assert.doesNotMatch(scan, /\.update\(|\.delete\(|\.remove\(|UPDATE |DELETE |status = |checkOut|CHECK_OUT|assertGuardMayStartWork/, 'never changes a shift, attendance or an existing alert');
      assert.match(scan, /getGuardSummary\(guard\.id, shift\.company\.id\)/, 'the same company-scoped assessment as the gates');
      assert.match(scan, /orIgnore\(\)/);
      assert.match(scan, /type: SafetyAlertType\.COMPLIANCE_LAPSE/);
      assert.doesNotMatch(scan, /SafetyAlertType\.PANIC/);
      const init = source.split('onModuleInit() {')[1].split('onModuleDestroy()')[0];
      assert.match(init, /runMissedWelfareChecks\(\)[\s\S]*\.then\(\(\) => this\.runComplianceLapseScan\(\)\)/, 'runs on the backend’s own five-minute timer');
    });
  } finally {
    await app.close();
  }

  console.log(JSON.stringify({ event: 'compliance_lapse_certified', tests: passed }));
}

main().catch((error) => {
  console.error('FAIL ', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
