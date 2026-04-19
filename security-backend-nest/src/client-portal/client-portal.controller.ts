import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CLIENT_PORTAL_ROLES } from '../user/entities/user.entity';
import { ClientPortalQueryDto } from './dto/client-portal-query.dto';
import { ClientPortalService } from './client-portal.service';

@Controller('client-portal')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...CLIENT_PORTAL_ROLES)
export class ClientPortalController {
  constructor(private readonly clientPortalService: ClientPortalService) {}

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
}
