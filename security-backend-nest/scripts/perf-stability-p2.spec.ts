/**
 * Performance P2 — stability remediation certification.
 *
 * The S4 P1 incident (14-15 Oct 2026): the backend's 10-connection pool ran dry, the Render health check
 * (which shares that pool) timed out, Render restarted the only instance, and a restart that could not
 * reach the database on its single connection attempt exited with status 1. Instance failures continued
 * overnight with no confirmed user traffic, while the five-minute safety sweep logged statement timeouts.
 *
 * Proven here against the REAL application on a local, disposable PostgreSQL reached through a TCP proxy
 * this spec controls:
 *
 *   P2-01..04  start-up: bounded, configurable retries for transient failures only; a persistent outage
 *              still fails (and the process still exits); privacy-safe attempt logs
 *   P2-05..07  health: /health/live never needs the database; /health/ready still reports it, and every
 *              readiness failure is logged without connection details
 *   P2-08..11  /coverage/shifts and /rota/week: identical responses to the pre-P2 queries, tenant
 *              isolation, one pooled connection at a time, far fewer joins
 *   P2-12..16  background jobs: one run at a time, a skipped tick defers and never loses work, failures are
 *              logged and retried on the next tick, nothing escapes as an unhandled rejection; the safety
 *              sweep's alerts, audit entries and notifications are identical to the pre-P2 sweep's
 *
 * "Pre-P2" is reproduced exactly by handing the services repositories that strip the two find options P2
 * added (relations / loadEagerRelations), which restores the entities' eager graphs.
 *
 * Requires PERF_P2_DATABASE_URL (localhost).
 */
import 'reflect-metadata';
import * as assert from 'assert';
import * as net from 'net';
import { LoggerService, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource, Repository } from 'typeorm';

const url = process.env.PERF_P2_DATABASE_URL ?? '';
if (!url) throw new Error('PERF_P2_DATABASE_URL is required');
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error('database must be local');

process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'perf-p2-local-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.DATABASE_POOLER_URL;
delete process.env.DB_POOL_DIAGNOSTICS;
// Fast, bounded retries for the spec; production defaults are certified separately in P2-01.
process.env.DATABASE_CONNECT_ATTEMPTS = '4';
process.env.DATABASE_CONNECT_RETRY_DELAY_MS = '300';

let passed = 0;
const pass = (name: string) => {
  passed += 1;
  console.log(`PASS ${name}`);
};

/** A forwarding proxy whose behaviour the spec switches: forward, or accept-and-drop (an outage). */
class SwitchableProxy {
  mode: 'forward' | 'drop' = 'forward';
  /** Drop only the next N connections, then forward. */
  dropNext = 0;
  accepted = 0;
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  constructor(private readonly host: string, private readonly port: number) {}

