import { Controller, Get } from '@nestjs/common';

@Controller()
export class FallbackController {
  @Get('health')
  health() {
    return {
      ok: true,
      mode: 'no-db',
      message:
        'Backend started in fallback mode because database connection failed. Configure DATABASE_URL or DATABASE_HOST/PORT/USER/PASSWORD/NAME and restart.',
    };
  }
}
