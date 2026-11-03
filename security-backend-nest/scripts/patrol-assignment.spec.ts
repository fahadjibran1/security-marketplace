/**
 * S4 patrol assignment correctness (owner-approved 3 Nov 2026, after production patrol P-6: a Guard booked on before the
 * site's setup was activated, the phone's plan had no window, and the patrol it then started was recorded ad hoc while
 * the scheduled window it was done in stayed owed). The whole application over HTTP on a disposable database built from
 * the repository's own migrations (head = Migration 75). The patrol and safety sweeps' timers are stopped.
 *
 *   PA-01  P-6: Book On before activation (the plan has no window), then Start Patrol with no schedule → linked to the ONE
 *          open shift window (schedule, key, scope sh{shift}); window_auto_assigned, not a review flag, not a late-sync
 *          audit; patrol.run.window_auto_assigned audited with the window weighed; the answer explains it; the window
 *          is covered (plan) and never judged missed (sweep); the next one still is
 *   PA-02  idempotency and offline replay: the same request again (and concurrently) → the same answer, one row; a run
 *          first reaching S4 after Book Off (offline, within the acceptance window) is linked the same way and flagged
 *          post_shift_creation as before; a stale clientRunId with different content is still 409
 *   PA-03  ambiguous: two windows open (a clock schedule and the shift window) → ad hoc, window_match_ambiguous, the
 *          answer says why; no window is satisfied; patrol.run.window_not_assigned names both
 *   PA-04  scopes: site-wide — one Guard's patrol takes the site window, a second Guard's ad-hoc start finds it covered
 *          (ad hoc, never satisfying it twice); per-guard — each Guard's start takes their own window
 *   PA-05  covered and missed: a window already covered by a scheduled run is never taken again; a window the sweep has
 *          judged missed is never taken (the exception untouched, never annotated or closed); a late start (within the
 *          grace after a window ends) is linked late only when no window contains the start
 *   PA-06  isolation: another company's schedules and another shift's windows are never candidates
 *   PA-07  explicit starts unchanged: a start naming a schedule is linked by that schedule as before (no assignment
 *          flag, no assignment audit, answer "scheduled"); a start with no window open stays ad hoc ("none")
 *   PA-08  the Patrol Monitor: an ad-hoc patrol is placed in its lane and hour (otherRuns laneKey / hour / explanation),
 *          marked on the cell (adHoc) and on the window it was received in (adHocRunIds), never counted; cells count
 *          later windows apart (later)
 *
 * Needs PATROL_ASSIGNMENT_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

const url = process.env.PATROL_ASSIGNMENT_DATABASE_URL;
if (!url) throw new Error('PATROL_ASSIGNMENT_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Patrol assignment database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-assignment-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
for (const k of ['RESEND_API_KEY', 'EXPO_ACCESS_TOKEN', 'PUSH_WELFARE_REMINDERS_ENABLED', 'PUSH_GUARD_NOTIFICATIONS_ENABLED', 'PATROL_QR_PREVIOUS_SIGNING_KEY',
  'PATROL_EVIDENCE_STORAGE_ENDPOINT']) delete process.env[k];
process.env.PATROL_QR_SIGNING_KEY = 'patrol-assignment-spec-only-signing-key-01';
process.env.PATROL_QR_SIGNING_KEY_ID = 'pa';

let passed = 0;
const failures: string[] = [];
const test = async (id: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failures.push(id);
    console.log(`FAIL  ${id}\n      ${String((error as Error)?.stack ?? error).split('\n').slice(0, 10).join('\n      ')}`);
  }
};

type Res = { status: number; body: any };
const PASSWORD = 'patrol-assignment-spec-only-password-1';
const MIN = 60_000;
const HOUR = 60 * MIN;
const Z = (s: string) => new Date(s);
let clientSeq = 0;
const cid = (p: string) => `${p}-${Date.now().toString(36)}-${(++clientSeq).toString().padStart(4, '0')}`;

async function main() {
  const path = require('node:path');
  const fs = require('node:fs');
  const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
  const allFiles: string[] = fs.readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).sort();
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const base = buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' });
  const migrate = new DataSource({ ...base, entities: [], migrations: allFiles.map((f) => path.join(migrationsDir, f)), dropSchema: true } as never);
  await migrate.initialize();
  const migrated = await migrate.runMigrations({ transaction: 'each' });
  assert.equal(migrated[migrated.length - 1]?.name, 'AddPatrolMonitorIndexes1720900000022', 'the head is Migration 75 — this fix adds no migration');
  await migrate.destroy();

  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const ds = app.get(DataSource);
  const [{ current_database: db }] = await ds.query('SELECT current_database()');
  if (db !== new URL(url!).pathname.slice(1)) throw new Error(`Refusing: connected to ${db}`);
  const { PatrolSweepService } = await import('../src/patrol/patrol-sweep.service');
  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const { AuthService } = await import('../src/auth/auth.service');
  const C = await import('../src/patrol/patrol-constants');
  const M = await import('../src/patrol/patrol-window-match');
  const sweeper = app.get(PatrolSweepService);
  sweeper.onModuleDestroy();
  app.get(SafetyAlertService).onModuleDestroy();
  const auth = app.get(AuthService);

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const count = async (sql: string, params: unknown[] = []) => Number(Object.values((await q(sql, params))[0] ?? {})[0]);
  const api = async (method: string, p: string, tok: string | null, body?: unknown): Promise<Res> => {
    const res = await fetch(baseUrl + p, {
      method,
      headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };
  const expect = (r: Res, status: number, code?: string, what = '') => {
    assert.equal(r.status, status, `${what} expected ${status}${code ? ` ${code}` : ''}, got ${r.status} ${JSON.stringify(r.body)}`);
    if (code) assert.equal(r.body?.code, code, `${what} code: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;

  // ── Fixtures (fictional) ─────────────────────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash(PASSWORD, 4);
  let seq = 0;
  const mkUser = async (email: string, role: string) =>
    Number((await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
       VALUES ($1,$2,$3,'active',true,false,$4,'Spec') RETURNING id`, [email, hash, role, email.split('@')[0]])).id);
  const mkCompany = async (label: string) => {
    seq += 1;
    const ownerEmail = `pa.${label}.owner@example.invalid`;
    const ownerId = await mkUser(ownerEmail, 'company_admin');
    const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,$2,$3,'1 Way','ops@example.invalid',true) RETURNING id`,
      [ownerId, `PA ${label} Ltd`, String(75000000 + seq)]);
    return { id: Number(id), ownerId, token: await login(ownerEmail) };
  };
  const mkSite = async (companyId: number, name: string, tz = 'Europe/London') =>
    Number((await one(`INSERT INTO sites ("companyId",name,address,timezone) VALUES ($1,$2,'3 Quay',$3) RETURNING id`, [companyId, name, tz])).id);
  const mkGuard = async (label: string) => {
    seq += 1;
    const email = `pa.${label}@example.invalid`;
    const userId = await mkUser(email, 'guard');
    const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, `Guard ${label}`, `75${String(seq).padStart(14, '0')}`, `0775${String(seq).padStart(7, '0')}`]);
    return { id: Number(id), userId, token: await login(email) };
  };
  const mkShift = async (companyId: number, siteId: number, guardId: number, start: Date, end: Date, status = 'in_progress') =>
    Number((await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Gate',$3,$4,$5,$6) RETURNING id`,
      [companyId, siteId, guardId, status, start, end])).id);
  const bookOn = (shiftId: number, guardId: number, at: Date) =>
    q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-in',$3,$3,false)`, [shiftId, guardId, at]);
  const bookOff = async (shiftId: number, guardId: number, at: Date) => {
    await q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-out',$3,$3,false)`, [shiftId, guardId, at]);
    await q(`UPDATE shifts SET status = 'completed' WHERE id = $1`, [shiftId]);
  };
  const setup = (token: string, siteId: number, body: Record<string, unknown>) => api('PUT', `/patrols/sites/${siteId}/setup`, token, body);
  /** As production: activated now; the floors backdated so windows on the spec's dates are judged. */
  const activate = async (co: { token: string }, siteId: number, since: string) => {
    expect(await api('POST', `/patrols/sites/${siteId}/setup/confirm`, co.token), 200, undefined, 'activate');
    await q(`UPDATE patrol_policies SET "setupConfirmedAt" = $2 WHERE "siteId" = $1 AND "setupConfirmedAt" IS NOT NULL`, [siteId, since]);
    await q(`UPDATE patrol_schedules SET "createdAt" = $2, "updatedAt" = $2 WHERE "siteId" = $1 AND anchor = 'shift'`, [siteId, since]);
    await q(`UPDATE audit_logs SET "createdAt" = $2 WHERE action = 'patrol.setup.updated' AND ("afterData"->>'siteId')::int = $1`, [siteId, since]);
    return one(`SELECT * FROM patrol_schedules WHERE "siteId" = $1 AND anchor = 'shift' AND "archivedAt" IS NULL`, [siteId]);
  };
  /** A photo-only site with shift patrols every `every` minutes from the shift's scheduled start, active as of `since`. */
  const shiftSite = async (co: { id: number; token: string }, name: string, every = 30, since = '2026-01-01T00:00:00Z') => {
    const siteId = await mkSite(co.id, name);
    expect(await setup(co.token, siteId, { setupMode: 'every_shift', evidenceMode: 'photo', frequencyMinutes: every }), 200, undefined, 'save');
    const schedule = await activate(co, siteId, since);
    return { siteId, schedule };
  };
  const clockSchedule = async (co: { token: string }, siteId: number, body: Record<string, unknown>) => {
    const s = expect(await api('POST', '/patrols/schedules', co.token, { siteId, name: 'Gatehouse', frequencyMinutes: 60, ...body }), 201, undefined, 'clock schedule');
    await q(`UPDATE patrol_schedules SET "createdAt" = '2026-01-01', "updatedAt" = '2026-01-01' WHERE id = $1`, [s.id]);
    return s;
  };
  const start = (g: { token: string }, shiftId: number, at: Date | string, extra: Record<string, unknown> = {}) =>
    api('POST', '/patrols/runs', g.token, { shiftId, clientRunId: cid('run'), startedAtDevice: new Date(at).toISOString(), ...extra });
  const complete = async (g: { token: string }, runId: number, at: string) => {
    const r = await api('POST', `/patrols/runs/${runId}/complete`, g.token, { completedAtDevice: at });
    assert.ok(r.status === 200 || r.status === 201, `complete ${runId}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const runRow = (id: number) => one(`SELECT * FROM patrol_runs WHERE id = $1`, [id]);
  const auditsFor = (runId: number) => q(`SELECT action, "afterData" FROM audit_logs WHERE "entityType" = 'patrol_run' AND "entityId" = $1 ORDER BY id`, [runId]);
  const sweep = (at: Date | string) => sweeper.sweep(new Date(at));
  const missedOf = (companyId: number) => q(`SELECT * FROM patrol_exceptions WHERE "companyId" = $1 AND type = 'patrol_missed' ORDER BY "windowStart", "scopeKey", id`, [companyId]);

  const A = await mkCompany('alpha');
  const B = await mkCompany('bravo');
  const ava = await mkGuard('ava');
  const ben = await mkGuard('ben');
  const cara = await mkGuard('cara');

  try {
    await test('PA-00-THE-MATCH-RULE-IS-PURE-ONE-ELIGIBLE-WINDOW-OR-AD-HOC', () => {
      const c = (key: string, s: string, e: string, over: Record<string, unknown> = {}) => ({
        scheduleId: 1, scheduleName: 'Shift patrol', anchor: 'shift' as const, scopeKey: 'sh1', windowKey: key, start: Z(s), end: Z(e), covered: false, missed: false, schedule: null, window: null, ...over });
      const w1 = c('w1', '2026-11-10T10:10:00Z', '2026-11-10T10:40:00Z');
      const w2 = c('w2', '2026-11-10T10:40:00Z', '2026-11-10T11:10:00Z');
      const at = (s: string) => Z(s);
      const r1 = M.matchStartWindow([w1, w2], at('2026-11-10T10:10:22Z'), 15, 'Europe/London');
      assert.equal(r1.outcome, 'auto_assigned');
      assert.equal(r1.outcome === 'auto_assigned' && r1.candidate.windowKey, 'w1');
      assert.equal(r1.outcome === 'auto_assigned' && r1.lateStart, false);
      // Containing first: at 10:45 w2 contains the start; w1 ended within the grace but is not considered.
      const r2 = M.matchStartWindow([w1, w2], at('2026-11-10T10:45:00Z'), 15, 'Europe/London');
      assert.equal(r2.outcome === 'auto_assigned' && r2.candidate.windowKey, 'w2');
      // ...and if w2 is covered, the start is NOT moved back to w1: covered, ad hoc.
      assert.equal(M.matchStartWindow([w1, { ...w2, covered: true }], at('2026-11-10T10:45:00Z'), 15, 'Europe/London').outcome, 'covered');
      // Late tier only when nothing contains the start.
      const r3 = M.matchStartWindow([w1], at('2026-11-10T10:50:00Z'), 15, 'Europe/London');
      assert.ok(r3.outcome === 'auto_assigned' && r3.lateStart, 'a late start within the grace');
      assert.equal(M.matchStartWindow([w1], at('2026-11-10T10:56:00Z'), 15, 'Europe/London').outcome, 'none', 'beyond the grace');
      const both = M.matchStartWindow([w1, c('k1', '2026-11-10T10:00:00Z', '2026-11-10T11:00:00Z', { scheduleId: 2, scheduleName: 'Gatehouse', anchor: 'clock', scopeKey: 'site' })], at('2026-11-10T10:20:00Z'), 15, 'Europe/London');
      assert.equal(both.outcome, 'ambiguous');
      assert.match(both.message, /2 scheduled patrol windows were open \(Gatehouse 10:00-11:00; Shift patrol 10:10-10:40\)/);
      assert.equal(M.matchStartWindow([{ ...w1, missed: true }], at('2026-11-10T10:20:00Z'), 15, 'Europe/London').outcome, 'missed');
      assert.deepEqual(C.PATROL_ASSIGNMENT_FLAGS, ['window_auto_assigned', 'window_match_ambiguous']);
      assert.ok(C.PATROL_ASSIGNMENT_FLAGS.every((f) => !C.PATROL_REVIEW_FLAGS.includes(f)), 'never a review reason');
    });

    await test('PA-01-P6-BOOK-ON-BEFORE-ACTIVATION-THEN-START-PATROL-IS-LINKED-TO-ITS-ONE-WINDOW', async () => {
      const siteId = await mkSite(A.id, 'Totmonslow-like Solar Farm');
      expect(await setup(A.token, siteId, { setupMode: 'every_shift', evidenceMode: 'photo', frequencyMinutes: 30 }), 200);
      const shiftId = await mkShift(A.id, siteId, ava.id, Z('2026-11-10T10:10:00Z'), Z('2026-11-10T11:10:00Z'));
      await bookOn(shiftId, ava.id, Z('2026-11-10T10:08:04Z'));
      const stale = expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftId}`, ava.token), 200, undefined, 'the plan at Book On');
      assert.deepEqual(stale.windows, [], 'before activation the plan has no window — what the phone kept');
      const schedule = await activate(A, siteId, '2026-11-10T10:09:21Z');
      // The phone (stale plan) sends no schedule.
      const started = expect(await start(ava, shiftId, '2026-11-10T10:10:22.990Z'), 201, undefined, 'start');
      assert.deepEqual([started.scheduleId, started.windowStart, started.windowEnd, started.lateStart], [Number(schedule.id), '2026-11-10T10:10:00.000Z', '2026-11-10T10:40:00.000Z', false]);
      assert.ok(started.windowKey && started.syncFlags.includes('window_auto_assigned'), 'linked, and says so');
      assert.equal(started.needsReview, false, 'not a review reason');
      assert.deepEqual(started.windowAssignment, { outcome: 'auto_assigned', message: 'Linked by S4 to the scheduled patrol window it was started in.' });
      const row = await runRow(started.id);
      assert.equal(row.scopeKey, `sh${shiftId}`, 'owed by the shift');
      const audits = await auditsFor(started.id);
      assert.deepEqual(audits.map((a: any) => a.action), ['patrol.run.window_auto_assigned'], 'audited as an assignment, not as a late sync');
      assert.equal(audits[0].afterData.message, 'Linked to the scheduled patrol Shift patrol 10:10-10:40.');
      assert.deepEqual(audits[0].afterData.candidates.map((c: any) => [c.windowKey, c.covered, c.missed]), [[row.windowKey, false, false]]);
      // The plan now shows the window covered; the sweep never judges it missed; the next window is still owed.
      const plan = expect(await api('GET', `/patrols/mine/plan?shiftId=${shiftId}`, ava.token), 200);
      assert.deepEqual(plan.windows.map((w: any) => [w.start, w.covered]), [['2026-11-10T10:10:00.000Z', true], ['2026-11-10T10:40:00.000Z', false]]);
      await complete(ava, started.id, '2026-11-10T10:10:49Z');
      await sweep('2026-11-10T11:30:00Z');
      const missed = await missedOf(A.id);
      assert.deepEqual(missed.filter((m: any) => m.scopeKey === `sh${shiftId}`).map((m: any) => new Date(m.windowStart).toISOString()), ['2026-11-10T10:40:00.000Z'], 'only the window nobody patrolled');
    });

    await test('PA-02-IDEMPOTENT-REPLAY-CONCURRENT-DUPLICATES-AND-OFFLINE-AFTER-BOOK-OFF', async () => {
      const { siteId, schedule } = await shiftSite(A, 'Replay yard');
      const shiftId = await mkShift(A.id, siteId, ben.id, Z('2026-11-10T08:00:00Z'), Z('2026-11-10T09:00:00Z'));
      await bookOn(shiftId, ben.id, Z('2026-11-10T07:58:00Z'));
      const body = { shiftId, clientRunId: cid('rep'), startedAtDevice: '2026-11-10T08:05:00Z' };
      const first = expect(await api('POST', '/patrols/runs', ben.token, body), 201);
      const again = expect(await api('POST', '/patrols/runs', ben.token, body), 201, undefined, 'replay');
      assert.deepEqual(again, first, 'a replay answers exactly as the first request');
      assert.equal(first.scheduleId, Number(schedule.id));
      expect(await api('POST', '/patrols/runs', ben.token, { ...body, startedAtDevice: '2026-11-10T08:06:00Z' }), 409, 'PATROL_IDEMPOTENCY_CONFLICT', 'same id, different content');
      await complete(ben, first.id, '2026-11-10T08:10:00Z');
      // Concurrent duplicates of one ad-hoc start: one row, the same answer.
      const dup = { shiftId, clientRunId: cid('dup'), startedAtDevice: '2026-11-10T08:35:00Z' };
      const answers = await Promise.all([1, 2, 3].map(() => api('POST', '/patrols/runs', ben.token, dup)));
      assert.ok(answers.every((a) => a.status === 201), JSON.stringify(answers.map((a) => a.status)));
      assert.ok(answers.every((a) => JSON.stringify(a.body) === JSON.stringify(answers[0].body)), 'one answer');
      assert.equal(await count(`SELECT count(*) FROM patrol_runs WHERE "clientRunId" = $1`, [dup.clientRunId]), 1);
      assert.equal(answers[0].body.windowStart, '2026-11-10T08:30:00.000Z', 'the second window');
      // Offline: the run first reaches S4 after Book Off (within the acceptance window) — linked the same way.
      const now = Date.now();
      const offSite = await shiftSite(A, 'Offline yard', 30);
      const startAt = new Date(Math.floor((now - 3 * HOUR) / (30 * MIN)) * 30 * MIN);
      const offShift = await mkShift(A.id, offSite.siteId, cara.id, startAt, new Date(startAt.getTime() + HOUR));
      await bookOn(offShift, cara.id, new Date(startAt.getTime() - 2 * MIN));
      await bookOff(offShift, cara.id, new Date(startAt.getTime() + HOUR));
      const late = expect(await start(cara, offShift, new Date(startAt.getTime() + 5 * MIN)), 201, undefined, 'offline start after Book Off');
      assert.equal(late.scheduleId, Number(offSite.schedule.id));
      assert.equal(late.windowStart, startAt.toISOString());
      assert.ok(late.syncFlags.includes('post_shift_creation') && late.syncFlags.includes('window_auto_assigned'), JSON.stringify(late.syncFlags));
      assert.equal(late.provisional, true, 'post-shift rules unchanged');
    });

    await test('PA-03-TWO-OPEN-WINDOWS-ARE-AMBIGUOUS-THE-PATROL-STAYS-AD-HOC-WITH-A-REASON', async () => {
      const { siteId } = await shiftSite(A, 'Overlap yard', 30);
      await clockSchedule(A, siteId, { activeFrom: '09:00', activeTo: '12:00', frequencyMinutes: 60, windowMinutes: 60 });
      const shiftId = await mkShift(A.id, siteId, ava.id, Z('2026-11-10T10:10:00Z'), Z('2026-11-10T11:10:00Z'));
      await bookOn(shiftId, ava.id, Z('2026-11-10T10:05:00Z'));
      const r = expect(await start(ava, shiftId, '2026-11-10T10:20:00Z'), 201);
      assert.deepEqual([r.scheduleId, r.windowKey, r.windowStart], [null, null, null], 'satisfies no window');
      assert.ok(r.syncFlags.includes('window_match_ambiguous') && !r.syncFlags.includes('window_auto_assigned'));
      assert.equal(r.needsReview, false);
      assert.deepEqual(r.windowAssignment.outcome, 'ambiguous');
      assert.match(r.windowAssignment.message, /more than one scheduled patrol window was open/);
      const [audit] = await auditsFor(r.id);
      assert.equal(audit.action, 'patrol.run.window_not_assigned');
      assert.equal(audit.afterData.candidates.length, 2);
      assert.match(audit.afterData.message, /2 scheduled patrol windows were open \(Gatehouse 10:00-11:00; Shift patrol 10:10-10:40\)/);
      assert.equal(await count(`SELECT count(*) FROM patrol_runs WHERE "siteId" = $1 AND "windowKey" IS NOT NULL`, [siteId]), 0);
    });

    await test('PA-04-SITE-WIDE-ONE-PATROL-PER-WINDOW-PER-GUARD-ONE-EACH', async () => {
      // Site-wide (clock schedule, scope site): Ava takes it; Ben's ad-hoc start finds it covered.
      const siteId = await mkSite(A.id, 'Site-wide yard');
      expect(await api('PUT', `/patrols/policies/sites/${siteId}`, A.token, { methods: ['photo'], photosPerRun: 1, requirementScope: 'site' }), 200);
      await clockSchedule(A, siteId, { activeFrom: '08:00', activeTo: '12:00', frequencyMinutes: 60, windowMinutes: 60 });
      const sA = await mkShift(A.id, siteId, ava.id, Z('2026-11-11T08:00:00Z'), Z('2026-11-11T12:00:00Z'));
      const sB = await mkShift(A.id, siteId, ben.id, Z('2026-11-11T08:00:00Z'), Z('2026-11-11T12:00:00Z'));
      const a = expect(await start(ava, sA, '2026-11-11T09:05:00Z'), 201);
      assert.ok(a.windowKey && a.syncFlags.includes('window_auto_assigned'));
      assert.equal((await runRow(a.id)).scopeKey, 'site');
      await complete(ava, a.id, '2026-11-11T09:20:00Z');
      const b = expect(await start(ben, sB, '2026-11-11T09:25:00Z'), 201);
      assert.deepEqual([b.scheduleId, b.windowKey, b.windowAssignment.outcome], [null, null, 'ad_hoc'], 'the site window already has a patrol: never satisfied twice');
      const [audit] = await auditsFor(b.id);
      assert.equal(audit.afterData.outcome, 'covered');
      // Concurrent site-wide starts in the next window: exactly one takes it.
      await complete(ben, b.id, '2026-11-11T09:30:00Z');
      const [x, y] = await Promise.all([start(ava, sA, '2026-11-11T10:02:00Z'), start(ben, sB, '2026-11-11T10:03:00Z')]);
      assert.deepEqual([x.status, y.status], [201, 201]);
      assert.equal([x.body, y.body].filter((r) => r.windowKey).length, 1, 'one window, one patrol');
      assert.equal(await count(`SELECT count(*) FROM patrol_runs WHERE "siteId" = $1 AND "windowStart" = '2026-11-11T10:00:00Z'`, [siteId]), 1);
      // Per guard: each Guard's start takes their own window.
      const pg = await mkSite(A.id, 'Per-guard yard');
      expect(await api('PUT', `/patrols/policies/sites/${pg}`, A.token, { methods: ['photo'], photosPerRun: 1, requirementScope: 'per_guard' }), 200);
      await clockSchedule(A, pg, { activeFrom: '08:00', activeTo: '12:00', frequencyMinutes: 60, windowMinutes: 60 });
      const pA = await mkShift(A.id, pg, ava.id, Z('2026-11-12T08:00:00Z'), Z('2026-11-12T12:00:00Z'));
      const pB = await mkShift(A.id, pg, ben.id, Z('2026-11-12T08:00:00Z'), Z('2026-11-12T12:00:00Z'));
      const ra = expect(await start(ava, pA, '2026-11-12T09:05:00Z'), 201);
      const rb = expect(await start(ben, pB, '2026-11-12T09:06:00Z'), 201);
      assert.deepEqual([(await runRow(ra.id)).scopeKey, (await runRow(rb.id)).scopeKey], [`sh${pA}`, `sh${pB}`]);
      assert.ok(ra.windowKey && rb.windowKey && ra.windowKey === rb.windowKey, 'the same window, each Guard\'s own obligation');
    });

    await test('PA-05-COVERED-AND-MISSED-WINDOWS-ARE-NEVER-TAKEN-LATE-STARTS-ONLY-WHEN-NOTHING-CONTAINS-THE-START', async () => {
      const { siteId, schedule } = await shiftSite(A, 'Judged yard', 30);
      const shiftId = await mkShift(A.id, siteId, cara.id, Z('2026-11-13T08:00:00Z'), Z('2026-11-13T10:00:00Z'));
      await bookOn(shiftId, cara.id, Z('2026-11-13T07:55:00Z'));
      // A scheduled run covers 08:00–08:30; an ad-hoc start in it is never linked.
      const sched = expect(await start(cara, shiftId, '2026-11-13T08:02:00Z', { scheduleId: Number(schedule.id) }), 201);
      await complete(cara, sched.id, '2026-11-13T08:10:00Z');
      const extra = expect(await start(cara, shiftId, '2026-11-13T08:15:00Z'), 201);
      assert.deepEqual([extra.windowKey, (await auditsFor(extra.id))[0].afterData.outcome], [null, 'covered']);
      await complete(cara, extra.id, '2026-11-13T08:20:00Z');
      // 08:30–09:00 is judged missed (deadline 09:15); a start at 09:10 (within the grace, nothing else contains it? 09:00–09:30 does) …
      await sweep('2026-11-13T09:16:00Z');
      const missed = (await missedOf(A.id)).filter((m: any) => m.scopeKey === `sh${shiftId}`);
      assert.deepEqual(missed.map((m: any) => new Date(m.windowStart).toISOString()), ['2026-11-13T08:30:00.000Z']);
      const before = await one(`SELECT * FROM patrol_exceptions WHERE id = $1`, [missed[0].id]);
      // … is linked to 09:00–09:30, which contains it — never moved back to the missed one.
      const inNext = expect(await start(cara, shiftId, '2026-11-13T09:10:00Z'), 201);
      assert.equal(inNext.windowStart, '2026-11-13T09:00:00.000Z');
      await complete(cara, inNext.id, '2026-11-13T09:12:00Z');
      // A missed window with nothing else open: the late start is NOT linked; the exception is untouched.
      const lone = await mkSite(A.id, 'Lone yard');
      expect(await setup(A.token, lone, { setupMode: 'every_shift', evidenceMode: 'photo', frequencyMinutes: 60 }), 200);
      await activate(A, lone, '2026-01-01T00:00:00Z');
      const ls = await mkShift(A.id, lone, cara.id, Z('2026-11-14T08:00:00Z'), Z('2026-11-14T09:00:00Z'));
      await bookOn(ls, cara.id, Z('2026-11-14T07:55:00Z'));
      await sweep('2026-11-14T09:15:30Z');
      const loneMissed = (await missedOf(A.id)).find((m: any) => m.scopeKey === `sh${ls}`);
      assert.ok(loneMissed, 'judged missed');
      const r = expect(await start(cara, ls, '2026-11-14T09:05:00Z'), 201, undefined, 'within the grace after the window ended');
      assert.deepEqual([r.windowKey, (await auditsFor(r.id))[0].afterData.outcome], [null, 'missed'], 'a missed outcome is never overwritten');
      const after = await one(`SELECT * FROM patrol_exceptions WHERE id = $1`, [loneMissed.id]);
      assert.deepEqual([after.status, after.runId, after.lateEvidenceAt, after.annotations], [loneMissed.status, loneMissed.runId, loneMissed.lateEvidenceAt, loneMissed.annotations], 'never annotated or closed');
      assert.deepEqual([before.status, before.runId], [(await one(`SELECT * FROM patrol_exceptions WHERE id = $1`, [missed[0].id])).status, null]);
      // Late tier: no window contains the start, one ended within the grace and is free → linked, late.
      const lateSite = await mkSite(A.id, 'Late yard');
      expect(await setup(A.token, lateSite, { setupMode: 'every_shift', evidenceMode: 'photo', frequencyMinutes: 60 }), 200);
      await activate(A, lateSite, '2026-01-01T00:00:00Z');
      const lsh = await mkShift(A.id, lateSite, ben.id, Z('2026-11-15T08:00:00Z'), Z('2026-11-15T09:00:00Z'));
      await bookOn(lsh, ben.id, Z('2026-11-15T07:55:00Z'));
      const lr = expect(await start(ben, lsh, '2026-11-15T09:05:00Z'), 201);
      assert.deepEqual([lr.windowStart, lr.lateStart], ['2026-11-15T08:00:00.000Z', true], 'linked late');
    });

    await test('PA-06-NO-CROSS-COMPANY-OR-CROSS-SHIFT-ASSIGNMENT', async () => {
      // Company B's schedule at the same times on its own site is never a candidate for A's Guard.
      const bSite = await mkSite(B.id, 'Bravo yard');
      expect(await api('PUT', `/patrols/policies/sites/${bSite}`, B.token, { methods: ['photo'], photosPerRun: 1 }), 200);
      await clockSchedule(B, bSite, { activeFrom: '08:00', activeTo: '12:00', frequencyMinutes: 60, windowMinutes: 60 });
      const aSite = await mkSite(A.id, 'Alpha bare yard');
      const s = await mkShift(A.id, aSite, ava.id, Z('2026-11-16T08:00:00Z'), Z('2026-11-16T12:00:00Z'));
      const r = expect(await start(ava, s, '2026-11-16T09:05:00Z'), 201);
      assert.deepEqual([r.scheduleId, r.windowKey, r.windowAssignment.outcome], [null, null, 'ad_hoc']);
      assert.equal((await auditsFor(r.id))[0].afterData.outcome, 'none');
      // Another shift's shift-anchored window at the same site is never this shift's candidate.
      const { siteId } = await shiftSite(A, 'Two shifts yard', 30);
      const early = await mkShift(A.id, siteId, ben.id, Z('2026-11-16T08:00:00Z'), Z('2026-11-16T09:00:00Z'));
      const unrequired = await mkShift(A.id, siteId, cara.id, Z('2026-11-16T08:00:00Z'), Z('2026-11-16T09:00:00Z'));
      await q(`UPDATE shifts SET "patrolRequirement" = 'not_required' WHERE id = $1`, [unrequired]);
      void early;
      const c = expect(await start(cara, unrequired, '2026-11-16T08:05:00Z'), 201);
      assert.deepEqual([c.windowKey, (await auditsFor(c.id))[0].afterData.outcome], [null, 'none'], 'Ben\'s shift windows are Ben\'s; Cara\'s shift owes none');
      // A Guard cannot start on someone else's shift (unchanged).
      expect(await start(cara, early, '2026-11-16T08:06:00Z'), 404, undefined, 'not the Guard\'s shift');
    });

    await test('PA-07-EXPLICIT-STARTS-ARE-UNCHANGED-AND-NO-OPEN-WINDOW-STAYS-AD-HOC', async () => {
      const { siteId, schedule } = await shiftSite(A, 'Explicit yard', 30);
      const shiftId = await mkShift(A.id, siteId, ava.id, Z('2026-11-17T08:00:00Z'), Z('2026-11-17T09:00:00Z'));
      await bookOn(shiftId, ava.id, Z('2026-11-17T07:55:00Z'));
      const r = expect(await start(ava, shiftId, '2026-11-17T08:03:00Z', { scheduleId: Number(schedule.id) }), 201);
      assert.ok(r.windowKey && !r.syncFlags.some((f: string) => C.PATROL_ASSIGNMENT_FLAGS.includes(f as never)));
      assert.deepEqual(r.windowAssignment, { outcome: 'scheduled', message: 'Started for its scheduled patrol window.' });
      assert.equal((await auditsFor(r.id)).length, 0, 'no assignment audit for an explicit start');
      await complete(ava, r.id, '2026-11-17T08:10:00Z');
      // A start before the shift's first window: nothing open → ad hoc ("none").
      const early = await mkShift(A.id, siteId, ben.id, Z('2026-11-17T12:00:00Z'), Z('2026-11-17T13:00:00Z'));
      const e = expect(await start(ben, early, '2026-11-17T11:55:00Z'), 201);
      assert.deepEqual([e.windowKey, e.windowAssignment.outcome], [null, 'ad_hoc']);
    });

    await test('PA-08-THE-MONITOR-SHOWS-AD-HOC-PATROLS-IN-THEIR-HOUR-NEVER-COUNTED-AND-LATER-WINDOWS-APART', async () => {
      const { siteId } = await shiftSite(A, 'Monitor yard', 30);
      await clockSchedule(A, siteId, { activeFrom: '10:00', activeTo: '11:00', frequencyMinutes: 60, windowMinutes: 60 });
      const shiftId = await mkShift(A.id, siteId, ava.id, Z('2026-11-18T10:10:00Z'), Z('2026-11-18T11:10:00Z'));
      await bookOn(shiftId, ava.id, Z('2026-11-18T10:05:00Z'));
      const r = expect(await start(ava, shiftId, '2026-11-18T10:20:00Z'), 201, undefined, 'ambiguous → ad hoc');
      assert.equal(r.windowKey, null);
      // As on a live day: S4 received it seconds after the device started it (the Monitor reads ad-hoc runs by their receipt).
      await q(`UPDATE patrol_runs SET "startedAtServer" = "startedAtDevice" WHERE id = $1`, [r.id]);
      const v = expect(await api('GET', `/patrols/monitor/sites/${siteId}?date=2026-11-18`, A.token), 200);
      const other = v.otherRuns.find((o: any) => o.runId === r.id);
      const shiftLane = v.lanes.find((l: any) => l.kind === 'shift' && l.shiftId === shiftId);
      assert.deepEqual([other.reason, other.explanation, other.laneKey, other.hour], ['unscheduled', 'ambiguous', shiftLane.key, 10]);
      const cell = shiftLane.cells.find((c: any) => c.hour === 10);
      assert.deepEqual([cell.total, cell.verified, cell.adHoc], [2, 0, 1], 'shown in the hour, not counted');
      const w = shiftLane.windows.find((x: any) => x.start === '2026-11-18T10:10:00.000Z');
      assert.deepEqual(w.adHocRunIds, [r.id], 'the window it was received in names it');
      assert.equal(typeof cell.later, 'number', 'later windows counted apart');
      assert.equal(v.counts.verified, 0, 'an ad-hoc patrol never counts');
    });
  } finally {
    await app.close();
  }
  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`);
  console.log(JSON.stringify({ event: 'patrol_assignment_certified', tests: passed }));
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
