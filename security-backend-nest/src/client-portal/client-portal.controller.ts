import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CLIENT_PORTAL_ROLES, UserRole } from '../user/entities/user.entity';
import { ClientPortalQueryDto } from './dto/client-portal-query.dto';
import { ClientPortalService } from './client-portal.service';
import { ClientPortalWeeklyApprovalService } from '../client-weekly-approval/client-portal-weekly-approval.service';
import { ClientDisputeDto } from '../client-weekly-approval/dto/client-dispute.dto';

@Controller('client-portal')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...CLIENT_PORTAL_ROLES)
export class ClientPortalController {
  constructor(
    private readonly clientPortalService: ClientPortalService,
    private readonly clientPortalWeeklyApprovalService: ClientPortalWeeklyApprovalService,
  ) {}

  @Get('dashboard')
  getDashboard(@CurrentUser() user: JwtPayload) {
    return this.clientPortalService.getDashboard(user.sub);
  }

  @Get('sites')
  listSites(@CurrentUser() user: JwtPayload) {
    return this.clientPortalService.listSites(user.sub);
  }

  @Get('service-records')
  listServiceRecords(@CurrentUser() user: JwtPayload, @Query() query: ClientPortalQueryDto) {
    return this.clientPortalService.listServiceRecords(user.sub, query);
  }

  @Get('incidents')
  listIncidents(@CurrentUser() user: JwtPayload, @Query() query: ClientPortalQueryDto) {
    return this.clientPortalService.listIncidents(user.sub, query);
  }

  @Get('reports/service-hours')
  getServiceHoursReport(@CurrentUser() user: JwtPayload, @Query() query: ClientPortalQueryDto) {
    return this.clientPortalService.getServiceHoursReport(user.sub, query);
  }

  @Get('reports/incidents')
  getIncidentSummaryReport(@CurrentUser() user: JwtPayload, @Query() query: ClientPortalQueryDto) {
    return this.clientPortalService.getIncidentSummaryReport(user.sub, query);
  }

  @Get('reports/welfare')
  getWelfareReport(@CurrentUser() user: JwtPayload, @Query() query: ClientPortalQueryDto) {
    return this.clientPortalService.getWelfareReport(user.sub, query);
  }

  @Get('invoices')
  listInvoices(@CurrentUser() user: JwtPayload) {
    return this.clientPortalService.listInvoices(user.sub);
  }

  @Get('invoices/:id/document')
  getInvoiceDocument(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.clientPortalService.getInvoiceDocument(user.sub, id);
  }

  // P1H — Weekly Client Approval
  @Get('weekly-approvals')
  @Roles(...CLIENT_PORTAL_ROLES)
  listWeeklyApprovals(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: string,
    @Query('siteId', new ParseIntPipe({ optional: true })) siteId?: number,
    @Query('weekCommencing') weekCommencing?: string,
  ) {
    return this.clientPortalWeeklyApprovalService.listForClient(user.clientId!, user.sub, { status, siteId, weekCommencing });
  }

  @Get('weekly-approvals/:id')
  @Roles(...CLIENT_PORTAL_ROLES)
  getWeeklyApproval(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.clientPortalWeeklyApprovalService.findOneForClient(user.clientId!, user.sub, id);
  }

  @Post('weekly-approvals/:id/approve')
  @Roles(UserRole.CLIENT_ADMIN)
  approveWeek(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.clientPortalWeeklyApprovalService.approveWeek(user.clientId!, user.sub, id);
  }

  @Post('weekly-approvals/:id/dispute')
  @Roles(UserRole.CLIENT_ADMIN)
  disputeWeek(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ClientDisputeDto,
  ) {
    return this.clientPortalWeeklyApprovalService.disputeShifts(user.clientId!, user.sub, id, dto);
  }
}
