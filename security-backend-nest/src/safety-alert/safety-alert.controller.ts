import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { SafetyAlertService } from './safety-alert.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CreateSafetyAlertDto } from './dto/create-safety-alert.dto';
import { ResolveSafetyAlertDto } from './dto/resolve-safety-alert.dto';
import { parseAlertScopeQuery } from './alert-scope-query';

@Controller('alerts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SafetyAlertController {
  constructor(private readonly safetyAlertService: SafetyAlertService) {}

  @Get('mine')
  @Roles(UserRole.GUARD)
  findMine(@CurrentUser() user: JwtPayload) {
    return this.safetyAlertService.findMine(user.sub);
  }

  /**
   * Without `scope`: exactly as before — every alert the caller may see (Platform Admin: every company's). With
   * `scope` (Stage A): a bounded company read — operational, history (paginated) or one shift's record. Each parameter
   * is read on its own, so a query key this route does not know is still ignored, as it always was.
   */
  @Get('company')
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES)
  findForCompany(
    @CurrentUser() user: JwtPayload,
    @Query('scope') scope?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('shiftId') shiftId?: string,
  ) {
    const scoped = parseAlertScopeQuery({ scope, since, until, page, pageSize, from, to, type, status, shiftId });
    if (user.role === UserRole.ADMIN) {
      // Platform Admin's every-company list is unchanged; its bounded read is a later, separate change.
      if (scoped) throw new BadRequestException('Alert scopes are for company accounts.');
      return this.safetyAlertService.findAll();
    }
    if (scoped) return this.safetyAlertService.scopedForCompany(user.sub, scoped);
    return this.safetyAlertService.findForCompany(user.sub);
  }

  @Post()
  @Roles(UserRole.GUARD)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateSafetyAlertDto) {
    return this.safetyAlertService.createForGuard(user.sub, dto);
  }

  // Entry gate. Company staff reach this only to act on their own company's compliance lapse alerts with
  // compliance.manage; that, and everything else, is enforced in the service.
  @Patch(':id/ack')
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES, UserRole.COMPANY_STAFF)
  acknowledge(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    if (user.role === UserRole.ADMIN) {
      return this.safetyAlertService.acknowledgeAsAdmin(user.sub, id);
    }

    return this.safetyAlertService.acknowledgeForCompany(user.sub, id);
  }

  /**
   * The body is optional so an existing caller that closes an alert with no payload keeps working;
   * when one IS sent, the service validates the reason against the stored alert's own type.
   */
  @Patch(':id/close')
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES, UserRole.COMPANY_STAFF)
  close(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResolveSafetyAlertDto,
  ) {
    const resolution = dto?.resolutionReason || dto?.resolutionNote ? dto : undefined;

    if (user.role === UserRole.ADMIN) {
      return this.safetyAlertService.closeAsAdmin(user.sub, id, resolution);
    }

    return this.safetyAlertService.closeForCompany(user.sub, id, resolution);
  }

  /** The reasons this alert may be closed with, so the UI never offers a value the API will refuse. */
  @Get(':id/resolution-reasons')
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES, UserRole.COMPANY_STAFF)
  resolutionReasons(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.safetyAlertService.resolutionOptions(user.sub, id, user.role === UserRole.ADMIN);
  }
}
