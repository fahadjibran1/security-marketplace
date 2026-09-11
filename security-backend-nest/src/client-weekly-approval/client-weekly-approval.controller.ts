import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Patch, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { ClientWeeklyApprovalService } from './client-weekly-approval.service';
import { CreateWeeklyApprovalDto } from './dto/create-weekly-approval.dto';
import { ResubmitApprovalDto } from './dto/resubmit-approval.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';

@Controller('timesheets/weekly-approvals')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ClientWeeklyApprovalController {
  constructor(private readonly service: ClientWeeklyApprovalService) {}

  @Post()
  @Roles(...COMPANY_ADMIN_ROLES)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateWeeklyApprovalDto) {
    return this.service.createSubmission(user.sub, dto);
  }

  @Get()
  @Roles(...COMPANY_VIEW_ROLES)
  list(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: string,
    @Query('clientId') clientIdStr?: string,
    @Query('siteId') siteIdStr?: string,
    @Query('weekCommencing') weekCommencing?: string,
  ) {
    const clientId = clientIdStr ? parseInt(clientIdStr, 10) : undefined;
    const siteId = siteIdStr ? parseInt(siteIdStr, 10) : undefined;
    return this.service.listForCompany(user.sub, { status, clientId, siteId, weekCommencing });
  }

  @Get('eligible')
  @Roles(...COMPANY_VIEW_ROLES)
  getEligible(
    @CurrentUser() user: JwtPayload,
    @Query('siteId') siteIdStr?: string,
    @Query('weekCommencing') weekCommencing?: string,
  ) {
    if (!siteIdStr || !weekCommencing) {
      throw new BadRequestException('siteId and weekCommencing are required.');
    }
    const siteId = parseInt(siteIdStr, 10);
    if (isNaN(siteId)) throw new BadRequestException('siteId must be a number.');
    return this.service.getEligibleTimesheets(user.sub, siteId, weekCommencing);
  }

  @Get(':id')
  @Roles(...COMPANY_VIEW_ROLES)
  findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.service.findOneForCompany(user.sub, id);
  }

  @Patch(':id/disputes/:disputeId/resolve')
  @Roles(...COMPANY_ADMIN_ROLES)
  resolveDispute(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Param('disputeId', ParseIntPipe) disputeId: number,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.service.resolveDispute(user.sub, id, disputeId, dto);
  }

  @Post(':id/resubmit')
  @Roles(...COMPANY_ADMIN_ROLES)
  resubmit(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResubmitApprovalDto,
  ) {
    return this.service.resubmit(user.sub, id, dto);
  }
}
