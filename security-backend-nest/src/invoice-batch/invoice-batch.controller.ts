import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { CreateInvoiceBatchDto } from './dto/create-invoice-batch.dto';
import { InvoiceBatchService } from './invoice-batch.service';

@Controller('invoice-batches')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InvoiceBatchController {
  constructor(private readonly invoiceBatchService: InvoiceBatchService) {}

  @Post()
  @Roles(...COMPANY_ADMIN_ROLES)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateInvoiceBatchDto) {
    return this.invoiceBatchService.createForCompany(user.sub, dto);
  }

  @Get('company')
  @Roles(...COMPANY_VIEW_ROLES)
  findForCompany(@CurrentUser() user: JwtPayload) {
    return this.invoiceBatchService.listForCompany(user.sub);
  }

  @Get(':id')
  @Roles(...COMPANY_VIEW_ROLES)
  findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.invoiceBatchService.findOneForCompany(user.sub, id);
  }

  @Patch(':id/finalise')
  @Roles(...COMPANY_ADMIN_ROLES)
  finalise(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.invoiceBatchService.finaliseForCompany(user.sub, id);
  }

  @Patch(':id/issue')
  @Roles(...COMPANY_ADMIN_ROLES)
  issue(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.invoiceBatchService.issueForCompany(user.sub, id);
  }

  @Patch(':id/pay')
  @Roles(...COMPANY_ADMIN_ROLES)
  pay(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.invoiceBatchService.payForCompany(user.sub, id);
  }
}
