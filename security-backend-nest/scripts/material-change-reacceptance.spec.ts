/**
 * Material-change re-acceptance (owner-approved 22 Oct 2026).
 *
 * A Guard accepts a shift on its start, end and site. Any actual change to one of them, by any amount, returns an
 * accepted ('ready') shift to the SAME Guard as a revised offer ('offered'); it is not confirmed again until the
 * Guard accepts it through the existing offer workflow. Notes and instructions are not material. In-progress and
 * closed shifts stay protected, and reassigning to another Guard stays the controlled reassignment workflow.
 *
 *   RA-01  accepted shift retimed → offered, same Guard
 *   RA-02  the Guard re-accepts → ready, and can then Book On
 *   RA-03  the Guard declines → rejected
 *   RA-04  site change → offered
 *   RA-05  a five-minute change → offered
 *   RA-06  notes / instructions / Welfare interval / an unchanged time → stays ready
 *   RA-07  a Rota Planner time change re-offers every accepted position (and only those)
 *   RA-08  an overlap, compliance or rota-conflict refusal leaves the original shift exactly as it was
 *   RA-09  editing racing the Guard's acceptance (both orders)
 *   RA-10  editing (and a Rota Planner time change) racing Book On (both orders)
 *   RA-11  the draft timesheet and the audit history are preserved
 *   RA-12  company isolation
 *   RA-13  no duplicate offers or audit entries
 *   RA-14  the Guard's app sees the revised offer through the existing /shifts/my list
 *   RA-15  a re-offered shift cannot be Booked On until it is accepted
 *   RA-16  an in-progress shift still cannot be retimed; a ready shift still cannot be handed to another Guard
 *   RA-17  Book On stays idempotent (concurrent duplicate and retry): one event; a refused edit leaves it untouched
 *
 * Every test runs over real HTTP with real authorisation and the real audit log, against a disposable local database
 * built from the repository's own migrations. The races are made deterministic by holding the shift's row lock in a
 * separate transaction until both requests are queued behind it, in a known order.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { complianceToday } from '../src/compliance/compliance-dates';

const url = process.env.REACCEPTANCE_DATABASE_URL;
if (!url) throw new Error('REACCEPTANCE_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Re-acceptance database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'reacceptance-local-certification-secret-not-production';
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
const PASSWORD = 'reacceptance-spec-only-password-1';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
    const A = await company('raalpha', '73333333');
    const B = await company('rabeta', '74444444');

    let n = 0;
    /** A Guard of company A, fully compliant through the real compliance-check API. */
    const guard = async (label: string) => {
      n += 1;
      const email = `${label}@example.invalid`;
      const userId = await user(email, 'guard');
      const licence = `81000000000000${String(n).padStart(2, '0')}`;
      const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","siaExpiryDate","rightToWorkStatus",phone) VALUES ($1,$2,$3,$4,'british','07000000000') RETURNING id`,
        [userId, `${label} Guard`, licence, ukDay(500)]);
      await q(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [A.id, id]);
      for (const type of ['sia_licence', 'right_to_work']) {
        await q(`INSERT INTO guard_documents ("guardId","companyId",type,"storageProvider","storageKey","originalFileName","mimeType","sizeBytes","uploadCompletedAt",verified,"uploadedByUserId","verifiedByUserId","verifiedAt")
          VALUES ($1,$2,$3,'s3-compatible',$4,'e.pdf','application/pdf','1024',now(),true,null,null,now())`, [id, A.id, type, `ra/${A.id}/${id}/${type}`]);
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

    // Every test gets its own future window, so no test's shifts overlap another's.
    let windowIndex = 0;
    const nextWindow = () => Date.now() + (48 + 24 * windowIndex++) * HOUR;

    /** A shift row in company A starting at `start` (ms). */
    const shift = async (status: string, start: number, hours: number, opts: { guardId: number | null; rotaSlotId?: number | null; siteId?: number }) => {
      const { id } = await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end","checkCallIntervalMinutes","rotaSlotId") VALUES ($1,$2,'Main Site',$3,$4,$5,$6,60,$7) RETURNING id`,
        [A.id, opts.siteId ?? A.siteId, opts.guardId, status, new Date(start), new Date(start + hours * HOUR), opts.rotaSlotId ?? null]);
      return id as number;
    };
    const slotAt = async (start: number, hours: number, required: number) =>
      (await one(`INSERT INTO rota_slots ("companyId","siteId","startAt","endAt","requiredGuardCount") VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [A.id, A.siteId, new Date(start), new Date(start + hours * HOUR), required])).id as number;
    const row = (id: number) => one(`SELECT status, "guardId", "siteId", "checkCallIntervalMinutes" iv, instructions, start, "end" FROM shifts WHERE id = $1`, [id]);
    const audits = (id: number, action: string) =>
      q(`SELECT "beforeData" b, "afterData" a, "userId" u, "companyId" c, "createdAt" t FROM audit_logs WHERE "entityType"='shift' AND "entityId"=$1 AND action=$2 ORDER BY id`, [id, action]);
    const auditCount = async (id: number) => Number((await one(`SELECT count(*) n FROM audit_logs WHERE "entityType"='shift' AND "entityId"=$1`, [id])).n);
    const events = async (id: number) => Number((await one(`SELECT count(*) n FROM attendance_events WHERE "shiftId" = $1`, [id])).n);
    const respond = (g: { token: string }, id: number, response: 'accepted' | 'rejected') => api('PATCH', `/shifts/${id}/respond`, g.token, { response });
    const bookOn = (g: { token: string }, id: number) => api('POST', '/attendance/check-in', g.token, { shiftId: id });
    const myShift = async (g: { token: string }, id: number) => {
      const r = await api('GET', '/shifts/my', g.token);
      assert.equal(r.status, 200, `/shifts/my: ${r.status}`);
      const list = (Array.isArray(r.body) ? r.body : r.body?.shifts ?? []) as any[];
      return list.filter((item) => (item.shift?.id ?? item.id) === id).map((item) => item.shift ?? item);
    };

    /** Holds a shift's row lock in its own transaction; release() lets the queued requests through in arrival order. */
    const holdRow = async (id: number) => {
      const holder = ds.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      await holder.query('SELECT id FROM shifts WHERE id = $1 FOR UPDATE', [id]);
      return {
        release: async () => {
          await holder.commitTransaction();
          await holder.release();
        },
      };
    };
    const lockWaiters = async () =>
      Number((await one(`SELECT count(*) n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)).n);
    const untilWaiting = async (count: number, label: string) => {
      for (let i = 0; i < 400; i += 1) {
        if ((await lockWaiters()) >= count) return;
        await sleep(25);
      }
      throw new Error(`${label}: expected ${count} request(s) queued on a lock`);
    };

    const g1 = await guard('ra-one');
    const g2 = await guard('ra-two');

    // ════════════════ the rule ════════════════

    await test('RA-01-AN-ACCEPTED-SHIFT-RETIMED-IS-RE-OFFERED-TO-THE-SAME-GUARD', async () => {
      const start = nextWindow();
      const id = await shift('ready', start, 8, { guardId: g1.id });
      const r = await api('PATCH', `/shifts/${id}`, A.token, { start: iso(start + HOUR), end: iso(start + 9 * HOUR) });
      assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.status, 'offered', 'the response shows the shift awaiting re-acceptance');
      const after = await row(id);
      assert.equal(after.status, 'offered');
      assert.equal(after.guardId, g1.id, 'the same Guard keeps it');
      assert.equal(after.start.getTime(), start + HOUR);
      const [entry] = await audits(id, 'shift.reacceptance_required');
      assert.ok(entry, 'the re-offer is audited');
      assert.equal(entry.b.status, 'ready');
      assert.equal(new Date(entry.b.start).getTime(), start, 'with the accepted start');
      assert.equal(new Date(entry.b.end).getTime(), start + 8 * HOUR, 'and the accepted end');
      assert.equal(new Date(entry.a.start).getTime(), start + HOUR, 'and the revised start');
      assert.equal(entry.a.status, 'offered');
      assert.equal(entry.a.reason, 'material_change');
      assert.deepEqual(entry.a.changedFields, ['start', 'end']);
      assert.equal(entry.a.guardId, g1.id);
      assert.equal(entry.u, A.ownerId, 'by the manager who made the change');
      assert.equal(entry.c, A.id);
      assert.ok(entry.t instanceof Date, 'at a recorded time');
    });

    await test('RA-02-THE-GUARD-RE-ACCEPTS-AND-CAN-THEN-BOOK-ON', async () => {
      const start = nextWindow();
      const id = await shift('ready', start, 8, { guardId: g1.id });
      assert.equal((await api('PATCH', `/shifts/${id}`, A.token, { end: iso(start + 9 * HOUR) })).status, 200);
      assert.equal((await row(id)).status, 'offered');
      const r = await respond(g1, id, 'accepted');
      assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal((await row(id)).status, 'ready', 'confirmed again only by the Guard');
      assert.equal((await audits(id, 'shift.offer_accepted')).length, 1);
      assert.equal((await bookOn(g1, id)).status, 201, 'the re-accepted shift can be started');
      assert.equal((await row(id)).status, 'in_progress');
    });

    await test('RA-03-THE-GUARD-DECLINES-THE-REVISED-OFFER', async () => {
      const start = nextWindow();
      const id = await shift('ready', start, 8, { guardId: g1.id });
      assert.equal((await api('PATCH', `/shifts/${id}`, A.token, { start: iso(start - HOUR) })).status, 200);
      const r = await respond(g1, id, 'rejected');
      assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
      const after = await row(id);
      assert.equal(after.status, 'rejected', 'the company now arranges replacement cover');
      assert.equal(after.start.getTime(), start - HOUR, 'the revised times stay on the record');
      assert.equal((await audits(id, 'shift.offer_rejected')).length, 1);
    });

    await test('RA-04-A-CHANGE-OF-SITE-IS-RE-OFFERED', async () => {
      const id = await shift('ready', nextWindow(), 8, { guardId: g1.id });
      const r = await api('PATCH', `/shifts/${id}`, A.token, { siteId: A.site2Id });
      assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
      const after = await row(id);
      assert.equal(after.status, 'offered');
      assert.equal(after.siteId, A.site2Id);
      const [entry] = await audits(id, 'shift.reacceptance_required');
      assert.equal(entry.b.siteId, A.siteId, 'the accepted site');
      assert.equal(entry.a.siteId, A.site2Id, 'the revised site');
      assert.deepEqual(entry.a.changedFields, ['siteId']);
    });

    await test('RA-05-A-FIVE-MINUTE-CHANGE-IS-RE-OFFERED', async () => {
      const start = nextWindow();
      const id = await shift('ready', start, 8, { guardId: g1.id });
      const r = await api('PATCH', `/shifts/${id}`, A.token, { end: iso(start + 8 * HOUR + 5 * MIN) });
      assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal((await row(id)).status, 'offered', 'there is no minimum threshold');
      assert.deepEqual((await audits(id, 'shift.reacceptance_required'))[0].a.changedFields, ['end']);
    });

    await test('RA-06-NOTES-INSTRUCTIONS-INTERVAL-AND-UNCHANGED-TIMES-KEEP-IT-ACCEPTED', async () => {
      const start = nextWindow();
      const id = await shift('ready', start, 8, { guardId: g1.id });
      for (const body of [
        { instructions: 'Bring a torch.' },
        { closeOutNotes: 'Handover at the gate.' },
        { checkCallIntervalMinutes: 30 },
        { start: iso(start), end: iso(start + 8 * HOUR) },
        { siteId: A.siteId },
      ]) {
        const r = await api('PATCH', `/shifts/${id}`, A.token, body);
        assert.equal(r.status, 200, `${JSON.stringify(body)}: ${r.status} ${JSON.stringify(r.body)}`);
        assert.equal((await row(id)).status, 'ready', `${JSON.stringify(body)} is not a material change`);
      }
      assert.equal((await audits(id, 'shift.reacceptance_required')).length, 0);
    });

    await test('RA-07-A-ROTA-PLANNER-TIME-CHANGE-RE-OFFERS-EVERY-ACCEPTED-POSITION', async () => {
      const [ga, gb, gc] = [await guard('ra-rota-a'), await guard('ra-rota-b'), await guard('ra-rota-c')];
      const start = nextWindow();
      const slot = await slotAt(start, 8, 4);
      const readyA = await shift('ready', start, 8, { guardId: ga.id, rotaSlotId: slot });
      const readyB = await shift('ready', start, 8, { guardId: gb.id, rotaSlotId: slot });
      const offeredC = await shift('offered', start, 8, { guardId: gc.id, rotaSlotId: slot });
      const unfilled = await shift('unfilled', start, 8, { guardId: null, rotaSlotId: slot });
      const r = await api('PATCH', `/rota-slots/${slot}/time`, A.token, { startAt: iso(start + 30 * MIN), endAt: iso(start + 8 * HOUR + 30 * MIN) });
      assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
      for (const [id, g] of [[readyA, ga], [readyB, gb]] as const) {
        const after = await row(id);
        assert.equal(after.status, 'offered', `accepted position ${id} is re-offered`);
        assert.equal(after.guardId, g.id, 'to the same Guard');
        assert.equal(after.start.getTime(), start + 30 * MIN);
        const entries = await audits(id, 'shift.reacceptance_required');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].a.via, 'rota_slot.time_changed');
        assert.equal(entries[0].a.rotaSlotId, slot);
        assert.equal(new Date(entries[0].b.start).getTime(), start, 'with the accepted start');
      }
      assert.equal((await row(offeredC)).status, 'offered', 'an offered position stays offered');
      assert.equal((await audits(offeredC, 'shift.reacceptance_required')).length, 0);
      assert.equal((await row(unfilled)).status, 'unfilled');
      assert.equal((await row(unfilled)).start.getTime(), start + 30 * MIN, 'every position moves with its slot');
      const [slotEntry] = await q(`SELECT "beforeData" b, "afterData" a FROM audit_logs WHERE "entityType"='rota_slot' AND "entityId"=$1 AND action='rota_slot.time_changed'`, [slot]);
      assert.ok(slotEntry, 'the slot change is audited');
      assert.equal(new Date(slotEntry.b.startAt).getTime(), start, 'with the slot\'s previous times');
      assert.deepEqual([...slotEntry.a.reofferedShiftIds].sort(), [readyA, readyB].sort(), 'and the positions it re-offered');
      // The Rota Planner reads the positions as awaiting a response.
      const detail = await api('GET', `/rota-slots/${slot}`, A.token);
      assert.equal(detail.status, 200);
      const statuses = JSON.stringify(detail.body);
      assert.ok(!statuses.includes('"status":"ready"'), 'no position still shows as confirmed');
    });

    await test('RA-08-A-REFUSED-CHANGE-LEAVES-THE-ACCEPTED-SHIFT-EXACTLY-AS-IT-WAS', async () => {
      const start = nextWindow();
      const other = await shift('ready', start + 10 * HOUR, 6, { guardId: g2.id });
      const id = await shift('ready', start, 8, { guardId: g2.id });
      const before = await row(id);
      const auditsBefore = await auditCount(id);

      const overlap = await api('PATCH', `/shifts/${id}`, A.token, { end: iso(start + 12 * HOUR) });
      assert.equal(overlap.status, 403, `overlap: ${overlap.status} ${JSON.stringify(overlap.body)}`);
      assert.deepEqual(await row(id), before, 'overlap refusal: nothing changed');

      await q(`UPDATE company_guards SET status = 'INACTIVE' WHERE "companyId" = $1 AND "guardId" = $2`, [A.id, g2.id]);
      try {
        const revoked = await api('PATCH', `/shifts/${id}`, A.token, { end: iso(start + 9 * HOUR) });
        assert.equal(revoked.status, 403, `inactive Guard: ${revoked.status} ${JSON.stringify(revoked.body)}`);
        assert.deepEqual(await row(id), before, 'eligibility refusal: nothing changed');
      } finally {
        await q(`UPDATE company_guards SET status = 'ACTIVE' WHERE "companyId" = $1 AND "guardId" = $2`, [A.id, g2.id]);
      }
      assert.equal(await auditCount(id), auditsBefore, 'and nothing was recorded as changed');
      assert.equal((await row(other)).status, 'ready');

      const rotaGuard = await guard('ra-rota-conflict');
      const rotaStart = nextWindow();
      await shift('ready', rotaStart + 9 * HOUR, 6, { guardId: rotaGuard.id });
      const slot = await slotAt(rotaStart, 8, 1);
      const position = await shift('ready', rotaStart, 8, { guardId: rotaGuard.id, rotaSlotId: slot });
      const positionBefore = await row(position);
      const r = await api('PATCH', `/rota-slots/${slot}/time`, A.token, { startAt: iso(rotaStart + 2 * HOUR), endAt: iso(rotaStart + 10 * HOUR) });
      assert.equal(r.status, 422, `rota conflict: ${r.status} ${JSON.stringify(r.body)}`);
      assert.deepEqual(await row(position), positionBefore, 'rota refusal: the accepted position is unchanged');
      assert.equal((await audits(position, 'shift.reacceptance_required')).length, 0);
    });

    // ════════════════ races ════════════════

    await test('RA-09A-EDIT-THEN-ACCEPT-THE-ACCEPTANCE-OF-SUPERSEDED-TERMS-IS-REFUSED', async () => {
      const g = await guard('ra-race-accept-a');
      const start = nextWindow();
      const id = await shift('offered', start, 8, { guardId: g.id });
      const lock = await holdRow(id);
      const edit = api('PATCH', `/shifts/${id}`, A.token, { start: iso(start + HOUR) });
      await untilWaiting(1, 'RA-09A edit');
      const accept = respond(g, id, 'accepted');
      await untilWaiting(2, 'RA-09A accept');
      await lock.release();
      const [e, a] = await Promise.all([edit, accept]);
      assert.equal(e.status, 200, `the edit commits first: ${e.status} ${JSON.stringify(e.body)}`);
      assert.equal(a.status, 409, `the acceptance of the old terms is refused: ${a.status} ${JSON.stringify(a.body)}`);
      assert.match(a.body.message, /changed by your company/i);
      const after = await row(id);
      assert.equal(after.status, 'offered', 'the revised shift is not confirmed');
      assert.equal(after.start.getTime(), start + HOUR);
      assert.equal((await audits(id, 'shift.offer_accepted')).length, 0);
      assert.equal((await respond(g, id, 'accepted')).status, 200, 'the Guard can then accept the revised offer');
      assert.equal((await row(id)).status, 'ready');
    });

    await test('RA-09B-ACCEPT-THEN-EDIT-THE-EDIT-OF-A-NOW-ACCEPTED-SHIFT-IS-REFUSED', async () => {
      const g = await guard('ra-race-accept-b');
      const start = nextWindow();
      const id = await shift('offered', start, 8, { guardId: g.id });
      const lock = await holdRow(id);
      const accept = respond(g, id, 'accepted');
      await untilWaiting(1, 'RA-09B accept');
      const edit = api('PATCH', `/shifts/${id}`, A.token, { start: iso(start + HOUR) });
      await untilWaiting(2, 'RA-09B edit');
      await lock.release();
      const [a, e] = await Promise.all([accept, edit]);
      assert.equal(a.status, 200, `the acceptance commits first: ${a.status} ${JSON.stringify(a.body)}`);
      assert.equal(e.status, 409, `the stale edit is refused: ${e.status} ${JSON.stringify(e.body)}`);
      const after = await row(id);
      assert.equal(after.status, 'ready', 'the Guard accepted exactly the terms they saw');
      assert.equal(after.start.getTime(), start, 'and those terms stand');
      assert.equal((await audits(id, 'shift.updated')).length, 0);
      const retry = await api('PATCH', `/shifts/${id}`, A.token, { start: iso(start + HOUR) });
      assert.equal(retry.status, 200, 'the company re-applies the change after reloading');
      assert.equal((await row(id)).status, 'offered', 'and it is re-offered');
    });

    await test('RA-10A-EDIT-THEN-BOOK-ON-THE-BOOK-ON-OF-A-RE-OFFERED-SHIFT-IS-REFUSED', async () => {
      const g = await guard('ra-race-book-a');
      const start = nextWindow();
      const id = await shift('ready', start, 8, { guardId: g.id });
      const lock = await holdRow(id);
      const edit = api('PATCH', `/shifts/${id}`, A.token, { start: iso(start + HOUR) });
      await untilWaiting(1, 'RA-10A edit');
      const book = bookOn(g, id);
      await untilWaiting(2, 'RA-10A Book On');
      await lock.release();
      const [e, b] = await Promise.all([edit, book]);
      assert.equal(e.status, 200, `the edit commits first: ${e.status} ${JSON.stringify(e.body)}`);
      assert.equal(b.status, 400, `the Book On is refused: ${b.status} ${JSON.stringify(b.body)}`);
      assert.match(b.body.message, /waiting for you to accept/i);
      const after = await row(id);
      assert.equal(after.status, 'offered');
      assert.equal(after.start.getTime(), start + HOUR, 'the revised times are not overwritten by the Book On');
      assert.equal(await events(id), 0, 'no attendance was recorded');
    });

    await test('RA-10B-BOOK-ON-THEN-EDIT-THE-STARTED-SHIFT-IS-NOT-RETIMED', async () => {
      const g = await guard('ra-race-book-b');
      const start = nextWindow();
      const id = await shift('ready', start, 8, { guardId: g.id });
      const lock = await holdRow(id);
      const book = bookOn(g, id);
      await untilWaiting(1, 'RA-10B Book On');
      const edit = api('PATCH', `/shifts/${id}`, A.token, { start: iso(start + HOUR) });
      await untilWaiting(2, 'RA-10B edit');
      await lock.release();
      const [b, e] = await Promise.all([book, edit]);
      assert.equal(b.status, 201, `the Book On commits first: ${b.status} ${JSON.stringify(b.body)}`);
      assert.equal(e.status, 409, `the edit is refused: ${e.status} ${JSON.stringify(e.body)}`);
      const after = await row(id);
      assert.equal(after.status, 'in_progress');
      assert.equal(after.start.getTime(), start, 'the started shift keeps its schedule');
      assert.equal(await events(id), 1);
    });

    await test('RA-10C-A-ROTA-PLANNER-TIME-CHANGE-THEN-BOOK-ON-IS-REFUSED', async () => {
      const g = await guard('ra-race-book-c');
      const start = nextWindow();
      const slot = await slotAt(start, 8, 1);
      const id = await shift('ready', start, 8, { guardId: g.id, rotaSlotId: slot });
      const lock = await holdRow(id);
      const change = api('PATCH', `/rota-slots/${slot}/time`, A.token, { startAt: iso(start + HOUR), endAt: iso(start + 9 * HOUR) });
      await untilWaiting(1, 'RA-10C time change');
      const book = bookOn(g, id);
      await untilWaiting(2, 'RA-10C Book On');
      await lock.release();
      const [c, b] = await Promise.all([change, book]);
      assert.equal(c.status, 200, `the time change commits first: ${c.status} ${JSON.stringify(c.body)}`);
      assert.equal(b.status, 400, `the Book On is refused: ${b.status} ${JSON.stringify(b.body)}`);
      assert.equal((await row(id)).status, 'offered');
      assert.equal(await events(id), 0);
    });

    await test('RA-10D-BOOK-ON-THEN-A-ROTA-PLANNER-TIME-CHANGE-IS-REFUSED', async () => {
      const g = await guard('ra-race-book-d');
      const start = nextWindow();
      const slot = await slotAt(start, 8, 1);
      const id = await shift('ready', start, 8, { guardId: g.id, rotaSlotId: slot });
      const lock = await holdRow(id);
      const book = bookOn(g, id);
      await untilWaiting(1, 'RA-10D Book On');
      const change = api('PATCH', `/rota-slots/${slot}/time`, A.token, { startAt: iso(start + HOUR), endAt: iso(start + 9 * HOUR) });
      await untilWaiting(2, 'RA-10D time change');
      await lock.release();
      const [b, c] = await Promise.all([book, change]);
      assert.equal(b.status, 201, `the Book On commits first: ${b.status} ${JSON.stringify(b.body)}`);
      assert.equal(c.status, 409, `the time change is refused: ${c.status} ${JSON.stringify(c.body)}`);
      const after = await row(id);
      assert.equal(after.status, 'in_progress');
      assert.equal(after.start.getTime(), start, 'the started position keeps its schedule');
      const slotRow = await one(`SELECT "startAt" FROM rota_slots WHERE id = $1`, [slot]);
      assert.equal(new Date(slotRow.startAt).getTime(), start, 'and so does its slot');
    });

    // ════════════════ evidence ════════════════

    await test('RA-11-THE-DRAFT-TIMESHEET-AND-THE-AUDIT-HISTORY-ARE-PRESERVED', async () => {
      const start = nextWindow();
      const created = await api('POST', '/shifts', A.token, { siteId: A.siteId, guardId: g1.id, start: iso(start), end: iso(start + 8 * HOUR) });
      assert.equal(created.status, 201, `${created.status} ${JSON.stringify(created.body)}`);
      const id = created.body.shift.id as number;
      const [timesheet] = await q(`SELECT id, "approvalStatus" FROM timesheets WHERE "shiftId" = $1`, [id]);
      assert.ok(timesheet, 'the assignment created a draft timesheet');
      assert.equal((await respond(g1, id, 'accepted')).status, 200);

      assert.equal((await api('PATCH', `/shifts/${id}`, A.token, { start: iso(start + HOUR), end: iso(start + 9 * HOUR) })).status, 200);
      const sheets = await q(`SELECT id, "approvalStatus", "scheduledStartAt", "scheduledEndAt", "guardId" FROM timesheets WHERE "shiftId" = $1`, [id]);
      assert.equal(sheets.length, 1, 'still exactly one timesheet');
      assert.equal(sheets[0].id, timesheet.id, 'the same timesheet');
      assert.equal(sheets[0].approvalStatus, 'draft');
      assert.equal(sheets[0].guardId, g1.id);
      assert.equal(new Date(sheets[0].scheduledStartAt).getTime(), start + HOUR, 'its scheduled times follow the revised shift');
      assert.equal(new Date(sheets[0].scheduledEndAt).getTime(), start + 9 * HOUR);

      assert.equal((await audits(id, 'shift.offer_accepted')).length, 1, 'the original acceptance stays on the record');
      const [updated] = await audits(id, 'shift.updated');
      assert.equal(updated.b.status, 'ready');
      assert.equal(updated.a.status, 'offered');
      const [reoffer] = await audits(id, 'shift.reacceptance_required');
      assert.equal(new Date(reoffer.b.start).getTime(), start, 'the accepted terms are kept');
      assert.equal(new Date(reoffer.b.end).getTime(), start + 8 * HOUR);

      assert.equal((await respond(g1, id, 'accepted')).status, 200);
      assert.equal((await audits(id, 'shift.offer_accepted')).length, 2, 'and the re-acceptance is a second, separate entry');
    });

    await test('RA-12-COMPANY-ISOLATION', async () => {
      const start = nextWindow();
      const id = await shift('ready', start, 8, { guardId: g1.id });
      const slot = await slotAt(start + 12 * HOUR, 8, 1);
      const position = await shift('ready', start + 12 * HOUR, 8, { guardId: g1.id, rotaSlotId: slot });
      const before = await row(id);
      const positionBefore = await row(position);
      assert.equal((await api('PATCH', `/shifts/${id}`, B.token, { start: iso(start + HOUR) })).status, 404, 'another company cannot retime it');
      assert.equal((await api('PATCH', `/shifts/${id}`, B.token, { siteId: B.siteId })).status, 404);
      assert.equal((await api('PATCH', `/rota-slots/${slot}/time`, B.token, { startAt: iso(start + 13 * HOUR), endAt: iso(start + 21 * HOUR) })).status, 404);
      assert.deepEqual(await row(id), before);
      assert.deepEqual(await row(position), positionBefore);
      // A's own manager cannot move A's shift onto B's site.
      assert.ok([403, 404].includes((await api('PATCH', `/shifts/${id}`, A.token, { siteId: B.siteId })).status), 'refused');
      assert.deepEqual(await row(id), before);
      // Another Guard cannot answer this Guard's revised offer.
      assert.equal((await api('PATCH', `/shifts/${id}`, A.token, { end: iso(start + 9 * HOUR) })).status, 200);
      assert.equal((await respond(g2, id, 'accepted')).status, 404);
      assert.equal((await row(id)).status, 'offered');
      const foreign = Number((await one(`SELECT count(*) n FROM audit_logs WHERE "companyId" = $1 AND "entityType" = 'shift' AND "entityId" = ANY($2::int[])`, [B.id, [id, position]])).n);
      assert.equal(foreign, 0, 'nothing is recorded against the other company');
    });

    await test('RA-13-NO-DUPLICATE-OFFERS-OR-AUDIT-ENTRIES', async () => {
      const g = await guard('ra-dup');
      const start = nextWindow();
      const id = await shift('ready', start, 8, { guardId: g.id });
      assert.equal((await api('PATCH', `/shifts/${id}`, A.token, { start: iso(start + HOUR) })).status, 200);
      assert.equal((await api('PATCH', `/shifts/${id}`, A.token, { start: iso(start + 2 * HOUR) })).status, 200, 'a second change to the revised offer');
      assert.equal((await api('PATCH', `/shifts/${id}`, A.token, { start: iso(start + 2 * HOUR) })).status, 200, 'and the same change repeated');
      assert.equal((await row(id)).status, 'offered');
      assert.equal((await audits(id, 'shift.reacceptance_required')).length, 1, 'one re-offer: the shift was accepted once');
      assert.equal((await audits(id, 'shift.updated')).length, 2, 'two real changes, and nothing for the repeat');
      const shiftsForGuard = Number((await one(`SELECT count(*) n FROM shifts WHERE "guardId" = $1`, [g.id])).n);
      assert.equal(shiftsForGuard, 1, 'no second shift or offer was created');
      assert.equal((await myShift(g, id)).length, 1, 'the Guard sees it once');
    });

    // ════════════════ the existing Guard app and the protected states ════════════════

    await test('RA-14-THE-GUARD-APP-SEES-THE-REVISED-OFFER-IN-ITS-EXISTING-LIST', async () => {
      const g = await guard('ra-app');
      const start = nextWindow();
      const id = await shift('ready', start, 8, { guardId: g.id });
      assert.equal((await myShift(g, id))[0]?.status, 'ready');
      assert.equal((await api('PATCH', `/shifts/${id}`, A.token, { end: iso(start + 10 * HOUR) })).status, 200);
      const [mine] = await myShift(g, id);
      assert.ok(mine, 'the shift is still in the Guard\'s list');
      assert.equal(mine.status, 'offered', 'as an offer, which builds 15 / 14 show with Accept and Decline');
      assert.equal(new Date(mine.end).getTime(), start + 10 * HOUR, 'with the revised times');
    });

    await test('RA-15-A-RE-OFFERED-SHIFT-CANNOT-BE-BOOKED-ON-UNTIL-ACCEPTED', async () => {
      const g = await guard('ra-book');
      const start = nextWindow();
      const id = await shift('ready', start, 8, { guardId: g.id });
      assert.equal((await api('PATCH', `/shifts/${id}`, A.token, { siteId: A.site2Id })).status, 200);
      const r = await bookOn(g, id);
      assert.equal(r.status, 400, `${r.status} ${JSON.stringify(r.body)}`);
      assert.match(r.body.message, /waiting for you to accept/i);
      assert.equal(await events(id), 0);
      assert.equal((await respond(g, id, 'accepted')).status, 200);
      assert.equal((await bookOn(g, id)).status, 201);
    });

    await test('RA-16-STARTED-SHIFTS-AND-REASSIGNMENT-STAY-PROTECTED', async () => {
      const g = await guard('ra-protected');
      const start = nextWindow();
      const live = await shift('ready', start, 8, { guardId: g.id });
      assert.equal((await bookOn(g, live)).status, 201);
      const r = await api('PATCH', `/shifts/${live}`, A.token, { end: iso(start + 9 * HOUR) });
      assert.equal(r.status, 409, `an in-progress shift is not retimed here: ${r.status}`);
      assert.equal((await row(live)).status, 'in_progress');

      const accepted = await shift('ready', nextWindow(), 8, { guardId: g.id });
      const reassign = await api('PATCH', `/shifts/${accepted}`, A.token, { guardId: g2.id });
      assert.equal(reassign.status, 400, `an accepted shift is not handed to another Guard by editing: ${reassign.status}`);
      const after = await row(accepted);
      assert.equal(after.status, 'ready');
      assert.equal(after.guardId, g.id);
    });
    await test('RA-17-BOOK-ON-STAYS-IDEMPOTENT-AND-WRITES-ONE-EVENT', async () => {
      const g = await guard('ra-idem');
      const id = await shift('ready', nextWindow(), 8, { guardId: g.id });
      const lock = await holdRow(id);
      const first = bookOn(g, id);
      await untilWaiting(1, 'RA-17 first Book On');
      const second = bookOn(g, id);
      await untilWaiting(2, 'RA-17 second Book On');
      await lock.release();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.status, 201, `${a.status} ${JSON.stringify(a.body)}`);
      assert.equal(b.status, 201, `the concurrent duplicate gets the same answer: ${b.status} ${JSON.stringify(b.body)}`);
      assert.equal(a.body.id, b.body.id, 'and the same Book On event');
      const retry = await bookOn(g, id);
      assert.equal(retry.status, 201, 'a retry after a lost response is still answered');
      assert.equal(retry.body.id, a.body.id);
      assert.equal(await events(id), 1, 'exactly one Book On is recorded');
      const before = await q(`SELECT row_to_json(e)::text j FROM attendance_events e WHERE "shiftId" = $1`, [id]);
      assert.equal((await api('PATCH', `/shifts/${id}`, A.token, { end: iso(Date.now() + 999 * HOUR) })).status, 409);
      assert.deepEqual(await q(`SELECT row_to_json(e)::text j FROM attendance_events e WHERE "shiftId" = $1`, [id]), before,
        'a refused edit leaves the attendance evidence byte-identical');
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
