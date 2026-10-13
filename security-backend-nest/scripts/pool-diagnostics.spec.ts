/**
 * Pool diagnostics certification.
 *
 * Exercises src/database/pool-diagnostics against a REAL node-postgres Pool and a REAL TypeORM
 * DataSource on a local, disposable PostgreSQL (no mocks of the pool): acquisition and release,
 * concurrency, saturation, both timeout kinds, rate limiting, fault isolation, request attribution,
 * and — the point of it — that nothing it writes can contain SQL, parameters, credentials or
 * personal data. Also proves the feature is off unless explicitly enabled.
 *
 * Requires POOL_DIAGNOSTICS_DATABASE_URL (localhost only). Nothing is written to any table.
 */
import 'reflect-metadata';
import * as assert from 'assert';
import * as net from 'net';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Pool } = require('pg') as { Pool: any };
import { DataSource } from 'typeorm';
import { readPoolDiagnosticsConfig } from '../src/database/pool-diagnostics/pool-diagnostics.config';
import {
  classifyAcquireError,
  DiagnosticsSink,
  getActivePoolDiagnostics,
  PoolDiagnostics,
  PoolLike,
} from '../src/database/pool-diagnostics/pool-diagnostics';
import {
  currentDbRequestContext,
  matchedRouteTemplate,
  newDbRequestContext,
  runWithDbRequestContext,
  sanitizeRoute,
} from '../src/database/pool-diagnostics/request-context';
import { PoolDiagnosticsService } from '../src/database/pool-diagnostics/pool-diagnostics.service';

const url: string = process.env.POOL_DIAGNOSTICS_DATABASE_URL ?? '';
if (!url) throw new Error('POOL_DIAGNOSTICS_DATABASE_URL is required');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Pool diagnostics database must be local');

let passed = 0;
const pass = (name: string) => {
  passed += 1;
  console.log(`PASS ${name}`);
};

type Line = { level: string; event: string; payload: Record<string, unknown> };
const recorder = () => {
  const lines: Line[] = [];
  const sink: DiagnosticsSink = (level, event, payload) => lines.push({ level, event, payload });
  return { lines, sink, text: () => lines.map((l) => JSON.stringify(l)).join('\n') };
};

