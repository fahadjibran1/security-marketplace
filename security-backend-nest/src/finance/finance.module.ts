import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CompanyModule } from '../company/company.module';
import { ContractPricingModule } from '../contract-pricing/contract-pricing.module';
import { InvoiceBatch } from '../invoice-batch/entities/invoice-batch.entity';
import { PayRuleModule } from '../pay-rule/pay-rule.module';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { FinanceController } from './finance.controller';
import { FinanceReconciliationService } from './finance-reconciliation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([InvoiceBatch, Timesheet]),
    CompanyModule,
    ContractPricingModule,
    PayRuleModule,
  ],
  controllers: [FinanceController],
  providers: [FinanceReconciliationService],
  exports: [FinanceReconciliationService],
})
export class FinanceModule {}
