/**
 * S4 1.3.0 B1 rollback rehearsal on a RESTORED backup — step 1, run with the B1 code (never against production: the URL
 * must be 127.0.0.1 / localhost). Prints ids, counts and booleans only.
 *
 *   1. fingerprints every row (restored-db-snapshot.ts), migrates the database to 74, and proves no existing row changed;
 *   2. on site REHEARSAL_SITE_ID (default 15), with synthetic accounts only: a custom route, a clock schedule using it, a
 *      Guard's completed patrol on it; then a route edit (a successor version) — and checks that the schedule now names
 *      the new version while the patrol and its window still resolve to the version they had;
 *   3. a shift-patrol setup on the same site (a test-scanned checkpoint, every shift, QR), activated;
 *   4. writes REHEARSAL_STATE_FILE (ids of the synthetic rows + the fingerprints) for the observe step, and reports which
 *      pre-existing rows changed (expected: none).
 *
 * Usage: RESTORED_DATABASE_URL=… REHEARSAL_STATE_FILE=…/state.json ts-node -r tsconfig-paths/register scripts/rehearsals/patrol-b1-restored-setup.ts
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { compare, snapshot } from './restored-db-snapshot';

const url = process.env.RESTORED_DATABASE_URL;
const stateFile = process.env.REHEARSAL_STATE_FILE;
if (!url || !stateFile) throw new Error('RESTORED_DATABASE_URL and REHEARSAL_STATE_FILE are required');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Refusing: the restored database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-b1-restored-rehearsal-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
for (const k of ['RESEND_API_KEY', 'EXPO_ACCESS_TOKEN', 'PUSH_WELFARE_REMINDERS_ENABLED', 'PUSH_GUARD_NOTIFICATIONS_ENABLED', 'PATROL_QR_PREVIOUS_SIGNING_KEY',
  'PATROL_EVIDENCE_STORAGE_ENDPOINT']) delete process.env[k];
process.env.PATROL_QR_SIGNING_KEY = 'patrol-b1-restored-rehearsal-signing-key-0001';
process.env.PATROL_QR_SIGNING_KEY_ID = 'r1';
export const REHEARSAL_PASSWORD = 'patrol-b1-restored-rehearsal-password-1';
const SITE_ID = Number(process.env.REHEARSAL_SITE_ID ?? 15);

async function main() {
  const path = require('node:path');
  const fs = require('node:fs');
  const out: Record<string, unknown> = { siteId: SITE_ID };
  const raw = new DataSource({ type: 'postgres', url, entities: [], synchronize: false } as never);
  await raw.initialize();
  const before = await snapshot(raw);
  out.migrationsBefore = Number((await raw.query(`SELECT count(*)::int n FROM typeorm_migrations`))[0].n);
  await raw.destroy();

  const migrationsDir = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
  const { buildTypeOrmOptions } = await import('../../src/database/typeorm.config');
  const base = buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' });
  const migrate = new DataSource({ ...base, entities: [], migrations: fs.readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).map((f: string) => path.join(migrationsDir, f)) } as never);
  await migrate.initialize();
  out.migrationsApplied = (await migrate.runMigrations({ transaction: 'each' })).map((m) => m.name);
  const afterMigration = await snapshot(migrate);
  out.migrationChangedExistingRows = compare(before, afterMigration);
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
  app.get(PatrolSweepService).onModuleDestroy();
  app.get(SafetyAlertService).onModuleDestroy();
  const auth = app.get(AuthService);
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const api = async (method: string, p: string, tok: string, body?: unknown) => {
    const res = await fetch(baseUrl + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (res.status >= 300) throw new Error(`${method} ${p} → ${res.status} ${json?.code ?? ''}`);
    return json;
  };

  // Synthetic accounts only (the restored users' passwords are never needed or touched).
  const [{ companyId }] = await q(`SELECT "companyId" FROM sites WHERE id = $1`, [SITE_ID]);
  const hash = await bcrypt.hash(REHEARSAL_PASSWORD, 4);
  const tag = Date.now().toString(36);
  const ownerEmail = `b1-rehearsal-owner-${tag}@example.invalid`;
  const guardEmail = `b1-rehearsal-guard-${tag}@example.invalid`;
  const ownerId = Number((await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName") VALUES ($1,$2,'company_admin','active',true,false,'Rehearsal','Owner') RETURNING id`, [ownerEmail, hash])).id);
  await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,'owner','active')`, [ownerId, companyId]);
  const guardUserId = Number((await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName") VALUES ($1,$2,'guard','active',true,false,'Rehearsal','Guard') RETURNING id`, [guardEmail, hash])).id);
  const guardId = Number((await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'Rehearsal Guard',$2,'07000000174') RETURNING id`, [guardUserId, `17${Date.now()}`.padEnd(16, '0').slice(0, 16)])).id);
  const now = Date.now();
  const shiftId = Number((await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Rehearsal',$3,'in_progress',$4,$5) RETURNING id`,
    [companyId, SITE_ID, guardId, new Date(now - 3 * 3_600_000), new Date(now + 5 * 3_600_000)])).id);
  await q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-in',$3,$3,false)`, [shiftId, guardId, new Date(now - 3 * 3_600_000)]);
  const owner = ((await auth.login({ email: ownerEmail, password: REHEARSAL_PASSWORD } as never)) as any).accessToken as string;
  const guard = ((await auth.login({ email: guardEmail, password: REHEARSAL_PASSWORD } as never)) as any).accessToken as string;

  // 2. A custom route, a clock schedule on it, a patrol, then a route edit.
  const c1 = await api('POST', '/patrols/checkpoints', owner, { siteId: SITE_ID, label: 'Rehearsal gate 1' });
  const c2 = await api('POST', '/patrols/checkpoints', owner, { siteId: SITE_ID, label: 'Rehearsal gate 2' });
  const r1 = await api('POST', '/patrols/routes', owner, { siteId: SITE_ID, name: 'Rehearsal perimeter', checkpoints: [{ checkpointId: c1.id }] });
  const schedule = await api('POST', '/patrols/schedules', owner, { siteId: SITE_ID, name: 'Rehearsal hourly', activeFrom: '00:00', activeTo: '00:00', frequencyMinutes: 60, routeId: r1.id });
  const historicalAt = new Date(now - 2 * 3_600_000 + 5 * 60_000);
  const run = await api('POST', '/patrols/runs', guard, { shiftId, clientRunId: `b1-rehearsal-${tag}-1`, scheduleId: schedule.id, routeId: r1.id, startedAtDevice: historicalAt.toISOString() });
  await api('POST', `/patrols/runs/${run.id}/visits`, guard, { clientVisitId: `b1-rehearsal-${tag}-v1`, scanPayload: (await api('GET', `/patrols/checkpoints/${c1.id}/label`, owner)).payload, scannedAtDevice: new Date(historicalAt.getTime() + 60_000).toISOString() });
  await api('POST', `/patrols/runs/${run.id}/complete`, guard, { completedAtDevice: new Date(historicalAt.getTime() + 120_000).toISOString() });
  const r2 = await api('PATCH', `/patrols/routes/${r1.id}`, owner, { checkpoints: [{ checkpointId: c1.id }, { checkpointId: c2.id }] });
  const sched = await one(`SELECT "routeId", "updatedAt", "supersededByScheduleId" FROM patrol_schedules WHERE id = $1`, [schedule.id]);
  const plan = await api('GET', `/patrols/mine/plan?shiftId=${shiftId}`, guard);
  const ours = plan.windows.filter((w: any) => w.scheduleId === schedule.id);
  const historicalWindow = ours.find((w: any) => w.windowKey === run.windowKey);
  // The window open now started BEFORE the edit (it owes version 1); the next one starts after it (version 2).
  const current = ours.find((w: any) => new Date(w.start).getTime() > Date.now());
  out.routeVersioning = {
    r1: r1.id, r2: r2.id, versioned: r2.versioned === true,
    scheduleNamesCurrentVersion: Number(sched.routeId) === r2.id,
    scheduleNotSuperseded: sched.supersededByScheduleId == null,
    historicalRunRouteId: Number((await one(`SELECT "routeId" FROM patrol_runs WHERE id = $1`, [run.id])).routeId),
    historicalWindowRouteId: historicalWindow?.routeId ?? null,
    openWindowRouteId: ours.find((w: any) => new Date(w.start).getTime() <= Date.now() && Date.now() < new Date(w.end).getTime())?.routeId ?? null,
    nextWindowRouteId: current?.routeId ?? null,
    planWarningsForSchedule: plan.configurationWarnings.filter((w: any) => w.scheduleId === schedule.id).map((w: any) => w.code),
    schedulesNamingAReplacedRoute: Number((await one(`SELECT count(*)::int n FROM patrol_schedules s JOIN patrol_routes r ON r.id = s."routeId" WHERE r."supersededByRouteId" IS NOT NULL`)).n),
  };
  assert.equal(Number(sched.routeId), r2.id);
  assert.equal(historicalWindow?.routeId, r1.id, 'the historical window still resolves to the version in force at its start');
  assert.equal(current?.routeId, r2.id);

  // 3. Shift patrols on the same site, activated (B1).
  await api('POST', `/patrols/checkpoints/${c1.id}/confirm`, owner, { scanPayload: (await api('GET', `/patrols/checkpoints/${c1.id}/label`, owner)).payload });
  await api('PUT', `/patrols/sites/${SITE_ID}/setup`, owner, { setupMode: 'every_shift', evidenceMode: 'qr', frequencyMinutes: 60 });
  const activated = await api('POST', `/patrols/sites/${SITE_ID}/setup/confirm`, owner);
  const b1Plan = await api('GET', `/patrols/mine/plan?shiftId=${shiftId}`, guard);
  out.shiftSetup = {
    active: activated.active === true, shiftScheduleId: activated.schedule?.id ?? null,
    b1ShiftWindows: b1Plan.windows.filter((w: any) => w.anchor === 'shift').length,
  };

  const afterSetup = await snapshot(ds);
  out.setupChangedExistingRows = compare(afterMigration, afterSetup);
  fs.writeFileSync(stateFile!, JSON.stringify({
    ownerEmail, guardEmail, password: REHEARSAL_PASSWORD, siteId: SITE_ID, shiftId, scheduleId: schedule.id, r1: r1.id, r2: r2.id, runId: run.id,
    shiftScheduleId: activated.schedule?.id ?? null, before, afterSetup,
  }));
  await app.close();
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exit(1);
});
