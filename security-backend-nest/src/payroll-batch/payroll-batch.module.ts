import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { PayRuleModule } from '../pay-rule/pay-rule.module';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { PayrollBatchController } from './payroll-batch.controller';
import { PayrollBatch } from './entities/payroll-batch.entity';
import { PayrollBatchService } from './payroll-batch.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([PayrollBatch, Timesheet]),
    CompanyMembershipModule,
    AuditLogModule,
    PayRuleModule,
  ],
  controllers: [PayrollBatchController],
  providers: [PayrollBatchService],
  exports: [PayrollBatchService, TypeOrmModule],
})
export class PayrollBatchModule {}
