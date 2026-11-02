import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { PatrolMonitorSiteQueryDto, PatrolMonitorSummaryQueryDto } from './dto/patrol-monitor.dto';
import { PatrolMonitorService } from './patrol-monitor.service';

/**
 * Patrol Monitor (S4 Patrol Monitor S1): read-only company reads under new paths only — no existing route, payload or
 * Guard API changes. Company accounts only (role guard); the company, the Patrols switch (404 while off) and patrols.view
 * are checked in PatrolAccessService.
 */
@Controller('patrols/monitor')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...COMPANY_VIEW_ROLES)
export class PatrolMonitorController {
  constructor(private readonly monitor: PatrolMonitorService) {}

  @Get('summary')
  summary(@CurrentUser() user: JwtPayload, @Query() q: PatrolMonitorSummaryQueryDto) {
    return this.monitor.summary(user, q);
  }

  @Get('sites/:siteId')
  site(@CurrentUser() user: JwtPayload, @Param('siteId', ParseIntPipe) siteId: number, @Query() q: PatrolMonitorSiteQueryDto) {
    return this.monitor.site(user, siteId, q);
  }
}
