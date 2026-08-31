import { Body, Controller, Get, Post, Put, Query, UseGuards } from '@nestjs/common';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { AvailabilityService } from './availability.service';
import { UpsertAvailabilityOverrideDto } from './dto/upsert-availability-override.dto';
import { UpsertAvailabilityRuleDto } from './dto/upsert-availability-rule.dto';

@Controller('availability')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AvailabilityController {
  constructor(private readonly availabilityService: AvailabilityService) {}

  @Get('rules')
  @Roles(...COMPANY_VIEW_ROLES)
  listRules(@CurrentUser() user: JwtPayload, @Query('guardId') guardId?: string) {
    return this.availabilityService.listRulesForCompanyUser(user.sub, guardId ? Number(guardId) : undefined);
  }

  @Get('overrides')
  @Roles(...COMPANY_VIEW_ROLES)
  listOverrides(@CurrentUser() user: JwtPayload, @Query('guardId') guardId?: string) {
    return this.availabilityService.listOverridesForCompanyUser(user.sub, guardId ? Number(guardId) : undefined);
  }

  @Get('mine/rules')
  @Roles(UserRole.GUARD)
  listMyRules(@CurrentUser() user: JwtPayload) {
    return this.availabilityService.listRulesForGuardUser(user.sub);
  }

  @Get('mine/overrides')
  @Roles(UserRole.GUARD)
  listMyOverrides(@CurrentUser() user: JwtPayload) {
    return this.availabilityService.listOverridesForGuardUser(user.sub);
  }

  @Post('rules')
  @Roles(...COMPANY_ADMIN_ROLES)
  createRule(@CurrentUser() user: JwtPayload, @Body() dto: UpsertAvailabilityRuleDto) {
    return this.availabilityService.upsertRuleForCompanyUser(user.sub, dto);
  }

  @Put('rules')
  @Roles(...COMPANY_ADMIN_ROLES)
  updateRule(@CurrentUser() user: JwtPayload, @Body() dto: UpsertAvailabilityRuleDto) {
    return this.availabilityService.upsertRuleForCompanyUser(user.sub, dto);
  }

  @Post('overrides')
  @Roles(...COMPANY_ADMIN_ROLES)
  createOverride(@CurrentUser() user: JwtPayload, @Body() dto: UpsertAvailabilityOverrideDto) {
    return this.availabilityService.upsertOverrideForCompanyUser(user.sub, dto);
  }

  @Put('overrides')
  @Roles(...COMPANY_ADMIN_ROLES)
  updateOverride(@CurrentUser() user: JwtPayload, @Body() dto: UpsertAvailabilityOverrideDto) {
    return this.availabilityService.upsertOverrideForCompanyUser(user.sub, dto);
  }

  @Post('mine/rules')
  @Roles(UserRole.GUARD)
  createMyRule(@CurrentUser() user: JwtPayload, @Body() dto: UpsertAvailabilityRuleDto) {
    return this.availabilityService.upsertRuleForGuardUser(user.sub, dto);
  }

  @Post('mine/overrides')
  @Roles(UserRole.GUARD)
  createMyOverride(@CurrentUser() user: JwtPayload, @Body() dto: UpsertAvailabilityOverrideDto) {
    return this.availabilityService.upsertOverrideForGuardUser(user.sub, dto);
  }
}
