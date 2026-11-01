/**
 * S4 1.3.0 B1 compatibility rehearsal (not part of test:release: it is run by hand against TWO code bases).
 *
 * The same scenario — seeded with plain SQL, read through the HTTP API and judged by the sweep on a fixed clock — is run
 * with the B1 code AND with the 1.2.1 code (5d749fa, with Migration 74's file copied into its migrations folder so its
 * database is at 74). It prints one JSON document of what a user and the sweep see; the two documents are compared.
 *
 *   pilot     pilot-shaped data: a QR site, a never-confirmed checkpoint, a clock schedule replaced by a timing change
 *             (Migration 73 successor), a completed run flagged qr_rule_missing — plan windows, warnings, the windows-due
 *             count, missed exceptions and the run's verification must be IDENTICAL under both codes  (compatibility c)
 *   setup     data only 1.3.0 writes (when the columns exist): an active every-shift setup, its shift-anchored schedule
 *             (current + superseded), automatic route versions, a confirmed checkpoint, a shift marked required — the
 *             1.2.1 code must show no shift window, count none and raise nothing for it                 (compatibility b)
 *   routes    a custom route versioned by 1.3.0 (archived + linked) that a clock schedule still names, and a run that
 *             names the replaced version — what the 1.2.1 code does with it, before and after the documented repoint
 *
 * Usage (disposable local database): COMPAT_SCENARIO_DATABASE_URL=postgresql://…/s4_compat_scenario \
 *   ts-node -r tsconfig-paths/register scripts/rehearsals/patrol-b1-compat-scenario.ts > out.json
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

const url = process.env.COMPAT_SCENARIO_DATABASE_URL;
if (!url) throw new Error('COMPAT_SCENARIO_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('The rehearsal database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-b1-compat-rehearsal-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
for (const k of ['RESEND_API_KEY', 'EXPO_ACCESS_TOKEN', 'PUSH_WELFARE_REMINDERS_ENABLED', 'PUSH_GUARD_NOTIFICATIONS_ENABLED', 'PATROL_QR_SIGNING_KEY',
  'PATROL_QR_PREVIOUS_SIGNING_KEY', 'PATROL_EVIDENCE_STORAGE_ENDPOINT']) delete process.env[k];
const PASSWORD = 'patrol-b1-compat-rehearsal-password-1';

async function main() {
  const path = require('node:path');
  const fs = require('node:fs');
  const migrationsDir = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
  const allFiles: string[] = fs.readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).sort();
  const { buildTypeOrmOptions } = await import('../../src/database/typeorm.config');
  const base = buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' });
  const migrate = new DataSource({ ...base, entities: [], migrations: allFiles.map((f) => path.join(migrationsDir, f)), dropSchema: true } as never);
  await migrate.initialize();
  const migrated = await migrate.runMigrations({ transaction: 'each' });
  await migrate.destroy();

  const { AppModule } = await import('../../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const ds = app.get(DataSource);
  const { PatrolSweepService } = await import('../../src/patrol/patrol-sweep.service');
  const { SafetyAlertService } = await import('../../src/safety-alert/safety-alert.service');
  const { AuthService } = await import('../../src/auth/auth.service');
  const sweeper = app.get(PatrolSweepService);
  sweeper.onModuleDestroy();
  app.get(SafetyAlertService).onModuleDestroy();
  const auth = app.get(AuthService);
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const api = async (method: string, p: string, tok: string, body?: unknown) => {
    const res = await fetch(baseUrl + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };
  const has = async (table: string, column: string) => (await q(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, column])).length > 0;
  const m74 = await has('patrol_schedules', 'anchor');

  // ── Seed (identical under both codes; ids are deterministic on a fresh database) ──
  const hash = await bcrypt.hash(PASSWORD, 4);
  const user = async (email: string, role: string) => Number((await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
    VALUES ($1,$2,$3,'active',true,false,$4,'R') RETURNING id`, [email, hash, role, email.split('@')[0]])).id);
  const ownerId = await user('compat.owner@example.invalid', 'company_admin');
  const co = Number((await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,'Compat Ltd','74999999','1 Way','o@example.invalid',true) RETURNING id`, [ownerId])).id);
  const guardUser = await user('compat.guard@example.invalid', 'guard');
  const guard = Number((await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'Compat Guard','7499999999999999','07999999999') RETURNING id`, [guardUser])).id);
  const site = async (name: string) => Number((await one(`INSERT INTO sites ("companyId",name,address,timezone) VALUES ($1,$2,'2 Way','Europe/London') RETURNING id`, [co, name])).id);
  const shift = async (siteId: number, start: string, end: string) => {
    const id = Number((await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'x',$3,'in_progress',$4,$5) RETURNING id`, [co, siteId, guard, start, end])).id);
    await q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-in',$3,$3,false)`, [id, guard, start]);
    return id;
  };
  const schedule = async (siteId: number, name: string, freq: number, routeId: number | null, extra: Record<string, unknown> = {}) => Number((await one(
    `INSERT INTO patrol_schedules ("companyId","siteId","routeId",name,"daysOfWeek","activeFrom","activeTo","frequencyMinutes","windowMinutes",active,"archivedAt","startsOn","endsOn","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'[1,2,3,4,5,6,7]'::jsonb,$5,$6,$7,$7,$8,$9,$10,$10,'2026-01-01','2026-01-01') RETURNING id`,
    [co, siteId, routeId, name, extra.from ?? '08:00', extra.to ?? '20:00', freq, extra.active ?? true, extra.archivedAt ?? null, extra.inertDate ?? null])).id);
  const checkpoint = async (siteId: number, label: string) => Number((await one(`INSERT INTO patrol_checkpoints ("companyId","siteId","publicId",label) VALUES ($1,$2,md5($3),$3) RETURNING id`, [co, siteId, `${siteId}-${label}`])).id);
  const route = async (siteId: number, name: string, cps: number[], archived = false) => {
    const id = Number((await one(`INSERT INTO patrol_routes ("companyId","siteId",name,active,"archivedAt") VALUES ($1,$2,$3,$4,$5) RETURNING id`, [co, siteId, name, !archived, archived ? '2026-11-21T12:00:00Z' : null])).id);
    for (const [i, cp] of cps.entries()) await q(`INSERT INTO patrol_route_checkpoints ("companyId","siteId","routeId","checkpointId",position) VALUES ($1,$2,$3,$4,$5)`, [co, siteId, id, cp, i + 1]);
    return id;
  };

  // pilot: QR policy, an unconfirmed checkpoint, v1 → v2 at 12:30 (Migration 73), a completed qr_rule_missing run on v1.
  const pilot = await site('Pilot Gate');
  await q(`INSERT INTO patrol_policies ("companyId","siteId",methods) VALUES ($1,$2,'["qr"]'::jsonb)`, [co, pilot]);
  const pilotCp = await checkpoint(pilot, 'Front gate');
  const v1 = await schedule(pilot, 'Hourly', 60, null, { active: false, archivedAt: '2026-11-21T12:30:00Z' });
  const v2 = await schedule(pilot, 'Hourly', 120, null);
  await q(`UPDATE patrol_schedules SET "supersededByScheduleId" = $2, "supersededAt" = '2026-11-21T12:30:00Z' WHERE id = $1`, [v1, v2]);
  await q(`UPDATE patrol_schedules SET "createdAt" = '2026-11-21T12:30:00Z', "updatedAt" = '2026-11-21T12:30:00Z' WHERE id = $1`, [v2]);
  const pilotShift = await shift(pilot, '2026-11-21T08:00:00Z', '2026-11-21T20:00:00Z');
  const pilotRun = Number((await one(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","scheduleId","windowKey","windowStart","windowEnd","startedAtDevice","startedAtServer",
      status,"completedAtDevice","completedAtServer","clientRunId","syncFlags","needsReview")
    VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-11-21T09:00:00Z','2026-11-21T10:00:00Z','2026-11-21T09:10:00Z','2026-11-21T09:10:00Z','completed','2026-11-21T09:20:00Z','2026-11-21T09:20:00Z','compat-run-0001','["qr_rule_missing"]'::jsonb,true) RETURNING id`,
    [co, pilot, pilotShift, guard, guardUser, v1, `s${v1}:2026-11-21:1`])).id);
  await q(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","checkpointId","scannedPublicId",result,"scannedAtDevice","clientVisitId") VALUES ($1,$2,$3,md5($4),'unverified','2026-11-21T09:12:00Z','compat-visit-0001')`,
    [co, pilotRun, pilotCp, `${pilot}-Front gate`]);

  // setup (1.3.0 data, only when the columns exist): exactly as PatrolSetupService writes it.
  const setupSite = await site('Setup Yard');
  const setupCp = await checkpoint(setupSite, 'Yard gate');
  const setupShift = await shift(setupSite, '2026-11-21T08:00:00Z', '2026-11-21T20:00:00Z');
  let shiftSchedules: number[] = [];
  if (m74) {
    await q(`INSERT INTO patrol_policies ("companyId","siteId",methods,"setupMode","windowAnchor","setupConfirmedAt","setupConfirmedByUserId") VALUES ($1,$2,'["qr"]'::jsonb,'every_shift','scheduled_start','2026-01-01',$3)`, [co, setupSite, ownerId]);
    await q(`UPDATE patrol_checkpoints SET "confirmedAt" = '2026-01-01', "confirmedByUserId" = $2, "confirmedTokenVersion" = 1 WHERE id = $1`, [setupCp, ownerId]);
    const a1 = await route(setupSite, 'All confirmed checkpoints', [], true);
    const a2 = await route(setupSite, 'All confirmed checkpoints', [setupCp]);
    await q(`UPDATE patrol_routes SET kind = 'auto' WHERE id = ANY($1::int[])`, [[a1, a2]]);
    await q(`UPDATE patrol_routes SET "supersededByRouteId" = $2, "supersededAt" = '2026-11-21T12:00:00Z' WHERE id = $1`, [a1, a2]);
    const sh1 = await schedule(setupSite, 'Shift patrol', 60, a1, { from: '00:00', to: '00:00', active: false, archivedAt: '2026-11-21T13:00:00Z', inertDate: '2000-01-01' });
    const sh2 = await schedule(setupSite, 'Shift patrol', 30, a1, { from: '00:00', to: '00:00', active: false, inertDate: '2000-01-01' });
    await q(`UPDATE patrol_schedules SET anchor = 'shift' WHERE id = ANY($1::int[])`, [[sh1, sh2]]);
    await q(`UPDATE patrol_schedules SET "supersededByScheduleId" = $2, "supersededAt" = '2026-11-21T13:00:00Z' WHERE id = $1`, [sh1, sh2]);
    await q(`UPDATE shifts SET "patrolRequirement" = 'required' WHERE id = $1`, [setupShift]);
    shiftSchedules = [sh1, sh2];
  }

  // routes: a custom route versioned by 1.3.0 (R1 archived → R2) that a clock schedule still names; a run on R1.
  const routesSite = await site('Routes Quay');
  await q(`INSERT INTO patrol_policies ("companyId","siteId",methods) VALUES ($1,$2,'["qr"]'::jsonb)`, [co, routesSite]);
  const rc1 = await checkpoint(routesSite, 'R gate 1');
  const rc2 = await checkpoint(routesSite, 'R gate 2');
  const r1 = await route(routesSite, 'Perimeter', [rc1], true);
  const r2 = await route(routesSite, 'Perimeter', [rc1, rc2]);
  if (m74) await q(`UPDATE patrol_routes SET "supersededByRouteId" = $2, "supersededAt" = '2026-11-21T12:00:00Z' WHERE id = $1`, [r1, r2]);
  const routeSchedule = await schedule(routesSite, 'Perimeter hourly', 60, r1);
  const routesShift = await shift(routesSite, '2026-11-21T08:00:00Z', '2026-11-21T20:00:00Z');
  const oldRouteRun = Number((await one(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","scheduleId","routeId","windowKey","windowStart","windowEnd","startedAtDevice","startedAtServer",
      status,"completedAtDevice","completedAtServer","clientRunId")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'2026-11-21T10:00:00Z','2026-11-21T11:00:00Z','2026-11-21T10:05:00Z','2026-11-21T10:05:00Z','completed','2026-11-21T10:20:00Z','2026-11-21T10:20:00Z','compat-run-0002') RETURNING id`,
    [co, routesSite, routesShift, guard, guardUser, routeSchedule, r1, `s${routeSchedule}:2026-11-21:2`])).id);
  await q(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","checkpointId","scannedPublicId",result,"scannedAtDevice","clientVisitId") VALUES ($1,$2,$3,md5($4),'verified','2026-11-21T10:10:00Z','compat-visit-0002')`,
    [co, oldRouteRun, rc1, `${routesSite}-R gate 1`]);

  const owner = ((await auth.login({ email: 'compat.owner@example.invalid', password: PASSWORD } as never)) as any).accessToken as string;
  const guardTok = ((await auth.login({ email: 'compat.guard@example.invalid', password: PASSWORD } as never)) as any).accessToken as string;

  // ── Observe ──
  const planOf = async (shiftId: number) => {
    const r = await api('GET', `/patrols/mine/plan?shiftId=${shiftId}`, guardTok);
    return {
      status: r.status,
      schedules: (r.body?.schedules ?? []).map((s: any) => ({ id: s.id, routeId: s.routeId, frequencyMinutes: s.frequencyMinutes })),
      windows: (r.body?.windows ?? []).map((w: any) => ({ windowKey: w.windowKey, scheduleId: w.scheduleId, routeId: w.routeId, start: w.start, end: w.end, covered: w.covered })),
      routes: (r.body?.routes ?? []).map((x: any) => ({ id: x.id, checkpoints: x.checkpoints.map((c: any) => [c.label, c.required]) })),
      warnings: (r.body?.configurationWarnings ?? []).map((w: any) => [w.code, w.scheduleId]),
    };
  };
  const dayOf = async (siteId: number) => {
    const r = await api('GET', `/patrols/windows/day?siteId=${siteId}&date=2026-11-21`, owner);
    return { status: r.status, due: r.body?.windowsDue, completed: r.body?.windowsCompleted, outstanding: r.body?.windowsOutstanding };
  };
  const exceptionsOf = async (siteId: number) => (await q(`SELECT "scheduleId", "windowKey", "scopeKey", type, "windowStart" FROM patrol_exceptions WHERE "siteId" = $1 ORDER BY "windowStart", type, "windowKey"`, [siteId]))
    .map((e: any) => [e.type, e.windowKey, e.scopeKey, new Date(e.windowStart ?? 0).toISOString()]);
  const runOf = async (runId: number) => {
    const r = await one(`SELECT status, "verificationStatus", "syncFlags", "needsReview", "routeId" FROM patrol_runs WHERE id = $1`, [runId]);
    return { status: r.status, verificationStatus: r.verificationStatus, syncFlags: r.syncFlags, needsReview: r.needsReview, routeId: r.routeId };
  };

  const out: any = { migrations: migrated.length, lastMigration: migrated[migrated.length - 1]?.name, m74Columns: m74 };
  out.before = {
    pilotPlan: await planOf(pilotShift), pilotDay: await dayOf(pilot),
    setupPlan: await planOf(setupShift), setupDay: await dayOf(setupSite),
    routesPlan: await planOf(routesShift), routesDay: await dayOf(routesSite),
    schedulesList: (await api('GET', '/patrols/schedules?includeInactive=true', owner)).body.map((s: any) => [s.id, s.name, s.active, s.archivedAt != null, s.configurationWarnings?.map((w: any) => w.code) ?? []]),
    routesList: (await api('GET', `/patrols/routes?siteId=${routesSite}`, owner)).body.map((r: any) => [r.id, r.name, r.checkpoints?.length]),
  };
  await sweeper.sweep(new Date('2026-11-21T13:00:00Z'));
  await sweeper.sweep(new Date('2026-11-21T21:30:00Z'));
  out.after = {
    pilotExceptions: await exceptionsOf(pilot), pilotRun: await runOf(pilotRun),
    setupExceptions: await exceptionsOf(setupSite), shiftScheduleExceptions: shiftSchedules.length
      ? Number((await one(`SELECT count(*)::int n FROM patrol_exceptions WHERE "scheduleId" = ANY($1::int[])`, [shiftSchedules])).n) : 0,
    routesExceptions: await exceptionsOf(routesSite), oldRouteRun: await runOf(oldRouteRun),
  };
  // A new patrol on the routes site, as the app would start it from the plan (window routeId), at 14:05.
  const startFromPlan = async () => {
    const plan = await planOf(routesShift);
    const w = plan.windows.find((x: any) => x.start === '2026-11-21T14:00:00.000Z');
    const r = await api('POST', '/patrols/runs', guardTok, { shiftId: routesShift, clientRunId: `compat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, scheduleId: w?.scheduleId, routeId: w?.routeId ?? undefined, startedAtDevice: '2026-11-21T14:05:00Z' });
    if (r.status === 201) await api('POST', `/patrols/runs/${r.body.id}/complete`, guardTok, { completedAtDevice: '2026-11-21T14:06:00Z' });
    return { windowRouteId: w?.routeId ?? null, status: r.status, code: r.body?.code ?? null, routeId: r.body?.routeId ?? null };
  };
  out.routesStart = await startFromPlan();
  // The documented rollback repoint (docs/patrols/P1-follow-ups.md §6): a clock schedule names the newest version.
  await q(`WITH RECURSIVE chain AS (
      SELECT s.id AS "scheduleId", s."routeId" AS "routeId", 0 AS depth FROM patrol_schedules s WHERE s."routeId" IS NOT NULL
      UNION ALL SELECT c."scheduleId", r."supersededByRouteId", c.depth + 1 FROM chain c JOIN patrol_routes r ON r.id = c."routeId" WHERE r."supersededByRouteId" IS NOT NULL AND c.depth < 1000)
    UPDATE patrol_schedules s SET "routeId" = h."routeId" FROM (SELECT DISTINCT ON ("scheduleId") "scheduleId", "routeId" FROM chain ORDER BY "scheduleId", depth DESC) h
     WHERE s.id = h."scheduleId" AND s."routeId" IS DISTINCT FROM h."routeId" AND s.anchor = 'clock'`).catch((e: any) => { out.repointError = String(e?.message ?? e); });
  out.routesStartAfterRepoint = await startFromPlan();
  out.routesPlanAfterRepoint = (await planOf(routesShift)).warnings;
  await app.close();
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
