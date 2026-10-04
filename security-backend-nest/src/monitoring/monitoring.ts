import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { scrubBreadcrumb, scrubEvent } from './monitoring-scrub';

/**
 * Error monitoring (Sentry), prepared but OFF unless configured.
 *
 *   SENTRY_DSN          — required to enable. Absent or empty: monitoring is disabled and the SDK is
 *                          never even loaded, so a deployment without it behaves exactly as before.
 *   SENTRY_ENVIRONMENT  — optional environment tag; defaults to NODE_ENV.
 *   SENTRY_RELEASE      — optional release tag; falls back to RENDER_GIT_COMMIT when Render sets it.
 *
 * Errors only: no performance tracing, no profiling, no session replay, no analytics. sendDefaultPii is
 * false and every event and breadcrumb passes through the S4 privacy scrubber before it can leave.
 */

type MonitoringEnv = Record<string, string | undefined>;

export interface MonitoringConfig {
  enabled: boolean;
  dsn?: string;
  environment: string;
  release?: string;
}

export function resolveMonitoringConfig(env: MonitoringEnv): MonitoringConfig {
  const dsn = env.SENTRY_DSN?.trim();
  const environment = env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV?.trim() || 'development';
  const release = env.SENTRY_RELEASE?.trim() || env.RENDER_GIT_COMMIT?.trim() || undefined;
  return dsn ? { enabled: true, dsn, environment, release } : { enabled: false, environment, release };
}

/** The exact options handed to Sentry.init — exported so the certification suite can assert them. */
export function buildSentryOptions(config: MonitoringConfig) {
  return {
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    sendDefaultPii: false,
    // Errors only. Leaving these undefined (not 0) keeps the tracing machinery from initialising at all.
    tracesSampleRate: undefined,
    tracesSampler: undefined,
    profilesSampleRate: undefined,
    includeLocalVariables: false,
    maxBreadcrumbs: 30,
    initialScope: { tags: { service: 's4-api', ...(config.release ? { release: config.release } : {}) } },
    beforeSend: (event: Record<string, unknown>) => scrubEvent(event),
    beforeSendTransaction: () => null,
    beforeBreadcrumb: (breadcrumb: Record<string, unknown>) => scrubBreadcrumb(breadcrumb),
  };
}

type SentryModule = {
  init: (options: Record<string, unknown>) => unknown;
  captureException: (error: unknown) => unknown;
};

let sentry: SentryModule | null = null;

/** Call once, before the Nest application is created. Returns whether monitoring is active. */
export function initMonitoring(env: MonitoringEnv, logger = new Logger('Monitoring')): boolean {
  const config = resolveMonitoringConfig(env);
  if (!config.enabled) {
    logger.log(JSON.stringify({ event: 'error_monitoring_disabled', reason: 'SENTRY_DSN not set' }));
    return false;
  }
  // Loaded only when enabled, so an unconfigured deployment never executes SDK code.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sentry = require('@sentry/node') as SentryModule;
  sentry.init(buildSentryOptions(config));
  logger.log(JSON.stringify({ event: 'error_monitoring_enabled', environment: config.environment, release: config.release ?? null }));
  return true;
}

export function captureException(error: unknown): void {
  sentry?.captureException(error);
}

/**
 * Reports unexpected failures (anything that is not a deliberate 4xx HttpException) and then lets
 * Nest's normal handling produce the response, so clients see exactly what they saw before.
 */
@Catch()
export class MonitoringExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500) captureException(exception);
    super.catch(exception, host);
  }
}
