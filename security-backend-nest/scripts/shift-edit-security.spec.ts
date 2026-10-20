/**
 * Shift editing security: PATCH /shifts/:id and DELETE /shifts/:id. (Security P0, owner-approved 20 Oct 2026.)
 *
 * THE DEFECTS THIS EXISTS TO PREVENT
 * PATCH /shifts/:id validated only that end followed start. It would rewrite the scheduled times, site and
 * welfare interval of an in-progress, completed or missed shift — the frame every welfare window, Live
 * Operations row and export is graded against — with no audit entry. It let a company accept or decline an
 * offer on the Guard's behalf (offered → ready / rejected), start a shift with no Book On (ready →
 * in_progress, so no attendance exists for the work), and mark a shift missed before it had even started.
 * No edit was audited. DELETE /shifts/:id hard-deleted any shift in any status, and the database cascades
 * that to its attendance events and Welfare Check logs; it checked only shifts.view. A platform administrator
 * could edit or delete any company's shift without any company permission.
 *
 * Reacceptance after a material change, availability at edit time, the Guard's notice and rota-position
 * rules are the Workflow P1 release; SES-11, SES-14 and SES-16 pin today's behaviour until then.
 *
 * Every test runs over real HTTP with real authorisation, against a disposable local database built from
 * the repository's own migrations.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { complianceToday } from '../src/compliance/compliance-dates';

const url = process.env.SHIFT_EDIT_SECURITY_DATABASE_URL;
if (!url) throw new Error('SHIFT_EDIT_SECURITY_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Shift edit security database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'shift-edit-security-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

let passed = 0;
const failures: string[] = [];
const test = async (id: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failures.push(id);
    console.log(`FAIL  ${id}\n      ${String((error as Error)?.message ?? error).split('\n').join('\n      ')}`);
  }
};

type Res = { status: number; body: any };
const HOUR = 3_600_000;
const MIN = 60_000;
const PASSWORD = 'shift-edit-spec-only-password-1';
const ukDay = (n: number) => {
  const [y, m, d] = complianceToday().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const iso = (ms: number) => new Date(ms).toISOString();

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
    const { AuthService } = await import('../src/auth/auth.service');
    const auth = app.get(AuthService);
    const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;

    const company = async (label: string, number: string) => {
      const ownerEmail = `${label}.owner@example.invalid`;
      const ownerId = await user(ownerEmail, 'company_admin');
      const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,$2,$3,'1 Way','ops@example.invalid') RETURNING id`, [ownerId, `${label} Security Ltd`, number]);
      const siteId = (await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'Main Site','2 Way') RETURNING id`, [id])).id as number;
      const site2Id = (await one(`INSERT INTO sites ("companyId",name,address) VALUES ($1,'Second Site','3 Way') RETURNING id`, [id])).id as number;
      return { id: id as number, ownerId, siteId, site2Id, token: await login(ownerEmail) };
    };
    const A = await company('sesalpha', '71111111');
    const B = await company('sesbeta', '72222222');

    let n = 0;
    const guard = async (label: string) => {
      n += 1;
      const email = `${label}@example.invalid`;
      const userId = await user(email, 'guard');
      const licence = `80000000000000${String(n).padStart(2, '0')}`;
      const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","siaExpiryDate","rightToWorkStatus",phone) VALUES ($1,$2,$3,$4,'british','07000000000') RETURNING id`,
        [userId, `${label} Guard`, licence, ukDay(500)]);
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [A.id, id]);
      for (const type of ['sia_licence', 'right_to_work']) {
        await q(`INSERT INTO guard_documents ("guardId","companyId",type,"storageProvider","storageKey","originalFileName","mimeType","sizeBytes","uploadCompletedAt",verified,"uploadedByUserId","verifiedByUserId","verifiedAt")
          VALUES ($1,$2,$3,'s3-compatible',$4,'e.pdf','application/pdf','1024',now(),true,null,null,now())`, [id, A.id, type, `ses/${A.id}/${id}/${type}`]);
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
    const g = await guard('ses-one');
    const g2 = await guard('ses-two');

    // A company_admin account whose ACTIVE membership is only viewer: it may see shifts, never manage them.
    const viewerEmail = 'sesalpha.viewer@example.invalid';
    const viewerId = await user(viewerEmail, 'company_admin');
    await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,'viewer','active')`, [viewerId, A.id]);
    const viewerToken = await login(viewerEmail);

    /** A shift row in company A. Times in ms from now. */
    const shift = async (status: string, startIn: number, hours: number, opts: { guardId?: number | null; rotaSlotId?: number | null } = {}) => {
      const start = Date.now() + startIn;
      const guardId = opts.guardId === undefined ? g.id : opts.guardId;
      const { id } = await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end","checkCallIntervalMinutes","rotaSlotId") VALUES ($1,$2,'Main Site',$3,$4,$5,$6,60,$7) RETURNING id`,
        [A.id, A.siteId, guardId, status, new Date(start), new Date(start + hours * HOUR), opts.rotaSlotId ?? null]);
      return id as number;
    };
    const row = (id: number) => one(`SELECT status, "guardId", "siteId", "checkCallIntervalMinutes" iv, start, "end", "closeOutNotes" notes FROM shifts WHERE id = $1`, [id]);
    const evidence = async (id: number) => ({
      attendance: Number((await one(`SELECT count(*) n FROM attendance_events WHERE "shiftId" = $1`, [id])).n),
      logs: Number((await one(`SELECT count(*) n FROM daily_logs WHERE "shiftId" = $1`, [id])).n),
    });
    const audits = (id: number, action: string) => q(`SELECT "beforeData" b, "afterData" a, "userId" u FROM audit_logs WHERE "entityType"='shift' AND "entityId"=$1 AND action=$2 ORDER BY id`, [id, action]);

    /** A completed shift with genuine evidence: Book On, a Welfare Check, Book Off — all through the real API. */
    const completedWithEvidence = async () => {
      const id = await shift('ready', -2 * HOUR, 8);
      assert.equal((await api('POST', '/attendance/check-in', g.token, { shiftId: id })).status, 201, 'book on');
      const log = await api('POST', '/daily-logs', g.token, { shiftId: id, message: 'All quiet', logType: 'welfare_check' });
      assert.ok(log.status === 201, `welfare check: ${log.status} ${JSON.stringify(log.body)}`);
      assert.equal((await api('POST', '/attendance/check-out', g.token, { shiftId: id })).status, 201, 'book off');
      assert.equal((await row(id)).status, 'completed');
      return id;
    };

    // ════════════════ history cannot be deleted ════════════════

    await test('SES-01-A-COMPLETED-SHIFT-WITH-ATTENDANCE-CANNOT-BE-DELETED', async () => {
      const id = await completedWithEvidence();
      const before = await evidence(id);
      assert.ok(before.attendance === 2 && before.logs >= 1, 'evidence exists');
      const r = await api('DELETE', `/shifts/${id}`, A.token);
      assert.equal(r.status, 409, `delete must be refused, got ${r.status}`);
      assert.deepEqual(await evidence(id), before, 'Book On, Book Off and the Welfare Check must survive');
      assert.ok(await row(id), 'the shift itself must survive');
    });

    await test('SES-02-DELETE-NEEDS-SHIFTS-MANAGE-NOT-JUST-VIEW', async () => {
      const id = await shift('unfilled', 24 * HOUR, 8, { guardId: null });
      const r = await api('DELETE', `/shifts/${id}`, viewerToken);
      assert.equal(r.status, 403, `a viewer must not delete, got ${r.status}`);
      assert.ok(await row(id));
    });

    await test('SES-03-A-NEVER-WORKED-SHIFT-CAN-STILL-BE-DELETED-AND-IT-IS-AUDITED', async () => {
      const id = await shift('offered', 24 * HOUR, 8);
      const r = await api('DELETE', `/shifts/${id}`, A.token);
      assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(await row(id), undefined);
      const [entry] = await audits(id, 'shift.deleted');
      assert.ok(entry, 'deletion is audited');
      assert.equal(entry.b.status, 'offered');
      assert.equal(entry.b.guardId, g.id);
    });

    await test('SES-04-STARTED-MISSED-REJECTED-AND-ROTA-SHIFTS-CANNOT-BE-DELETED', async () => {
      const slot = (await one(`INSERT INTO rota_slots ("companyId","siteId","startAt","endAt","requiredGuardCount") VALUES ($1,$2,$3,$4,1) RETURNING id`,
        [A.id, A.siteId, new Date(Date.now() + 30 * HOUR), new Date(Date.now() + 38 * HOUR)])).id;
      for (const id of [
        await shift('in_progress', -HOUR, 8),
        await shift('missed', -3 * HOUR, 8),
        await shift('rejected', 24 * HOUR, 8),
        await shift('unfilled', 30 * HOUR, 8, { guardId: null, rotaSlotId: slot }),
      ]) {
        const r = await api('DELETE', `/shifts/${id}`, A.token);
        assert.equal(r.status, 409, `shift ${id} (${(await row(id)).status}): ${r.status}`);
      }
    });

    // ════════════════ started and finished shifts are not edited ════════════════

    await test('SES-05-A-COMPLETED-SHIFT-SCHEDULE-SITE-AND-INTERVAL-CANNOT-BE-REWRITTEN', async () => {
      const id = await completedWithEvidence();
      const before = await row(id);
      for (const body of [
        { start: iso(Date.now() - 5 * HOUR), end: iso(Date.now() + 5 * HOUR) },
        { end: iso(Date.now() + 9 * HOUR) },
        { siteId: A.site2Id },
        { checkCallIntervalMinutes: 15 },
      ]) {
        const r = await api('PATCH', `/shifts/${id}`, A.token, body);
        assert.equal(r.status, 409, `${JSON.stringify(body)} must be refused, got ${r.status}`);
      }
      assert.deepEqual(await row(id), before, 'nothing about the completed shift changed');
    });

    await test('SES-06-AN-IN-PROGRESS-SHIFT-KEEPS-ITS-SCHEDULE-BUT-NOTES-STILL-SAVE', async () => {
      const id = await shift('ready', -HOUR, 8);
      assert.equal((await api('POST', '/attendance/check-in', g.token, { shiftId: id })).status, 201);
      const before = await row(id);
      const r = await api('PATCH', `/shifts/${id}`, A.token, { start: iso(Date.now() - 30 * MIN) });
      assert.equal(r.status, 409, `moving a live shift's start must be refused, got ${r.status}`);
      assert.equal((await row(id)).start.getTime(), before.start.getTime());
      const notes = await api('PATCH', `/shifts/${id}`, A.token, { closeOutNotes: 'Handover to day team.' });
      assert.equal(notes.status, 200, `close-out notes stay editable: ${notes.status}`);
      const instr = await api('PATCH', `/shifts/${id}`, A.token, { instructions: 'Check gate 3 hourly.' });
      assert.equal(instr.status, 200, `instructions stay editable: ${instr.status}`);
      const [entry] = await audits(id, 'shift.updated');
      assert.ok(entry && entry.a.closeOutNotes === 'Handover to day team.', 'and the note change is audited');
    });

    await test('SES-07-MISSED-AND-CANCELLED-SHIFTS-KEEP-THEIR-SCHEDULE', async () => {
      for (const status of ['missed', 'cancelled', 'rejected']) {
        const id = await shift(status, -3 * HOUR, 8);
        const r = await api('PATCH', `/shifts/${id}`, A.token, { end: iso(Date.now() + 9 * HOUR) });
        assert.equal(r.status, 409, `${status}: ${r.status}`);
      }
    });

    // ════════════════ the company cannot act as the Guard or as the attendance record ════════════════

    await test('SES-08-THE-COMPANY-CANNOT-ACCEPT-OR-DECLINE-ON-THE-GUARDS-BEHALF', async () => {
      for (const status of ['ready', 'accepted', 'rejected']) {
        const id = await shift('offered', 24 * HOUR, 8);
        const r = await api('PATCH', `/shifts/${id}`, A.token, { status });
        assert.equal(r.status, 409, `offered → ${status} by the company must be refused, got ${r.status}`);
        assert.equal((await row(id)).status, 'offered');
      }
    });

    await test('SES-09-A-SHIFT-STARTS-BY-BOOK-ON-NOT-BY-EDITING-IT', async () => {
      const id = await shift('ready', -10 * MIN, 8);
      const r = await api('PATCH', `/shifts/${id}`, A.token, { status: 'in_progress' });
      assert.equal(r.status, 409, `ready → in_progress by the company must be refused, got ${r.status}`);
      assert.equal((await row(id)).status, 'ready');
      assert.equal((await evidence(id)).attendance, 0);
    });

    await test('SES-10-MISSED-ONLY-AFTER-THE-GRACE-AND-WITHOUT-A-BOOK-ON', async () => {
      const early = await shift('ready', 2 * HOUR, 8);
      assert.equal((await api('PATCH', `/shifts/${early}`, A.token, { status: 'missed' })).status, 409, 'not before the shift has started');
      const justStarted = await shift('ready', -5 * MIN, 8);
      assert.equal((await api('PATCH', `/shifts/${justStarted}`, A.token, { status: 'missed' })).status, 409, 'not inside the 15-minute grace');
      const noShow = await shift('ready', -20 * MIN, 8);
      const r = await api('PATCH', `/shifts/${noShow}`, A.token, { status: 'missed' });
      assert.equal(r.status, 200, `the Live Operations no-show rule still works: ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal((await row(noShow)).status, 'missed');
      assert.ok((await audits(noShow, 'shift.updated')).length === 1, 'and is audited');
    });

    // ════════════════ a future shift stays editable, and every edit is audited ════════════════
    // Security P0 keeps today's offer and acceptance behaviour for future shifts. Returning an accepted shift
    // to the Guard after a material change (reacceptance), with an availability check and a notice, is the
    // Workflow P1 release; until then the change is at least on the record.

    await test('SES-11-RETIMING-A-FUTURE-ACCEPTED-SHIFT-IS-ALLOWED-AND-AUDITED', async () => {
      const id = await shift('ready', 300 * HOUR, 8);
      const before = await row(id);
      const newStart = Date.now() + 301 * HOUR;
      const r = await api('PATCH', `/shifts/${id}`, A.token, { start: iso(newStart), end: iso(newStart + 8 * HOUR) });
      assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal((await row(id)).status, 'ready', 'acceptance behaviour is unchanged in the security release');
      const [entry] = await audits(id, 'shift.updated');
      assert.ok(entry, 'the change is audited');
      assert.equal(new Date(entry.b.start).getTime(), before.start.getTime());
      assert.equal(new Date(entry.a.start).getTime(), newStart);
      assert.equal(entry.u, A.ownerId, 'by the manager who made it');
      assert.equal(entry.b.status, undefined, 'only changed fields are recorded');
    });

    await test('SES-12-MOVING-A-FUTURE-SHIFT-TO-ANOTHER-SITE-IS-AUDITED', async () => {
      const id = await shift('ready', 24 * HOUR, 8);
      const r = await api('PATCH', `/shifts/${id}`, A.token, { siteId: A.site2Id });
      assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
      const [entry] = await audits(id, 'shift.updated');
      assert.equal(entry.b.siteId, A.siteId);
      assert.equal(entry.a.siteId, A.site2Id);
    });

    await test('SES-13-INSTRUCTIONS-ON-AN-ACCEPTED-SHIFT-DO-NOT-UNACCEPT-IT', async () => {
      const id = await shift('ready', 24 * HOUR, 8);
      assert.equal((await api('PATCH', `/shifts/${id}`, A.token, { instructions: 'Bring a torch.' })).status, 200);
      assert.equal((await row(id)).status, 'ready');
    });

    await test('SES-14-AN-OFFERED-SHIFT-CAN-BE-RETIMED-AND-STAYS-OFFERED', async () => {
      const id = await shift('offered', 24 * HOUR, 8);
      const r = await api('PATCH', `/shifts/${id}`, A.token, { end: iso(Date.now() + 33 * HOUR) });
      assert.equal(r.status, 200);
      assert.equal((await row(id)).status, 'offered');
      assert.equal((await audits(id, 'shift.updated')).length, 1);
    });

    await test('SES-15-A-PLATFORM-ADMINISTRATOR-CANNOT-EDIT-OR-DELETE-A-COMPANY-SHIFT', async () => {
      const adminEmail = 'ses.platform.admin@example.invalid';
      await user(adminEmail, 'admin');
      const adminToken = await login(adminEmail);
      const id = await shift('offered', 24 * HOUR, 8);
      const before = await row(id);
      assert.equal((await api('PATCH', `/shifts/${id}`, adminToken, { instructions: 'x' })).status, 403, 'edit');
      assert.equal((await api('PATCH', `/shifts/${id}`, adminToken, { status: 'cancelled' })).status, 403, 'status change');
      assert.equal((await api('DELETE', `/shifts/${id}`, adminToken)).status, 403, 'delete');
      assert.deepEqual(await row(id), before);
    });

    await test('SES-16-THE-ROTA-SLOT-TIME-CHANGE-IS-UNCHANGED-IN-THE-SECURITY-RELEASE', async () => {
      const startAt = Date.now() + 72 * HOUR;
      const slot = (await one(`INSERT INTO rota_slots ("companyId","siteId","startAt","endAt","requiredGuardCount") VALUES ($1,$2,$3,$4,1) RETURNING id`,
        [A.id, A.siteId, new Date(startAt), new Date(startAt + 8 * HOUR)])).id;
      const accepted = await shift('ready', 72 * HOUR, 8, { rotaSlotId: slot });
      const r = await api('PATCH', `/rota-slots/${slot}/time`, A.token, { startAt: iso(startAt + HOUR), endAt: iso(startAt + 9 * HOUR) });
      assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal((await row(accepted)).start.getTime(), startAt + HOUR, 'the position moves with its slot');
      assert.equal((await row(accepted)).status, 'ready');
    });

    // ════════════════ tenant isolation and the existing workflows ════════════════

    await test('SES-17-ANOTHER-COMPANY-CANNOT-SEE-EDIT-OR-DELETE-THE-SHIFT', async () => {
      const id = await shift('offered', 24 * HOUR, 8);
      assert.equal((await api('PATCH', `/shifts/${id}`, B.token, { instructions: 'x' })).status, 404);
      assert.equal((await api('DELETE', `/shifts/${id}`, B.token)).status, 404);
      assert.equal((await row(id)).status, 'offered');
    });

    await test('SES-18-GUARDS-AND-VIEWERS-CANNOT-EDIT-SHIFTS', async () => {
      const id = await shift('offered', 24 * HOUR, 8);
      assert.equal((await api('PATCH', `/shifts/${id}`, g.token, { instructions: 'x' })).status, 403);
      assert.equal((await api('PATCH', `/shifts/${id}`, viewerToken, { instructions: 'x' })).status, 403);
    });

    await test('SES-19-WITHDRAW-RECOVER-AND-REASSIGN-STILL-WORK', async () => {
      const offered = await shift('offered', 24 * HOUR, 8);
      assert.equal((await api('PATCH', `/shifts/${offered}`, A.token, { status: 'cancelled' })).status, 200, 'Withdraw Offer');
      const missed = await shift('missed', -3 * HOUR, 8);
      const recover = await api('PATCH', `/shifts/${missed}`, A.token, { guardId: g2.id });
      assert.equal(recover.status, 200, `re-cover a no-show: ${recover.status} ${JSON.stringify(recover.body)}`);
      assert.equal((await row(missed)).status, 'offered');
      const [entry] = await audits(missed, 'shift.updated');
      assert.equal(entry.b.guardId, g.id, 'the Guard who missed it stays on record in the audit');
      const open = await shift('unfilled', 24 * HOUR, 8, { guardId: null });
      assert.equal((await api('PATCH', `/shifts/${open}`, A.token, { guardId: g2.id })).status, 200, 'assign');
      assert.equal((await row(open)).status, 'offered');
    });

    await test('SES-20-BOOK-ON-BOOK-OFF-AND-CLOSE-WITHOUT-BOOK-OFF-ARE-UNCHANGED', async () => {
      await completedWithEvidence();
      const id = await shift('ready', -4 * HOUR, 3.5);
      assert.equal((await api('POST', '/attendance/check-in', g.token, { shiftId: id })).status, 201);
      const r = await api('POST', `/shifts/${id}/reconcile-without-book-off`, A.token, { reason: 'control_confirmed_departure' });
      assert.ok(r.status === 201 || r.status === 200, `reconcile: ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal((await row(id)).status, 'completed');
      const notes = await api('PATCH', `/shifts/${id}`, A.token, { closeOutNotes: 'Confirmed by phone.' });
      assert.equal(notes.status, 200, 'close-out notes on a finished shift');
    });

    await test('SES-21-A-NO-OP-EDIT-WRITES-NO-AUDIT-NOISE', async () => {
      const id = await shift('offered', 24 * HOUR, 8);
      const current = await row(id);
      assert.equal((await api('PATCH', `/shifts/${id}`, A.token, { start: current.start.toISOString() })).status, 200);
      assert.equal((await audits(id, 'shift.updated')).length, 0);
    });
  } finally {
    await app.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(`FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
