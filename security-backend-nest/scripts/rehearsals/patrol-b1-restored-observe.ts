/**
 * S4 1.3.0 B1 rollback rehearsal on a RESTORED backup — step 2, run with EITHER backend (the 1.2.1 code, 5d749fa, or B1)
 * against the database step 1 (patrol-b1-restored-setup.ts) left at Migration 74. Runs no migration. Uses only API routes
 * that 1.2.1 has. Prints ids, counts and booleans only.
 *
 *   the Guard's plan for the rehearsal shift: any "route required" warning, the route of each window, shift windows;
 *   a NEW patrol started from the plan's open window (as the app does) — no 422 PATROL_ROUTE_NOT_FOR_SITE;
 *   the windows due today at the site; the company's schedule list warnings;
 *   every pre-existing (restored) row compared with its fingerprint from before Migration 74 (expected: unchanged).
 *
 * Usage: RESTORED_DATABASE_URL=… REHEARSAL_STATE_FILE=…/state.json ts-node -r tsconfig-paths/register scripts/rehearsals/patrol-b1-restored-observe.ts
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
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
  'PATROL_EVIDENCE_STORAGE_ENDPOINT', 'PATROL_QR_SIGNING_KEY']) delete process.env[k];

async function main() {
  const fs = require('node:fs');
  const state = JSON.parse(fs.readFileSync(stateFile!, 'utf8'));
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
  const api = async (method: string, p: string, tok: string, body?: unknown) => {
    const res = await fetch(baseUrl + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };
  const owner = ((await auth.login({ email: state.ownerEmail, password: state.password } as never)) as any).accessToken as string;
  const guard = ((await auth.login({ email: state.guardEmail, password: state.password } as never)) as any).accessToken as string;

  const out: Record<string, unknown> = {};
  const plan = (await api('GET', `/patrols/mine/plan?shiftId=${state.shiftId}`, guard)).body;
  const ours = plan.windows.filter((w: any) => w.scheduleId === state.scheduleId);
  const now = Date.now();
  const open = ours.find((w: any) => !w.covered && new Date(w.start).getTime() <= now && now < new Date(w.end).getTime());
  out.plan = {
    routeRequiredWarningForSchedule: plan.configurationWarnings.some((w: any) => w.code === 'QR_ROUTE_REQUIRED' && w.scheduleId === state.scheduleId),
    windowRouteIds: [...new Set(ours.map((w: any) => w.routeId))],
    windowRoutesInPlan: ours.every((w: any) => w.routeId == null || plan.routes.some((r: any) => r.id === w.routeId)),
    shiftScheduleWindows: plan.windows.filter((w: any) => w.scheduleId === state.shiftScheduleId).length,
    openWindowRouteId: open?.routeId ?? null,
  };
  const started = await api('POST', '/patrols/runs', guard, {
    shiftId: state.shiftId, clientRunId: `b1-observe-${Date.now().toString(36)}`, scheduleId: open?.scheduleId, routeId: open?.routeId ?? undefined, startedAtDevice: new Date(now).toISOString(),
  });
  out.newPatrol = { status: started.status, code: started.body?.code ?? null, routeId: started.body?.routeId ?? null, windowKey: started.body?.windowKey === open?.windowKey };
  if (started.status === 201) await api('POST', `/patrols/runs/${started.body.id}/complete`, guard, { completedAtDevice: new Date(now + 60_000).toISOString() });
  const run = (await api('GET', `/patrols/runs/${state.runId}`, owner)).body;
  out.historicalRun = { routeId: run?.run?.routeId ?? null, status: run?.run?.status ?? null };
  const day = (await api('GET', `/patrols/windows/day?siteId=${state.siteId}`, owner)).body;
  out.windowsDue = day?.windowsDue ?? null;
  const schedules = (await api('GET', `/patrols/schedules?siteId=${state.siteId}`, owner)).body as any[];
  out.scheduleList = schedules.map((s: any) => ({ id: s.id, rehearsal: s.id === state.scheduleId, routeId: s.routeId, warnings: (s.configurationWarnings ?? []).map((w: any) => w.code) }));
  // Every restored row against its fingerprint from before the migrations (and from the end of the setup step).
  const now2 = await snapshot(ds);
  out.restoredRowsSinceBackup = compare(state.before, now2);
  await app.close();
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exit(1);
});