  async start(): Promise<number> {
    this.server = net.createServer((client) => {
      this.accepted += 1;
      if (this.mode === 'drop' || this.dropNext > 0) {
        if (this.dropNext > 0) this.dropNext -= 1;
        client.destroy();
        return;
      }
      const upstream = net.connect(this.port, this.host);
      this.sockets.add(client);
      this.sockets.add(upstream);
      client.pipe(upstream);
      upstream.pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
        this.sockets.delete(client);
        this.sockets.delete(upstream);
      };
      client.on('error', close);
      upstream.on('error', close);
      client.on('close', close);
      upstream.on('close', close);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return (this.server!.address() as net.AddressInfo).port;
  }

  /** Every open connection is cut, as a network failure or a database restart would. */
  cutAll() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  async stop() {
    this.cutAll();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

class CaptureLogger implements LoggerService {
  lines: Array<{ level: string; message: string; context?: string }> = [];
  private push(level: string, message: unknown, rest: unknown[]) {
    const context = typeof rest[rest.length - 1] === 'string' ? (rest[rest.length - 1] as string) : undefined;
    this.lines.push({ level, message: typeof message === 'string' ? message : JSON.stringify(message), context });
  }
  log(message: unknown, ...rest: unknown[]) { this.push('log', message, rest); }
  error(message: unknown, ...rest: unknown[]) { this.push('error', message, rest); }
  warn(message: unknown, ...rest: unknown[]) { this.push('warn', message, rest); }
  debug() {}
  verbose() {}
  events(name: string) {
    return this.lines
      .map((l) => { try { return JSON.parse(l.message); } catch { return null; } })
      .filter((e) => e && e.event === name);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Strips the find options P2 added, which restores each entity's eager graph: the pre-P2 query. */
function prePhase2<T extends object>(repo: Repository<T>): Repository<T> {
  const proxy = Object.create(repo) as Repository<T>;
  const strip = (options: any) => {
    if (!options) return options;
    const { relations, loadEagerRelations, ...rest } = options;
    return rest;
  };
  (proxy as any).find = (options?: any) => repo.find(strip(options));
  (proxy as any).findOne = (options: any) => repo.findOne(strip(options));
  return proxy;
}

async function main() {
  const {
    buildConnectRetryPolicy, classifyConnectError, readConnectRetryConfig,
    CONNECT_ATTEMPTS_DEFAULT, CONNECT_RETRY_DELAY_MS_DEFAULT,
  } = await import('../src/database/connect-retry');
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');

  // ── P2-01: configuration ──────────────────────────────────────────────────────────────────────────
  assert.equal(CONNECT_ATTEMPTS_DEFAULT, 5);
  assert.equal(CONNECT_RETRY_DELAY_MS_DEFAULT, 3000);
  assert.deepEqual(readConnectRetryConfig({}), { attempts: 5, delayMs: 3000 });
  assert.deepEqual(readConnectRetryConfig({ DATABASE_CONNECT_ATTEMPTS: '', DATABASE_CONNECT_RETRY_DELAY_MS: 'abc' }), { attempts: 5, delayMs: 3000 });
  assert.deepEqual(readConnectRetryConfig({ DATABASE_CONNECT_ATTEMPTS: '3', DATABASE_CONNECT_RETRY_DELAY_MS: '1500' }), { attempts: 3, delayMs: 1500 });
  // Clamped both ways: never zero attempts, never unbounded, never a busy loop, never a ten-minute wait.
  assert.deepEqual(readConnectRetryConfig({ DATABASE_CONNECT_ATTEMPTS: '0', DATABASE_CONNECT_RETRY_DELAY_MS: '0' }), { attempts: 1, delayMs: 250 });
  assert.deepEqual(readConnectRetryConfig({ DATABASE_CONNECT_ATTEMPTS: '999999', DATABASE_CONNECT_RETRY_DELAY_MS: '600000' }), { attempts: 10, delayMs: 30000 });
  assert.deepEqual(readConnectRetryConfig({ DATABASE_CONNECT_ATTEMPTS: 'Infinity' }), { attempts: 5, delayMs: 3000 });
  // Worst case with defaults: 5 attempts x (10 s connect timeout) + 4 x 3 s = 62 s, inside Render's start window.
  pass('P2-01 start-up retries: 5 attempts 3 s apart by default; configurable; clamped to 1-10 attempts and 250 ms-30 s');

  // ── P2-02: classification (real driver errors where the outcome matters) ─────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require('pg');
  const realError = async (connectionString: string, extra: any = {}) => {
    const c = new Client({ connectionString, connectionTimeoutMillis: 2000, ...extra });
    try { await c.connect(); await c.end(); return null; } catch (e) { try { await c.end(); } catch { /* closed */ } return e; }
  };
  const closedPort = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  const refused = await realError(`postgresql://s4test@127.0.0.1:${closedPort}/x`);
  // The spec's own server and credentials, only the database name changed, so the server itself answers
  // "database does not exist" whether it uses trust (local) or password (CI) authentication.
  const missingDbUrl = new URL(url);
  missingDbUrl.pathname = '/s4_p2_database_that_does_not_exist';
  const missingDb = await realError(missingDbUrl.toString());
  assert.ok(refused && missingDb, 'both connections must fail');
  assert.deepEqual(classifyConnectError(refused), { category: 'refused', code: 'ECONNREFUSED', transient: true });
  assert.deepEqual(classifyConnectError(missingDb), { category: 'configuration', code: '3D000', transient: false });
  assert.equal(classifyConnectError(new Error('timeout exceeded when trying to connect')).category, 'timeout');
  assert.equal(classifyConnectError(new Error('Connection terminated unexpectedly')).category, 'reset');
  assert.equal(classifyConnectError(Object.assign(new Error('x'), { code: '57P03' })).transient, true);
  assert.equal(classifyConnectError(Object.assign(new Error('x'), { code: '53300' })).transient, true);
  assert.equal(classifyConnectError(Object.assign(new Error('pw'), { code: '28P01' })).transient, false);
  assert.equal(classifyConnectError(new Error('FATAL: Tenant or user not found')).transient, false);
  assert.equal(classifyConnectError(new Error('Entity metadata for Shift#site was not found')).transient, false, 'a code defect is not retried');
  assert.equal(classifyConnectError(undefined).category, 'other');
  pass('P2-02 only failures that can clear on their own are retried: timeouts, refused/reset, DNS, busy server; never auth, config or code errors');

  // ── P2-03: policy and privacy of its log lines ────────────────────────────────────────────────────
  const lines: string[] = [];
  const policy = buildConnectRetryPolicy({ attempts: 3, delayMs: 500 }, (l) => lines.push(l));
  assert.equal(policy.retryAttempts, 3);
  assert.equal(policy.retryDelay, 500);
  const secretish = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432 user=postgres.abcdef password=hunter2 postgresql://u:p@h/db'), { code: 'ECONNREFUSED' });
  assert.equal(policy.toRetry(secretish), true);
  assert.equal(policy.toRetry(secretish), true);
  assert.equal(policy.toRetry(missingDb), false);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.deepEqual(parsed.map((p) => [p.attempt, p.retrying, p.retryInMs]), [[1, true, 500], [2, true, 500], [3, false, null]]);
  assert.ok(parsed.every((p) => p.event === 'database_connect_failed' && p.maxAttempts === 3));
  for (const l of lines) assert.doesNotMatch(l, /10\.1\.2\.3|postgres\.|hunter2|postgresql:|abcdef|s4_p2_database_that_does_not_exist|127\.0\.0\.1/);
  pass('P2-03 each failed attempt is one JSON line: attempt, category, code, retrying - never a host, user, password or message');

  // ── migrate the disposable database directly (not through the proxy) ─────────────────────────────
  const migrator = new DataSource(buildTypeOrmOptions({ DATABASE_URL: url, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' }));
  await migrator.initialize();
  await migrator.runMigrations({ transaction: 'each' });
  await migrator.destroy();

  const proxy = new SwitchableProxy(target.hostname, Number(target.port || 5432));
  const proxyPort = await proxy.start();
  const proxied = new URL(url);
  proxied.port = String(proxyPort);
  process.env.DATABASE_URL = proxied.toString();

  // ── P2-04a: a persistent outage still fails, after exactly the configured attempts ────────────────
  // In a child process booted exactly as production boots (NestFactory.create with Nest's default
  // abortOnError), so the assertion is on the real exit status. (A second AppModule boot in one process
  // after a failed one is not something Nest supports, and is not what production does.)
  {
    proxy.mode = 'drop';
    const started = Date.now();
    // Asynchronous on purpose: the proxy lives in this process and must keep accepting while the child runs.
    const child = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const p = require('child_process').spawn('npx ts-node -r tsconfig-paths/register scripts/perf-stability-p2.spec.ts', {
        cwd: require('path').join(__dirname, '..'),
        env: { ...process.env, P2_CHILD: 'persistent-outage', DATABASE_URL: proxied.toString() },
        shell: true,
      });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d: Buffer) => (stdout += d));
      p.stderr.on('data', (d: Buffer) => (stderr += d));
      const kill = setTimeout(() => p.kill(), 180_000);
      p.on('close', (status: number | null) => { clearTimeout(kill); resolve({ status, stdout, stderr }); });
    });
    const elapsed = Date.now() - started;
    const out = `${child.stdout}\n${child.stderr}`;
    const childLines = out.split('\n').filter((l: string) => l.startsWith('P2CHILD ')).map((l: string) => JSON.parse(l.slice(8)));
    const attempts = childLines.filter((l: any) => l.context === 'DatabaseConnect').map((l: any) => JSON.parse(l.message));
    assert.equal(child.status, 1, `the process exits with status 1 (got ${child.status})`);
    assert.ok(!out.includes('P2CHILD_STARTED'), 'the application must not start without a database');
    assert.deepEqual(attempts.map((a: any) => a.attempt), [1, 2, 3, 4]);
    assert.deepEqual(attempts.map((a: any) => a.retrying), [true, true, true, false]);
    // A dropped connection reaches the driver as ECONNRESET, or (on Linux, when the close wins the race) as
    // a code-less "Connection terminated unexpectedly". Both are the same transient reset.
    assert.ok(attempts.every((a: any) => a.transient && a.category === 'reset' && [null, 'ECONNRESET'].includes(a.code)), JSON.stringify(attempts));
    const nestRetries = childLines.filter((l: any) => l.context === 'TypeOrmModule' && /Unable to connect to the database/.test(l.message));
    assert.equal(nestRetries.length, 4, 'and Nest logs each attempt as before');
    for (const a of childLines.filter((l: any) => l.context === 'DatabaseConnect')) assert.doesNotMatch(a.message, /127\.0\.0\.1|s4test|postgresql:/);
    pass(`P2-04a persistent outage: 4 attempts 300 ms apart, then the original error propagates and the process exits with status 1 (${elapsed} ms incl. compile)`);
  }

  const { AppModule } = await import('../src/app.module');

  // ── P2-04b: a temporary outage is ridden out ──────────────────────────────────────────────────────
  proxy.mode = 'forward';
  proxy.dropNext = 2;
  const logger = new CaptureLogger();
  const app = await NestFactory.create(AppModule, { logger, abortOnError: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as any).port}`;
  const http = async (path: string, timeoutMs = 20000) => {
    const started = Date.now();
    const res = await fetch(base + path, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.json().catch(() => null), ms: Date.now() - started };
  };
  {
    const attempts = logger.events('database_connect_failed');
    assert.deepEqual(attempts.map((a: any) => [a.attempt, a.retrying]), [[1, true], [2, true]]);
    assert.equal((await http('/health/ready')).status, 200);
    pass('P2-04b temporary outage: two refused attempts, the third connects and the application serves');
  }

  const ds = app.get(DataSource);
  const pool = (ds.driver as any).master;

  // Stop the five-minute timer so it cannot fire in the middle of a comparison; ticks are driven by hand.
  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const safety = app.get(SafetyAlertService);
  clearInterval((safety as any).welfareInterval);

  // ── P2-05/06/07: health ───────────────────────────────────────────────────────────────────────────
  {
    // Every pooled connection taken, as in the incident.
    const held: any[] = [];
    for (let i = 0; i < pool.options.max; i += 1) held.push(await pool.connect());
    const live = await http('/health/live');
    assert.equal(live.status, 200);
    assert.ok(live.ms < 1000, `/health/live answers with the pool exhausted (${live.ms} ms)`);
    const before = logger.events('database_readiness_failed').length;
    const ready = await http('/health/ready', 30000);
    assert.equal(ready.status, 503, 'readiness reports the exhausted pool');
    assert.equal(ready.body?.checks?.database, 'down');
    assert.ok(ready.ms >= 9000, `readiness waited for a connection (${ready.ms} ms) - longer than Render's 5 s probe`);
    const failures = logger.events('database_readiness_failed');
    assert.equal(failures.length, before + 1, 'the failure is logged');
    assert.equal(failures[failures.length - 1].category, 'timeout');
    held.forEach((c) => c.release());
    assert.equal((await http('/health/ready')).status, 200);
    pass(`P2-05 pool exhausted: /health/live 200 in ${live.ms} ms; /health/ready 503 after ${ready.ms} ms and logged (category "timeout")`);
  }
  {
    // A database outage while running: connections cut and new ones dropped.
    proxy.mode = 'drop';
    proxy.cutAll();
    await sleep(200);
    const live = await http('/health/live');
    const ready = await http('/health/ready');
    assert.equal(live.status, 200);
    assert.equal(ready.status, 503);
    const last = logger.events('database_readiness_failed').pop();
    assert.ok(['reset', 'timeout', 'refused'].includes(last.category), JSON.stringify(last));
    for (const l of logger.lines.filter((x) => x.context === 'Health')) assert.doesNotMatch(l.message, /127\.0\.0\.1|s4test|postgresql:|terminated/);
    proxy.mode = 'forward';
    let recovered = false;
    for (let i = 0; i < 20 && !recovered; i += 1) {
      recovered = (await http('/health/ready')).status === 200;
      if (!recovered) await sleep(250);
    }
    assert.ok(recovered, 'readiness recovers by itself when the database returns, with no restart');
    pass('P2-06 database outage: /health/live stays 200, /health/ready 503 and logged without connection details, then recovers unaided');
  }
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/health.controller.ts'), 'utf8');
    const liveBody = src.split("@Get('live')")[1].split("@Get('ready')")[0];
    assert.doesNotMatch(liveBody, /dataSource|query|await/, '/health/live must not touch the database');
    const manifest = require('fs').readFileSync(require('path').join(__dirname, '../../render.yaml'), 'utf8');
    assert.match(manifest, /healthCheckPath: \/health\/ready/, 'P2 does not change the deployed health-check path; that is an owner decision');
    pass('P2-07 /health/live has no database dependency; render.yaml is unchanged (health-check path change is prepared, not applied)');
  }

  // ── fixtures for coverage, rota and the sweeps ─────────────────────────────────────────────────────
  const { User, UserRole, UserStatus } = await import('../src/user/entities/user.entity');
  const { Company } = await import('../src/company/entities/company.entity');
  const { Client: ClientEntity } = await import('../src/client/entities/client.entity');
  const { Site } = await import('../src/site/entities/site.entity');
  const { Job } = await import('../src/job/entities/job.entity');
  const { GuardProfile } = await import('../src/guard-profile/entities/guard-profile.entity');
  const { Shift } = await import('../src/shift/entities/shift.entity');
  const { RotaSlot } = await import('../src/rota-slot/entities/rota-slot.entity');
  const { AttendanceEvent, AttendanceEventType } = await import('../src/attendance/entities/attendance.entity');
  const { DailyLog, DailyLogType } = await import('../src/daily-log/entities/daily-log.entity');
  const { SafetyAlert, SafetyAlertPriority, SafetyAlertStatus, SafetyAlertType } = await import('../src/safety-alert/entities/safety-alert.entity');
  const { AuditLog } = await import('../src/audit-log/entities/audit-log.entity');
  const { Notification } = await import('../src/notification/entities/notification.entity');
  const repo = <T extends object>(e: new () => T) => ds.getRepository(e);

  const MIN = 60_000;
  const RUN = Date.now().toString(36);
  let seq = 0;
  const now = Date.now();
  // Shift times are aligned to whole minutes plus 30 s, so a window boundary is never within seconds of a run.
  const at = (minutesFromNow: number) => new Date(Math.floor((now + minutesFromNow * MIN) / MIN) * MIN + 30_000);

  type Tenant = Awaited<ReturnType<typeof makeTenant>>;
  async function makeTenant(label: string) {
    const owner = await repo(User).save(repo(User).create({ email: `${label}.${RUN}.${++seq}@p2.invalid`, passwordHash: 'x', role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE }));
    const company = await repo(Company).save(repo(Company).create({ user: owner, name: `${label} Security Ltd`, companyNumber: String(30000000 + ++seq), address: '1 Test St', contactDetails: 'ops@p2.invalid' }));
    const client = await repo(ClientEntity).save(repo(ClientEntity).create({ company, name: 'Acme Retail' }));
    const siteA = await repo(Site).save(repo(Site).create({ company, client, name: 'Acme Store', address: '2 Test St', status: 'active', requiredGuardCount: 2, welfareCheckIntervalMinutes: 60, logBookIntervalMinutes: 120, timezone: 'Europe/London' }));
    const siteB = await repo(Site).save(repo(Site).create({ company, name: 'Depot', address: '3 Test St', status: 'active', requiredGuardCount: 1, welfareCheckIntervalMinutes: 30, logBookIntervalMinutes: null, timezone: 'Europe/London' }));
    const job = await repo(Job).save(repo(Job).create({ company, site: siteA, title: 'Static', guardsRequired: 2, hourlyRate: 14 } as any));
    const guards = [];
    for (let i = 0; i < 3; i += 1) {
      const u = await repo(User).save(repo(User).create({ email: `${label}.g${i}.${RUN}.${++seq}@p2.invalid`, passwordHash: 'x', role: UserRole.GUARD, status: UserStatus.ACTIVE }));
      guards.push(await repo(GuardProfile).save(repo(GuardProfile).create({ user: u, fullName: `Guard ${i}`, siaLicenseNumber: String(6300000000000000 + ++seq), phone: '07700000000' })));
    }
    return { company, client, siteA, siteB, job, guards };
  }

  const shiftFor = (t: Tenant, o: { site: any; guard?: any; job?: any; start: number; hours: number; status: string; rotaSlotId?: number }) =>
    repo(Shift).save(repo(Shift).create({
      company: t.company, site: o.site, siteName: o.site.name, guard: o.guard ?? null, job: o.job ?? null,
      start: at(o.start), end: at(o.start + o.hours * 60), status: o.status, checkCallIntervalMinutes: 60, rotaSlotId: o.rotaSlotId ?? null,
    } as any)) as Promise<any>;
  const attend = (shift: any, guard: any, type: any, minutes: number) =>
    repo(AttendanceEvent).save(repo(AttendanceEvent).create({ shift, guard, type, occurredAt: at(minutes) } as any));
  const log = async (shift: any, guard: any, company: any, type: any, minutes: number) => {
    const saved: any = await repo(DailyLog).save(repo(DailyLog).create({ company, guard, shift, message: 'entry', logType: type } as any));
    await ds.query('UPDATE daily_logs SET "createdAt" = $1 WHERE id = $2', [at(minutes), saved.id]);
  };
  const alert = (shift: any, guard: any, company: any, type: any, extra: any = {}) =>
    repo(SafetyAlert).save(repo(SafetyAlert).create({ company, guard, shift, type, priority: SafetyAlertPriority.HIGH, status: SafetyAlertStatus.OPEN, welfareWindowIndex: null, message: 'alert', ...extra }));

  /** A board's worth of shifts for coverage and rota: every status the rules distinguish. */
  async function seedBoard(t: Tenant) {
    const monday = new Date(); monday.setUTCHours(0, 0, 0, 0); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const slotAt = (dayOffset: number, hour: number) => new Date(monday.getTime() + dayOffset * 86_400_000 + hour * 3_600_000);
    const slots: any[] = [];
    for (const [day, hour, site] of [[0, 8, t.siteA], [2, 20, t.siteA], [4, 9, t.siteB]] as const) {
      slots.push(await repo(RotaSlot).save(repo(RotaSlot).create({ companyId: t.company.id, siteId: site.id, jobId: null, startAt: slotAt(day, hour), endAt: slotAt(day, hour + 8), requiredGuardCount: 2, checkCallIntervalMinutes: 60, status: 'active', title: `Cover ${day}` } as any)) as any);
    }
    const live = await shiftFor(t, { site: t.siteA, guard: t.guards[0], job: t.job, start: -150, hours: 8, status: 'in_progress', rotaSlotId: slots[0].id });
    await attend(live, t.guards[0], AttendanceEventType.CHECK_IN, -148);
    await log(live, t.guards[0], t.company, DailyLogType.CHECK_CALL, -100);
    await log(live, t.guards[0], t.company, DailyLogType.LOG_BOOK, -40);
    await alert(live, t.guards[0], t.company, SafetyAlertType.MISSED_CHECKCALL, { message: 'Welfare overdue - 1 consecutive check missed' });
    await shiftFor(t, { site: t.siteA, guard: t.guards[1], start: 60, hours: 8, status: 'ready', rotaSlotId: slots[0].id });
    await shiftFor(t, { site: t.siteA, start: 120, hours: 6, status: 'unfilled', rotaSlotId: slots[1].id });
    await shiftFor(t, { site: t.siteB, guard: t.guards[2], start: 180, hours: 6, status: 'offered', rotaSlotId: slots[2].id });
    await shiftFor(t, { site: t.siteB, guard: t.guards[2], start: 24 * 60, hours: 8, status: 'rejected', rotaSlotId: slots[2].id });
    await shiftFor(t, { site: t.siteB, start: 2 * 24 * 60, hours: 8, status: 'cancelled' });
    await shiftFor(t, { site: t.siteA, guard: t.guards[1], start: -600, hours: 8, status: 'completed' });
    await shiftFor(t, { site: t.siteB, guard: t.guards[2], start: -420, hours: 4, status: 'missed' });
    return { monday: monday.toISOString().slice(0, 10) };
  }

  const A = await makeTenant('p2a');
  const B = await makeTenant('p2b');
  const boardA = await seedBoard(A);
  await seedBoard(B);

  // ── P2-08..11: coverage and rota ──────────────────────────────────────────────────────────────────
  const { CoverageService } = await import('../src/coverage/coverage.service');
  const { OperationsProjectionService } = await import('../src/coverage/operations-projection.service');
  const { OperationalWindowService } = await import('../src/operations/operational-window.service');
  const { WelfareWindowService } = await import('../src/operations/welfare-window.service');
  const { LogBookWindowService } = await import('../src/operations/log-book-window.service');
  const { RotaWeekService } = await import('../src/rota-slot/rota-week.service');
  const engine = app.get(OperationalWindowService);
  const projection = (r: (x: any) => any) => new OperationsProjectionService(
    r(repo(AttendanceEvent)), r(repo(DailyLog)), r(repo(SafetyAlert)), engine, app.get(WelfareWindowService), app.get(LogBookWindowService),
  );
  const member = (t: Tenant) => ({ resolveCompanyContext: async () => ({ company: t.company, membershipRole: 'owner' }) }) as any;
  const same = <T>(x: T) => x;
  const coverageFor = (t: Tenant, r: (x: any) => any) => new CoverageService(r(repo(Shift)), member(t), {} as any, projection(r));
  const rotaFor = (t: Tenant, r: (x: any) => any) => new RotaWeekService(r(repo(RotaSlot)), r(repo(Shift)), r(repo(Site)), member(t));

  const ymd = new Date().toISOString().slice(0, 10);
  const queries = [
    {}, { uncoveredOnly: 'true' }, { from: ymd, to: ymd },
    { siteId: String(A.siteB.id) }, { clientId: String(A.client.id) },
    { from: new Date(now - 2 * 86_400_000).toISOString().slice(0, 10), to: new Date(now + 3 * 86_400_000).toISOString().slice(0, 10) },
  ];
  // Both versions read "now" themselves; run them back to back inside the same minute.
  let compared = 0;
  for (const t of [A, B]) {
    for (const q of queries) {
      const before = await coverageFor(t, prePhase2).listShiftCoverage(1, 'company' as any, q as any);
      const after = await coverageFor(t, same).listShiftCoverage(1, 'company' as any, q as any);
      assert.deepEqual(after, before, `coverage ${JSON.stringify(q)} differs`);
      compared += 1;
    }
  }
  const allA = await coverageFor(A, same).listShiftCoverage(1, 'company' as any, { from: queries[5].from, to: queries[5].to } as any);
  assert.ok(allA.length >= 5, `fixture produces a real board (${allA.length} rows)`);
  assert.ok(allA.some((r: any) => r.operations?.welfare?.completedCount === 1 && r.operations?.welfareSummary), 'operations block populated');
  assert.ok(allA.some((r: any) => r.coverageState === 'uncovered') && allA.some((r: any) => r.coverageState === 'waiting_response') && allA.some((r: any) => r.coverageState === 'confirmed'));
  assert.ok(allA.every((r: any) => r.siteId === A.siteA.id || r.siteId === A.siteB.id), 'company A sees only its own shifts');
  pass(`P2-08 /coverage/shifts: ${compared} queries over two companies return exactly the pre-P2 rows (counts, states, Welfare/Log Book blocks); no cross-tenant row`);

  for (const t of [A, B]) {
    for (const extra of [{}, { siteIds: String(t.siteA.id) }, { clientId: t.client.id }, { status: 'active' }]) {
      const before = await rotaFor(t, prePhase2).getWeek({ sub: 1, role: 'company' } as any, { weekCommencing: boardA.monday, ...extra } as any);
      const after = await rotaFor(t, same).getWeek({ sub: 1, role: 'company' } as any, { weekCommencing: boardA.monday, ...extra } as any);
      const firstDiff = (x: any, y: any, p = ''): string | null => { if (JSON.stringify(x) === JSON.stringify(y)) return null; if (x && y && typeof x === 'object' && typeof y === 'object') { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) { const d = firstDiff(x[k], y[k], p + '.' + k); if (d) return d; } } return p + ': ' + JSON.stringify(x)?.slice(0, 300) + ' vs ' + JSON.stringify(y)?.slice(0, 300); };
      // Pre-P2 returned a slot's positions in join-plan order (no ORDER BY); P2 orders them by shift id.
      // Same positions, same values: compared order-insensitively, and P2's order checked separately.
      const byShift = (week: any) => JSON.parse(JSON.stringify(week), (k, v) => (k === 'positions' && Array.isArray(v) ? [...v].sort((p: any, q: any) => p.shiftId - q.shiftId) : v));
      assert.deepEqual(byShift(after), byShift(before), `rota ${JSON.stringify(extra)} differs at ${firstDiff(byShift(after), byShift(before))}`);
      const cells = after.sites.flatMap((x: any) => Object.values(x.days).flatMap((d: any) => d.slots));
      assert.ok(cells.every((c: any) => c.positions.every((p: any, i: number) => i === 0 || c.positions[i - 1].shiftId < p.shiftId)), 'positions in shift order');
    }
  }
  const weekA = await rotaFor(A, same).getWeek({ sub: 1, role: 'company' } as any, { weekCommencing: boardA.monday } as any);
  assert.equal(weekA.snapshot.totalSlots, 3);
  assert.ok(weekA.sites.some((s: any) => s.clientName === 'Acme Retail'), 'client names still loaded');
  const positions = weekA.sites.flatMap((s: any) => Object.values(s.days).flatMap((d: any) => d.slots.flatMap((c: any) => c.positions)));
  assert.ok(positions.some((p: any) => p.guardName === 'Guard 0'), 'guard names still loaded');
  assert.ok(weekA.sites.every((s: any) => [A.siteA.id, A.siteB.id].includes(s.siteId)), 'company A sees only its own sites');
  pass('P2-09 /rota/week: identical to pre-P2 for every filter and both companies (snapshot, cells, positions, client and guard names); positions now in a stable order');

  // Connections and joins for one coverage request.
  const pg = require('pg');
  let held = 0;
  let maxHeld = 0;
  const statements: string[] = [];
  const originalConnect = pool.connect.bind(pool);
  const originalQuery = pg.Client.prototype.query;
  pg.Client.prototype.query = function (config: any, ...rest: any[]) {
    statements.push(typeof config === 'string' ? config : config?.text ?? '');
    return originalQuery.call(this, config, ...rest);
  };
  pool.connect = (cb?: any) => {
    if (typeof cb !== 'function') {
      return originalConnect().then((client: any) => {
        held += 1; maxHeld = Math.max(maxHeld, held);
        const release = client.release.bind(client);
        let done = false;
        client.release = (e?: any) => { if (!done) { done = true; held -= 1; } return release(e); };
        return client;
      });
    }
    return originalConnect((err: any, client: any, release: any) => {
      if (err) return cb(err, client, release);
      held += 1; maxHeld = Math.max(maxHeld, held);
      let done = false;
      cb(err, client, (e?: any) => { if (!done) { done = true; held -= 1; } return release(e); });
    });
  };
  const measure = async (work: () => Promise<unknown>) => {
    held = 0; maxHeld = 0; statements.length = 0;
    await work();
    const joins = statements.reduce((n, s) => n + (s.match(/\bJOIN\b/g) || []).length, 0);
    const chars = statements.reduce((n, s) => n + s.length, 0);
    return { maxHeld, statements: statements.length, joins, chars };
  };
  const today = { from: ymd, to: ymd };
  const oldParallelProjection = async () => {
    // The pre-P2 projection: its four reads in parallel, on the eager graph.
    const shifts = await prePhase2(repo(Shift)).find({ where: { company: { id: A.company.id } } } as any);
    const ids = shifts.map((s: any) => s.id);
    const { In } = await import('typeorm');
    await Promise.all([
      prePhase2(repo(AttendanceEvent)).find({ where: { shift: { id: In(ids) } } } as any),
      prePhase2(repo(DailyLog)).find({ where: { shift: { id: In(ids) } } } as any),
      prePhase2(repo(DailyLog)).find({ where: { shift: { id: In(ids) } } } as any),
      prePhase2(repo(SafetyAlert)).find({ where: { shift: { id: In(ids) } } } as any),
    ]);
  };
  const covOld = await measure(() => coverageFor(A, prePhase2).listShiftCoverage(1, 'company' as any, today as any));
  const covNew = await measure(() => coverageFor(A, same).listShiftCoverage(1, 'company' as any, today as any));
  const projOld = await measure(oldParallelProjection);
  const rotaOld = await measure(() => rotaFor(A, prePhase2).getWeek({ sub: 1, role: 'company' } as any, { weekCommencing: boardA.monday } as any));
  const rotaNew = await measure(() => rotaFor(A, same).getWeek({ sub: 1, role: 'company' } as any, { weekCommencing: boardA.monday } as any));
  assert.equal(covNew.maxHeld, 1, `coverage holds at most one connection at a time (got ${covNew.maxHeld})`);
  assert.ok(projOld.maxHeld >= 2, `the pre-P2 projection held several at once (${projOld.maxHeld})`);
  assert.equal(rotaNew.maxHeld, 1);
  assert.ok(covNew.joins * 3 <= covOld.joins, `coverage joins ${covOld.joins} -> ${covNew.joins}`);
  assert.ok(rotaNew.joins * 3 <= rotaOld.joins, `rota joins ${rotaOld.joins} -> ${rotaNew.joins}`);
  console.log(JSON.stringify({ event: 'p2_query_shape', coverage: { before: covOld, after: covNew, preP2ProjectionAlone: projOld }, rota: { before: rotaOld, after: rotaNew } }));
  pass(`P2-10 one coverage request: max connections held ${Math.max(covOld.maxHeld, projOld.maxHeld)} -> ${covNew.maxHeld}; JOINs ${covOld.joins} -> ${covNew.joins}; SQL ${covOld.chars} -> ${covNew.chars} chars. Rota JOINs ${rotaOld.joins} -> ${rotaNew.joins}`);

  // Tenant isolation through the real HTTP stack is covered by the release gate's coverage/rota specs; here
  // the services' own company filter is proven above. P2 did not touch authorisation.
  pass('P2-11 tenant isolation: every coverage and rota result is scoped to the resolving company (no B rows for A, and vice versa)');

  // ── P2-12..14: single-flight background jobs ──────────────────────────────────────────────────────
  const { SingleFlightJob } = await import('../src/scheduler/single-flight-job');
  {
    const jobLines: Array<[string, string]> = [];
    const jobLogger = { log: (m: string) => jobLines.push(['log', m]), warn: (m: string) => jobLines.push(['warn', m]), error: (m: string) => jobLines.push(['error', m]) } as any;
    let clock = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    let release: () => void = () => undefined;
    const job = new SingleFlightJob('t', async () => {
      concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((r) => (release = r));
      concurrent -= 1;
    }, { overrunAfterMs: 1000, logger: jobLogger, now: () => clock });
    const first = job.tick();
    const skipped = [];
    for (let i = 0; i < 5; i += 1) { clock += 300; skipped.push(await job.tick()); }
    assert.equal(maxConcurrent, 1);
    assert.ok(skipped.every((s) => !s.ran && s.skippedBecause === 'previous_run_active'));
    const events = jobLines.map(([lvl, m]) => [lvl, JSON.parse(m).event]);
    assert.deepEqual(events.slice(0, 3).map((e) => e[1]), ['background_job_skipped', 'background_job_skipped', 'background_job_skipped']);
    assert.deepEqual(events.slice(3), [['error', 'background_job_overrun'], ['error', 'background_job_overrun']], 'a run past its overrun threshold is an error on every skipped tick');
    release();
    assert.deepEqual(await first, { ran: true, ok: true, durationMs: 1500 });
    assert.equal(job.isRunning(), false);
    assert.deepEqual(job.stats(), { runs: 1, succeeded: 1, failed: 0, skipped: 5, overruns: 2 });
    pass('P2-12 a tick while a run is active is skipped (never queued, never concurrent); an overrunning run is reported at error level');
  }
  {
    const jobLines: string[] = [];
    const jobLogger = { log: () => undefined, warn: () => undefined, error: (m: string) => jobLines.push(m) } as any;
    let calls = 0;
    const failing = new SingleFlightJob('f', async () => { calls += 1; if (calls <= 2) throw new Error('canceling statement due to statement timeout'); }, { overrunAfterMs: 60000, logger: jobLogger });
    const syncThrow = new SingleFlightJob('s', () => { throw new Error('sync'); }, { overrunAfterMs: 60000, logger: jobLogger });
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on('unhandledRejection', onUnhandled);
    assert.deepEqual((await failing.tick()).ok, false);
    assert.deepEqual((await failing.tick()).ok, false);
    assert.deepEqual((await failing.tick()).ok, true, 'the next tick retries, and succeeds once the database does');
    assert.equal(calls, 3, 'exactly one attempt per tick: no tight retry loop');
    assert.equal((await syncThrow.tick()).ok, false);
    assert.equal(syncThrow.isRunning(), false, 'a synchronous throw does not wedge the job');
    await sleep(20);
    process.off('unhandledRejection', onUnhandled);
    assert.equal(unhandled, 0, 'nothing escapes as an unhandled rejection');
    assert.ok(jobLines.every((l) => !/statement timeout|sync/.test(l)) && jobLines.length === 3, 'structured failure lines carry no message text');
    failing.stop();
    assert.deepEqual(await failing.tick(), { ran: false, skippedBecause: 'stopped' });
    pass('P2-13 a failed run is logged, retried on the next tick only, never crashes the process; stop() ends the schedule');
  }
  {
    const src = (f: string) => require('fs').readFileSync(require('path').join(__dirname, f), 'utf8');
    const sa = src('../src/safety-alert/safety-alert.service.ts');
    const init = sa.split('onModuleInit() {')[1].split('onModuleDestroy()')[0];
    assert.match(init, /new SingleFlightJob\(\s*'safety-sweep'/);
    assert.match(init, /setInterval\(\(\) => void this\.triggerSafetySweep\(\), SAFETY_SWEEP_INTERVAL_MS\)/);
    assert.match(sa, /const SAFETY_SWEEP_INTERVAL_MS = 5 \* 60 \* 1000;/, 'cadence unchanged');
    const sched = src('../src/scheduler/scheduler.service.ts');
    assert.match(sched, /setInterval\(\(\) => void this\.reminderJob\.tick\(\), DAY_MS\)/);
    assert.match(sched, /setInterval\(\(\) => void this\.suggestionJob\.tick\(\), 7 \* DAY_MS\)/);
    assert.doesNotMatch(sched, /Promise\.all\(companies\.map/, 'no fan-out across every company');
    // Every setInterval in the application goes through a single-flight job (pool diagnostics only snapshot).
    const glob = require('child_process').execSync('git ls-files src', { cwd: require('path').join(__dirname, '..') }).toString().split('\n').filter((f: string) => f.endsWith('.ts'));
    const intervals = glob.filter((f: string) => /setInterval\(/.test(src('../' + f))).sort();
    assert.deepEqual(intervals, ['src/database/pool-diagnostics/pool-diagnostics.service.ts', 'src/safety-alert/safety-alert.service.ts', 'src/scheduler/scheduler.service.ts']);
    // The real sweep through the timer path: two ticks at once start one sweep.
    const [one, two] = await Promise.all([safety.triggerSafetySweep(), safety.triggerSafetySweep()]);
    assert.equal([one, two].filter((o) => o.ran).length, 1);
    assert.equal([one, two].filter((o) => o.skippedBecause === 'previous_run_active').length, 1);
    pass('P2-14 every scheduled job is single-flight (safety sweep every 5 min, reminders daily, suggestions weekly); two simultaneous sweep ticks run one sweep');
  }

  // ── P2-15/16: the safety sweep is unchanged in effect ──────────────────────────────────────────────
  // Scenario per company, identical shapes: a lapsing Welfare run, a partially answered shift, an ended
  // shift with no Book Off, an open Missing Book Off answered by a late Book Off, and a Guard with no
  // compliance checks on a live shift (compliance lapse).
  async function seedSweep(t: Tenant) {
    const [g0, g1, g2] = t.guards;
    const lapsing = await shiftFor(t, { site: t.siteA, guard: g0, job: t.job, start: -305, hours: 10, status: 'in_progress' });
    await attend(lapsing, g0, AttendanceEventType.CHECK_IN, -303);
    const partial = await shiftFor(t, { site: t.siteB, guard: g1, start: -185, hours: 8, status: 'in_progress' });
    await attend(partial, g1, AttendanceEventType.CHECK_IN, -184);
    await log(partial, g1, t.company, DailyLogType.CHECK_CALL, -150);
    await log(partial, g1, t.company, DailyLogType.WELFARE_CHECK, -95);
    const ended = await shiftFor(t, { site: t.siteA, guard: g2, start: -605, hours: 8, status: 'in_progress' });
    await attend(ended, g2, AttendanceEventType.CHECK_IN, -603);
    const late = await shiftFor(t, { site: t.siteB, guard: g1, start: -900, hours: 8, status: 'completed' });
    await attend(late, g1, AttendanceEventType.CHECK_IN, -899);
    await attend(late, g1, AttendanceEventType.CHECK_OUT, -400);
    await alert(late, g1, t.company, SafetyAlertType.MISSING_BOOK_OFF, { priority: SafetyAlertPriority.MEDIUM, message: 'Shift ended - no Book Off recorded.' });
    return { lapsing, partial, ended, late };
  }
  const outcome = async (t: Tenant, shifts: Record<string, any>) => {
    const key = new Map(Object.entries(shifts).map(([k, s]) => [s.id, k]));
    const guardKey = new Map(t.guards.map((g: any, i: number) => [g.id, `g${i}`]));
    const alerts = await ds.query(
      `SELECT id, "shiftId", "guardId", type, priority, status, "welfareWindowIndex", message, "complianceCategory", "complianceReason", "closedAt" IS NOT NULL AS closed
         FROM safety_alerts WHERE "companyId" = $1 ORDER BY "shiftId", type, "welfareWindowIndex" NULLS FIRST, "complianceCategory" NULLS FIRST, id`, [t.company.id]);
    const alertKey = new Map(alerts.map((a: any, i: number) => [a.id, `a${i}`]));
    const audit = await ds.query(`SELECT action, "entityType", "entityId", "afterData" FROM audit_logs WHERE "companyId" = $1 ORDER BY id`, [t.company.id]);
    const notes = await ds.query(`SELECT "userId", type, title, message FROM notifications WHERE "companyId" = $1 ORDER BY id`, [t.company.id]);
    const scrub = (v: any): any => {
      if (Array.isArray(v)) return v.map(scrub);
      if (v && typeof v === 'object') {
        const o: any = {};
        for (const [k, x] of Object.entries(v)) {
          if (k === 'shiftId') o[k] = key.get(x as number) ?? x;
          else if (k === 'guardId') o[k] = guardKey.get(x as number) ?? x;
          else if (k === 'siteId') o[k] = x === t.siteA.id ? 'siteA' : x === t.siteB.id ? 'siteB' : x;
          else if (k === 'checkId' || k === 'detectedAt') o[k] = typeof x;
          else o[k] = scrub(x);
        }
        return o;
      }
      return v;
    };
    return {
      alerts: alerts.map((a: any) => ({ ...a, id: undefined, shiftId: key.get(a.shiftId) ?? a.shiftId, guardId: guardKey.get(a.guardId) ?? a.guardId })),
      audit: audit.map((a: any) => ({ ...a, entityId: a.entityType === 'safety_alert' ? alertKey.get(a.entityId) ?? 'unknown' : a.entityId, afterData: scrub(a.afterData) })),
      notifications: notes.map((n: any) => ({ ...n, userId: n.userId === t.company.user.id ? 'owner' : n.userId })),
    };
  };

  // Freeze the board-fixture shifts out of the sweep (they are in_progress too) by completing them, so the
  // two runs below differ only in which code ran.
  await ds.query(`UPDATE shifts SET status = 'completed' WHERE "companyId" IN ($1, $2) AND status = 'in_progress'`, [A.company.id, B.company.id]);
  const X = await makeTenant('p2x');
  const Y = await makeTenant('p2y');
  const xs = await seedSweep(X);

  // Pre-P2 sweep over X only (Y does not exist yet as sweep work).
  const live = safety as any;
  const realRepos = { shiftRepo: live.shiftRepo, dailyLogRepo: live.dailyLogRepo, attendanceRepo: live.attendanceRepo, safetyAlertRepo: live.safetyAlertRepo };
  Object.assign(live, Object.fromEntries(Object.entries(realRepos).map(([k, r]) => [k, prePhase2(r as any)])));
  const beforeCounts: any = {};
  const welfareBefore = await measure(async () => { beforeCounts.welfare = await safety.runMissedWelfareChecks(); });
  const lapseBefore = await measure(async () => { beforeCounts.lapse = await safety.runComplianceLapseScan(); });
  Object.assign(live, realRepos);
  const xAfterOld = await outcome(X, xs);

  // P2 sweep over Y (and X again, which must change nothing).
  const ys = await seedSweep(Y);
  const afterCounts: any = {};
  const welfareAfter = await measure(async () => { afterCounts.welfare = await safety.runMissedWelfareChecks(); });
  const lapseAfter = await measure(async () => { afterCounts.lapse = await safety.runComplianceLapseScan(); });
  // The P2 run covers both companies' shifts, the pre-P2 run one company's: compared per shift swept.
  const perShift = (m: any, n: number) => ({ ...m, shifts: n, joinsPerShift: +(m.joins / n).toFixed(1), charsPerShift: Math.round(m.chars / n) });
  const wB = perShift(welfareBefore, beforeCounts.welfare.shiftsChecked);
  const wA = perShift(welfareAfter, afterCounts.welfare.shiftsChecked);
  const lB = perShift(lapseBefore, beforeCounts.lapse.shiftsChecked);
  const lA = perShift(lapseAfter, afterCounts.lapse.shiftsChecked);
  const yAfterNew = await outcome(Y, ys);
  const xAfterBoth = await outcome(X, xs);

  assert.ok(beforeCounts.welfare.evidenceCreated >= 6, `the scenario produces real Welfare evidence (${beforeCounts.welfare.evidenceCreated})`);
  assert.ok(beforeCounts.welfare.missingBookOffCreated >= 1 && beforeCounts.welfare.missingBookOffClosed >= 1);
  assert.ok(beforeCounts.lapse.alertsRaised >= 1, 'and a compliance lapse');
  assert.deepEqual(yAfterNew, xAfterOld, 'the P2 sweep writes exactly what the pre-P2 sweep wrote');
  assert.deepEqual(xAfterBoth, xAfterOld, 'and a P2 sweep after a pre-P2 sweep changes nothing (safe across the deploy)');
  // The closed Missing Book Off kept its guard and company: unloaded relations were not nulled on save.
  const [closed] = await ds.query(`SELECT "guardId", "companyId", status FROM safety_alerts WHERE "shiftId" = $1 AND type = 'missing_book_off'`, [ys.late.id]);
  assert.deepEqual(closed, { guardId: Y.guards[1].id, companyId: Y.company.id, status: 'closed' });
  pass(`P2-15 safety sweep: alerts (${yAfterNew.alerts.length}), audit entries (${yAfterNew.audit.length}) and notifications (${yAfterNew.notifications.length}) identical to the pre-P2 sweep; re-running over pre-P2 output is a no-op`);

  // The compliance lapse scan writes everything through its transaction: one connection. The Welfare scan's
  // per-shift transaction holds one while AuditLogService / NotificationService write on a second, as before
  // P2 (moving those writes into the transaction would change audit atomicity: a separate decision). With
  // single-flight sweeps that is a fixed ceiling of two, where overlapping sweeps had no ceiling at all.
  assert.equal(lapseAfter.maxHeld, 1, `compliance lapse scan: one connection (got ${lapseAfter.maxHeld})`);
  assert.ok(welfareAfter.maxHeld <= 2, `welfare scan: at most two (got ${welfareAfter.maxHeld})`);
  assert.ok(wA.joinsPerShift * 3 <= wB.joinsPerShift, `welfare joins per shift ${wB.joinsPerShift} -> ${wA.joinsPerShift}`);
  assert.ok(lA.joinsPerShift * 2 <= lB.joinsPerShift, `lapse joins per shift ${lB.joinsPerShift} -> ${lA.joinsPerShift}`);
  console.log(JSON.stringify({ event: 'p2_sweep_shape', welfare: { before: wB, after: wA }, lapse: { before: lB, after: lA } }));
  pass(`P2-16 sweep: connections held lapse ${lB.maxHeld} -> ${lA.maxHeld}, welfare ${wB.maxHeld} -> ${wA.maxHeld}; per shift swept: JOINs welfare ${wB.joinsPerShift} -> ${wA.joinsPerShift}, lapse ${lB.joinsPerShift} -> ${lA.joinsPerShift}; SQL welfare ${wB.charsPerShift} -> ${wA.charsPerShift} chars`);

  pool.connect = originalConnect;
  pg.Client.prototype.query = originalQuery;
  await app.close();
  await proxy.stop();
  console.log(JSON.stringify({ event: 'perf_stability_p2_certified', tests: passed }));
}

/** P2-04a's child: boot exactly as production does and let Nest decide the exit status. */
async function persistentOutageChild() {
  const emit = (level: string) => (message: unknown, ...rest: unknown[]) => {
    const context = typeof rest[rest.length - 1] === 'string' ? rest[rest.length - 1] : undefined;
    process.stdout.write(`P2CHILD ${JSON.stringify({ level, context, message: typeof message === 'string' ? message : String(message) })}\n`);
  };
  const logger: LoggerService = { log: emit('log'), warn: emit('warn'), error: emit('error'), debug: () => undefined, verbose: () => undefined };
  const { AppModule } = await import('../src/app.module');
  await NestFactory.create(AppModule, { logger });
  process.stdout.write('P2CHILD_STARTED\n');
  process.exit(0);
}

(process.env.P2_CHILD === 'persistent-outage' ? persistentOutageChild() : main()).catch((error) => {
  console.error('FAIL ', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
