/**
 * Pool load reproduction (diagnostic tool, LOCAL ONLY).
 *
 * Boots the real application with the production pool settings (buildTypeOrmOptions: max 10,
 * connectionTimeoutMillis 10000, idleTimeoutMillis 30000) and pool diagnostics enabled, against a
 * local disposable PostgreSQL reached through a latency-injecting TCP proxy that models the
 * production path (Render Oregon -> Supabase pooler eu-west-1: ~120 ms per round trip, and a
 * slower first exchange standing in for TLS + SCRAM through the pooler).
 *
 * It then replays exactly what the Company web dashboard sends (CompanyDashboardScreen loadData:
 * nine core loaders in parallel, then the section loaders in parallel) and reports, per endpoint,
 * how many pooled connections each request takes, how long it holds them and how long it waits.
 *
 * Synthetic data only (shaped like the pilot company: 6 linked Guards, 4 with recorded company
 * checks, 6 shifts). Never touches production. Writes only to its own local database.
 *
 * Requires POOL_LOAD_DATABASE_URL (localhost). Optional: POOL_LOAD_ONE_WAY_MS (default 60),
 * POOL_LOAD_CONNECT_PENALTY_MS (default 480), POOL_LOAD_USERS (default 3), POOL_LOAD_SECONDS (default 60).
 *
 * Performance P2 additions (all off by default, so earlier runs reproduce exactly):
 *   POOL_LOAD_CLIENT=uncoordinated|coordinated  how phase C's dashboards refresh. "uncoordinated" is the
 *       pre-P2 web app: every timer tick starts a reload whether or not the last one finished, and the
 *       browser abandons a request after 30 s while the server keeps working on it. "coordinated" is the
 *       P2 web app: the next reload starts only after the last one finished. Either way the browser's
 *       30 s abort applies.
 *   POOL_LOAD_SWEEP_SECONDS=N  drive the five-minute safety sweep every N seconds (compressed time) during
 *       phases C and D, through whatever the running build's timer does: P2's single-flight tick, or the
 *       pre-P2 bare interval body.
 *   POOL_LOAD_STALE_SHIFTS=N   in-progress shifts left running long past their end (as in production) for
 *       the sweep to work on (default 4).
 *   POOL_LOAD_IDLE_SECONDS=N   phase D: nobody signed in, only the sweep and the health probe.
 *   POOL_LOAD_SKIP_AB=true     skip phases A and B.
 * With any of these set, a Render-style probe calls /health/ready and /health/live every 5 s with a 5 s
 * timeout throughout phases C and D, and the report counts the probes Render would have failed.
 */
