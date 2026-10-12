/**
 * Compliance phase 1B: the company compliance gate at the start of work (real PostgreSQL, real Nest app,
 * real HTTP).
 *
 * A Guard can be assigned while compliant and fall out of compliance before the shift starts (a check
 * expires, or is re-recorded as not confirmed). Work therefore re-checks the company's assessment at the
 * moment it starts, using the SAME gate as assignment (ShiftService.assertGuardMayStartWork:
 * ACTIVE relationship, then ComplianceService.assertGuardAssignable). Both routes that start work are
 * covered: the Guard's Book On and a company moving a shift to in_progress by hand.
 *
 *   BOC-01..06  eligibility and refusal: complete file, no company checks, expired / not confirmed checks,
 *               continuous right to work, expiring-soon still allowed
 *   BOC-07..08  company isolation and the relationship
 *   BOC-09      compliance refusal comes before (and regardless of) the location check
 *   BOC-10..11  bypass attempts: manual start by the company, guard routes
 *   BOC-12      already-active shift: Book Off and the idempotent retry are never blocked
 *   BOC-13      existing assignment made before the company recorded checks
 *   BOC-14      work restrictions are a warning only
 *   BOC-15      old client compatibility (response shapes, refusal body)
 *
 * Needs BOOK_ON_COMPLIANCE_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { complianceToday } from '../src/compliance/compliance-dates';

const url = process.env.BOOK_ON_COMPLIANCE_DATABASE_URL;
if (!url) throw new Error('BOOK_ON_COMPLIANCE_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Book On compliance database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'book-on-compliance-local-certification-secret-not-production';
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
const PASSWORD = 'book-on-spec-only-password-1';

const ukDay = (n: number) => {
  const [y, m, d] = complianceToday().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** Every key the pre-Migration-62 compliance summary carried, with its JSON type. Old clients read these. */
const LEGACY_SUMMARY_KEYS: Record<string, string[]> = {
  guardId: ['number'], fullName: ['string'], siaLicenceNumber: ['string', 'null'], siaExpiryDate: ['string', 'null'],
  rightToWorkStatus: ['string', 'null'], rightToWorkExpiryDate: ['string', 'null'], complianceStatus: ['string'],
  assignable: ['boolean'], blockingReasons: ['array'], expiringReasons: ['array'], missingDocuments: ['array'], documents: ['array'],
};
const jsonType = (value: unknown) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

