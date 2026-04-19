import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { ComplianceService } from './compliance.service';
import { UpsertComplianceRecordDto } from './dto/upsert-compliance-record.dto';

@Controller('compliance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ComplianceController {
  constructor(private readonly complianceService: ComplianceService) {}

  @Get()
  @Roles(...COMPANY_VIEW_ROLES)
  list(@CurrentUser() user: JwtPayload) {
    return this.complianceService.listForCompanyUser(user.sub);
  }

  @Get('mine')
  @Roles(UserRole.GUARD)
  listMine(@CurrentUser() user: JwtPayload) {
    return this.complianceService.listForGuardUser(user.sub);
  }

  @Post()
  @Roles(...COMPANY_ADMIN_ROLES)
  create(@CurrentUser() user: JwtPayload, @Body() dto: UpsertComplianceRecordDto) {
    return this.complianceService.upsertForCompanyUser(user.sub, dto);
  }

  @Put()
  @Roles(...COMPANY_ADMIN_ROLES)
  update(@CurrentUser() user: JwtPayload, @Body() dto: UpsertComplianceRecordDto) {
    return this.complianceService.upsertForCompanyUser(user.sub, dto);
  }
}