import 'reflect-metadata';
import * as assert from 'assert';
import * as net from 'net';
import { monitorEventLoopDelay } from 'perf_hooks';
import { randomUUID } from 'crypto';
import { LoggerService, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { NextFunction, Request, Response } from 'express';

const url = process.env.POOL_LOAD_DATABASE_URL ?? '';
if (!url) throw new Error('POOL_LOAD_DATABASE_URL is required');
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error('Pool load database must be local');

const ONE_WAY_MS = Number(process.env.POOL_LOAD_ONE_WAY_MS ?? 60);
const CONNECT_PENALTY_MS = Number(process.env.POOL_LOAD_CONNECT_PENALTY_MS ?? 480);
const USERS = Number(process.env.POOL_LOAD_USERS ?? 3);
const SECONDS = Number(process.env.POOL_LOAD_SECONDS ?? 60);
const CLIENT = process.env.POOL_LOAD_CLIENT as 'coordinated' | 'uncoordinated' | undefined;
const SWEEP_SECONDS = Number(process.env.POOL_LOAD_SWEEP_SECONDS ?? 0);
const IDLE_SECONDS = Number(process.env.POOL_LOAD_IDLE_SECONDS ?? 0);
const STALE_SHIFTS = Number(process.env.POOL_LOAD_STALE_SHIFTS ?? 4);
const SKIP_AB = process.env.POOL_LOAD_SKIP_AB === 'true';
const P2_MODE = Boolean(CLIENT || SWEEP_SECONDS || IDLE_SECONDS);
/** The web app's own request timeout (security-mobile-app/src/services/api.ts). */
const BROWSER_ABORT_MS = 30_000;

/**
 * Performance P3: a model of what a statement with a large eager JOIN graph cost on the production
 * database, where the local one plans it in ~100 ms. Off unless POOL_LOAD_HEAVY_COST_MS is set.
 * A statement with more than HEAVY_JOINS JOINs is held for HEAVY_COST_MS before PostgreSQL sees it, and
 * holds one of DB_CPUS "database CPU" slots meanwhile, so heavy statements queue behind each other as
 * they did on the Nano instance. Statements at or below HEAVY_JOINS cost nothing extra.
 * Default cost 2700 ms: the median production round trip of the pre-P2 eager statements measured on
 * 15 Oct 2026 (EXPLAIN only: 6538, 2705, 9218, 495, 431 ms).
 */
const HEAVY_COST_MS = Number(process.env.POOL_LOAD_HEAVY_COST_MS ?? 0);
const HEAVY_JOINS = 8;
const DB_CPUS = Number(process.env.POOL_LOAD_DB_CPUS ?? 2);
const cpu = { free: DB_CPUS, queue: [] as Array<() => void>, heavyStatements: 0, maxQueued: 0 };
const takeCpu = () => new Promise<void>((resolve) => {
  if (cpu.free > 0) { cpu.free -= 1; resolve(); return; }
  cpu.queue.push(resolve);
  cpu.maxQueued = Math.max(cpu.maxQueued, cpu.queue.length);
});
const giveCpu = () => { const next = cpu.queue.shift(); if (next) next(); else cpu.free += 1; };

/** Delays every chunk in both directions, preserving order; the first server reply is delayed further. */
class LatencyProxy {
  oneWayMs = 0;
  readonly socketErrors: string[] = [];
  connectPenaltyMs = 0;
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();

  async start(targetHost: string, targetPort: number): Promise<number> {
    this.server = net.createServer((client) => {
      const upstream = net.connect(targetPort, targetHost);
      this.sockets.add(client);
      this.sockets.add(upstream);
      let firstReply = true;
      const pipe = (from: net.Socket, to: net.Socket, isReply: boolean) => {
        // Strict FIFO per direction: one timer at a time drains a queue in arrival order. (Separate
        // setTimeout calls with different durations are not ordered by Node when they fall due in the
        // same millisecond, which would reorder protocol bytes and stall the driver.)
        const queue: Array<{ due: number; fn: () => void }> = [];
        let timer: NodeJS.Timeout | null = null;
        const drain = () => {
          timer = null;
          while (queue.length && queue[0].due <= Date.now()) queue.shift()!.fn();
          if (queue.length) timer = setTimeout(drain, Math.max(0, queue[0].due - Date.now()));
        };
        const schedule = (fn: () => void) => {
          let delay = this.oneWayMs;
          if (isReply && firstReply) {
            delay += this.connectPenaltyMs;
            firstReply = false;
          }
          const last = queue.length ? queue[queue.length - 1].due : 0;
          queue.push({ due: Math.max(Date.now() + delay, last), fn });
          if (!timer) timer = setTimeout(drain, Math.max(0, queue[0].due - Date.now()));
        };
        if (HEAVY_COST_MS > 0 && !isReply) {
          // Client -> server, cost model on: JOINs are counted across the chunks of one extended-query
          // batch, and the chunk that ends it (Sync: 'S' 00 00 00 04) is held for the modelled cost.
          let joins = 0;
          let chain = Promise.resolve();
          from.on('data', (chunk: Buffer) => {
            joins += (chunk.toString('latin1').match(/\bJOIN\b/g) ?? []).length;
            const endsBatch = chunk.length >= 5 && chunk[chunk.length - 5] === 0x53 && chunk.readInt32BE(chunk.length - 4) === 4;
            const heavy = endsBatch && joins > HEAVY_JOINS;
            if (endsBatch) joins = 0;
            chain = chain.then(async () => {
              if (heavy) {
                cpu.heavyStatements += 1;
                await takeCpu();
                await new Promise((r) => setTimeout(r, HEAVY_COST_MS));
                giveCpu();
              }
              schedule(() => !to.destroyed && to.write(chunk));
            });
          });
        } else {
          from.on('data', (chunk) => schedule(() => !to.destroyed && to.write(chunk)));
        }
        from.on('end', () => schedule(() => !to.destroyed && to.end()));
        from.on('error', (error: NodeJS.ErrnoException) => {
          this.socketErrors.push(error.code ?? error.name);
          to.destroy();
        });
        from.on('close', () => this.sockets.delete(from));
      };
      pipe(client, upstream, false);
      pipe(upstream, client, true);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return (this.server!.address() as net.AddressInfo).port;
  }

  async stop() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

/** Collects the application's DbPool lines; everything else is dropped. */
class CaptureLogger implements LoggerService {
  readonly poolLines: string[] = [];
  log(message: unknown, context?: string) {
    if (context === 'DbPool') this.poolLines.push(String(message));
  }
  warn(message: unknown, context?: string) {
    if (context === 'DbPool') this.poolLines.push(String(message));
  }
  readonly appErrors: string[] = [];
  error(message: unknown, trace?: unknown, context?: string) {
    // Synthetic data only; kept local, short, for diagnosing unexpected 5xx responses.
    if (this.appErrors.length >= 50) return;
    const stack = String(trace ?? '').split('\n').slice(0, 3).join(' < ').slice(0, 300);
    this.appErrors.push(`${context ?? ''}: ${String(message).slice(0, 160)} | ${stack}`);
  }
  debug() {}
  verbose() {}
}

type Res = { status: number; ms: number; body: any };
const hung: Array<{ path: string; afterMs: number; error: string }> = [];
const T0 = Date.now();
const phase = (name: string) => console.error(`[pool-load] +${((Date.now() - T0) / 1000).toFixed(1)}s ${name}`);

async function main() {
  const proxy = new LatencyProxy();
  const proxyPort = await proxy.start(target.hostname, Number(target.port || 5432));
  const proxied = new URL(url);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(proxyPort);

  phase("proxy up");
  // Migrate directly (no latency), then point the app at the proxy.
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const migrator = new DataSource(buildTypeOrmOptions({ DATABASE_URL: url, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' }));
  await migrator.initialize();
  await migrator.runMigrations({ transaction: 'each' });
  await migrator.destroy();

  process.env.DATABASE_URL = proxied.toString();
  delete process.env.DATABASE_POOLER_URL;
  process.env.DATABASE_SSL = 'false';
  process.env.DATABASE_SYNCHRONIZE = 'false';
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'pool-load-local-secret-not-production';
  process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  process.env.DB_POOL_DIAGNOSTICS = 'true';
  process.env.DB_POOL_DIAG_REQUEST_ACQUISITIONS = '1';
  process.env.DB_POOL_DIAG_MAX_EVENTS_PER_MIN = '600';
  process.env.DB_POOL_DIAG_SNAPSHOT_MS = '5000';

  const capture = new CaptureLogger();
  const { AppModule } = await import('../src/app.module');
  const { dbRequestContextMiddleware } = await import('../src/database/pool-diagnostics/pool-diagnostics.middleware');
  const app = await NestFactory.create(AppModule, { logger: capture });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  // As main.ts: request id first, then the diagnostics context.
  app.use((request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Request-Id', request.header('x-request-id')?.trim() || randomUUID());
    next();
  });
  app.use(dbRequestContextMiddleware());
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as net.AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const ds = app.get(DataSource);
  const pool: any = (ds.driver as any).master;
  const [{ current_database: db }] = await ds.query('SELECT current_database()');
  assert.equal(db, target.pathname.slice(1), 'app is on the disposable database');

  const api = async (method: string, path: string, token: string | null, body?: unknown, timeoutMs = 60_000): Promise<Res> => {
    const started = Date.now();
    let res: globalThis.Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // The browser gave up (P2 modes): the server is still working on it, which is the point.
      if (timeoutMs < 60_000) return { status: 598, ms: Date.now() - started, body: null };
      // No response within 60 s: recorded as 599 so a hang is reported, not fatal. The server's own view
      // of every session (read directly, not through the proxy) says whether PostgreSQL is still working
      // on something — a lock wait, a running query — or has answered and the reply never arrived.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Client } = require('pg');
      const direct = new Client({ connectionString: url });
      let sessions: unknown = null;
      try {
        await direct.connect();
        sessions = (await direct.query(
          `SELECT state, wait_event_type AS "waitType", wait_event AS "wait", (now() - state_change)::text AS "inState",
                  (now() - xact_start)::text AS "inXact", left(regexp_replace(query, '\\s+', ' ', 'g'), 60) AS "lastQuery"
             FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() ORDER BY state_change`,
        )).rows;
      } finally {
        await direct.end().catch(() => undefined);
      }
      hung.push({ path: path.split('?')[0], afterMs: Date.now() - started, error: (error as Error).name, sessions } as any);
      return { status: 599, ms: Date.now() - started, body: null };
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, ms: Date.now() - started, body: json };
  };

  phase("app listening");
  // ── synthetic fixtures (no latency) ────────────────────────────────────────────────────────────
  const { AuthService } = await import('../src/auth/auth.service');
  const { TransactionalEmailService } = await import('../src/email/transactional-email.service');
  const { AccountRecoveryService } = await import('../src/auth/account-recovery.service');
  const auth = app.get(AuthService);
  const RUN = Date.now().toString(36);
  const password = 'Str0ng-pass-1!';
  const secrets: string[] = [];
  const verify = async (email: string) => {
    const message = [...app.get(TransactionalEmailService).capturedMessages()].reverse().find((m: any) => m.kind === 'email_verification' && m.to === email);
    const token = message && /verify-email\?token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
    assert.ok(token);
    await app.get(AccountRecoveryService).verifyEmail(token);
  };
  const login = async (email: string) => (await auth.login({ email, password }) as any);

  const ownerEmail = `owner.${RUN}@pool-load.test`;
  secrets.push(ownerEmail);
  await auth.register({
    email: ownerEmail, password, role: 'company' as any, fullName: 'Load Owner', phone: '02000000000',
    companyName: `Load ${RUN} Security Ltd`, companyNumber: String(10000000 + Math.floor(Math.random() * 8999999)),
    address: '1 High St, London', contactDetails: 'ops@load.test',
  } as any);
  await verify(ownerEmail);
  const owner = await login(ownerEmail);
  const token: string = owner.accessToken;
  const companyId: number = owner.user.companyId;

  const client = await api('POST', '/clients', token, { name: 'Acme Retail', contactName: 'Pat', contactEmail: 'pat@acme.test', contactPhone: '02011112222' });
  const site = await api('POST', '/sites', token, { name: 'Acme Store 1', clientId: client.body.id, address: '10 Market Sq, London', welfareCheckIntervalMinutes: 60, requireGpsCheckIn: false });
  const guardIds: number[] = [];
  let sia = 6100000000000000 + Math.floor(Math.random() * 1e9);
  for (let i = 0; i < 6; i += 1) {
    const email = `guard${i}.${RUN}@pool-load.test`;
    const siaNumber = String((sia += 7919));
    secrets.push(email, siaNumber, `Load Guard ${i}`);
    await auth.register({ email, password, role: 'guard' as any, fullName: `Load Guard ${i}`, phone: '07700000000', siaLicenseNumber: siaNumber } as any);
    await verify(email);
    const g = await login(email);
    guardIds.push(g.user.guardId);
    const link = await api('POST', '/company-guards', token, { companyId, guardId: g.user.guardId });
    assert.equal(link.status, 201, JSON.stringify(link.body));
    if (i < 4) {
      const ukDay = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
      await api('POST', '/compliance/checks', token, {
        guardId: g.user.guardId, kind: 'sia', outcome: 'confirmed', method: 'sia_public_register', licenceNumber: siaNumber,
        checkDate: ukDay(-1), expiryDate: ukDay(400), checkedByName: 'Pat Checker', evidenceReference: 'HR file SIA',
      });
      await api('POST', '/compliance/checks', token, {
        guardId: g.user.guardId, kind: 'right_to_work', outcome: 'confirmed', method: 'manual_document', rightToWorkExcuse: 'continuous',
        checkDate: ukDay(-1), checkedByName: 'Pat Checker', evidenceReference: 'HR file RTW',
      });
    }
  }
  const today = new Date();
  for (let i = 0; i < 6; i += 1) {
    const start = new Date(today);
    start.setUTCHours(8 + i, 0, 0, 0);
    const end = new Date(start.getTime() + 8 * 3_600_000);
    const slot = await api('POST', '/rota-slots', token, {
      siteId: site.body.id, startAt: start.toISOString(), endAt: end.toISOString(), requiredGuardCount: 1, checkCallIntervalMinutes: 60, title: `Cover ${i}`,
    });
    assert.equal(slot.status, 201, JSON.stringify(slot.body));
  }
  phase("fixtures seeded");

  // ── P2: background sweep and Render-style health probe ─────────────────────────────────────────
  const { Shift } = await import('../src/shift/entities/shift.entity');
  const { AttendanceEvent, AttendanceEventType } = await import('../src/attendance/entities/attendance.entity');
  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const sweepService: any = app.get(SafetyAlertService);
  // The build's own five-minute timer is replaced by the harness's compressed one below.
  clearInterval(sweepService.welfareInterval);
  if (P2_MODE) {
    // Shaped like production on 15 Oct: shifts still 'in_progress' long after their scheduled end, never
    // booked off, plus one genuinely live shift. Each has a Book On and no Welfare entries.
    for (let i = 0; i < STALE_SHIFTS; i += 1) {
      const startedHoursAgo = i === 0 ? 3 : 14 + i * 10;
      const start = new Date(Date.now() - startedHoursAgo * 3_600_000);
      const shift: any = await ds.getRepository(Shift).save(ds.getRepository(Shift).create({
        company: { id: companyId }, site: { id: site.body.id }, siteName: 'Acme Store 1', guard: { id: guardIds[i % guardIds.length] },
        start, end: new Date(start.getTime() + 12 * 3_600_000), status: 'in_progress', checkCallIntervalMinutes: 60,
      } as any));
      await ds.getRepository(AttendanceEvent).save(ds.getRepository(AttendanceEvent).create({
        shift: { id: shift.id }, guard: { id: guardIds[i % guardIds.length] }, type: AttendanceEventType.CHECK_IN, occurredAt: start,
      } as any));
    }
  }
  const sweeps = { ticks: 0, started: 0, skipped: 0, durationsMs: [] as number[], maxConcurrent: 0, concurrent: 0, singleFlight: typeof sweepService.triggerSafetySweep === 'function' };
  const sweepTick = () => {
    sweeps.ticks += 1;
    const t0 = Date.now();
    if (sweeps.singleFlight) {
      void sweepService.triggerSafetySweep().then((o: any) => {
        if (o.ran) { sweeps.started += 1; sweeps.durationsMs.push(Date.now() - t0); } else sweeps.skipped += 1;
      });
      return;
    }
    // Exactly the pre-P2 interval body: no guard against a sweep already running.
    sweeps.started += 1;
    sweeps.concurrent += 1;
    sweeps.maxConcurrent = Math.max(sweeps.maxConcurrent, sweeps.concurrent);
    void sweepService.runMissedWelfareChecks()
      .catch(() => undefined)
      .then(() => sweepService.runComplianceLapseScan())
      .catch(() => undefined)
      .finally(() => { sweeps.concurrent -= 1; sweeps.durationsMs.push(Date.now() - t0); });
  };
  const probes: Array<{ at: number; readyMs: number; readyOk: boolean; liveMs: number; liveOk: boolean }> = [];
  const probeOnce = async () => {
    const one = async (path: string) => {
      const t0 = Date.now();
      try {
        const r = await fetch(base + path, { signal: AbortSignal.timeout(5_000) });
        await r.text();
        return { ms: Date.now() - t0, ok: r.status === 200 };
      } catch {
        return { ms: Date.now() - t0, ok: false };
      }
    };
    const [ready, live] = await Promise.all([one('/health/ready'), one('/health/live')]);
    probes.push({ at: Date.now(), readyMs: ready.ms, readyOk: ready.ok, liveMs: live.ms, liveOk: live.ok });
  };
  const startBackground = () => {
    const sweepTimers: NodeJS.Timeout[] = [];
    const probeTimers: NodeJS.Timeout[] = [];
    if (SWEEP_SECONDS > 0) { sweepTick(); sweepTimers.push(setInterval(sweepTick, SWEEP_SECONDS * 1000)); }
    if (P2_MODE) probeTimers.push(setInterval(() => void probeOnce(), 5_000));
    const stopSweeps = () => sweepTimers.forEach(clearInterval);
    const stopAll = () => { stopSweeps(); probeTimers.forEach(clearInterval); };
    return Object.assign(stopAll, { stopSweeps });
  };
  /** Event-loop delay: how long the process could not run anything else (a probe, a request). */
  const loopDelay = () => {
    const h = monitorEventLoopDelay({ resolution: 20 });
    h.enable();
    return () => { h.disable(); return { p50: Math.round(h.percentile(50) / 1e6), p99: Math.round(h.percentile(99) / 1e6), max: Math.round(h.max / 1e6) }; };
  };
  const probeSummary = (from: number) => {
    const p = probes.slice(from);
    const streak = (ok: (x: typeof p[number]) => boolean) => {
      let best = 0, run = 0;
      for (const x of p) { run = ok(x) ? 0 : run + 1; best = Math.max(best, run); }
      return best;
    };
    const sorted = (k: 'readyMs' | 'liveMs') => p.map((x) => x[k]).sort((a, b) => a - b);
    const pct = (arr: number[], q: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] ?? 0;
    return {
      probes: p.length,
      readyFailed: p.filter((x) => !x.readyOk).length,
      readyLongestFailStreak: streak((x) => x.readyOk),
      readyMs: { p50: pct(sorted('readyMs'), 0.5), p95: pct(sorted('readyMs'), 0.95), max: pct(sorted('readyMs'), 1) },
      liveFailed: p.filter((x) => !x.liveOk).length,
      liveMs: { p50: pct(sorted('liveMs'), 0.5), max: pct(sorted('liveMs'), 1) },
    };
  };
  const sweepSummary = () => {
    const d = [...sweeps.durationsMs].sort((a, b) => a - b);
    return { singleFlight: sweeps.singleFlight, ticks: sweeps.ticks, started: sweeps.started, skipped: sweeps.skipped, completed: d.length,
      maxConcurrent: sweeps.singleFlight ? 1 : sweeps.maxConcurrent, durationMs: { p50: d[Math.floor(d.length / 2)] ?? 0, max: d[d.length - 1] ?? 0 }, allDurationsMs: [...sweeps.durationsMs] };
  };
  const fixture = {
    guards: guardIds.length,
    checksRecorded: Number((await ds.query('SELECT count(*)::int n FROM guard_compliance_checks WHERE "companyId" = $1', [companyId]))[0].n),
    shifts: Number((await ds.query('SELECT count(*)::int n FROM shifts WHERE "companyId" = $1', [companyId]))[0].n),
  };

  // ── the dashboard's own request pattern ────────────────────────────────────────────────────────
  const ymd = today.toISOString().slice(0, 10);
  const CORE = [
    '/clients', '/sites', '/shifts', '/coverage/shifts?uncoveredOnly=true', `/coverage/shifts?from=${ymd}&to=${ymd}`,
    '/guards', '/company-guards', '/company-guards/invitations', '/screening/company/outcomes',
  ];
  const SECTION = {
    dashboard: ['/attendance/company', '/timesheets/company', '/incidents/company', '/alerts/company', '/daily-logs/company', '/notifications/company', '/compliance/statuses'],
    'live-operations': ['/attendance/company', '/timesheets/company', '/incidents/company', '/alerts/company', '/daily-logs/company', '/notifications/company'],
  };
  const reload = async (section: keyof typeof SECTION) => {
    const results: Array<{ path: string } & Res> = [];
    const timeoutMs = P2_MODE ? BROWSER_ABORT_MS : 60_000;
    const run = async (paths: string[]) =>
      Promise.all(paths.map(async (path) => results.push({ path, ...(await api('GET', path, token, undefined, timeoutMs)) })));
    const started = Date.now();
    await run(CORE);
    await run(SECTION[section]);
    return { ms: Date.now() - started, results };
  };

  const summaries = (from: number) =>
    capture.poolLines.slice(from).map((line) => JSON.parse(line)).filter((e) => e.event === 'db_pool_request_summary');
  const byRoute = (rows: any[]) => {
    const m = new Map<string, { requests: number; acq: number; maxAcq: number; holdMs: number; waitMs: number; maxWaitMs: number; maxPar: number; failures: number; maxMs: number }>();
    for (const r of rows) {
      const key = `${r.method} ${r.route}`;
      const s = m.get(key) ?? { requests: 0, acq: 0, maxAcq: 0, holdMs: 0, waitMs: 0, maxWaitMs: 0, maxPar: 0, failures: 0, maxMs: 0 };
      s.requests += 1;
      s.acq += r.acquisitions;
      s.maxAcq = Math.max(s.maxAcq, r.acquisitions);
      s.holdMs += r.totalHoldMs;
      s.waitMs += r.totalWaitMs;
      s.maxWaitMs = Math.max(s.maxWaitMs, r.maxWaitMs);
      s.maxPar = Math.max(s.maxPar, r.maxConcurrentHeld);
      s.failures += r.failures;
      s.maxMs = Math.max(s.maxMs, r.durationMs);
      m.set(key, s);
    }
    return [...m.entries()]
      .map(([route, s]) => ({
        route,
        requests: s.requests,
        acqPerReq: +(s.acq / s.requests).toFixed(1),
        maxAcq: s.maxAcq,
        holdMsPerReq: Math.round(s.holdMs / s.requests),
        waitMsPerReq: Math.round(s.waitMs / s.requests),
        maxWaitMs: s.maxWaitMs,
        maxParallel: s.maxPar,
        failures: s.failures,
        maxDurationMs: s.maxMs,
      }))
      .sort((a, b) => b.holdMsPerReq * b.requests - a.holdMsPerReq * a.requests);
  };
  const waitForDrain = async () => {
    // Let the pool idle out (idleTimeoutMillis 30 s), as it does between 60-second dashboard refreshes.
    const deadline = Date.now() + 40_000;
    while (pool.totalCount > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  };

  const report: any = { settings: { oneWayMs: ONE_WAY_MS, connectPenaltyMs: CONNECT_PENALTY_MS, users: USERS, seconds: SECONDS, pool: { max: pool.options.max, connectionTimeoutMillis: pool.options.connectionTimeoutMillis, idleTimeoutMillis: pool.options.idleTimeoutMillis } }, fixture };

  let mark = capture.poolLines.length;
  if (!SKIP_AB) {
  // A: no latency, warm pool — the query cost of one dashboard load.
  await reload('dashboard');
  mark = capture.poolLines.length;
  const a = await reload('dashboard');
  report.A_noLatency_warm = { reloadMs: a.ms, statuses: [...new Set(a.results.map((r) => r.status))], perRoute: byRoute(summaries(mark)) };

  phase("A done");
  }
  // B: production-like latency, cold pool — one user opening the dashboard.
  proxy.oneWayMs = ONE_WAY_MS;
  proxy.connectPenaltyMs = CONNECT_PENALTY_MS;
  if (!SKIP_AB) {
  await waitForDrain();
  mark = capture.poolLines.length;
  const b = await reload('dashboard');
  report.B_latency_cold_singleUser = { reloadMs: b.ms, poolTotalAfter: pool.totalCount, failedRequests: b.results.filter((r) => r.status >= 500).map((r) => r.path), perRoute: byRoute(summaries(mark)) };

  phase("B done");
  }
  // C: production-like latency, several open dashboards on their real cadences, for SECONDS.
  mark = capture.poolLines.length;
  const stopAt = Date.now() + SECONDS * 1000;
  const sections: Array<keyof typeof SECTION> = ['live-operations', 'dashboard', 'live-operations', 'dashboard', 'live-operations'];
  const cadence = { 'live-operations': 15_000, dashboard: 60_000 };
  const loads: number[] = [];
  const failures: string[] = [];
  let peakWaiting = 0;
  const sampler = setInterval(() => (peakWaiting = Math.max(peakWaiting, pool.waitingCount)), 100);
  const probeMarkC = probes.length;
  const stopLoopC = loopDelay();
  const stopBackgroundC = startBackground();
  let peakInFlightReloads = 0;
  let clientAborts = 0;
  const record = (r: { ms: number; results: Array<{ path: string } & Res> }) => {
    loads.push(r.ms);
    r.results.filter((x) => x.status >= 500).forEach((x) => (x.status === 598 ? (clientAborts += 1) : failures.push(`${x.status} ${x.path.split('?')[0]}`)));
  };
  if (CLIENT === 'uncoordinated') {
    // Pre-P2 web app: the refresh timer fires on cadence whatever is still in flight.
    let inFlight = 0;
    const pending: Promise<void>[] = [];
    await Promise.all(
      Array.from({ length: USERS }, async (_, u) => {
        const section = sections[u % sections.length];
        await new Promise((r) => setTimeout(r, u * 1_500));
        while (Date.now() < stopAt) {
          inFlight += 1;
          peakInFlightReloads = Math.max(peakInFlightReloads, inFlight);
          pending.push(reload(section).then(record).finally(() => { inFlight -= 1; }));
          await new Promise((res) => setTimeout(res, cadence[section]));
        }
      }),
    );
    await Promise.all(pending);
  } else {
  await Promise.all(
    Array.from({ length: USERS }, async (_, u) => {
      const section = sections[u % sections.length];
      await new Promise((r) => setTimeout(r, u * 1_500));
      while (Date.now() < stopAt) {
        const r = await reload(section);
        record(r);
        const wait = cadence[section] - r.ms;
        if (wait > 0 && Date.now() + wait < stopAt) await new Promise((res) => setTimeout(res, wait));
        else if (wait > 0) break;
      }
    }),
  );
  }
  stopBackgroundC();
  clearInterval(sampler);
  phase("C done");
  const snapshots = capture.poolLines.slice(mark).map((l) => JSON.parse(l)).filter((e) => e.event === 'db_pool_snapshot');
  const sorted = [...loads].sort((x, y) => x - y);
  report.C_latency_concurrentUsers = {
    reloads: loads.length,
    reloadMs: { p50: sorted[Math.floor(sorted.length / 2)] ?? 0, max: sorted[sorted.length - 1] ?? 0 },
    peakWaiting,
    http5xx: failures.length,
    http5xxByPath: failures.reduce((m: Record<string, number>, f) => ((m[f] = (m[f] ?? 0) + 1), m), {}),
    queueTimeouts: snapshots.reduce((n, s) => n + (s.failures?.queue_timeout ?? 0), 0),
    connectTimeouts: snapshots.reduce((n, s) => n + (s.failures?.connect_timeout ?? 0), 0),
    newConnections: snapshots.reduce((n, s) => n + (s.newConnections ?? 0), 0),
    establishMsP95: Math.max(0, ...snapshots.map((s) => s.establishMs?.p95 ?? 0)),
    perRoute: byRoute(summaries(mark)).slice(0, 12),
  };
  if (P2_MODE) {
    Object.assign(report.C_latency_concurrentUsers, {
      client: CLIENT ?? 'coordinated', peakInFlightReloads, clientAborts, eventLoopDelayMs: stopLoopC(),
      health: probeSummary(probeMarkC), sweep: sweepSummary(),
    });
  }

  // D: nobody signed in — only the background sweep and the health probe (P2).
  if (IDLE_SECONDS > 0) {
    await waitForDrain();
    const probeMarkD = probes.length;
    const before = sweepSummary();
    let peakWaitingD = 0;
    const samplerD = setInterval(() => (peakWaitingD = Math.max(peakWaitingD, pool.waitingCount)), 100);
    const stopLoopD = loopDelay();
    const startedD = Date.now();
    const stopBackgroundD = startBackground();
    await new Promise((r) => setTimeout(r, IDLE_SECONDS * 1000));
    stopBackgroundD.stopSweeps();
    // Let the last sweep finish before reporting, still probing as Render would.
    const deadline = Date.now() + 1_200_000;
    while ((sweeps.singleFlight ? sweepService.safetySweep?.isRunning?.() : sweeps.concurrent > 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    stopBackgroundD();
    clearInterval(samplerD);
    const wallMs = Date.now() - startedD;
    const eventLoopDelayMs = stopLoopD();
    const after = sweepSummary();
    report.D_idle_backgroundOnly = {
      seconds: IDLE_SECONDS, wallMs, eventLoopDelayMs, peakWaiting: peakWaitingD, health: probeSummary(probeMarkD),
      sweep: { ...after, ticks: after.ticks - before.ticks, started: after.started - before.started, skipped: after.skipped - before.skipped },
    };
    phase("D done");
  }

  // Privacy: nothing seeded as personal data appears in any diagnostics line.
  const allPool = capture.poolLines.join('\n');
  for (const s of secrets) assert.ok(!allPool.includes(s), 'diagnostics must not contain seeded personal data');
  assert.ok(!allPool.includes(proxied.toString()) && !allPool.includes(url), 'no connection string');
  assert.ok(!/SELECT|INSERT|UPDATE /.test(allPool), 'no SQL text');
  report.appErrors = capture.appErrors;
  report.hungRequests = hung;
  const events = capture.poolLines.map((l) => JSON.parse(l));
  report.longHolds = events
    .filter((e) => e.event === 'db_pool_long_hold')
    .map((e) => ({ route: e.route, heldMs: e.heldMs }))
    .sort((x, y) => y.heldMs - x.heldMs)
    .slice(0, 15);
  report.acquireFailures = events.filter((e) => e.event === 'db_pool_acquire_failed').map((e) => ({ kind: e.kind, route: e.route, waitedMs: e.waitedMs }));
  report.poolAtEnd = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
  report.proxySocketErrors = proxy.socketErrors;
  if (HEAVY_COST_MS > 0) report.costModel = { heavyCostMs: HEAVY_COST_MS, dbCpus: DB_CPUS, heavyJoinsAbove: HEAVY_JOINS, heavyStatements: cpu.heavyStatements, maxQueuedForCpu: cpu.maxQueued };
  report.privacy = { poolLines: capture.poolLines.length, seededValuesChecked: secrets.length, leaks: 0 };

  console.log(JSON.stringify(report, null, 1));
  await app.close();
  await proxy.stop();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
