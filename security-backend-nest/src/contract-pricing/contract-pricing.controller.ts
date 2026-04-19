import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { ContractPricingService } from './contract-pricing.service';
import { ContractPricingQueryDto } from './dto/contract-pricing-query.dto';
import { CreateContractPricingRuleDto } from './dto/create-contract-pricing-rule.dto';
import { UpdateContractPricingRuleDto } from './dto/update-contract-pricing-rule.dto';

@Controller('contract-pricing')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ContractPricingController {
  constructor(private readonly contractPricingService: ContractPricingService) {}

  @Get()
  @Roles(...COMPANY_VIEW_ROLES)
  list(@CurrentUser() user: JwtPayload, @Query() query: ContractPricingQueryDto) {
    return this.contractPricingService.listForCompany(user.sub, query);
  }

  @Get('preview')
  @Roles(...COMPANY_VIEW_ROLES)
  preview(@CurrentUser() user: JwtPayload, @Query('timesheetId', ParseIntPipe) timesheetId: number) {
    return this.contractPricingService.previewForCompany(user.sub, timesheetId);
  }

  @Get(':id')
  @Roles(...COMPANY_VIEW_ROLES)
  findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.contractPricingService.findOneForCompany(user.sub, id);
  }

  @Post()
  @Roles(...COMPANY_ADMIN_ROLES)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateContractPricingRuleDto) {
    return this.contractPricingService.createForCompany(user.sub, dto);
  }

  @Patch(':id')
  @Roles(...COMPANY_ADMIN_ROLES)
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateContractPricingRuleDto,
  ) {
    return this.contractPricingService.updateForCompany(user.sub, id, dto);
  }

  @Patch(':id/deactivate')
  @Roles(...COMPANY_ADMIN_ROLES)
  deactivate(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.contractPricingService.deactivateForCompany(user.sub, id);
  }
}
