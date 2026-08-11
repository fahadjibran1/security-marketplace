import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Controller('health')
export class HealthController {
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

    try {
      await this.dataSource.query('SELECT 1');
    } catch {
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