const config = (overrides: Partial<ReturnType<typeof readPoolDiagnosticsConfig>> = {}) => ({
  ...readPoolDiagnosticsConfig({ DB_POOL_DIAGNOSTICS: 'true' }),
  ...overrides,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // ── PD-01 off by default; bounded configuration ────────────────────────────────────────────────
  assert.equal(readPoolDiagnosticsConfig({}).enabled, false);
  for (const value of ['', 'false', '0', 'yes', 'on', 'TRUE ']) {
    assert.equal(readPoolDiagnosticsConfig({ DB_POOL_DIAGNOSTICS: value }).enabled, value.trim().toLowerCase() === 'true', value);
  }
  assert.equal(readPoolDiagnosticsConfig({ DB_POOL_DIAGNOSTICS: '1' }).enabled, true);
  const clamped = readPoolDiagnosticsConfig({
    DB_POOL_DIAGNOSTICS: 'true',
    DB_POOL_DIAG_SLOW_ACQUIRE_MS: '1',
    DB_POOL_DIAG_MAX_EVENTS_PER_MIN: '999999',
    DB_POOL_DIAG_SNAPSHOT_MS: 'abc',
  });
  assert.equal(clamped.slowAcquireMs, 50);
  assert.equal(clamped.maxEventsPerMinute, 600);
  assert.equal(clamped.snapshotIntervalMs, 30_000);
  pass('PD-01 diagnostics are OFF unless DB_POOL_DIAGNOSTICS is "true"/"1"; thresholds are bounded');

  // ── PD-02 the service does nothing when disabled ───────────────────────────────────────────────
  {
    const ds = new DataSource({ type: 'postgres', url, extra: { max: 2 } });
    await ds.initialize();
    const pool = (ds.driver as any).master as PoolLike;
    const connectBefore = pool.connect;
    const listenersBefore = ['connect', 'acquire', 'release', 'remove', 'error'].map((e) => (pool as any).listenerCount(e));
    delete process.env.DB_POOL_DIAGNOSTICS;
    const service = new PoolDiagnosticsService(ds);
    service.onApplicationBootstrap();
    assert.equal(pool.connect, connectBefore, 'connect untouched when disabled');
    assert.deepEqual(['connect', 'acquire', 'release', 'remove', 'error'].map((e) => (pool as any).listenerCount(e)), listenersBefore);
    assert.equal(getActivePoolDiagnostics(), null);

    // Enabled: attaches, and onModuleDestroy restores the pool exactly.
    process.env.DB_POOL_DIAGNOSTICS = 'true';
    const enabled = new PoolDiagnosticsService(ds);
    enabled.onApplicationBootstrap();
    assert.notEqual(pool.connect, connectBefore);
    assert.ok(getActivePoolDiagnostics());
    await ds.query('SELECT 1');
    enabled.onModuleDestroy();
    assert.equal(pool.connect, connectBefore, 'connect restored on destroy');
    assert.deepEqual(['connect', 'acquire', 'release', 'remove', 'error'].map((e) => (pool as any).listenerCount(e)), listenersBefore);
    assert.equal(getActivePoolDiagnostics(), null);
    delete process.env.DB_POOL_DIAGNOSTICS;
    await ds.destroy();
  }
  pass('PD-02 disabled: no hooks, no listeners, no timer; enabled then destroyed: pool restored exactly');

  // ── PD-03 acquire and release are measured and attributed to the request ───────────────────────
  {
    const pool = new Pool({ connectionString: url, max: 3 });
    const rec = recorder();
    const diag = new PoolDiagnostics(pool as unknown as PoolLike, config({ requestAcquisitionThreshold: 2 }), rec.sink).attach();
    const ctx = newDbRequestContext('req-pd03', 'GET', sanitizeRoute('/compliance/statuses?status=valid'));
    await runWithDbRequestContext(ctx, async () => {
      assert.equal(currentDbRequestContext(), ctx);
      await pool.query('SELECT 1');
      const client = await pool.connect();
      await client.query('SELECT 2');
      client.release();
    });
    assert.equal(ctx.acquisitions, 2);
    assert.equal(ctx.held, 0, 'every acquisition was released');
    assert.equal(ctx.failures, 0);
    assert.equal(ctx.route, '/compliance/statuses');
    const state = diag.poolState();
    assert.equal(state.inUse, 0);
    diag.requestFinished(ctx, 200, 5);
    const summary = rec.lines.find((l) => l.event === 'db_pool_request_summary');
    assert.ok(summary, 'a request at the acquisition threshold is summarised');
    assert.equal(summary!.payload.requestId, 'req-pd03');
    assert.equal(summary!.payload.acquisitions, 2);
    const snap = diag.snapshot()!;
    assert.equal(snap.acquisitions, 2);
    assert.ok((snap.newConnections as number) >= 1, 'a new physical connection was timed');
    assert.ok((snap.freshConnectionAcquisitions as number) >= 1, 'the first caller is attributed to opening a connection');
    diag.detach();
    await pool.end();
  }
  pass('PD-03 acquisition, hold and release recorded and attributed to the request; new connection timed');

  // ── PD-04 concurrency: queueing and per-request parallelism are visible ────────────────────────
  {
    const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5_000 });
    // Warm both slots first, so every slow acquisition below is a queue wait rather than a slow first
    // connection (which is measured separately, and is timing-dependent on a cold database).
    const warm = await Promise.all([pool.connect(), pool.connect()]);
    warm.forEach((client: any) => client.release());
    const rec = recorder();
    const diag = new PoolDiagnostics(pool as unknown as PoolLike, config({ slowAcquireMs: 100 }), rec.sink).attach();
    const ctx = newDbRequestContext('req-pd04', 'GET', '/coverage/shifts');
    let sawWaiting = 0;
    await runWithDbRequestContext(ctx, async () => {
      const work = Array.from({ length: 6 }, () => pool.query('SELECT pg_sleep(0.15)'));
      await sleep(30);
      sawWaiting = pool.waitingCount;
      await Promise.all(work);
    });
    assert.ok(sawWaiting >= 3, `callers queued behind a full pool (saw ${sawWaiting})`);
    assert.equal(ctx.acquisitions, 6);
    assert.equal(ctx.maxConcurrentHeld, 2, 'never more held than the pool size');
    assert.ok(ctx.maxWaitMs >= 250, `the last caller waited for two rounds (${ctx.maxWaitMs}ms)`);
    const slow = rec.lines.filter((l) => l.event === 'db_pool_slow_acquire');
    assert.ok(slow.length >= 2, 'slow acquisitions are reported');
    assert.ok(slow.every((l) => l.payload.cause === 'pool_busy'), 'attributed to a busy pool, not to opening connections');
    const snap = diag.snapshot()!;
    assert.ok((snap.busyPoolWaits as number) >= 3);
    assert.equal(snap.freshConnectionAcquisitions, 0, "the pool was warm: no connection was opened");
    diag.detach();
    await pool.end();
  }
  pass('PD-04 concurrent requests: queueing, waits and per-request parallelism are measured');

  // ── PD-05 saturation: the queue timeout is classified and attributed ───────────────────────────
  {
    const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 200 });
    const rec = recorder();
    const diag = new PoolDiagnostics(pool as unknown as PoolLike, config(), rec.sink).attach();
    const holder = await pool.connect();
    const ctx = newDbRequestContext('req-pd05', 'POST', '/auth/refresh');
    let error: Error | null = null;
    await runWithDbRequestContext(ctx, async () => {
      try {
        await pool.query('SELECT 1');
      } catch (e) {
        error = e as Error;
      }
    });
    assert.equal(error!?.message, 'timeout exceeded when trying to connect', 'the exact production error');
    const failed = rec.lines.find((l) => l.event === 'db_pool_acquire_failed');
    assert.ok(failed);
    assert.equal(failed!.payload.kind, 'queue_timeout');
    assert.equal(failed!.payload.route, '/auth/refresh');
    assert.equal(ctx.failures, 1);
    assert.equal((failed!.payload.pool as any).inUse, 1);
    holder.release();
    const snap = diag.snapshot()!;
    assert.equal((snap.failures as any).queue_timeout, 1);
    diag.detach();
    await pool.end();
  }
  pass('PD-05 pool saturation: "timeout exceeded when trying to connect" is classified queue_timeout and attributed');

  // ── PD-06 slow connection establishment and connect errors are told apart ───────────────────────
  {
    // A server that accepts TCP but never answers: the new-client connect timeout fires.
    const accepted: net.Socket[] = [];
    const blackhole = net.createServer((socket) => {
      accepted.push(socket);
    });
    await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
    const port = (blackhole.address() as net.AddressInfo).port;
    const pool = new Pool({ host: '127.0.0.1', port, user: 'nobody', database: 'none', max: 1, connectionTimeoutMillis: 200 });
    const rec = recorder();
    const diag = new PoolDiagnostics(pool as unknown as PoolLike, config(), rec.sink).attach();
    await assert.rejects(pool.query('SELECT 1'));
    const failed = rec.lines.find((l) => l.event === 'db_pool_acquire_failed');
    assert.equal(failed?.payload.kind, 'connect_timeout');
    diag.detach();
    await pool.end();
    accepted.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => blackhole.close(() => resolve()));

    // Nothing listening: a driver error code, never its message (which can carry a host and port).
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedPort = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const refused = new Pool({ host: '127.0.0.1', port: closedPort, user: 'nobody', database: 'none', max: 1, connectionTimeoutMillis: 1000 });
    const rec2 = recorder();
    const diag2 = new PoolDiagnostics(refused as unknown as PoolLike, config(), rec2.sink).attach();
    await assert.rejects(refused.query('SELECT 1'));
    const refusedLine = rec2.lines.find((l) => l.event === 'db_pool_acquire_failed');
    assert.equal(refusedLine?.payload.kind, 'connect_error');
    assert.equal(refusedLine?.payload.code, 'ECONNREFUSED');
    assert.ok(!rec2.text().includes(String(closedPort)), 'no host/port from the driver message');
    diag2.detach();
    await refused.end();

    assert.deepEqual(classifyAcquireError(new Error('timeout exceeded when trying to connect')), { kind: 'queue_timeout', code: null });
    assert.equal(classifyAcquireError(new Error('Connection terminated due to connection timeout')).kind, 'connect_timeout');
    assert.deepEqual(classifyAcquireError(Object.assign(new Error('x'), { code: 'not a safe code; DROP' })), { kind: 'other', code: null });
  }
  pass('PD-06 slow/failed connection establishment is distinguished from queue saturation; only safe codes logged');

  // ── PD-07 long holds are reported with the holder; transactions hold one connection throughout ──
  {
    const ds = new DataSource({ type: 'postgres', url, extra: { max: 4 } });
    await ds.initialize();
    const rec = recorder();
    const diag = new PoolDiagnostics((ds.driver as any).master, config({ longHoldMs: 150 }), rec.sink).attach();
    const ctx = newDbRequestContext('req-pd07', 'PATCH', sanitizeRoute('/rota-slots/42/time'));
    await runWithDbRequestContext(ctx, () =>
      ds.transaction(async (manager) => {
        await manager.query('SELECT 1');
        await sleep(200);
        await manager.query('SELECT 2');
      }),
    );
    const long = rec.lines.find((l) => l.event === 'db_pool_long_hold');
    assert.ok(long, 'a transaction held past the threshold is reported');
    assert.equal(long!.payload.route, '/rota-slots/:id/time');
    assert.equal(long!.payload.requestId, 'req-pd07');
    assert.ok((long!.payload.heldMs as number) >= 190);
    assert.equal(ctx.acquisitions, 1, 'a transaction is ONE acquisition held for its whole duration');
    diag.detach();
    await ds.destroy();
  }
  pass('PD-07 long-held connections are reported with request id and route template');

  // ── PD-08 nothing sensitive can reach the log ─────────────────────────────────────────────────
  {
    const secretSia = '1234567890123456';
    const secretShareCode = 'W9X8Y7Z6A';
    const secretEmail = 'jane.doe@example.test';
    const secretName = 'Jane Q Guardperson';
    const parsed = new URL(url);
    const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1_000 });
    const rec = recorder();
    const diag = new PoolDiagnostics(pool as unknown as PoolLike, config({ slowAcquireMs: 50, longHoldMs: 50, requestAcquisitionThreshold: 2 }), rec.sink).attach();
    const ctx = newDbRequestContext(
      'req-pd08',
      'GET',
      sanitizeRoute(`/compliance/guards/77/checks/${secretShareCode}XYZ0123456789?sia=${secretSia}&email=${secretEmail}`),
    );
    await runWithDbRequestContext(ctx, async () => {
      const held = await pool.connect();
      await held.query(`SELECT $1::text AS sia, $2::text AS name, '${secretShareCode}' AS share, pg_sleep(0.1)`, [secretSia, secretName]);
      await assert.rejects(pool.query('SELECT $1::text', [secretEmail])); // queue timeout while held
      held.release();
    });
    diag.requestFinished(ctx, 500, 400);
    diag.snapshot(true);
    const everything = rec.text();
    assert.ok(rec.lines.length >= 4, 'events were written');
    for (const forbidden of [secretSia, secretShareCode, secretEmail, secretName, 'SELECT', 'pg_sleep', parsed.username, parsed.host, url]) {
      if (!forbidden) continue;
      assert.ok(!everything.includes(forbidden), `log must not contain ${forbidden === url ? 'the connection string' : JSON.stringify(forbidden)}`);
    }
    diag.detach();
    await pool.end();

    assert.equal(sanitizeRoute('/auth/verify-email?token=AbCdEfGhIjKlMnOpQrStUv'), '/auth/verify-email');
    assert.equal(sanitizeRoute('/auth/reset-password/AbCdEfGhIjKlMnOpQrStUv123'), '/auth/reset-password/:value');
    assert.equal(sanitizeRoute('/guards/123/documents/9'), '/guards/:id/documents/:id');
    assert.equal(sanitizeRoute('/x/550e8400-e29b-41d4-a716-446655440000'), '/x/:uuid');
    assert.equal(sanitizeRoute(`/users/${secretEmail}`), '/users/:value');
    assert.equal(matchedRouteTemplate({ baseUrl: '', route: { path: '/rota-slots/:id/assign' } }), '/rota-slots/:id/assign');
    assert.equal(matchedRouteTemplate({}), null);
  }
  pass('PD-08 no SQL, parameters, SIA numbers, share codes, emails, names, hosts or credentials in any output');

  // ── PD-09 rate limiting: bounded output, the excess is counted ────────────────────────────────
  {
    let clock = 1_000_000;
    const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 400 });
    const rec = recorder();
    const diag = new PoolDiagnostics(pool as unknown as PoolLike, config({ maxEventsPerMinute: 3 }), rec.sink, () => clock).attach();
    const held = await pool.connect();
    for (let i = 0; i < 10; i += 1) await assert.rejects(pool.query('SELECT 1'));
    held.release();
    assert.equal(rec.lines.filter((l) => l.event === 'db_pool_acquire_failed').length, 3, 'capped at 3 per minute');
    const snap = diag.snapshot()!;
    assert.equal(snap.suppressedEvents, 7);
    assert.equal((snap.failures as any).queue_timeout, 10, 'every failure still counted');
    clock += 60_000;
    await assert.rejects((async () => {
      const again = await pool.connect();
      try {
        await pool.query('SELECT 1');
      } finally {
        again.release();
      }
    })());
    assert.equal(rec.lines.filter((l) => l.event === 'db_pool_acquire_failed').length, 4, 'budget renews each minute');
    diag.detach();
    await pool.end();
  }
  pass('PD-09 detail events are rate limited; suppressed ones are counted in the snapshot');

  // ── PD-10 a failing sink can never break a query; idle pools stay silent ──────────────────────
  {
    const pool = new Pool({ connectionString: url, max: 2 });
    const diag = new PoolDiagnostics(pool as unknown as PoolLike, config({ slowAcquireMs: 50, longHoldMs: 50, requestAcquisitionThreshold: 2 }), () => {
      throw new Error('sink failure');
    }).attach();
    const ctx = newDbRequestContext('req-pd10', 'GET', '/health/ready');
    const rows = await runWithDbRequestContext(ctx, async () => {
      const results = await Promise.all([pool.query('SELECT 41 + 1 AS n'), pool.query('SELECT pg_sleep(0.08), 7 AS n')]);
      return results.map((r: any) => Number(r.rows[0].n));
    });
    assert.deepEqual(rows, [42, 7]);
    assert.doesNotThrow(() => diag.requestFinished(ctx, 200, 100));
    diag.detach();

    const rec = recorder();
    const quiet = new PoolDiagnostics(pool as unknown as PoolLike, config(), rec.sink).attach();
    assert.equal(quiet.snapshot(), null, 'no activity, no waiters: nothing written');
    assert.equal(rec.lines.length, 0);
    quiet.detach();
    await pool.end();
  }
  pass('PD-10 a faulty sink never affects queries; an idle pool writes nothing');

  // ── PD-11 background work (sweeps) is labelled, not attributed to a request ───────────────────
  {
    const pool = new Pool({ connectionString: url, max: 2 });
    const rec = recorder();
    const diag = new PoolDiagnostics(pool as unknown as PoolLike, config(), rec.sink).attach();
    await pool.query('SELECT 1');
    const snap = diag.snapshot()!;
    const routes = (snap.topRoutesByHold as Array<{ route: string }>).map((r) => r.route);
    assert.deepEqual(routes, ['background']);
    diag.detach();
    await pool.end();
  }
  pass('PD-11 acquisitions outside a request are reported as background');

  console.log(JSON.stringify({ event: 'pool_diagnostics_certified', tests: passed }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
