import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { UpsertGuardLeaveDto } from './dto/upsert-guard-leave.dto';
import { LeaveService } from './leave.service';

@Controller('leave')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeaveController {
  constructor(private readonly leaveService: LeaveService) {}

  @Get()
  @Roles(...COMPANY_VIEW_ROLES)
  listForCompany(@CurrentUser() user: JwtPayload) {
    return this.leaveService.listForCompanyUser(user.sub);
  }

  @Get('mine')
  @Roles(UserRole.GUARD)
  listMine(@CurrentUser() user: JwtPayload) {
    return this.leaveService.listForGuardUser(user.sub);
  }

  @Post()
  @Roles(...COMPANY_ADMIN_ROLES)
  createForCompany(@CurrentUser() user: JwtPayload, @Body() dto: UpsertGuardLeaveDto) {
    return this.leaveService.upsertForCompanyUser(user.sub, dto);
  }

  @Put()
  @Roles(...COMPANY_ADMIN_ROLES)
  updateForCompany(@CurrentUser() user: JwtPayload, @Body() dto: UpsertGuardLeaveDto) {
    return this.leaveService.upsertForCompanyUser(user.sub, dto);
  }

  @Post('mine')
  @Roles(UserRole.GUARD)
  createMine(@CurrentUser() user: JwtPayload, @Body() dto: UpsertGuardLeaveDto) {
    return this.leaveService.upsertForGuardUser(user.sub, dto);
  }
}
