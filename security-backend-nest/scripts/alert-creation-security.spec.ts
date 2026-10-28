/**
 * Alert creation security: only trusted server-side sweeps may create system-generated alert types.
 * Real PostgreSQL, the real Nest application and real HTTP.
 *
 * The only public route that creates a safety alert is POST /alerts (Guard role). Everything else that
 * writes safety_alerts is a server sweep (welfare: missed Welfare Check evidence + summary, Missing Book
 * Off; compliance: compliance lapse). Every other module only reads alerts.
 *
 *   SEC-01  a Guard cannot create any system-generated type (missing_book_off, missed_checkcall,
 *           compliance_lapse, legacy check_call, late_checkin): refused, nothing written or notified
 *   SEC-02  the type is refused before any shift lookup (no probing through a forged type)
 *   SEC-03  a Guard can still raise SOS / panic (critical, owner notified, audited)
 *   SEC-04  a Guard can still raise a site request, the legacy welfare label and a default manual report
 *   SEC-05  forged company / site / guard fields are rejected outright
 *   SEC-06  another Guard's shift, another company's shift, a missing shift and a shift that is not live
 *           are refused, the first three with the same answer
 *   SEC-07  company, site and Guard on a created alert come from the server, never the request
 *   SEC-08  company and admin accounts cannot use the Guard route at all
 *   SEC-09  the server sweeps still create missing_book_off and compliance_lapse
 *   SEC-10  acknowledgement / resolution permissions are unchanged
 *
 * Needs ALERT_SECURITY_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

const url = process.env.ALERT_SECURITY_DATABASE_URL;
if (!url) throw new Error('ALERT_SECURITY_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Alert security database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'alert-security-local-certification-secret-not-production';
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
const PASSWORD = 'alert-security-spec-only-password-1';
const SYSTEM_TYPES = ['missing_book_off', 'missed_checkcall', 'compliance_lapse', 'check_call', 'late_checkin'];

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
  sweep.onModuleDestroy(); // every sweep in this spec is explicit
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
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n);

  try {
    const hash = await bcrypt.hash(PASSWORD, 4);
    const user = async (email: string, role: string) =>
      (await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName") VALUES ($1,$2,$3,'active',true,false,'Spec') RETURNING id`, [email, hash, role])).id as number;
    const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;
    const company = async (label: string, number: string) => {
      const ownerEmail = `${label}.owner@example.invalid`;
      const ownerId = await user(ownerEmail, 'company_admin');
      const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,$2,$3,'1 Way','ops@example.invalid') RETURNING id`, [ownerId, `${label} Ltd`, number]);
      const site = await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,$2,'2 Way') RETURNING id`, [id, `${label} Site`]);
      const hrEmail = `${label}.hr@example.invalid`;
      const hrId = await user(hrEmail, 'company_staff');
      await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,'hr_compliance','active')`, [hrId, id]);
      return { id: id as number, ownerId, siteId: site.id as number, token: await login(ownerEmail), hr: await login(hrEmail) };
    };
    const A = await company('secalpha', '71111111');
    const B = await company('secbeta', '72222222');

    let n = 0;
    const guard = async (label: string, c: typeof A) => {
      n += 1;
      const email = `${label}@example.invalid`;
      const userId = await user(email, 'guard');
      const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,'07000000000') RETURNING id`,
        [userId, `${label} Guard`, `90000000000000${String(n).padStart(2, '0')}`]);
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [c.id, id]);
      return { id: id as number, userId, token: await login(email) };
    };
    type G = Awaited<ReturnType<typeof guard>>;
    const shift = async (c: typeof A, g: G, status = 'in_progress', startOffset = -HOUR, hours = 8) => {
      const start = new Date(Date.now() + startOffset);
      const { id } = await one(`INSERT INTO shifts ("companyId","siteId","siteName",status,"guardId",start,"end","checkCallIntervalMinutes") VALUES ($1,$2,'Site',$3,$4,$5,$6,60) RETURNING id`,
        [c.id, c.siteId, status, g.id, start, new Date(start.getTime() + hours * HOUR)]);
      return id as number;
    };
    const alertsOn = (shiftId: number) => count(`SELECT count(*)::int n FROM safety_alerts WHERE "shiftId" = $1`, [shiftId]);
    const notifications = () => count(`SELECT count(*)::int n FROM notifications`);
    const createAudits = () => count(`SELECT count(*)::int n FROM audit_logs WHERE action = 'safety_alert.created'`);

    const g1 = await guard('secg1', A);
    const g2 = await guard('secg2', A);
    const gB = await guard('secgb', B);
    const s1 = await shift(A, g1);
    const s2 = await shift(A, g2);
    const sB = await shift(B, gB);

    await test('SEC-01-A-GUARD-CANNOT-CREATE-ANY-SYSTEM-GENERATED-ALERT-TYPE', async () => {
      const [before, notesBefore, auditsBefore] = [await alertsOn(s1), await notifications(), await createAudits()];
      for (const type of SYSTEM_TYPES) {
        const r = await api('POST', '/alerts', g1.token, { shiftId: s1, type, message: `forged ${type}` });
        assert.equal(r.status, 400, `${type}: ${r.status}`);
        assert.equal(r.body.message, 'This alert type is raised by S4 only.', type);
      }
      assert.equal(await alertsOn(s1), before, 'nothing written');
      assert.equal(await notifications(), notesBefore, 'nobody notified');
      assert.equal(await createAudits(), auditsBefore, 'no audit entry for a refused request');
    });

    await test('SEC-02-A-FORGED-TYPE-IS-REFUSED-BEFORE-ANY-SHIFT-LOOKUP', async () => {
      for (const shiftId of [s1, sB, 99999999]) {
        const r = await api('POST', '/alerts', g1.token, { shiftId, type: 'missing_book_off', message: 'x' });
        assert.equal(r.status, 400);
        assert.equal(r.body.message, 'This alert type is raised by S4 only.', 'same answer whatever the shift');
      }
    });

    await test('SEC-03-A-GUARD-CAN-STILL-RAISE-SOS', async () => {
      const notesBefore = await notifications();
      const r = await api('POST', '/alerts', g1.token, { shiftId: s1, type: 'panic', priority: 'low', message: 'Need help now' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.type, 'panic');
      assert.equal(r.body.priority, 'critical', 'an SOS is always critical, whatever the client sends');
      const [note] = await q(`SELECT "userId", title FROM notifications ORDER BY id DESC LIMIT 1`);
      assert.equal(await notifications(), notesBefore + 1);
      assert.equal(note.userId, A.ownerId);
      assert.equal(note.title, 'CRITICAL: Panic alert raised');
      const [audit] = await q(`SELECT "userId","companyId" FROM audit_logs WHERE action = 'safety_alert.created' AND "entityId" = $1`, [r.body.id]);
      assert.equal(audit.userId, g1.userId);
      assert.equal(audit.companyId, A.id);
    });

    await test('SEC-04-SITE-REQUESTS-THE-LEGACY-WELFARE-LABEL-AND-MANUAL-REPORTS-STILL-WORK', async () => {
      for (const [type, expected] of [['site_request', 'site_request'], ['welfare', 'welfare'], [undefined, 'other']] as const) {
        const r = await api('POST', '/alerts', g1.token, { shiftId: s1, ...(type ? { type } : {}), message: `report ${expected}` });
        assert.equal(r.status, 201, `${expected}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.type, expected);
      }
    });

    await test('SEC-05-FORGED-COMPANY-SITE-AND-GUARD-FIELDS-ARE-REJECTED', async () => {
      const before = await alertsOn(s1);
      for (const forged of [{ companyId: B.id }, { siteId: B.siteId }, { guardId: gB.id }, { company: { id: B.id } }, { status: 'closed' }]) {
        const r = await api('POST', '/alerts', g1.token, { shiftId: s1, type: 'site_request', message: 'x', ...forged });
        assert.equal(r.status, 400, `${JSON.stringify(forged)}: ${r.status}`);
      }
      assert.equal(await alertsOn(s1), before);
    });

    await test('SEC-06-ONLY-THE-GUARDS-OWN-LIVE-SHIFT-AND-THE-SAME-ANSWER-FOR-EVERY-OTHER-SHIFT', async () => {
      const answers = [];
      for (const shiftId of [s2, sB, 99999999]) {
        const r = await api('POST', '/alerts', g1.token, { shiftId, type: 'panic', message: 'x' });
        assert.equal(r.status, 400, `shift ${shiftId}: ${r.status}`);
        answers.push(r.body.message);
      }
      assert.deepEqual(new Set(answers), new Set(['This shift is not assigned to the current guard']),
        'another Guard’s, another company’s and a missing shift are indistinguishable');
      assert.equal(await alertsOn(s2), 0);
      assert.equal(await alertsOn(sB), 0);
      const notLive = await shift(A, g1, 'ready', HOUR);
      const r = await api('POST', '/alerts', g1.token, { shiftId: notLive, type: 'panic', message: 'x' });
      assert.equal(r.status, 400);
      assert.match(r.body.message, /must be in progress/);
      const noShift = await api('POST', '/alerts', g1.token, { type: 'panic', message: 'x' });
      assert.equal(noShift.status, 400);
      assert.match(noShift.body.message, /must be linked to an assigned shift/);
    });

    await test('SEC-07-COMPANY-SITE-AND-GUARD-ARE-TAKEN-FROM-THE-SERVER', async () => {
      const r = await api('POST', '/alerts', gB.token, { shiftId: sB, type: 'site_request', message: 'Gate light out' });
      assert.equal(r.status, 201);
      const row = await one(`SELECT "companyId","guardId","shiftId" FROM safety_alerts WHERE id = $1`, [r.body.id]);
      assert.deepEqual(row, { companyId: B.id, guardId: gB.id, shiftId: sB });
      // And it is visible to its own company only.
      const mine = await api('GET', '/alerts/company', B.token);
      const theirs = await api('GET', '/alerts/company', A.token);
      assert.ok((mine.body as any[]).some((a) => a.id === r.body.id));
      assert.ok(!(theirs.body as any[]).some((a) => a.id === r.body.id));
    });

    await test('SEC-08-COMPANY-ACCOUNTS-CANNOT-USE-THE-GUARD-ALERT-ROUTE', async () => {
      for (const token of [A.token, A.hr]) {
        const r = await api('POST', '/alerts', token, { shiftId: s1, type: 'panic', message: 'x' });
        assert.equal(r.status, 403);
      }
      assert.equal((await api('POST', '/alerts', null, { shiftId: s1, type: 'panic', message: 'x' })).status, 401);
    });

    await test('SEC-09-THE-SERVER-SWEEPS-STILL-CREATE-SYSTEM-ALERTS', async () => {
      // Missing Book Off: booked on, scheduled end over 15 minutes ago, no Book Off.
      const g3 = await guard('secg3', A);
      const ended = await shift(A, g3, 'in_progress', -6 * HOUR, 4);
      await q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt") VALUES ($1,$2,'check-in',$3)`, [ended, g3.id, new Date(Date.now() - 6 * HOUR)]);
      await sweep.runMissedWelfareChecks();
      assert.equal(await count(`SELECT count(*)::int n FROM safety_alerts WHERE "shiftId" = $1 AND type::text = 'missing_book_off'`, [ended]), 1);
      // Compliance lapse: a live shift with no company checks.
      await sweep.runComplianceLapseScan();
      assert.equal(await count(`SELECT count(*)::int n FROM safety_alerts WHERE "shiftId" = $1 AND type::text = 'compliance_lapse'`, [s1]), 2);
    });

    await test('SEC-10-ACKNOWLEDGEMENT-AND-RESOLUTION-PERMISSIONS-ARE-UNCHANGED', async () => {
      const [panic] = await q(`SELECT id FROM safety_alerts WHERE "shiftId" = $1 AND type::text = 'panic' ORDER BY id LIMIT 1`, [s1]);
      const [lapse] = await q(`SELECT id FROM safety_alerts WHERE "shiftId" = $1 AND type::text = 'compliance_lapse' ORDER BY id LIMIT 1`, [s1]);
      assert.equal((await api('PATCH', `/alerts/${panic.id}/ack`, g1.token)).status, 403, 'a Guard cannot acknowledge');
      // PR #56 isolation hardening: another company's alert is answered exactly like a missing one (404, was 400), so
      // alert ids cannot be probed across companies. Still refused, and the row is untouched.
      assert.equal((await api('PATCH', `/alerts/${panic.id}/ack`, B.token)).status, 404, 'another company cannot');
      assert.equal((await api('PATCH', `/alerts/${panic.id}/close`, B.token, { resolutionReason: 'guard_confirmed_safe', resolutionNote: 'x' })).status, 404, 'nor close it');
      assert.deepEqual((await q(`SELECT status::text AS status, "acknowledgedByUserId", "closedByUserId" FROM safety_alerts WHERE id = $1`, [panic.id]))[0], { status: 'open', acknowledgedByUserId: null, closedByUserId: null }, 'cross-company attempts leave the alert unchanged');
      assert.equal((await api('PATCH', `/alerts/${panic.id}/ack`, A.hr)).status, 403, 'HR / Compliance cannot act on an SOS');
      assert.equal((await api('PATCH', `/alerts/${lapse.id}/ack`, A.hr)).status, 200, 'but can on a compliance alert');
      assert.equal((await api('PATCH', `/alerts/${panic.id}/ack`, A.token)).status, 200, 'the owner can act on an SOS');
      const close = await api('PATCH', `/alerts/${panic.id}/close`, A.token, { resolutionReason: 'guard_confirmed_safe', resolutionNote: 'Called the guard.' });
      assert.equal(close.status, 200, JSON.stringify(close.body));
      const audits = await q(`SELECT action, "userId" FROM audit_logs WHERE "entityType" = 'safety_alert' AND "entityId" = $1 ORDER BY id`, [panic.id]);
      assert.deepEqual(audits.map((a) => a.action), ['safety_alert.created', 'safety_alert.acknowledged', 'safety_alert.closed']);
    });
  } finally {
    await app.close();
  }

  console.log(JSON.stringify({ event: 'alert_creation_security_certified', tests: passed }));
}

main().catch((error) => {
  console.error('FAIL ', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
