import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { CoverageQuery, CoverageService } from './coverage.service';

@Controller('coverage')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CoverageController {
  constructor(private readonly coverageService: CoverageService) {}

  @Get('shifts')
  @Roles(...COMPANY_VIEW_ROLES)
  shifts(@CurrentUser() user: JwtPayload, @Query() query: CoverageQuery) {
    return this.coverageService.listShiftCoverage(user.sub, user.role, query);
  }

  /** Welfare and Log Book monitoring for named shifts: `GET /coverage/operations?shiftIds=12,13`. */
  @Get('operations')
  @Roles(...COMPANY_VIEW_ROLES)
  operations(@CurrentUser() user: JwtPayload, @Query('shiftIds') shiftIds?: string) {
    return this.coverageService.listShiftOperations(user.sub, user.role, shiftIds);
  }

  @Get('sites')
  @Roles(...COMPANY_VIEW_ROLES)
  sites(@CurrentUser() user: JwtPayload, @Query() query: CoverageQuery) {
    return this.coverageService.listSiteCoverage(user.sub, user.role, query);
  }

  @Get('shifts/:id/eligible-guards')
  @Roles(...COMPANY_VIEW_ROLES)
  eligibleGuards(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.coverageService.eligibleGuardsForShift(user.sub, user.role, id);
  }
}
