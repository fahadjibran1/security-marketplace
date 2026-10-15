import { Logger } from '@nestjs/common';

/**
 * Bounded database connection retries at start-up (Performance P2).
 *
 * Until P2 the backend was configured with `retryAttempts: 1`, which in @nestjs/typeorm means ONE attempt
 * and no retry: a single slow or refused connection while the process was starting made it exit with
 * status 1, and Render answered with 502s until the next restart (S4 P1 incident, 14 Oct 2026, 23:36 UTC).
 *
 * The rules:
 *  - a bounded number of attempts with a fixed delay between them, both configurable and both clamped,
 *    so a misconfiguration can neither disable retries silently nor make the process retry forever;
 *  - only failures that can plausibly clear on their own are retried (timeouts, refused or reset
 *    connections, DNS hiccups, a pooler or server that is full or starting up). A wrong password, a missing
 *    database or a schema/metadata error fails on the first attempt, exactly as before;
 *  - when the last attempt fails the original error is rethrown and the process still exits non-zero;
 *  - every failed attempt is logged as one JSON line naming a category and error code only. No message
 *    text, host, user or connection string is ever written by this module.
 *
 * @nestjs/typeorm still logs its own "Unable to connect to the database. Retrying (n)..." line with the
 * driver's stack; that line is unchanged from before P2.
 */

export const CONNECT_ATTEMPTS_DEFAULT = 5;
export const CONNECT_ATTEMPTS_MIN = 1;
export const CONNECT_ATTEMPTS_MAX = 10;
export const CONNECT_RETRY_DELAY_MS_DEFAULT = 3000;
export const CONNECT_RETRY_DELAY_MS_MIN = 250;
export const CONNECT_RETRY_DELAY_MS_MAX = 30000;

export interface ConnectRetryConfig {
  /** Total connection attempts, including the first. */
  attempts: number;
  /** Fixed wait between attempts. */
  delayMs: number;
}

function bounded(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value == null || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function readConnectRetryConfig(env: {
  DATABASE_CONNECT_ATTEMPTS?: string;
  DATABASE_CONNECT_RETRY_DELAY_MS?: string;
}): ConnectRetryConfig {
  return {
    attempts: bounded(env.DATABASE_CONNECT_ATTEMPTS, CONNECT_ATTEMPTS_DEFAULT, CONNECT_ATTEMPTS_MIN, CONNECT_ATTEMPTS_MAX),
    delayMs: bounded(
      env.DATABASE_CONNECT_RETRY_DELAY_MS,
      CONNECT_RETRY_DELAY_MS_DEFAULT,
      CONNECT_RETRY_DELAY_MS_MIN,
      CONNECT_RETRY_DELAY_MS_MAX,
    ),
  };
}

export type ConnectFailureCategory =
  | 'timeout'
  | 'refused'
  | 'reset'
  | 'dns'
  | 'unreachable'
  | 'server_busy'
  | 'authentication'
  | 'configuration'
  | 'other';

const NETWORK_CODES: Record<string, ConnectFailureCategory> = {
  ETIMEDOUT: 'timeout',
  ECONNREFUSED: 'refused',
  ECONNRESET: 'reset',
  EPIPE: 'reset',
  EAI_AGAIN: 'dns',
  ENOTFOUND: 'dns',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
};

const SQLSTATE: Record<string, ConnectFailureCategory> = {
  '57P03': 'server_busy', // cannot_connect_now (starting up / shutting down)
  '53300': 'server_busy', // too_many_connections
  '08000': 'reset',
  '08001': 'refused',
  '08003': 'reset',
  '08004': 'refused',
  '08006': 'reset',
  '28P01': 'authentication', // invalid_password
  '28000': 'authentication', // invalid_authorization_specification
  '3D000': 'configuration', // invalid_catalog_name (database does not exist)
};

const TRANSIENT: ReadonlySet<ConnectFailureCategory> = new Set([
  'timeout',
  'refused',
  'reset',
  'dns',
  'unreachable',
  'server_busy',
]);

// Messages produced by pg / pg-pool / Supavisor that carry no code. Matched, never logged.
const MESSAGE_PATTERNS: Array<[RegExp, ConnectFailureCategory]> = [
  [/timeout exceeded when trying to connect/i, 'timeout'],
  [/connection timeout/i, 'timeout'],
  [/Connection terminated/i, 'reset'],
  [/server closed the connection unexpectedly/i, 'reset'],
  [/Max client connections reached|too many clients|remaining connection slots/i, 'server_busy'],
  [/Tenant or user not found|password authentication failed/i, 'authentication'],
];

export function classifyConnectError(error: unknown): { category: ConnectFailureCategory; code: string | null; transient: boolean } {
  const err = (error ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof err.code === 'string' && /^[A-Z0-9_]{2,20}$/.test(err.code) ? err.code : null;
  let category: ConnectFailureCategory = 'other';
  if (code && NETWORK_CODES[code]) category = NETWORK_CODES[code];
  else if (code && SQLSTATE[code]) category = SQLSTATE[code];
  else {
    const message = typeof err.message === 'string' ? err.message : '';
    const match = MESSAGE_PATTERNS.find(([pattern]) => pattern.test(message));
    if (match) category = match[1];
  }
  return { category, code, transient: TRANSIENT.has(category) };
}

export interface ConnectRetryPolicy {
  retryAttempts: number;
  retryDelay: number;
  toRetry: (error: unknown) => boolean;
}

/**
 * The options handed to TypeOrmModule. `toRetry` is called by @nestjs/typeorm on every failed attempt,
 * before it decides whether to try again; it logs the attempt and answers whether a retry is worthwhile.
 */
export function buildConnectRetryPolicy(
  config: ConnectRetryConfig,
  log: (line: string) => void = (line) => new Logger('DatabaseConnect').warn(line),
): ConnectRetryPolicy {
  let attempt = 0;
  return {
    retryAttempts: config.attempts,
    retryDelay: config.delayMs,
    toRetry: (error: unknown) => {
      attempt += 1;
      const { category, code, transient } = classifyConnectError(error);
      const retrying = transient && attempt < config.attempts;
      log(
        JSON.stringify({
          event: 'database_connect_failed',
          attempt,
          maxAttempts: config.attempts,
          category,
          code,
          transient,
          retrying,
          retryInMs: retrying ? config.delayMs : null,
        }),
      );
      return transient;
    },
  };
}
