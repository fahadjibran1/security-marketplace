/**
 * Timesheet review reasons, history and hours (owner-approved, 28 Oct 2026) certification: the whole application over
 * HTTP, on a disposable database built from the repository's own migrations. No migration is added.
 *
 * Live pilot finding (timesheet 40): the Guard claimed 9.50 h (9 h 30 min), the company read 9 h 50 min and returned
 * it with the web's generic default reason, and the reason vanished from the row when the Guard resubmitted.
 *
 *   TR-01  return / reject without a reason, with a token reason ("  ok "), or with > 500 characters: 400
 *          TIMESHEET_REVIEW_REASON_REQUIRED / TIMESHEET_REVIEW_REASON_TOO_LONG; nothing written, no audit, no notice
 *   TR-02  return with a reason: stored trimmed; the Guard's in-app notice carries the reason and what to do; reject too
 *   TR-03  approve is unchanged: the verified default needs no reason; approving the Guard's claim when it differs from
 *          verified needs the override reason (existing rule) and is audited as an override
 *   TR-04  history access: the owning Guard and the owning company read it; another Guard, another company, a client
 *          role and an unknown id get 404; no token 401
 *   TR-05  the reason and the previous claim survive resubmission (the row's rejectionReason is cleared as before);
 *          reviewer by name, the Guard as "You" to themself and by name to the company; no ids, no e-mail
 *   TR-06  hours / minutes storage unchanged: hoursWorked 8.57 → workedMinutes 514; 9.5 → 570
 *   TR-07  an override approval shows once in the history with its reason and approved minutes
 *   TR-08  static: no generic default reason in the web, the route and the reason check are wired
 *
 * Needs TIMESHEET_REVIEW_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
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

const url = process.env.TIMESHEET_REVIEW_DATABASE_URL;
if (!url) throw new Error('TIMESHEET_REVIEW_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Timesheet review database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'timesheet-review-local-certification-secret-not-production';
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
const PASSWORD = 'timesheet-review-spec-only-password-1';
const REASON = 'Your Book Off was 09:03, so 9h 30m looks too high. Check your hours.';
const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const minute = (ms: number) => Math.floor(ms / MIN) * MIN;

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
  const { AuthService } = await import('../src/auth/auth.service');
  clearInterval((app.get(SafetyAlertService) as any).welfareInterval);
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
    const user = async (email: string, role: string, first: string, last = 'Spec') =>
      (await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired",
          "firstName","lastName") VALUES ($1,$2,$3,'active',true,false,$4,$5) RETURNING id`, [email, hash, role, first, last])).id as number;
    const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;

    type Co = { id: number; ownerId: number; siteId: number; token: string };
    const company = async (label: string, number: string, first: string): Promise<Co> => {
      const ownerEmail = `${label}.owner@example.invalid`;
      const ownerId = await user(ownerEmail, 'company_admin', first, 'Reviewer');
      const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,$2,$3,'1 Way','ops@example.invalid') RETURNING id`, [ownerId, `${label} Security Ltd`, number]);
      const siteId = (await one(`INSERT INTO sites ("companyId",name,address,timezone,"welfareCheckIntervalMinutes") VALUES ($1,'Harbour Gate','3 Quay','Europe/London',60) RETURNING id`, [id])).id as number;
      return { id: id as number, ownerId, siteId, token: await login(ownerEmail) };
    };
    const A = await company('tralpha', '68111111', 'Sam');
    const B = await company('trbeta', '68222222', 'Bea');
    await user('tr.client@example.invalid', 'client_admin', 'Cli');
    const client = await login('tr.client@example.invalid');

    let n = 0;
    type G = { id: number; userId: number; token: string; name: string };
    const guard = async (co = A): Promise<G> => {
      n += 1;
      const email = `tr.guard${n}@example.invalid`;
      const userId = await user(email, 'guard', `Ava${n}`, 'Guard');
      const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","siaExpiryDate","rightToWorkStatus",phone) VALUES ($1,$2,$3,'2031-01-01','british',$4) RETURNING id`,
        [userId, `Ava${n} Guard`, `87000000000000${String(n).padStart(2, '0')}`, `0771090${String(n).padStart(4, '0')}`]);
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [co.id, id]);
      return { id: id as number, userId, token: await login(email), name: `Ava${n} Guard` };
    };
    /** A completed shift of `co` for `g` with a timesheet in `status`: verified 514 min (timesheet 40), claim `hours`. */
    const sheetFor = async (g: G, status: string, hours = 8.57, co: Co = A) => {
      const start = minute(Date.now() - 12 * HOUR);
      const { id: shiftId } = await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end","checkCallIntervalMinutes")
          VALUES ($1,$2,'Harbour Gate',$3,'completed',$4,$5,60) RETURNING id`, [co.id, co.siteId, g.id, ts(start), ts(start + 9.5 * HOUR)]);
      const worked = Math.round(hours * 60);
      return (await one(`INSERT INTO timesheets ("shiftId","guardId","companyId","hoursWorked","workedMinutes","roundedMinutes","approvalStatus",
            "actualCheckInAt","actualCheckOutAt","verifiedMinutes","verifiedSource","guardNote") VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,514,'manual',$9) RETURNING id`,
        [shiftId, g.id, co.id, hours, worked, status, ts(start), ts(start + 514 * MIN), status === 'submitted' ? 'Site finished early' : null])).id as number;
    };
    const row = (id: number) => one(`SELECT * FROM timesheets WHERE id = $1`, [id]);
    const auditCount = async (id: number) => Number((await one(`SELECT count(*)::int c FROM audit_logs WHERE "entityType" = 'timesheet' AND "entityId" = $1`, [id])).c);
    const notices = (userId: number) => q(`SELECT type::text, title, message FROM notifications WHERE "userId" = $1 ORDER BY id`, [userId]);
    const review = (tok: string, id: number, body: unknown) => api('PATCH', `/timesheets/${id}`, tok, body);
    const history = (tok: string | null, id: number) => api('GET', `/timesheets/${id}/history`, tok);

    await test('TR-01-RETURN-AND-REJECT-NEED-A-REAL-REASON', async () => {
      const g = await guard();
      const sheet = await sheetFor(g, 'submitted', 9.5);
      const before = JSON.stringify(await row(sheet));
      const audits = await auditCount(sheet);
      for (const status of ['returned', 'rejected']) {
        expect(await review(A.token, sheet, { approvalStatus: status }), 400, 'TIMESHEET_REVIEW_REASON_REQUIRED', `${status}, no reason`);
        expect(await review(A.token, sheet, { approvalStatus: status, rejectionReason: '' }), 400, 'TIMESHEET_REVIEW_REASON_REQUIRED', `${status}, empty`);
        expect(await review(A.token, sheet, { approvalStatus: status, rejectionReason: '  ok  ' }), 400, 'TIMESHEET_REVIEW_REASON_REQUIRED', `${status}, token`);
        expect(await review(A.token, sheet, { approvalStatus: status, rejectionReason: 'a b c d' }), 400, 'TIMESHEET_REVIEW_REASON_REQUIRED', `${status}, 4 letters`);
        expect(await review(A.token, sheet, { approvalStatus: status, rejectionReason: 'x'.repeat(501) }), 400, 'TIMESHEET_REVIEW_REASON_TOO_LONG', `${status}, too long`);
      }
      const refused = await review(A.token, sheet, { approvalStatus: 'returned' });
      assert.match(refused.body.message, /reason is required when returning a timesheet for correction/);
      assert.equal(JSON.stringify(await row(sheet)), before, 'nothing written');
      assert.equal(await auditCount(sheet), audits, 'no audit');
      assert.deepEqual(await notices(g.userId), [], 'no notice');
    });

    await test('TR-02-THE-REASON-IS-STORED-AND-SENT-TO-THE-GUARD', async () => {
      const g = await guard();
      const sheet = await sheetFor(g, 'submitted', 9.5);
      const r = await review(A.token, sheet, { approvalStatus: 'returned', rejectionReason: `   ${REASON}   ` });
      expect(r, 200, undefined, 'return');
      const t = await row(sheet);
      assert.deepEqual([t.approvalStatus, t.rejectionReason], ['returned', REASON], 'stored trimmed');
      assert.equal(t.reviewedByUserId, A.ownerId);
      const [notice] = await notices(g.userId);
      assert.equal(notice.type, 'timesheet_rejected');
      assert.equal(notice.title, 'Timesheet returned');
      assert.ok(notice.message.includes(`Reason: "${REASON}"`), notice.message);
      assert.ok(notice.message.endsWith('Correct your hours or note and submit again.'), notice.message);
      const exact = await review(A.token, await sheetFor(g, 'submitted'), { approvalStatus: 'rejected', rejectionReason: 'Duplicate of the shift on Monday.' });
      expect(exact, 200, undefined, 'reject');
      const all = await notices(g.userId);
      assert.equal(all[1].message.endsWith('was rejected. Reason: "Duplicate of the shift on Monday."'), true, all[1].message);
      assert.equal(await one(`SELECT count(*)::int c FROM guard_notification_dispatches WHERE "userId" = $1`, [g.userId]).then((x: any) => x.c), 0,
        'timesheet notices are in-app only (never pushed)');
    });

    await test('TR-03-APPROVE-IS-UNCHANGED-AND-THE-OVERRIDE-RULE-APPLIES-TO-THE-CLAIM', async () => {
      const g = await guard();
      const plain = await sheetFor(g, 'submitted', 9.5);
      expect(await review(A.token, plain, { approvalStatus: 'approved', rejectionReason: null }), 200, undefined, 'approve the verified default');
      const t = await row(plain);
      assert.deepEqual([t.approvalStatus, t.approvedMinutes, t.overrideReason, Number(t.hoursWorked), t.workedMinutes], ['approved', 514, null, 9.5, 570],
        "the verified default; the Guard's claim untouched");
      const claim = await sheetFor(g, 'submitted', 9.5);
      expect(await review(A.token, claim, { approvalStatus: 'approved', approvedMinutes: 570, rejectionReason: null }), 400, undefined, "approving the Guard's claim ≠ verified without a reason");
      assert.equal((await row(claim)).approvalStatus, 'submitted');
      expect(await review(A.token, claim, { approvalStatus: 'approved', approvedMinutes: 570, overrideReason: 'Site confirmed relief at 10:00.', rejectionReason: null }), 200);
      const c = await row(claim);
      assert.deepEqual([c.approvedMinutes, Number(c.approvedHours), c.overrideReason, c.overrideBy, c.verifiedMinutes, c.workedMinutes],
        [570, 9.5, 'Site confirmed relief at 10:00.', A.ownerId, 514, 570], 'verified minutes and the claim are never rewritten');
      assert.equal((await q(`SELECT 1 FROM audit_logs WHERE action = 'timesheet.approved_duration_overridden' AND "entityId" = $1`, [claim])).length, 1);
    });

    await test('TR-04-HISTORY-IS-FOR-THE-OWNING-GUARD-AND-COMPANY-ONLY', async () => {
      const g = await guard();
      const other = await guard();
      const sheet = await sheetFor(g, 'submitted');
      expect(await history(g.token, sheet), 200, undefined, 'own Guard');
      expect(await history(A.token, sheet), 200, undefined, 'own company');
      expect(await history(other.token, sheet), 404, undefined, 'another Guard');
      expect(await history(B.token, sheet), 404, undefined, 'another company');
      expect(await history(B.token, 999999), 404, undefined, 'unknown id');
      const bGuard = await guard(B);
      const bSheet = await sheetFor(bGuard, 'submitted', 8.57, B);
      expect(await history(A.token, bSheet), 404, undefined, "A cannot read B's timesheet");
      expect(await history(g.token, bSheet), 404, undefined, "a Guard cannot read another company's timesheet");
      const denied = await history(client, sheet);
      assert.ok(denied.status === 403 || denied.status === 404, `client role: ${denied.status}`);
      expect(await history(null, sheet), 401, undefined, 'no token');
    });

    await test('TR-05-THE-REASON-AND-THE-PREVIOUS-CLAIM-SURVIVE-RESUBMISSION', async () => {
      const g = await guard();
      const sheet = await sheetFor(g, 'draft', 8.57);
      expect(await api('PATCH', `/timesheets/${sheet}/submit`, g.token, { hoursWorked: 9.5, guardNote: 'Site finished early' }), 200, undefined, 'submit 9.50');
      expect(await review(A.token, sheet, { approvalStatus: 'returned', rejectionReason: REASON }), 200, undefined, 'return');
      expect(await api('PATCH', `/timesheets/${sheet}`, g.token, { hoursWorked: 8.57 }), 200, undefined, 'draft edit');
      expect(await api('PATCH', `/timesheets/${sheet}/submit`, g.token, { hoursWorked: 8.57, guardNote: 'Corrected to my Book Off' }), 200, undefined, 'resubmit');
      const t = await row(sheet);
      assert.deepEqual([t.approvalStatus, t.rejectionReason, t.reviewedAt], ['submitted', null, null], 'the row is cleared as before');

      const mine = await history(g.token, sheet);
      expect(mine, 200);
      const items = mine.body.items;
      assert.deepEqual(items.map((i: any) => i.action), ['submitted', 'returned', 'resubmitted']);
      assert.deepEqual([items[0].actorRole, items[0].actorName, items[0].claimedMinutesAfter, items[0].note], ['guard', 'You', 570, 'Site finished early']);
      assert.deepEqual([items[1].actorRole, items[1].actorName, items[1].reason, items[1].claimedMinutesAfter], ['company', 'Sam Reviewer', REASON, 570],
        'the reason and the reviewer are kept');
      assert.deepEqual([items[2].claimedMinutesBefore, items[2].claimedMinutesAfter, items[2].note], [570, 514, 'Corrected to my Book Off'],
        'the returned claim (not the draft) is the previous claim');
      for (const i of items) assert.ok(!Number.isNaN(Date.parse(i.at)));
      const text = JSON.stringify(mine.body);
      assert.doesNotMatch(text, /"[A-Za-z]*[iI]d"\s*:/, 'no ids');
      assert.doesNotMatch(text, /@example\.invalid|passwordHash|beforeData|afterData/, 'no e-mail, no raw audit');
      assert.deepEqual(Object.keys(items[0]).sort(), ['action', 'actorName', 'actorRole', 'approvedMinutes', 'at', 'claimedMinutesAfter', 'claimedMinutesBefore', 'note', 'reason']);

      const theirs = await history(A.token, sheet);
      assert.deepEqual(theirs.body.items.map((i: any) => i.actorName), [g.name, 'Sam Reviewer', g.name], 'the company sees its Guard by name');
      assert.equal(theirs.body.items[1].reason, REASON);
    });

    await test('TR-06-HOURS-AND-MINUTES-STORAGE-IS-UNCHANGED', async () => {
      const g = await guard();
      for (const [hours, minutes] of [[8.57, 514], [9.5, 570], [0.75, 45], [8.33, 500]] as const) {
        const sheet = await sheetFor(g, 'draft', 1);
        expect(await api('PATCH', `/timesheets/${sheet}/submit`, g.token, { hoursWorked: hours }), 200, undefined, `submit ${hours}`);
        const t = await row(sheet);
        assert.deepEqual([Number(t.hoursWorked), t.workedMinutes], [hours, minutes], `${hours} h is stored as ${minutes} minutes`);
      }
    });

    await test('TR-07-AN-OVERRIDE-APPROVAL-SHOWS-ONCE-WITH-ITS-REASON', async () => {
      const g = await guard();
      const sheet = await sheetFor(g, 'draft');
      expect(await api('PATCH', `/timesheets/${sheet}/submit`, g.token, { hoursWorked: 9.5 }), 200);
      expect(await review(A.token, sheet, { approvalStatus: 'approved', approvedMinutes: 540, overrideReason: 'Agreed 9h with the client.', companyNote: 'Paid 9h', rejectionReason: null }), 200);
      const items = (await history(g.token, sheet)).body.items;
      assert.deepEqual(items.map((i: any) => i.action), ['submitted', 'approved'], 'the override audit row is folded into the approval');
      assert.deepEqual([items[1].approvedMinutes, items[1].reason, items[1].note, items[1].claimedMinutesAfter], [540, 'Agreed 9h with the client.', 'Paid 9h', 570]);
    });

    await test('TR-08-STATIC-WIRING', async () => {
      const root = join(__dirname, '..', '..');
      const ws = readFileSync(join(root, 'security-mobile-app', 'src', 'components', 'company', 'CompanyTimesheetsWorkspace.tsx'), 'utf8');
      assert.ok(!ws.includes('Returned for correction by company reviewer.') && !ws.includes('Rejected by company reviewer.'), 'no generic default reason in the web');
      const svc = readFileSync(join(__dirname, '..', 'src', 'timesheet', 'timesheet.service.ts'), 'utf8');
      assert.match(svc, /timesheetReviewReasonRefusal\(dto\.rejectionReason, requestedStatus\)/);
      const ctl = readFileSync(join(__dirname, '..', 'src', 'timesheet', 'timesheet.controller.ts'), 'utf8');
      assert.match(ctl, /@Get\(':id\/history'\)/);
      const migrations = readFileSync(join(__dirname, '..', 'src', 'timesheet', 'timesheet-review.ts'), 'utf8');
      assert.doesNotMatch(migrations, /ALTER TABLE|CREATE TABLE/i, 'no schema change');
    });
  } finally {
    await app.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  console.log(JSON.stringify({ event: 'timesheet_review_certified', tests: passed }));
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
