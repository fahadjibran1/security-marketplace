/**
 * Patrols outage reconciliation (issue #67, Migration 71) certification: the patrol sweep's per-company watermark and the
 * bounded, audited catch-up of missed-patrol detection after a gap longer than the normal lookback. The whole application
 * (HTTP for the company API) plus the sweep called directly on a chosen clock, on a disposable database built from the
 * repository's own migrations. The sweep's and the safety sweep's timers are stopped so every pass is explicit, and only
 * the company under test has Patrols switched on during its passes.
 *
 *   PR-01  the first pass sets the watermark (nothing backdated); short gaps are absorbed by the live pass (no run)
 *   PR-02  30 h outage: one run, completed in one pass; the windows the old lookback lost are judged — deadlines older than
 *          now − 26 h by reconciliation (marked, no per-window alert, one site summary alert), the rest live (alerted)
 *   PR-03  5-day outage, two sites: bounded batches (≤ 6 h of deadlines, ≤ 8 per pass), resumable across passes, exact
 *          expected set, one summary alert per site (content: count, range, ten listed windows, "and N more")
 *   PR-04  20-day outage: deadlines older than the 14-day horizon are NOT judged — recorded on the run, audited, ONE
 *          explicit alert; the 14 days within the horizon are reconciled; never a silent drop
 *   PR-05  crash mid-batch: the batch rolls back (watermark, run and exceptions agree); the next pass resumes; no duplicates
 *   PR-06  concurrent sweeps (Promise.all) and a replayed watermark: one run at a time, no duplicate exception or alert
 *   PR-07  DST night inside the gap (UK clocks back, 25 Oct 2026): one exception per real window, 8 on that night
 *   PR-08  late-synced runs inside the gap satisfy their windows; the switch-on time still bounds what is judged
 *   PR-09  reconciled exceptions through the API (reconciliationRunId, resolvable on their own); the summary alert closes
 *          through the existing alert lifecycle without touching them; audit trail (started / batch / completed counts)
 *   PR-10  a batch judges at most 500 windows (ties at the cut-off kept together); the next batch continues from there
 *
 * Needs PATROL_RECONCILIATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

const url = process.env.PATROL_RECONCILIATION_DATABASE_URL;
if (!url) throw new Error('PATROL_RECONCILIATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Patrol reconciliation database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-reconciliation-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.RESEND_API_KEY;
delete process.env.EXPO_ACCESS_TOKEN;
delete process.env.PUSH_WELFARE_REMINDERS_ENABLED;
delete process.env.PUSH_GUARD_NOTIFICATIONS_ENABLED;
delete process.env.PATROL_QR_SIGNING_KEY;
delete process.env.PATROL_QR_PREVIOUS_SIGNING_KEY;

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
const PASSWORD = 'patrol-reconciliation-spec-only-password-1';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const L = 26 * HOUR;
const GRACE = 15 * MIN; // the default start grace
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
  assert.equal(migrated[migrated.length - 1]?.name, 'AddPatrolSyncRecoveryGrants1720900000018', 'the head is Migration 72 (#68); reconciliation is Migration 71');
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
  const sweepModule = await import('../src/patrol/patrol-sweep.service');
  const { PatrolSweepService, PATROL_RECONCILIATION_BATCH_HOURS, PATROL_RECONCILIATION_BATCHES_PER_PASS, PATROL_RECONCILIATION_HORIZON_DAYS } = sweepModule;
  const { PatrolExceptionService } = await import('../src/patrol/patrol-exception.service');
  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const { AuthService } = await import('../src/auth/auth.service');
  const W = await import('../src/patrol/patrol-window.service');
  const sweeper = app.get(PatrolSweepService);
  const exceptionsSvc = app.get(PatrolExceptionService);
  app.get(SafetyAlertService).onModuleDestroy();
  sweeper.onModuleDestroy(); // every sweep in this suite is explicit, on its own clock
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
  const expect = (r: Res, status: number, what = '') => assert.equal(r.status, status, `${what} expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;

  // ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash(PASSWORD, 4);
  let seq = 0;
  const mkUser = async (email: string, role: string) =>
    Number((await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
       VALUES ($1,$2,$3,'active',true,false,$4,'Spec') RETURNING id`, [email, hash, role, email.split('@')[0]])).id);
  const mkGuard = async (label: string) => {
    seq += 1;
    const userId = await mkUser(`pr.${label}@example.invalid`, 'guard');
    const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, `Guard ${label}`, `71${String(seq).padStart(14, '0')}`, `0773${String(seq).padStart(7, '0')}`]);
    return { id: Number(id), userId };
  };
  const mkSchedule = async (companyId: number, siteId: number, s: { name: string; from: string; to: string; freq: number }) =>
    one(`INSERT INTO patrol_schedules ("companyId","siteId",name,"daysOfWeek","activeFrom","activeTo","frequencyMinutes","windowMinutes","createdAt","updatedAt")
       VALUES ($1,$2,$3,'[1,2,3,4,5,6,7]'::jsonb,$4,$5,$6,$6,'2026-01-01','2026-01-01') RETURNING *`,
      [companyId, siteId, s.name, s.from, s.to, s.freq]);
  /** A company whose Guard is booked on for the whole period at each site, with an hourly 08:00–20:00 schedule per site. */
  const scenario = async (label: string, from: Date, to: Date, opts: { sites?: number; schedule?: { from: string; to: string; freq?: number } } = {}) => {
    seq += 1;
    const ownerEmail = `pr.${label}.owner@example.invalid`;
    const ownerId = await mkUser(ownerEmail, 'company_admin');
    const co = Number((await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,$2,$3,'1 Way','ops@example.invalid',false) RETURNING id`,
      [ownerId, `PR ${label} Ltd`, String(71000000 + seq)])).id);
    const sites: Array<{ id: number; name: string; schedule: any; shift: number }> = [];
    for (let i = 0; i < (opts.sites ?? 1); i += 1) {
      const name = `${label} Gate ${String.fromCharCode(65 + i)}`;
      const site = Number((await one(`INSERT INTO sites ("companyId",name,address,timezone) VALUES ($1,$2,'3 Quay','Europe/London') RETURNING id`, [co, name])).id);
      const guard = await mkGuard(`${label}${i}`);
      const shift = Number((await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,$3,$4,'in_progress',$5,$6) RETURNING id`,
        [co, site, name, guard.id, new Date(from.getTime() - 2 * DAY), new Date(to.getTime() + 30 * DAY)])).id);
      await q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-in',$3,$3,false)`,
        [shift, guard.id, new Date(from.getTime() - 2 * DAY)]);
      const schedule = await mkSchedule(co, site, { name: `Hourly ${i + 1}`, from: opts.schedule?.from ?? '08:00', to: opts.schedule?.to ?? '20:00', freq: opts.schedule?.freq ?? 60 });
      sites.push({ id: site, name, schedule, shift });
    }
    return { co, ownerEmail, sites };
  };
  /** Only this company's switch is on, so a sweep judges only it. */
  const focus = (companyId: number) => q(`UPDATE companies SET "patrolsEnabled" = (id = $1)`, [companyId]);
  const sweep = (at: Date, options?: { reconciliationBatches?: number }) => sweeper.sweep(at, options);
  /** Passes five minutes apart until the company has no running reconciliation (bounded). */
  const sweepUntilCaughtUp = async (co: number, at: Date, maxPasses = 20) => {
    let t = at.getTime();
    for (let i = 0; i < maxPasses; i += 1) {
      await sweep(new Date(t));
      if (!(await count(`SELECT count(*) FROM patrol_reconciliation_runs WHERE "companyId" = $1 AND status = 'running'`, [co]))) return { passes: i + 1, at: new Date(t) };
      t += 5 * MIN;
    }
    throw new Error('reconciliation did not complete');
  };
  /** Independent expectation: the schedule's windows starting at/after startFloor with start deadline in (dFrom, dTo]. */
  const expectedKeys = (schedule: any, startFloor: Date, dFrom: Date | null, dTo: Date) =>
    W.windowsBetween(schedule, 'Europe/London', startFloor, dTo)
      .filter((w) => w.start.getTime() >= startFloor.getTime())
      .filter((w) => w.end.getTime() + GRACE <= dTo.getTime() && (!dFrom || w.end.getTime() + GRACE > dFrom.getTime()))
      .map((w) => w.windowKey).sort();
  const exceptionsOf = (co: number) => q(`SELECT * FROM patrol_exceptions WHERE "companyId" = $1 ORDER BY "windowKey", "scopeKey", type, id`, [co]);
  const keysOf = (rows: any[]) => rows.filter((r) => r.type === 'patrol_missed').map((r) => r.windowKey).sort();
  const runsOf = (co: number) => q(`SELECT * FROM patrol_reconciliation_runs WHERE "companyId" = $1 ORDER BY id`, [co]);
  const watermarkOf = async (co: number) => {
    const row = await one(`SELECT "judgedThrough" FROM patrol_sweep_watermarks WHERE "companyId" = $1`, [co]);
    return row ? new Date(row.judgedThrough) : null;
  };
  const reconAlertsOf = (co: number) => q(`SELECT * FROM safety_alerts WHERE "companyId" = $1 AND "patrolReconciliationRunId" IS NOT NULL ORDER BY id`, [co]);
  const windowAlertsOf = (co: number) => q(`SELECT * FROM safety_alerts WHERE "companyId" = $1 AND "patrolExceptionId" IS NOT NULL ORDER BY id`, [co]);
  const auditsOf = (co: number, action: string) => q(`SELECT * FROM audit_logs WHERE "companyId" = $1 AND action = $2 ORDER BY id`, [co, action]);
  const noDuplicates = async (co: number) => {
    const ex = await exceptionsOf(co);
    const keys = ex.map((e: any) => `${e.windowKey}|${e.scopeKey}|${e.type}`);
    assert.equal(new Set(keys).size, keys.length, 'one exception per (window, scope, type)');
    const alerts = await windowAlertsOf(co);
    assert.equal(new Set(alerts.map((a: any) => a.patrolExceptionId)).size, alerts.length, 'one alert per exception');
    const recon = await reconAlertsOf(co);
    assert.equal(new Set(recon.map((a: any) => `${a.patrolReconciliationRunId}|${a.patrolWindowKey}`)).size, recon.length, 'one reconciliation alert per (run, key)');
  };

  // A Monday morning (BST, UTC+1): 05:00Z is 06:00 local, before the first window of the day.
  const T1 = new Date('2026-10-05T05:00:00Z');

  try {
    await test('PR-01-FIRST-PASS-SETS-THE-WATERMARK-AND-SHORT-GAPS-NEED-NO-RECONCILIATION', async () => {
      const s = await scenario('r01', T1, new Date(T1.getTime() + 2 * DAY));
      await focus(s.co);
      const sched = s.sites[0].schedule;
      await sweep(T1);
      assert.equal((await watermarkOf(s.co))?.toISOString(), T1.toISOString(), 'the first pass sets judgedThrough = now');
      assert.deepEqual(keysOf(await exceptionsOf(s.co)), expectedKeys(sched, new Date(T1.getTime() - L), null, T1), 'nothing older than today\'s lookback is backdated');
      // A 20-hour gap (within the lookback): the live pass absorbs it, no run.
      const T2 = new Date(T1.getTime() + 20 * HOUR);
      const c = await sweep(T2);
      assert.equal(c.reconciliationsStarted, 0);
      assert.equal((await runsOf(s.co)).length, 0);
      assert.equal((await watermarkOf(s.co))?.toISOString(), T2.toISOString());
      assert.deepEqual(keysOf(await exceptionsOf(s.co)), expectedKeys(sched, new Date(T1.getTime() - L), null, T2), 'every due window judged');
      assert.ok((await exceptionsOf(s.co)).every((e: any) => e.reconciliationRunId === null && e.safetyAlertId !== null), 'live exceptions alert as before');
      await noDuplicates(s.co);
    });

    await test('PR-02-30-HOUR-OUTAGE-NOTHING-THE-OLD-LOOKBACK-LOST-IS-LOST', async () => {
      const s = await scenario('r02', T1, new Date(T1.getTime() + 2 * DAY));
      await focus(s.co);
      const sched = s.sites[0].schedule;
      await sweep(T1);
      const T2 = new Date(T1.getTime() + 30 * HOUR);
      const c = await sweep(T2);
      assert.deepEqual([c.reconciliationsStarted, c.reconciliationsCompleted, c.reconciliationBatches], [1, 1, 1], JSON.stringify(c));
      const all = await exceptionsOf(s.co);
      assert.deepEqual(keysOf(all), expectedKeys(sched, new Date(T1.getTime() - L), null, T2), 'every window due by now is judged exactly once');
      const reconciled = all.filter((e: any) => e.reconciliationRunId !== null);
      const expectedRecon = expectedKeys(sched, new Date(T1.getTime() - L), T1, new Date(T2.getTime() - L));
      assert.deepEqual(keysOf(reconciled), expectedRecon, 'deadlines older than now − 26 h are reconciled');
      assert.deepEqual(expectedRecon.length, 1, 'here: the 08:00–09:00 window of the first day (deadline 09:15 local)');
      // The old sweep's lookback (window START ≥ now − 26 h) would never have judged these two windows.
      const lostBefore = W.windowsBetween(sched, 'Europe/London', new Date(T1.getTime()), new Date(T2.getTime() - L))
        .filter((w) => w.start.getTime() < T2.getTime() - L && w.end.getTime() + GRACE > T1.getTime()).map((w) => w.windowKey).sort();
      assert.equal(lostBefore.length, 2);
      assert.ok(lostBefore.every((k) => all.some((e: any) => e.windowKey === k)), 'both are now recorded');
      assert.ok(reconciled.every((e: any) => e.safetyAlertId === null && /outage reconciliation/.test(e.note)), 'reconciled: marked, no alert of its own');
      assert.ok(all.filter((e: any) => e.reconciliationRunId === null).every((e: any) => e.safetyAlertId !== null), 'live: one alert each');
      const [run] = await runsOf(s.co);
      assert.deepEqual([run.status, Number(run.windowsJudged), Number(run.exceptionsRaised), run.unjudgedFrom], ['completed', 1, 1, null]);
      assert.equal(new Date(run.fromAt).toISOString(), T1.toISOString());
      const recon = await reconAlertsOf(s.co);
      assert.equal(recon.length, 1, 'one summary alert for the site');
      assert.deepEqual([recon[0].type, recon[0].priority, recon[0].status, recon[0].patrolWindowKey], ['patrol_missed', 'high', 'open', `reconciliation:site:${s.sites[0].id}`]);
      assert.match(recon[0].message, /^Patrol reconciliation after an outage: 1 patrol window was missed at r02 Gate A between Mon 5 Oct 08:00 and Mon 5 Oct 09:00/);
      assert.equal((await watermarkOf(s.co))?.toISOString(), T2.toISOString(), 'caught up: judgedThrough = now');
      // The next pass is normal again.
      const c3 = await sweep(new Date(T2.getTime() + 5 * MIN));
      assert.equal(c3.reconciliationsStarted, 0);
      await noDuplicates(s.co);
    });

    await test('PR-03-5-DAY-OUTAGE-TWO-SITES-BOUNDED-RESUMABLE-BATCHES-AND-ONE-SUMMARY-PER-SITE', async () => {
      const s = await scenario('r03', T1, new Date(T1.getTime() + 6 * DAY), { sites: 2 });
      await focus(s.co);
      await sweep(T1);
      const T2 = new Date(T1.getTime() + 5 * DAY);
      const first = await sweep(T2);
      assert.equal(first.reconciliationBatches, PATROL_RECONCILIATION_BATCHES_PER_PASS, 'bounded per pass');
      assert.equal(first.reconciliationsCompleted, 0, 'not yet caught up');
      const [running] = await runsOf(s.co);
      assert.equal(running.status, 'running');
      const wm = await watermarkOf(s.co);
      assert.equal(wm!.getTime(), T1.getTime() + PATROL_RECONCILIATION_BATCHES_PER_PASS * PATROL_RECONCILIATION_BATCH_HOURS * HOUR, 'the watermark moved exactly with the committed batches');
      assert.equal(new Date(running.throughAt).getTime(), wm!.getTime(), 'run and watermark agree');
      // Normal alerting continued meanwhile: recent windows were judged live and alerted.
      const liveSoFar = (await exceptionsOf(s.co)).filter((e: any) => e.reconciliationRunId === null && new Date(e.windowEnd).getTime() + GRACE > T2.getTime() - L);
      assert.ok(liveSoFar.length > 0 && liveSoFar.every((e: any) => e.safetyAlertId), 'live windows alerted during the catch-up');
      const done = await sweepUntilCaughtUp(s.co, new Date(T2.getTime() + 5 * MIN));
      assert.equal(done.passes, 1, 'the rest in the next pass');
      const [run] = await runsOf(s.co);
      assert.equal(run.status, 'completed');
      const batches = await auditsOf(s.co, 'patrol.reconciliation_batch');
      assert.equal(batches.length, Number(run.batches));
      for (const b of batches) {
        const span = new Date(b.afterData.deadlinesThrough).getTime() - new Date(b.afterData.deadlinesFrom).getTime();
        assert.ok(span > 0 && span <= PATROL_RECONCILIATION_BATCH_HOURS * HOUR, 'each batch ≤ 6 h of deadlines');
        assert.ok(b.afterData.windowsJudged <= 500);
      }
      const all = await exceptionsOf(s.co);
      for (const site of s.sites) {
        const ofSite = all.filter((e: any) => Number(e.siteId) === site.id);
        assert.deepEqual(keysOf(ofSite), expectedKeys(site.schedule, new Date(T1.getTime() - L), null, done.at), `${site.name}: every due window judged once`);
        const recon = ofSite.filter((e: any) => e.reconciliationRunId !== null);
        assert.deepEqual(keysOf(recon), expectedKeys(site.schedule, new Date(T1.getTime() - L), T1, new Date(T2.getTime() - L)), `${site.name}: the gap is reconciled`);
        const [summary] = (await reconAlertsOf(s.co)).filter((a: any) => a.patrolWindowKey === `reconciliation:site:${site.id}`);
        assert.ok(summary, `${site.name}: a summary alert`);
        const n = recon.length;
        assert.ok(n > 10);
        assert.match(summary.message, new RegExp(`^Patrol reconciliation after an outage: ${n} patrol windows were missed at ${site.name} between Mon 5 Oct 08:00 and `));
        assert.match(summary.message, new RegExp(`Mon 5 Oct 08:00–09:00 Hourly \\d; Mon 5 Oct 09:00–10:00 Hourly \\d;.*; and ${n - 10} more\\. Review each in Patrols → Exceptions\\.$`));
        assert.equal((summary.message.match(/Hourly \d/g) ?? []).length, 10, 'ten windows listed by name');
      }
      assert.equal((await reconAlertsOf(s.co)).length, 2, 'exactly one summary alert per site');
      assert.deepEqual([Number(run.exceptionsRaised), Number(run.windowsJudged)], [all.filter((e: any) => e.reconciliationRunId).length, all.filter((e: any) => e.reconciliationRunId).length]);
      await noDuplicates(s.co);
    });

    await test('PR-04-20-DAY-OUTAGE-BEYOND-THE-HORIZON-IS-RECORDED-NOT-JUDGED-WITH-ONE-ALERT', async () => {
      const s = await scenario('r04', T1, new Date(T1.getTime() + 21 * DAY));
      await focus(s.co);
      const sched = s.sites[0].schedule;
      await sweep(T1);
      const T2 = new Date(T1.getTime() + 20 * DAY);
      const horizon = new Date(T2.getTime() - PATROL_RECONCILIATION_HORIZON_DAYS * DAY);
      const done = await sweepUntilCaughtUp(s.co, T2);
      assert.ok(done.passes >= 7, `14 days at ≤ 48 h per pass: ${done.passes}`);
      const runs = await runsOf(s.co);
      assert.equal(runs.length, 1);
      const [run] = runs;
      assert.deepEqual([new Date(run.unjudgedFrom).toISOString(), new Date(run.unjudgedTo).toISOString(), new Date(run.fromAt).toISOString(), Number(run.horizonDays)],
        [T1.toISOString(), horizon.toISOString(), horizon.toISOString(), 14], 'the range beyond the horizon is recorded on the run');
      const all = await exceptionsOf(s.co);
      const unjudged = W.windowsBetween(sched, 'Europe/London', T1, horizon).filter((w) => w.end.getTime() + GRACE > T1.getTime() && w.end.getTime() + GRACE <= horizon.getTime());
      assert.ok(unjudged.length > 50, `six days of windows: ${unjudged.length}`);
      assert.ok(unjudged.every((w) => !all.some((e: any) => e.windowKey === w.windowKey)), 'nothing beyond the horizon is judged (it is reported instead)');
      assert.deepEqual(keysOf(all.filter((e: any) => e.reconciliationRunId)), expectedKeys(sched, new Date(horizon.getTime() - L), horizon, new Date(T2.getTime() - L)),
        'the 14 days within the horizon are reconciled');
      const horizonAlerts = (await reconAlertsOf(s.co)).filter((a: any) => a.patrolWindowKey === 'reconciliation:horizon');
      assert.equal(horizonAlerts.length, 1, 'ONE explicit alert');
      assert.match(horizonAlerts[0].message, /^Patrol checks were NOT run for Mon 5 Oct 06:00 to .* \(Europe\/London\): .*14-day reconciliation limit, so missed patrols in that period are not recorded\./);
      const audit = await auditsOf(s.co, 'patrol.reconciliation_horizon_exceeded');
      assert.equal(audit.length, 1);
      assert.deepEqual([audit[0].afterData.unjudgedFrom, audit[0].afterData.unjudgedTo, audit[0].afterData.judged, audit[0].afterData.safetyAlertId],
        [T1.toISOString(), horizon.toISOString(), false, Number(horizonAlerts[0].id)]);
      const completed = (await auditsOf(s.co, 'patrol.reconciliation_completed'))[0];
      assert.deepEqual([completed.afterData.unjudgedFrom, completed.afterData.unjudgedTo], [T1.toISOString(), horizon.toISOString()]);
      await noDuplicates(s.co);
    });

    await test('PR-05-CRASH-MID-BATCH-ROLLS-BACK-AND-THE-NEXT-PASS-RESUMES-WITHOUT-DUPLICATES', async () => {
      const s = await scenario('r05', T1, new Date(T1.getTime() + 6 * DAY));
      await focus(s.co);
      const sched = s.sites[0].schedule;
      await sweep(T1);
      const T2 = new Date(T1.getTime() + 5 * DAY);
      const realRaise = exceptionsSvc.raise.bind(exceptionsSvc);
      let reconciledCalls = 0;
      (exceptionsSvc as any).raise = async (manager: any, input: any) => {
        if (input.reconciliationRunId && ++reconciledCalls === 6) throw new Error('simulated crash in the middle of batch 2');
        return realRaise(manager, input);
      };
      try {
        await assert.rejects(() => sweep(T2), /simulated crash/);
      } finally {
        (exceptionsSvc as any).raise = realRaise;
      }
      const [run] = await runsOf(s.co);
      const wm = await watermarkOf(s.co);
      assert.equal(wm!.getTime(), T1.getTime() + PATROL_RECONCILIATION_BATCH_HOURS * HOUR, 'only batch 1 committed');
      assert.equal(new Date(run.throughAt).getTime(), wm!.getTime(), 'run and watermark agree');
      const recon = (await exceptionsOf(s.co)).filter((e: any) => e.reconciliationRunId);
      assert.equal(recon.length, 3, 'batch 1 (09:15, 10:15, 11:15 local) kept; batch 2\'s partial work rolled back');
      assert.equal(Number(run.exceptionsRaised), 3);
      assert.ok(recon.every((e: any) => new Date(e.windowEnd).getTime() + GRACE <= wm!.getTime()), 'nothing beyond the watermark');
      const done = await sweepUntilCaughtUp(s.co, new Date(T2.getTime() + 5 * MIN));
      assert.deepEqual(keysOf(await exceptionsOf(s.co)), expectedKeys(sched, new Date(T1.getTime() - L), null, done.at), 'resumed to the exact expected set');
      assert.equal((await runsOf(s.co)).length, 1, 'the same run resumed');
      await noDuplicates(s.co);
    });

    await test('PR-06-CONCURRENT-SWEEPS-AND-A-REPLAYED-WATERMARK-NEVER-DUPLICATE', async () => {
      const s = await scenario('r06', T1, new Date(T1.getTime() + 6 * DAY));
      await focus(s.co);
      const sched = s.sites[0].schedule;
      await sweep(T1);
      const T2 = new Date(T1.getTime() + 5 * DAY);
      const results = await Promise.all([sweep(T2), sweep(T2), sweep(T2)]);
      assert.ok(results.some((r) => r.reconciliationBatches > 0));
      assert.equal((await runsOf(s.co)).length, 1, 'one run, however many sweeps');
      const done = await sweepUntilCaughtUp(s.co, new Date(T2.getTime() + 5 * MIN));
      const snapshot = { ex: (await exceptionsOf(s.co)).length, alerts: (await windowAlertsOf(s.co)).length, recon: (await reconAlertsOf(s.co)).length };
      assert.deepEqual(keysOf(await exceptionsOf(s.co)), expectedKeys(sched, new Date(T1.getTime() - L), null, done.at));
      await noDuplicates(s.co);
      // Replay: the watermark is put back (e.g. restored from an older backup). A new run re-judges the gap; everything it
      // finds already exists, so nothing new is raised and no summary alert is needed.
      await q(`UPDATE patrol_sweep_watermarks SET "judgedThrough" = $2 WHERE "companyId" = $1`, [s.co, T1]);
      await sweepUntilCaughtUp(s.co, new Date(done.at.getTime() + 5 * MIN));
      assert.equal((await runsOf(s.co)).length, 2);
      assert.deepEqual({ ex: (await exceptionsOf(s.co)).length, alerts: (await windowAlertsOf(s.co)).length, recon: (await reconAlertsOf(s.co)).length }, snapshot,
        'idempotent: no exception or alert added');
      await noDuplicates(s.co);
    });

    await test('PR-07-DST-NIGHT-INSIDE-THE-GAP-ONE-EXCEPTION-PER-REAL-WINDOW', async () => {
      // UK clocks go back at 02:00 BST on Sunday 25 Oct 2026; an hourly 22:00–06:00 schedule has 8 real windows that night.
      const D1 = new Date('2026-10-23T12:00:00Z');
      const s = await scenario('r07', D1, new Date(D1.getTime() + 6 * DAY), { schedule: { from: '22:00', to: '06:00' } });
      await focus(s.co);
      const sched = s.sites[0].schedule;
      await sweep(D1);
      const D2 = new Date(D1.getTime() + 5 * DAY);
      const done = await sweepUntilCaughtUp(s.co, D2);
      const all = await exceptionsOf(s.co);
      assert.deepEqual(keysOf(all), expectedKeys(sched, new Date(D1.getTime() - L), null, done.at));
      const night = all.filter((e: any) => e.windowKey.includes(':2026-10-24:'));
      assert.equal(night.length, 8, 'the night of 24–25 Oct: 8 windows (the 01:00 slot is two real hours)');
      assert.ok(night.every((e: any) => e.reconciliationRunId), 'all inside the reconciled gap');
      const ordinary = all.filter((e: any) => e.windowKey.includes(':2026-10-23:'));
      assert.equal(ordinary.length, 8, 'an ordinary night: 8 windows');
      await noDuplicates(s.co);
    });

    await test('PR-08-LATE-SYNCED-RUNS-SATISFY-THEIR-WINDOWS-AND-THE-SWITCH-ON-TIME-BOUNDS-JUDGING', async () => {
      const s = await scenario('r08', T1, new Date(T1.getTime() + 6 * DAY));
      await focus(s.co);
      const sched = s.sites[0].schedule;
      const site = s.sites[0];
      await sweep(T1);
      const T2 = new Date(T1.getTime() + 5 * DAY);
      // Patrols was switched off and on again during the outage: windows before the switch-on are not judged.
      const enabledAt = new Date(T1.getTime() + 3 * DAY);
      // Two windows inside the reconciled gap were patrolled; the runs reached the server only after the outage (late sync).
      const lateWindows = W.windowsBetween(sched, 'Europe/London', enabledAt, new Date(enabledAt.getTime() + DAY))
        .filter((w) => w.start.getTime() >= enabledAt.getTime()).slice(0, 2);
      assert.equal(lateWindows.length, 2);
      const guard = await one(`SELECT s."guardId", g."userId" FROM shifts s JOIN guard_profiles g ON g.id = s."guardId" WHERE s.id = $1`, [site.shift]);
      for (const w of lateWindows) {
        await q(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","scheduleId","windowKey","windowStart","windowEnd","scopeKey",
            status,"startedAtDevice","startedAtServer","completedAtDevice","completedAtServer","clientRunId","syncedLate","provisional")
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'site','completed',$10,$11,$12,$11,$13,true,true)`,
          [s.co, site.id, site.shift, guard.guardId, guard.userId, sched.id, w.windowKey, w.start, w.end, new Date(w.start.getTime() + 5 * MIN), T2,
            new Date(w.start.getTime() + 25 * MIN), cid('late')]);
      }
      await q(`INSERT INTO audit_logs ("companyId",action,"entityType","entityId","afterData","createdAt") VALUES ($1,'company.patrols_enabled_changed','company',$1,'{"patrolsEnabled":true}',$2)`,
        [s.co, enabledAt]);
      const done = await sweepUntilCaughtUp(s.co, T2);
      const all = await exceptionsOf(s.co);
      const lateKeys = lateWindows.map((w) => w.windowKey);
      assert.ok(lateKeys.every((k) => !all.some((e: any) => e.windowKey === k && e.type === 'patrol_missed')), 'late-synced runs satisfy their windows');
      const before = expectedKeys(sched, new Date(T1.getTime() - L), null, T1);
      const after = expectedKeys(sched, enabledAt, enabledAt, done.at).filter((k) => !lateKeys.includes(k));
      assert.ok(after.length > 20);
      assert.deepEqual(keysOf(all), [...before, ...after].sort(), 'nothing between the last judged window and the switch-on is judged');
      assert.ok(all.filter((e: any) => e.type === 'patrol_missed' && new Date(e.windowEnd).getTime() + GRACE <= T2.getTime() - L && new Date(e.windowStart).getTime() >= enabledAt.getTime())
        .every((e: any) => e.reconciliationRunId), 'the reconciled part of the gap is marked');
      const [run] = await runsOf(s.co);
      assert.equal(new Date(run.fromAt).toISOString(), enabledAt.toISOString(), 'the catch-up starts at the switch-on');
      await noDuplicates(s.co);
    });

    await test('PR-09-RECONCILED-EXCEPTIONS-API-SUMMARY-ALERT-LIFECYCLE-AND-AUDIT-TRAIL', async () => {
      const s = await scenario('r09', T1, new Date(T1.getTime() + 3 * DAY));
      await focus(s.co);
      await sweep(T1);
      const T2 = new Date(T1.getTime() + 2 * DAY);
      await sweepUntilCaughtUp(s.co, T2);
      const token = await login(s.ownerEmail);
      const list = await api('GET', '/patrols/exceptions', token);
      expect(list, 200, 'exceptions');
      const recon = list.body.filter((e: any) => e.reconciliationRunId !== null);
      const live = list.body.filter((e: any) => e.reconciliationRunId === null);
      assert.ok(recon.length > 0 && live.length > 0);
      const [run] = await runsOf(s.co);
      assert.ok(recon.every((e: any) => e.reconciliationRunId === Number(run.id) && e.safetyAlertId === null && e.type === 'patrol_missed'));
      // A reconciled exception is resolved on its own; the summary alert is untouched.
      const target = recon[0];
      expect(await api('POST', `/patrols/exceptions/${target.id}/resolve`, token, { resolutionReason: 'guard_contacted', resolutionNote: 'Confirmed missed during the outage' }), 200, 'resolve');
      const [summary] = await reconAlertsOf(s.co);
      assert.equal(summary.status, 'open', 'the summary alert stays open');
      // The summary alert is in the company's alert list and closes through the existing lifecycle, touching no exception.
      const alerts = await api('GET', '/alerts/company', token);
      expect(alerts, 200);
      const listed = alerts.body.find((a: any) => a.id === Number(summary.id));
      assert.ok(listed && listed.type === 'patrol_missed' && listed.patrolExceptionId === null && listed.patrolWindowKey === `reconciliation:site:${s.sites[0].id}`);
      const openBefore = await count(`SELECT count(*) FROM patrol_exceptions WHERE "companyId" = $1 AND status <> 'resolved'`, [s.co]);
      expect(await api('PATCH', `/alerts/${summary.id}/close`, token, { resolutionReason: 'guard_contacted', resolutionNote: 'Reviewed the outage list' }), 200, 'close summary');
      assert.equal(await count(`SELECT count(*) FROM patrol_exceptions WHERE "companyId" = $1 AND status <> 'resolved'`, [s.co]), openBefore, 'no exception changed');
      // Audit trail.
      const started = await auditsOf(s.co, 'patrol.reconciliation_started');
      const batches = await auditsOf(s.co, 'patrol.reconciliation_batch');
      const completed = await auditsOf(s.co, 'patrol.reconciliation_completed');
      assert.deepEqual([started.length, completed.length], [1, 1]);
      assert.equal(batches.length, Number(run.batches));
      assert.deepEqual([started[0].afterData.judgedThrough, started[0].afterData.horizonDays, started[0].afterData.batchHours, started[0].afterData.batchWindows],
        [T1.toISOString(), 14, 6, 500]);
      assert.equal(batches.reduce((a: number, b: any) => a + b.afterData.exceptionsRaised, 0), recon.length);
      assert.deepEqual([completed[0].afterData.exceptionsRaised, completed[0].afterData.summaryAlerts], [recon.length, [{ siteId: s.sites[0].id, windows: recon.length, safetyAlertId: Number(summary.id) }]]);
      assert.ok((await auditsOf(s.co, 'patrol.exception_raised')).filter((a: any) => a.afterData.reconciled === true).length === recon.length, 'each reconciled exception audited as such');
      assert.equal((await auditsOf(s.co, 'patrol.reconciliation_alert_raised')).length, 1);
      assert.ok(started.concat(batches, completed).every((a: any) => a.userId === null && a.entityType === 'patrol_reconciliation_run'));
    });

    await test('PR-10-A-BATCH-JUDGES-AT-MOST-500-WINDOWS-AND-THE-NEXT-CONTINUES-FROM-ITS-LAST-DEADLINE', async () => {
      // 25 all-day schedules with 15-minute windows: 100 windows an hour, so 6 h of deadlines is 600 windows.
      const s = await scenario('r10', T1, new Date(T1.getTime() + 3 * DAY), { schedule: { from: '00:00', to: '00:00', freq: 15 } });
      for (let i = 2; i <= 25; i += 1) await mkSchedule(s.co, s.sites[0].id, { name: `Q${i}`, from: '00:00', to: '00:00', freq: 15 });
      const schedules = await q(`SELECT * FROM patrol_schedules WHERE "companyId" = $1 ORDER BY id`, [s.co]);
      await focus(s.co);
      await sweep(T1);
      const T2 = new Date(T1.getTime() + L + 6 * HOUR); // 6 h of deadlines to reconcile
      const c = await sweep(T2);
      assert.deepEqual([c.reconciliationsStarted, c.reconciliationBatches, c.reconciliationsCompleted], [1, 2, 1], JSON.stringify(c));
      const batches = await auditsOf(s.co, 'patrol.reconciliation_batch');
      assert.deepEqual(batches.map((b: any) => [b.afterData.windowsJudged, b.afterData.boundedByWindowLimit]), [[500, true], [100, false]]);
      assert.equal(batches[0].afterData.deadlinesThrough, new Date(T1.getTime() + 5 * HOUR).toISOString(), 'cut at the 500th deadline (20 quarter-hours × 25 schedules)');
      assert.equal(batches[1].afterData.deadlinesFrom, batches[0].afterData.deadlinesThrough, 'the next batch continues from there');
      const all = await exceptionsOf(s.co);
      const expected = schedules.flatMap((sc: any) => expectedKeys(sc, new Date(T1.getTime() - L), null, T2)).sort();
      assert.deepEqual(keysOf(all), expected, 'every window judged exactly once');
      assert.equal(all.filter((e: any) => e.reconciliationRunId).length, 600);
      const [summary] = await reconAlertsOf(s.co);
      assert.match(summary.message, /600 patrol windows were missed at r10 Gate A .*; and 590 more\./);
      await noDuplicates(s.co);
    });
  } finally {
    await app.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  console.log(JSON.stringify({ event: 'patrol_reconciliation_certified', tests: passed }));
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
