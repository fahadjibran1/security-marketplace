import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { UpsertPayRuleConfigDto } from './dto/upsert-pay-rule-config.dto';
import { PayRuleService } from './pay-rule.service';

@Controller('pay-rules')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PayRuleController {
  constructor(private readonly payRuleService: PayRuleService) {}

  @Get()
  @Roles(...COMPANY_VIEW_ROLES)
  findForCompany(@CurrentUser() user: JwtPayload) {
    return this.payRuleService.findForCompanyUser(user.sub);
  }

  @Post()
  @Roles(...COMPANY_ADMIN_ROLES)
  create(@CurrentUser() user: JwtPayload, @Body() dto: UpsertPayRuleConfigDto) {
    return this.payRuleService.upsertForCompanyUser(user.sub, dto);
  }

  @Put()
  @Roles(...COMPANY_ADMIN_ROLES)
  update(@CurrentUser() user: JwtPayload, @Body() dto: UpsertPayRuleConfigDto) {
    return this.payRuleService.upsertForCompanyUser(user.sub, dto);
  }
}
