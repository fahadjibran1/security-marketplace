import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { SafetyAlertService } from './safety-alert.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CreateSafetyAlertDto } from './dto/create-safety-alert.dto';
import { ResolveSafetyAlertDto } from './dto/resolve-safety-alert.dto';

@Controller('alerts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SafetyAlertController {
  constructor(private readonly safetyAlertService: SafetyAlertService) {}

  @Get('mine')
  @Roles(UserRole.GUARD)
  findMine(@CurrentUser() user: JwtPayload) {
    return this.safetyAlertService.findMine(user.sub);
  }

  @Get('company')
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES)
  findForCompany(@CurrentUser() user: JwtPayload) {
    if (user.role === UserRole.ADMIN) {
      return this.safetyAlertService.findAll();
    }

    return this.safetyAlertService.findForCompany(user.sub);
  }

  @Post()
  @Roles(UserRole.GUARD)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateSafetyAlertDto) {
    return this.safetyAlertService.createForGuard(user.sub, dto);
  }

  @Patch(':id/ack')
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES)
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
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES)
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
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES)
  resolutionReasons(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.safetyAlertService.resolutionOptions(user.sub, id, user.role === UserRole.ADMIN);
  }
}
