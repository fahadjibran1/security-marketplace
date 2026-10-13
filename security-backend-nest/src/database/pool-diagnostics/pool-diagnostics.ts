import { currentDbRequestContext, DbRequestContext } from './request-context';
import { PoolDiagnosticsConfig } from './pool-diagnostics.config';

/**
 * Privacy-safe instrumentation of a node-postgres Pool.
 *
 * Measures, per acquisition: how long the caller waited, whether a new physical connection had to be
 * opened (and how long that took), how long the connection was then held, and which request or job
 * held it. Never sees or logs SQL text, parameters, results, credentials or connection strings —
 * only counts, durations, a sanitised route, an opaque request id and driver error codes.
 *
 * Fail-safe: every hook is wrapped so that a fault in the diagnostics can never alter, delay or fail
 * a database call. Detach restores the pool's own methods exactly.
 */

export type PoolLike = {
  connect: (...args: any[]) => any;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  removeListener: (event: string, listener: (...args: any[]) => void) => unknown;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  options?: { max?: number; connectionTimeoutMillis?: number; idleTimeoutMillis?: number };
  newClient?: (...args: any[]) => any;
  _clients?: unknown[];
};

export type DiagnosticsLevel = 'log' | 'warn';
export type DiagnosticsSink = (level: DiagnosticsLevel, event: string, payload: Record<string, unknown>) => void;

export type AcquireFailureKind = 'queue_timeout' | 'connect_timeout' | 'connect_error' | 'other';

type Holder = { since: number; context: DbRequestContext | undefined; route: string; requestId: string | null };

const BACKGROUND_ROUTE = 'background';
const SAMPLE_LIMIT = 2_000;
const SAFE_CODE = /^[A-Z0-9_]{1,24}$/;
/** A reused client obtained after at least this long counts as a wait for a busy pool. */
const BUSY_WAIT_FLOOR_MS = 20;

