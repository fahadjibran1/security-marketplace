import { Controller, Get } from '@nestjs/common';

@Controller()
export class FallbackController {
  @Get('health')
  health() {
    return {
      ok: true,
      mode: 'no-db',
      message: 'Starting without database connection because ALLOW_START_WITHOUT_DB=true',
    };
  }
}
