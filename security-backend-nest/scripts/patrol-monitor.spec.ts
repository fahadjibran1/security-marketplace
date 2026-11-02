/**
 * S4 Patrol Monitor S1 (owner-approved 2 Nov 2026): the read-only monitor model and its two endpoints. The whole
 * application over HTTP on a disposable database built from the repository's own migrations (NO new migration); the
 * patrol and safety sweeps' timers are stopped and the REAL sweep is run at chosen instants, so the Monitor is proven
 * against the sweep's own verdicts.
 *
 *   PMON-01  window states, first match wins (pure): verified only from server verification; late + verified is
 *            late_verified (never green); awaiting_verification; in_progress / incomplete by the completion deadline;
 *            flagged, not_verified; missed only from a sweep exception; future, not_on_duty, due, overdue, awaiting_check,
 *            not_judged
 *   PMON-02  hour cells: the most severe state, x/y = verified / owed so far; a site is never on track when nothing is due
 *   PMON-03  hours: 25 on the autumn day (the repeated hour labelled twice), 23 on the spring day, a non-hour zone
 *   PMON-04  a real day at a site-wide site after the real sweep: one shared Site patrol lane (no Guard lanes), the eight
 *            hourly windows' states, the Guard who actually did each patrol, missed with its exception and alert,
 *            not_verified with checkpoint_missed, an unscheduled run listed and never counted, site status attention
 *   PMON-05  the Monitor follows the sweep through time: due → overdue → awaiting_check → (sweep) missed; windows that
 *            started before the schedule's last change are not_judged
 *   PMON-06  per-guard lanes: one lane per shift; a Guard who never booked on is not_on_duty (the sweep raises nothing);
 *            a patrol completed but not yet judged by the sweep shows awaiting_verification
 *   PMON-07  shift-based patrols (active setup): a required shift's lane; a not-required shift's cells are not_required
 *   PMON-08  QR progress: unique required checkpoints of the required set; a repeat scan never counts twice (the run is
 *            still flagged — today's rule, unchanged in S1); QR-only patrols need no photo
 *   PMON-09  Live Operations counts: open patrol alerts = the alerts Attention Now lists (an exception and its alert count
 *            once); missed today counts windows; resolving makes it history (site no longer attention, missed stays)
 *   PMON-10  HTTP contract: summary and site shapes, DST day views, the live range, validation
 *   PMON-11  access: patrols.view (viewer yes, finance no), Guards refused, another company's site 404, Patrols off 404
 *   PMON-12  read-only: no row of any table changes and no audit entry is written by any monitor read; no storage key,
 *            URL or hash in a response
 *   PMON-13  bounded queries: the same number of queries for one site or every site
 *
 * Needs PATROL_MONITOR_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

const url = process.env.PATROL_MONITOR_DATABASE_URL;
if (!url) throw new Error('PATROL_MONITOR_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Patrol monitor database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-monitor-local-certification-secret-not-production';
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
    console.log(`FAIL  ${id}\n      ${String((error as Error)?.stack ?? error).split('\n').slice(0, 12).join('\n      ')}`);
  }
};

type Res = { status: number; body: any };
const PASSWORD = 'patrol-monitor-spec-only-password-1';
const Z = (s: string) => new Date(s);
let clientSeq = 0;
const cid = (p: string) => `${p}-${Date.now().toString(36)}-${(++clientSeq).toString().padStart(4, '0')}`;

async function main() {
  // ═══════════════════ Pure model (no database) ═══════════════════
  const M = await import('../src/patrol/patrol-monitor-model');
  const policy = { startGraceMinutes: 15, maxPatrolDurationMinutes: 45, completionGraceMinutes: 30 };
  const win = { start: Z('2026-03-10T10:00:00Z'), end: Z('2026-03-10T11:00:00Z') };
  const run = (o: Partial<{ status: string; verificationStatus: string; lateStart: boolean; startedAtDevice: Date; windowEnd: Date | null }> = {}) => ({
    status: 'completed', verificationStatus: 'pending', lateStart: false, startedAtDevice: Z('2026-03-10T10:05:00Z'), windowEnd: win.end, ...o,
  });
  const state = (now: string, o: Partial<Parameters<typeof M.monitorWindowState>[0]> = {}) => M.monitorWindowState({
    now: Z(now), window: win, policy, run: null, missed: false, expected: true, onDuty: true, judgedThrough: Z('2026-03-10T09:00:00Z'), ...o,
  });

  await test('PMON-01-WINDOW-STATES-FIRST-MATCH-WINS', () => {
    // A covering run decides, whatever the clock.
    assert.equal(state('2026-03-10T10:20:00Z', { run: run({ status: 'in_progress' }) }), 'in_progress', 'before the completion deadline (10:50)');
    assert.equal(state('2026-03-10T10:50:00Z', { run: run({ status: 'in_progress' }) }), 'incomplete', 'at the completion deadline: abandoned');
    assert.equal(state('2026-03-10T12:00:00Z', { run: run({ status: 'incomplete' }) }), 'incomplete');
    assert.equal(state('2026-03-10T12:00:00Z', { run: run({ status: 'closed_by_system', verificationStatus: 'unverified' }) }), 'incomplete');
    assert.equal(state('2026-03-10T12:00:00Z', { run: run({ verificationStatus: 'flagged' }) }), 'flagged');
    assert.equal(state('2026-03-10T12:00:00Z', { run: run({ verificationStatus: 'unverified' }) }), 'not_verified');
    assert.equal(state('2026-03-10T12:00:00Z', { run: run({ verificationStatus: 'verified' }) }), 'verified', 'the ONLY green');
    assert.equal(state('2026-03-10T12:00:00Z', { run: run({ verificationStatus: 'verified', lateStart: true }) }), 'late_verified', 'late + verified is amber, never green');
    assert.equal(state('2026-03-10T10:30:00Z', { run: run() }), 'awaiting_verification', 'completed, not yet judged by the sweep');
    assert.equal(state('2026-03-10T12:00:00Z', { run: run(), missed: true }), 'awaiting_verification', 'a run outranks a stale exception');
    // No run: the sweep's exception is the only source of "missed".
    assert.equal(state('2026-03-10T09:00:00Z', { missed: true }), 'missed');
    assert.equal(state('2026-03-10T09:00:00Z'), 'future');
    assert.equal(state('2026-03-10T09:00:00Z', { expected: false, onDuty: false }), null, 'nobody scheduled: not shown');
    assert.equal(state('2026-03-10T10:10:00Z', { onDuty: false }), 'not_on_duty', 'scheduled but never on duty (no Book On)');
    assert.equal(state('2026-03-10T10:10:00Z', { onDuty: false, expected: false }), null);
    assert.equal(state('2026-03-10T10:10:00Z'), 'due');
    assert.equal(state('2026-03-10T11:00:00Z'), 'overdue', 'the window has ended, inside the start grace');
    assert.equal(state('2026-03-10T11:14:59Z'), 'overdue');
    assert.equal(state('2026-03-10T11:15:00Z'), 'awaiting_check', 'the start deadline passed; the sweep has not reached it');
    assert.equal(state('2026-03-10T11:30:00Z', { judgedThrough: null }), 'awaiting_check', 'no watermark yet');
    assert.equal(state('2026-03-10T11:30:00Z', { judgedThrough: Z('2026-03-10T11:15:00Z') }), 'not_judged', 'judged, nothing raised: nothing was owed');
  });

  await test('PMON-02-HOUR-CELLS-AND-SITE-STATUS', () => {
    assert.equal(M.worstState(['verified', 'missed', 'late_verified']), 'missed');
    assert.equal(M.worstState(['verified', 'late_verified']), 'late_verified');
    assert.equal(M.worstState(['future', 'verified']), 'verified');
    assert.equal(M.worstState(['awaiting_verification', 'overdue']), 'overdue');
    assert.equal(M.worstState([]), null);
    const counts = (o: Partial<ReturnType<typeof M.countsOf>>) => ({ ...M.countsOf([], []), ...o });
    assert.equal(M.siteStatus(counts({})), 'no_patrols');
    assert.equal(M.siteStatus(counts({ windows: 3, future: 3 })), 'not_started', 'never on track merely because nothing is due yet');
    assert.equal(M.siteStatus(counts({ windows: 3, owed: 1, verified: 1, verifiedOnTime: 1, future: 2 })), 'on_track');
    assert.equal(M.siteStatus(counts({ windows: 3, owed: 1, lateVerified: 1 })), 'watch');
    assert.equal(M.siteStatus(counts({ windows: 3, owed: 1, awaitingCheck: 1 })), 'watch');
    assert.equal(M.siteStatus(counts({ windows: 3, owed: 1, verificationOverdue: 1 })), 'watch');
    assert.equal(M.siteStatus(counts({ windows: 3, owed: 1, overdue: 1 })), 'attention');
    assert.equal(M.siteStatus(counts({ windows: 3, owed: 2, missed: 1, openExceptions: 1 })), 'attention');
    assert.equal(M.siteStatus(counts({ windows: 3, owed: 2, missed: 1, verified: 1, verifiedOnTime: 1, openExceptions: 0 })), 'on_track', 'a resolved miss is history');
  });

  await test('PMON-03-HOURS-DST-AND-ZONES', () => {
    const W = require('../src/patrol/patrol-window.service');
    const hours = (date: string, tz: string) => { const b = W.siteDayBounds(date, tz); return M.monitorHours(b.start, b.end, tz, Z('2000-01-01T00:00:00Z')); };
    const autumn = hours('2026-10-25', 'Europe/London');
    assert.equal(autumn.length, 25, 'clocks back: 25 hours');
    assert.deepEqual(autumn.slice(0, 4).map((h) => `${h.label}${h.repeated ? '*' : ''}@${h.start.slice(11, 16)}`), ['00@23:00', '01@00:00', '01*@01:00', '02@02:00']);
    assert.notEqual(autumn[1].offset, autumn[2].offset, 'the repeated hour shows its own offset');
    const spring = hours('2026-03-29', 'Europe/London');
    assert.equal(spring.length, 23, 'clocks forward: 23 hours');
    assert.deepEqual(spring.slice(0, 3).map((h) => h.label), ['00', '02', '03'], 'there is no 01:00');
    assert.equal(hours('2026-11-01', 'America/New_York').length, 25, "another zone's own autumn day");
    assert.equal(hours('2026-06-01', 'Asia/Kolkata').length, 24);
    assert.equal(M.floorToLocalHour(Z('2026-06-01T10:20:00Z'), 'Asia/Kolkata').toISOString(), '2026-06-01T09:30:00.000Z', 'a half-hour zone floors to its own hour');
    assert.equal(M.floorToLocalHour(Z('2026-06-01T10:20:00Z'), 'Europe/London').toISOString(), '2026-06-01T10:00:00.000Z');
  });

  // ═══════════════════ The application ═══════════════════
  const path = require('node:path');
  const fs = require('node:fs');
  const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
  const allFiles: string[] = fs.readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).sort();
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const base = buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' });
  const migrate = new DataSource({ ...base, entities: [], migrations: allFiles.map((f) => path.join(migrationsDir, f)), dropSchema: true } as never);
  await migrate.initialize();
  const migrated = await migrate.runMigrations({ transaction: 'each' });
  assert.equal(migrated[migrated.length - 1]?.name, 'AddPatrolSiteSetup1720900000021', 'the head is still Migration 74: S1 needs no migration');
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
  const { PatrolMonitorService } = await import('../src/patrol/patrol-monitor.service');
  app.get(PatrolSweepService).onModuleDestroy();
  app.get(SafetyAlertService).onModuleDestroy();
  const sweep = app.get(PatrolSweepService);
  const monitor = app.get(PatrolMonitorService);
  const auth = app.get(AuthService);

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
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
    assert.equal(r.status, status, `${what} expected ${status}${code ? ` ${code}` : ''}, got ${r.status} ${JSON.stringify(r.body)?.slice(0, 400)}`);
    if (code) assert.equal(r.body?.code, code, `${what} code: ${JSON.stringify(r.body)}`);
  };
  const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;

  // ── Fixtures ──
  const hash = await bcrypt.hash(PASSWORD, 4);
  let seq = 0;
  const mkUser = async (email: string, role: string) =>
    Number((await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
       VALUES ($1,$2,$3,'active',true,false,$4,'Spec') RETURNING id`, [email, hash, role, email.split('@')[0]])).id);
  const mkCompany = async (label: string, patrolsEnabled = true) => {
    seq += 1;
    const ownerEmail = `pmon.${label}.owner@example.invalid`;
    const ownerId = await mkUser(ownerEmail, 'company_admin');
    const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,$2,$3,'1 Way','ops@example.invalid',$4) RETURNING id`,
      [ownerId, `PMON ${label} Ltd`, String(77000000 + seq), patrolsEnabled]);
    return { id: Number(id), ownerId, ownerEmail, user: { sub: ownerId, email: ownerEmail, role: 'company_admin', status: 'active' } as any };
  };
  const mkMember = async (companyId: number, label: string, role: string) => {
    const email = `pmon.${label}.${role}@example.invalid`;
    const id = await mkUser(email, 'company_admin');
    await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [id, companyId, role]);
    return email;
  };
  const mkSite = async (companyId: number, name: string, tz = 'Europe/London', clientName: string | null = 'Harbour Estates') =>
    Number((await one(`INSERT INTO sites ("companyId",name,address,timezone,"clientName") VALUES ($1,$2,'3 Quay',$3,$4) RETURNING id`, [companyId, name, tz, clientName])).id);
  const mkGuard = async (label: string) => {
    seq += 1;
    const email = `pmon.${label}@example.invalid`;
    const userId = await mkUser(email, 'guard');
    const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, `Guard ${label}`, `77${String(seq).padStart(14, '0')}`, `0773${String(seq).padStart(7, '0')}`]);
    return { id: Number(id), userId, email };
  };
  const mkShift = async (companyId: number, siteId: number, guardId: number | null, start: string, end: string, status: string, o: { bookOn?: string; bookOff?: string; requirement?: string | null } = {}) => {
    const id = Number((await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end","patrolRequirement") VALUES ($1,$2,'Gate',$3,$4,$5,$6,$7) RETURNING id`,
      [companyId, siteId, guardId, status, Z(start), Z(end), o.requirement ?? null])).id);
    if (o.bookOn) await q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-in',$3,$3,false)`, [id, guardId, Z(o.bookOn)]);
    if (o.bookOff) await q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-out',$3,$3,false)`, [id, guardId, Z(o.bookOff)]);
    return id;
  };
  const mkCheckpoint = async (companyId: number, siteId: number, label: string) =>
    one(`INSERT INTO patrol_checkpoints ("companyId","siteId","publicId",label) VALUES ($1,$2,$3,$4) RETURNING *`,
      [companyId, siteId, require('node:crypto').randomBytes(16).toString('hex'), label]);
  const mkRoute = async (companyId: number, siteId: number, checkpoints: any[]) => {
    const route = await one(`INSERT INTO patrol_routes ("companyId","siteId",name) VALUES ($1,$2,'Perimeter') RETURNING id`, [companyId, siteId]);
    for (const [i, cp] of checkpoints.entries()) {
      await q(`INSERT INTO patrol_route_checkpoints ("companyId","siteId","routeId","checkpointId",position) VALUES ($1,$2,$3,$4,$5)`, [companyId, siteId, route.id, cp.id, i + 1]);
    }
    return Number(route.id);
  };
  const mkSchedule = async (companyId: number, siteId: number, routeId: number | null, from: string, to: string, freq: number, updatedAt = '2026-01-01T00:00:00Z') =>
    Number((await one(`INSERT INTO patrol_schedules ("companyId","siteId","routeId",name,"daysOfWeek","activeFrom","activeTo","frequencyMinutes","windowMinutes",active,"createdAt","updatedAt")
       VALUES ($1,$2,$3,'Hourly patrol','[1,2,3,4,5,6,7]'::jsonb,$4,$5,$6,$6,true,'2026-01-01',$7) RETURNING id`, [companyId, siteId, routeId, from, to, freq, Z(updatedAt)])).id);
  const insRun = async (r: {
    companyId: number; siteId: number; shiftId: number; guard: { id: number; userId: number }; scheduleId?: number | null; routeId?: number | null;
    windowKey?: string | null; windowStart?: string | null; windowEnd?: string | null; scopeKey?: string; status?: string; startedAt: string;
    completedAt?: string | null; lateStart?: boolean; reason?: string | null;
  }) => one(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","scheduleId","routeId","windowKey","windowStart","windowEnd","scopeKey",
       status,"startedAtDevice","startedAtServer","completedAtDevice","completedAtServer","clientRunId","exceptionReason","lateStart")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$14,$15,$16,$17) RETURNING *`,
    [r.companyId, r.siteId, r.shiftId, r.guard.id, r.guard.userId, r.scheduleId ?? null, r.routeId ?? null, r.windowKey ?? null,
      r.windowStart ? Z(r.windowStart) : null, r.windowEnd ? Z(r.windowEnd) : null, r.scopeKey ?? 'site', r.status ?? 'completed', Z(r.startedAt),
      r.completedAt ? Z(r.completedAt) : null, cid('run'), r.reason ?? null, r.lateStart === true]);
  const insVisit = (companyId: number, runId: number, checkpoint: any, result: string, at: string, flags: string[] = []) =>
    one(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","checkpointId","scannedPublicId",result,flags,"scannedAtDevice","clientVisitId")
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`, [companyId, runId, checkpoint?.id ?? null, checkpoint?.publicId ?? null, result, JSON.stringify(flags), Z(at), cid('visit')]);
  const DAY = '2026-03-10'; // a Tuesday; London is on GMT, so site-local times read as UTC
  const at = (hhmm: string) => `${DAY}T${hhmm}:00Z`;
  const slotKey = (scheduleId: number, slot: number) => `s${scheduleId}:${DAY}:${slot}`;
  const site = async (o: any, siteId: number, nowIso: string, query: any = { date: DAY }): Promise<any> => monitor.site(o.user, siteId, query, Z(nowIso));
  const states = (lane: any) => lane.windows.map((w: any) => `${w.start.slice(11, 13)}:${w.state}`);

  const A = await mkCompany('alpha');
  const B = await mkCompany('bravo');
  const C = await mkCompany('charlie', false);
  const aViewer = await mkMember(A.id, 'alpha', 'viewer');
  const aFinance = await mkMember(A.id, 'alpha', 'finance');
  const aControl = await mkMember(A.id, 'alpha', 'control_room');
  const ava = await mkGuard('ava');
  const ben = await mkGuard('ben');
  const cal = await mkGuard('cal');
  const dee = await mkGuard('dee');
  const eve = await mkGuard('eve');
  const fin = await mkGuard('fin');
  const gus = await mkGuard('gus');

  // Quay — site-wide hourly patrols 08:00–16:00, QR on a two-checkpoint route.
  const quay = await mkSite(A.id, 'Quay');
  const cp1 = await mkCheckpoint(A.id, quay, 'Gate 1');
  const cp2 = await mkCheckpoint(A.id, quay, 'Gate 2');
  const quayRoute = await mkRoute(A.id, quay, [cp1, cp2]);
  const quaySched = await mkSchedule(A.id, quay, quayRoute, '08:00', '16:00', 60);
  const avaShift = await mkShift(A.id, quay, ava.id, at('08:00'), at('16:00'), 'in_progress', { bookOn: at('07:55') });
  const benShift = await mkShift(A.id, quay, ben.id, at('08:00'), at('12:00'), 'completed', { bookOn: at('08:00'), bookOff: at('12:00') });
  const quayRun = async (slot: number, guard: any, shiftId: number, start: string, o: any = {}) => insRun({
    companyId: A.id, siteId: quay, shiftId, guard, scheduleId: quaySched, routeId: quayRoute, windowKey: slotKey(quaySched, slot),
    windowStart: at(`${String(8 + slot).padStart(2, '0')}:00`), windowEnd: at(`${String(9 + slot).padStart(2, '0')}:00`), startedAt: start, ...o,
  });
  const r08 = await quayRun(0, ava, avaShift, at('08:05'), { completedAt: at('08:20') });
  await insVisit(A.id, r08.id, cp1, 'verified', at('08:06'));
  await insVisit(A.id, r08.id, cp2, 'verified', at('08:10'));
  const r09 = await quayRun(1, ben, benShift, at('10:05'), { completedAt: at('10:20'), lateStart: true }); // late, by Ben
  await insVisit(A.id, r09.id, cp1, 'verified', at('10:06'));
  await insVisit(A.id, r09.id, cp2, 'verified', at('10:10'));
  // 10:00: nobody patrols → the sweep's patrol_missed.
  const r11 = await quayRun(3, ava, avaShift, at('11:05'), { completedAt: at('11:20') }); // Gate 2 never scanned
  await insVisit(A.id, r11.id, cp1, 'verified', at('11:06'));
  const r12 = await quayRun(4, ava, avaShift, at('12:05'), { completedAt: at('12:20') }); // Gate 1 scanned twice
  await insVisit(A.id, r12.id, cp1, 'verified', at('12:06'));
  await insVisit(A.id, r12.id, cp1, 'flagged', at('12:08'), ['duplicate_in_run']);
  await insVisit(A.id, r12.id, cp2, 'verified', at('12:10'));
  const r13 = await quayRun(5, ava, avaShift, at('13:10'), { status: 'in_progress' });
  await insVisit(A.id, r13.id, cp1, 'verified', at('13:12'));
  const unscheduled = await insRun({ companyId: A.id, siteId: quay, shiftId: avaShift, guard: ava, routeId: quayRoute, startedAt: at('09:30'), completedAt: at('09:40') });

  // Yard — site-wide hourly 08:00–16:00, schedule last changed at 09:30, no patrol at all.
  const yard = await mkSite(A.id, 'Yard');
  const yardCp = await mkCheckpoint(A.id, yard, 'Yard gate');
  const yardRoute = await mkRoute(A.id, yard, [yardCp]);
  await mkSchedule(A.id, yard, yardRoute, '08:00', '16:00', 60, at('09:30'));
  await mkShift(A.id, yard, cal.id, at('08:00'), at('16:00'), 'in_progress', { bookOn: at('07:50') });

  // Depot — per-guard hourly 10:00–14:00: Dee on duty, Eve scheduled but never booked on.
  const depot = await mkSite(A.id, 'Depot', 'Europe/London', null);
  await q(`INSERT INTO patrol_policies ("companyId","siteId","requirementScope") VALUES ($1,$2,'per_guard')`, [A.id, depot]);
  const depotCp = await mkCheckpoint(A.id, depot, 'Depot door');
  const depotRoute = await mkRoute(A.id, depot, [depotCp]);
  const depotSched = await mkSchedule(A.id, depot, depotRoute, '10:00', '14:00', 60);
  const deeShift = await mkShift(A.id, depot, dee.id, at('10:00'), at('14:00'), 'in_progress', { bookOn: at('10:00') });
  const eveShift = await mkShift(A.id, depot, eve.id, at('10:00'), at('14:00'), 'ready');
  const depotRun = (slot: number, start: string, o: any = {}) => insRun({
    companyId: A.id, siteId: depot, shiftId: deeShift, guard: dee, scheduleId: depotSched, routeId: depotRoute, windowKey: `s${depotSched}:${DAY}:${slot}`,
    windowStart: at(`${10 + slot}:00`), windowEnd: at(`${11 + slot}:00`), scopeKey: `sh${deeShift}`, startedAt: start, ...o,
  });
  const d10 = await depotRun(0, at('10:05'), { completedAt: at('10:15') });
  await insVisit(A.id, d10.id, depotCp, 'verified', at('10:06'));
  await depotRun(1, at('11:05'), { completedAt: at('11:15'), status: 'incomplete', reason: 'Gate locked' });

  // Gate — shift-based patrols (active setup, per_shift, every 2 h from the scheduled start): Fin required, Gus not.
  const gate = await mkSite(A.id, 'Gate');
  await q(`INSERT INTO patrol_policies ("companyId","siteId","setupMode","setupConfirmedAt","setupConfirmedByUserId","methods") VALUES ($1,$2,'per_shift','2026-03-01T00:00:00Z',$3,'["qr"]'::jsonb)`, [A.id, gate, A.ownerId]);
  const gateCp = await mkCheckpoint(A.id, gate, 'Gate post');
  const gateRoute = await mkRoute(A.id, gate, [gateCp]);
  await q(`INSERT INTO patrol_schedules ("companyId","siteId","routeId",name,"daysOfWeek","activeFrom","activeTo","frequencyMinutes","windowMinutes","startsOn","endsOn",active,anchor,"createdAt","updatedAt")
     VALUES ($1,$2,$3,'Shift patrols','[1,2,3,4,5,6,7]'::jsonb,'00:00','00:00',120,120,'2000-01-01','2000-01-01',false,'shift','2026-03-01','2026-03-01')`, [A.id, gate, gateRoute]);
  const finShift = await mkShift(A.id, gate, fin.id, at('08:00'), at('16:00'), 'in_progress', { bookOn: at('08:00'), requirement: 'required' });
  const gusShift = await mkShift(A.id, gate, gus.id, at('08:00'), at('16:00'), 'in_progress', { bookOn: at('08:00') });

  // Company B: a site of its own (isolation).
  const bSite = await mkSite(B.id, 'Bravo Yard');
  await mkSchedule(B.id, bSite, null, '08:00', '16:00', 60);

  // The real sweep, at 13:40.
  await sweep.sweep(Z(at('13:40')));

  const tokOwnerA = await login(A.ownerEmail);
  const tokViewerA = await login(aViewer);
  const tokFinanceA = await login(aFinance);
  const tokControlA = await login(aControl);
  const tokOwnerB = await login(B.ownerEmail);
  const tokOwnerC = await login(C.ownerEmail);
  const tokGuard = await login(ava.email);

  try {
    await test('PMON-04-A-SITE-WIDE-DAY-AFTER-THE-REAL-SWEEP', async () => {
      const v = await site(A, quay, at('13:40'));
      assert.deepEqual(v.lanes.map((l: any) => l.kind), ['site'], 'site-wide patrols: ONE shared Site patrol lane, no Guard lanes');
      const lane = v.lanes[0];
      assert.deepEqual(states(lane), ['08:verified', '09:late_verified', '10:missed', '11:not_verified', '12:flagged', '13:in_progress', '14:future', '15:future']);
      const w = (h: string) => lane.windows.find((x: any) => x.start.slice(11, 13) === h);
      assert.equal(w('09').runGuardId, ben.id, 'the Guard who actually did the site-wide patrol');
      assert.equal(v.runs[w('09').runId].guardName, 'Guard ben');
      assert.equal(w('08').runGuardId, ava.id);
      const missed = await one(`SELECT * FROM patrol_exceptions WHERE "companyId" = $1 AND "windowKey" = $2 AND type = 'patrol_missed'`, [A.id, slotKey(quaySched, 2)]);
      assert.ok(missed, 'the sweep raised it');
      assert.deepEqual([w('10').exceptionId, w('10').exceptionStatus, w('10').alertId, w('10').alertStatus], [Number(missed.id), 'open', Number(missed.safetyAlertId), 'open']);
      const cm = await one(`SELECT * FROM patrol_exceptions WHERE "runId" = $1 AND type = 'checkpoint_missed'`, [r11.id]);
      assert.ok(cm && w('11').exceptionIds.includes(Number(cm.id)), 'not_verified carries the sweep\'s checkpoint_missed');
      // An unscheduled patrol is listed, never counted as a patrol — but its own exception (Gate 2 not scanned) counts.
      const unscheduledCm = await one(`SELECT id FROM patrol_exceptions WHERE "runId" = $1 AND type = 'checkpoint_missed'`, [unscheduled.id]);
      assert.deepEqual(v.otherRuns, [{ runId: Number(unscheduled.id), reason: 'unscheduled', exceptionIds: [Number(unscheduledCm.id)] }]);
      assert.ok(v.exceptions[unscheduledCm.id], 'and is described');
      assert.deepEqual([v.counts.windows, v.counts.owed, v.counts.verified, v.counts.verifiedOnTime, v.counts.lateVerified, v.counts.missed, v.counts.inProgress, v.counts.future],
        [8, 6, 2, 1, 1, 1, 1, 2]);
      assert.deepEqual([v.counts.openExceptions, v.counts.openAlerts], [3, 3], 'the missed window and two checkpoint misses, each with ONE alert');
      assert.equal(v.status, 'attention');
      assert.equal(v.nextWindowStart, at('14:00').replace('Z', '.000Z'));
      // Cells: one window an hour here; x/y and the hour's own state.
      const cell = (h: number) => lane.cells.find((c: any) => c.hour === h);
      assert.deepEqual([cell(9).state, cell(9).verified, cell(9).owed, cell(9).total], ['late_verified', 1, 1, 1]);
      assert.deepEqual([cell(14).state, cell(14).owed, cell(14).total], ['future', 0, 1]);
      assert.deepEqual([cell(3).state, cell(3).total], ['none', 0], 'no window that hour');
      assert.equal(v.hours.length, 24);
    });

    await test('PMON-05-THE-MONITOR-FOLLOWS-THE-SWEEP-THROUGH-TIME', async () => {
      const yardStates = async (now: string) => states((await site(A, yard, now)).lanes[0]);
      assert.deepEqual(await yardStates(at('13:40')),
        ['08:not_judged', '09:not_judged', '10:missed', '11:missed', '12:missed', '13:due', '14:future', '15:future'],
        'windows that started before the schedule\'s last change (09:30) are never judged; then the sweep\'s misses');
      assert.deepEqual((await yardStates(at('14:05'))).slice(5, 6), ['13:overdue'], 'ended, inside the start grace');
      assert.deepEqual((await yardStates(at('14:20'))).slice(5, 6), ['13:awaiting_check'], 'past the start deadline, the sweep has not been since');
      await sweep.sweep(Z(at('14:20')));
      assert.deepEqual((await yardStates(at('14:20'))).slice(5, 7), ['13:missed', '14:due'], 'after the sweep: missed, from its exception');
    });

    await test('PMON-06-PER-GUARD-LANES-NOT-ON-DUTY-AND-AWAITING-VERIFICATION', async () => {
      // Completed after the sweep's last pass: the sweep has not judged it yet.
      const late = await depotRun(3, at('14:21'), { completedAt: at('14:30'), windowStart: at('13:00'), windowEnd: at('14:00'), lateStart: true });
      await insVisit(A.id, late.id, depotCp, 'verified', at('14:22'));
      const v = await site(A, depot, at('14:35'));
      assert.deepEqual(v.lanes.map((l: any) => [l.kind, l.shiftId, l.guardName]), [['shift', deeShift, 'Guard dee'], ['shift', eveShift, 'Guard eve']], 'one lane per shift, no Site lane');
      assert.deepEqual(states(v.lanes[0]), ['10:verified', '11:incomplete', '12:missed', '13:awaiting_verification']);
      assert.equal(v.lanes[0].windows[3].lateStart, true, 'late is kept for when it is verified');
      assert.equal(v.lanes[0].windows[3].verificationOverdue, false, 'a normal processing delay: no warning');
      assert.deepEqual(states(v.lanes[1]), ['10:not_on_duty', '11:not_on_duty', '12:not_on_duty', '13:not_on_duty'], 'never booked on: nothing owed, nothing raised');
      assert.equal(Number((await one(`SELECT count(*)::int n FROM patrol_exceptions WHERE "shiftId" = $1`, [eveShift])).n), 0);
      assert.deepEqual([v.lanes[1].cells[9].state, v.lanes[1].cells[15].state], ['off_duty', 'off_duty']);
      // The sweep later verifies it as late: amber, never green.
      await sweep.sweep(Z(at('14:40')));
      assert.deepEqual(states((await site(A, depot, at('14:40'))).lanes[0]).slice(3), ['13:late_verified']);
    });

    await test('PMON-07-SHIFT-BASED-PATROLS-REQUIRED-AND-NOT-REQUIRED-SHIFTS', async () => {
      // (The sweeps at 13:40, 14:20 and 14:40 have run.)
      const v = await site(A, gate, at('14:40'));
      assert.equal(v.setup.active, true);
      const fl = v.lanes.find((l: any) => l.shiftId === finShift);
      const gl = v.lanes.find((l: any) => l.shiftId === gusShift);
      assert.deepEqual(states(fl), ['08:missed', '10:missed', '12:missed', '14:due'], 'every 2 h from the scheduled start; the sweep\'s misses');
      assert.equal(fl.windows[0].anchor, 'shift');
      assert.deepEqual([fl.requirement.effectiveRequired, fl.requirement.source], [true, 'shift']);
      assert.deepEqual([gl.requirement.effectiveRequired, gl.windows.length], [false, 0], 'per_shift and not marked: no patrols');
      assert.deepEqual([gl.cells[7].state, gl.cells[8].state, gl.cells[15].state, gl.cells[16].state], ['off_duty', 'not_required', 'not_required', 'off_duty']);
      assert.deepEqual([fl.cells[9].state, fl.cells[9].total], ['none', 0], 'a required lane between windows: no window that hour');
    });

    await test('PMON-08-QR-PROGRESS-UNIQUE-CHECKPOINTS-AND-QR-ONLY', async () => {
      const v = await site(A, quay, at('13:40'));
      const c12 = v.runs[r12.id].checkpoints;
      assert.deepEqual([c12.required, c12.verified, c12.scans, c12.repeatScans], [2, 2, 3, 1], 'a repeat scan is recorded but never counted twice');
      assert.equal(v.lanes[0].windows[4].state, 'flagged', 'today\'s rule (unchanged in S1): a repeat scan flags the patrol');
      const c11 = v.runs[r11.id].checkpoints;
      assert.deepEqual([c11.required, c11.verified], [2, 1]);
      assert.deepEqual(v.runs[r08.id].photos, { taken: 0, verified: 0, missing: 0 }, 'QR-only: no photo needed');
      assert.equal(v.policy.photoRequired, false);
      assert.equal(v.lanes[0].windows[0].state, 'verified', 'verified on checkpoints alone');
    });

    await test('PMON-09-LIVE-OPERATIONS-COUNTS-AND-HISTORY', async () => {
      const s = await monitor.summary(A.user, {}, Z(at('14:45')));
      const [{ n: alertsInDb }] = await q(`SELECT count(*)::int n FROM safety_alerts WHERE "companyId" = $1 AND status::text <> 'closed'
        AND type::text IN ('patrol_missed','patrol_abandoned','patrol_incomplete','checkpoint_missed','patrol_unverified')`, [A.id]);
      const [{ n: exceptionsWithAlert }] = await q(`SELECT count(*)::int n FROM patrol_exceptions e JOIN safety_alerts a ON a.id = e."safetyAlertId"
        WHERE e."companyId" = $1 AND a.status::text <> 'closed'`, [A.id]);
      assert.equal(s.liveOps.openPatrolAlerts, alertsInDb, 'exactly the patrol alerts Attention Now lists');
      assert.equal(s.liveOps.openPatrolAlerts, exceptionsWithAlert, 'an exception and its alert are one item');
      const [{ n: missedWindows }] = await q(`SELECT count(DISTINCT ("windowKey","scopeKey"))::int n FROM patrol_exceptions WHERE "companyId" = $1 AND type = 'patrol_missed'`, [A.id]);
      assert.deepEqual([s.liveOps.missedToday, s.liveOps.missedTodayOpen], [missedWindows, missedWindows]);
      assert.ok(missedWindows >= 7, 'Quay 1 + Yard 4 + Depot 1 + Gate 2');
      // Resolve Quay's missed window: Live Operations drops it, the Monitor keeps it as history.
      const missed = await one(`SELECT * FROM patrol_exceptions WHERE "companyId" = $1 AND "windowKey" = $2 AND type = 'patrol_missed'`, [A.id, slotKey(quaySched, 2)]);
      expect(await api('POST', `/patrols/exceptions/${missed.id}/resolve`, tokControlA, { resolutionReason: 'guard_contacted', resolutionNote: 'spoken to' }), 200, undefined, 'resolve');
      const after = await monitor.summary(A.user, {}, Z(at('14:45')));
      assert.deepEqual([after.liveOps.openPatrolAlerts, after.liveOps.missedToday, after.liveOps.missedTodayOpen],
        [s.liveOps.openPatrolAlerts - 1, missedWindows, missedWindows - 1]);
      const v = await site(A, quay, at('14:45'));
      const w10 = v.lanes[0].windows[2];
      assert.deepEqual([w10.state, w10.exceptionStatus, w10.alertStatus], ['missed', 'resolved', 'closed'], 'history stays visible');
      // Still open: the two checkpoint misses (11:00, the unscheduled patrol) and the 13:00 patrol the 14:20 sweep found
      // abandoned (now incomplete) — every unresolved exception of the site, none twice.
      const open = (await q(`SELECT type FROM patrol_exceptions WHERE "siteId" = $1 AND status <> 'resolved' ORDER BY type`, [quay])).map((r: any) => r.type);
      assert.deepEqual(open, ['checkpoint_missed', 'checkpoint_missed', 'patrol_abandoned']);
      assert.equal(v.lanes[0].windows[5].state, 'incomplete');
      assert.deepEqual([v.counts.missed, v.counts.missedOpen, v.counts.openExceptions], [1, 0, 3], 'the resolved miss is history; three remain open');
      assert.equal(v.status, 'attention');
    });

    await test('PMON-10-HTTP-CONTRACT-DST-AND-LIVE-RANGE', async () => {
      const sum = await api('GET', `/patrols/monitor/summary?date=${DAY}`, tokViewerA);
      expect(sum, 200, undefined, 'summary');
      assert.deepEqual(Object.keys(sum.body).sort(), ['date', 'dateBasis', 'generatedAt', 'liveOps', 'sites', 'sweep', 'totals']);
      assert.deepEqual(sum.body.sites.map((s: any) => s.siteName).sort(), ['Depot', 'Gate', 'Quay', 'Yard'], 'only sites with patrols; never company B');
      assert.equal(sum.body.sites[0].status, 'attention', 'most severe first');
      const quayRow = sum.body.sites.find((s: any) => s.siteId === quay);
      assert.deepEqual([quayRow.clientName, quayRow.timeZone, quayRow.date, quayRow.dayStart], ['Harbour Estates', 'Europe/London', DAY, `${DAY}T00:00:00.000Z`]);
      assert.equal(sum.body.totals.sites, 4);
      const one1 = await api('GET', `/patrols/monitor/summary?date=${DAY}&siteId=${quay}`, tokViewerA);
      expect(one1, 200);
      assert.equal(one1.body.sites.length, 1);
      const det = await api('GET', `/patrols/monitor/sites/${quay}?date=${DAY}`, tokViewerA);
      expect(det, 200, undefined, 'site');
      assert.deepEqual(Object.keys(det.body).sort(), ['clientId', 'clientName', 'counts', 'exceptions', 'generatedAt', 'hours', 'lanes', 'nextWindowStart', 'otherRuns',
        'policy', 'range', 'runs', 'setup', 'siteId', 'siteName', 'status', 'sweep', 'timeZone']);
      // DST day views (a whole-day schedule and a Guard on duty all day).
      const dst = await mkSite(A.id, 'Clock Tower');
      await mkSchedule(A.id, dst, null, '00:00', '00:00', 60);
      await mkShift(A.id, dst, ava.id, '2026-10-24T22:00:00Z', '2026-10-27T01:00:00Z', 'completed', { bookOn: '2026-10-24T22:00:00Z', bookOff: '2026-10-27T01:00:00Z' });
      const autumn = await api('GET', `/patrols/monitor/sites/${dst}?date=2026-10-25`, tokViewerA);
      expect(autumn, 200);
      assert.equal(autumn.body.hours.length, 25, '25 hours');
      assert.equal(autumn.body.lanes[0].windows.length, 24, 'the engine\'s 24 slots (01:00 lasts two real hours)');
      assert.deepEqual([autumn.body.lanes[0].cells[1].total, autumn.body.lanes[0].cells[2].total, autumn.body.hours[2].repeated], [1, 0, true]);
      for (const c of autumn.body.lanes[0].cells) {
        for (const k of c.windowKeys) {
          const ww = autumn.body.lanes[0].windows.find((x: any) => x.key === k);
          const h = autumn.body.hours[c.hour];
          assert.ok(ww.start >= h.start && ww.start < h.end, 'each window in the hour it starts');
        }
      }
      const spring = await api('GET', `/patrols/monitor/sites/${dst}?date=2026-03-29`, tokViewerA);
      expect(spring, 200);
      assert.equal(spring.body.hours.length, 23);
      // The live range: floored to the site hour, at most 36 h.
      const live = await api('GET', `/patrols/monitor/sites/${quay}?from=${encodeURIComponent('2026-03-10T01:20:00Z')}&to=${encodeURIComponent('2026-03-10T19:00:00Z')}`, tokViewerA);
      expect(live, 200, undefined, 'live');
      assert.deepEqual([live.body.range.from, live.body.range.date, live.body.hours.length], ['2026-03-10T01:00:00.000Z', null, 18]);
      expect(await api('GET', `/patrols/monitor/sites/${quay}?from=2026-03-10T00:00:00Z&to=2026-03-11T13:00:00Z`, tokViewerA), 400, 'PATROL_VALIDATION_FAILED', '> 36 h');
      expect(await api('GET', `/patrols/monitor/sites/${quay}?from=2026-03-10T10:00:00Z&to=2026-03-10T09:00:00Z`, tokViewerA), 400, 'PATROL_VALIDATION_FAILED', 'to before from');
      expect(await api('GET', `/patrols/monitor/sites/${quay}?from=2026-03-10T10:00:00Z`, tokViewerA), 400, 'PATROL_VALIDATION_FAILED', 'from alone');
      expect(await api('GET', `/patrols/monitor/sites/${quay}?date=${DAY}&from=2026-03-10T10:00:00Z&to=2026-03-10T12:00:00Z`, tokViewerA), 400, 'PATROL_VALIDATION_FAILED', 'both');
      expect(await api('GET', `/patrols/monitor/sites/${quay}?date=10-03-2026`, tokViewerA), 400, undefined, 'a bad date');
      expect(await api('GET', `/patrols/monitor/summary?nfc=true`, tokViewerA), 400, undefined, 'unknown parameters are refused');
    });

    await test('PMON-11-ACCESS', async () => {
      expect(await api('GET', `/patrols/monitor/summary`, tokViewerA), 200, undefined, 'viewer (patrols.view)');
      expect(await api('GET', `/patrols/monitor/summary`, tokControlA), 200, undefined, 'control room');
      expect(await api('GET', `/patrols/monitor/summary`, tokFinanceA), 403, 'PATROL_FORBIDDEN', 'finance: no patrols.view');
      expect(await api('GET', `/patrols/monitor/sites/${quay}`, tokFinanceA), 403, 'PATROL_FORBIDDEN');
      expect(await api('GET', `/patrols/monitor/summary`, tokGuard), 403, undefined, 'a Guard');
      expect(await api('GET', `/patrols/monitor/summary`, null), 401, undefined, 'no session');
      expect(await api('GET', `/patrols/monitor/sites/${quay}`, tokOwnerB), 404, 'PATROL_SITE_NOT_FOUND', "another company's site");
      expect(await api('GET', `/patrols/monitor/summary?siteId=${quay}`, tokOwnerB), 404, 'PATROL_SITE_NOT_FOUND');
      expect(await api('GET', `/patrols/monitor/summary?clientId=999999`, tokOwnerA), 404, 'PATROL_NOT_FOUND');
      expect(await api('GET', `/patrols/monitor/summary`, tokOwnerC), 404, 'PATROLS_NOT_ENABLED', 'Patrols off');
      const bView = await api('GET', `/patrols/monitor/summary?date=${DAY}`, tokOwnerB);
      expect(bView, 200);
      assert.deepEqual(bView.body.sites.map((s: any) => s.siteId), [bSite]);
      assert.equal(bView.body.liveOps.openPatrolAlerts, 0, "never another company's alerts");
    });

    await test('PMON-12-READ-ONLY-AND-NO-SECRETS', async () => {
      const tables = (await q(`SELECT table_name t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).map((r: any) => r.t);
      const snapshot = async () => {
        const out: Record<string, string> = {};
        for (const t of tables) out[t] = (await one(`SELECT count(*)::text || ':' || coalesce(md5(string_agg(md5(x::text), '' ORDER BY md5(x::text))), '') AS h FROM "${t}" x`)).h;
        return out;
      };
      const before = await snapshot();
      const bodies: string[] = [];
      for (const p of [`/patrols/monitor/summary`, `/patrols/monitor/summary?date=${DAY}`, `/patrols/monitor/sites/${quay}?date=${DAY}`, `/patrols/monitor/sites/${depot}?date=${DAY}`,
        `/patrols/monitor/sites/${gate}?date=${DAY}`, `/patrols/monitor/sites/${yard}`]) {
        const r = await api('GET', p, tokOwnerA);
        expect(r, 200, undefined, p);
        bodies.push(JSON.stringify(r.body));
      }
      const after = await snapshot();
      assert.deepEqual(Object.keys(after).filter((t) => after[t] !== before[t]), [], 'no table changed (audit_logs included)');
      for (const b of bodies) {
        assert.ok(!/storageKey|quarantineKey|sha256|https?:\/\/|X-Amz|signature/i.test(b), 'no storage key, hash, URL or signature');
        assert.ok(!/nfc/i.test(b), 'no NFC anywhere');
      }
    });

    await test('PMON-13-BOUNDED-QUERIES-WHATEVER-THE-NUMBER-OF-SITES', async () => {
      const original = ds.query.bind(ds);
      let n = 0;
      (ds as any).query = (...args: any[]) => { n += 1; return (original as any)(...args); };
      try {
        n = 0; await monitor.summary(A.user, { date: DAY }, Z(at('13:40'))); const all = n;
        // Gate exercises every query (an active setup, shifts and attendance); fewer only ever means a query was skipped.
        n = 0; await monitor.summary(A.user, { date: DAY, siteId: gate }, Z(at('13:40'))); const single = n;
        n = 0; await monitor.site(A.user, quay, { date: DAY }, Z(at('13:40'))); const detail = n;
        console.log(`      queries: summary all sites ${all}, one site ${single}; site detail ${detail}`);
        assert.equal(all, single, 'the same queries for every site as for 1');
        assert.ok(all <= 20 && detail <= 30, `bounded (${all}, ${detail})`);
      } finally {
        (ds as any).query = original;
      }
    });
  } finally {
    await app.close();
  }
  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
