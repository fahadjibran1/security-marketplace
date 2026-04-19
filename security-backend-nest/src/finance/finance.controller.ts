import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { FinanceQueryDto } from './dto/finance-query.dto';
import { FinanceReconciliationService } from './finance-reconciliation.service';

@Controller('finance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FinanceController {
  constructor(private readonly financeReconciliationService: FinanceReconciliationService) {}

  @Get('summary')
  @Roles(...COMPANY_VIEW_ROLES)
  getSummary(@CurrentUser() user: JwtPayload, @Query() query: FinanceQueryDto) {
    return this.financeReconciliationService.getSummary(user.sub, query);
  }

  @Get('receivables')
  @Roles(...COMPANY_VIEW_ROLES)
  getReceivables(@CurrentUser() user: JwtPayload, @Query() query: FinanceQueryDto) {
    return this.financeReconciliationService.getReceivables(user.sub, query);
  }

  @Get('reconciliation')
  @Roles(...COMPANY_VIEW_ROLES)
  getReconciliation(@CurrentUser() user: JwtPayload, @Query() query: FinanceQueryDto) {
    return this.financeReconciliationService.getReconciliation(user.sub, query);
  }
}
