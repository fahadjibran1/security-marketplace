import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Controller('health')
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  async check() {
    const timestamp = new Date().toISOString();

    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({
        ok: false,
        service: 'security-marketplace-api',
        checks: {
          database: 'down',
        },
        timestamp,
      });
    }

    return {
      ok: true,
      service: 'security-marketplace-api',
      checks: {
        database: 'up',
      },
      timestamp,
    };
  }
}
