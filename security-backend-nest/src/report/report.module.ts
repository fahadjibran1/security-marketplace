import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AttendanceEvent } from '../attendance/entities/attendance.entity';
import { CompanyModule } from '../company/company.module';
import { ContractPricingModule } from '../contract-pricing/contract-pricing.module';
import { DailyLog } from '../daily-log/entities/daily-log.entity';
import { Incident } from '../incident/entities/incident.entity';
import { NotificationModule } from '../notification/notification.module';
import { SafetyAlert } from '../safety-alert/entities/safety-alert.entity';
import { Shift } from '../shift/entities/shift.entity';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { ReportController } from './report.controller';
import { IncidentAnalyticsService } from './incident-analytics.service';
import { ReportService } from './report.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Timesheet, Incident, SafetyAlert, Shift, AttendanceEvent, DailyLog]),
    CompanyModule,
    ContractPricingModule,
    NotificationModule,
  ],
  controllers: [ReportController],
  providers: [ReportService, IncidentAnalyticsService],
})
export class ReportModule {}
