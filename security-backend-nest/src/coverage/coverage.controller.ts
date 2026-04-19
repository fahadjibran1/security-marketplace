import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { CoverageService } from './coverage.service';

@Controller('coverage')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CoverageController {
  constructor(private readonly coverageService: CoverageService) {}

  @Get('shifts')
  @Roles(...COMPANY_VIEW_ROLES)
  shifts(@CurrentUser() user: JwtPayload, @Query() query: { from?: string; to?: string; siteId?: string; clientId?: string }) {
    return this.coverageService.listShiftCoverage(user.sub, query);
  }

  @Get('sites')
  @Roles(...COMPANY_VIEW_ROLES)
  sites(@CurrentUser() user: JwtPayload, @Query() query: { from?: string; to?: string }) {
    return this.coverageService.listSiteCoverage(user.sub, query);
  }

  @Get('shifts/:id/eligible-guards')
  @Roles(...COMPANY_VIEW_ROLES)
  eligibleGuards(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.coverageService.eligibleGuardsForShift(user.sub, id);
  }
}
