import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { classifyConnectError } from './database/connect-retry';

/**
 * Two probes, deliberately different (Performance P2):
 *
 *  - /health/live answers from the process alone and never touches the database. It is the probe a
 *    platform should restart the service on: it fails only when the process itself cannot serve.
 *  - /health/ready checks the database. It needs a pooled connection, so when the pool is busy it slows
 *    down with everything else; restarting the service on it turned a busy pool into an outage (S4 P1
 *    incident, 14 Oct 2026). It stays for monitoring, and every failure is logged so a database problem
 *    is visible even when nothing restarts.
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger('Health');

  constructor(private readonly dataSource: DataSource) {}

  @Get('live')
  live() {
    return {
      ok: true,
      service: 's4-api',
      status: 'live',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready() {
    return this.databaseReadiness();
  }

  // Backwards-compatible readiness endpoint for existing deployment probes.
  @Get()
  async check() {
    return this.databaseReadiness();
  }

  private async databaseReadiness() {
    const timestamp = new Date().toISOString();
    const startedAt = Date.now();

    try {
      await this.dataSource.query('SELECT 1');
    } catch (error) {
      // A category and code only: never the driver's message, host or connection details.
      const { category, code } = classifyConnectError(error);
      this.logger.warn(
        JSON.stringify({
          event: 'database_readiness_failed',
          category,
          code,
          durationMs: Date.now() - startedAt,
        }),
      );
      throw new ServiceUnavailableException({
        ok: false,
        service: 's4-api',
        status: 'not-ready',
        checks: {
          database: 'down',
        },
        timestamp,
      });
    }

    return {
      ok: true,
      service: 's4-api',
      status: 'ready',
      checks: {
        database: 'up',
      },
      timestamp,
    };
  }
}
