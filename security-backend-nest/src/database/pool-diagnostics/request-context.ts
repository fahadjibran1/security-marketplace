import { AsyncLocalStorage } from 'async_hooks';

/**
 * Which request (or background job) a pooled database connection is being taken for.
 *
 * Carried with AsyncLocalStorage so the pool hooks can attribute an acquisition to the request that
 * asked for it, without threading anything through services. Only set while pool diagnostics are
 * enabled; when they are off nothing is stored and `currentDbRequestContext()` returns undefined.
 *
 * Holds no personal data: an opaque request id, the HTTP method, a route with query strings and
 * identifier-like segments removed, and counters.
 */
export type DbRequestContext = {
  requestId: string;
  method: string;
  /** Sanitised route; replaced by the matched route template when the request finishes. */
  route: string;
  acquisitions: number;
  totalWaitMs: number;
  maxWaitMs: number;
  totalHoldMs: number;
  held: number;
  maxConcurrentHeld: number;
  failures: number;
};

const storage = new AsyncLocalStorage<DbRequestContext>();

export function newDbRequestContext(requestId: string, method: string, route: string): DbRequestContext {
  return {
    requestId,
    method,
    route,
    acquisitions: 0,
    totalWaitMs: 0,
    maxWaitMs: 0,
    totalHoldMs: 0,
    held: 0,
    maxConcurrentHeld: 0,
    failures: 0,
  };
}

export function runWithDbRequestContext<T>(context: DbRequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentDbRequestContext(): DbRequestContext | undefined {
  return storage.getStore();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
// Anything long and token-like (reset/verification tokens, hashes, encoded values) is never logged.
const TOKEN_LIKE = /^[A-Za-z0-9_\-.~%]{16,}$/;
const MAX_ROUTE_LENGTH = 120;

/**
 * A route that is safe to log: the query string is dropped (it can carry tokens, dates and search
 * text) and every segment that could identify a record or carry a secret is replaced by a placeholder.
 */
export function sanitizeRoute(rawPath: string | undefined | null): string {
  if (!rawPath) return 'unknown';
  const pathOnly = String(rawPath).split('?')[0].split('#')[0];
  const segments = pathOnly.split('/').map((segment) => {
    if (!segment) return segment;
    if (NUMERIC.test(segment)) return ':id';
    if (UUID.test(segment)) return ':uuid';
    if (TOKEN_LIKE.test(segment) || segment.includes('@')) return ':value';
    return segment;
  });
  const route = segments.join('/') || '/';
  return route.length > MAX_ROUTE_LENGTH ? `${route.slice(0, MAX_ROUTE_LENGTH)}…` : route;
}

/** The matched Express route template (`/rota-slots/:id/assign`) when routing has resolved one. */
export function matchedRouteTemplate(request: { baseUrl?: string; route?: { path?: unknown } }): string | null {
  const routePath = request.route?.path;
  if (typeof routePath !== 'string') return null;
  return sanitizeRoute(`${request.baseUrl ?? ''}${routePath}`);
}
