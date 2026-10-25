/**
 * Live Shift Amendments, Phase 1 (owner-approved 22 Oct 2026) — certification over real HTTP with real authorisation,
 * audit and notifications, on a disposable database built from the repository's own migrations (head 64).
 *
 *   LSA-01  feature flag: off by default for every company; only the S4 platform administrator switches it
 *   LSA-02  normal extension accepted in the app: shift end moves, originalEnd kept, draft timesheet synced, audited
 *   LSA-03  declined: nothing changes
 *   LSA-04  withdrawn: the Guard can no longer answer
 *   LSA-05  expires without a response: acceptance after the current end is refused and the expiry is recorded;
 *           the expiry job marks lapsed proposals and tells the proposer; an unanswered proposal never extends
 *   LSA-06  last-minute proposal: warned, and still accepted before the end
 *   LSA-07  multiple sequential extensions: each references the previous effective end; originalEnd never moves
 *   LSA-08  Book Off while a proposal is pending voids it; the Book Off is untouched
 *   LSA-09  overlapping future shift: refused
 *   LSA-10  fatigue: warning > 12 h; Owner/Admin approval > 14 h (audited self-approval); hard limit > 16 h;
 *           rest < 11 h needs approval; > 48 h in 7 days flags compliance review — all on scheduled hours
 *   LSA-11  verbal agreement recorded by authorised staff (Owner, Operations, authorised Control Room); confirmation
 *           email outcome recorded truthfully; the Guard sees it as staff-reported
 *   LSA-12  unauthorised staff are refused; per-person Control Room grant and revoke; nothing else is granted
 *   LSA-13  dispute of a staff-recorded agreement keeps the extension; Owner/Admin resolves; in-app answers are not
 *           disputable
 *   LSA-14  only an in-progress, booked-on shift can be extended; ordinary edits still cannot move it
 *   LSA-15  a locked (approved) timesheet is never rewritten; the amendment is flagged for review
 *   LSA-16  tenant isolation
 *   LSA-17  audit integrity and idempotency: repeated answers return the stored result, no duplicate entries
 *   LSA-18  Missing Book Off is calculated from the effective end
 *   LSA-19  Welfare Checks continue to the effective end; existing missed windows untouched, not renumbered, no duplicates
 *   LSA-20  overnight and BST→GMT: scheduled hours and window grids are instant-based across the 25 Oct 2026 change
 *   LSA-21  Android 15 / iOS 14 compatibility: a pending proposal changes nothing the old apps read; afterwards they
 *           see the extended end, with every field they already used
 *   LSA-22  while a company is switched off, every state-changing route is refused and nothing changes
 *   LSA-23  the assessment is a dry run (nothing written), re-checked by the proposal, isolated like it, and never
 *           discloses another company's schedule (only that a warning applies)
 *   LSA-24  the staff directory is company-scoped, holds no contact details, shows authorisation only to Owner/Admin;
 *           no self-escalation or cross-company grant
 *   LSA-25  stored amendments, history, approvals and refusals never show a company another company's rest gap or 7-day
 *           hours (warnings and approval stay; the Guard keeps their own figures; legacy rows withheld)
 *
 * Deterministic races (the shift row, or the Guard lock, is held by a separate transaction until both requests are
 * queued behind it in a known order):
 *   LSA-R1  accept vs Book Off, both orders
 *   LSA-R2  accept vs withdraw, both orders
 *   LSA-R3  two simultaneous proposals: exactly one
 *   LSA-R4  accept vs the Welfare sweep's alert insert (the Phase 0b deadlock pattern): both commit, no deadlock
 *   LSA-R5  accept vs rota assignment of the same Guard into the extended window, both orders: never double-booked
 *   LSA-R6  a lock held too long is a retryable 409 SHIFT_AMENDMENT_BUSY, not a hung request
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { complianceToday } from '../src/compliance/compliance-dates';

const url = process.env.SHIFT_AMENDMENT_DATABASE_URL;
if (!url) throw new Error('SHIFT_AMENDMENT_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Shift amendment database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'shift-amendment-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.RESEND_API_KEY;

let passed = 0;
const failures: string[] = [];
const test = async (id: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failures.push(id);
    console.log(`FAIL  ${id}\n      ${String((error as Error)?.stack ?? error).split('\n').slice(0, 4).join('\n      ')}`);
  }
};

type Res = { status: number; body: any };
const HOUR = 3_600_000;
const MIN = 60_000;
const PASSWORD = 'shift-amendment-spec-only-password-1';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ukDay = (n: number) => {
  const [y, m, d] = complianceToday().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const iso = (ms: number) => new Date(ms).toISOString();
const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

async function main() {
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
  const { ShiftAmendmentService } = await import('../src/shift-amendment/shift-amendment.service');
  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const { assessFatigue, DEFAULT_SHIFT_POLICY } = await import('../src/shift-amendment/shift-amendment-policy');
  const { OperationalWindowService } = await import('../src/operations/operational-window.service');
  const amendments = app.get(ShiftAmendmentService);
  const sweep = app.get(SafetyAlertService);

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
  const ms = (v: unknown) => new Date(v as string).getTime();

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
      const siteId = (await one(`INSERT INTO sites ("companyId",name,address,timezone) VALUES ($1,'Main Site','2 Way','Europe/London') RETURNING id`, [id])).id as number;
      return { id: id as number, ownerId, siteId, token: await login(ownerEmail) };
    };
    const A = await company('lsaalpha', '75555555');
    const B = await company('lsabeta', '76666666');
    const staff = async (label: string, role: string, co = A) => {
      const email = `${label}@example.invalid`;
      const id = await user(email, 'company_admin');
      await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [id, co.id, role]);
      return { id, token: await login(email) };
    };
    const adminEmail = 'lsa.platform.admin@example.invalid';
    await user(adminEmail, 'admin');
    const adminToken = await login(adminEmail);

    let n = 0;
    const guard = async (label: string) => {
      n += 1;
      const email = `${label}@example.invalid`;
      const userId = await user(email, 'guard');
      const licence = `82000000000000${String(n).padStart(2, '0')}`;
      const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","siaExpiryDate","rightToWorkStatus",phone) VALUES ($1,$2,$3,$4,'british','07000000000') RETURNING id`,
        [userId, `${label} Guard`, licence, ukDay(500)]);
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [A.id, id]);
      for (const type of ['sia_licence', 'right_to_work']) {
        await q(`INSERT INTO guard_documents ("guardId","companyId",type,"storageProvider","storageKey","originalFileName","mimeType","sizeBytes","uploadCompletedAt",verified,"uploadedByUserId","verifiedByUserId","verifiedAt")
          VALUES ($1,$2,$3,'s3-compatible',$4,'e.pdf','application/pdf','1024',now(),true,null,null,now())`, [id, A.id, type, `lsa/${A.id}/${id}/${type}`]);
      }
      for (const body of [
        { guardId: id, kind: 'sia', outcome: 'confirmed', checkDate: ukDay(0), checkedByName: 'Spec Checker', evidenceReference: 'HR/spec', method: 'sia_public_register', licenceNumber: licence, expiryDate: ukDay(400) },
        { guardId: id, kind: 'right_to_work', outcome: 'confirmed', checkDate: ukDay(0), checkedByName: 'Spec Checker', evidenceReference: 'HR/spec', method: 'manual_document', rightToWorkExcuse: 'continuous' },
      ]) {
        const r = await api('POST', '/compliance/checks', A.token, body);
        assert.equal(r.status, 201, `record ${body.kind}: ${r.status} ${JSON.stringify(r.body)}`);
      }
      return { id: id as number, userId, token: await login(email) };
    };

    /** A booked-on, in-progress shift of company A: start and end relative to now (ms). */
    const liveShift = async (g: { id: number; token: string }, startIn: number, endIn: number, interval = 60) => {
      const now = Date.now();
      const { id } = await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end","checkCallIntervalMinutes") VALUES ($1,$2,'Main Site',$3,'ready',$4::timestamp,$5::timestamp,$6) RETURNING id`,
        [A.id, A.siteId, g.id, ts(now + startIn), ts(now + endIn), interval]);
      const on = await api('POST', '/attendance/check-in', g.token, { shiftId: id });
      assert.equal(on.status, 201, `book on: ${on.status} ${JSON.stringify(on.body)}`);
      return id as number;
    };
    const shiftRow = (id: number) => one(`SELECT status, start, "end", "originalEnd" FROM shifts WHERE id = $1`, [id]);
    const amendmentRow = (id: number) => one(`SELECT * FROM shift_amendments WHERE id = $1`, [id]);
    const audits = (entityType: string, id: number, action?: string) =>
      q(`SELECT action, "beforeData" b, "afterData" a, "userId" u, "companyId" c FROM audit_logs WHERE "entityType" = $1 AND "entityId" = $2 ${action ? 'AND action = $3' : ''} ORDER BY id`,
        action ? [entityType, id, action] : [entityType, id]);
    const notifications = async (userId: number, type: string) =>
      (await q(`SELECT id FROM notifications WHERE "userId" = $1 AND type = $2`, [userId, type])).length;
    const propose = (token: string, shiftId: number, endMs: number, reason = 'Relief Guard delayed by traffic') =>
      api('POST', `/shifts/${shiftId}/amendments`, token, { proposedEnd: iso(endMs), reason });
    const respond = (g: { token: string }, id: number, response: 'accepted' | 'declined') => api('PATCH', `/shift-amendments/${id}/respond`, g.token, { response });
    const enable = async (companyId: number) => {
      const r = await api('PUT', `/admin/shift-amendments/companies/${companyId}`, adminToken, { enabled: true });
      assert.equal(r.status, 200, `enable: ${r.status} ${JSON.stringify(r.body)}`);
    };

    // Row-lock holder, as in the re-acceptance suite.
    const hold = async (sql: string, params: unknown[]) => {
      const holder = ds.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      await holder.query(sql, params);
      return {
        runner: holder,
        release: async () => { await holder.commitTransaction(); await holder.release(); },
      };
    };
    const holdRow = (shiftId: number) => hold('SELECT id FROM shifts WHERE id = $1 FOR UPDATE', [shiftId]);
    const lockWaiters = async () =>
      Number((await one(`SELECT count(*) n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)).n);
    const untilWaiting = async (count: number, label: string) => {
      for (let i = 0; i < 400; i += 1) {
        if ((await lockWaiters()) >= count) return;
        await sleep(25);
      }
      throw new Error(`${label}: expected ${count} request(s) queued on a lock`);
    };

    const ops = await staff('lsa.ops', 'operations');
    const control = await staff('lsa.control', 'control_room');
    const viewer = await staff('lsa.viewer', 'viewer');
    const admin = await staff('lsa.admin', 'admin');

    // ════════════════ the feature flag ════════════════

    await test('LSA-01-OFF-BY-DEFAULT-AND-ONLY-S4-SWITCHES-IT', async () => {
      const g = await guard('lsa-flag');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const r = await propose(A.token, id, Date.now() + 3 * HOUR);
      assert.equal(r.status, 403, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'SHIFT_AMENDMENTS_DISABLED');
      const policy = await api('GET', '/shift-amendments/policy', A.token);
      assert.equal(policy.body.amendmentsEnabled, false);
      assert.equal(policy.body.source, 'default');
      const self = await api('PUT', `/admin/shift-amendments/companies/${A.id}`, A.token, { enabled: true });
      assert.equal(self.status, 403, 'a company cannot switch amendments on for itself');
      const tryPolicy = await api('PUT', '/shift-amendments/policy', A.token, { amendmentsEnabled: true });
      assert.equal(tryPolicy.status, 400, 'nor through the policy route (unknown field)');
      assert.equal((await api('GET', '/shift-amendments/policy', A.token)).body.amendmentsEnabled, false);
      await enable(A.id);
      assert.equal((await api('GET', '/shift-amendments/policy', A.token)).body.amendmentsEnabled, true);
      assert.equal((await audits('company', A.id, 'company_shift_policy.amendments_enabled')).length, 1, 'activation is audited');
      assert.equal((await api('GET', '/shift-amendments/policy', B.token)).body.amendmentsEnabled, false, 'other companies stay off');
    });

    // ════════════════ lifecycle ════════════════

    await test('LSA-02-ACCEPTED-IN-THE-APP-EXTENDS-THE-SHIFT', async () => {
      const g = await guard('lsa-accept');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const before = await shiftRow(id);
      const ts1 = (await one(`INSERT INTO timesheets ("shiftId","guardId","companyId","approvalStatus","payrollStatus","billingStatus","scheduledStartAt","scheduledEndAt") VALUES ($1,$2,$3,'draft','unpaid','uninvoiced',$4,$5) RETURNING id`,
        [id, g.id, A.id, before.start, before.end])).id;
      const newEnd = ms(before.end) + 90 * MIN;
      const p = await propose(A.token, id, newEnd);
      assert.equal(p.status, 201, `${p.status} ${JSON.stringify(p.body)}`);
      const a = p.body.amendment;
      assert.equal(a.status, 'pending');
      assert.equal(a.additionalMinutes, 90);
      assert.equal(ms((await shiftRow(id)).end), ms(before.end), 'a proposal never changes the shift');
      assert.equal((await shiftRow(id)).status, 'in_progress');
      assert.equal(await notifications(g.userId, 'shift_amendment_requested'), 1, 'the Guard is notified in the app');
      const r = await respond(g, a.id, 'accepted');
      assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.status, 'accepted');
      assert.equal(r.body.responseMethod, 'guard_app');
      const after = await shiftRow(id);
      assert.equal(ms(after.end), newEnd, 'the effective end is extended');
      assert.equal(ms(after.originalEnd), ms(before.end), 'the original end is kept');
      assert.equal(after.status, 'in_progress');
      assert.equal(ms((await one(`SELECT "scheduledEndAt" FROM timesheets WHERE id = $1`, [ts1])).scheduledEndAt), newEnd, 'the draft timesheet follows');
      assert.equal(r.body.timesheetSync, 'synced_draft');
      assert.equal(r.body.billingReviewRequired, true, 'flagged for billing review');
      assert.equal((await q(`SELECT 1 FROM attendance_events WHERE "shiftId" = $1`, [id])).length, 1, 'attendance untouched: only the Book On');
      assert.equal((await audits('shift_amendment', a.id, 'shift_amendment.proposed')).length, 1);
      assert.equal((await audits('shift_amendment', a.id, 'shift_amendment.accepted')).length, 1);
      const [ext] = await audits('shift', id, 'shift.extended');
      assert.equal(ms(ext.b.end), ms(before.end));
      assert.equal(ms(ext.a.end), newEnd);
      assert.equal(ext.u, g.userId, 'by the Guard who accepted');
      assert.equal(await notifications(A.ownerId, 'shift_amendment_responded'), 1, 'the proposer is notified');
    });

    await test('LSA-03-DECLINED-CHANGES-NOTHING', async () => {
      const g = await guard('lsa-decline');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const before = await shiftRow(id);
      const p = await propose(A.token, id, ms(before.end) + HOUR);
      const r = await respond(g, p.body.amendment.id, 'declined');
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'declined');
      assert.deepEqual(await shiftRow(id), before);
    });

    await test('LSA-04-WITHDRAWN-CANNOT-BE-ANSWERED', async () => {
      const g = await guard('lsa-withdraw');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const before = await shiftRow(id);
      const p = await propose(ops.token, id, ms(before.end) + HOUR);
      const w = await api('POST', `/shift-amendments/${p.body.amendment.id}/withdraw`, ops.token, { reason: 'Relief Guard arrived' });
      assert.equal(w.status, 200, `${w.status} ${JSON.stringify(w.body)}`);
      assert.equal(w.body.status, 'withdrawn');
      const r = await respond(g, p.body.amendment.id, 'accepted');
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'SHIFT_AMENDMENT_NOT_OPEN');
      assert.deepEqual(await shiftRow(id), before);
      assert.equal((await propose(A.token, id, ms(before.end) + HOUR)).status, 201, 'a new proposal may follow a withdrawn one');
    });

    await test('LSA-05-EXPIRY-NEVER-EXTENDS-AND-IS-RECORDED', async () => {
      const g = await guard('lsa-expiry');
      const id = await liveShift(g, -HOUR, 4_000);
      const before = await shiftRow(id);
      const p = await propose(A.token, id, ms(before.end) + HOUR);
      assert.equal(p.status, 201, `${p.status} ${JSON.stringify(p.body)}`);
      assert.ok(p.body.warnings.includes('LAST_MINUTE'));
      await sleep(4_500);
      const r = await respond(g, p.body.amendment.id, 'accepted');
      assert.equal(r.status, 409, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'SHIFT_AMENDMENT_EXPIRED');
      assert.equal((await amendmentRow(p.body.amendment.id)).status, 'expired', 'the expiry is committed, not rolled back with the refusal');
      assert.equal((await audits('shift_amendment', p.body.amendment.id, 'shift_amendment.expired')).length, 1);
      assert.deepEqual(await shiftRow(id), before, 'no retrospective acceptance');

      const g2 = await guard('lsa-expiry-job');
      const id2 = await liveShift(g2, -HOUR, 3_000);
      const p2 = await propose(ops.token, id2, Date.now() + HOUR);
      assert.equal(p2.status, 201);
      assert.equal((await api('GET', `/shift-amendments/${p2.body.amendment.id}`, g2.token)).body.effectiveStatus, 'pending');
      await sleep(3_500);
      assert.equal((await api('GET', `/shift-amendments/${p2.body.amendment.id}`, g2.token)).body.effectiveStatus, 'expired', 'reads show the lapse at once');
      const expired = await amendments.expireLapsedProposals();
      assert.ok(expired >= 1, `the expiry job marked ${expired}`);
      assert.equal((await amendmentRow(p2.body.amendment.id)).status, 'expired');
      assert.equal(await notifications(ops.id, 'shift_amendment_expired'), 1, 'the proposer is told');
      assert.equal(await amendments.expireLapsedProposals(), 0, 'idempotent');
    });

    await test('LSA-06-LAST-MINUTE-IS-WARNED-AND-STILL-WORKS', async () => {
      const g = await guard('lsa-lastminute');
      const id = await liveShift(g, -HOUR, 5 * MIN);
      const p = await propose(A.token, id, Date.now() + 2 * HOUR);
      assert.equal(p.status, 201);
      assert.deepEqual(p.body.warnings, ['LAST_MINUTE'], 'a prominent warning, not a refusal');
      assert.equal((await respond(g, p.body.amendment.id, 'accepted')).status, 200);
    });

    await test('LSA-07-SEQUENTIAL-EXTENSIONS-CHAIN-AND-KEEP-THE-ORIGINAL', async () => {
      const g = await guard('lsa-sequence');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const original = ms((await shiftRow(id)).end);
      const first = await propose(A.token, id, original + HOUR);
      assert.equal((await respond(g, first.body.amendment.id, 'accepted')).status, 200);
      const second = await propose(A.token, id, original + 2 * HOUR);
      assert.equal(second.status, 201);
      const s2 = second.body.amendment;
      assert.equal(s2.sequence, 2);
      assert.equal(ms(s2.previousEnd), original + HOUR, 'references the previous effective end');
      assert.equal(ms(s2.originalEnd), original);
      assert.equal((await respond(g, s2.id, 'accepted')).status, 200);
      const after = await shiftRow(id);
      assert.equal(ms(after.end), original + 2 * HOUR);
      assert.equal(ms(after.originalEnd), original, 'originalEnd never moves');
      const list = await api('GET', `/shifts/${id}/amendments`, A.token);
      assert.deepEqual(list.body.amendments.map((x: any) => x.sequence), [1, 2]);
      assert.equal(list.body.extended, true);
    });

    await test('LSA-08-BOOK-OFF-WHILE-PENDING-VOIDS-THE-PROPOSAL', async () => {
      const g = await guard('lsa-bookoff');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const before = await shiftRow(id);
      const p = await propose(A.token, id, ms(before.end) + HOUR);
      const off = await api('POST', '/attendance/check-out', g.token, { shiftId: id });
      assert.equal(off.status, 201, `${off.status} ${JSON.stringify(off.body)}`);
      const row = await amendmentRow(p.body.amendment.id);
      assert.equal(row.status, 'voided');
      assert.equal(row.voidedReason, 'booked_off');
      assert.equal((await audits('shift_amendment', p.body.amendment.id, 'shift_amendment.voided')).length, 1);
      const after = await shiftRow(id);
      assert.equal(after.status, 'completed');
      assert.equal(ms(after.end), ms(before.end), 'the voided proposal never extended the shift');
      assert.equal((await respond(g, p.body.amendment.id, 'accepted')).body.code, 'SHIFT_AMENDMENT_NOT_OPEN');
      assert.equal((await q(`SELECT 1 FROM attendance_events WHERE "shiftId" = $1`, [id])).length, 2, 'Book On and Book Off, untouched');
    });

    await test('LSA-09-OVERLAPPING-FUTURE-SHIFT-IS-REFUSED', async () => {
      const g = await guard('lsa-overlap');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const end = ms((await shiftRow(id)).end);
      await q(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Main Site',$3,'ready',$4::timestamp,$5::timestamp)`,
        [A.id, A.siteId, g.id, ts(end + 30 * MIN), ts(end + 8 * HOUR)]);
      const r = await propose(A.token, id, end + HOUR);
      assert.equal(r.status, 409, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'SHIFT_AMENDMENT_CLASH');
      assert.equal((await q(`SELECT 1 FROM shift_amendments WHERE "shiftId" = $1`, [id])).length, 0);
    });

    await test('LSA-10-FATIGUE-SAFEGUARDS-ON-SCHEDULED-HOURS', async () => {
      // > 12 h: warning only.
      const g1 = await guard('lsa-fatigue-warn');
      const s1 = await liveShift(g1, -HOUR, 2 * HOUR);
      const w = await propose(A.token, s1, Date.now() + 12 * HOUR);
      assert.equal(w.status, 201);
      assert.equal(w.body.amendment.status, 'pending');
      assert.ok(w.body.warnings.includes('LONG_SHIFT'));
      assert.equal(w.body.amendment.fatigue.basis, 'scheduled_hours');
      // > 14 h: Owner/Admin approval before the Guard can answer; self-approval needs explicit, audited confirmation.
      const g2 = await guard('lsa-fatigue-approval');
      const s2 = await liveShift(g2, -HOUR, 2 * HOUR);
      const ap = await propose(A.token, s2, Date.now() + 14.5 * HOUR);
      assert.equal(ap.body.amendment.status, 'awaiting_approval');
      assert.equal((await respond(g2, ap.body.amendment.id, 'accepted')).body.code, 'SHIFT_AMENDMENT_APPROVAL_REQUIRED');
      assert.equal(await notifications(g2.userId, 'shift_amendment_requested'), 0, 'the Guard is not asked before approval');
      assert.equal((await api('POST', `/shift-amendments/${ap.body.amendment.id}/approve`, ops.token, { statement: 'Approved by operations' })).status, 403, 'Operations cannot approve');
      const noConfirm = await api('POST', `/shift-amendments/${ap.body.amendment.id}/approve`, A.token, { statement: 'Approved: no relief available' });
      assert.equal(noConfirm.body.code, 'SHIFT_AMENDMENT_SELF_APPROVAL_CONFIRMATION_REQUIRED');
      const ok = await api('POST', `/shift-amendments/${ap.body.amendment.id}/approve`, A.token, { statement: 'Approved: no relief available', confirmSelfApproval: true });
      assert.equal(ok.status, 200, `${ok.status} ${JSON.stringify(ok.body)}`);
      assert.equal(ok.body.status, 'pending');
      assert.equal(ok.body.selfApproved, true);
      assert.equal((await audits('shift_amendment', ap.body.amendment.id, 'shift_amendment.approved'))[0].a.selfApproved, true);
      assert.equal((await respond(g2, ap.body.amendment.id, 'accepted')).status, 200);
      // An Admin approving someone else's proposal is not self-approval.
      const g2b = await guard('lsa-fatigue-admin');
      const s2b = await liveShift(g2b, -HOUR, 2 * HOUR);
      const ap2 = await propose(ops.token, s2b, Date.now() + 14.5 * HOUR);
      const ok2 = await api('POST', `/shift-amendments/${ap2.body.amendment.id}/approve`, admin.token, { statement: 'Approved by admin' });
      assert.equal(ok2.status, 200);
      assert.equal(ok2.body.selfApproved, false);
      // > 16 h: the configurable hard limit refuses.
      const g3 = await guard('lsa-fatigue-limit');
      const s3 = await liveShift(g3, -HOUR, 2 * HOUR);
      const lim = await propose(A.token, s3, Date.now() + 16 * HOUR);
      assert.equal(lim.status, 422);
      assert.equal(lim.body.code, 'SHIFT_AMENDMENT_FATIGUE_LIMIT');
      // The company can change it; a null hard limit means none.
      assert.equal((await api('PUT', '/shift-amendments/policy', A.token, { hardLimitHours: null })).status, 200);
      assert.equal((await propose(A.token, s3, Date.now() + 16 * HOUR)).body.amendment.status, 'awaiting_approval');
      assert.equal((await api('PUT', '/shift-amendments/policy', A.token, { hardLimitHours: 16 })).status, 200);
      assert.equal((await api('PUT', '/shift-amendments/policy', ops.token, { hardLimitHours: 30 })).status, 403, 'Operations cannot change policy');
      assert.equal((await api('PUT', '/shift-amendments/policy', A.token, { fatigueWarningHours: 15 })).status, 422, 'thresholds must stay in order');
      // Rest under 11 h before the next shift: warning and management review.
      const g4 = await guard('lsa-fatigue-rest');
      const s4 = await liveShift(g4, -HOUR, 2 * HOUR);
      const newEnd = Date.now() + 3 * HOUR;
      await q(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Main Site',$3,'ready',$4::timestamp,$5::timestamp)`,
        [A.id, A.siteId, g4.id, ts(newEnd + 6 * HOUR), ts(newEnd + 14 * HOUR)]);
      const rest = await propose(A.token, s4, newEnd);
      assert.ok(rest.body.warnings.includes('SHORT_REST'));
      assert.equal(rest.body.amendment.status, 'awaiting_approval');
      assert.equal(rest.body.amendment.fatigue.restHoursBeforeNextShift, 6);
      // More than 48 scheduled hours in 7 days: warning and compliance review, never a block.
      const g5 = await guard('lsa-fatigue-week');
      for (let d = 1; d <= 5; d += 1) {
        await q(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Main Site',$3,'completed',$4::timestamp,$5::timestamp)`,
          [A.id, A.siteId, g5.id, ts(Date.now() - d * 24 * HOUR), ts(Date.now() - d * 24 * HOUR + 10 * HOUR)]);
      }
      const s5 = await liveShift(g5, -HOUR, 2 * HOUR);
      const wk = await propose(A.token, s5, Date.now() + 3 * HOUR);
      assert.equal(wk.status, 201);
      assert.ok(wk.body.warnings.includes('WEEKLY_HOURS'));
      assert.equal(wk.body.amendment.complianceReviewRequired, true);
      assert.equal(wk.body.amendment.status, 'pending');
      assert.ok(wk.body.amendment.fatigue.sevenDayScheduledHours > 48);
    });

    await test('LSA-11-VERBAL-AGREEMENT-BY-AUTHORISED-STAFF', async () => {
      const g = await guard('lsa-verbal');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const before = await shiftRow(id);
      const newEnd = ms(before.end) + HOUR;
      const p = await propose(ops.token, id, newEnd);
      const aId = p.body.amendment.id;
      const body = { agreedEnd: iso(newEnd), contactMethod: 'telephone', contactAt: iso(Date.now()), confirmation: 'Phoned the Guard, who agreed to stay one more hour.', reason: 'Relief delayed' };
      assert.equal((await api('POST', `/shift-amendments/${aId}/record-verbal-agreement`, ops.token, { ...body, agreedEnd: iso(newEnd + MIN) })).body.code,
        'SHIFT_AMENDMENT_AGREED_TERMS_MISMATCH', 'staff cannot record different terms');
      assert.equal((await api('POST', `/shift-amendments/${aId}/record-verbal-agreement`, ops.token, { ...body, contactAt: iso(Date.now() - 2 * HOUR) })).body.code,
        'SHIFT_AMENDMENT_CONTACT_TIME_INVALID', 'contact cannot predate the proposal');
      const r = await api('POST', `/shift-amendments/${aId}/record-verbal-agreement`, ops.token, body);
      assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.status, 'accepted');
      assert.equal(r.body.responseMethod, 'staff_recorded_verbal');
      assert.equal(r.body.staffReported, true);
      assert.equal(r.body.respondedByUserId, ops.id, 'the staff member, never the Guard');
      assert.equal(r.body.confirmationEmailStatus, 'captured_outbox', 'the email outcome is what S4 actually knows (test outbox), never "delivered"');
      assert.equal(ms((await shiftRow(id)).end), newEnd);
      const [acc] = await audits('shift_amendment', aId, 'shift_amendment.accepted');
      assert.equal(acc.u, ops.id);
      assert.equal(acc.a.staffReported, true);
      assert.equal(acc.a.verbalContactMethod, 'telephone');
      assert.equal((await audits('shift_amendment', aId, 'shift_amendment.confirmation_email'))[0].a.outcome, 'captured_outbox');
      const seen = await api('GET', `/shift-amendments/${aId}`, g.token);
      assert.equal(seen.body.staffReported, true, 'the Guard sees it as staff-reported');
      assert.equal(await notifications(g.userId, 'shift_amendment_responded'), 1, 'and is told in the app');
      // The proposer may record it (Owner, proposing and recording).
      const g2 = await guard('lsa-verbal-owner');
      const id2 = await liveShift(g2, -HOUR, 2 * HOUR);
      const end2 = ms((await shiftRow(id2)).end) + HOUR;
      const p2 = await propose(A.token, id2, end2);
      const r2 = await api('POST', `/shift-amendments/${p2.body.amendment.id}/record-verbal-agreement`, A.token,
        { ...body, agreedEnd: iso(end2), contactMethod: 'in_person', contactAt: iso(Date.now()) });
      assert.equal(r2.status, 200);
      // A verbal record is refused while management approval is outstanding.
      const g3 = await guard('lsa-verbal-approval');
      const id3 = await liveShift(g3, -HOUR, 2 * HOUR);
      const p3 = await propose(A.token, id3, Date.now() + 14.5 * HOUR);
      assert.equal((await api('POST', `/shift-amendments/${p3.body.amendment.id}/record-verbal-agreement`, A.token,
        { ...body, agreedEnd: p3.body.amendment.proposedEnd })).body.code, 'SHIFT_AMENDMENT_APPROVAL_REQUIRED');
    });

    await test('LSA-12-UNAUTHORISED-STAFF-AND-PER-PERSON-CONTROL-ROOM', async () => {
      const g = await guard('lsa-perms');
      const id = await liveShift(g, -HOUR, 3 * HOUR);
      const end = ms((await shiftRow(id)).end);
      for (const [who, token] of [['viewer', viewer.token], ['control room (not authorised)', control.token], ['guard', g.token]] as const) {
        const r = await propose(token, id, end + HOUR);
        assert.equal(r.status, 403, `${who}: ${r.status}`);
      }
      assert.equal((await api('PUT', `/shift-amendments/control-room/${control.id}`, ops.token, { canAmendShifts: true })).status, 403, 'Operations cannot grant');
      assert.equal((await api('PUT', `/shift-amendments/control-room/${ops.id}`, A.token, { canAmendShifts: true })).status, 422, 'only Control Room members are granted individually');
      const grant = await api('PUT', `/shift-amendments/control-room/${control.id}`, A.token, { canAmendShifts: true });
      assert.equal(grant.status, 200);
      const shown = async () => (((await auth.getCurrentUser(control.id, 'company_admin' as never)) as any).companyPermissions ?? []) as string[];
      const granted = await shown();
      assert.ok(granted.includes('shifts.amend') && granted.includes('shifts.amend.record_agreement'), `the grant is shown to the web app: ${granted}`);
      assert.ok(!granted.includes('shifts.amend.approve') && !granted.includes('shifts.amend.resolve_dispute'), 'but never approve or resolve');
      assert.equal((await audits('company_membership', (await one(`SELECT id FROM company_memberships WHERE "userId" = $1`, [control.id])).id, 'company_membership.amendment_authorisation')).length, 1);
      const p = await propose(control.token, id, end + HOUR);
      assert.equal(p.status, 201, `authorised control room: ${p.status} ${JSON.stringify(p.body)}`);
      assert.equal((await api('POST', `/shift-amendments/${p.body.amendment.id}/approve`, control.token, { statement: 'Approved by control room', confirmSelfApproval: true })).status, 403, 'but never approves');
      assert.equal((await api('PATCH', `/shifts/${id}`, control.token, { instructions: 'x' })).status, 403, 'and gains no shift editing');
      assert.equal((await api('GET', '/payroll-batches', control.token)).status >= 400, true, 'nor payroll');
      const verbal = await api('POST', `/shift-amendments/${p.body.amendment.id}/record-verbal-agreement`, control.token,
        { agreedEnd: iso(end + HOUR), contactMethod: 'radio', contactAt: iso(Date.now()), confirmation: 'Guard agreed over the radio to stay.', reason: 'Cover' });
      assert.equal(verbal.status, 200, 'an authorised Control Room member may record agreement');
      assert.equal((await api('PUT', `/shift-amendments/control-room/${control.id}`, A.token, { canAmendShifts: false })).status, 200);
      assert.equal((await propose(control.token, id, end + 2 * HOUR)).status, 403, 'revoked');
      assert.ok(!(await shown()).some((p) => p.startsWith('shifts.amend')), 'and the revocation is shown too');
    });

    await test('LSA-13-DISPUTE-KEEPS-THE-EXTENSION-UNTIL-REVIEWED', async () => {
      const g = await guard('lsa-dispute');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const newEnd = ms((await shiftRow(id)).end) + HOUR;
      const p = await propose(A.token, id, newEnd);
      const aId = p.body.amendment.id;
      await api('POST', `/shift-amendments/${aId}/record-verbal-agreement`, A.token,
        { agreedEnd: iso(newEnd), contactMethod: 'telephone', contactAt: iso(Date.now()), confirmation: 'Phoned the Guard, who agreed to stay.', reason: 'Cover' });
      const d = await api('POST', `/shift-amendments/${aId}/dispute`, g.token, { reason: 'I did not agree to this' });
      assert.equal(d.status, 200, `${d.status} ${JSON.stringify(d.body)}`);
      assert.equal(d.body.status, 'disputed');
      assert.equal(d.body.payrollReviewRequired, true);
      assert.equal(ms((await shiftRow(id)).end), newEnd, 'the extension stays in force (Welfare cover continues)');
      assert.equal(await notifications(A.ownerId, 'shift_amendment_disputed'), 1);
      assert.equal(await notifications(admin.id, 'shift_amendment_disputed'), 1, 'Owners and Admins are told');
      assert.equal((await api('POST', `/shift-amendments/${aId}/resolve-dispute`, ops.token, { resolution: 'upheld', note: 'Upheld by operations' })).status, 403, 'Owner/Admin only');
      const res = await api('POST', `/shift-amendments/${aId}/resolve-dispute`, admin.token, { resolution: 'corrected', note: 'Payroll to pay to the original end' });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'dispute_corrected');
      assert.equal(ms((await shiftRow(id)).end), newEnd, 'never silently reversed');
      // An in-app acceptance is the Guard's own answer: not disputable.
      const g2 = await guard('lsa-dispute-app');
      const id2 = await liveShift(g2, -HOUR, 2 * HOUR);
      const p2 = await propose(A.token, id2, ms((await shiftRow(id2)).end) + HOUR);
      await respond(g2, p2.body.amendment.id, 'accepted');
      assert.equal((await api('POST', `/shift-amendments/${p2.body.amendment.id}/dispute`, g2.token, { reason: 'x x x' })).body.code, 'SHIFT_AMENDMENT_NOT_DISPUTABLE');
    });

    await test('LSA-14-ONLY-A-LIVE-BOOKED-ON-SHIFT-AND-EDITS-STILL-CANNOT-MOVE-IT', async () => {
      const g = await guard('lsa-notlive');
      const future = (await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Main Site',$3,'ready',now() + interval '30 hours', now() + interval '38 hours') RETURNING id`,
        [A.id, A.siteId, g.id])).id;
      assert.equal((await propose(A.token, future, Date.now() + 40 * HOUR)).body.code, 'SHIFT_AMENDMENT_NOT_LIVE', 'a future shift uses the ordinary edit (re-acceptance)');
      const noBookOn = (await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Main Site',$3,'in_progress',now() - interval '1 hour', now() + interval '1 hour') RETURNING id`,
        [A.id, A.siteId, g.id])).id;
      assert.equal((await propose(A.token, noBookOn, Date.now() + 3 * HOUR)).body.code, 'SHIFT_AMENDMENT_NOT_LIVE', 'no Book On, no extension');
      const g2 = await guard('lsa-notlater');
      const id = await liveShift(g2, -HOUR, 2 * HOUR);
      const end = ms((await shiftRow(id)).end);
      assert.equal((await propose(A.token, id, end - MIN)).body.code, 'SHIFT_AMENDMENT_NOT_LATER');
      assert.equal((await api('POST', `/shifts/${id}/amendments`, A.token, { proposedEnd: '2026-12-01T10:00:00', reason: 'no offset' })).status, 400, 'local wall time is refused');
      assert.equal((await api('PATCH', `/shifts/${id}`, A.token, { end: iso(end + HOUR) })).status, 409, 'the ordinary edit still cannot extend a live shift');
    });

    await test('LSA-15-A-LOCKED-TIMESHEET-IS-NEVER-REWRITTEN', async () => {
      for (const [label, approval, payroll, billing] of [
        ['approved', 'approved', 'unpaid', 'uninvoiced'], ['submitted', 'submitted', 'unpaid', 'uninvoiced'],
        ['paid', 'approved', 'paid', 'uninvoiced'], ['invoiced', 'approved', 'unpaid', 'invoiced'],
      ]) {
        const g = await guard(`lsa-locked-${label}`);
        const id = await liveShift(g, -HOUR, 2 * HOUR);
        const before = await shiftRow(id);
        const sheet = (await one(`INSERT INTO timesheets ("shiftId","guardId","companyId","approvalStatus","payrollStatus","billingStatus","scheduledStartAt","scheduledEndAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [id, g.id, A.id, approval, payroll, billing, before.start, before.end])).id;
        const snapshot = await one(`SELECT row_to_json(t)::text j FROM timesheets t WHERE id = $1`, [sheet]);
        const p = await propose(A.token, id, ms(before.end) + HOUR);
        const r = await respond(g, p.body.amendment.id, 'accepted');
        assert.equal(r.status, 200);
        assert.equal(r.body.timesheetSync, 'flagged_locked', label);
        assert.equal(r.body.payrollReviewRequired, true, `${label}: flagged for authorised review`);
        assert.equal((await one(`SELECT row_to_json(t)::text j FROM timesheets t WHERE id = $1`, [sheet])).j, snapshot.j, `${label}: byte-identical`);
      }
    });

    await test('LSA-16-TENANT-ISOLATION', async () => {
      const g = await guard('lsa-tenant');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const end = ms((await shiftRow(id)).end);
      await enable(B.id);
      assert.equal((await propose(B.token, id, end + HOUR)).status, 404, 'another company cannot propose');
      const p = await propose(A.token, id, end + HOUR);
      const aId = p.body.amendment.id;
      for (const [path, method, body] of [
        [`/shift-amendments/${aId}`, 'GET', undefined], [`/shifts/${id}/amendments`, 'GET', undefined],
        [`/shift-amendments/${aId}/withdraw`, 'POST', {}], [`/shift-amendments/${aId}/approve`, 'POST', { statement: 'Approved by another company', confirmSelfApproval: true }],
      ] as const) {
        assert.equal((await api(method, path, B.token, body)).status, 404, `${method} ${path}`);
      }
      const other = await guard('lsa-tenant-other');
      assert.equal((await respond(other, aId, 'accepted')).status, 404, "another Guard cannot answer this Guard's request");
      assert.equal((await api('GET', `/shifts/${id}/amendments`, other.token)).status, 404);
      assert.equal((await amendmentRow(aId)).status, 'pending');
      assert.equal(Number((await one(`SELECT count(*) n FROM audit_logs WHERE "companyId" = $1 AND "entityType" = 'shift_amendment'`, [B.id])).n), 0);
    });

    await test('LSA-17-AUDIT-INTEGRITY-AND-IDEMPOTENT-ANSWERS', async () => {
      const g = await guard('lsa-idem');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const p = await propose(A.token, id, ms((await shiftRow(id)).end) + HOUR);
      const aId = p.body.amendment.id;
      const first = await respond(g, aId, 'accepted');
      const again = await respond(g, aId, 'accepted');
      assert.equal(again.status, 200, 'the same answer returns the stored result');
      assert.deepEqual(again.body, first.body);
      const other = await respond(g, aId, 'declined');
      assert.equal(other.status, 409);
      assert.equal(other.body.code, 'SHIFT_AMENDMENT_ALREADY_ANSWERED');
      const actions = (await audits('shift_amendment', aId)).map((x: any) => x.action);
      assert.deepEqual(actions, ['shift_amendment.proposed', 'shift_amendment.accepted'], 'exactly one entry per real change');
      assert.equal((await audits('shift', id, 'shift.extended')).length, 1);
      for (const entry of await audits('shift_amendment', aId)) assert.equal(entry.c, A.id, 'every entry carries the company');
    });

    // ════════════════ Welfare and Missing Book Off ════════════════

    await test('LSA-23-ASSESSMENT-IS-A-DRY-RUN-THAT-NEVER-DISCLOSES-ANOTHER-COMPANYS-SCHEDULE', async () => {
      const assess = (token: string, shiftId: number, endMs: number) => api('POST', `/shifts/${shiftId}/amendments/assessment`, token, { proposedEnd: iso(endMs) });
      const counts = async () => one(`SELECT (SELECT count(*) FROM shift_amendments) a, (SELECT count(*) FROM notifications) n, (SELECT count(*) FROM audit_logs) l`);
      const g = await guard('lsa-assess');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const end = ms((await shiftRow(id)).end);
      const before = await counts();
      const ok = await assess(A.token, id, end + HOUR);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.canPropose, true);
      assert.deepEqual(ok.body.blockedBy, []);
      assert.equal(ok.body.additionalMinutes, 60);
      assert.equal(ok.body.approvalRequired, false);
      assert.equal(ok.body.timeZone, 'Europe/London');
      assert.match(ok.body.proposedEndLocal, /^\d\d-\d\d-\d{4} · \d\d:\d\d$/, 'site-local display');
      assert.equal(ok.body.basis, 'scheduled_hours');
      assert.deepEqual(await counts(), before, 'no amendment, notification or audit row');
      assert.equal(ms((await shiftRow(id)).end), end, 'the shift is untouched');

      // over the hard limit: reported, not thrown, and still nothing written
      const long = await assess(A.token, id, end + 16 * HOUR);
      assert.equal(long.status, 200);
      assert.equal(long.body.hardLimitExceeded, true);
      assert.equal(long.body.canPropose, false);
      assert.ok(long.body.blockedBy.some((b: any) => b.code === 'SHIFT_AMENDMENT_FATIGUE_LIMIT'));
      assert.deepEqual(await counts(), before);

      // permission and isolation exactly as for proposing
      assert.equal((await assess(ops.token, id, end + HOUR)).status, 200, 'Operations may propose, so may assess');
      for (const [who, token] of [['viewer', viewer.token], ['control room (not authorised)', control.token], ['guard', g.token]] as const) {
        assert.equal((await assess(token, id, end + HOUR)).status, 403, who);
      }
      assert.equal((await assess(B.token, id, end + HOUR)).status, 404, 'another company');
      assert.equal((await assess(A.token, id, end - HOUR)).body.code, 'SHIFT_AMENDMENT_NOT_LATER');

      // another company's next shift drives a SHORT_REST warning, but its time is never returned
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE') ON CONFLICT DO NOTHING`, [B.id, g.id]);
      const bStart = end + HOUR + 5 * HOUR;
      await q(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Rival Depot',$3,'ready',$4::timestamp,$5::timestamp)`,
        [B.id, B.siteId, g.id, ts(bStart), ts(bStart + 8 * HOUR)]);
      const cross = await assess(A.token, id, end + HOUR);
      assert.ok(cross.body.warnings.includes('SHORT_REST'), JSON.stringify(cross.body.warnings));
      assert.equal(cross.body.approvalRequired, true);
      assert.deepEqual(cross.body.approvalReasons, ['SHORT_REST']);
      assert.equal(cross.body.restHoursBeforeNextShift, null, 'no figure from another company');
      assert.equal(cross.body.restFiguresWithheld, true);
      const text = JSON.stringify(cross.body);
      for (const leak of [iso(bStart), iso(bStart + 8 * HOUR), 'Rival Depot']) {
        assert.ok(!text.includes(leak), `does not disclose ${leak}`);
      }
      // exactly these fields: nothing that could carry another shift's site, company or times
      assert.deepEqual(Object.keys(cross.body).sort(), ['additionalMinutes', 'approvalReasons', 'approvalRequired', 'basis', 'blockedBy',
        'canPropose', 'companySevenDayScheduledHours', 'complianceReviewRequired', 'currentEnd', 'currentEndLocal', 'hardLimitExceeded',
        'proposedEnd', 'proposedEndLocal', 'restFiguresWithheld', 'restHoursBeforeNextShift', 'sevenDayIncludesOtherWork', 'shiftId',
        'thresholds', 'timeZone', 'totalScheduledHours', 'warnings']);
      assert.equal(cross.body.shiftId, id, 'only the asked-about shift is named');
      // the company's own next shift is disclosed: it is the company's own schedule
      const aStart = end + HOUR + 3 * HOUR;
      await q(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Main Site',$3,'ready',$4::timestamp,$5::timestamp)`,
        [A.id, A.siteId, g.id, ts(aStart), ts(aStart + HOUR)]);
      const own = await assess(A.token, id, end + HOUR);
      assert.equal(own.body.restFiguresWithheld, false);
      assert.equal(own.body.restHoursBeforeNextShift, 3);

      // advice, never a reservation: the proposal re-checks under lock
      const g2 = await guard('lsa-assess-race');
      const id2 = await liveShift(g2, -HOUR, 2 * HOUR);
      const end2 = ms((await shiftRow(id2)).end);
      assert.equal((await assess(A.token, id2, end2 + HOUR)).body.canPropose, true);
      await q(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Main Site',$3,'ready',$4::timestamp,$5::timestamp)`,
        [A.id, A.siteId, g2.id, ts(end2 + 30 * MIN), ts(end2 + 3 * HOUR)]);
      const now = await assess(A.token, id2, end2 + HOUR);
      assert.equal(now.body.canPropose, false);
      assert.ok(now.body.blockedBy.some((b: any) => b.code === 'SHIFT_AMENDMENT_CLASH'), JSON.stringify(now.body.blockedBy));
      const p = await propose(A.token, id2, end2 + HOUR);
      assert.equal(p.status, 409, `proposal re-validates: ${p.status} ${JSON.stringify(p.body)}`);
      assert.equal(p.body.code, 'SHIFT_AMENDMENT_CLASH');
    });

    await test('LSA-24-STAFF-DIRECTORY-IS-COMPANY-SCOPED-AND-HOLDS-NO-CONTACT-DETAILS', async () => {
      const opsUser = (await one(`SELECT "userId" FROM company_memberships WHERE "userId" = (SELECT id FROM users WHERE email = 'lsa.ops@example.invalid')`)).userId;
      await q(`UPDATE users SET "firstName" = 'Olivia', "lastName" = 'Okoro', phone = '07000000001' WHERE id = $1`, [opsUser]);
      const admin = await staff('lsa.dir.admin', 'admin');
      const bControl = await staff('lsa.dir.bcontrol', 'control_room', B);
      const dir = await api('GET', '/shift-amendments/staff', A.token);
      assert.equal(dir.status, 200);
      assert.equal(dir.body.canManageControlRoom, true);
      const byId = new Map(dir.body.staff.map((s: any) => [s.userId, s]));
      assert.equal((byId.get(A.ownerId) as any).role, 'owner');
      assert.equal((byId.get(A.ownerId) as any).isYou, true);
      assert.equal((byId.get(opsUser) as any).displayName, 'Olivia Okoro');
      assert.equal((byId.get(control.id) as any).displayName, `Control Room (staff #${control.id})`, 'no name on file: role, never the email');
      assert.equal((byId.get(control.id) as any).canAmendShifts, false);
      assert.ok(!('canAmendShifts' in (byId.get(opsUser) as any)), 'authorisation shown only where it applies');
      assert.ok(!byId.has(viewer.id), 'a role that cannot act on amendments is not listed');
      assert.ok(!byId.has(bControl.id), "another company's staff are never listed");
      const text = JSON.stringify(dir.body);
      for (const leak of ['@', 'passwordHash', '07000000001', 'email', 'phone']) assert.ok(!text.includes(leak), `no ${leak}`);
      for (const s of dir.body.staff) assert.deepEqual(Object.keys(s).sort().filter((k) => !['canAmendShifts'].includes(k)), ['displayName', 'isYou', 'role', 'userId']);

      const opsDir = await api('GET', '/shift-amendments/staff', ops.token);
      assert.equal(opsDir.status, 200);
      assert.equal(opsDir.body.canManageControlRoom, false);
      assert.ok(opsDir.body.staff.every((s: any) => !('canAmendShifts' in s)), 'only Owner/Admin see authorisation');
      const bDir = await api('GET', '/shift-amendments/staff', B.token);
      assert.ok(!bDir.body.staff.some((s: any) => s.userId === control.id || s.userId === opsUser), 'company B sees only its own');
      assert.equal((await api('GET', '/shift-amendments/staff', (await guard('lsa-dir-guard')).token)).status, 403);

      // grants through the existing route; no self-escalation, no cross-company change
      const put = (token: string, userId: number, canAmendShifts: boolean) => api('PUT', `/shift-amendments/control-room/${userId}`, token, { canAmendShifts });
      assert.equal((await put(control.token, control.id, true)).status, 403, 'Control Room cannot grant itself');
      assert.equal((await put(ops.token, control.id, true)).status, 403, 'Operations cannot grant');
      assert.equal((await put(admin.token, admin.id, true)).status, 422, 'Admin is not a Control Room member to grant');
      assert.equal((await put(A.token, bControl.id, true)).status, 404, "another company's member");
      assert.equal(Number((await one(`SELECT "canAmendShifts"::int v FROM company_memberships WHERE "userId" = $1`, [bControl.id])).v), 0);
      assert.equal((await put(admin.token, control.id, true)).status, 200, 'Admin grants');
      assert.equal(((await api('GET', '/shift-amendments/staff', A.token)).body.staff.find((s: any) => s.userId === control.id)).canAmendShifts, true);
      assert.equal((await put(A.token, control.id, false)).status, 200, 'Owner revokes');
      assert.equal(((await api('GET', '/shift-amendments/staff', admin.token)).body.staff.find((s: any) => s.userId === control.id)).canAmendShifts, false);
    });

    await test('LSA-25-STORED-AMENDMENTS-NEVER-SHOW-A-COMPANY-ANOTHER-COMPANYS-SCHEDULE', async () => {
      const g = await guard('lsa-privacy');
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE') ON CONFLICT DO NOTHING`, [B.id, g.id]);
      const id = await liveShift(g, -2 * HOUR, 2 * HOUR);
      const end = ms((await shiftRow(id)).end);
      // company B: worked 9 h yesterday (7-day hours) and starts again 5 h after A's proposed end (short rest)
      const bPast = Date.now() - 30 * HOUR;
      await q(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Rival Depot',$3,'completed',$4::timestamp,$5::timestamp)`,
        [B.id, B.siteId, g.id, ts(bPast), ts(bPast + 9 * HOUR)]);
      const bNext = end + HOUR + 5 * HOUR;
      await q(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Rival Depot',$3,'ready',$4::timestamp,$5::timestamp)`,
        [B.id, B.siteId, g.id, ts(bNext), ts(bNext + 8 * HOUR)]);
      const leaks = (body: unknown) => {
        const text = JSON.stringify(body);
        for (const leak of [iso(bNext), iso(bNext + 8 * HOUR), iso(bPast), 'Rival Depot']) assert.ok(!text.includes(leak), `no ${leak}`);
      };
      const companyFatigue = (f: any, where: string) => {
        assert.ok(f.warnings.includes('SHORT_REST'), `${where}: the warning stays`);
        assert.equal(f.restHoursBeforeNextShift, null, `${where}: no rest figure from another company`);
        assert.equal(f.restFiguresWithheld, true, `${where}`);
        assert.ok(f.sevenDayScheduledHours < 9, `${where}: this company's 7-day hours only (${f.sevenDayScheduledHours})`);
        assert.equal(f.sevenDayIncludesOtherWork, true, where);
      };

      const p = await propose(A.token, id, end + HOUR);
      assert.equal(p.status, 201, JSON.stringify(p.body));
      assert.equal(p.body.amendment.status, 'awaiting_approval', 'the approval requirement stays');
      assert.equal(p.body.amendment.approvalRequired, true);
      companyFatigue(p.body.amendment.fatigue, 'propose response');
      leaks(p.body);
      const aId = p.body.amendment.id;
      const list = await api('GET', `/shifts/${id}/amendments`, A.token);
      companyFatigue(list.body.amendments[0].fatigue, 'history');
      leaks(list.body);
      const one1 = await api('GET', `/shift-amendments/${aId}`, A.token);
      companyFatigue(one1.body.fatigue, 'single read');
      leaks(one1.body);
      const appr = await api('POST', `/shift-amendments/${aId}/approve`, A.token, { statement: 'Reviewed rest with the Guard', confirmSelfApproval: true });
      assert.equal(appr.status, 200);
      companyFatigue(appr.body.fatigue, 'approve response');

      // the Guard sees their own full figures
      const mine = (await api('GET', '/shift-amendments/mine', g.token)).body.find((a: any) => a.id === aId);
      assert.equal(mine.fatigue.restHoursBeforeNextShift, 5, "the Guard's own rest gap");
      assert.ok(mine.fatigue.sevenDayScheduledHours >= 9, 'and all of their own 7-day hours');
      assert.equal(mine.fatigue.restFiguresWithheld, false);
      assert.equal((await api('GET', `/shift-amendments/${aId}`, g.token)).body.fatigue.restHoursBeforeNextShift, 5);

      // the stored row still holds the full assessment (for the Guard and the audit), plus the company-view facts
      const stored = (await amendmentRow(aId)).fatigueAssessment;
      assert.equal(stored.restHoursBeforeNextShift, 5);
      assert.equal(stored.restFromOwnCompany, false);

      // a refusal over the hard limit carries only company-safe figures (a Guard with past work at B, no next shift)
      const g3 = await guard('lsa-privacy-hard');
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE') ON CONFLICT DO NOTHING`, [B.id, g3.id]);
      await q(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Rival Depot',$3,'completed',$4::timestamp,$5::timestamp)`,
        [B.id, B.siteId, g3.id, ts(bPast), ts(bPast + 9 * HOUR)]);
      const id3 = await liveShift(g3, -2 * HOUR, 2 * HOUR);
      const hard = await propose(A.token, id3, ms((await shiftRow(id3)).end) + 14 * HOUR);
      assert.equal(hard.body.code, 'SHIFT_AMENDMENT_FATIGUE_LIMIT', JSON.stringify(hard.body));
      assert.ok(!('sevenDayScheduledHours' in hard.body.details.assessment), 'no all-company 7-day figure');
      assert.ok(!('restFromOwnCompany' in hard.body.details.assessment));
      assert.equal(hard.body.details.assessment.sevenDayIncludesOtherWork, true);
      // this company's only shift in the window is the one being extended, so its 7-day hours are exactly that shift's
      assert.ok(Math.abs(hard.body.details.assessment.companySevenDayScheduledHours - hard.body.details.assessment.totalScheduledHours) < 0.05,
        `only this company's hours: ${hard.body.details.assessment.companySevenDayScheduledHours} vs ${hard.body.details.assessment.totalScheduledHours}`);
      assert.equal(hard.body.details.assessment.hardLimitExceeded, true, 'the restriction itself is unchanged');
      leaks(hard.body);

      // rows stored before this correction (no recorded owner of the next shift) are withheld from companies
      await q(`UPDATE shift_amendments SET "fatigueAssessment" = "fatigueAssessment" - 'restFromOwnCompany' - 'companySevenDayScheduledHours' WHERE id = $1`, [aId]);
      const legacy = (await api('GET', `/shift-amendments/${aId}`, A.token)).body.fatigue;
      assert.equal(legacy.restHoursBeforeNextShift, null, 'legacy row: rest withheld');
      assert.equal(legacy.sevenDayScheduledHours, null, 'legacy row: 7-day withheld');
      assert.ok(legacy.warnings.includes('SHORT_REST'), 'legacy row: the warning stays');
      assert.equal((await api('GET', `/shift-amendments/${aId}`, g.token)).body.fatigue.restHoursBeforeNextShift, 5, 'the Guard still sees it');

      // the company's own next shift is the company's own schedule: shown
      const g2 = await guard('lsa-privacy-own');
      const id2 = await liveShift(g2, -HOUR, 2 * HOUR);
      const end2 = ms((await shiftRow(id2)).end);
      await q(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Main Site',$3,'ready',$4::timestamp,$5::timestamp)`,
        [A.id, A.siteId, g2.id, ts(end2 + HOUR + 4 * HOUR), ts(end2 + HOUR + 6 * HOUR)]);
      const own = await propose(A.token, id2, end2 + HOUR);
      assert.equal(own.body.amendment.fatigue.restHoursBeforeNextShift, 4);
      assert.equal(own.body.amendment.fatigue.restFiguresWithheld, false);
      assert.equal(own.body.amendment.fatigue.sevenDayIncludesOtherWork, false);
    });

    await test('LSA-18-MISSING-BOOK-OFF-USES-THE-EFFECTIVE-END', async () => {
      const g = await guard('lsa-mbo-extended');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const p = await propose(A.token, id, Date.now() + 4 * HOUR);
      await respond(g, p.body.amendment.id, 'accepted');
      // Move the whole extended shift back in time, as if the extension had been agreed earlier: its ORIGINAL end is now
      // 30 minutes ago (past the 15-minute grace) but its EFFECTIVE end is still 2 hours ahead.
      const now = Date.now();
      await q(`UPDATE shifts SET start = $2::timestamp, "originalEnd" = $3::timestamp, "end" = $4::timestamp WHERE id = $1`,
        [id, ts(now - 3 * HOUR), ts(now - 30 * MIN), ts(now + 2 * HOUR)]);
      const g2 = await guard('lsa-mbo-control');
      const control2 = await liveShift(g2, -HOUR, 2 * HOUR);
      await q(`UPDATE shifts SET start = $2::timestamp, "end" = $3::timestamp WHERE id = $1`, [control2, ts(now - 3 * HOUR), ts(now - 30 * MIN)]);
      await sweep.runMissedWelfareChecks();
      const mbo = async (shiftId: number) => (await q(`SELECT id FROM safety_alerts WHERE "shiftId" = $1 AND type = 'missing_book_off'`, [shiftId])).length;
      assert.equal(await mbo(control2), 1, 'control: an unextended shift past its end + 15 min raises Missing Book Off');
      assert.equal(await mbo(id), 0, 'the extended shift does not: its effective end is still ahead');
    });

    await test('LSA-19-WELFARE-CONTINUES-TO-THE-EFFECTIVE-END-WITHOUT-RENUMBERING', async () => {
      const g = await guard('lsa-welfare');
      const id = await liveShift(g, -HOUR, 2 * HOUR, 60);
      const p = await propose(A.token, id, Date.now() + 4 * HOUR);
      await respond(g, p.body.amendment.id, 'accepted');
      // Shift the extended shift so that windows 0..3 have closed: original end after window 1, effective end ahead.
      const now = Date.now();
      const start = now - 4 * HOUR - 30 * MIN;
      await q(`UPDATE shifts SET start = $2::timestamp, "originalEnd" = $3::timestamp, "end" = $4::timestamp WHERE id = $1`,
        [id, ts(start), ts(start + 2 * HOUR), ts(now + 2 * HOUR)]);
      await q(`UPDATE attendance_events SET "occurredAt" = $2::timestamp WHERE "shiftId" = $1`, [id, ts(start + MIN)]);
      // A Welfare Check in window 0; window 1 already recorded as missed by an earlier sweep (evidence that must survive).
      await q(`INSERT INTO daily_logs ("companyId","guardId","shiftId",message,"logType","createdAt") VALUES ($1,$2,$3,'All quiet','welfare_check',$4::timestamp)`,
        [A.id, g.id, id, ts(start + 30 * MIN)]);
      const existing = (await one(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message,"welfareWindowIndex") VALUES ($1,$2,$3,'missed_checkcall','high','closed','window 1 missed',1) RETURNING id`,
        [A.id, g.id, id])).id;
      const existingBefore = await one(`SELECT row_to_json(a)::text j FROM safety_alerts a WHERE id = $1`, [existing]);
      await sweep.runMissedWelfareChecks();
      await sweep.runMissedWelfareChecks();
      const windows = (await q(`SELECT "welfareWindowIndex" w FROM safety_alerts WHERE "shiftId" = $1 AND "welfareWindowIndex" IS NOT NULL ORDER BY 1`, [id]))
        .map((r: any) => Number(r.w));
      assert.ok(windows.includes(2) && windows.includes(3), `windows after the original end are still owed and recorded (got ${windows})`);
      assert.ok(!windows.includes(0), 'the window with a Welfare Check is not missed');
      assert.equal(windows.filter((w) => w === 1).length, 1, 'the existing window-1 record is not duplicated');
      assert.deepEqual(new Set(windows).size, windows.length, 'no duplicate window records');
      assert.equal((await one(`SELECT row_to_json(a)::text j FROM safety_alerts a WHERE id = $1`, [existing])).j, existingBefore.j, 'and is byte-identical');
    });

    await test('LSA-20-OVERNIGHT-AND-BST-TO-GMT-ARE-INSTANT-BASED', () => {
      // 24 Oct 2026 23:00Z = 00:00 BST on the 25th; 25 Oct 07:00Z = 07:00 GMT: 7 wall-clock hours, 8 real hours.
      const startMs = Date.parse('2026-10-24T23:00:00Z');
      const originalEnd = Date.parse('2026-10-25T05:00:00Z');
      const extended = Date.parse('2026-10-25T07:00:00Z');
      const a = assessFatigue({ startMs, currentEndMs: originalEnd, proposedEndMs: extended, nowMs: startMs + HOUR,
        nextShiftStartMs: null, sevenDayScheduledHours: 8, policy: DEFAULT_SHIFT_POLICY });
      assert.equal(a.totalScheduledHours, 8, 'scheduled hours are real elapsed hours across the clock change');
      const engine = new OperationalWindowService();
      const before = engine.windowsFor({ anchor: new Date(startMs), notAfter: new Date(originalEnd), intervalMinutes: 60 } as any);
      const after = engine.windowsFor({ anchor: new Date(startMs), notAfter: new Date(extended), intervalMinutes: 60 } as any);
      assert.equal(before.length, 6);
      assert.equal(after.length, 8, 'the extension adds windows at the end');
      for (const w of before) {
        const same = after[w.index];
        assert.equal(same.start.getTime(), w.start.getTime(), `window ${w.index} keeps its index and span`);
        assert.equal(same.end.getTime(), w.end.getTime());
      }
      assert.ok(after.every((w, i) => i === 0 || w.start.getTime() - after[i - 1].start.getTime() === HOUR), 'hourly by instant through the change');
    });

    await test('LSA-21-OLD-APPS-SEE-NOTHING-NEW-UNTIL-THE-EXTENDED-END', async () => {
      const g = await guard('lsa-oldapp');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const mine = async () => {
        const r = await api('GET', '/shifts/my', g.token);
        assert.equal(r.status, 200);
        const list = (Array.isArray(r.body) ? r.body : r.body?.shifts ?? []) as any[];
        return list.map((x) => x.shift ?? x).find((s) => s.id === id);
      };
      const before = await mine();
      const p = await propose(A.token, id, ms(before.end) + HOUR);
      const pending = await mine();
      assert.equal(pending.status, 'in_progress', 'a pending request never changes the status the old apps read');
      assert.equal(ms(pending.end), ms(before.end));
      await respond(g, p.body.amendment.id, 'accepted');
      const after = await mine();
      assert.equal(ms(after.end), ms(before.end) + HOUR, 'after acceptance the extended end shows on refresh');
      const missing = Object.keys(before).filter((k) => !(k in after));
      assert.deepEqual(missing, [], 'every field the old apps already read is still present');
    });

    await test('LSA-22-NO-AMENDMENT-STATE-CHANGES-WHILE-DISABLED', async () => {
      // Amendments in every actionable state, made while enabled …
      const mk = async (label: string) => {
        const g = await guard(label);
        const id = await liveShift(g, -HOUR, 2 * HOUR);
        return { g, id, end: ms((await shiftRow(id)).end) };
      };
      const p = await mk('lsa-off-pending');
      const pending = (await propose(A.token, p.id, p.end + HOUR)).body.amendment.id;
      const w = await mk('lsa-off-approval');
      const awaiting = (await propose(A.token, w.id, Date.now() + 14.5 * HOUR)).body.amendment.id;
      const v = await mk('lsa-off-verbal');
      const verbal = (await propose(A.token, v.id, v.end + HOUR)).body.amendment.id;
      const verbalBody = (end: number) => ({ agreedEnd: iso(end), contactMethod: 'telephone', contactAt: iso(Date.now()), confirmation: 'Phoned the Guard, who agreed to stay.', reason: 'Cover' });
      assert.equal((await api('POST', `/shift-amendments/${verbal}/record-verbal-agreement`, A.token, verbalBody(v.end + HOUR))).status, 200);
      const d = await mk('lsa-off-disputed');
      const disputed = (await propose(A.token, d.id, d.end + HOUR)).body.amendment.id;
      await api('POST', `/shift-amendments/${disputed}/record-verbal-agreement`, A.token, verbalBody(d.end + HOUR));
      assert.equal((await api('POST', `/shift-amendments/${disputed}/dispute`, d.g.token, { reason: 'I did not agree' })).status, 200);
      const n = await mk('lsa-off-new');
      const snapshot = async () => ({
        amendments: await q(`SELECT id, status, "updatedAt" FROM shift_amendments WHERE id = ANY($1::int[]) ORDER BY id`, [[pending, awaiting, verbal, disputed]]),
        shifts: await q(`SELECT id, status, "end", "originalEnd" FROM shifts WHERE id = ANY($1::int[]) ORDER BY id`, [[p.id, w.id, v.id, d.id, n.id]]),
        audit: Number((await one(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'shift_amendment'`)).n),
      });
      // … then S4 switches the company off.
      assert.equal((await api('PUT', `/admin/shift-amendments/companies/${A.id}`, adminToken, { enabled: false })).status, 200);
      const before = await snapshot();
      const calls: Array<[string, Promise<Res>]> = [
        ['propose', propose(A.token, n.id, n.end + HOUR)],
        ['approve', api('POST', `/shift-amendments/${awaiting}/approve`, A.token, { statement: 'Approved while disabled', confirmSelfApproval: true })],
        ['withdraw', api('POST', `/shift-amendments/${pending}/withdraw`, A.token, {})],
        ['accept', respond(p.g, pending, 'accepted')],
        ['decline', respond(p.g, pending, 'declined')],
        ['record verbal agreement', api('POST', `/shift-amendments/${pending}/record-verbal-agreement`, ops.token, verbalBody(p.end + HOUR))],
        ['dispute', api('POST', `/shift-amendments/${verbal}/dispute`, v.g.token, { reason: 'I did not agree' })],
        ['resolve dispute', api('POST', `/shift-amendments/${disputed}/resolve-dispute`, A.token, { resolution: 'upheld', note: 'Upheld while disabled' })],
      ];
      for (const [label, call] of calls) {
        const r = await call;
        assert.equal(r.status, 403, `${label}: ${r.status} ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, 'SHIFT_AMENDMENTS_DISABLED', label);
      }
      assert.deepEqual(await snapshot(), before, 'no amendment, shift or audit entry changed');
      assert.equal((await api('GET', `/shifts/${p.id}/amendments`, A.token)).status, 200, 'the history stays readable');
      // Switching back on restores normal behaviour.
      assert.equal((await api('PUT', `/admin/shift-amendments/companies/${A.id}`, adminToken, { enabled: true })).status, 200);
      assert.equal((await respond(p.g, pending, 'accepted')).status, 200);
    });

    // ════════════════ deterministic races ════════════════

    await test('LSA-R1-ACCEPT-VS-BOOK-OFF-BOTH-ORDERS', async () => {
      // Accept first: the shift is extended, then the Book Off completes it; nothing is voided.
      const g = await guard('lsa-r1a');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const end = ms((await shiftRow(id)).end);
      const p = await propose(A.token, id, end + HOUR);
      let lock = await holdRow(id);
      const acc = respond(g, p.body.amendment.id, 'accepted');
      await untilWaiting(1, 'R1a accept');
      const off = api('POST', '/attendance/check-out', g.token, { shiftId: id });
      await untilWaiting(2, 'R1a Book Off');
      await lock.release();
      const [a1, o1] = await Promise.all([acc, off]);
      assert.equal(a1.status, 200, `accept: ${a1.status} ${JSON.stringify(a1.body)}`);
      assert.equal(o1.status, 201, `Book Off: ${o1.status} ${JSON.stringify(o1.body)}`);
      assert.equal((await shiftRow(id)).status, 'completed');
      assert.equal(ms((await shiftRow(id)).end), end + HOUR);
      assert.equal((await amendmentRow(p.body.amendment.id)).status, 'accepted');
      // Book Off first: the proposal is voided and the acceptance refused; the shift is not extended.
      const g2 = await guard('lsa-r1b');
      const id2 = await liveShift(g2, -HOUR, 2 * HOUR);
      const end2 = ms((await shiftRow(id2)).end);
      const p2 = await propose(A.token, id2, end2 + HOUR);
      lock = await holdRow(id2);
      const off2 = api('POST', '/attendance/check-out', g2.token, { shiftId: id2 });
      await untilWaiting(1, 'R1b Book Off');
      const acc2 = respond(g2, p2.body.amendment.id, 'accepted');
      await untilWaiting(2, 'R1b accept');
      await lock.release();
      const [o2, a2] = await Promise.all([off2, acc2]);
      assert.equal(o2.status, 201);
      assert.equal(a2.status >= 400 && a2.status < 500, true, `accept refused: ${a2.status} ${JSON.stringify(a2.body)}`);
      assert.ok(['SHIFT_AMENDMENT_NOT_OPEN', 'SHIFT_AMENDMENT_NOT_LIVE'].includes(a2.body.code));
      assert.equal((await amendmentRow(p2.body.amendment.id)).status, 'voided');
      assert.equal(ms((await shiftRow(id2)).end), end2, 'not extended');
      assert.equal((await q(`SELECT 1 FROM attendance_events WHERE "shiftId" = $1`, [id2])).length, 2, 'Book On + Book Off only');
    });

    await test('LSA-R2-ACCEPT-VS-WITHDRAW-BOTH-ORDERS', async () => {
      const g = await guard('lsa-r2a');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const end = ms((await shiftRow(id)).end);
      const p = await propose(A.token, id, end + HOUR);
      let lock = await holdRow(id);
      const acc = respond(g, p.body.amendment.id, 'accepted');
      await untilWaiting(1, 'R2a accept');
      const wd = api('POST', `/shift-amendments/${p.body.amendment.id}/withdraw`, A.token, {});
      await untilWaiting(2, 'R2a withdraw');
      await lock.release();
      const [a1, w1] = await Promise.all([acc, wd]);
      assert.equal(a1.status, 200);
      assert.equal(w1.status, 409);
      assert.equal(w1.body.code, 'SHIFT_AMENDMENT_ALREADY_ANSWERED');
      assert.equal(ms((await shiftRow(id)).end), end + HOUR);
      const g2 = await guard('lsa-r2b');
      const id2 = await liveShift(g2, -HOUR, 2 * HOUR);
      const end2 = ms((await shiftRow(id2)).end);
      const p2 = await propose(A.token, id2, end2 + HOUR);
      lock = await holdRow(id2);
      const wd2 = api('POST', `/shift-amendments/${p2.body.amendment.id}/withdraw`, A.token, {});
      await untilWaiting(1, 'R2b withdraw');
      const acc2 = respond(g2, p2.body.amendment.id, 'accepted');
      await untilWaiting(2, 'R2b accept');
      await lock.release();
      const [w2, a2] = await Promise.all([wd2, acc2]);
      assert.equal(w2.status, 200);
      assert.equal(a2.status, 409);
      assert.equal(a2.body.code, 'SHIFT_AMENDMENT_NOT_OPEN');
      assert.equal(ms((await shiftRow(id2)).end), end2);
    });

    await test('LSA-R3-TWO-SIMULTANEOUS-PROPOSALS-EXACTLY-ONE', async () => {
      const g = await guard('lsa-r3');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const end = ms((await shiftRow(id)).end);
      const lock = await holdRow(id);
      const first = propose(A.token, id, end + HOUR, 'first');
      await untilWaiting(1, 'R3 first');
      const second = propose(ops.token, id, end + 2 * HOUR, 'second');
      await untilWaiting(2, 'R3 second');
      await lock.release();
      const results = await Promise.all([first, second]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], JSON.stringify(results.map((r) => r.body)));
      assert.equal(results.find((r) => r.status === 409)!.body.code, 'SHIFT_AMENDMENT_PENDING');
      assert.equal((await q(`SELECT 1 FROM shift_amendments WHERE "shiftId" = $1`, [id])).length, 1);
    });

    await test('LSA-R4-ACCEPT-VS-WELFARE-SWEEP-INSERT-NO-DEADLOCK', async () => {
      const { WELFARE_SWEEP_LOCK_NAMESPACE } = await import('../src/operations/advisory-locks');
      const g = await guard('lsa-r4');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const end = ms((await shiftRow(id)).end);
      const p = await propose(A.token, id, end + HOUR);
      // The sweep holds its per-shift lock (as recordWelfareMiss does) while the acceptance arrives.
      const sweepTx = await hold('SELECT pg_advisory_xact_lock($1, $2)', [WELFARE_SWEEP_LOCK_NAMESPACE, id]);
      const acc = respond(g, p.body.amendment.id, 'accepted');
      await untilWaiting(1, 'R4 accept waits for the sweep lock while holding the shift row');
      // The sweep now inserts an alert referencing the shift (FOR KEY SHARE): with FOR NO KEY UPDATE it is not blocked.
      await sweepTx.runner.query(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message) VALUES ($1,$2,$3,'other','high','open','sweep insert during acceptance')`,
        [A.id, g.id, id]);
      await sweepTx.release();
      const a = await acc;
      assert.equal(a.status, 200, `both commit, no deadlock: ${a.status} ${JSON.stringify(a.body)}`);
      assert.equal(ms((await shiftRow(id)).end), end + HOUR);
      assert.equal((await q(`SELECT 1 FROM safety_alerts WHERE "shiftId" = $1 AND message = 'sweep insert during acceptance'`, [id])).length, 1);
    });

    await test('LSA-R5-ACCEPT-VS-ROTA-ASSIGNMENT-OF-THE-SAME-GUARD-BOTH-ORDERS', async () => {
      const slotFor = async (startMs: number) => {
        const slot = (await one(`INSERT INTO rota_slots ("companyId","siteId","startAt","endAt","requiredGuardCount") VALUES ($1,$2,$3::timestamp,$4::timestamp,1) RETURNING id`,
          [A.id, A.siteId, ts(startMs), ts(startMs + 4 * HOUR)])).id;
        const pos = (await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end","rotaSlotId") VALUES ($1,$2,'Main Site',null,'unfilled',$3::timestamp,$4::timestamp,$5) RETURNING id`,
          [A.id, A.siteId, ts(startMs), ts(startMs + 4 * HOUR), slot])).id;
        return { slot, pos };
      };
      const committed = async (guardId: number) =>
        Number((await one(`SELECT count(*) n FROM shifts a JOIN shifts b ON a."guardId" = b."guardId" AND a.id < b.id AND a.start < b."end" AND a."end" > b.start
          WHERE a."guardId" = $1 AND a.status IN ('scheduled','offered','ready','in_progress') AND b.status IN ('scheduled','offered','ready','in_progress')`, [guardId])).n);
      // Accept first: the rota assignment into the extended window is then refused.
      const g = await guard('lsa-r5a');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const end = ms((await shiftRow(id)).end);
      const p = await propose(A.token, id, end + 2 * HOUR);
      const r1 = await slotFor(end + HOUR);
      let lock = await holdRow(id);
      const acc = respond(g, p.body.amendment.id, 'accepted');
      await untilWaiting(1, 'R5a accept');
      const asg = api('POST', `/rota-slots/${r1.slot}/assign`, A.token, { shiftId: r1.pos, guardId: g.id });
      await untilWaiting(2, 'R5a assign');
      await lock.release();
      const [a1, s1] = await Promise.all([acc, asg]);
      assert.equal(a1.status, 200);
      assert.equal(s1.status, 403, `assignment refused: ${s1.status} ${JSON.stringify(s1.body)}`);
      assert.equal(await committed(g.id), 0, 'never double-booked');
      // Assignment first: the acceptance is then refused as a clash, and the shift is not extended.
      const g2 = await guard('lsa-r5b');
      const id2 = await liveShift(g2, -HOUR, 2 * HOUR);
      const end2 = ms((await shiftRow(id2)).end);
      const p2 = await propose(A.token, id2, end2 + 2 * HOUR);
      const r2 = await slotFor(end2 + HOUR);
      lock = await hold('SELECT pg_advisory_xact_lock($1, $2)', [534_401_402, g2.id]);
      const asg2 = api('POST', `/rota-slots/${r2.slot}/assign`, A.token, { shiftId: r2.pos, guardId: g2.id });
      await untilWaiting(1, 'R5b assign');
      const acc2 = respond(g2, p2.body.amendment.id, 'accepted');
      await untilWaiting(2, 'R5b accept');
      await lock.release();
      const [s2, a2] = await Promise.all([asg2, acc2]);
      assert.ok(s2.status < 300, `assignment: ${s2.status} ${JSON.stringify(s2.body)}`);
      assert.equal(a2.status, 409, `accept: ${a2.status} ${JSON.stringify(a2.body)}`);
      assert.equal(a2.body.code, 'SHIFT_AMENDMENT_CLASH');
      assert.equal(ms((await shiftRow(id2)).end), end2, 'not extended');
      assert.equal((await amendmentRow(p2.body.amendment.id)).status, 'pending', 'the request stays open for the company to resolve');
      assert.equal(await committed(g2.id), 0, 'never double-booked');
    });

    await test('LSA-R6-A-LONG-LOCK-IS-A-RETRYABLE-BUSY', async () => {
      const g = await guard('lsa-r6');
      const id = await liveShift(g, -HOUR, 2 * HOUR);
      const end = ms((await shiftRow(id)).end);
      const lock = await holdRow(id);
      const started = Date.now();
      const r = await propose(A.token, id, end + HOUR);
      const waited = Date.now() - started;
      await lock.release();
      assert.equal(r.status, 409, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'SHIFT_AMENDMENT_BUSY');
      assert.ok(waited >= 4_500 && waited < 15_000, `bounded wait (${waited} ms)`);
      assert.equal((await propose(A.token, id, end + HOUR)).status, 201, 'the retry succeeds');
    });
  } finally {
    await app.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
