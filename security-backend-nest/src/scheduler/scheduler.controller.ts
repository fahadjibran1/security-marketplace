import { Controller, Get, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { AutomationSchedulerService } from './scheduler.service';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class SchedulerController {
  constructor(private readonly schedulerService: AutomationSchedulerService) {}

  @Get('payroll/suggestions')
  @Roles(...COMPANY_VIEW_ROLES)
  getPayrollSuggestions(@CurrentUser() user: JwtPayload) {
    return this.schedulerService.getPayrollSuggestionsForCompany(user.sub);
  }

  @Get('invoices/suggestions')
  @Roles(...COMPANY_VIEW_ROLES)
  getInvoiceSuggestions(@CurrentUser() user: JwtPayload) {
    return this.schedulerService.getInvoiceSuggestionsForCompany(user.sub);
  }

  @Post('scheduler/run/payroll-suggestions')
  @Roles(...COMPANY_ADMIN_ROLES)
  runPayrollSuggestions() {
    return this.schedulerService.runPayrollSuggestions();
  }

  @Post('scheduler/run/invoice-suggestions')
  @Roles(...COMPANY_ADMIN_ROLES)
  runInvoiceSuggestions() {
    return this.schedulerService.runInvoiceSuggestions();
  }

  @Post('scheduler/run/reminders')
  @Roles(...COMPANY_ADMIN_ROLES)
  runReminders() {
    return this.schedulerService.runReminders();
  }
}
