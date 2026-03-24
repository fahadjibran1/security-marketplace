import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { SafetyAlertService } from './safety-alert.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CreateSafetyAlertDto } from './dto/create-safety-alert.dto';

@Controller('alerts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SafetyAlertController {
  constructor(private readonly safetyAlertService: SafetyAlertService) {}

  @Get('mine')
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  findMine(@CurrentUser() user: JwtPayload) {
    return this.safetyAlertService.findMine(user.sub);
  }

  @Get('company')
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES)
  findForCompany(@CurrentUser() user: JwtPayload) {
    return this.safetyAlertService.findForCompany(user.sub);
  }

  @Post()
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateSafetyAlertDto) {
    return this.safetyAlertService.createForGuard(user.sub, dto);
  }

  @Patch(':id/ack')
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES)
  acknowledge(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.safetyAlertService.acknowledgeForCompany(user.sub, id);
  }

  @Patch(':id/close')
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES)
  close(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.safetyAlertService.closeForCompany(user.sub, id);
  }
}