export function classifyAcquireError(error: unknown): { kind: AcquireFailureKind; code: string | null } {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const rawCode = (error as { code?: unknown } | null)?.code;
  const code = typeof rawCode === 'string' && SAFE_CODE.test(rawCode) ? rawCode : null;
  if (message === 'timeout exceeded when trying to connect') return { kind: 'queue_timeout', code };
  if (message.startsWith('Connection terminated due to connection timeout')) return { kind: 'connect_timeout', code };
  if (code) return { kind: 'connect_error', code };
  return { kind: 'other', code: null };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function pushSample(samples: number[], value: number) {
  if (samples.length < SAMPLE_LIMIT) samples.push(value);
  else samples[Math.floor(Math.random() * SAMPLE_LIMIT)] = value;
}

export class PoolDiagnostics {
  private readonly holders = new Map<object, Holder>();
  private readonly connectingSince = new WeakMap<object, number>();
  /** Clients just opened and not yet handed to their caller. */
  private readonly freshClients = new WeakSet<object>();
  private readonly listeners: Array<[string, (...args: any[]) => void]> = [];
  private originalConnect: PoolLike['connect'] | null = null;
  private originalNewClient: PoolLike['newClient'] | null = null;
  private attached = false;

  private window: ReturnType<PoolDiagnostics['emptyWindow']>;
  private eventBudget: { minute: number; used: number } = { minute: -1, used: 0 };
  private suppressed = 0;

  constructor(
    private readonly pool: PoolLike,
    private readonly config: PoolDiagnosticsConfig,
    private readonly sink: DiagnosticsSink,
    private readonly now: () => number = Date.now,
  ) {
    this.window = this.emptyWindow();
  }

  attach(): this {
    if (this.attached) return this;
    const pool = this.pool;
    const self = this;

    this.originalConnect = pool.connect;
    const originalConnect = pool.connect;
    pool.connect = function diagnosedConnect(this: unknown, ...args: any[]) {
      let begin: ReturnType<PoolDiagnostics['beginAcquire']> | null = null;
      try {
        begin = self.beginAcquire();
      } catch {
        begin = null;
      }
      const callback = typeof args[0] === 'function' ? args[0] : null;
      if (callback) {
        return originalConnect.call(pool, (err: unknown, client: any, release: unknown) => {
          self.safely(() => self.finishAcquire(begin, err, client));
          return callback(err, client, release);
        });
      }
      const result = originalConnect.apply(pool, args as []);
      if (result && typeof result.then === 'function') {
        return result.then(
          (client: any) => {
            self.safely(() => self.finishAcquire(begin, null, client));
            return client;
          },
          (err: unknown) => {
            self.safely(() => self.finishAcquire(begin, err, null));
            throw err;
          },
        );
      }
      return result;
    };

    // Opening a physical connection (TLS + authentication through the pooler) is timed separately
    // from waiting for a free one; the two have different fixes.
    if (typeof pool.newClient === 'function' && Array.isArray(pool._clients)) {
      this.originalNewClient = pool.newClient;
      const originalNewClient = pool.newClient;
      pool.newClient = function diagnosedNewClient(this: unknown, ...args: any[]) {
        const before = pool._clients ? pool._clients.length : 0;
        const startedAt = self.now();
        const result = originalNewClient.apply(pool, args);
        self.safely(() => {
          const clients = pool._clients ?? [];
          const created = clients.length > before ? clients[clients.length - 1] : null;
          if (created && typeof created === 'object') self.connectingSince.set(created, startedAt);
          self.window.newConnectionsStarted += 1;
        });
        return result;
      };
    }

    this.listen('connect', (client: object) => {
      this.freshClients.add(client);
      const startedAt = this.connectingSince.get(client);
      if (startedAt == null) return;
      this.connectingSince.delete(client);
      const ms = this.now() - startedAt;
      this.window.newConnections += 1;
      pushSample(this.window.establishMs, ms);
    });
    this.listen('release', (_err: unknown, client: object) => this.finishHold(client));
    this.listen('remove', (client: object) => {
      this.window.removed += 1;
      // A client removed while still checked out (error during use) ends its hold here.
      if (this.holders.has(client)) this.finishHold(client);
    });
    this.listen('error', (error: unknown) => {
      this.window.idleClientErrors += 1;
      const { code } = classifyAcquireError(error);
      this.emit('warn', 'db_pool_idle_client_error', { code, pool: this.poolState() });
    });

    this.attached = true;
    return this;
  }

  detach() {
    if (!this.attached) return;
    if (this.originalConnect) this.pool.connect = this.originalConnect;
    if (this.originalNewClient) this.pool.newClient = this.originalNewClient;
    for (const [event, listener] of this.listeners) this.pool.removeListener(event, listener);
    this.listeners.length = 0;
    this.holders.clear();
    this.attached = false;
  }

  /** Current pool numbers plus the longest connection still checked out. */
  poolState() {
    const options = this.pool.options ?? {};
    let oldest: Holder | null = null;
    for (const holder of this.holders.values()) {
      if (!oldest || holder.since < oldest.since) oldest = holder;
    }
    return {
      max: options.max ?? null,
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
      inUse: this.holders.size,
      longestHeldMs: oldest ? this.now() - oldest.since : 0,
      longestHeldRoute: oldest?.route ?? null,
      longestHeldRequestId: oldest?.requestId ?? null,
    };
  }

  /**
   * Called on the snapshot timer. Writes one line only if the pool did something since the last one
   * or a caller is waiting right now, so an idle service stays silent.
   */
  snapshot(force = false): Record<string, unknown> | null {
    const state = this.poolState();
    const w = this.window;
    const active =
      w.acquisitions > 0 || w.failures.total > 0 || w.idleClientErrors > 0 || state.waiting > 0 || state.inUse > 0;
    if (!active && !force && this.suppressed === 0) return null;

    const waits = [...w.waitMs].sort((a, b) => a - b);
    const holds = [...w.holdMs].sort((a, b) => a - b);
    const establish = [...w.establishMs].sort((a, b) => a - b);
    const topRoutes = [...w.byRoute.entries()]
      .sort((a, b) => b[1].holdMs - a[1].holdMs)
      .slice(0, 5)
      .map(([route, stats]) => ({ route, ...stats }));

    const payload = {
      windowMs: this.now() - w.startedAt,
      pool: state,
      acquisitions: w.acquisitions,
      freshConnectionAcquisitions: w.freshConnectionAcquisitions,
      busyPoolWaits: w.busyPoolWaits,
      waitMs: { p50: percentile(waits, 50), p95: percentile(waits, 95), max: waits[waits.length - 1] ?? 0 },
      holdMs: { p50: percentile(holds, 50), p95: percentile(holds, 95), max: holds[holds.length - 1] ?? 0 },
      newConnectionsStarted: w.newConnectionsStarted,
      newConnections: w.newConnections,
      establishMs: { p50: percentile(establish, 50), p95: percentile(establish, 95), max: establish[establish.length - 1] ?? 0 },
      removed: w.removed,
      failures: w.failures,
      idleClientErrors: w.idleClientErrors,
      slowAcquisitions: w.slowAcquisitions,
      longHolds: w.longHolds,
      suppressedEvents: this.suppressed,
      topRoutesByHold: topRoutes,
    };
    this.window = this.emptyWindow();
    this.suppressed = 0;
    this.sink(state.waiting > 0 || payload.failures.total > 0 ? 'warn' : 'log', 'db_pool_snapshot', payload);
    return payload;
  }

  /** Per-request summary, written when the request was connection-hungry, slow to get one, or failed to. */
  requestFinished(context: DbRequestContext, statusCode: number, durationMs: number) {
    const heavy = context.acquisitions >= this.config.requestAcquisitionThreshold;
    const slow = context.totalWaitMs >= this.config.slowAcquireMs;
    const parallel = context.maxConcurrentHeld >= 3;
    if (!heavy && !slow && !parallel && context.failures === 0) return;
    this.emit(context.failures > 0 ? 'warn' : 'log', 'db_pool_request_summary', {
      requestId: context.requestId,
      method: context.method,
      route: context.route,
      statusCode,
      durationMs,
      acquisitions: context.acquisitions,
      totalWaitMs: context.totalWaitMs,
      maxWaitMs: context.maxWaitMs,
      totalHoldMs: context.totalHoldMs,
      maxConcurrentHeld: context.maxConcurrentHeld,
      failures: context.failures,
    });
  }

  // ───────────────────────────────────────── internals ─────────────────────────────────────────

  private beginAcquire() {
    const context = currentDbRequestContext();
    const pool = this.pool;
    return { startedAt: this.now(), context, stateAtRequest: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } };
  }

  private finishAcquire(begin: ReturnType<PoolDiagnostics['beginAcquire']> | null, err: unknown, client: any) {
    if (!begin) return;
    const waitedMs = this.now() - begin.startedAt;
    const context = begin.context;
    const route = context?.route ?? BACKGROUND_ROUTE;
    const requestId = context?.requestId ?? null;
    const w = this.window;

    if (err || !client) {
      const { kind, code } = classifyAcquireError(err);
      w.failures.total += 1;
      w.failures[kind] += 1;
      if (context) context.failures += 1;
      this.emit('warn', 'db_pool_acquire_failed', {
        kind,
        code,
        requestId,
        route,
        waitedMs,
        poolAtRequest: begin.stateAtRequest,
        pool: this.poolState(),
      });
      return;
    }

    // Why the caller waited, decided by what actually happened rather than by the pool's counters at
    // request time (pg-pool hands idle clients out on the next tick, so counters mislead in a burst):
    // a client opened for this caller means the wait was connection establishment; any other client
    // means the caller waited for one that was busy.
    const freshConnection = typeof client === 'object' && this.freshClients.has(client);
    if (freshConnection) this.freshClients.delete(client);
    const cause = freshConnection ? 'new_connection' : 'pool_busy';
    w.acquisitions += 1;
    if (freshConnection) w.freshConnectionAcquisitions += 1;
    else if (waitedMs >= BUSY_WAIT_FLOOR_MS) w.busyPoolWaits += 1;
    pushSample(w.waitMs, waitedMs);
    if (context) {
      context.acquisitions += 1;
      context.totalWaitMs += waitedMs;
      context.maxWaitMs = Math.max(context.maxWaitMs, waitedMs);
      context.held += 1;
      context.maxConcurrentHeld = Math.max(context.maxConcurrentHeld, context.held);
    }
    if (typeof client === 'object') this.holders.set(client, { since: this.now(), context, route, requestId });

    if (waitedMs >= this.config.slowAcquireMs) {
      w.slowAcquisitions += 1;
      this.emit('warn', 'db_pool_slow_acquire', {
        requestId,
        route,
        waitedMs,
        cause,
        poolAtRequest: begin.stateAtRequest,
        pool: this.poolState(),
      });
    }
  }

  private finishHold(client: object) {
    const holder = this.holders.get(client);
    if (!holder) return;
    this.holders.delete(client);
    const heldMs = this.now() - holder.since;
    const w = this.window;
    pushSample(w.holdMs, heldMs);
    const routeStats = w.byRoute.get(holder.route) ?? { acquisitions: 0, holdMs: 0, maxHoldMs: 0 };
    routeStats.acquisitions += 1;
    routeStats.holdMs += heldMs;
    routeStats.maxHoldMs = Math.max(routeStats.maxHoldMs, heldMs);
    if (w.byRoute.size < 200 || w.byRoute.has(holder.route)) w.byRoute.set(holder.route, routeStats);
    if (holder.context) {
      holder.context.totalHoldMs += heldMs;
      holder.context.held = Math.max(0, holder.context.held - 1);
    }
    if (heldMs >= this.config.longHoldMs) {
      w.longHolds += 1;
      this.emit('warn', 'db_pool_long_hold', {
        requestId: holder.requestId,
        route: holder.route,
        heldMs,
        pool: this.poolState(),
      });
    }
  }

  private emit(level: DiagnosticsLevel, event: string, payload: Record<string, unknown>) {
    const minute = Math.floor(this.now() / 60_000);
    if (this.eventBudget.minute !== minute) this.eventBudget = { minute, used: 0 };
    if (this.eventBudget.used >= this.config.maxEventsPerMinute) {
      this.suppressed += 1;
      return;
    }
    this.eventBudget.used += 1;
    this.safely(() => this.sink(level, event, payload));
  }

  private listen(event: string, handler: (...args: any[]) => void) {
    const listener = (...args: any[]) => this.safely(() => handler(...args));
    this.pool.on(event, listener);
    this.listeners.push([event, listener]);
  }

  private safely(fn: () => void) {
    try {
      fn();
    } catch {
      // Diagnostics must never affect the database call they observe.
    }
  }

  private emptyWindow() {
    return {
      startedAt: this.now(),
      acquisitions: 0,
      freshConnectionAcquisitions: 0,
      busyPoolWaits: 0,
      waitMs: [] as number[],
      holdMs: [] as number[],
      establishMs: [] as number[],
      newConnectionsStarted: 0,
      newConnections: 0,
      removed: 0,
      failures: { total: 0, queue_timeout: 0, connect_timeout: 0, connect_error: 0, other: 0 },
      idleClientErrors: 0,
      slowAcquisitions: 0,
      longHolds: 0,
      byRoute: new Map<string, { acquisitions: number; holdMs: number; maxHoldMs: number }>(),
    };
  }
}

let active: PoolDiagnostics | null = null;

export function setActivePoolDiagnostics(diagnostics: PoolDiagnostics | null) {
  active = diagnostics;
}

export function getActivePoolDiagnostics(): PoolDiagnostics | null {
  return active;
}
