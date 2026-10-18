import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AttendanceEvent } from '../attendance/entities/attendance.entity';
import { CompanyModule } from '../company/company.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { ContractPricingModule } from '../contract-pricing/contract-pricing.module';
import { DailyLog } from '../daily-log/entities/daily-log.entity';
import { Incident } from '../incident/entities/incident.entity';
import { NotificationModule } from '../notification/notification.module';
import { SafetyAlert } from '../safety-alert/entities/safety-alert.entity';
import { Shift } from '../shift/entities/shift.entity';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { User } from '../user/entities/user.entity';
import { CoverageModule } from '../coverage/coverage.module';
import { OperationsExportService } from './operations-export.service';
import { ReportController } from './report.controller';
import { IncidentAnalyticsService } from './incident-analytics.service';
import { ReportService } from './report.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Timesheet, Incident, SafetyAlert, Shift, AttendanceEvent, DailyLog, AuditLog, User]),
    CoverageModule,
    CompanyModule,
    CompanyMembershipModule,
    ContractPricingModule,
    NotificationModule,
  ],
  controllers: [ReportController],
  providers: [ReportService, IncidentAnalyticsService, OperationsExportService],
})
export class ReportModule {}
