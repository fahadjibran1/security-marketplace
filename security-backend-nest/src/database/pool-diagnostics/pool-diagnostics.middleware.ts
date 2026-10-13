import { NextFunction, Request, Response } from 'express';
import { getActivePoolDiagnostics } from './pool-diagnostics';
import {
  matchedRouteTemplate,
  newDbRequestContext,
  runWithDbRequestContext,
  sanitizeRoute,
} from './request-context';

/**
 * Tags every database connection a request takes with that request, so pool diagnostics can say
 * which endpoint was waiting for, or holding, connections. Registered only when diagnostics are
 * enabled; it reuses the request id the request logger already assigned.
 */
export function dbRequestContextMiddleware() {
  return (request: Request, response: Response, next: NextFunction) => {
    const header = response.getHeader('X-Request-Id') ?? request.header('x-request-id');
    const requestId = typeof header === 'string' && header.trim() ? header.trim().slice(0, 64) : 'unknown';
    const startedAt = Date.now();
    const context = newDbRequestContext(requestId, request.method, sanitizeRoute(request.originalUrl));

    response.on('finish', () => {
      try {
        context.route = matchedRouteTemplate(request) ?? context.route;
        getActivePoolDiagnostics()?.requestFinished(context, response.statusCode, Date.now() - startedAt);
      } catch {
        // Diagnostics never affect the response.
      }
    });

    runWithDbRequestContext(context, next);
  };
}
