import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { AnalyticsReportQueryDto } from './dto/analytics-report-query.dto';
import { MarginReportQueryDto } from './dto/margin-report-query.dto';
import { IncidentAnalyticsService } from './incident-analytics.service';
import { ReportService } from './report.service';

@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReportController {
  constructor(
    private readonly reportService: ReportService,
    private readonly incidentAnalyticsService: IncidentAnalyticsService,
  ) {}

  @Get('margin')
  @Roles(...COMPANY_VIEW_ROLES)
  getMarginReport(@CurrentUser() user: JwtPayload, @Query() query: MarginReportQueryDto) {
    return this.reportService.getCompanyMarginReport(user.sub, query);
  }

  @Get('financial-consistency')
  @Roles(...COMPANY_VIEW_ROLES)
  getFinancialConsistency(@CurrentUser() user: JwtPayload) {
    return this.reportService.getFinancialConsistency(user.sub);
  }

  @Get('incidents')
  @Roles(...COMPANY_VIEW_ROLES)
  getIncidentReport(@CurrentUser() user: JwtPayload, @Query() query: AnalyticsReportQueryDto) {
    return this.incidentAnalyticsService.getIncidentReport(user.sub, query);
  }

  @Get('welfare')
  @Roles(...COMPANY_VIEW_ROLES)
  getWelfareReport(@CurrentUser() user: JwtPayload, @Query() query: AnalyticsReportQueryDto) {
    return this.incidentAnalyticsService.getWelfareReport(user.sub, query);
  }

  @Get('sites-risk')
  @Roles(...COMPANY_VIEW_ROLES)
  getSiteRiskReport(@CurrentUser() user: JwtPayload, @Query() query: AnalyticsReportQueryDto) {
    return this.incidentAnalyticsService.getSiteRiskReport(user.sub, query);
  }
}
