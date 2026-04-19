import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Timesheet } from './entities/timesheet.entity';
import { TimesheetController } from './timesheet.controller';
import { TimesheetService } from './timesheet.service';
import { CompanyModule } from '../company/company.module';
import { ContractPricingModule } from '../contract-pricing/contract-pricing.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Timesheet]),
    CompanyModule,
    ContractPricingModule,
    GuardProfileModule,
    AuditLogModule,
    NotificationModule,
  ],
  controllers: [TimesheetController],
  providers: [TimesheetService],
  exports: [TimesheetService, TypeOrmModule]
})
export class TimesheetModule {}
