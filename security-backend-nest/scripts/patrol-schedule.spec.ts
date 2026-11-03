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
 *           deadline (Patrols only unless escalated); server-verified ⇒ verified; settled after 24 h
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
 * S4 1.2.1 patrol correctness
 *   PS-C01  only server-verified, eligible photos count towards verification (pending, uploaded, rejected, quarantined,
 *           purged, tombstone never do); "taken" keeps Guard completeness; 8 rejected photos are not 8 verified
 *   PS-C02  one image (server hash) counts once in a run; later copies are listed for review
 *   PS-C03  photos are Yes / No: any count above 0 means one photo
 *   PS-C04  QR needs a checkpoint rule (a route with required checkpoints) — never verified without one, one scan is never
 *           enough; photo-only needs no checkpoint; NFC is not a method
 *   PS-C05  schedule versions: a window belongs to the version in force at its start — same day, overnight, UK DST nights
 *   PS-C06  a same-day timing edit: no false missed, old runs never satisfy new windows, exceptions / evidence / audit kept
 *   PS-C07  an overnight edit across midnight (sweep and the day count)
 *   PS-C08  overlapping windows: the old window open at the change and the successor's first are independent (plan, sweep)
 *   PS-C09  UK DST nights (29 Mar, 25 Oct 2026) with an edit: one exception per real window, split at the change
 *   PS-C10  the API ends the schedule and creates a successor on a timing change (atomic, audited, history kept)
 *   PS-C11  a run covers only the window with its actual start: the sweep, the Guard plan and the day count
 *   PS-C12  QR without a route is saved with a "Configuration required" warning (schedule, policy, plan) and its patrols
 *           are never verified (flagged qr_rule_missing, needs review); NFC refused
 *   PS-C13  the sweep counts a repeated verified image once and flags the copy duplicate_sha256 (review), once
 *   PS-C14  a patrol started (offline) under the old version before a timing change still syncs for that version's window;
 *           the old version takes nothing after the change; the plan shows each version on its side of the change
 *   PS-C15  Migration 73: the successor link is durable — concurrent timing edits make ONE successor (the other edit 409),
 *           chains A → B → C bound each version, the reads need no audit entry, a paused schedule changes in place, and
 *           the database refuses self / cross-site / unarchived / half / second-predecessor links
 *   PS-C16  exception actions through the Patrols API: acknowledge / resolve audited on the exception and its alert, the
 *           list names who acted (display name only), validation (note, late sync, 2000), a resolved exception is final
 *   PS-C17  owner rule: a PAUSED schedule's timing changes in place only with no history (no run, no exception in any
 *           status, not a successor, audited as created paused and never on); otherwise a successor that stays paused,
 *           one successor under concurrent edits; active schedules unchanged
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
  assert.equal(migrated[migrated.length - 1]?.name, 'AddPatrolMonitorIndexes1720900000022', 'the head is Migration 75 (Patrol Monitor indexes; 74 = patrol site setup; 73 = durable schedule successors; 72 = patrol sync recovery grants)');
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
      // S4 1.2.1: the photo still to be VERIFIED is photosNotVerified (photosNotOnServer is its old name, the same value).
      assert.equal(r.photosNotVerified, 1);
      assert.equal(S.verificationState({ requirements: { ...clean, photosNotOnServer: 0, photosNotVerified: 0 }, now: Z('2026-06-02T08:00:00Z'), syncDeadline: Z('2026-06-02T08:50:00Z') }), 'verified');
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
      // S4 1.2.1: these unrouted runs are photo patrols (methods ['photo']) — under a QR policy a run with no route has no
      // checkpoint rule and is never verified (patrol-correctness.spec.ts PC-S03).
      await setPolicy(s.co.id, s.site, { photosPerRun: 1, methods: JSON.stringify(['photo']) });
      const loud = await mkSite(s.co.id, 's11 Loud');
      await setPolicy(s.co.id, loud, { photosPerRun: 1, escalateUnverified: true, methods: JSON.stringify(['photo']) });
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

    await test('PS-G02-THE-GUARD-PLAN-LISTS-THE-SHIFT-S-WINDOWS-FROM-THE-SWEEP-S-ENGINE-AND-WHICH-ARE-COVERED', async () => {
      // Patrols P1-E: the Guard app shows upcoming patrols from these windows and never computes a due time itself.
      const shift = await rShift(2, null);
      const plan = await api('GET', `/patrols/mine/plan?shiftId=${shift.id}`, gtok);
      expect(plan, 200);
      const expected = W.windowsBetween(allDay, 'Europe/London', shift.start, shift.end);
      assert.ok(expected.length >= 5, 'an all-day hourly schedule has a window every hour of a 5 h shift');
      assert.deepEqual(plan.body.windows.map((w: any) => [w.windowKey, w.start, w.end]), expected.map((w) => [w.windowKey, iso(w.start), iso(w.end)]),
        'exactly the sweep engine\'s windows of the shift, earliest first; the future-dated schedule has none');
      const coveredInDb = async () => new Set((await q(`SELECT "windowKey" FROM patrol_runs WHERE "siteId" = $1 AND "scopeKey" = 'site' AND "windowKey" IS NOT NULL`, [R.site]))
        .map((x: any) => x.windowKey));
      const before = await coveredInDb();
      for (const w of plan.body.windows) {
        assert.deepEqual(Object.keys(w).sort(), ['covered', 'end', 'localDate', 'routeId', 'scheduleId', 'scheduleName', 'start', 'windowKey']);
        assert.equal(w.scheduleId, Number(allDay.id));
        assert.equal(w.covered, before.has(w.windowKey), `${w.windowKey} covered exactly when a site-scope run holds it`);
      }
      const startedAt = nowMs() - 5 * MIN;
      const r = await start({ shiftId: shift.id, scheduleId: allDay.id, startedAtDevice: iso(startedAt) });
      expect(r, 201);
      assert.ok(r.body.windowKey && !before.has(r.body.windowKey), 'the current window was open');
      const again = await api('GET', `/patrols/mine/plan?shiftId=${shift.id}`, gtok);
      const newlyCovered = again.body.windows.filter((w: any) => w.covered && !before.has(w.windowKey)).map((w: any) => w.windowKey);
      assert.deepEqual(newlyCovered, [r.body.windowKey], 'the started window is now covered, no other changed');
      assert.ok(!/guardId|guardName|clientRunId/.test(JSON.stringify(again.body.windows)), 'coverage names no Guard and no run');
      expect(await complete(r.body.id, { completedAtDevice: iso(startedAt + 2 * MIN) }), 200);
      await bookOff(shift.id, rg.id, new Date(nowMs() - MIN));
    });

    /** The late-sync flags of a run, without the assignment flags (window_auto_assigned / _match_*; never review reasons). */
    const lateFlags = (flags: string[]) => flags.filter((x) => !['window_auto_assigned', 'window_match_ambiguous', 'window_match_needs_route'].includes(x));
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
      // S4 patrol assignment correctness: a start with no schedule may also carry an assignment flag (which depends on
      // whether a window was open on the real clock this spec runs on); the late-sync flags are unchanged.
      assert.deepEqual([c.body.status, c.body.syncedLate, c.body.needsReview, lateFlags(c.body.syncFlags)], ['completed', true, false, ['synced_after_book_off']]);
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
      assert.deepEqual([c.body.needsReview, lateFlags(c.body.syncFlags).sort()], [true, ['completed_after_book_off', 'synced_after_book_off']]);
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
      assert.deepEqual([lateFlags(slow.body.syncFlags), slow.body.needsReview], [['clock_drift_suspect'], true]);
      const v = await visit(slow.body.id, { scannedAtDevice: iso(nowMs() - 60 * MIN), sentAtDevice: iso(nowMs() + 8 * MIN) });
      expect(v, 201);
      near(v.body.clockDriftMs, -8 * MIN, 20_000, 'visit drift');
      assert.deepEqual(v.body.syncFlags, ['clock_drift_suspect']);
      expect(await complete(slow.body.id, { completedAtDevice: iso(nowMs() - 50 * MIN), sentAtDevice: iso(nowMs() - 4 * MIN) }), 200);
      const fine = await start({ shiftId: shift.id, startedAtDevice: iso(nowMs() - 40 * MIN), sentAtDevice: iso(nowMs() - 4 * MIN) });
      expect(fine, 201);
      assert.deepEqual([lateFlags(fine.body.syncFlags), fine.body.needsReview], [[], false], 'within 5 minutes: not flagged');
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

    // ═══════════════════ S4 1.2.1 patrol correctness ═══════════════════
    const V = await import('../src/patrol/patrol-schedule-versions');
    const { PATROL_METHODS } = await import('../src/patrol/patrol-constants');
    const ev = (o: Partial<{ id: number; kind: string; visitId: number | null; uploadStatus: string; retentionStatus: string; sha256Stored: string | null }>) => ({
      id: o.id, kind: o.kind ?? 'run_photo', visitId: o.visitId ?? null, uploadStatus: o.uploadStatus ?? 'verified',
      retentionStatus: o.retentionStatus ?? 'active', sha256Stored: o.sha256Stored === undefined ? null : o.sha256Stored,
    });
    const photoOnly = (evidence: any[], extra: Record<string, unknown> = {}) => S.evaluateRequirements({
      requiredCheckpointIds: [], photoRequiredCheckpointIds: [], photosPerRun: 0, photosPerCheckpoint: 0, visits: [], evidence, methods: ['photo'], ...extra,
    });
    const dl = Z('2026-06-02T08:50:00Z');
    const verdict = (r: any, at: string) => S.verificationState({ requirements: r, now: Z(at), syncDeadline: dl });

    await test('PS-C01-ONLY-SERVER-VERIFIED-ELIGIBLE-PHOTOS-COUNT-TOWARDS-VERIFICATION', () => {
      // [evidence, missing (not taken), not verified]
      const cases: Array<[string, any, number, number]> = [
        ['pending (still in the outbox / uploading)', ev({ uploadStatus: 'pending' }), 0, 1],
        ['uploaded (pre-inspection lease)', ev({ uploadStatus: 'uploaded' }), 0, 1],
        ['rejected by the server', ev({ uploadStatus: 'rejected' }), 1, 0],
        ['local_corrupt', ev({ uploadStatus: 'local_corrupt' }), 1, 0],
        ['verified, quarantined', ev({ retentionStatus: 'quarantined' }), 0, 1],
        ['verified, purged', ev({ retentionStatus: 'purged' }), 0, 1],
        ['verified, tombstone', ev({ retentionStatus: 'tombstone' }), 0, 1],
        ['verified, active', ev({}), 0, 0],
        ['verified, claimed (deletion requested, not yet moved)', ev({ retentionStatus: 'claimed' }), 0, 0],
      ];
      for (const [what, e, missing, notVerified] of cases) {
        const r = photoOnly([e]);
        assert.deepEqual([r.missingRunPhotos, r.photosNotVerified, r.photosNotOnServer], [missing, notVerified, notVerified], what);
        assert.equal(verdict(r, '2026-06-02T08:00:00Z'), missing + notVerified === 0 ? 'verified' : 'pending', `${what}: before the sync deadline`);
        assert.equal(verdict(r, '2026-06-02T08:50:00Z'), missing + notVerified === 0 ? 'verified' : 'unverified', `${what}: at the sync deadline`);
      }
      const eightRejected = photoOnly(Array.from({ length: 8 }, (_, i) => ev({ id: i + 1, uploadStatus: 'rejected', sha256Stored: `${i}`.repeat(64).slice(0, 64) })));
      assert.deepEqual([eightRejected.missingRunPhotos, eightRejected.photosNotVerified], [1, 0], '8 rejected photos are not 8 verified photos: nothing usable was taken');
      assert.equal(verdict(eightRejected, '2026-06-02T09:00:00Z'), 'unverified');
      const eightVerified = photoOnly(Array.from({ length: 8 }, (_, i) => ev({ id: i + 1, sha256Stored: String.fromCharCode(97 + i).repeat(64) })));
      assert.equal(verdict(eightVerified, '2026-06-02T08:00:00Z'), 'verified');
      const mixed = photoOnly([ev({ id: 1, uploadStatus: 'pending' }), ev({ id: 2, uploadStatus: 'rejected' }), ev({ id: 3, retentionStatus: 'purged' })]);
      assert.deepEqual([mixed.missingRunPhotos, mixed.photosNotVerified], [0, 1], 'taken (pending) keeps completeness; nothing counts as verified');
      // Completeness findings use what was TAKEN: a pending photo is never "not taken".
      assert.deepEqual(S.completionFindings({ status: 'completed', exceptionReason: null, incompleteNeedsAction: true, requirements: photoOnly([ev({ uploadStatus: 'pending' })]) }), []);
      assert.deepEqual(S.completionFindings({ status: 'completed', exceptionReason: null, incompleteNeedsAction: true, requirements: photoOnly([]) }).map((f) => f.reason),
        ['1 required photo(s) not taken']);
    });

    await test('PS-C02-ONE-IMAGE-COUNTS-ONCE-DUPLICATES-ARE-LISTED-FOR-REVIEW', () => {
      const A = 'a'.repeat(64);
      const B = 'b'.repeat(64);
      const two = photoOnly([ev({ id: 11, sha256Stored: A }), ev({ id: 12, sha256Stored: A })]);
      assert.deepEqual([two.photosNotVerified, two.duplicateEvidenceIds], [0, [12]], 'one run photo needed: met once; the later copy is listed');
      assert.deepEqual(photoOnly([ev({ id: 11, sha256Stored: A }), ev({ id: 12, sha256Stored: B })]).duplicateEvidenceIds, [], 'different images');
      assert.deepEqual(photoOnly([ev({ id: 11, sha256Stored: A }), ev({ id: 12, sha256Stored: A, uploadStatus: 'uploaded' })]).duplicateEvidenceIds, [],
        'only verified, eligible copies are compared');
      // The same image as the run photo AND the checkpoint photo satisfies only one of the two requirements.
      const visits = [{ visitId: 5, checkpointId: 50, result: 'verified' }];
      const both = (evidence: any[]) => S.evaluateRequirements({
        requiredCheckpointIds: [50], photoRequiredCheckpointIds: [], photosPerRun: 1, photosPerCheckpoint: 1, visits, evidence, methods: ['qr', 'photo'],
      });
      const shared = both([ev({ id: 1, sha256Stored: A }), ev({ id: 2, kind: 'checkpoint_photo', visitId: 5, sha256Stored: A })]);
      assert.deepEqual([shared.photosNotVerified, shared.duplicateEvidenceIds, shared.missingRunPhotos + shared.missingCheckpointPhotos], [1, [2], 0]);
      assert.equal(verdict(shared, '2026-06-02T09:00:00Z'), 'unverified', 'one image never verifies two requirements');
      // The requirement with fewer candidate photos chooses first, so a second image is used where it can be.
      const choice = both([ev({ id: 1, sha256Stored: A }), ev({ id: 2, sha256Stored: B }), ev({ id: 3, kind: 'checkpoint_photo', visitId: 5, sha256Stored: A })]);
      assert.deepEqual([choice.photosNotVerified, choice.duplicateEvidenceIds], [0, [3]]);
      assert.equal(verdict(choice, '2026-06-02T08:00:00Z'), 'verified');
    });

    await test('PS-C03-PHOTOS-ARE-YES-OR-NO-NEVER-A-COUNT', () => {
      const one = [ev({ id: 1, sha256Stored: 'c'.repeat(64) })];
      const r = S.evaluateRequirements({ requiredCheckpointIds: [], photoRequiredCheckpointIds: [], photosPerRun: 5, photosPerCheckpoint: 0, visits: [], evidence: one });
      assert.deepEqual([r.missingRunPhotos, r.photosNotVerified], [0, 0], 'a legacy count of 5 means "required": one verified photo meets it');
      const cp = S.evaluateRequirements({
        requiredCheckpointIds: [1], photoRequiredCheckpointIds: [], photosPerRun: 0, photosPerCheckpoint: 3, visits: [{ visitId: 9, checkpointId: 1, result: 'verified' }],
        evidence: [ev({ id: 2, kind: 'checkpoint_photo', visitId: 9, sha256Stored: 'd'.repeat(64) })], methods: ['qr'],
      });
      assert.deepEqual([cp.missingCheckpointPhotos, cp.photosNotVerified, verdict(cp, '2026-06-02T08:00:00Z')], [0, 0, 'verified']);
      const none = S.evaluateRequirements({ requiredCheckpointIds: [1], photoRequiredCheckpointIds: [], photosPerRun: 0, photosPerCheckpoint: 0,
        visits: [{ visitId: 9, checkpointId: 1, result: 'verified' }], evidence: [], methods: ['qr'] });
      assert.equal(verdict(none, '2026-06-02T08:00:00Z'), 'verified', 'QR only, photos not required');
    });

    await test('PS-C04-QR-NEEDS-A-CHECKPOINT-RULE-PHOTO-ONLY-NEEDS-NONE', () => {
      const scan = [{ visitId: 1, checkpointId: 7, result: 'verified' }];
      const noRule = S.evaluateRequirements({ requiredCheckpointIds: [], photoRequiredCheckpointIds: [], photosPerRun: 0, photosPerCheckpoint: 0, visits: scan, evidence: [], methods: ['qr'] });
      assert.deepEqual([noRule.qrRuleMissing, noRule.missingCheckpointIds], [true, []]);
      assert.equal(verdict(noRule, '2026-06-02T08:00:00Z'), 'pending', 'one scan is never enough: never verified');
      assert.equal(verdict(noRule, '2026-06-02T08:50:00Z'), 'unverified');
      const ruled = S.evaluateRequirements({ requiredCheckpointIds: [7], photoRequiredCheckpointIds: [], photosPerRun: 0, photosPerCheckpoint: 0, visits: scan, evidence: [], methods: ['qr'] });
      assert.deepEqual([ruled.qrRuleMissing, verdict(ruled, '2026-06-02T08:00:00Z')], [false, 'verified']);
      // Photo-only: checkpoints on a route are not required (the Guard is never asked to scan); one verified photo verifies it.
      const photo = S.evaluateRequirements({ requiredCheckpointIds: [7, 8], photoRequiredCheckpointIds: [], photosPerRun: 0, photosPerCheckpoint: 0, visits: [], evidence: [], methods: ['photo'] });
      assert.deepEqual([photo.qrRuleMissing, photo.missingCheckpointIds, photo.missingRunPhotos], [false, [], 1]);
      const photoDone = S.evaluateRequirements({ requiredCheckpointIds: [], photoRequiredCheckpointIds: [], photosPerRun: 0, photosPerCheckpoint: 0, visits: [],
        evidence: [ev({ id: 1, sha256Stored: 'e'.repeat(64) })], methods: ['photo'] });
      assert.equal(verdict(photoDone, '2026-06-02T08:00:00Z'), 'verified', 'photo-only with zero checkpoints');
      const both = S.evaluateRequirements({ requiredCheckpointIds: [], photoRequiredCheckpointIds: [], photosPerRun: 0, photosPerCheckpoint: 0, visits: [],
        evidence: [ev({ id: 1, sha256Stored: 'e'.repeat(64) })], methods: ['qr', 'photo'] });
      assert.deepEqual([both.qrRuleMissing, verdict(both, '2026-06-02T09:00:00Z')], [true, 'unverified'], 'QR + photo: the photo does not replace the checkpoint rule');
      // NFC is not a method anywhere.
      assert.deepEqual([...PATROL_METHODS], ['qr', 'photo']);
    });

    // Schedule versions (B1). The engine with version bounds; then the sweep, the plan and the day count.
    const partition = (def: any, at: Date, succDef: any, from: string, to: string) => ({
      all: W.windowsBetween(def, 'Europe/London', Z(from), Z(to)),
      pred: W.windowsBetween({ ...def, effectiveUntil: at }, 'Europe/London', Z(from), Z(to)),
      succ: W.windowsBetween({ ...succDef, effectiveFrom: at }, 'Europe/London', Z(from), Z(to)),
    });
    const starts = (ws: any[]) => ws.map((w) => w.start.toISOString().slice(0, 16));

    await test('PS-C05-A-WINDOW-BELONGS-TO-THE-VERSION-IN-FORCE-AT-ITS-START-SAME-DAY-OVERNIGHT-AND-UK-DST', () => {
      // Same definition on both sides: the two versions partition the windows exactly (nothing twice, nothing lost).
      const cases: Array<[string, any, string, string, string]> = [
        ['same day', sched({ id: 31, from: '08:00', to: '12:00', freq: 60 }), '2026-06-02T09:20:00Z', '2026-06-02T00:00:00Z', '2026-06-03T00:00:00Z'],
        ['overnight', sched({ id: 32, from: '22:00', to: '06:00', freq: 60 }), '2026-06-03T00:30:00Z', '2026-06-02T12:00:00Z', '2026-06-03T12:00:00Z'],
        ['spring forward 29 Mar 2026', sched({ id: 33, from: '22:00', to: '06:00', freq: 30 }), '2026-03-29T00:30:00Z', '2026-03-28T12:00:00Z', '2026-03-29T12:00:00Z'],
        ['spring forward, edit at the jump', sched({ id: 34, from: '22:00', to: '06:00', freq: 30 }), '2026-03-29T01:00:00Z', '2026-03-28T12:00:00Z', '2026-03-29T12:00:00Z'],
        ['clocks back 25 Oct 2026', sched({ id: 35, from: '22:00', to: '06:00', freq: 30 }), '2026-10-25T00:30:00Z', '2026-10-24T12:00:00Z', '2026-10-25T12:00:00Z'],
        ['clocks back, edit in the repeated hour', sched({ id: 36, from: '22:00', to: '06:00', freq: 30 }), '2026-10-25T01:15:00Z', '2026-10-24T12:00:00Z', '2026-10-25T12:00:00Z'],
      ];
      for (const [what, def, at, from, to] of cases) {
        const p = partition(def, Z(at), def, from, to);
        assert.deepEqual([...starts(p.pred), ...starts(p.succ)].sort(), starts(p.all).sort(), `${what}: the versions partition the windows`);
        assert.ok(p.pred.every((w: any) => w.start < Z(at)) && p.succ.every((w: any) => w.start >= Z(at)), `${what}: split at the change`);
        assert.equal(new Set(starts(p.succ)).size, p.succ.length, `${what}: no duplicate`);
      }
      // A real change, with exact windows (site clock in comments).
      const sameDay = partition(sched({ id: 41, freq: 60 }), Z('2026-06-02T09:20:00Z'), sched({ id: 42, freq: 30 }), '2026-06-02T00:00:00Z', '2026-06-03T00:00:00Z');
      assert.deepEqual(starts(sameDay.pred), ['2026-06-02T07:00', '2026-06-02T08:00', '2026-06-02T09:00'], '08, 09 and the 10:00 window open at the change (10:20 BST)');
      assert.deepEqual(sameDay.succ.map((w: any) => [w.windowKey, w.start.toISOString().slice(11, 16)]),
        [['s42:2026-06-02:5', '09:30'], ['s42:2026-06-02:6', '10:00'], ['s42:2026-06-02:7', '10:30']], 'every 30 min from the change: 10:30, 11:00, 11:30 BST');
      const night = partition(sched({ id: 43, from: '22:00', to: '06:00', freq: 60 }), Z('2026-06-03T00:30:00Z'), sched({ id: 44, from: '22:00', to: '06:00', freq: 120 }),
        '2026-06-02T12:00:00Z', '2026-06-03T12:00:00Z');
      assert.deepEqual(starts(night.pred), ['2026-06-02T21:00', '2026-06-02T22:00', '2026-06-02T23:00', '2026-06-03T00:00'], '22:00–01:00 BST, the 01:00 window open at 01:30');
      assert.deepEqual(night.succ.map((w: any) => [w.windowKey, w.start.toISOString().slice(0, 16)]),
        [['s44:2026-06-02:2', '2026-06-03T01:00'], ['s44:2026-06-02:3', '2026-06-03T03:00']], 'across midnight: still the night that started on the 2nd');
      const spring = partition(sched({ id: 45, from: '22:00', to: '06:00', freq: 60 }), Z('2026-03-29T00:30:00Z'), sched({ id: 46, from: '22:00', to: '06:00', freq: 30 }),
        '2026-03-28T12:00:00Z', '2026-03-29T12:00:00Z');
      assert.deepEqual([spring.all.length, spring.pred.length, spring.succ.length], [7, 3, 9], 'spring forward: 22, 23, 00 GMT before; 00:30 GMT then 02:00–05:30 BST after');
      assert.deepEqual(starts(spring.succ).slice(0, 3), ['2026-03-29T00:30', '2026-03-29T01:00', '2026-03-29T01:30']);
      const autumn = partition(sched({ id: 47, from: '22:00', to: '06:00', freq: 60 }), Z('2026-10-25T00:30:00Z'), sched({ id: 48, from: '22:00', to: '06:00', freq: 30 }),
        '2026-10-24T12:00:00Z', '2026-10-25T12:00:00Z');
      assert.deepEqual([autumn.all.length, autumn.pred.length, autumn.succ.length], [8, 4, 9], 'clocks back: 22–01 BST before; 01:30 BST (first) … 05:30 GMT after');
      assert.deepEqual([autumn.succ[0].start.toISOString(), autumn.succ[0].end.toISOString()], ['2026-10-25T00:30:00.000Z', '2026-10-25T02:00:00.000Z'],
        'the 01:30 slot runs to 02:00 GMT (the repeated hour is covered once)');
      // What counts as a timing change.
      const base = { daysOfWeek: [1, 3, 5], activeFrom: '22:00', activeTo: '06:00', frequencyMinutes: 60, windowMinutes: 60, startsOn: null, endsOn: null };
      assert.equal(V.timingChanged(base, { ...base, daysOfWeek: [5, 3, 1] }), false, 'the same days in another order');
      for (const change of [{ frequencyMinutes: 30 }, { windowMinutes: 30 }, { activeFrom: '21:00' }, { activeTo: '07:00' }, { daysOfWeek: [1, 3] }, { startsOn: '2026-11-01' }, { endsOn: '2026-12-01' }]) {
        assert.equal(V.timingChanged(base, { ...base, ...change }), true, JSON.stringify(change));
      }
    });

    /** What PatrolConfigService.updateSchedule does on a timing change, at a chosen instant (PS-C10 checks the API does exactly this). */
    const supersedeAt = async (companyId: number, pred: any, at: Date, changes: { activeFrom?: string; activeTo?: string; freq?: number; win?: number }) => {
      const succ = await one(`INSERT INTO patrol_schedules ("companyId","siteId","routeId",name,"daysOfWeek","activeFrom","activeTo","frequencyMinutes","windowMinutes","startsOn",active,"createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,true,$11,$11) RETURNING *`,
        [companyId, pred.siteId, pred.routeId, pred.name, JSON.stringify(pred.daysOfWeek), changes.activeFrom ?? pred.activeFrom, changes.activeTo ?? pred.activeTo,
          changes.freq ?? pred.frequencyMinutes, changes.win ?? changes.freq ?? pred.windowMinutes, pred.startsOn, at]);
      // The Migration 73 link, as the service writes it (updatedAt kept: the old version's judging floor).
      await q(`UPDATE patrol_schedules SET active = false, "archivedAt" = $2, "supersededByScheduleId" = $3, "supersededAt" = $2 WHERE id = $1`, [pred.id, at, succ.id]);
      return succ;
    };
    const keysOf = async (companyId: number) => (await exceptionsOf(companyId)).filter((e: any) => e.type === 'patrol_missed').map((e: any) => e.windowKey).sort();
    const sorted = (a: string[]) => [...a].sort();

    await test('PS-C06-SAME-DAY-EDIT-NO-FALSE-MISSED-OLD-RUNS-NEVER-SATISFY-NEW-WINDOWS-HISTORY-KEPT', async () => {
      const s = await scenario('c06');
      const [g] = s.guards;
      const pred = await mkSchedule(s.co.id, s.site, { name: 'Yard', from: '08:00', to: '12:00', freq: 60 });
      const shift = await mkShift(s.co.id, s.site, g.id, day('05:00:00'), day('13:00:00'));
      await bookOn(shift, g.id, day('04:55:00'));
      const run0 = await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, scheduleId: pred.id, window: windowAt(pred, '2026-06-02T07:05:00Z'),
        status: 'completed', startedAt: day('07:05:00'), completedAt: day('07:20:00') });
      await insEvidence(run0, 'run_photo', 'verified');
      await sweep(day('09:19:00'));
      assert.deepEqual(await keysOf(s.co.id), sorted([`s${pred.id}:2026-06-02:1`]), 'before the edit: the 09:00 BST window was missed');
      const before = await exceptionsOf(s.co.id);
      const succ = await supersedeAt(s.co.id, pred, day('09:20:00'), { freq: 30 }); // 10:20 BST: every 30 minutes from now
      await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, scheduleId: succ.id, window: windowAt(withBounds(succ), '2026-06-02T09:35:00Z'),
        status: 'completed', startedAt: day('09:35:00'), completedAt: day('09:50:00') });
      await sweep(day('12:00:00'));
      assert.deepEqual(await keysOf(s.co.id), sorted([`s${pred.id}:2026-06-02:1`, `s${succ.id}:2026-06-02:6`, `s${succ.id}:2026-06-02:7`]),
        'the 10:00 window open at the change is not judged (no false missed); the successor is judged from the change; 10:30 had its run');
      const after = await exceptionsOf(s.co.id);
      const kept = after.find((e: any) => Number(e.id) === Number(before[0].id));
      assert.deepEqual([Number(kept.scheduleId), kept.status, kept.windowKey], [Number(pred.id), 'open', before[0].windowKey], 'the earlier exception is kept as it was');
      assert.equal(await count(`SELECT count(*) FROM patrol_runs WHERE "scheduleId" = $1`, [pred.id]), 1, 'the old run still points at its version');
      assert.equal(await count(`SELECT count(*) FROM patrol_evidence WHERE "runId" = $1`, [run0.id]), 1, 'its evidence is kept');
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.exception_raised' AND "entityId" = $1`, [before[0].id]), 1, 'its audit is kept');
      assert.ok(after.every((e: any) => e.type !== 'patrol_missed' || Number(e.scheduleId) !== Number(succ.id) || new Date(e.windowStart) >= day('09:20:00')),
        'no successor window before the change');
    });
    /** A schedule row with its version bounds from the audit trail (what the services read). */
    function withBounds(row: any) {
      return { ...row, effectiveFrom: new Date(row.createdAt) };
    }

    await test('PS-C07-OVERNIGHT-EDIT-ACROSS-MIDNIGHT', async () => {
      const s = await scenario('c07');
      const [g] = s.guards;
      const pred = await mkSchedule(s.co.id, s.site, { name: 'Night', from: '22:00', to: '06:00', freq: 60 });
      const shift = await mkShift(s.co.id, s.site, g.id, Z('2026-06-02T20:00:00Z'), Z('2026-06-03T06:30:00Z'));
      await bookOn(shift, g.id, Z('2026-06-02T20:00:00Z'));
      await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, scheduleId: pred.id, window: windowAt(pred, '2026-06-02T22:05:00Z'),
        status: 'completed', startedAt: Z('2026-06-02T22:05:00Z'), completedAt: Z('2026-06-02T22:20:00Z') });
      await sweep(Z('2026-06-03T00:29:00Z'));
      const succ = await supersedeAt(s.co.id, pred, Z('2026-06-03T00:30:00Z'), { freq: 120 }); // 01:30 BST: every two hours from now
      await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, scheduleId: succ.id, window: windowAt(withBounds(succ), '2026-06-03T01:10:00Z'),
        status: 'completed', startedAt: Z('2026-06-03T01:10:00Z'), completedAt: Z('2026-06-03T01:30:00Z') });
      await sweep(Z('2026-06-03T06:00:00Z'));
      assert.deepEqual(await keysOf(s.co.id), sorted([`s${pred.id}:2026-06-02:0`, `s${pred.id}:2026-06-02:2`, `s${succ.id}:2026-06-02:3`]),
        '22:00 and 00:00 BST missed before the change (23:00 had its run); 01:00 open at the change is not judged; the successor\'s 04:00 missed, 02:00 had its run');
      // The day count for the night's date: the old version's windows before the change, the new one's from it — none twice.
      const ownerTok = await login(s.co.ownerEmail);
      const d = await api('GET', `/patrols/windows/day?siteId=${s.site}&date=2026-06-03`, ownerTok);
      expect(d, 200);
      assert.equal(d.body.windowsDue, 2 + 3, 'on 3 June: 00:00 and 01:00 BST (old, before the change) + 02:00, 04:00 and 22:00 BST (new)');
    });

    await test('PS-C08-OVERLAPPING-WINDOWS-THE-OPEN-OLD-WINDOW-AND-THE-SUCCESSOR-S-FIRST-ARE-INDEPENDENT', async () => {
      const s = await scenario('c08');
      const [g] = s.guards;
      const pred = await mkSchedule(s.co.id, s.site, { name: 'Lot', from: '08:00', to: '12:00', freq: 60 });
      const shift = await mkShift(s.co.id, s.site, g.id, day('05:00:00'), day('13:00:00'));
      await bookOn(shift, g.id, day('04:55:00'));
      await sweep(day('09:09:00'));
      const succ = await supersedeAt(s.co.id, pred, day('09:10:00'), { activeFrom: '10:15', freq: 30 }); // 10:10 BST
      const open = windowAt({ ...pred, effectiveUntil: day('09:10:00') }, '2026-06-02T09:12:00Z');
      const first = windowAt(withBounds(succ), '2026-06-02T09:20:00Z');
      assert.deepEqual([iso(open.start), iso(open.end), iso(first.start), iso(first.end)],
        ['2026-06-02T09:00:00.000Z', '2026-06-02T10:00:00.000Z', '2026-06-02T09:15:00.000Z', '2026-06-02T09:45:00.000Z'], 'they overlap');
      // A run for the old open window covers only it.
      await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, scheduleId: pred.id, window: open, status: 'completed',
        startedAt: day('09:12:00'), completedAt: day('09:30:00') });
      const plan = await api('GET', `/patrols/mine/plan?shiftId=${shift}`, await login(g.email));
      expect(plan, 200);
      const rows = plan.body.windows.map((w: any) => [w.scheduleId, w.start.slice(11, 16), w.covered]);
      assert.deepEqual(rows.filter((r: any) => r[0] === Number(pred.id)), [[Number(pred.id), '07:00', false], [Number(pred.id), '08:00', false], [Number(pred.id), '09:00', true]],
        'the old version until the change, its open window covered');
      assert.deepEqual(rows.filter((r: any) => r[0] === Number(succ.id)).map((r: any) => r.slice(1)), [['09:15', false], ['09:45', false], ['10:15', false], ['10:45', false]],
        'the new version from the change');
      assert.deepEqual(plan.body.schedules.map((x: any) => x.id), [Number(succ.id)], 'only the version in force is offered as a schedule');
      await sweep(day('11:30:00'));
      assert.deepEqual(await keysOf(s.co.id), sorted([`s${pred.id}:2026-06-02:0`, `s${pred.id}:2026-06-02:1`, `s${succ.id}:2026-06-02:0`, `s${succ.id}:2026-06-02:1`, `s${succ.id}:2026-06-02:2`, `s${succ.id}:2026-06-02:3`]),
        'the old run does not satisfy the overlapping new window; the old window open at the change is never judged; 08:00 BST (judged before the change) and 09:00 BST (ended before it) were missed');
    });

    await test('PS-C09-UK-DST-NIGHTS-WITH-AN-EDIT-ONE-EXCEPTION-PER-REAL-WINDOW', async () => {
      for (const [label, night, at, before, after, want] of [
        ['c09s', '2026-03-28', '2026-03-29T00:30:00Z', '2026-03-29T00:29:00Z', '2026-03-29T06:00:00Z', [2, 9]],
        ['c09a', '2026-10-24', '2026-10-25T00:30:00Z', '2026-10-25T00:29:00Z', '2026-10-25T07:00:00Z', [3, 9]],
      ] as Array<[string, string, string, string, string, number[]]>) {
        const s = await scenario(label);
        const [g] = s.guards;
        const pred = await mkSchedule(s.co.id, s.site, { name: 'Night', from: '22:00', to: '06:00', freq: 60 });
        const shift = await mkShift(s.co.id, s.site, g.id, Z(`${night}T19:00:00Z`), Z(addDay(night) + 'T07:30:00Z'));
        await bookOn(shift, g.id, Z(`${night}T19:00:00Z`));
        await sweep(Z(before));
        const succ = await supersedeAt(s.co.id, pred, Z(at), { freq: 30 });
        await sweep(Z(after));
        const ex = (await exceptionsOf(s.co.id)).filter((e: any) => e.type === 'patrol_missed');
        const old = ex.filter((e: any) => Number(e.scheduleId) === Number(pred.id));
        const neu = ex.filter((e: any) => Number(e.scheduleId) === Number(succ.id));
        assert.deepEqual([old.length, neu.length], want, `${label}: old windows judged before the change, every new window after`);
        assert.equal(new Set(ex.map((e: any) => e.windowKey)).size, ex.length, `${label}: no window twice`);
        assert.equal(new Set(ex.map((e: any) => iso(e.windowStart))).size, ex.length, `${label}: no instant twice`);
        assert.ok(old.every((e: any) => new Date(e.windowStart) < Z(at)) && neu.every((e: any) => new Date(e.windowStart) >= Z(at)), `${label}: split at the change`);
        const expected = W.windowsBetween({ ...succ, effectiveFrom: Z(at) }, 'Europe/London', Z(`${night}T12:00:00Z`), Z(after)).map((w: any) => w.windowKey).sort();
        assert.deepEqual(neu.map((e: any) => e.windowKey).sort(), expected, `${label}: exactly the engine's windows`);
      }
    });
    function addDay(date: string) {
      return W.addLocalDays(date, 1);
    }

    await test('PS-C10-THE-API-ENDS-THE-SCHEDULE-AND-CREATES-A-SUCCESSOR-ON-A-TIMING-CHANGE', async () => {
      const s = await scenario('c10');
      const [g] = s.guards;
      const tok = await login(s.co.ownerEmail);
      const created = await api('POST', '/patrols/schedules', tok, { siteId: s.site, name: 'Gatehouse', activeFrom: '08:00', activeTo: '20:00', frequencyMinutes: 60 });
      expect(created, 201);
      const predId = created.body.id;
      const shift = await mkShift(s.co.id, s.site, g.id, day('05:00:00'), day('13:00:00'));
      const oldRun = await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, scheduleId: predId, status: 'completed', startedAt: day('07:05:00'), completedAt: day('07:20:00') });
      await insEvidence(oldRun, 'run_photo', 'verified');
      const schedulesBefore = await count(`SELECT count(*) FROM patrol_schedules WHERE "companyId" = $1`, [s.co.id]);
      // Atomic: a timing change that fails validation (another site's route) creates nothing and ends nothing.
      const other = await mkSite(s.co.id, 'c10 Other');
      const foreign = await one(`INSERT INTO patrol_routes ("companyId","siteId",name) VALUES ($1,$2,'Elsewhere') RETURNING id`, [s.co.id, other]);
      expect(await api('PATCH', `/patrols/schedules/${predId}`, tok, { frequencyMinutes: 30, routeId: Number(foreign.id) }), 422, 'PATROL_ROUTE_NOT_FOR_SITE');
      assert.equal(await count(`SELECT count(*) FROM patrol_schedules WHERE "companyId" = $1`, [s.co.id]), schedulesBefore);
      assert.equal((await one(`SELECT active FROM patrol_schedules WHERE id = $1`, [predId])).active, true);
      // Name only: in place.
      const renamed = await api('PATCH', `/patrols/schedules/${predId}`, tok, { name: 'Gatehouse loop', daysOfWeek: [7, 6, 5, 4, 3, 2, 1] });
      expect(renamed, 200);
      assert.deepEqual([renamed.body.id, renamed.body.timingChanged, renamed.body.predecessorId, renamed.body.name], [predId, false, null, 'Gatehouse loop']);
      // Timing: a successor.
      const p = await api('PATCH', `/patrols/schedules/${predId}`, tok, { frequencyMinutes: 30, activeTo: '22:00' });
      expect(p, 200);
      const succId = p.body.id;
      assert.notEqual(succId, predId);
      assert.deepEqual([p.body.timingChanged, p.body.predecessorId, p.body.frequencyMinutes, p.body.windowMinutes, p.body.activeTo, p.body.name, p.body.active],
        [true, predId, 30, 30, '22:00', 'Gatehouse loop', true]);
      const pred = await one(`SELECT * FROM patrol_schedules WHERE id = $1`, [predId]);
      const succ = await one(`SELECT * FROM patrol_schedules WHERE id = $1`, [succId]);
      assert.deepEqual([pred.active, Number(pred.frequencyMinutes), pred.activeTo], [false, 60, '20:00'], 'the old version is kept as it was, archived');
      assert.equal(iso(pred.archivedAt), iso(succ.createdAt), 'the new version takes effect the instant the old one ends');
      const sup = await q(`SELECT "afterData", "userId" FROM audit_logs WHERE action = 'patrol.schedule.superseded' AND "entityId" = $1`, [predId]);
      assert.equal(sup.length, 1);
      assert.deepEqual([sup[0].afterData.successorId, sup[0].afterData.effectiveAt, Number(sup[0].userId)], [succId, iso(succ.createdAt), s.co.ownerId],
        'the audit entry is kept as evidence');
      assert.deepEqual([Number(pred.supersededByScheduleId), iso(pred.supersededAt), succ.supersededByScheduleId], [succId, iso(succ.createdAt), null],
        'the durable link (Migration 73)');
      const predRead = await api('GET', `/patrols/schedules/${predId}`, tok);
      assert.deepEqual([predRead.body.supersededByScheduleId, predRead.body.supersededAt], [succId, iso(succ.createdAt)]);
      const cre = await one(`SELECT "afterData" FROM audit_logs WHERE action = 'patrol.schedule.created' AND "entityId" = $1`, [succId]);
      assert.deepEqual([cre.afterData.predecessorId, cre.afterData.effectiveAt], [predId, iso(succ.createdAt)]);
      const bounds = await V.scheduleVersionBounds(ds, s.co.id);
      assert.deepEqual([iso(bounds.get(predId)!.effectiveUntil!), bounds.get(predId)!.successorId, iso(bounds.get(succId)!.effectiveFrom!), bounds.get(succId)!.predecessorId],
        [iso(succ.createdAt), succId, iso(succ.createdAt), predId]);
      // History is untouched; the old version can no longer be edited; the list shows the version in force.
      assert.equal(Number((await one(`SELECT "scheduleId" FROM patrol_runs WHERE id = $1`, [oldRun.id])).scheduleId), predId);
      assert.equal(await count(`SELECT count(*) FROM patrol_evidence WHERE "runId" = $1`, [oldRun.id]), 1);
      expect(await api('PATCH', `/patrols/schedules/${predId}`, tok, { frequencyMinutes: 15 }), 409, 'PATROL_VALIDATION_FAILED');
      const list = await api('GET', `/patrols/schedules?siteId=${s.site}`, tok);
      assert.deepEqual(list.body.map((x: any) => x.id), [succId]);
      const all = await api('GET', `/patrols/schedules?siteId=${s.site}&includeInactive=true`, tok);
      assert.deepEqual(all.body.map((x: any) => x.id).sort((a: number, b: number) => a - b), [predId, succId]);
      // A second timing change chains: the successor ends and a third version starts.
      const p2 = await api('PATCH', `/patrols/schedules/${succId}`, tok, { activeFrom: '07:00' });
      expect(p2, 200);
      assert.deepEqual([p2.body.timingChanged, p2.body.predecessorId], [true, succId]);
      const chain = await V.scheduleVersionBounds(ds, s.co.id);
      assert.ok(chain.get(succId)!.effectiveFrom && chain.get(succId)!.effectiveUntil, 'the middle version is bounded on both sides');
    });

    await test('PS-C11-A-RUN-COVERS-ONLY-THE-WINDOW-WITH-ITS-ACTUAL-START-SWEEP-PLAN-AND-DAY', async () => {
      const s = await scenario('c11');
      const [g] = s.guards;
      const schedule = await mkSchedule(s.co.id, s.site, { name: 'Dock', from: '08:00', to: '12:00', freq: 60 });
      const shift = await mkShift(s.co.id, s.site, g.id, day('05:00:00'), day('13:00:00'));
      await bookOn(shift, g.id, day('04:55:00'));
      const w0 = windowAt(schedule, '2026-06-02T07:05:00Z');
      const w1 = windowAt(schedule, '2026-06-02T08:05:00Z');
      await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, scheduleId: schedule.id, window: w0, status: 'completed', startedAt: day('07:05:00'), completedAt: day('07:20:00') });
      // A run recorded under w1's key but for a window with a different start (as an in-place timing edit used to leave).
      await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, scheduleId: schedule.id,
        window: { windowKey: w1.windowKey, start: new Date(w1.start.getTime() + 30 * MIN), end: new Date(w1.end.getTime() + 30 * MIN) },
        status: 'completed', startedAt: day('08:35:00'), completedAt: day('08:50:00') });
      await sweep(day('12:00:00'));
      assert.deepEqual(await keysOf(s.co.id), sorted([1, 2, 3].map((k) => `s${schedule.id}:2026-06-02:${k}`)), 'sweep: only w0 is covered');
      const plan = await api('GET', `/patrols/mine/plan?shiftId=${shift}`, await login(g.email));
      expect(plan, 200);
      assert.deepEqual(plan.body.windows.map((w: any) => w.covered), [true, false, false, false], 'plan: only w0 is covered');
      const d = await api('GET', `/patrols/windows/day?siteId=${s.site}&date=2026-06-02`, await login(s.co.ownerEmail));
      expect(d, 200);
      assert.deepEqual([d.body.windowsDue, d.body.windowsCompleted, d.body.windowsOutstanding], [4, 1, 3], 'day: only w0 is completed');
    });

    await test('PS-C12-QR-WITHOUT-A-ROUTE-IS-SAVED-WITH-A-WARNING-AND-ITS-PATROLS-ARE-NEVER-VERIFIED', async () => {
      const s = await scenario('c12');
      const [g] = s.guards;
      const tok = await login(s.co.ownerEmail);
      const sch = await api('POST', '/patrols/schedules', tok, { siteId: s.site, name: 'No route', activeFrom: '08:00', activeTo: '12:00', frequencyMinutes: 60 });
      expect(sch, 201, undefined, 'saving a QR schedule with no route is allowed');
      assert.deepEqual(sch.body.configurationWarnings, [{ code: 'QR_ROUTE_REQUIRED', message: 'Choose a route with required checkpoints, or switch this site to photos.', siteId: s.site, scheduleId: sch.body.id }]);
      const cp = await mkCheckpoint(s.co.id, s.site, 'Rear door');
      const optional = await api('POST', '/patrols/routes', tok, { siteId: s.site, name: 'Optional only', checkpoints: [{ checkpointId: Number(cp.id), required: false }] });
      expect(optional, 201);
      const withOptional = await api('POST', '/patrols/schedules', tok, { siteId: s.site, name: 'Optional route', activeFrom: '08:00', activeTo: '12:00', frequencyMinutes: 60, routeId: optional.body.id });
      assert.equal(withOptional.body.configurationWarnings.length, 1, 'a route without a required checkpoint is no checkpoint rule');
      const route = await api('POST', '/patrols/routes', tok, { siteId: s.site, name: 'Loop', checkpoints: [{ checkpointId: Number(cp.id) }] });
      const good = await api('POST', '/patrols/schedules', tok, { siteId: s.site, name: 'Routed', activeFrom: '08:00', activeTo: '12:00', frequencyMinutes: 60, routeId: route.body.id });
      assert.deepEqual(good.body.configurationWarnings, []);
      const pol = await api('GET', '/patrols/policies', tok);
      assert.deepEqual(pol.body.sites.find((x: any) => x.siteId === s.site).configurationWarnings.map((w: any) => w.scheduleId).sort(), [sch.body.id, withOptional.body.id].sort());
      const put = await api('PUT', `/patrols/policies/sites/${s.site}`, tok, { methods: ['qr'], photosPerRun: 3 });
      expect(put, 200);
      assert.deepEqual([put.body.policy.photosPerRun, put.body.configurationWarnings.length], [1, 2], 'saving the QR policy returns the warnings (and photos are Yes/No)');
      const shift = await mkShift(s.co.id, s.site, g.id, day('05:00:00'), day('13:00:00'));
      const plan = await api('GET', `/patrols/mine/plan?shiftId=${shift}`, await login(g.email));
      assert.deepEqual(plan.body.configurationWarnings.map((w: any) => [w.code, w.scheduleId]).sort(), [['QR_ROUTE_REQUIRED', sch.body.id], ['QR_ROUTE_REQUIRED', withOptional.body.id]].sort(),
        'the Guard is told plainly');
      const photo = await api('PUT', `/patrols/policies/sites/${s.site}`, tok, { methods: ['photo'], photosPerRun: 0 });
      assert.deepEqual(photo.body.configurationWarnings, [], 'a photo site needs no route');
      assert.deepEqual((await api('GET', `/patrols/schedules?siteId=${s.site}`, tok)).body.map((x: any) => x.configurationWarnings.length), [0, 0, 0]);
      expect(await api('PUT', `/patrols/policies/sites/${s.site}`, tok, { methods: ['nfc'] }), 400, undefined, 'NFC is never accepted');
      await api('PUT', `/patrols/policies/sites/${s.site}`, tok, { methods: ['qr'] });

      // The sweep: a QR run with no route is never verified (even with a scan), flagged once for review.
      await bookOn(shift, g.id, day('04:55:00'));
      const bare = await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, status: 'completed', startedAt: day('07:05:00'), completedAt: day('07:20:00') });
      await insVisit(s.co.id, bare.id, cp, 'verified', day('07:10:00'));
      const routed = await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, routeId: route.body.id, status: 'completed', startedAt: day('07:25:00'), completedAt: day('07:40:00') });
      await insVisit(s.co.id, routed.id, cp, 'verified', day('07:30:00'));
      const reasoned = await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, status: 'incomplete', reason: 'No labels on site', startedAt: day('07:45:00'), completedAt: day('07:50:00') });
      await sweep(day('07:55:00'));
      const st = async (id: number) => one(`SELECT "verificationStatus", "needsReview", "syncFlags" FROM patrol_runs WHERE id = $1`, [id]);
      assert.deepEqual(await st(bare.id), { verificationStatus: 'pending', needsReview: true, syncFlags: ['qr_rule_missing'] }, 'never "verified" by one scan; up for review');
      assert.deepEqual(await st(routed.id), { verificationStatus: 'verified', needsReview: false, syncFlags: [] });
      assert.deepEqual([(await st(reasoned.id)).syncFlags], [['qr_rule_missing']]);
      await sweep(day('10:00:00'));
      assert.equal((await st(bare.id)).verificationStatus, 'unverified', 'after the sync deadline: unverified, never verified');
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.run_flagged_for_review' AND "entityId" = $1`, [bare.id]), 1, 'flagged once');
      const inc = (await exceptionsOf(s.co.id)).filter((e: any) => Number(e.runId) === Number(reasoned.id));
      assert.deepEqual(inc.map((e: any) => [e.type, e.note]), [['patrol_incomplete', 'No labels on site']], 'an incomplete patrol with a reason is still recorded as such');
      assert.equal((await exceptionsOf(s.co.id)).filter((e: any) => e.type === 'evidence_unverified').length, 0, 'no photo was required');
    });

    await test('PS-C13-THE-SWEEP-COUNTS-A-REPEATED-IMAGE-ONCE-AND-FLAGS-IT-FOR-REVIEW', async () => {
      const s = await scenario('c13');
      const [g] = s.guards;
      await setPolicy(s.co.id, s.site, { methods: JSON.stringify(['photo']), photosPerRun: 1 });
      const shift = await mkShift(s.co.id, s.site, g.id, day('05:00:00'), day('13:00:00'));
      await bookOn(shift, g.id, day('04:55:00'));
      const run = await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, status: 'completed', startedAt: day('07:05:00'), completedAt: day('07:20:00') });
      const photo = async (status: string, sha: string | null, retention = 'active') => one(
        `INSERT INTO patrol_evidence ("companyId","siteId","runId","guardId","shiftId",kind,"uploadStatus","retentionStatus","sha256Client","sha256Stored","capturedAtDevice","clientEvidenceId","purgedAt")
         VALUES ($1,$2,$3,$4,$5,'run_photo',$6,$7::varchar,$8,$9,$10,$11,CASE WHEN $7::varchar IN ('purged','tombstone') THEN $10::timestamptz END) RETURNING id`,
        [s.co.id, s.site, run.id, g.id, shift, status, retention, 'f'.repeat(64), sha, day('07:10:00'), cid('ev')]);
      const first = await photo('verified', 'f'.repeat(64));
      const copy = await photo('verified', 'f'.repeat(64));
      const purgedCopy = await photo('verified', 'f'.repeat(64), 'purged');
      await sweep(day('07:30:00'));
      const r = await one(`SELECT "verificationStatus", "needsReview", "syncFlags" FROM patrol_runs WHERE id = $1`, [run.id]);
      assert.deepEqual([r.verificationStatus, r.needsReview, r.syncFlags], ['verified', true, ['duplicate_sha256']], 'one photo needed and met once; the run is up for review');
      const flags = async (id: number) => (await one(`SELECT "syncFlags", "needsReview" FROM patrol_evidence WHERE id = $1`, [id]));
      assert.deepEqual(await flags(first.id), { syncFlags: [], needsReview: false });
      assert.deepEqual(await flags(copy.id), { syncFlags: ['duplicate_sha256'], needsReview: true });
      assert.deepEqual(await flags(purgedCopy.id), { syncFlags: [], needsReview: false }, 'a purged copy is no longer evidence at all');
      await sweep(day('07:40:00'));
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.run_flagged_for_review' AND "entityId" = $1`, [run.id]), 1, 'flagged once');
      // Two different images: no flag. Only copies of the SAME verified image are duplicates.
      const run2 = await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, status: 'completed', startedAt: day('08:05:00'), completedAt: day('08:20:00') });
      await one(`INSERT INTO patrol_evidence ("companyId","siteId","runId","guardId","shiftId",kind,"uploadStatus","sha256Client","sha256Stored","capturedAtDevice","clientEvidenceId")
         VALUES ($1,$2,$3,$4,$5,'run_photo','verified',$6,$6,$7,$8),($1,$2,$3,$4,$5,'run_photo','verified',$9,$9,$7,$10) RETURNING id`,
        [s.co.id, s.site, run2.id, g.id, shift, '1'.repeat(64), day('08:10:00'), cid('ev'), '2'.repeat(64), cid('ev')]);
      await sweep(day('08:30:00'));
      assert.deepEqual((await one(`SELECT "needsReview", "syncFlags" FROM patrol_runs WHERE id = $1`, [run2.id])), { needsReview: false, syncFlags: [] });
    });

    await test('PS-C14-A-PATROL-STARTED-UNDER-THE-OLD-VERSION-STILL-SYNCS-AFTER-A-TIMING-CHANGE', async () => {
      const s = await scenario('c14');
      const [g] = s.guards;
      const tok = await login(s.co.ownerEmail);
      const created = await api('POST', '/patrols/schedules', tok, { siteId: s.site, name: 'Round the clock', activeFrom: '00:00', activeTo: '00:00', frequencyMinutes: 60 });
      expect(created, 201);
      const predId = created.body.id;
      const now = Date.now();
      const shift = await mkShift(s.co.id, s.site, g.id, new Date(now - 3 * HOUR), new Date(now + 3 * HOUR));
      await bookOn(shift, g.id, new Date(now - 3 * HOUR));
      const p = await api('PATCH', `/patrols/schedules/${predId}`, tok, { frequencyMinutes: 30 });
      expect(p, 200);
      const gt = await login(g.email);
      // Started on the phone (offline) 30 minutes before the change, synced after it: accepted for the old version's window.
      const startedAt = new Date(now - 30 * MIN);
      const old = await api('POST', '/patrols/runs', gt, { clientRunId: cid('r'), shiftId: shift, scheduleId: predId, startedAtDevice: startedAt.toISOString() });
      expect(old, 201, undefined, 'a patrol for a window of the old version');
      const expected = W.windowForStart({ ...created.body, effectiveUntil: new Date(p.body.createdAt) }, 'Europe/London', startedAt, 15)!.window;
      assert.deepEqual([old.body.scheduleId, old.body.windowKey, old.body.windowStart], [predId, expected.windowKey, iso(expected.start)]);
      expect(await api('POST', `/patrols/runs/${old.body.id}/complete`, gt, { completedAtDevice: new Date(now - 10 * MIN).toISOString() }), 200);
      // The old version takes nothing that starts after the change.
      const nextHour = Math.ceil((Date.now() + MIN) / HOUR) * HOUR;
      expect(await api('POST', '/patrols/runs', gt, { clientRunId: cid('r'), shiftId: shift, scheduleId: predId, startedAtDevice: new Date(nextHour + 30 * MIN).toISOString() }),
        422, 'PATROL_SCHEDULE_NOT_FOR_SITE', 'after the change the old version has no window');
      // The plan lists the old version's windows up to the change, the new one's after it, and its run as covering only its own.
      const plan = await api('GET', `/patrols/mine/plan?shiftId=${shift}`, gt);
      expect(plan, 200);
      const effectiveAt = new Date(p.body.createdAt).getTime();
      const rows = plan.body.windows;
      assert.ok(rows.every((w: any) => (w.scheduleId === predId ? Date.parse(w.start) < effectiveAt : w.scheduleId === p.body.id && Date.parse(w.start) >= effectiveAt)));
      assert.deepEqual(rows.filter((w: any) => w.covered).map((w: any) => [w.scheduleId, w.windowKey]), [[predId, expected.windowKey]]);
    });

    await test('PS-C15-THE-SUCCESSOR-LINK-IS-DURABLE-ONE-SUCCESSOR-UNDER-CONCURRENT-EDITS-AND-READS-NEED-NO-AUDIT', async () => {
      const s = await scenario('c15');
      const tok = await login(s.co.ownerEmail);
      const mk = async (name: string, extra: Record<string, unknown> = {}) => {
        const r = await api('POST', '/patrols/schedules', tok, { siteId: s.site, name, activeFrom: '08:00', activeTo: '20:00', frequencyMinutes: 60, ...extra });
        expect(r, 201, undefined, name);
        return r.body.id as number;
      };
      // Concurrent timing edits of the same schedule: one successor, the other edit gets a clean 409.
      const a = await mk('Concurrent');
      const results = await Promise.all([
        api('PATCH', `/patrols/schedules/${a}`, tok, { frequencyMinutes: 30 }),
        api('PATCH', `/patrols/schedules/${a}`, tok, { frequencyMinutes: 120 }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], JSON.stringify(results.map((r) => r.body)));
      const refused = results.find((r) => r.status === 409)!;
      assert.equal(refused.body.code, 'PATROL_VALIDATION_FAILED');
      const winner = results.find((r) => r.status === 200)!.body;
      assert.equal(await count(`SELECT count(*) FROM patrol_schedules WHERE "companyId" = $1 AND name = 'Concurrent'`, [s.co.id]), 2, 'one successor, never two');
      assert.equal(Number((await one(`SELECT "supersededByScheduleId" FROM patrol_schedules WHERE id = $1`, [a])).supersededByScheduleId), winner.id);
      assert.equal(await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.schedule.superseded' AND "entityId" = $1`, [a]), 1);
      const again = await api('PATCH', `/patrols/schedules/${a}`, tok, { name: 'x' });
      assert.deepEqual([again.status, again.body.code, again.body.details?.supersededByScheduleId], [409, 'PATROL_VALIDATION_FAILED', winner.id], 'the replaced version is not editable');

      // A chain A → B → C: each link bounds its two versions, read from the columns.
      const b = winner.id;
      const c = (await api('PATCH', `/patrols/schedules/${b}`, tok, { activeTo: '21:00' })).body;
      assert.deepEqual([c.timingChanged, c.predecessorId], [true, b]);
      const bounds = await V.scheduleVersionBounds(ds, s.co.id);
      const rows = await q(`SELECT id, "supersededAt" FROM patrol_schedules WHERE id = ANY($1::int[]) ORDER BY id`, [[a, b]]);
      assert.deepEqual([bounds.get(a)!.successorId, bounds.get(b)!.predecessorId, bounds.get(b)!.successorId, bounds.get(c.id)!.predecessorId], [b, a, c.id, b]);
      assert.deepEqual([iso(bounds.get(b)!.effectiveFrom!), iso(bounds.get(b)!.effectiveUntil!)], rows.map((r: any) => iso(r.supersededAt)));

      // The reads never depend on audit_logs: with the audit entries gone (a test database only), the bounds are the same.
      await q(`DELETE FROM audit_logs WHERE "companyId" = $1 AND action = 'patrol.schedule.superseded'`, [s.co.id]);
      const afterAudit = await V.scheduleVersionBounds(ds, s.co.id);
      assert.deepEqual([...afterAudit.entries()].map(([k, v]) => [k, v.effectiveFrom?.toISOString() ?? null, v.effectiveUntil?.toISOString() ?? null]).sort(),
        [...bounds.entries()].map(([k, v]) => [k, v.effectiveFrom?.toISOString() ?? null, v.effectiveUntil?.toISOString() ?? null]).sort());

      // A paused schedule has no windows: its timing changes in place (no successor, no link).
      const paused = await mk('Paused', { active: false });
      const pp = await api('PATCH', `/patrols/schedules/${paused}`, tok, { frequencyMinutes: 30 });
      expect(pp, 200);
      assert.deepEqual([pp.body.id, pp.body.timingChanged, pp.body.predecessorId, pp.body.frequencyMinutes, pp.body.supersededByScheduleId], [paused, false, null, 30, null]);

      // The database refuses an invalid link whatever the service does.
      const other = await mkSite(s.co.id, 'c15 Other');
      const foreign = await mkSchedule(s.co.id, other, { from: '08:00', to: '12:00', freq: 60 });
      const loose = await mkSchedule(s.co.id, s.site, { from: '08:00', to: '12:00', freq: 60 });
      const link = (id: number, to: number, archived = true) =>
        q(`UPDATE patrol_schedules SET active = false, "archivedAt" = ${archived ? 'now()' : 'NULL'}, "supersededByScheduleId" = $2, "supersededAt" = now() WHERE id = $1`, [id, to]);
      await assert.rejects(() => link(loose.id, loose.id), /CHK_patrol_schedules_superseded_not_self/, 'never itself');
      await assert.rejects(() => link(loose.id, foreign.id), /FK_patrol_schedules_superseded_by/, 'never another site');
      await assert.rejects(() => link(loose.id, c.id, false), /CHK_patrol_schedules_superseded_archived/, 'a replaced schedule is archived');
      await assert.rejects(() => link(loose.id, b), /UQ_patrol_schedules_superseded_by/, 'a successor replaces exactly one schedule');
      await assert.rejects(() => q(`UPDATE patrol_schedules SET "supersededAt" = NULL WHERE id = $1`, [a]), /CHK_patrol_schedules_superseded_pair/);
      await assert.rejects(() => q(`DELETE FROM patrol_schedules WHERE id = $1`, [b]), /FK_patrol_schedules_superseded_by/, 'a successor is never deleted from under its link');
    });

    await test('PS-C16-EXCEPTION-ACTIONS-ARE-AUDITED-THE-LIST-NAMES-WHO-ACTED-AND-A-RESOLVED-EXCEPTION-IS-FINAL', async () => {
      const s = await scenario('c16');
      const [g] = s.guards;
      await mkSchedule(s.co.id, s.site, { from: '08:00', to: '10:00', freq: 60 });
      const shift = await mkShift(s.co.id, s.site, g.id, day('05:00:00'), day('13:00:00'));
      await bookOn(shift, g.id, day('04:55:00'));
      await sweep(day('09:30:00'));
      const [a, b] = (await exceptionsOf(s.co.id)).filter((e: any) => e.type === 'patrol_missed');
      assert.ok(a?.safetyAlertId && b?.safetyAlertId, 'two missed windows, each with its Live Operations alert');
      await q(`UPDATE users SET "firstName" = 'Olive', "lastName" = 'Owner' WHERE id = $1`, [s.co.ownerId]);
      const tok = await login(s.co.ownerEmail);
      const viewerEmail = 'ps.c16.viewer@example.invalid';
      const viewerId = (await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
         VALUES ($1,$2,'company_admin','active',true,false,'Vic','Viewer') RETURNING id`, [viewerEmail, hash])).id;
      await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,'viewer','active')`, [viewerId, s.co.id]);
      const viewer = await login(viewerEmail);
      expect(await api('POST', `/patrols/exceptions/${a.id}/acknowledge`, viewer), 403, undefined, 'a Viewer cannot act');
      const auditCount = async (action: string, entityId: number) => count(`SELECT count(*) FROM audit_logs WHERE action = $1 AND "entityId" = $2`, [action, entityId]);

      // Acknowledge, then resolve, through the Patrols API: the alert's own lifecycle runs and both sides are audited.
      const ack = await api('POST', `/patrols/exceptions/${a.id}/acknowledge`, tok);
      expect(ack, 200);
      assert.equal(ack.body.status, 'acknowledged');
      assert.deepEqual([await auditCount('patrol.exception_acknowledged', Number(a.id)), await auditCount('safety_alert.acknowledged', Number(a.safetyAlertId))], [1, 1]);
      expect(await api('POST', `/patrols/exceptions/${b.id}/resolve`, tok, { resolutionReason: 'guard_contacted' }), 400, undefined, 'a note is required for this reason');
      expect(await api('POST', `/patrols/exceptions/${b.id}/resolve`, tok, { resolutionReason: 'patrol_completed_late_sync' }), 400, undefined, 'no late evidence: late sync is refused');
      expect(await api('POST', `/patrols/exceptions/${b.id}/resolve`, tok, { resolutionReason: 'guard_contacted', resolutionNote: 'x'.repeat(2001) }), 400, undefined, 'a note is at most 2000 characters');
      const res = await api('POST', `/patrols/exceptions/${a.id}/resolve`, tok, { resolutionReason: 'guard_contacted', resolutionNote: 'Guard rang in: gate blocked.' });
      expect(res, 200);
      assert.deepEqual([res.body.status, res.body.resolution], ['resolved', 'guard_contacted']);
      assert.deepEqual([await auditCount('patrol.exception_resolved', Number(a.id)), await auditCount('safety_alert.closed', Number(a.safetyAlertId))], [1, 1]);
      const alert = await one(`SELECT status, "resolutionReason" FROM safety_alerts WHERE id = $1`, [a.safetyAlertId]);
      assert.deepEqual([alert.status, alert.resolutionReason], ['closed', 'guard_contacted']);

      // The list says who acted and when — a display name only, never an email.
      const list = await api('GET', '/patrols/exceptions', viewer);
      expect(list, 200);
      const item = list.body.find((e: any) => e.id === Number(a.id));
      assert.deepEqual([item.status, item.resolution, item.acknowledgedByName, item.resolvedByName, Boolean(item.acknowledgedAt), Boolean(item.resolvedAt)],
        ['resolved', 'guard_contacted', 'Olive Owner', 'Olive Owner', true, true]);
      const other = list.body.find((e: any) => e.id === Number(b.id));
      assert.deepEqual([other.status, other.acknowledgedByName, other.resolvedByName], ['open', null, null]);
      assert.ok(!JSON.stringify(list.body).includes('@'), 'no email in the exceptions list');
      for (const key of ['id', 'siteId', 'runId', 'scheduleId', 'shiftId', 'windowKey', 'scopeKey', 'type', 'status', 'safetyAlertId', 'note', 'resolution',
        'resolvedAt', 'createdAt', 'guardId', 'windowStart', 'windowEnd', 'acknowledgedAt', 'lateEvidenceAt', 'annotations', 'reconciliationRunId', 'alertStatus', 'alertPriority']) {
        assert.ok(key in item, `existing field ${key} is still there`);
      }

      // A resolved exception is final: 409, and nothing about it (or its alert, or the audit trail) changes.
      const snapshot = async () => ({
        exception: await one(`SELECT md5(to_jsonb(x)::text) h FROM patrol_exceptions x WHERE id = $1`, [a.id]),
        alert: await one(`SELECT md5(to_jsonb(x)::text) h FROM safety_alerts x WHERE id = $1`, [a.safetyAlertId]),
        audits: await count(`SELECT count(*) FROM audit_logs WHERE "companyId" = $1`, [s.co.id]),
      });
      const before = await snapshot();
      expect(await api('POST', `/patrols/exceptions/${a.id}/resolve`, tok, { resolutionReason: 'other', resolutionNote: 'again' }), 409, 'PATROL_EXCEPTION_ALREADY_RESOLVED');
      expect(await api('POST', `/patrols/exceptions/${a.id}/acknowledge`, tok), 409, 'PATROL_EXCEPTION_ALREADY_RESOLVED');
      assert.deepEqual(await snapshot(), before, 'unchanged');

      // An exception without an alert is acted on directly, and audited as such.
      const quiet = await one(`INSERT INTO patrol_exceptions ("companyId","siteId","shiftId","windowKey","scopeKey",type,"windowStart","windowEnd")
         VALUES ($1,$2,$3,'c16-quiet','site','patrol_incomplete',$4,$5) RETURNING id`, [s.co.id, s.site, shift, day('08:00:00'), day('09:00:00')]);
      const direct = await api('POST', `/patrols/exceptions/${quiet.id}/resolve`, tok, { resolutionReason: 'patrol_completed_confirmed', resolutionNote: 'Supervisor walked it.' });
      expect(direct, 200);
      const audit = await one(`SELECT "afterData" FROM audit_logs WHERE action = 'patrol.exception_resolved' AND "entityId" = $1`, [quiet.id]);
      assert.deepEqual([audit.afterData.via, audit.afterData.resolution], ['patrols', 'patrol_completed_confirmed']);
    });

    await test('PS-C17-A-PAUSED-SCHEDULE-CHANGES-IN-PLACE-ONLY-WITHOUT-HISTORY', async () => {
      const s = await scenario('c17');
      const [g] = s.guards;
      const tok = await login(s.co.ownerEmail);
      const mk = async (name: string, active: boolean) => {
        const r = await api('POST', '/patrols/schedules', tok, { siteId: s.site, name, activeFrom: '08:00', activeTo: '20:00', frequencyMinutes: 60, active });
        expect(r, 201, undefined, name);
        return r.body.id as number;
      };
      const shift = await mkShift(s.co.id, s.site, g.id, day('05:00:00'), day('13:00:00'));
      const supersededAudit = (id: number) => count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.schedule.superseded' AND "entityId" = $1`, [id]);

      // Paused since creation, nothing names it: in place — same id, no successor, audited as an update.
      const clean = await mk('Never on', false);
      const inPlace = await api('PATCH', `/patrols/schedules/${clean}`, tok, { frequencyMinutes: 30 });
      expect(inPlace, 200);
      assert.deepEqual([inPlace.body.id, inPlace.body.timingChanged, inPlace.body.predecessorId, inPlace.body.frequencyMinutes, inPlace.body.active],
        [clean, false, null, 30, false]);
      assert.deepEqual([await count(`SELECT count(*) FROM audit_logs WHERE action = 'patrol.schedule.updated' AND "entityId" = $1`, [clean]), await supersededAudit(clean)], [1, 0]);

      // Paused, with a historical run: a successor (new id, linked, audited), and it stays paused.
      const withRun = await mk('Had a run', true);
      await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, scheduleId: withRun, status: 'completed', startedAt: day('07:05:00'), completedAt: day('07:20:00') });
      expect(await api('PATCH', `/patrols/schedules/${withRun}`, tok, { active: false }), 200, undefined, 'pausing is in place');
      const r1 = await api('PATCH', `/patrols/schedules/${withRun}`, tok, { frequencyMinutes: 30 });
      expect(r1, 200);
      assert.deepEqual([r1.body.timingChanged, r1.body.predecessorId, r1.body.active, r1.body.frequencyMinutes], [true, withRun, false, 30], 'the successor stays paused');
      assert.notEqual(r1.body.id, withRun);
      assert.equal(Number((await one(`SELECT "supersededByScheduleId" FROM patrol_schedules WHERE id = $1`, [withRun])).supersededByScheduleId), r1.body.id);
      assert.equal(await supersededAudit(withRun), 1);
      assert.equal(Number((await one(`SELECT "scheduleId" FROM patrol_runs WHERE "companyId" = $1 AND "scheduleId" = $2`, [s.co.id, withRun])).scheduleId), withRun, 'the run keeps its version');

      // Paused since creation, only a RESOLVED exception names it: a successor too (any status counts).
      const withException = await mk('Had an exception', false);
      await q(`INSERT INTO patrol_exceptions ("companyId","siteId","scheduleId","shiftId","windowKey","scopeKey",type,status,resolution,"resolvedAt","windowStart","windowEnd")
         VALUES ($1,$2,$3,$4,'c17-exc','site','patrol_missed','resolved','patrol_not_required',now(),$5,$6)`, [s.co.id, s.site, withException, shift, day('08:00:00'), day('09:00:00')]);
      const r2 = await api('PATCH', `/patrols/schedules/${withException}`, tok, { activeTo: '21:00' });
      expect(r2, 200);
      assert.deepEqual([r2.body.timingChanged, r2.body.predecessorId, r2.body.active], [true, withException, false]);

      // Switched on at some point (it may have had windows), now paused, nothing names it: a successor (conservative).
      const wasOn = await mk('Was on', true);
      expect(await api('PATCH', `/patrols/schedules/${wasOn}`, tok, { active: false }), 200);
      const r3 = await api('PATCH', `/patrols/schedules/${wasOn}`, tok, { activeFrom: '09:00' });
      assert.deepEqual([r3.status, r3.body.timingChanged, r3.body.predecessorId], [200, true, wasOn]);
      // No audit trail at all (cannot prove it never had a window): a successor.
      const unaudited = await mkSchedule(s.co.id, s.site, { name: 'Unaudited', from: '08:00', to: '12:00', freq: 60 });
      await q(`UPDATE patrol_schedules SET active = false WHERE id = $1`, [unaudited.id]);
      const r4 = await api('PATCH', `/patrols/schedules/${unaudited.id}`, tok, { frequencyMinutes: 30 });
      assert.deepEqual([r4.status, r4.body.timingChanged, r4.body.predecessorId], [200, true, Number(unaudited.id)]);
      // A paused successor is itself history-bearing: its next timing change is a successor again (a chain).
      const r5 = await api('PATCH', `/patrols/schedules/${r4.body.id}`, tok, { frequencyMinutes: 120 });
      assert.deepEqual([r5.status, r5.body.timingChanged, r5.body.predecessorId, r5.body.active], [200, true, r4.body.id, false]);

      // Paused with history, two timing edits at once: one successor, the other a clean 409.
      const busy = await mk('Concurrent paused', true);
      await insRun({ companyId: s.co.id, siteId: s.site, shiftId: shift, guard: g, scheduleId: busy, status: 'completed', startedAt: day('08:05:00'), completedAt: day('08:20:00') });
      expect(await api('PATCH', `/patrols/schedules/${busy}`, tok, { active: false }), 200);
      const both = await Promise.all([
        api('PATCH', `/patrols/schedules/${busy}`, tok, { frequencyMinutes: 30 }),
        api('PATCH', `/patrols/schedules/${busy}`, tok, { frequencyMinutes: 120 }),
      ]);
      assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], JSON.stringify(both.map((r) => r.body)));
      assert.equal(both.find((r) => r.status === 409)!.body.code, 'PATROL_VALIDATION_FAILED');
      assert.equal(await supersededAudit(busy), 1, 'exactly one successor');
      assert.equal(await count(`SELECT count(*) FROM patrol_schedules WHERE "companyId" = $1 AND name = 'Concurrent paused'`, [s.co.id]), 2);

      // Active schedules are unchanged: a timing change is always a successor.
      const active = await mk('Active', true);
      const r6 = await api('PATCH', `/patrols/schedules/${active}`, tok, { frequencyMinutes: 30 });
      assert.deepEqual([r6.status, r6.body.timingChanged, r6.body.predecessorId, r6.body.active], [200, true, active, true]);
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
