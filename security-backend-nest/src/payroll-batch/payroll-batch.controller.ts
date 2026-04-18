import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { CreatePayrollBatchDto } from './dto/create-payroll-batch.dto';
import { PayrollBatchService } from './payroll-batch.service';

@Controller('payroll-batches')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PayrollBatchController {
  constructor(private readonly payrollBatchService: PayrollBatchService) {}

  @Post()
  @Roles(...COMPANY_ADMIN_ROLES)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreatePayrollBatchDto) {
    return this.payrollBatchService.createForCompany(user.sub, dto);
  }

  @Get('company')
  @Roles(...COMPANY_VIEW_ROLES)
  findForCompany(@CurrentUser() user: JwtPayload) {
    return this.payrollBatchService.listForCompany(user.sub);
  }

  @Get(':id')
  @Roles(...COMPANY_VIEW_ROLES)
  findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.payrollBatchService.findOneForCompany(user.sub, id);
  }

  @Patch(':id/finalise')
  @Roles(...COMPANY_ADMIN_ROLES)
  finalise(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.payrollBatchService.finaliseForCompany(user.sub, id);
  }

  @Patch(':id/pay')
  @Roles(...COMPANY_ADMIN_ROLES)
  pay(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.payrollBatchService.payForCompany(user.sub, id);
  }
}
