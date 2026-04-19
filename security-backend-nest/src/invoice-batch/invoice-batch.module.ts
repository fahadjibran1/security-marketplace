import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { Client } from '../client/entities/client.entity';
import { CompanyModule } from '../company/company.module';
import { ContractPricingModule } from '../contract-pricing/contract-pricing.module';
import { PaymentRecord } from '../payment-record/entities/payment-record.entity';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { InvoiceBatchController } from './invoice-batch.controller';
import { InvoiceBatch } from './entities/invoice-batch.entity';
import { InvoiceBatchService } from './invoice-batch.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([InvoiceBatch, Timesheet, Client, PaymentRecord]),
    CompanyModule,
    ContractPricingModule,
    AuditLogModule,
  ],
  controllers: [InvoiceBatchController],
  providers: [InvoiceBatchService],
  exports: [InvoiceBatchService, TypeOrmModule],
})
export class InvoiceBatchModule {}
