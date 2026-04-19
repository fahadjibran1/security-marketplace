import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { MarginReportQueryDto } from './dto/margin-report-query.dto';
import { ReportService } from './report.service';

@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

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
}
