import { Module } from '@nestjs/common';
import { LogBookWindowService } from './log-book-window.service';
import { OperationalWindowService } from './operational-window.service';
import { WelfareWindowService } from './welfare-window.service';

/**
 * The operational window engine.
 *
 * Providers only: no controllers, no entities, no repositories. Every service here is stateless
 * and pure, so this module adds no runtime behaviour on its own — it exists to be injected by the
 * welfare sweep, the live projection and the Operations Log.
 */
@Module({
  providers: [OperationalWindowService, WelfareWindowService, LogBookWindowService],
  exports: [OperationalWindowService, WelfareWindowService, LogBookWindowService],
})
export class OperationsModule {}
