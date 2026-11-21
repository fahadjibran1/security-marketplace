import { Body, Controller, Get, Post, Put, UseGuards, UseInterceptors } from '@nestjs/common';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { UpsertGuardLeaveDto } from './dto/upsert-guard-leave.dto';
import { LeaveService } from './leave.service';
import { CompanyResponsePrivacyInterceptor } from '../common/privacy/company-response-privacy';
import { CompanyCapability, CompanyCapabilityRequired } from '../company/company-capability';

@Controller('leave')
@UseInterceptors(CompanyResponsePrivacyInterceptor)
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeaveController {
  constructor(private readonly leaveService: LeaveService) {}

  @Get()
  @Roles(...COMPANY_VIEW_ROLES)
  listForCompany(@CurrentUser() user: JwtPayload) {
    return this.leaveService.listForCompanyUser(user.sub, user.role);
  }

  @Get('mine')
  @Roles(UserRole.GUARD)
  listMine(@CurrentUser() user: JwtPayload) {
    return this.leaveService.listForGuardUser(user.sub);
  }

  /** The companies the guard can send a leave request to: their ACTIVE employers ({ companyId, name }). */
  @Get('mine/companies')
  @Roles(UserRole.GUARD)
  listMyLeaveCompanies(@CurrentUser() user: JwtPayload) {
    return this.leaveService.listLeaveCompaniesForGuardUser(user.sub);
  }

  @Post()
  @Roles(...COMPANY_ADMIN_ROLES)
  @CompanyCapabilityRequired(CompanyCapability.EXISTING_OBLIGATIONS)
  createForCompany(@CurrentUser() user: JwtPayload, @Body() dto: UpsertGuardLeaveDto) {
    return this.leaveService.upsertForCompanyUser(user.sub, user.role, dto);
  }

  @Put()
  @Roles(...COMPANY_ADMIN_ROLES)
  @CompanyCapabilityRequired(CompanyCapability.EXISTING_OBLIGATIONS)
  updateForCompany(@CurrentUser() user: JwtPayload, @Body() dto: UpsertGuardLeaveDto) {
    return this.leaveService.upsertForCompanyUser(user.sub, user.role, dto);
  }

  @Post('mine')
  @Roles(UserRole.GUARD)
  createMine(@CurrentUser() user: JwtPayload, @Body() dto: UpsertGuardLeaveDto) {
    return this.leaveService.upsertForGuardUser(user.sub, dto);
  }
}