async function main() {
  // Fresh schema from the repository's own migrations.
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const migrator = new DataSource({
    ...buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' }),
    dropSchema: true,
  } as never);
  await migrator.initialize();
  await migrator.runMigrations({ transaction: 'each' });
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
    // ── fixture: users, companies, guards, documents, sites (SQL: no product API in a test environment) ──
    const hash = await bcrypt.hash(PASSWORD, 4);
    const user = async (email: string, role: string) =>
      (await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired") VALUES ($1,$2,$3,'active',true,false) RETURNING id`, [email, hash, role])).id as number;
    // Sessions come from the real AuthService (as pilot-core does), so the login throttle — a production
    // control this spec must not weaken — is not hit by creating many accounts. Every action under test
    // still crosses real HTTP and real authorisation.
    const { AuthService } = await import('../src/auth/auth.service');
    const auth = app.get(AuthService);
    const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;
    const company = async (label: string, number: string) => {
      const ownerId = await user(`${label}.owner@example.invalid`, 'company_admin');
      const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,$2,$3,'1 Way','ops@example.invalid') RETURNING id`, [ownerId, `${label} Security Ltd`, number]);
      const site = await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'Main Site','2 Way') RETURNING id`, [id]);
      return { id: id as number, name: `${label} Security Ltd`, ownerEmail: `${label}.owner@example.invalid`, siteId: site.id as number, token: '' };
    };
    const A = await company('bocalpha', '51111111');
    const B = await company('bocbeta', '52222222');
    A.token = await login(A.ownerEmail);
    B.token = await login(B.ownerEmail);

    let n = 0;
    const guard = async (label: string, links: Array<{ c: typeof A; status?: string }>) => {
      n += 1;
      const email = `${label}@example.invalid`;
      const userId = await user(email, 'guard');
      // Declarations are always "valid" here, to prove they are not what lets anyone work.
      const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","siaExpiryDate","rightToWorkStatus",phone) VALUES ($1,$2,$3,$4,'british','07000000000') RETURNING id`,
        [userId, `${label} Guard`, `70000000000000${String(n).padStart(2, '0')}`, ukDay(500)]);
      for (const { c, status } of links) {
        await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,$3,'EMPLOYEE')`, [c.id, id, status ?? 'ACTIVE']);
        for (const type of ['sia_licence', 'right_to_work']) {
          await q(`INSERT INTO guard_documents ("guardId","companyId",type,"storageProvider","storageKey","originalFileName","mimeType","sizeBytes","uploadCompletedAt",verified,"uploadedByUserId","verifiedByUserId","verifiedAt")
            VALUES ($1,$2,$3,'s3-compatible',$4,'e.pdf','application/pdf','1024',now(),true,null,null,now())`, [id, c.id, type, `boc/${c.id}/${id}/${type}`]);
        }
      }
      return { id: id as number, userId, licence: `70000000000000${String(n).padStart(2, '0')}`, token: await login(email) };
    };
    type G = Awaited<ReturnType<typeof guard>>;

    /** Records a company check over the real endpoint, as the company's compliance manager. */
    const recordCheck = async (c: typeof A, g: G, kind: 'sia' | 'right_to_work', over: Record<string, unknown> = {}) => {
      const history = await api('GET', `/compliance/checks?guardId=${g.id}`, c.token);
      const current = (history.body as any[]).find((row) => row.kind === kind && !row.supersededAt);
      const body = {
        guardId: g.id, kind, outcome: 'confirmed', checkDate: ukDay(0), checkedByName: 'Spec Checker', evidenceReference: 'HR/spec',
        ...(kind === 'sia'
          ? { method: 'sia_public_register', licenceNumber: g.licence, expiryDate: ukDay(400) }
          : { method: 'manual_document', rightToWorkExcuse: 'continuous' }),
        ...(current ? { replacesCheckId: current.id, changeType: 'new_check' } : {}),
        ...over,
      };
      const r = await api('POST', '/compliance/checks', c.token, body);
      assert.equal(r.status, 201, `record ${kind}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    };
    const fullChecks = async (c: typeof A, g: G) => {
      await recordCheck(c, g, 'sia');
      await recordCheck(c, g, 'right_to_work');
    };

    /** A READY shift that started an hour ago, assigned to the guard. */
    const readyShift = async (c: typeof A, g: G, opts: { siteId?: number; status?: string } = {}) => {
      const start = new Date(Date.now() - HOUR);
      const { id } = await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end","checkCallIntervalMinutes") VALUES ($1,$2,'Main Site',$3,$4,$5,$6,60) RETURNING id`,
        [c.id, opts.siteId ?? c.siteId, g.id, opts.status ?? 'ready', start, new Date(start.getTime() + 8 * HOUR)]);
      return id as number;
    };
    const bookOn = (g: G, shiftId: number, extra: Record<string, unknown> = {}) => api('POST', '/attendance/check-in', g.token, { shiftId, ...extra });
    const bookOff = (g: G, shiftId: number) => api('POST', '/attendance/check-out', g.token, { shiftId });
    const shiftStatus = async (id: number) => (await one(`SELECT status FROM shifts WHERE id = $1`, [id])).status;
    const checkIns = async (id: number) => Number((await one(`SELECT count(*)::int n FROM attendance_events WHERE "shiftId" = $1 AND type = 'check-in'`, [id])).n);
    const refusals = async (shiftId: number) =>
      q(`SELECT "companyId","userId","afterData" FROM audit_logs WHERE action = 'attendance.book_on_refused' AND "entityType" = 'shift' AND "entityId" = $1 ORDER BY id`, [shiftId]);

    // ══ BOC-01..06 eligibility ══════════════════════════════════════════════════════════════════════
    await test('BOC-01-COMPLETE-COMPANY-FILE-BOOKS-ON', async () => {
      const g = await guard('boc01', [{ c: A }]);
      await fullChecks(A, g);
      const shift = await readyShift(A, g);
      const r = await bookOn(g, shift);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(await shiftStatus(shift), 'in_progress');
      assert.equal((await refusals(shift)).length, 0);
    });

    await test('BOC-02-NO-COMPANY-CHECKS-IS-REFUSED-WITH-AN-ACTIONABLE-REASON-AND-AUDITED', async () => {
      const g = await guard('boc02', [{ c: A }]);
      const shift = await readyShift(A, g);
      const r = await bookOn(g, shift);
      assert.equal(r.status, 403);
      assert.equal(r.body.message, `You cannot Book On for this shift: SIA licence check not recorded. Contact ${A.name} to resolve it.`);
      assert.equal(await shiftStatus(shift), 'ready', 'the shift does not start');
      assert.equal(await checkIns(shift), 0, 'no attendance event is written');
      const [audit] = await refusals(shift);
      assert.equal(audit.companyId, A.id);
      assert.equal(audit.userId, g.userId);
      assert.deepEqual(audit.afterData, { guardId: g.id, reason: 'SIA licence check not recorded' }, 'reason only: no evidence, licence or document details');
    });

    await test('BOC-03-EXPIRED-RIGHT-TO-WORK-IS-REFUSED', async () => {
      const g = await guard('boc03', [{ c: A }]);
      await recordCheck(A, g, 'sia');
      await recordCheck(A, g, 'right_to_work', { rightToWorkExcuse: 'time_limited', checkDate: ukDay(-100), expiryDate: ukDay(-1) });
      const shift = await readyShift(A, g);
      const r = await bookOn(g, shift);
      assert.equal(r.status, 403);
      assert.match(r.body.message, /Right to work permission expired/);
      assert.equal(await checkIns(shift), 0);
    });

    await test('BOC-04-NOT-CONFIRMED-AND-EXPIRED-SIA-ARE-REFUSED', async () => {
      const notConfirmed = await guard('boc04a', [{ c: A }]);
      await recordCheck(A, notConfirmed, 'sia');
      await recordCheck(A, notConfirmed, 'right_to_work', { outcome: 'not_confirmed', rightToWorkExcuse: undefined });
      const r1 = await bookOn(notConfirmed, await readyShift(A, notConfirmed));
      assert.equal(r1.status, 403);
      assert.match(r1.body.message, /Right to work check did not confirm permission to work/);

      const expiredSia = await guard('boc04b', [{ c: A }]);
      await recordCheck(A, expiredSia, 'sia', { checkDate: ukDay(-30), expiryDate: ukDay(-1) });
      await recordCheck(A, expiredSia, 'right_to_work');
      const r2 = await bookOn(expiredSia, await readyShift(A, expiredSia));
      assert.equal(r2.status, 403);
      assert.match(r2.body.message, /SIA licence expired/);
    });

    await test('BOC-05-CONTINUOUS-RIGHT-TO-WORK-NEEDS-NO-EXPIRY', async () => {
      const g = await guard('boc05', [{ c: A }]);
      await recordCheck(A, g, 'sia');
      const rtw = await recordCheck(A, g, 'right_to_work', { rightToWorkExcuse: 'continuous' });
      assert.equal(rtw.expiryDate, null);
      assert.equal((await bookOn(g, await readyShift(A, g))).status, 201);
    });

    await test('BOC-06-EXPIRING-SOON-WARNS-BUT-BOOKS-ON', async () => {
      const g = await guard('boc06', [{ c: A }]);
      await recordCheck(A, g, 'sia', { expiryDate: ukDay(10) });
      await recordCheck(A, g, 'right_to_work', { rightToWorkExcuse: 'time_limited', expiryDate: ukDay(5) });
      assert.equal((await bookOn(g, await readyShift(A, g))).status, 201);
    });

    // ══ BOC-07..08 isolation and relationship ═══════════════════════════════════════════════════════
    await test('BOC-07-ONE-COMPANYS-CHECKS-NEVER-LET-A-GUARD-WORK-FOR-ANOTHER', async () => {
      const g = await guard('boc07', [{ c: A }, { c: B }]);
      await fullChecks(A, g);
      const forB = await readyShift(B, g);
      const refused = await bookOn(g, forB);
      assert.equal(refused.status, 403);
      assert.match(refused.body.message, new RegExp(`SIA licence check not recorded. Contact ${B.name}`));
      const [audit] = await refusals(forB);
      assert.equal(audit.companyId, B.id, 'the refusal is recorded against the company whose shift it is');
      assert.equal((await bookOn(g, await readyShift(A, g))).status, 201, 'A’s own shift is unaffected');
    });

    await test('BOC-08-AN-ENDED-RELATIONSHIP-IS-REFUSED-EVEN-WITH-VALID-CHECKS', async () => {
      for (const status of ['INACTIVE', 'BLOCKED']) {
        const g = await guard(`boc08${status.toLowerCase()}`, [{ c: A }]);
        await fullChecks(A, g);
        const shift = await readyShift(A, g);
        await q(`UPDATE company_guards SET status = $1 WHERE "guardId" = $2`, [status, g.id]);
        const r = await bookOn(g, shift);
        assert.equal(r.status, 403, status);
        assert.match(r.body.message, /you are not currently active with this company/);
      }
    });

    // ══ BOC-09 ordering ═════════════════════════════════════════════════════════════════════════════
    await test('BOC-09-COMPLIANCE-REFUSAL-COMES-BEFORE-THE-LOCATION-CHECK', async () => {
      const { id: gpsSite } = await one(`INSERT INTO sites ("companyId",name,address,latitude,longitude,"geofenceRadiusMeters","requireGpsCheckIn") VALUES ($1,'GPS Site','3 Way',51.5,-0.12,100,true) RETURNING id`, [A.id]);
      const g = await guard('boc09', [{ c: A }]);
      const shift = await readyShift(A, g, { siteId: gpsSite });
      const r = await bookOn(g, shift); // no coordinates at all
      assert.equal(r.status, 403);
      assert.match(r.body.message, /SIA licence check not recorded/, 'told about compliance, not location');
    });

    // ══ BOC-10..11 bypass attempts ══════════════════════════════════════════════════════════════════
    await test('BOC-10-COMPANY-CANNOT-START-A-NON-COMPLIANT-GUARDS-SHIFT-BY-HAND', async () => {
      const g = await guard('boc10', [{ c: A }]);
      const shift = await readyShift(A, g);
      const refused = await api('PATCH', `/shifts/${shift}`, A.token, { status: 'in_progress' });
      assert.equal(refused.status, 403, JSON.stringify(refused.body));
      assert.match(refused.body.message, /Guard compliance invalid: SIA licence check not recorded/);
      assert.equal(await shiftStatus(shift), 'ready');
      await fullChecks(A, g);
      const started = await api('PATCH', `/shifts/${shift}`, A.token, { status: 'in_progress' });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.equal(await shiftStatus(shift), 'in_progress');
    });

    await test('BOC-11-GUARD-ROUTES-CANNOT-BYPASS-THE-GATE', async () => {
      const g = await guard('boc11', [{ c: A }]);
      const other = await guard('boc11other', [{ c: A }]);
      await fullChecks(A, other);
      const mine = await readyShift(A, g);
      const theirs = await readyShift(A, other);
      assert.equal((await api('PATCH', `/shifts/${mine}`, g.token, { status: 'in_progress' })).status, 403, 'a guard cannot set shift status');
      assert.equal((await bookOn(g, theirs)).status, 403, 'nor Book On to a compliant colleague’s shift');
      assert.equal(await shiftStatus(theirs), 'ready');
      const sneaky = await bookOn(g, mine, { companyId: B.id, guardId: other.id });
      assert.equal(sneaky.status, 400, 'extra identity fields are rejected outright');
      assert.equal(await shiftStatus(mine), 'ready');
      assert.equal((await api('PATCH', `/shifts/${mine}/respond`, g.token, { response: 'accepted' })).status, 400, 'respond cannot start a ready shift');
      assert.equal(await shiftStatus(mine), 'ready');
    });

    // ══ BOC-12 already-active shifts ════════════════════════════════════════════════════════════════
    await test('BOC-12-A-GUARD-ALREADY-ON-SHIFT-CAN-ALWAYS-BOOK-OFF-AND-RETRY-SAFELY', async () => {
      const g = await guard('boc12', [{ c: A }]);
      await fullChecks(A, g);
      const shift = await readyShift(A, g);
      const first = await bookOn(g, shift);
      assert.equal(first.status, 201);
      // While on shift, the company re-records the right to work check as not confirmed.
      await recordCheck(A, g, 'right_to_work', { outcome: 'not_confirmed', rightToWorkExcuse: undefined });
      const retry = await bookOn(g, shift);
      assert.equal(retry.status, 201, 'a lost-response retry still returns the original Book On');
      assert.equal(retry.body.id, first.body.id);
      assert.equal(await checkIns(shift), 1);
      const off = await bookOff(g, shift);
      assert.ok(off.status === 201 || off.status === 200, `Book Off must never be blocked: ${off.status} ${JSON.stringify(off.body)}`);
      assert.equal(await shiftStatus(shift), 'completed');
      // The next shift, however, is refused.
      const next = await bookOn(g, await readyShift(A, g));
      assert.equal(next.status, 403);
    });

    // ══ BOC-13 existing assignments ═════════════════════════════════════════════════════════════════
    await test('BOC-13-AN-ASSIGNMENT-MADE-BEFORE-CHECKS-EXISTED-CANNOT-BE-ACCEPTED-OR-WORKED-UNTIL-RECORDED', async () => {
      const g = await guard('boc13', [{ c: A }]);
      // Simulates a shift offered before activation, when the declaration-based rules let it through.
      const offered = await readyShift(A, g, { status: 'offered' });
      const accept = await api('PATCH', `/shifts/${offered}/respond`, g.token, { response: 'accepted' });
      assert.equal(accept.status, 403, 'acceptance re-runs the gate');
      assert.equal(await shiftStatus(offered), 'offered', 'the assignment is left in place, not removed');
      await fullChecks(A, g);
      assert.equal((await api('PATCH', `/shifts/${offered}/respond`, g.token, { response: 'accepted' })).status, 200);
      assert.equal((await bookOn(g, offered)).status, 201);
    });

    // ══ BOC-14 work restrictions ════════════════════════════════════════════════════════════════════
    await test('BOC-14-WORK-RESTRICTIONS-WARN-AND-ARE-NOT-ENFORCED-OR-TREATED-AS-APPROVAL', async () => {
      const g = await guard('boc14', [{ c: A }]);
      await recordCheck(A, g, 'sia');
      await recordCheck(A, g, 'right_to_work', { rightToWorkExcuse: 'time_limited', expiryDate: ukDay(200), workRestrictions: 'Student: 20 hours a week in term time' });
      const statuses = await api('GET', '/compliance/statuses', A.token);
      const summary = (statuses.body as any[]).find((s) => s.guardId === g.id);
      assert.equal(summary.complianceStatus, 'valid', 'a restriction does not change compliance');
      assert.equal(summary.companyChecks.rightToWork.workRestrictions, 'Student: 20 hours a week in term time');
      assert.equal(summary.warnings.length, 1);
      assert.match(summary.warnings[0], /S4 does not check shifts against them/);
      assert.equal((await bookOn(g, await readyShift(A, g))).status, 201, 'S4 does not enforce restrictions, and says so');
      const plain = (statuses.body as any[]).find((s) => s.companyChecks?.rightToWork && !s.companyChecks.rightToWork.workRestrictions);
      assert.deepEqual(plain.warnings, [], 'no restriction, no warning');
    });

    // ══ BOC-15 old clients ══════════════════════════════════════════════════════════════════════════
    await test('BOC-15-OLD-CLIENTS-KEEP-EVERY-FIELD-THEY-READ-AND-GET-A-READABLE-REFUSAL', async () => {
      const statuses = await api('GET', '/compliance/statuses', A.token);
      assert.equal(statuses.status, 200);
      for (const summary of statuses.body as any[]) {
        for (const [key, types] of Object.entries(LEGACY_SUMMARY_KEYS)) {
          assert.ok(key in summary, `${key} still present`);
          assert.ok(types.includes(jsonType(summary[key])), `${key} keeps its type (${jsonType(summary[key])})`);
        }
      }
      const g = await guard('boc15', [{ c: A }]);
      const mine = await api('GET', '/compliance/mine/status', g.token);
      assert.equal(mine.status, 200);
      assert.equal(mine.body.companyChecks, null, 'the Guard’s own view is unchanged');
      for (const key of Object.keys(LEGACY_SUMMARY_KEYS)) assert.ok(key in mine.body);
      // Shipped Android vc14 / iOS 13 show a 403 body.message verbatim (formatApiErrorMessage).
      const refused = await bookOn(g, await readyShift(A, g));
      assert.equal(refused.status, 403);
      assert.equal(typeof refused.body.message, 'string');
      assert.equal(refused.body.statusCode, 403);
      assert.doesNotMatch(refused.body.message, /HR\/spec|7000000000|\.pdf|evidence/i, 'no evidence details in the refusal');
    });
  } finally {
    await app.close();
  }

  console.log(JSON.stringify({ event: 'book_on_compliance_certified', tests: passed }));
}

main().catch((error) => {
  console.error('FAIL ', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
