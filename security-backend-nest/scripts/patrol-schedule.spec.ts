/**
 * Patrol Management P1-B (Migration 69) certification: scheduling, deadlines, offline sync after Book Off and operational
 * alerts. The whole application over HTTP plus the sweep called directly with a chosen clock, on a disposable database
 * built from the repository's own migrations. The sweep's and the safety sweep's five-minute timers are stopped so every
 * sweep in here is explicit.
 *
 * Windows (pure, patrol-window.service.ts)
 *   PS-W01  hourly windows are site-local wall-clock slots (BST) with stable keys "s{schedule}:{date}:{slot}"
 *   PS-W02  custom frequency, window length and the clip to activeTo
 *   PS-W03  an overnight 22:00–06:00 period belongs to the day it starts (days of week, startsOn / endsOn)
 *   PS-W04  UK spring forward, 29 Mar 2026, hourly 22:00–06:00: the 01:00 slot does not exist, 7 windows, no duplicates
 *   PS-W05  UK spring forward, 30-minute slots; a window starting in the gap starts at the first valid instant
 *   PS-W06  UK clocks back, 25 Oct 2026, hourly 22:00–06:00: earliest occurrence, 8 windows, the 01:00 slot is 2 real hours
 *   PS-W07  UK clocks back, 30-minute slots: 16 contiguous windows, no duplicate
 *   PS-W08  a run satisfies exactly one window: the one containing its start, or the one it started late for
 * Deadlines and rules (pure, patrol-state.ts / patrol-late-sync.ts)
 *   PS-D01  start deadline = window end + 15 min, boundaries exact; late start iff windowEnd ≤ start < windowEnd + grace
 *   PS-D02  completion deadline = min(start + 45 min, window end + 30 min); no window → start + 45
 *   PS-D03  sync deadline = completion deadline + 60 min; verification settles 24 h later
 *   PS-D04  requirements: flagged scans never count; photos recorded vs on the server; findings and verification
 *   PS-L01  the post-shift legitimacy rule (refuse: no Book On, window closed; accept + flags otherwise; 24 h boundary)
 *   PS-L02  clock drift: server receipt − sentAtDevice; flagged only beyond the threshold
 * The sweep (patrol-sweep.service.ts)
 *   PS-S01  a missed window raises ONE exception and ONE SafetyAlert, linked both ways and audited; the grace is exact
 *   PS-S02  windows before the effective Book On are not judged (the window booked on during is)
 *   PS-S03  a cancelled shift's windows are dropped: no exception, no alert
 *   PS-S04  per-site scope: any on-duty Guard's run satisfies the window
 *   PS-S05  per-guard scope: each on-duty Guard (shift) must patrol; only the missing one is raised
 *   PS-S06  overlapping schedules are independent
 *   PS-S07  a late-started run satisfies its window (no missed)
 *   PS-S08  abandoned: in progress at the completion deadline (start + 45), boundary exact; starting never cancels it
 *   PS-S09  missed completion deadline when the window's completion grace comes first (window end + 30)
 *   PS-S10  incomplete: required checkpoints missed ⇒ checkpoint_missed; a stated reason ⇒ patrol_incomplete, alerted
 *           only when the policy says it needs action
 *   PS-S11  photos: not taken ⇒ incomplete at the completion deadline; not on the server ⇒ unverified at the sync
 *           deadline (Patrols only unless escalated); uploaded ⇒ verified; settled after 24 h
 *   PS-S12  Replace Guard: windows follow the shift; the outgoing Guard's run in progress closes incomplete guard_replaced
 *   PS-S13  exactly one alert under concurrent sweeps (Promise.all)
 *   PS-S14  switch off stops the sweep at once; switching on never judges earlier windows
 *   PS-S15  UK DST nights through the sweep: one exception per real window (7 in spring, 8 in autumn)
 * Alerts and the existing lifecycle
 *   PS-A01  acknowledge / resolve through the EXISTING alert endpoints mirror onto the exception (audited); patrol
 *           reasons; the late-sync reason is not offered without late evidence; a resolved exception is never re-raised
 *   PS-A02  resolving the exception (Patrols API) closes its alert; permissions (alerts.manage or patrols.manage) and tenant isolation
 *   PS-A03  Live Operations: patrol alerts are in the company alert list with link fields; other alerts unchanged; Guards
 *           never see them
 *   PS-A04  Welfare is untouched: the patrol sweep writes no Welfare row and the Welfare sweep no patrol row
 *   PS-A05  owner decision (P1-C): Control Room acknowledges / resolves patrol alerts with alerts.manage (alert and Patrols
 *           endpoints, audited, the exception follows the alert); neither-permission roles, Viewers, Guards and another
 *           company cannot; Control Room still cannot change patrol configuration (no patrols.manage)
 * The Guard API and offline sync after Book Off
 *   PS-G01  a start is assigned to its one window and scope
 *   PS-O01  a run started on shift syncs its scans and completion after Book Off (accepted, syncedLate)
 *   PS-O02  a completion whose device time is after Book Off is accepted and needs review
 *   PS-O03  a run first reaching the server after Book Off with a matching window: accepted, provisional, flagged, audited
 *   PS-O04  outside the on-duty interval / no matching window: accepted, needsReview
 *   PS-O05  no booked-on attendance on that shift: refused (409 PATROL_SYNC_NOT_BOOKED_ON), nothing written
 *   PS-O06  beyond the 24 h acceptance window: refused (409 PATROL_SYNC_WINDOW_CLOSED) for start, scan and completion
 *   PS-O07  replay after 24 h: idempotent success; a new write is refused
 *   PS-O08  expired session then re-sync with fresh sign-ins: the same result, no duplicates
 *   PS-O09  duplicate sync attempts, sequential and concurrent: one row each, one audit entry
 *   PS-O10  delayed evidence after a missed alert: applied with device times; exception annotated; alert stays open,
 *           downgraded, offers "patrol completed — late sync"; no audit entry rewritten
 *   PS-O11  delayed completion after an abandoned alert, synced after Book Off: annotated, never closed
 *   PS-O12  clock drift is measured from sentAtDevice and flagged beyond 5 minutes
 *   PS-O13  another company's Guard cannot sync into this company
 *   PS-O14  a run left open past the acceptance window is closed by the system (abandonment already raised)
 *   PS-O15  the post-shift acceptance window is the policy's (postShiftSyncHours)
 *
 * Needs PATROL_SCHEDULE_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

const url = process.env.PATROL_SCHEDULE_DATABASE_URL;
if (!url) throw new Error('PATROL_SCHEDULE_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Patrol schedule database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-schedule-local-certification-secret-not-production';
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
const PASSWORD = 'patrol-schedule-spec-only-password-1';
const MIN = 60_000;
const HOUR = 60 * MIN;
const Z = (s: string) => new Date(s);
const iso = (ms: number | Date = Date.now()) => new Date(ms).toISOString();
let clientSeq = 0;
const cid = (p: string) => `${p}-${Date.now().toString(36)}-${(++clientSeq).toString().padStart(4, '0')}`;
const near = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} not within ${tolerance} of ${expected}`);

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
  assert.equal(migrated[migrated.length - 1]?.name, 'AddPatrolEvidenceStorage1720900000016', 'the head is Migration 70');
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
  const sweeper = app.get(PatrolSweepService);
  const safety = app.get(SafetyAlertService);
  sweeper.onModuleDestroy(); // every sweep in this suite is explicit, on its own clock
  safety.onModuleDestroy();
  const auth = app.get(AuthService);

  const W = await import('../src/patrol/patrol-window.service');
  const S = await import('../src/patrol/patrol-state');
  const L = await import('../src/patrol/patrol-late-sync');
  const { PatrolErrorCode } = await import('../src/patrol/patrol-constants');

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const scalar = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0];
  const count = async (sql: string, params: unknown[] = []) => Number(await scalar(sql, params));
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
  };
  const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;

  // ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash(PASSWORD, 4);
  let seq = 0;
  const mkUser = async (email: string, role: string) =>
    (await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
       VALUES ($1,$2,$3,'active',true,false,$4,'Spec') RETURNING id`, [email, hash, role, email.split('@')[0]])).id as number;
  const mkCompany = async (label: string) => {
    seq += 1;
    const ownerEmail = `ps.${label}.owner@example.invalid`;
    const ownerId = await mkUser(ownerEmail, 'company_admin');
    const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,$2,$3,'1 Way','ops@example.invalid') RETURNING id`,
      [ownerId, `PS ${label} Ltd`, String(69000000 + seq)]);
    return { id: Number(id), ownerId, ownerEmail };
  };
  const mkSite = async (companyId: number, name: string, tz = 'Europe/London') =>
    Number((await one(`INSERT INTO sites ("companyId",name,address,timezone) VALUES ($1,$2,'3 Quay',$3) RETURNING id`, [companyId, name, tz])).id);
  const mkGuard = async (label: string) => {
    seq += 1;
    const email = `ps.${label}@example.invalid`;
    const userId = await mkUser(email, 'guard');
    const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, `Guard ${label}`, `69${String(seq).padStart(14, '0')}`, `0771${String(seq).padStart(7, '0')}`]);
    return { id: Number(id), userId, email };
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
  const mkSchedule = async (companyId: number, siteId: number, s: { name?: string; from: string; to: string; freq: number; win?: number; days?: number[]; routeId?: number | null; startsOn?: string | null }) =>
    one(`INSERT INTO patrol_schedules ("companyId","siteId","routeId",name,"daysOfWeek","activeFrom","activeTo","frequencyMinutes","windowMinutes","startsOn","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,'2026-01-01','2026-01-01') RETURNING *`,
      [companyId, siteId, s.routeId ?? null, s.name ?? 'Patrol', JSON.stringify(s.days ?? [1, 2, 3, 4, 5, 6, 7]), s.from, s.to, s.freq, s.win ?? s.freq, s.startsOn ?? null]);
  const setPolicy = (companyId: number, siteId: number, fields: Record<string, unknown>) => {
    const cols = Object.keys(fields);
    return q(`INSERT INTO patrol_policies ("companyId","siteId",${cols.map((c) => `"${c}"`).join(',')}) VALUES ($1,$2,${cols.map((_, i) => `$${i + 3}`).join(',')})
      ON CONFLICT ("companyId","siteId") WHERE "siteId" IS NOT NULL DO UPDATE SET ${cols.map((c, i) => `"${c}" = $${i + 3}`).join(',')}`,
      [companyId, siteId, ...cols.map((c) => fields[c])]);
  };
  const mkCheckpoint = async (companyId: number, siteId: number, label: string, photoRequired = false) =>
    one(`INSERT INTO patrol_checkpoints ("companyId","siteId","publicId",label,"photoRequired") VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [companyId, siteId, require('node:crypto').randomBytes(16).toString('hex'), label, photoRequired]);
  const insRun = async (r: {
    companyId: number; siteId: number; shiftId: number; guard: { id: number; userId: number }; scheduleId?: number | null; routeId?: number | null;
    window?: { windowKey: string; start: Date; end: Date } | null; scopeKey?: string; status?: string; startedAt: Date; completedAt?: Date | null;
    reason?: string | null; lateStart?: boolean;
  }) => one(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","scheduleId","routeId","windowKey","windowStart","windowEnd","scopeKey",
       status,"startedAtDevice","startedAtServer","completedAtDevice","completedAtServer","exceptionReason","clientRunId","lateStart")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$14,$15,$16,$17) RETURNING *`,
    [r.companyId, r.siteId, r.shiftId, r.guard.id, r.guard.userId, r.scheduleId ?? null, r.routeId ?? null, r.window?.windowKey ?? null,
      r.window?.start ?? null, r.window?.end ?? null, r.scopeKey ?? 'site', r.status ?? 'in_progress', r.startedAt, r.completedAt ?? null, r.reason ?? null, cid('run'),
      r.lateStart ?? false]);
  const insVisit = (companyId: number, runId: number, checkpoint: any, result: string, at: Date) =>
    one(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","checkpointId","scannedPublicId",result,"scannedAtDevice","clientVisitId")
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [companyId, runId, checkpoint.id, checkpoint.publicId, result, at, cid('visit')]);
  const insEvidence = (run: any, kind: string, uploadStatus: string, visitId: number | null = null) =>
    q(`INSERT INTO patrol_evidence ("companyId","siteId","runId","visitId","guardId","shiftId",kind,"uploadStatus","sha256Client","capturedAtDevice","clientEvidenceId")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [run.companyId, run.siteId, run.id, visitId, run.guardId, run.shiftId, kind, uploadStatus, 'c'.repeat(64), run.startedAtDevice, cid('ev')]);
  /** Only this company's switch is on, so a sweep judges only it. */
  const focus = (companyId: number) => q(`UPDATE companies SET "patrolsEnabled" = (id = $1)`, [companyId]);
  const sweep = (at: Date | string) => sweeper.sweep(new Date(at));
  const exceptionsOf = (companyId: number) => q(`SELECT * FROM patrol_exceptions WHERE "companyId" = $1 ORDER BY "windowKey", "scopeKey", type, id`, [companyId]);
  const alertsOf = (companyId: number) => q(`SELECT * FROM safety_alerts WHERE "companyId" = $1 AND type::text LIKE ANY(ARRAY['patrol_%','checkpoint_missed']) ORDER BY id`, [companyId]);
  const windowsOf = (schedule: any, from: string, to: string) => W.windowsBetween(schedule, 'Europe/London', Z(from), Z(to));

  const platformEmail = 'ps.platform@example.invalid';
  await mkUser(platformEmail, 'admin');

  try {
    // ═══════════════════ Windows (pure) ═══════════════════
    const sched = (o: Partial<{ id: number; from: string; to: string; freq: number; win: number; days: number[]; startsOn: string | null; endsOn: string | null }>) => ({
      id: o.id ?? 7, daysOfWeek: o.days ?? [1, 2, 3, 4, 5, 6, 7], activeFrom: o.from ?? '08:00', activeTo: o.to ?? '12:00',
      frequencyMinutes: o.freq ?? 60, windowMinutes: o.win ?? o.freq ?? 60, startsOn: o.startsOn ?? null, endsOn: o.endsOn ?? null,
    });
    const span = (w: any) => [w.start.toISOString(), w.end.toISOString()];

    await test('PS-W01-HOURLY-WINDOWS-ARE-SITE-LOCAL-WALL-CLOCK-WITH-STABLE-KEYS', () => {
      const ws = W.windowsForLocalDate(sched({}), '2026-06-02', 'Europe/London');
      assert.deepEqual(ws.map(span), [
        ['2026-06-02T07:00:00.000Z', '2026-06-02T08:00:00.000Z'], ['2026-06-02T08:00:00.000Z', '2026-06-02T09:00:00.000Z'],
        ['2026-06-02T09:00:00.000Z', '2026-06-02T10:00:00.000Z'], ['2026-06-02T10:00:00.000Z', '2026-06-02T11:00:00.000Z'],
      ], '08:00–12:00 BST');
      assert.deepEqual(ws.map((w) => w.windowKey), ['s7:2026-06-02:0', 's7:2026-06-02:1', 's7:2026-06-02:2', 's7:2026-06-02:3']);
      const winter = W.windowsForLocalDate(sched({}), '2026-12-02', 'Europe/London');
      assert.equal(winter[0].start.toISOString(), '2026-12-02T08:00:00.000Z', '08:00 GMT in winter: the wall clock, not a fixed offset');
      assert.deepEqual(W.windowsForLocalDate(sched({}), '2026-06-02', 'Europe/London').map((w) => w.windowKey), ws.map((w) => w.windowKey), 'stable');
    });

    await test('PS-W02-CUSTOM-FREQUENCY-WINDOW-LENGTH-AND-THE-CLIP-TO-ACTIVE-TO', () => {
      assert.deepEqual(W.windowsForLocalDate(sched({ from: '10:00', to: '14:00', freq: 90, win: 30 }), '2026-12-02', 'Europe/London').map(span), [
        ['2026-12-02T10:00:00.000Z', '2026-12-02T10:30:00.000Z'], ['2026-12-02T11:30:00.000Z', '2026-12-02T12:00:00.000Z'], ['2026-12-02T13:00:00.000Z', '2026-12-02T13:30:00.000Z'],
      ]);
      assert.deepEqual(W.windowsForLocalDate(sched({ from: '10:00', to: '11:00', freq: 45 }), '2026-12-02', 'Europe/London').map(span), [
        ['2026-12-02T10:00:00.000Z', '2026-12-02T10:45:00.000Z'], ['2026-12-02T10:45:00.000Z', '2026-12-02T11:00:00.000Z'],
      ], 'the last window is clipped to activeTo');
      assert.equal(W.windowsForLocalDate(sched({ from: '00:00', to: '00:00', freq: 15 }), '2026-12-02', 'Europe/London').length, 96, '15-minute minimum, whole day');
      assert.equal(W.windowsForLocalDate(sched({ from: '06:00', to: '06:00', freq: 1440 }), '2026-12-02', 'Europe/London').length, 1, '24 h maximum');
    });

    await test('PS-W03-OVERNIGHT-22-06-BELONGS-TO-THE-DAY-IT-STARTS', () => {
      const fridays = sched({ from: '22:00', to: '06:00', freq: 60, days: [5] });
      const ws = windowsOf(fridays, '2026-12-04T12:00:00Z', '2026-12-06T12:00:00Z'); // Fri 4 Dec → Sun 6 Dec
      assert.equal(ws.length, 8, 'only Friday night, not Saturday night');
      assert.ok(ws.every((w) => w.localDate === '2026-12-04'), 'every slot belongs to Friday');
      assert.deepEqual([span(ws[0])[0], span(ws[7])[1]], ['2026-12-04T22:00:00.000Z', '2026-12-05T06:00:00.000Z']);
      assert.equal(windowsOf({ ...fridays, endsOn: '2026-12-03' }, '2026-12-04T12:00:00Z', '2026-12-06T12:00:00Z').length, 0, 'endsOn');
      assert.equal(windowsOf({ ...fridays, startsOn: '2026-12-05' }, '2026-12-04T12:00:00Z', '2026-12-06T12:00:00Z').length, 0, 'startsOn');
    });

    const nightly = (freq: number) => sched({ from: '22:00', to: '06:00', freq });
    const contiguous = (ws: any[]) => ws.every((w, i) => i === 0 || ws[i - 1].end.getTime() === w.start.getTime());
    await test('PS-W04-UK-SPRING-FORWARD-29-MAR-2026-HOURLY-OVERNIGHT', () => {
      const ws = W.windowsForLocalDate(nightly(60), '2026-03-28', 'Europe/London');
      assert.deepEqual(ws.map((w) => w.slotIndex), [0, 1, 2, 4, 5, 6, 7], 'the 01:00 slot does not exist that night');
      assert.deepEqual(ws.map(span), [
        ['2026-03-28T22:00:00.000Z', '2026-03-28T23:00:00.000Z'], ['2026-03-28T23:00:00.000Z', '2026-03-29T00:00:00.000Z'],
        ['2026-03-29T00:00:00.000Z', '2026-03-29T01:00:00.000Z'], ['2026-03-29T01:00:00.000Z', '2026-03-29T02:00:00.000Z'],
        ['2026-03-29T02:00:00.000Z', '2026-03-29T03:00:00.000Z'], ['2026-03-29T03:00:00.000Z', '2026-03-29T04:00:00.000Z'],
        ['2026-03-29T04:00:00.000Z', '2026-03-29T05:00:00.000Z'],
      ]);
      assert.ok(contiguous(ws), 'contiguous: nothing uncovered, nothing twice');
      assert.equal(new Set(ws.map((w) => w.start.getTime())).size, ws.length, 'no duplicate window');
    });

    await test('PS-W05-UK-SPRING-FORWARD-30-MIN-AND-A-WINDOW-STARTING-IN-THE-GAP', () => {
      const ws = W.windowsForLocalDate(nightly(30), '2026-03-28', 'Europe/London');
      assert.equal(ws.length, 14);
      assert.ok(!ws.some((w) => [6, 7].includes(w.slotIndex)), '01:00 and 01:30 do not exist');
      assert.ok(contiguous(ws));
      const gap = W.windowsForLocalDate(sched({ from: '00:30', to: '03:30', freq: 60 }), '2026-03-29', 'Europe/London');
      assert.deepEqual(gap.map(span), [
        ['2026-03-29T00:30:00.000Z', '2026-03-29T01:00:00.000Z'],
        ['2026-03-29T01:00:00.000Z', '2026-03-29T01:30:00.000Z'],
        ['2026-03-29T01:30:00.000Z', '2026-03-29T02:30:00.000Z'],
      ], 'the 01:30 window starts when the clocks go forward (02:00 BST = 01:00Z)');
    });

    await test('PS-W06-UK-CLOCKS-BACK-25-OCT-2026-HOURLY-OVERNIGHT', () => {
      const ws = W.windowsForLocalDate(nightly(60), '2026-10-24', 'Europe/London');
      assert.equal(ws.length, 8, 'the repeated hour is not a second window');
      assert.deepEqual(span(ws[3]), ['2026-10-25T00:00:00.000Z', '2026-10-25T02:00:00.000Z'], '01:00 BST (earliest occurrence) to 02:00 GMT');
      assert.deepEqual([span(ws[0])[0], span(ws[7])[1]], ['2026-10-24T21:00:00.000Z', '2026-10-25T06:00:00.000Z']);
      assert.ok(contiguous(ws));
      assert.equal(new Set(ws.map((w) => w.windowKey)).size, 8);
    });

    await test('PS-W07-UK-CLOCKS-BACK-25-OCT-2026-30-MIN', () => {
      const ws = W.windowsForLocalDate(nightly(30), '2026-10-24', 'Europe/London');
      assert.equal(ws.length, 16);
      assert.ok(contiguous(ws));
      assert.deepEqual([span(ws[6]), span(ws[7])], [
        ['2026-10-25T00:00:00.000Z', '2026-10-25T00:30:00.000Z'], ['2026-10-25T00:30:00.000Z', '2026-10-25T02:00:00.000Z'],
      ]);
      assert.equal(new Set(ws.map((w) => w.start.getTime())).size, 16);
    });

    await test('PS-W08-A-RUN-SATISFIES-EXACTLY-ONE-WINDOW-OR-THE-ONE-IT-STARTED-LATE-FOR', () => {
      const hourly = sched({});
      const at = (t: string, s = hourly) => W.windowForStart(s, 'Europe/London', Z(t), 15);
      assert.deepEqual([at('2026-06-02T07:20:00Z')!.window.slotIndex, at('2026-06-02T07:20:00Z')!.lateStart], [0, false]);
      assert.deepEqual([at('2026-06-02T08:05:00Z')!.window.slotIndex, at('2026-06-02T08:05:00Z')!.lateStart], [1, false], 'contiguous: the open window');
      const half = sched({ freq: 60, win: 30 });
      assert.deepEqual([at('2026-06-02T07:35:00Z', half)!.window.slotIndex, at('2026-06-02T07:35:00Z', half)!.lateStart], [0, true], 'late, within grace');
      assert.deepEqual([at('2026-06-02T07:30:00Z', half)!.window.slotIndex, at('2026-06-02T07:30:00Z', half)!.lateStart], [0, true], 'exactly at window end: late');
      assert.equal(at('2026-06-02T07:45:00Z', half), null, 'exactly at end + grace: too late for any window');
      assert.equal(at('2026-06-02T05:00:00Z'), null, 'before the active period');
    });

    // ═══════════════════ Deadlines and rules (pure) ═══════════════════
    await test('PS-D01-START-DEADLINE-AND-LATE-START-BOUNDARIES-ARE-EXACT', () => {
      const end = Z('2026-06-02T08:00:00Z');
      assert.equal(S.startDeadline(end, 15).toISOString(), '2026-06-02T08:15:00.000Z');
      assert.equal(S.windowState({ hasRun: false, windowEnd: end, startGraceMinutes: 15, now: Z('2026-06-02T08:14:59.999Z') }), 'due');
      assert.equal(S.windowState({ hasRun: false, windowEnd: end, startGraceMinutes: 15, now: Z('2026-06-02T08:15:00.000Z') }), 'missed');
      assert.equal(S.windowState({ hasRun: true, windowEnd: end, startGraceMinutes: 15, now: Z('2026-06-02T12:00:00Z') }), 'started');
      assert.equal(S.isLateStart(Z('2026-06-02T07:59:59.999Z'), end, 15), false);
      assert.equal(S.isLateStart(end, end, 15), true);
      assert.equal(S.isLateStart(Z('2026-06-02T08:14:59.999Z'), end, 15), true);
      assert.equal(S.isLateStart(Z('2026-06-02T08:15:00.000Z'), end, 15), false);
    });

    const grace = { startGraceMinutes: 15, maxPatrolDurationMinutes: 45, completionGraceMinutes: 30, syncGraceMinutes: 60 };
    await test('PS-D02-COMPLETION-DEADLINE-IS-THE-EARLIER-OF-DURATION-AND-WINDOW-GRACE', () => {
      const end = Z('2026-06-02T08:00:00Z');
      assert.equal(S.completionDeadline(Z('2026-06-02T07:05:00Z'), end, grace).toISOString(), '2026-06-02T07:50:00.000Z', 'start + 45');
      assert.equal(S.completionDeadline(Z('2026-06-02T07:55:00Z'), end, grace).toISOString(), '2026-06-02T08:30:00.000Z', 'window end + 30');
      assert.equal(S.completionDeadline(Z('2026-06-02T07:05:00Z'), null, grace).toISOString(), '2026-06-02T07:50:00.000Z', 'no window');
      const dl = Z('2026-06-02T07:50:00Z');
      assert.equal(S.runProgressState({ status: 'in_progress', completionDeadline: dl, now: Z('2026-06-02T07:49:59.999Z') }), 'in_progress');
      assert.equal(S.runProgressState({ status: 'in_progress', completionDeadline: dl, now: dl }), 'abandoned');
      assert.equal(S.runProgressState({ status: 'completed', completionDeadline: dl, now: Z('2026-06-03T00:00:00Z') }), 'finished');
    });

    await test('PS-D03-SYNC-DEADLINE-AND-THE-24H-SETTLEMENT', () => {
      const dl = Z('2026-06-02T07:50:00Z');
      assert.equal(S.syncDeadline(dl, 60).toISOString(), '2026-06-02T08:50:00.000Z');
      assert.equal(S.verificationFinalAt(S.syncDeadline(dl, 60)).toISOString(), '2026-06-03T08:50:00.000Z');
    });

    await test('PS-D04-REQUIREMENTS-FINDINGS-AND-VERIFICATION', () => {
      const r = S.evaluateRequirements({
        requiredCheckpointIds: [1, 2, 3], photoRequiredCheckpointIds: [1], photosPerRun: 1, photosPerCheckpoint: 0,
        visits: [{ visitId: 10, checkpointId: 1, result: 'verified' }, { visitId: 11, checkpointId: 2, result: 'flagged' }, { visitId: 12, checkpointId: 3, result: 'unverified' }],
        evidence: [{ kind: 'run_photo', visitId: null, uploadStatus: 'pending' }, { kind: 'checkpoint_photo', visitId: 10, uploadStatus: 'verified' }],
      });
      assert.deepEqual(r.missingCheckpointIds, [2], 'a flagged scan never counts; an unverified (unsigned) one does');
      assert.deepEqual([r.missingRunPhotos, r.missingCheckpointPhotos, r.photosNotOnServer, r.anyFlaggedScan], [0, 0, 1, true]);
      assert.deepEqual(S.completionFindings({ status: 'completed', exceptionReason: null, incompleteNeedsAction: true, requirements: r }).map((f) => f.type), ['checkpoint_missed']);
      assert.deepEqual(S.completionFindings({ status: 'incomplete', exceptionReason: 'Gate locked', incompleteNeedsAction: false, requirements: r }),
        [{ type: 'patrol_incomplete', actionable: false, reason: 'Gate locked' }]);
      assert.equal(S.verificationState({ requirements: r, now: Z('2026-06-02T09:00:00Z'), syncDeadline: Z('2026-06-02T08:50:00Z') }), 'flagged');
      const clean = { ...r, missingCheckpointIds: [], anyFlaggedScan: false };
      assert.equal(S.verificationState({ requirements: clean, now: Z('2026-06-02T08:49:59Z'), syncDeadline: Z('2026-06-02T08:50:00Z') }), 'pending');
      assert.equal(S.verificationState({ requirements: clean, now: Z('2026-06-02T08:50:00Z'), syncDeadline: Z('2026-06-02T08:50:00Z') }), 'unverified');
      assert.equal(S.verificationState({ requirements: { ...clean, photosNotOnServer: 0 }, now: Z('2026-06-02T08:00:00Z'), syncDeadline: Z('2026-06-02T08:50:00Z') }), 'verified');
    });

    await test('PS-L01-THE-POST-SHIFT-LEGITIMACY-RULE', () => {
      const bookOn = Z('2026-06-02T06:00:00Z');
      const bookOffAt = Z('2026-06-02T14:00:00Z');
      const base = {
        bookOnAt: bookOn, bookOffAt, shiftEnd: Z('2026-06-02T14:00:00Z'), postShiftSyncHours: 24, clockDriftThresholdMinutes: 5,
        startedAtDevice: Z('2026-06-02T10:00:00Z'), driftMs: null as number | null, scheduled: true, matchingWindow: true, allowUnscheduledPatrols: true,
      };
      const ok = L.evaluatePostShiftStart({ ...base, now: Z('2026-06-02T15:00:00Z') });
      assert.deepEqual(ok.accept && [ok.flags, ok.needsReview], [['post_shift_creation'], false]);
      const no = L.evaluatePostShiftStart({ ...base, bookOnAt: null, now: Z('2026-06-02T15:00:00Z') });
      assert.deepEqual(!no.accept && no.code, PatrolErrorCode.SYNC_NOT_BOOKED_ON);
      const edge = L.evaluatePostShiftStart({ ...base, now: Z('2026-06-03T14:00:00Z') });
      assert.equal(edge.accept, true, 'exactly 24 h after Book Off is still inside');
      const closed = L.evaluatePostShiftStart({ ...base, now: Z('2026-06-03T14:00:00.001Z') });
      assert.deepEqual(!closed.accept && closed.code, PatrolErrorCode.SYNC_WINDOW_CLOSED);
      const outside = L.evaluatePostShiftStart({ ...base, startedAtDevice: Z('2026-06-02T05:00:00Z'), now: Z('2026-06-02T15:00:00Z') });
      assert.deepEqual(outside.accept && [outside.flags, outside.needsReview], [['post_shift_creation', 'outside_on_duty_interval'], true]);
      const nowin = L.evaluatePostShiftStart({ ...base, matchingWindow: false, now: Z('2026-06-02T15:00:00Z') });
      assert.deepEqual(nowin.accept && nowin.flags, ['post_shift_creation', 'no_matching_window']);
      const unscheduled = L.evaluatePostShiftStart({ ...base, scheduled: false, matchingWindow: false, now: Z('2026-06-02T15:00:00Z') });
      assert.deepEqual(unscheduled.accept && unscheduled.flags, ['post_shift_creation'], 'unscheduled patrols allowed by policy');
      const notAllowed = L.evaluatePostShiftStart({ ...base, scheduled: false, matchingWindow: false, allowUnscheduledPatrols: false, now: Z('2026-06-02T15:00:00Z') });
      assert.deepEqual(notAllowed.accept && notAllowed.flags, ['post_shift_creation', 'no_matching_window']);
      // A phone 2 h fast claims 11:00 but was really at 09:00 — still inside duty once adjusted; the drift itself is flagged.
      const drift = L.evaluatePostShiftStart({ ...base, startedAtDevice: Z('2026-06-02T16:30:00Z'), driftMs: -3 * HOUR, now: Z('2026-06-02T15:00:00Z') });
      assert.deepEqual(drift.accept && [drift.flags, drift.adjustedStart.toISOString()], [['post_shift_creation', 'clock_drift_suspect'], '2026-06-02T13:30:00.000Z']);
      assert.equal(L.syncAcceptanceEndsAt(null, Z('2026-06-02T14:00:00Z'), 24).toISOString(), '2026-06-03T14:00:00.000Z', 'no Book Off: the shift end');
    });

    await test('PS-L02-CLOCK-DRIFT-MEASURE-AND-THRESHOLD', () => {
      const received = Z('2026-06-02T10:00:00Z');
      assert.equal(L.clockDriftMs(received, null), null);
      assert.equal(L.clockDriftMs(received, Z('2026-06-02T09:50:00Z')), 10 * MIN, 'a slow phone: positive drift');
      assert.equal(L.clockDriftMs(received, Z('2026-06-02T10:05:00Z')), -5 * MIN, 'a fast phone: negative drift');
      assert.equal(L.isClockDriftSuspect(5 * MIN, 5), false, 'exactly the threshold is not suspect');
      assert.equal(L.isClockDriftSuspect(5 * MIN + 1, 5), true);
      assert.equal(L.isClockDriftSuspect(-(5 * MIN + 1), 5), true);
      assert.equal(L.adjustForDrift(Z('2026-06-02T09:00:00Z'), 10 * MIN).toISOString(), '2026-06-02T09:10:00.000Z');
    });

    // ═══════════════════ The sweep ═══════════════════
    // One company per scenario; focus() turns only that company's switch on, so a sweep judges only it.
    const scenario = async (label: string, guards = 1) => {
      const co = await mkCompany(label);
      const site = await mkSite(co.id, `${label} Gate`);
      const gs = [];
      for (let i = 0; i < guards; i += 1) gs.push(await mkGuard(`${label}${i + 1}`));
      await focus(co.id);
      return { co, site, guards: gs };
    };
    // 2026-06-02 is a Tuesday in BST: 08:00–12:00 local is 07:00Z–11:00Z.
    const day = (t: string) => Z(`2026-06-02T${t}Z`);

    let s01: any;
    await test('PS-S01-A-MISSED-WINDOW-RAISES-ONE-EXCEPTION-AND-ONE-ALERT-LINKED-BOTH-WAYS', async () => {
      s01 = await scenario('s01');
      const [g] = s01.guards;
      s01.schedule = await mkSchedule(s01.co.id, s01.site, { name: 'Perimeter', from: '08:00', to: '12:00', freq: 60 });
      s01.shift = await mkShift(s01.co.id, s01.site, g.id, day('06:00:00'), day('14:00:00'));
      await bookOn(s01.shift, g.id, day('05:55:00'));
      await sweep(day('08:14:59.999'));
      assert.equal((await exceptionsOf(s01.co.id)).length, 0, 'inside the start grace: nothing');
      const counters = await sweep(day('08:15:00.000'));
      const ex = await exceptionsOf(s01.co.id);
      assert.deepEqual(ex.map((e: any) => [e.windowKey, e.scopeKey, e.type, e.status]), [[`s${s01.schedule.id}:2026-06-02:0`, 'site', 'patrol_missed', 'open']]);
      assert.deepEqual([counters.exceptionsRaised, counters.alertsRaised], [1, 1]);
      const alerts = await alertsOf(s01.co.id);
      assert.equal(alerts.length, 1);
      const [a] = alerts;
      assert.deepEqual([a.type, a.priority, a.status, Number(a.patrolExceptionId), a.patrolWindowKey, a.patrolRunId, Number(a.shiftId), Number(a.guardId)],
        ['patrol_missed', 'high', 'open', Number(ex[0].id), ex[0].windowKey, null, s01.shift, g.id]);
      assert.equal(Number(ex[0].safetyAlertId), Number(a.id), 'linked both ways');
      assert.deepEqual([iso(ex[0].windowStart), iso(ex[0].windowEnd), Number(ex[0].guardId)], ['2026-06-02T07:00:00.000Z', '2026-06-02T08:00:00.000Z', g.id]);
      assert.match(a.message, /Patrol missed: Perimeter 08:00–09:00 at s01 Gate/);
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.exception_raised' AND "entityId" = $1`, [ex[0].id]), 1);
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.alert_raised' AND "entityId" = $1`, [a.id]), 1);
      await sweep(day('08:20:00'));
      await sweep(day('08:20:00'));
      assert.equal((await exceptionsOf(s01.co.id)).length, 1, 'repeated sweeps add nothing');
      assert.equal((await alertsOf(s01.co.id)).length, 1);
    });

    await test('PS-S02-WINDOWS-BEFORE-THE-EFFECTIVE-BOOK-ON-ARE-NOT-JUDGED', async () => {
      const s = await scenario('s02');
      const [g] = s.guards;
      const schedule = await mkSchedule(s.co.id, s.site, { from: '08:00', to: '12:00', freq: 60 });
      const shift = await mkShift(s.co.id, s.site, g.id, day('06:00:00'), day('14:00:00'));
      await bookOn(shift, g.id, day('09:30:00')); // 10:30 BST
      await sweep(day('11:30:00'));
      assert.deepEqual((await exceptionsOf(s.co.id)).map((e: any) => e.windowKey),
        [`s${schedule.id}:2026-06-02:2`, `s${schedule.id}:2026-06-02:3`], 'the 10:00 window (booked on during it) and 11:00; never 08:00 or 09:00');
      const noBookOn = await scenario('s02b');
      await mkSchedule(noBookOn.co.id, noBookOn.site, { from: '08:00', to: '12:00', freq: 60 });
      await mkShift(noBookOn.co.id, noBookOn.site, noBookOn.guards[0].id, day('06:00:00'), day('14:00:00'));
      await sweep(day('13:00:00'));
      assert.equal((await exceptionsOf(noBookOn.co.id)).length, 0, 'never booked on: nobody was on duty');
    });

    await test('PS-S03-A-CANCELLED-SHIFT-DROPS-ITS-WINDOWS', async () => {
      const s = await scenario('s03');
      const [g] = s.guards;
      await mkSchedule(s.co.id, s.site, { from: '08:00', to: '12:00', freq: 60 });
      const shift = await mkShift(s.co.id, s.site, g.id, day('06:00:00'), day('14:00:00'), 'cancelled');
      await bookOn(shift, g.id, day('05:55:00'));
      await sweep(day('13:00:00'));
      assert.deepEqual([(await exceptionsOf(s.co.id)).length, (await alertsOf(s.co.id)).length], [0, 0]);
    });

    const windowAt = (schedule: any, t: string) => W.windowForStart(schedule, 'Europe/London', Z(t), 15)!.window;
    await test('PS-S04-PER-SITE-ANY-ON-DUTY-GUARD-SATISFIES-THE-WINDOW', async () => {
      const s = await scenario('s04', 2);
      const schedule = await mkSchedule(s.co.id, s.site, { from: '08:00', to: '10:00', freq: 60 });
      const shifts = [];
      for (const g of s.guards) {
        const id = await mkShift(s.co.id, s.site, g.id, day('06:00:00'), day('14:00:00'));
        await bookOn(id, g.id, day('05:55:00'));
        shifts.push(id);
      }
      await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shifts[1], guard: s.guards[1], scheduleId: schedule.id, window: windowAt(schedule, '2026-06-02T07:10:00Z'),
        status: 'completed', startedAt: day('07:10:00'), completedAt: day('07:30:00') });
      await sweep(day('09:15:00'));
      assert.deepEqual((await exceptionsOf(s.co.id)).map((e: any) => [e.windowKey, e.scopeKey]), [[`s${schedule.id}:2026-06-02:1`, 'site']],
        'the second Guard\'s patrol covered 08:00 for the site; 09:00 was missed once for the site');
    });

    await test('PS-S05-PER-GUARD-EACH-ON-DUTY-GUARD-MUST-PATROL', async () => {
      const s = await scenario('s05', 2);
      await setPolicy(s.co.id, s.site, { requirementScope: 'per_guard' });
      const schedule = await mkSchedule(s.co.id, s.site, { from: '08:00', to: '09:00', freq: 60 });
      const shifts: number[] = [];
      for (const g of s.guards) {
        const id = await mkShift(s.co.id, s.site, g.id, day('06:00:00'), day('14:00:00'));
        await bookOn(id, g.id, day('05:55:00'));
        shifts.push(id);
      }
      await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shifts[0], guard: s.guards[0], scheduleId: schedule.id, window: windowAt(schedule, '2026-06-02T07:10:00Z'),
        scopeKey: `sh${shifts[0]}`, status: 'completed', startedAt: day('07:10:00'), completedAt: day('07:30:00') });
      await sweep(day('08:15:00'));
      const ex = await exceptionsOf(s.co.id);
      assert.deepEqual(ex.map((e: any) => [e.scopeKey, Number(e.shiftId), Number(e.guardId)]), [[`sh${shifts[1]}`, shifts[1], s.guards[1].id]]);
      assert.deepEqual((await alertsOf(s.co.id)).map((a: any) => Number(a.guardId)), [s.guards[1].id]);
    });

    await test('PS-S06-OVERLAPPING-SCHEDULES-ARE-INDEPENDENT', async () => {
      const s = await scenario('s06');
      const [g] = s.guards;
      const a = await mkSchedule(s.co.id, s.site, { name: 'Outer', from: '08:00', to: '09:00', freq: 60 });
      const b = await mkSchedule(s.co.id, s.site, { name: 'Inner', from: '08:00', to: '09:00', freq: 30 });
      const shift = await mkShift(s.co.id, s.site, g.id, day('06:00:00'), day('14:00:00'));
      await bookOn(shift, g.id, day('05:55:00'));
      await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, scheduleId: a.id, window: windowAt(a, '2026-06-02T07:10:00Z'),
        status: 'completed', startedAt: day('07:10:00'), completedAt: day('07:30:00') });
      await sweep(day('08:30:00'));
      assert.deepEqual((await exceptionsOf(s.co.id)).map((e: any) => [Number(e.scheduleId), e.windowKey]),
        [[b.id, `s${b.id}:2026-06-02:0`], [b.id, `s${b.id}:2026-06-02:1`]], 'the Outer run satisfies only its own window; Inner is still due twice');
    });

    await test('PS-S07-A-LATE-STARTED-RUN-SATISFIES-ITS-WINDOW', async () => {
      const s = await scenario('s07');
      const [g] = s.guards;
      const schedule = await mkSchedule(s.co.id, s.site, { from: '08:00', to: '09:00', freq: 60, win: 30 });
      const shift = await mkShift(s.co.id, s.site, g.id, day('06:00:00'), day('14:00:00'));
      await bookOn(shift, g.id, day('05:55:00'));
      const assigned = W.windowForStart(schedule, 'Europe/London', day('07:40:00'), 15)!;
      assert.equal(assigned.lateStart, true);
      await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, scheduleId: schedule.id, window: assigned.window, lateStart: true,
        status: 'completed', startedAt: day('07:40:00'), completedAt: day('08:00:00') });
      await sweep(day('10:00:00'));
      assert.equal((await exceptionsOf(s.co.id)).length, 0, 'late, not missed');
    });

    await test('PS-S08-ABANDONED-AT-THE-COMPLETION-DEADLINE-STARTING-NEVER-CANCELS-IT', async () => {
      const s = await scenario('s08');
      const [g] = s.guards;
      const schedule = await mkSchedule(s.co.id, s.site, { from: '08:00', to: '09:00', freq: 60 });
      const shift = await mkShift(s.co.id, s.site, g.id, day('06:00:00'), day('14:00:00'));
      await bookOn(shift, g.id, day('05:55:00'));
      const run = await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, scheduleId: schedule.id, window: windowAt(schedule, '2026-06-02T07:05:00Z'),
        startedAt: day('07:05:00') });
      await sweep(day('07:49:59.999'));
      assert.equal((await exceptionsOf(s.co.id)).length, 0);
      await sweep(day('07:50:00.000'));
      const ex = await exceptionsOf(s.co.id);
      assert.deepEqual(ex.map((e: any) => [e.type, Number(e.runId), e.windowKey]), [['patrol_abandoned', Number(run.id), run.windowKey]], 'start + 45 min; never missed (it started)');
      const [a] = await alertsOf(s.co.id);
      assert.deepEqual([a.type, a.priority, Number(a.patrolRunId), Number(a.patrolExceptionId)], ['patrol_abandoned', 'high', Number(run.id), Number(ex[0].id)]);
      assert.equal((await one(`SELECT status FROM patrol_runs WHERE id = $1`, [run.id])).status, 'in_progress', 'the run itself stays open: its completion may still sync');
    });

    await test('PS-S09-MISSED-COMPLETION-DEADLINE-WHEN-THE-WINDOW-GRACE-COMES-FIRST', async () => {
      const s = await scenario('s09');
      const [g] = s.guards;
      const schedule = await mkSchedule(s.co.id, s.site, { from: '08:00', to: '09:00', freq: 60 });
      const shift = await mkShift(s.co.id, s.site, g.id, day('06:00:00'), day('14:00:00'));
      await bookOn(shift, g.id, day('05:55:00'));
      await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, scheduleId: schedule.id, window: windowAt(schedule, '2026-06-02T07:55:00Z'), startedAt: day('07:55:00') });
      await sweep(day('08:29:59.999'));
      assert.equal((await exceptionsOf(s.co.id)).length, 0);
      await sweep(day('08:30:00'));
      assert.deepEqual((await exceptionsOf(s.co.id)).map((e: any) => e.type), ['patrol_abandoned'], 'window end + 30 min (earlier than start + 45)');
    });

    await test('PS-S10-INCOMPLETE-CHECKPOINTS-AND-STATED-REASONS', async () => {
      const s = await scenario('s10');
      const [g] = s.guards;
      const cp1 = await mkCheckpoint(s.co.id, s.site, 'North');
      const cp2 = await mkCheckpoint(s.co.id, s.site, 'South');
      const route = await one(`INSERT INTO patrol_routes ("companyId","siteId",name) VALUES ($1,$2,'Loop') RETURNING id`, [s.co.id, s.site]);
      await q(`INSERT INTO patrol_route_checkpoints ("companyId","siteId","routeId","checkpointId",position) VALUES ($1,$2,$3,$4,1),($1,$2,$3,$5,2)`, [s.co.id, s.site, route.id, cp1.id, cp2.id]);
      const shift = await mkShift(s.co.id, s.site, g.id, day('06:00:00'), day('14:00:00'));
      await bookOn(shift, g.id, day('05:55:00'));
      const done = await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, routeId: route.id, status: 'completed', startedAt: day('07:05:00'), completedAt: day('07:30:00') });
      await insVisit(s.co.id, done.id, cp1, 'verified', day('07:10:00'));
      await insVisit(s.co.id, done.id, cp2, 'flagged', day('07:20:00'));
      const reason = await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, status: 'incomplete', reason: 'Gate blocked by lorry', startedAt: day('07:35:00'), completedAt: day('07:40:00') });
      await sweep(day('07:41:00'));
      const ex = await exceptionsOf(s.co.id);
      assert.deepEqual(ex.map((e: any) => [e.type, Number(e.runId), e.windowKey]).sort(),
        [['checkpoint_missed', Number(done.id), `r${done.id}`], ['patrol_incomplete', Number(reason.id), `r${reason.id}`]].sort());
      assert.deepEqual((await alertsOf(s.co.id)).map((a: any) => a.type).sort(), ['checkpoint_missed', 'patrol_incomplete']);
      // A site whose policy says an incomplete patrol with a reason needs no action: the exception, no alert.
      const quiet = await mkSite(s.co.id, 's10 Quiet');
      await setPolicy(s.co.id, quiet, { incompleteNeedsAction: false });
      const shift2 = await mkShift(s.co.id, quiet, g.id, day('06:00:00'), day('14:00:00'));
      await bookOn(shift2, g.id, day('05:55:00'));
      const q2 = await insRun({ companyId: s.co.id, siteId: quiet, shiftId: shift2, guard: g, status: 'incomplete', reason: 'Rain', startedAt: day('08:00:00'), completedAt: day('08:10:00') });
      await sweep(day('08:11:00'));
      const quietEx = (await exceptionsOf(s.co.id)).filter((e: any) => Number(e.runId) === Number(q2.id));
      assert.deepEqual(quietEx.map((e: any) => [e.type, e.safetyAlertId]), [['patrol_incomplete', null]]);
      assert.equal((await alertsOf(s.co.id)).length, 2, 'no alert for it');
    });

    await test('PS-S11-PHOTOS-INCOMPLETE-UNVERIFIED-VERIFIED-AND-SETTLED', async () => {
      const s = await scenario('s11');
      const [g] = s.guards;
      await setPolicy(s.co.id, s.site, { photosPerRun: 1 });
      const loud = await mkSite(s.co.id, 's11 Loud');
      await setPolicy(s.co.id, loud, { photosPerRun: 1, escalateUnverified: true });
      const shift = await mkShift(s.co.id, s.site, g.id, day('06:00:00'), day('14:00:00'));
      await bookOn(shift, g.id, day('05:55:00'));
      const mk = (siteId: number) => insRun({ companyId: s.co.id, siteId, shiftId: shift, guard: g, status: 'completed', startedAt: day('07:05:00'), completedAt: day('07:30:00') });
      const none = await mk(s.site);
      const pending = await mk(s.site);
      await insEvidence(pending, 'run_photo', 'pending');
      const uploaded = await mk(s.site);
      await insEvidence(uploaded, 'run_photo', 'verified');
      const escalated = await mk(loud);
      await insEvidence(escalated, 'run_photo', 'pending');
      await sweep(day('07:49:59'));
      assert.deepEqual((await exceptionsOf(s.co.id)).length, 0, 'photos may still be in the outbox until the completion deadline');
      assert.equal((await one(`SELECT "verificationStatus", "verifiedAt" FROM patrol_runs WHERE id = $1`, [uploaded.id])).verificationStatus, 'verified');
      await sweep(day('07:50:00'));
      assert.deepEqual((await exceptionsOf(s.co.id)).map((e: any) => [Number(e.runId), e.type]), [[Number(none.id), 'patrol_incomplete']], 'a photo never taken');
      await sweep(day('08:49:59'));
      assert.equal((await one(`SELECT "verificationStatus" FROM patrol_runs WHERE id = $1`, [pending.id])).verificationStatus, 'pending', 'completed · pending sync');
      await sweep(day('08:50:00'));
      const unverified = (await exceptionsOf(s.co.id)).filter((e: any) => e.type === 'evidence_unverified');
      assert.deepEqual(unverified.map((e: any) => [Number(e.runId), e.safetyAlertId == null]).sort(), [[Number(pending.id), true], [Number(escalated.id), false]].sort(),
        'Patrols only, unless the policy escalates it');
      assert.deepEqual((await alertsOf(s.co.id)).map((a: any) => a.type).sort(), ['patrol_incomplete', 'patrol_unverified']);
      assert.equal((await one(`SELECT "verificationStatus" FROM patrol_runs WHERE id = $1`, [pending.id])).verificationStatus, 'unverified');
      await sweep(Z('2026-06-03T08:50:00Z'));
      assert.ok((await one(`SELECT "verificationFinalAt" FROM patrol_runs WHERE id = $1`, [pending.id])).verificationFinalAt, 'settled 24 h after the sync deadline');
      await q(`UPDATE patrol_evidence SET "uploadStatus" = 'verified' WHERE "runId" = $1`, [pending.id]);
      await sweep(Z('2026-06-03T09:00:00Z'));
      assert.equal((await one(`SELECT "verificationStatus" FROM patrol_runs WHERE id = $1`, [pending.id])).verificationStatus, 'unverified', 'final: later evidence no longer changes it');
    });

    await test('PS-S12-REPLACE-GUARD-WINDOWS-FOLLOW-THE-SHIFT-AND-THE-OUTGOING-RUN-CLOSES-GUARD-REPLACED', async () => {
      const s = await scenario('s12', 2);
      const [out, inn] = s.guards;
      await setPolicy(s.co.id, s.site, { requirementScope: 'per_guard' });
      const schedule = await mkSchedule(s.co.id, s.site, { from: '08:00', to: '10:00', freq: 60 });
      const shift = await mkShift(s.co.id, s.site, out.id, day('06:00:00'), day('14:00:00'));
      await bookOn(shift, out.id, day('05:55:00'));
      const run = await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: out, scheduleId: schedule.id, window: windowAt(schedule, '2026-06-02T07:05:00Z'),
        scopeKey: `sh${shift}`, startedAt: day('07:05:00') });
      await q(`UPDATE shifts SET "guardId" = $2 WHERE id = $1`, [shift, inn.id]); // as Replace Guard moves the shift
      const counters = await sweep(day('07:30:00'));
      assert.equal(counters.runsClosedGuardReplaced, 1);
      const closed = await one(`SELECT status, "exceptionReason", "guardId", "completedAtServer" FROM patrol_runs WHERE id = $1`, [run.id]);
      assert.deepEqual([closed.status, closed.exceptionReason, Number(closed.guardId), iso(closed.completedAtServer)], ['incomplete', 'guard_replaced', out.id, '2026-06-02T07:30:00.000Z'],
        'closed incomplete, still recording who performed it');
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.run_closed_guard_replaced' AND "entityId" = $1`, [run.id]), 1);
      const inc = (await exceptionsOf(s.co.id)).find((e: any) => e.type === 'patrol_incomplete');
      assert.deepEqual([Number(inc.runId), Number(inc.guardId)], [Number(run.id), out.id]);
      await sweep(day('09:15:00'));
      const missed = (await exceptionsOf(s.co.id)).filter((e: any) => e.type === 'patrol_missed');
      assert.deepEqual(missed.map((e: any) => [e.windowKey, e.scopeKey, Number(e.guardId)]), [[`s${schedule.id}:2026-06-02:1`, `sh${shift}`, inn.id]],
        'the next window follows the shift to the incoming Guard; the outgoing Guard\'s window had a run');
    });

    await test('PS-S13-EXACTLY-ONE-ALERT-UNDER-CONCURRENT-SWEEPS', async () => {
      const s = await scenario('s13');
      const [g] = s.guards;
      await mkSchedule(s.co.id, s.site, { from: '08:00', to: '09:00', freq: 60 });
      const shift = await mkShift(s.co.id, s.site, g.id, day('06:00:00'), day('14:00:00'));
      await bookOn(shift, g.id, day('05:55:00'));
      const results = await Promise.all([sweep(day('08:15:00')), sweep(day('08:15:00')), sweep(day('08:16:00'))]);
      assert.deepEqual([(await exceptionsOf(s.co.id)).length, (await alertsOf(s.co.id)).length], [1, 1]);
      assert.equal(results.reduce((n, r) => n + r.alertsRaised, 0), 1, 'raised once across all sweeps');
    });

    await test('PS-S14-SWITCH-OFF-STOPS-THE-SWEEP-AND-SWITCHING-ON-NEVER-JUDGES-EARLIER-WINDOWS', async () => {
      const s = await scenario('s14');
      const [g] = s.guards;
      await mkSchedule(s.co.id, s.site, { from: '00:00', to: '00:00', freq: 60 });
      const now = Date.now();
      const shift = await mkShift(s.co.id, s.site, g.id, new Date(now - 6 * HOUR), new Date(now + 6 * HOUR));
      await bookOn(shift, g.id, new Date(now - 6 * HOUR));
      await q(`UPDATE companies SET "patrolsEnabled" = false`);
      await sweep(new Date(now));
      assert.equal((await exceptionsOf(s.co.id)).length, 0, 'switched off: nothing, although windows were missed');
      const platform = await login(platformEmail);
      expect(await api('PUT', `/admin/patrols/companies/${s.co.id}`, platform, { patrolsEnabled: true }), 200);
      const enabledAt = Date.now();
      await sweep(new Date(enabledAt + 3 * HOUR));
      const ex = await exceptionsOf(s.co.id);
      assert.ok(ex.length >= 1, 'windows after the switch was turned on are judged');
      assert.ok(ex.every((e: any) => new Date(e.windowStart).getTime() >= enabledAt - 1000), 'never a window that started before it');
      expect(await api('PUT', `/admin/patrols/companies/${s.co.id}`, platform, { patrolsEnabled: false }), 200);
      const before = ex.length;
      await sweep(new Date(enabledAt + 5 * HOUR));
      assert.equal((await exceptionsOf(s.co.id)).length, before, 'switched off again: the sweep stops at once');
    });

    await test('PS-S15-UK-DST-NIGHTS-THROUGH-THE-SWEEP-ONE-EXCEPTION-PER-REAL-WINDOW', async () => {
      const spring = await scenario('s15s');
      const sp = await mkSchedule(spring.co.id, spring.site, { from: '22:00', to: '06:00', freq: 60 });
      const sShift = await mkShift(spring.co.id, spring.site, spring.guards[0].id, Z('2026-03-28T21:30:00Z'), Z('2026-03-29T05:30:00Z'));
      await bookOn(sShift, spring.guards[0].id, Z('2026-03-28T21:30:00Z'));
      await sweep(Z('2026-03-29T06:30:00Z'));
      const sEx = await exceptionsOf(spring.co.id);
      assert.deepEqual(sEx.map((e: any) => Number(e.windowKey.split(':')[2])).sort((a: number, b: number) => a - b), [0, 1, 2, 4, 5, 6, 7], '7 windows: 01:00 never existed');
      assert.ok(sEx.every((e: any) => e.windowKey.startsWith(`s${sp.id}:2026-03-28:`)));
      assert.equal((await alertsOf(spring.co.id)).length, 7);
      const autumn = await scenario('s15a');
      const au = await mkSchedule(autumn.co.id, autumn.site, { from: '22:00', to: '06:00', freq: 60 });
      const aShift = await mkShift(autumn.co.id, autumn.site, autumn.guards[0].id, Z('2026-10-24T20:30:00Z'), Z('2026-10-25T06:30:00Z'));
      await bookOn(aShift, autumn.guards[0].id, Z('2026-10-24T20:30:00Z'));
      await sweep(Z('2026-10-25T07:00:00Z'));
      const aEx = await exceptionsOf(autumn.co.id);
      assert.equal(aEx.length, 8, '8 windows: the repeated hour is not a ninth');
      const slot3 = aEx.find((e: any) => e.windowKey === `s${au.id}:2026-10-24:3`);
      assert.deepEqual([iso(slot3.windowStart), iso(slot3.windowEnd)], ['2026-10-25T00:00:00.000Z', '2026-10-25T02:00:00.000Z']);
      assert.equal((await alertsOf(autumn.co.id)).length, 8);
    });

    // ═══════════════════ Alerts and the existing lifecycle ═══════════════════
    const members: Record<string, string> = {};
    let ownerA = '';
    await test('PS-A01-ACKNOWLEDGE-AND-RESOLVE-THROUGH-THE-EXISTING-ALERT-ENDPOINTS', async () => {
      await focus(s01.co.id);
      for (const role of ['operations', 'viewer', 'control_room', 'hr_compliance']) {
        const email = `ps.s01.${role}@example.invalid`;
        const id = await mkUser(email, 'company_admin');
        await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [id, s01.co.id, role]);
        members[role] = await login(email);
      }
      ownerA = await login(s01.co.ownerEmail);
      const [alert] = await alertsOf(s01.co.id);
      const [exception] = await exceptionsOf(s01.co.id);
      const reasons = await api('GET', `/alerts/${alert.id}/resolution-reasons`, ownerA);
      expect(reasons, 200);
      assert.ok(!reasons.body.reasons.some((r: any) => r.value === 'patrol_completed_late_sync'), 'no late sync without late evidence');
      assert.ok(reasons.body.reasons.some((r: any) => r.value === 'guard_contacted' && r.noteRequired === true));
      expect(await api('PATCH', `/alerts/${alert.id}/ack`, members.viewer), 403, undefined, 'viewer');
      // Owner decision (P1-C): Control Room acts on patrol alerts through alerts.manage (PS-A05). A role with neither
      // alerts.manage nor patrols.manage still cannot.
      expect(await api('PATCH', `/alerts/${alert.id}/ack`, members.hr_compliance), 403, undefined, 'HR / compliance (neither alerts.manage nor patrols.manage)');
      expect(await api('PATCH', `/alerts/${alert.id}/ack`, ownerA), 200);
      const acked = await one(`SELECT * FROM patrol_exceptions WHERE id = $1`, [exception.id]);
      assert.deepEqual([acked.status, Number(acked.acknowledgedByUserId)], ['acknowledged', s01.co.ownerId]);
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.exception_acknowledged' AND "entityId" = $1`, [exception.id]), 1);
      expect(await api('PATCH', `/alerts/${alert.id}/close`, ownerA, {}), 400, undefined, 'a patrol alert needs a reason');
      expect(await api('PATCH', `/alerts/${alert.id}/close`, ownerA, { resolutionReason: 'patrol_completed_late_sync' }), 400, undefined, 'not offered');
      expect(await api('PATCH', `/alerts/${alert.id}/close`, ownerA, { resolutionReason: 'guard_contacted' }), 400, undefined, 'a note is required');
      expect(await api('PATCH', `/alerts/${alert.id}/close`, ownerA, { resolutionReason: 'network_signal_issue', resolutionNote: 'x' }), 400, undefined, 'a Welfare reason');
      const closed = await api('PATCH', `/alerts/${alert.id}/close`, ownerA, { resolutionReason: 'guard_contacted', resolutionNote: 'Guard was escorting a contractor.' });
      expect(closed, 200);
      const resolved = await one(`SELECT * FROM patrol_exceptions WHERE id = $1`, [exception.id]);
      assert.deepEqual([resolved.status, resolved.resolution, Number(resolved.resolvedByUserId)], ['resolved', 'guard_contacted', s01.co.ownerId]);
      assert.deepEqual(resolved.annotations.map((a: any) => [a.kind, a.text]), [['resolution_note', 'Guard was escorting a contractor.']]);
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.exception_resolved' AND "entityId" = $1`, [exception.id]), 1);
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'safety_alert.closed' AND "entityId" = $1`, [alert.id]), 1);
      expect(await api('PATCH', `/alerts/${alert.id}/close`, ownerA, { resolutionReason: 'guard_contacted', resolutionNote: 'again' }), 409);
      await sweep(day('09:20:00'));
      assert.equal((await exceptionsOf(s01.co.id)).filter((e: any) => e.windowKey === exception.windowKey).length, 1, 'a resolved exception is never raised again');
    });

    await test('PS-A02-RESOLVING-THE-EXCEPTION-CLOSES-ITS-ALERT-PERMISSIONS-AND-TENANCY', async () => {
      await focus(s01.co.id);
      const open = (await exceptionsOf(s01.co.id)).filter((e: any) => e.status === 'open' && e.safetyAlertId);
      assert.ok(open.length >= 1, 'the 09:00 window was missed meanwhile');
      const target = open[0];
      const list = await api('GET', '/patrols/exceptions?status=open', members.viewer);
      expect(list, 200);
      assert.ok(list.body.some((e: any) => e.id === Number(target.id) && e.alertStatus === 'open'));
      expect(await api('POST', `/patrols/exceptions/${target.id}/resolve`, members.viewer, { resolutionReason: 'guard_contacted', resolutionNote: 'x' }), 403);
      const other = await mkCompany('a02other');
      await focus(other.id);
      await q(`UPDATE companies SET "patrolsEnabled" = true WHERE id IN ($1, $2)`, [other.id, s01.co.id]);
      const otherOwner = await login(other.ownerEmail);
      expect(await api('POST', `/patrols/exceptions/${target.id}/resolve`, otherOwner, { resolutionReason: 'guard_contacted', resolutionNote: 'x' }), 404, 'PATROL_NOT_FOUND');
      expect(await api('PATCH', `/alerts/${target.safetyAlertId}/ack`, otherOwner), 400, undefined, 'another company\'s alert');
      await focus(s01.co.id);
      expect(await api('POST', `/patrols/exceptions/${target.id}/resolve`, members.operations, { resolutionReason: 'not_a_reason', resolutionNote: 'x' }), 400);
      expect(await api('POST', `/patrols/exceptions/${target.id}/acknowledge`, members.operations), 200);
      const res = await api('POST', `/patrols/exceptions/${target.id}/resolve`, members.operations, { resolutionReason: 'patrol_not_required', resolutionNote: 'Site closed for the morning.' });
      expect(res, 200);
      assert.equal(res.body.status, 'resolved');
      const alert = await one(`SELECT status, "resolutionReason", "closedByUserId" FROM safety_alerts WHERE id = $1`, [target.safetyAlertId]);
      assert.deepEqual([alert.status, alert.resolutionReason], ['closed', 'patrol_not_required'], 'the alert closed through its own lifecycle');
      // An exception with no alert (not actionable) is resolved directly.
      const quiet = (await q(`SELECT * FROM patrol_exceptions WHERE "safetyAlertId" IS NULL AND status = 'open' AND type = 'patrol_incomplete'`))[0];
      const quietCompany = Number(quiet.companyId);
      await focus(quietCompany);
      const quietOwner = await login((await one(`SELECT u.email FROM companies c JOIN users u ON u.id = c."userId" WHERE c.id = $1`, [quietCompany])).email);
      const direct = await api('POST', `/patrols/exceptions/${quiet.id}/resolve`, quietOwner, { resolutionReason: 'patrol_completed_confirmed', resolutionNote: 'Supervisor walked it.' });
      expect(direct, 200);
      assert.equal(direct.body.status, 'resolved');
      expect(await api('POST', `/patrols/exceptions/${quiet.id}/resolve`, quietOwner, { resolutionReason: 'other', resolutionNote: 'x' }), 409, 'PATROL_EXCEPTION_ALREADY_RESOLVED');
    });

    await test('PS-A03-LIVE-OPERATIONS-ALERT-LIST-CARRIES-PATROL-ALERTS-WITH-LINKS-GUARDS-NEVER-SEE-THEM', async () => {
      await focus(s01.co.id);
      const [g] = s01.guards;
      await q(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message) VALUES ($1,$2,$3,'panic','critical','SOS')`, [s01.co.id, g.id, s01.shift]);
      const list = await api('GET', '/alerts/company', ownerA);
      expect(list, 200);
      const patrol = list.body.filter((a: any) => a.type === 'patrol_missed');
      assert.ok(patrol.length >= 2);
      for (const a of patrol) {
        assert.ok(Number.isInteger(a.patrolExceptionId) && typeof a.patrolWindowKey === 'string' && 'patrolRunId' in a, 'link fields for the web');
      }
      const panic = list.body.find((a: any) => a.type === 'panic');
      assert.ok(panic && !('patrolExceptionId' in panic) && !('patrolLateSyncAt' in panic), 'every other alert reads exactly as before Migration 69');
      const viewerList = await api('GET', '/alerts/company', members.viewer);
      expect(viewerList, 200);
      assert.ok(viewerList.body.length >= 2 && viewerList.body.every((a: any) => a.type.startsWith('patrol_') || a.type === 'checkpoint_missed'),
        'a patrols.view member sees patrol alerts only');
      await q(`UPDATE companies SET "patrolsEnabled" = false WHERE id = $1`, [s01.co.id]);
      const off = await api('GET', '/alerts/company', members.viewer);
      expect(off, 200, undefined, 'a Viewer holds compliance.view, as before Patrols');
      assert.ok(!off.body.some((a: any) => a.type.startsWith('patrol_') || a.type === 'checkpoint_missed'), 'switch off: no patrol alert, exactly as before Patrols');
      await focus(s01.co.id);
      const guardToken = await login(g.email);
      const mine = await api('GET', '/alerts/mine', guardToken);
      expect(mine, 200);
      assert.deepEqual(mine.body.map((a: any) => a.type), ['panic'], 'the Guard\'s own list never shows patrol alerts');
    });

    await test('PS-A04-WELFARE-IS-UNTOUCHED', async () => {
      const s = await scenario('a04');
      const [g] = s.guards;
      await mkSchedule(s.co.id, s.site, { from: '00:00', to: '00:00', freq: 60 });
      const now = Date.now();
      const shift = await mkShift(s.co.id, s.site, g.id, new Date(now - 4 * HOUR), new Date(now + 4 * HOUR));
      await bookOn(shift, g.id, new Date(now - 4 * HOUR));
      const welfare = () => count(`SELECT count(*) FROM safety_alerts WHERE "shiftId" = $1 AND type::text IN ('missed_checkcall','missing_book_off','check_call','welfare','late_checkin')`, [shift]);
      const patrolRows = async () => [await count(`SELECT count(*) FROM patrol_exceptions WHERE "companyId" = $1`, [s.co.id]), (await alertsOf(s.co.id)).length];
      const welfareBefore = await welfare();
      await sweep(new Date(now));
      assert.equal(await welfare(), welfareBefore, 'the patrol sweep writes no Welfare row');
      const patrolAfterSweep = await patrolRows();
      assert.ok(patrolAfterSweep[0] > 0);
      await safety.runMissedWelfareChecks();
      assert.ok((await welfare()) > welfareBefore, 'the Welfare sweep judged its own windows');
      assert.deepEqual(await patrolRows(), patrolAfterSweep, 'and wrote no patrol row');
      assert.equal(await count(`SELECT count(*) FROM safety_alerts WHERE "patrolExceptionId" IS NOT NULL AND type::text = 'missed_checkcall'`), 0, 'no shared alert');
    });

    await test('PS-A05-CONTROL-ROOM-ACTS-ON-PATROL-ALERTS-WITH-ALERTS-MANAGE-BUT-NEVER-CONFIGURES', async () => {
      // Owner decision (Patrols P1-C): Control Room operators acknowledge, investigate, escalate and resolve patrol alerts
      // through alerts.manage; they are NOT given patrols.manage.
      const { CompanyPermission, CompanyMembershipRole, hasPermission, mayActOnPatrolAlerts } = await import('../src/company-membership/company-membership-types');
      assert.equal(hasPermission(CompanyMembershipRole.CONTROL_ROOM, CompanyPermission.ALERTS_MANAGE), true);
      assert.equal(hasPermission(CompanyMembershipRole.CONTROL_ROOM, CompanyPermission.PATROLS_MANAGE), false, 'never patrols.manage');
      const expected: Record<string, boolean> = { owner: true, admin: true, operations: true, control_room: true, hr_compliance: false, finance: false, viewer: false };
      for (const role of Object.values(CompanyMembershipRole)) {
        assert.equal(hasPermission(role, CompanyPermission.ALERTS_MANAGE), expected[role], `${role}: alerts.manage`);
        assert.equal(mayActOnPatrolAlerts(role), expected[role], `${role}: may act on patrol alerts`);
      }

      const s = await scenario('a05');
      const [g] = s.guards;
      await mkSchedule(s.co.id, s.site, { name: 'Perimeter', from: '08:00', to: '12:00', freq: 60 });
      const shift = await mkShift(s.co.id, s.site, g.id, day('06:00:00'), day('14:00:00'));
      await bookOn(shift, g.id, day('05:55:00'));
      await sweep(day('12:20:00'));
      const alerts = await alertsOf(s.co.id);
      const exceptions = await exceptionsOf(s.co.id);
      assert.ok(alerts.length >= 3, `three or more missed windows raised alerts (${alerts.length})`);
      const tok: Record<string, string> = {};
      for (const role of ['control_room', 'hr_compliance', 'viewer']) {
        const email = `ps.a05.${role}@example.invalid`;
        const id = await mkUser(email, 'company_admin');
        await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [id, s.co.id, role]);
        tok[role] = await login(email);
      }
      const cr = tok.control_room;
      const crId = Number(await scalar(`SELECT id FROM users WHERE email = 'ps.a05.control_room@example.invalid'`));
      const exceptionOf = (alert: any) => exceptions.find((e: any) => Number(e.safetyAlertId) === Number(alert.id));

      // Through the existing alert endpoints: acknowledge, see the resolution options, resolve.
      const [a1, a2, a3] = alerts;
      expect(await api('GET', `/alerts/${a1.id}/resolution-reasons`, cr), 200, undefined, 'control room reads the resolution options');
      expect(await api('PATCH', `/alerts/${a1.id}/ack`, cr), 200, undefined, 'control room acknowledges');
      const acked = await one(`SELECT * FROM patrol_exceptions WHERE id = $1`, [exceptionOf(a1).id]);
      assert.deepEqual([acked.status, Number(acked.acknowledgedByUserId)], ['acknowledged', crId], 'the exception follows the alert');
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.exception_acknowledged' AND "entityId" = $1 AND "userId" = $2`, [acked.id, crId]), 1, 'audited as the operator');
      const closed = await api('PATCH', `/alerts/${a1.id}/close`, cr, { resolutionReason: 'guard_contacted', resolutionNote: 'Guard was dealing with a delivery; patrol walked at 08:40.' });
      expect(closed, 200, undefined, 'control room resolves');
      const resolved = await one(`SELECT * FROM patrol_exceptions WHERE id = $1`, [acked.id]);
      assert.deepEqual([resolved.status, resolved.resolution, Number(resolved.resolvedByUserId)], ['resolved', 'guard_contacted', crId]);
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.exception_resolved' AND "entityId" = $1 AND "userId" = $2`, [acked.id, crId]), 1);

      // Through the Patrols API (the same action): alerts.manage is accepted there too.
      const e2 = exceptionOf(a2);
      expect(await api('POST', `/patrols/exceptions/${e2.id}/acknowledge`, cr), 200, undefined, 'control room acknowledges via /patrols');
      const r2 = await api('POST', `/patrols/exceptions/${e2.id}/resolve`, cr, { resolutionReason: 'patrol_not_required', resolutionNote: 'Site closed by the client.' });
      expect(r2, 200);
      assert.equal(r2.body.status, 'resolved');
      assert.equal((await one(`SELECT status FROM safety_alerts WHERE id = $1`, [a2.id])).status, 'closed', 'its alert closed through the alert lifecycle');

      // A role with neither alerts.manage nor patrols.manage, a Viewer and a Guard cannot act.
      const e3 = exceptionOf(a3);
      expect(await api('PATCH', `/alerts/${a3.id}/ack`, tok.hr_compliance), 403, undefined, 'HR / compliance');
      expect(await api('PATCH', `/alerts/${a3.id}/close`, tok.hr_compliance, { resolutionReason: 'guard_contacted', resolutionNote: 'x' }), 403);
      expect(await api('POST', `/patrols/exceptions/${e3.id}/acknowledge`, tok.hr_compliance), 403, 'PATROL_FORBIDDEN');
      expect(await api('PATCH', `/alerts/${a3.id}/ack`, tok.viewer), 403, undefined, 'viewer');
      expect(await api('POST', `/patrols/exceptions/${e3.id}/resolve`, tok.viewer, { resolutionReason: 'guard_contacted', resolutionNote: 'x' }), 403, 'PATROL_FORBIDDEN');
      const guardToken = await login(g.email);
      expect(await api('PATCH', `/alerts/${a3.id}/ack`, guardToken), 403, undefined, 'the Guard');
      expect(await api('POST', `/patrols/exceptions/${e3.id}/acknowledge`, guardToken), 403, undefined, 'the Guard (company route)');
      assert.equal((await one(`SELECT status FROM patrol_exceptions WHERE id = $1`, [e3.id])).status, 'open', 'nothing changed');

      // Another company's Control Room cannot touch these.
      const other = await mkCompany('a05other');
      const otherCrEmail = 'ps.a05other.control_room@example.invalid';
      const otherCr = await mkUser(otherCrEmail, 'company_admin');
      await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,'control_room','active')`, [otherCr, other.id]);
      await q(`UPDATE companies SET "patrolsEnabled" = true WHERE id IN ($1, $2)`, [other.id, s.co.id]);
      const otherTok = await login(otherCrEmail);
      expect(await api('PATCH', `/alerts/${a3.id}/ack`, otherTok), 400, undefined, 'another company\'s alert');
      expect(await api('POST', `/patrols/exceptions/${e3.id}/acknowledge`, otherTok), 404, 'PATROL_NOT_FOUND');
      expect(await api('POST', `/patrols/exceptions/${e3.id}/resolve`, otherTok, { resolutionReason: 'guard_contacted', resolutionNote: 'x' }), 404, 'PATROL_NOT_FOUND');
      assert.equal((await one(`SELECT status FROM patrol_exceptions WHERE id = $1`, [e3.id])).status, 'open');

      // …and Control Room still cannot change patrol configuration.
      await focus(s.co.id);
      expect(await api('PUT', '/patrols/policies/default', cr, { startGraceMinutes: 10 }), 403, 'PATROL_FORBIDDEN', 'policy');
      expect(await api('PUT', `/patrols/policies/sites/${s.site}`, cr, { startGraceMinutes: 10 }), 403, 'PATROL_FORBIDDEN', 'site policy');
      expect(await api('POST', '/patrols/schedules', cr, { siteId: s.site, name: 'x', activeFrom: '08:00', activeTo: '12:00', frequencyMinutes: 60 }), 403, 'PATROL_FORBIDDEN', 'schedule');
      expect(await api('POST', '/patrols/checkpoints', cr, { siteId: s.site, label: 'x' }), 403, 'PATROL_FORBIDDEN', 'checkpoint');
      const cp = await mkCheckpoint(s.co.id, s.site, 'A05 Gate');
      expect(await api('PATCH', `/patrols/checkpoints/${cp.id}`, cr, { description: 'probe' }), 403, 'PATROL_FORBIDDEN', 'checkpoint edit');
      expect(await api('POST', '/patrols/routes', cr, { siteId: s.site, name: 'x', checkpoints: [{ checkpointId: Number(cp.id) }] }), 403, 'PATROL_FORBIDDEN', 'route');
    });

    // ═══════════════════ Guard API and offline sync after Book Off ═══════════════════
    const R = await scenario('rt', 1);
    const [rg] = R.guards;
    const rb = await scenario('rtb', 1); // company B, for tenant isolation
    await focus(R.co.id);
    await q(`UPDATE companies SET "patrolsEnabled" = true WHERE id = $1`, [rb.co.id]);
    const allDay = await mkSchedule(R.co.id, R.site, { name: 'All day', from: '00:00', to: '00:00', freq: 60 });
    const never = await mkSchedule(R.co.id, R.site, { name: 'Future', from: '00:00', to: '00:00', freq: 60, startsOn: '2030-01-01' });
    const cpR = await mkCheckpoint(R.co.id, R.site, 'Main door');
    let gtok = await login(rg.email);
    const nowMs = () => Date.now();
    /** A shift that started `fromH` hours ago, booked on then; optionally booked off `offH` hours ago. */
    const rShift = async (fromH: number, offH: number | null, bookedOn = true) => {
      const start = new Date(nowMs() - fromH * HOUR);
      const end = offH == null ? new Date(nowMs() + 3 * HOUR) : new Date(nowMs() - offH * HOUR);
      const id = await mkShift(R.co.id, R.site, rg.id, start, end, offH == null ? 'in_progress' : 'completed');
      if (bookedOn) await bookOn(id, rg.id, start);
      if (offH != null && bookedOn) {
        await q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-out',$3,$3,false)`, [id, rg.id, end]);
      }
      return { id, start, end };
    };
    const start = (body: Record<string, unknown>, tok = gtok) => api('POST', '/patrols/runs', tok, { clientRunId: cid('r'), ...body });
    const visit = (runId: number, body: Record<string, unknown> = {}, tok = gtok) =>
      api('POST', `/patrols/runs/${runId}/visits`, tok, { clientVisitId: cid('v'), checkpointPublicId: cpR.publicId, scannedAtDevice: iso(nowMs() - 2 * HOUR), ...body });
    const complete = (runId: number, body: Record<string, unknown> = {}, tok = gtok) => api('POST', `/patrols/runs/${runId}/complete`, tok, { completedAtDevice: iso(nowMs() - 90 * MIN), ...body });

    await test('PS-G01-A-START-IS-ASSIGNED-TO-ITS-ONE-WINDOW-AND-SCOPE', async () => {
      const shift = await rShift(4, null);
      // Five minutes into the hourly window that was open 90 minutes ago, so both starts below share one window.
      const startedAt = W.windowForStart(allDay, 'Europe/London', new Date(nowMs() - 90 * MIN), 15)!.window.start.getTime() + 5 * MIN;
      const r = await start({ shiftId: shift.id, scheduleId: allDay.id, startedAtDevice: iso(startedAt) });
      expect(r, 201);
      const expected = W.windowForStart(allDay, 'Europe/London', new Date(startedAt), 15)!.window;
      assert.deepEqual([r.body.windowKey, r.body.windowStart, r.body.windowEnd, r.body.lateStart, r.body.provisional, r.body.syncedLate, r.body.syncFlags],
        [expected.windowKey, iso(expected.start), iso(expected.end), false, false, false, []]);
      assert.equal((await one(`SELECT "scopeKey" FROM patrol_runs WHERE id = $1`, [r.body.id])).scopeKey, 'site');
      // A second run for the same window and scope is recorded but satisfies none.
      expect(await complete(r.body.id, { completedAtDevice: iso(startedAt + 10 * MIN) }), 200);
      const again = await start({ shiftId: shift.id, scheduleId: allDay.id, startedAtDevice: iso(startedAt + 15 * MIN) });
      expect(again, 201);
      assert.deepEqual([again.body.windowKey, again.body.syncFlags], [null, ['window_already_covered']]);
      expect(await complete(again.body.id, { completedAtDevice: iso(startedAt + 20 * MIN) }), 200);
      await bookOff(shift.id, rg.id, new Date(nowMs() - MIN));
    });

    await test('PS-O01-A-RUN-STARTED-ON-SHIFT-SYNCS-ITS-SCANS-AND-COMPLETION-AFTER-BOOK-OFF', async () => {
      const shift = await rShift(4, null);
      const run = await start({ shiftId: shift.id, startedAtDevice: iso(nowMs() - 2 * HOUR - 5 * MIN) });
      expect(run, 201);
      await bookOff(shift.id, rg.id, new Date(nowMs() - HOUR)); // the Guard booked off; the phone was offline
      const v = await visit(run.body.id);
      expect(v, 201, undefined, 'a scan after Book Off');
      assert.deepEqual([v.body.syncedLate, v.body.provisional, v.body.syncFlags], [true, true, ['synced_after_book_off']]);
      const c = await complete(run.body.id);
      expect(c, 200, undefined, 'the completion after Book Off');
      assert.deepEqual([c.body.status, c.body.syncedLate, c.body.needsReview, c.body.syncFlags], ['completed', true, false, ['synced_after_book_off']]);
      assert.equal(c.body.completedAtDevice, iso(new Date(c.body.completedAtDevice)), 'device time kept');
      assert.ok(new Date(c.body.completedAtServer).getTime() > new Date(c.body.completedAtDevice).getTime(), 'server receipt kept separately');
      assert.ok(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.late_sync_flagged' AND "entityType" = 'patrol_run' AND "entityId" = $1`, [run.body.id]) >= 1);
    });

    await test('PS-O02-A-COMPLETION-TIMED-AFTER-BOOK-OFF-IS-ACCEPTED-AND-NEEDS-REVIEW', async () => {
      const shift = await rShift(4, null);
      const run = await start({ shiftId: shift.id, startedAtDevice: iso(nowMs() - 2 * HOUR) });
      expect(run, 201);
      await bookOff(shift.id, rg.id, new Date(nowMs() - HOUR));
      const c = await complete(run.body.id, { completedAtDevice: iso(nowMs() - 30 * MIN) });
      expect(c, 200);
      assert.deepEqual([c.body.needsReview, c.body.syncFlags.sort()], [true, ['completed_after_book_off', 'synced_after_book_off']]);
    });

    let o03Run: any;
    await test('PS-O03-A-RUN-FIRST-REACHING-THE-SERVER-AFTER-BOOK-OFF-WITH-A-MATCHING-WINDOW', async () => {
      const shift = await rShift(5, 1);
      const startedAt = nowMs() - 3 * HOUR;
      const r = await start({ shiftId: shift.id, scheduleId: allDay.id, startedAtDevice: iso(startedAt) });
      expect(r, 201);
      o03Run = r.body;
      assert.deepEqual([r.body.provisional, r.body.syncedLate, r.body.needsReview, r.body.syncFlags], [true, true, false, ['post_shift_creation']]);
      assert.equal(r.body.windowKey, W.windowForStart(allDay, 'Europe/London', new Date(startedAt), 15)!.window.windowKey, 'its real scheduled window');
      assert.equal(r.body.startedAtDevice, iso(startedAt), 'device time preserved');
      const audit = await one(`SELECT "afterData" FROM audit_logs WHERE action = 'patrol.late_sync_flagged' AND "entityType" = 'patrol_run' AND "entityId" = $1`, [r.body.id]);
      assert.deepEqual([audit.afterData.flags, audit.afterData.provisional], [['post_shift_creation'], true]);
      expect(await complete(r.body.id, { completedAtDevice: iso(startedAt + 20 * MIN) }), 200);
    });

    await test('PS-O04-OUTSIDE-THE-ON-DUTY-INTERVAL-OR-WITHOUT-A-WINDOW-IS-ACCEPTED-AND-NEEDS-REVIEW', async () => {
      const shift = await rShift(5, 1);
      const before = await start({ shiftId: shift.id, scheduleId: allDay.id, startedAtDevice: iso(nowMs() - 6 * HOUR) });
      expect(before, 201);
      assert.deepEqual([before.body.provisional, before.body.needsReview, before.body.syncFlags], [true, true, ['post_shift_creation', 'outside_on_duty_interval']]);
      expect(await complete(before.body.id, { completedAtDevice: iso(nowMs() - 5.5 * HOUR) }), 200);
      const noWindow = await start({ shiftId: shift.id, scheduleId: never.id, startedAtDevice: iso(nowMs() - 2 * HOUR) });
      expect(noWindow, 201);
      assert.deepEqual([noWindow.body.needsReview, noWindow.body.syncFlags, noWindow.body.windowKey], [true, ['post_shift_creation', 'no_matching_window'], null]);
      expect(await complete(noWindow.body.id, { completedAtDevice: iso(nowMs() - 100 * MIN) }), 200);
    });

    await test('PS-O05-NO-BOOKED-ON-ATTENDANCE-IS-REFUSED-AND-NOTHING-IS-WRITTEN', async () => {
      const shift = await rShift(5, 1, false);
      const runsBefore = await count(`SELECT count(*) FROM patrol_runs WHERE "shiftId" = $1`, [shift.id]);
      expect(await start({ shiftId: shift.id, startedAtDevice: iso(nowMs() - 2 * HOUR) }), 409, 'PATROL_SYNC_NOT_BOOKED_ON');
      assert.equal(await count(`SELECT count(*) FROM patrol_runs WHERE "shiftId" = $1`, [shift.id]), runsBefore);
      const notStarted = await mkShift(R.co.id, R.site, rg.id, new Date(nowMs() + HOUR), new Date(nowMs() + 9 * HOUR), 'ready');
      expect(await start({ shiftId: notStarted, startedAtDevice: iso() }), 409, 'PATROL_SHIFT_NOT_IN_PROGRESS', 'before Book On it is still P1-A\'s refusal');
    });

    await test('PS-O06-BEYOND-THE-24H-ACCEPTANCE-WINDOW-IS-REFUSED', async () => {
      const shift = await rShift(33, 25);
      const r = await start({ shiftId: shift.id, startedAtDevice: iso(nowMs() - 30 * HOUR) });
      expect(r, 409, 'PATROL_SYNC_WINDOW_CLOSED');
      assert.ok(r.body.details.acceptanceEndsAt);
      // A run still open on that shift: its new scan and completion are refused too.
      const open = await insRun({ companyId: R.co.id, siteId: R.site, shiftId: shift.id, guard: rg, startedAt: new Date(nowMs() - 30 * HOUR) });
      expect(await visit(Number(open.id), { scannedAtDevice: iso(nowMs() - 29 * HOUR) }), 409, 'PATROL_SYNC_WINDOW_CLOSED');
      expect(await complete(Number(open.id), { completedAtDevice: iso(nowMs() - 29 * HOUR) }), 409, 'PATROL_SYNC_WINDOW_CLOSED');
      await q(`UPDATE patrol_runs SET status = 'closed_by_system', "completedAtServer" = now() WHERE id = $1`, [open.id]);
    });

    await test('PS-O07-REPLAY-AFTER-24H-IS-AN-IDEMPOTENT-SUCCESS-A-NEW-WRITE-IS-REFUSED', async () => {
      const shift = await rShift(5, 1);
      const body = { clientRunId: cid('replay'), shiftId: shift.id, startedAtDevice: iso(nowMs() - 3 * HOUR) };
      const s1 = await api('POST', '/patrols/runs', gtok, body);
      expect(s1, 201);
      const vBody = { clientVisitId: cid('replay'), checkpointPublicId: cpR.publicId, scannedAtDevice: iso(nowMs() - 170 * MIN) };
      const v1 = await api('POST', `/patrols/runs/${s1.body.id}/visits`, gtok, vBody);
      expect(v1, 201);
      const cBody = { completedAtDevice: iso(nowMs() - 160 * MIN) };
      const c1 = await api('POST', `/patrols/runs/${s1.body.id}/complete`, gtok, cBody);
      expect(c1, 200);
      const open = await api('POST', '/patrols/runs', gtok, { clientRunId: cid('open'), shiftId: shift.id, startedAtDevice: iso(nowMs() - 150 * MIN) });
      expect(open, 201);
      // 25 hours pass.
      await q(`UPDATE attendance_events SET "occurredAt" = "occurredAt" - interval '25 hours' WHERE "shiftId" = $1`, [shift.id]);
      await q(`UPDATE shifts SET start = start - interval '25 hours', "end" = "end" - interval '25 hours' WHERE id = $1`, [shift.id]);
      const s2 = await api('POST', '/patrols/runs', gtok, body);
      expect(s2, 201);
      assert.equal(s2.body.id, s1.body.id);
      assert.deepEqual((await api('POST', `/patrols/runs/${s1.body.id}/visits`, gtok, vBody)).body, v1.body, 'the scan replays');
      const c2 = await api('POST', `/patrols/runs/${s1.body.id}/complete`, gtok, cBody);
      expect(c2, 200);
      assert.equal(c2.body.completedAtServer, c1.body.completedAtServer, 'completed once');
      expect(await visit(open.body.id), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'a NEW scan');
      expect(await api('POST', '/patrols/runs', gtok, { ...body, clientRunId: cid('new') }), 409, 'PATROL_SYNC_WINDOW_CLOSED', 'a NEW run');
      assert.equal(await count(`SELECT count(*) FROM patrol_runs WHERE "clientRunId" = $1`, [body.clientRunId]), 1);
      await q(`UPDATE patrol_runs SET status = 'closed_by_system', "completedAtServer" = now() WHERE id = $1`, [open.body.id]);
    });

    await test('PS-O08-EXPIRED-SESSION-THEN-RE-SYNC-GIVES-THE-SAME-RESULT-WITHOUT-DUPLICATES', async () => {
      const shift = await rShift(5, 1);
      const body = { clientRunId: cid('session'), shiftId: shift.id, scheduleId: allDay.id, startedAtDevice: iso(nowMs() - 2 * HOUR) };
      const vBody = { clientVisitId: cid('session'), checkpointPublicId: cpR.publicId, scannedAtDevice: iso(nowMs() - 115 * MIN) };
      const cBody = { completedAtDevice: iso(nowMs() - 100 * MIN) };
      const first = [await api('POST', '/patrols/runs', gtok, body)];
      first.push(await api('POST', `/patrols/runs/${first[0].body.id}/visits`, gtok, vBody));
      first.push(await api('POST', `/patrols/runs/${first[0].body.id}/complete`, gtok, cBody));
      // The session expired; the app signs in again and replays its whole outbox.
      gtok = await login(rg.email);
      const second = [await api('POST', '/patrols/runs', gtok, body)];
      second.push(await api('POST', `/patrols/runs/${first[0].body.id}/visits`, gtok, vBody));
      second.push(await api('POST', `/patrols/runs/${first[0].body.id}/complete`, gtok, cBody));
      assert.deepEqual(second.map((r) => r.status), first.map((r) => r.status));
      assert.deepEqual(second[1].body, first[1].body);
      assert.deepEqual(second[2].body, first[2].body);
      assert.equal(second[0].body.id, first[0].body.id);
      assert.deepEqual([await count(`SELECT count(*) FROM patrol_runs WHERE "clientRunId" = $1`, [body.clientRunId]),
        await count(`SELECT count(*) FROM patrol_checkpoint_visits WHERE "clientVisitId" = $1`, [vBody.clientVisitId])], [1, 1]);
    });

    await test('PS-O09-DUPLICATE-SYNC-ATTEMPTS-SEQUENTIAL-AND-CONCURRENT', async () => {
      const shift = await rShift(5, 1);
      const body = { clientRunId: cid('dup'), shiftId: shift.id, startedAtDevice: iso(nowMs() - 2 * HOUR), sentAtDevice: iso() };
      const starts = await Promise.all(Array.from({ length: 6 }, () => api('POST', '/patrols/runs', gtok, body)));
      for (const s of starts) expect(s, 201);
      assert.equal(new Set(starts.map((s) => s.body.id)).size, 1);
      const runId = starts[0].body.id;
      const seqAgain = await api('POST', '/patrols/runs', gtok, { ...body, sentAtDevice: iso() });
      expect(seqAgain, 201, undefined, 'a later retry with a new send time is the same request');
      assert.equal(seqAgain.body.id, runId);
      const vBody = { clientVisitId: cid('dup'), checkpointPublicId: cpR.publicId, scannedAtDevice: iso(nowMs() - 110 * MIN) };
      const visits = await Promise.all(Array.from({ length: 6 }, () => api('POST', `/patrols/runs/${runId}/visits`, gtok, vBody)));
      for (const v of visits) expect(v, 201);
      assert.equal(new Set(visits.map((v) => v.body.id)).size, 1);
      const cBody = { completedAtDevice: iso(nowMs() - 100 * MIN) };
      const dones = await Promise.all(Array.from({ length: 6 }, () => api('POST', `/patrols/runs/${runId}/complete`, gtok, cBody)));
      for (const d of dones) expect(d, 200);
      assert.equal(new Set(dones.map((d) => d.body.completedAtServer)).size, 1);
      assert.deepEqual([await count(`SELECT count(*) FROM patrol_runs WHERE "clientRunId" = $1`, [body.clientRunId]),
        await count(`SELECT count(*) FROM patrol_checkpoint_visits WHERE "clientVisitId" = $1`, [vBody.clientVisitId])], [1, 1]);
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.late_sync_flagged' AND "entityType" = 'patrol_run' AND "entityId" = $1
        AND ("afterData"->>'step') IS NULL`, [runId]), 1, 'the flagged acceptance is audited once');
    });

    await test('PS-O10-DELAYED-EVIDENCE-AFTER-A-MISSED-ALERT-ANNOTATES-AND-NEVER-CLOSES', async () => {
      // Its own site and schedule: per-site scope means another shift's patrol at the main site would cover its windows.
      const yard = await mkSite(R.co.id, 'rt Yard');
      const yardSchedule = await mkSchedule(R.co.id, yard, { name: 'Yard', from: '00:00', to: '00:00', freq: 60 });
      const startedShift = new Date(nowMs() - 5 * HOUR);
      const shift = { id: await mkShift(R.co.id, yard, rg.id, startedShift, new Date(nowMs() + 3 * HOUR)) };
      await bookOn(shift.id, rg.id, startedShift);
      await sweep(new Date());
      const target = W.windowForStart(yardSchedule, 'Europe/London', new Date(nowMs() - 2 * HOUR), 15)!.window;
      const exception = await one(`SELECT * FROM patrol_exceptions WHERE "companyId" = $1 AND "windowKey" = $2 AND type = 'patrol_missed'`, [R.co.id, target.windowKey]);
      assert.ok(exception && exception.safetyAlertId, 'the window was missed and alerted');
      const alertBefore = await one(`SELECT * FROM safety_alerts WHERE id = $1`, [exception.safetyAlertId]);
      const auditBefore = await q(`SELECT id, action, "afterData"::text AS d, "createdAt" FROM audit_logs WHERE ("entityType" = 'patrol_exception' AND "entityId" = $1)
        OR ("entityType" = 'safety_alert' AND "entityId" = $2) ORDER BY id`, [exception.id, exception.safetyAlertId]);
      // The Guard had patrolled on time, offline; the run reaches the server now.
      const deviceStart = target.start.getTime() + 5 * MIN;
      const r = await start({ shiftId: shift.id, scheduleId: yardSchedule.id, startedAtDevice: iso(deviceStart) });
      expect(r, 201);
      assert.deepEqual([r.body.windowKey, r.body.startedAtDevice, r.body.syncedLate, r.body.syncFlags.includes('evidence_after_alert')],
        [target.windowKey, iso(deviceStart), true, true], 'applied to its window with the device time');
      const ex = await one(`SELECT * FROM patrol_exceptions WHERE id = $1`, [exception.id]);
      assert.equal(ex.status, 'open', 'the exception is not closed');
      assert.deepEqual(ex.annotations.map((a: any) => [a.kind, a.text, a.runId]), [['run_started_after_alert', 'evidence received after alert', r.body.id]]);
      assert.ok(ex.lateEvidenceAt);
      const alert = await one(`SELECT * FROM safety_alerts WHERE id = $1`, [exception.safetyAlertId]);
      assert.deepEqual([alert.status, alert.priority, alert.message], ['open', 'low', alertBefore.message], 'still open, downgraded, the message as raised');
      assert.ok(alert.patrolLateSyncAt && /Evidence received after alert/.test(alert.patrolAnnotation));
      const auditAfter = await q(`SELECT id, action, "afterData"::text AS d, "createdAt" FROM audit_logs WHERE ("entityType" = 'patrol_exception' AND "entityId" = $1)
        OR ("entityType" = 'safety_alert' AND "entityId" = $2) ORDER BY id`, [exception.id, exception.safetyAlertId]);
      assert.deepEqual(auditAfter.slice(0, auditBefore.length), auditBefore, 'no audit entry rewritten or deleted');
      assert.deepEqual(auditAfter.slice(auditBefore.length).map((a: any) => a.action).sort(), ['patrol.late_evidence_received', 'safety_alert.patrol_late_sync']);
      expect(await complete(r.body.id, { completedAtDevice: iso(deviceStart + 25 * MIN) }), 200);
      await sweep(new Date());
      assert.equal(await count(`SELECT count(*) FROM patrol_exceptions WHERE "companyId" = $1 AND "windowKey" = $2`, [R.co.id, target.windowKey]), 1, 'nothing re-raised');
      const owner = await login(R.co.ownerEmail);
      const reasons = await api('GET', `/alerts/${exception.safetyAlertId}/resolution-reasons`, owner);
      assert.deepEqual(reasons.body.reasons.find((x: any) => x.value === 'patrol_completed_late_sync'), { value: 'patrol_completed_late_sync', noteRequired: false },
        'now offered, for a person to confirm');
      expect(await api('PATCH', `/alerts/${exception.safetyAlertId}/close`, owner, { resolutionReason: 'patrol_completed_late_sync' }), 200);
      assert.deepEqual(Object.values(await one(`SELECT status, resolution FROM patrol_exceptions WHERE id = $1`, [exception.id])), ['resolved', 'patrol_completed_late_sync']);
      await bookOff(shift.id, rg.id, new Date(nowMs() - MIN));
    });

    await test('PS-O11-DELAYED-COMPLETION-AFTER-AN-ABANDONED-ALERT-SYNCED-AFTER-BOOK-OFF', async () => {
      const shift = await rShift(5, null);
      const r = await start({ shiftId: shift.id, startedAtDevice: iso(nowMs() - 3 * HOUR) });
      expect(r, 201);
      await sweep(new Date());
      const abandoned = await one(`SELECT * FROM patrol_exceptions WHERE "runId" = $1 AND type = 'patrol_abandoned'`, [r.body.id]);
      assert.ok(abandoned?.safetyAlertId, 'abandoned and alerted');
      await bookOff(shift.id, rg.id, new Date(nowMs() - 10 * MIN));
      const c = await complete(r.body.id, { completedAtDevice: iso(nowMs() - 150 * MIN) });
      expect(c, 200);
      assert.deepEqual([c.body.status, c.body.syncedLate, c.body.syncFlags.includes('synced_after_book_off'), c.body.syncFlags.includes('evidence_after_alert')], ['completed', true, true, true]);
      const ex = await one(`SELECT * FROM patrol_exceptions WHERE id = $1`, [abandoned.id]);
      assert.deepEqual([ex.status, ex.annotations.map((a: any) => a.kind)], ['open', ['run_completed_after_alert']]);
      const alert = await one(`SELECT status, priority FROM safety_alerts WHERE id = $1`, [abandoned.safetyAlertId]);
      assert.deepEqual([alert.status, alert.priority], ['open', 'low']);
    });

    await test('PS-O12-CLOCK-DRIFT-IS-MEASURED-FROM-SENT-AT-DEVICE-AND-FLAGGED-BEYOND-5-MINUTES', async () => {
      const shift = await rShift(4, null);
      const slow = await start({ shiftId: shift.id, startedAtDevice: iso(nowMs() - 70 * MIN), sentAtDevice: iso(nowMs() - 10 * MIN) });
      expect(slow, 201);
      near(slow.body.clockDriftMs, 10 * MIN, 20_000, 'drift');
      assert.deepEqual([slow.body.syncFlags, slow.body.needsReview], [['clock_drift_suspect'], true]);
      const v = await visit(slow.body.id, { scannedAtDevice: iso(nowMs() - 60 * MIN), sentAtDevice: iso(nowMs() + 8 * MIN) });
      expect(v, 201);
      near(v.body.clockDriftMs, -8 * MIN, 20_000, 'visit drift');
      assert.deepEqual(v.body.syncFlags, ['clock_drift_suspect']);
      expect(await complete(slow.body.id, { completedAtDevice: iso(nowMs() - 50 * MIN), sentAtDevice: iso(nowMs() - 4 * MIN) }), 200);
      const fine = await start({ shiftId: shift.id, startedAtDevice: iso(nowMs() - 40 * MIN), sentAtDevice: iso(nowMs() - 4 * MIN) });
      expect(fine, 201);
      assert.deepEqual([fine.body.syncFlags, fine.body.needsReview], [[], false], 'within 5 minutes: not flagged');
      expect(await complete(fine.body.id, { completedAtDevice: iso(nowMs() - 30 * MIN) }), 200);
      await bookOff(shift.id, rg.id, new Date(nowMs() - MIN));
    });

    await test('PS-O13-ANOTHER-COMPANY-S-GUARD-CANNOT-SYNC-INTO-THIS-COMPANY', async () => {
      const shift = await rShift(5, 1);
      const own = await start({ shiftId: shift.id, startedAtDevice: iso(nowMs() - 3 * HOUR) });
      expect(own, 201);
      const btok = await login(rb.guards[0].email);
      expect(await api('POST', '/patrols/runs', btok, { clientRunId: cid('x'), shiftId: shift.id, startedAtDevice: iso(nowMs() - 3 * HOUR) }), 404, 'PATROL_SHIFT_NOT_FOUND');
      expect(await visit(own.body.id, {}, btok), 404, 'PATROL_NOT_FOUND');
      expect(await complete(own.body.id, {}, btok), 404, 'PATROL_NOT_FOUND');
      const bShift = await mkShift(rb.co.id, rb.site, rb.guards[0].id, new Date(nowMs() - 5 * HOUR), new Date(nowMs() - HOUR), 'completed');
      await bookOn(bShift, rb.guards[0].id, new Date(nowMs() - 5 * HOUR));
      expect(await api('POST', '/patrols/runs', btok, { clientRunId: cid('x'), shiftId: bShift, scheduleId: allDay.id, startedAtDevice: iso(nowMs() - 3 * HOUR) }),
        422, 'PATROL_SCHEDULE_NOT_FOR_SITE', 'another company\'s schedule');
      const sameId = await api('POST', '/patrols/runs', btok, { clientRunId: own.body.clientRunId, shiftId: bShift, startedAtDevice: iso(nowMs() - 3 * HOUR) });
      expect(sameId, 201, undefined, 'client ids are per company');
      assert.notEqual(sameId.body.id, own.body.id);
      assert.equal(await count(`SELECT count(*) FROM patrol_runs WHERE "companyId" = $1 AND "guardId" = $2`, [R.co.id, rb.guards[0].id]), 0, 'nothing written into this company');
      expect(await complete(own.body.id, { completedAtDevice: iso(nowMs() - 160 * MIN) }), 200);
    });

    await test('PS-O14-A-RUN-LEFT-OPEN-PAST-THE-ACCEPTANCE-WINDOW-IS-CLOSED-BY-THE-SYSTEM', async () => {
      const shift = await rShift(34, 26);
      const open = await insRun({ companyId: R.co.id, siteId: R.site, shiftId: shift.id, guard: rg, startedAt: new Date(nowMs() - 30 * HOUR) });
      const counters = await sweep(new Date());
      assert.ok(counters.runsClosedBySystem >= 1);
      const row = await one(`SELECT status, "verificationStatus", "verificationFinalAt" FROM patrol_runs WHERE id = $1`, [open.id]);
      assert.deepEqual([row.status, row.verificationStatus, Boolean(row.verificationFinalAt)], ['closed_by_system', 'unverified', true]);
      assert.equal(await count(`SELECT count(*) FROM patrol_exceptions WHERE "runId" = $1 AND type = 'patrol_abandoned'`, [open.id]), 1, 'its abandonment was raised');
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.run_closed_by_system' AND "entityId" = $1`, [open.id]), 1);
      expect(await complete(Number(open.id), { completedAtDevice: iso(nowMs() - 29 * HOUR) }), 409, 'PATROL_RUN_NOT_IN_PROGRESS');
    });

    await test('PS-O15-THE-POST-SHIFT-ACCEPTANCE-WINDOW-IS-THE-POLICY-S', async () => {
      await setPolicy(R.co.id, R.site, { postShiftSyncHours: 2 });
      try {
        const shift = await rShift(6, 3);
        expect(await start({ shiftId: shift.id, startedAtDevice: iso(nowMs() - 4 * HOUR) }), 409, 'PATROL_SYNC_WINDOW_CLOSED', '3 h after Book Off with a 2 h window');
        const recent = await rShift(4, 1);
        const ok = await start({ shiftId: recent.id, startedAtDevice: iso(nowMs() - 2 * HOUR) });
        expect(ok, 201);
        expect(await complete(ok.body.id, { completedAtDevice: iso(nowMs() - 100 * MIN) }), 200);
      } finally {
        await q(`DELETE FROM patrol_policies WHERE "companyId" = $1 AND "siteId" = $2`, [R.co.id, R.site]);
      }
      assert.equal(o03Run.provisional, true);
    });
  } finally {
    await app.close();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  console.log(JSON.stringify({ event: 'patrol_schedule_certified', tests: passed }));
  if (failures.length) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
