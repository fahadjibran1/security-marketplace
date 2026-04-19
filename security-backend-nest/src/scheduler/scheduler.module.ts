import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Company } from '../company/entities/company.entity';
import { InvoiceBatch } from '../invoice-batch/entities/invoice-batch.entity';
import { InvoiceBatchModule } from '../invoice-batch/invoice-batch.module';
import { Notification } from '../notification/entities/notification.entity';
import { PayRuleModule } from '../pay-rule/pay-rule.module';
import { PayrollBatch } from '../payroll-batch/entities/payroll-batch.entity';
import { PayrollBatchModule } from '../payroll-batch/payroll-batch.module';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { SchedulerController } from './scheduler.controller';
import { AutomationSchedulerService } from './scheduler.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Company, Timesheet, PayrollBatch, InvoiceBatch, Notification]),
    PayrollBatchModule,
    InvoiceBatchModule,
    PayRuleModule,
  ],
  controllers: [SchedulerController],
  providers: [AutomationSchedulerService],
  exports: [AutomationSchedulerService],
})
export class SchedulerModule {}
