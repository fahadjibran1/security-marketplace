/**
 * Pool diagnostics are OFF unless DB_POOL_DIAGNOSTICS is exactly "true" or "1". Every threshold is
 * bounded so a mistyped value can neither flood the logs nor silence them entirely.
 */
export type PoolDiagnosticsConfig = {
  enabled: boolean;
  /** An acquisition that waited at least this long is logged (rate limited). */
  slowAcquireMs: number;
  /** A connection held by one caller at least this long is logged when it is released (rate limited). */
  longHoldMs: number;
  /** How often a pool snapshot is considered; one is written only when there was activity or a waiter. */
  snapshotIntervalMs: number;
  /** Ceiling on detail events per minute across all kinds; the excess is counted, not written. */
  maxEventsPerMinute: number;
  /** A request taking at least this many connections is summarised when it finishes. */
  requestAcquisitionThreshold: number;
};

type Env = Record<string, string | undefined>;

function bounded(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value == null || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function readPoolDiagnosticsConfig(env: Env = process.env): PoolDiagnosticsConfig {
  const flag = (env.DB_POOL_DIAGNOSTICS ?? '').trim().toLowerCase();
  return {
    enabled: flag === 'true' || flag === '1',
    slowAcquireMs: bounded(env.DB_POOL_DIAG_SLOW_ACQUIRE_MS, 500, 50, 60_000),
    longHoldMs: bounded(env.DB_POOL_DIAG_LONG_HOLD_MS, 2_000, 100, 600_000),
    snapshotIntervalMs: bounded(env.DB_POOL_DIAG_SNAPSHOT_MS, 30_000, 5_000, 600_000),
    maxEventsPerMinute: bounded(env.DB_POOL_DIAG_MAX_EVENTS_PER_MIN, 60, 1, 600),
    requestAcquisitionThreshold: bounded(env.DB_POOL_DIAG_REQUEST_ACQUISITIONS, 15, 1, 10_000),
  };
}
