import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { CompanyModule } from './company/company.module';
import { GuardProfileModule } from './guard-profile/guard-profile.module';
import { JobModule } from './job/job.module';
import { JobApplicationModule } from './job-application/job-application.module';
import { AssignmentModule } from './assignment/assignment.module';
import { ShiftModule } from './shift/shift.module';
import { TimesheetModule } from './timesheet/timesheet.module';
import { UserModule } from './user/user.module';
import { JobSlotModule } from './job-slot/job-slot.module';
import { JobMatchModule } from './job-match/job-match.module';
import { CompanyGuardModule } from './company-guard/company-guard.module';
import { MatchingModule } from './matching/matching.module';
import { AttendanceModule } from './attendance/attendance.module';
import { IncidentModule } from './incident/incident.module';
import { SiteModule } from './site/site.module';
import { SafetyAlertModule } from './safety-alert/safety-alert.module';
import { DailyLogModule } from './daily-log/daily-log.module';
import { AttachmentModule } from './attachment/attachment.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { NotificationModule } from './notification/notification.module';
import { ClientModule } from './client/client.module';
import { ContractPricingModule } from './contract-pricing/contract-pricing.module';
import { InvoiceBatchModule } from './invoice-batch/invoice-batch.module';
import { PayrollBatchModule } from './payroll-batch/payroll-batch.module';
import { ReportModule } from './report/report.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { PayRuleModule } from './pay-rule/pay-rule.module';
import { ComplianceModule } from './compliance/compliance.module';
import { AvailabilityModule } from './availability/availability.module';
import { LeaveModule } from './leave/leave.module';
import { CoverageModule } from './coverage/coverage.module';
import { HealthController } from './health.controller';
import { buildNestTypeOrmOptions } from './database/typeorm.config';
import { validateRuntimeEnv } from './config/runtime-env';
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateRuntimeEnv }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...buildNestTypeOrmOptions({
          DATABASE_POOLER_URL: config.get<string>('DATABASE_POOLER_URL'),
          DATABASE_URL: config.get<string>('DATABASE_URL'),
          DATABASE_SSL: config.get<string>('DATABASE_SSL'),
          NODE_ENV: config.get<string>('NODE_ENV'),
          DATABASE_SYNCHRONIZE: config.get<string>('DATABASE_SYNCHRONIZE'),
          DATABASE_HOST: config.get<string>('DATABASE_HOST'),
          DATABASE_PORT: config.get<string>('DATABASE_PORT'),
          DATABASE_USER: config.get<string>('DATABASE_USER'),
          DATABASE_PASSWORD: config.get<string>('DATABASE_PASSWORD'),
          DATABASE_NAME: config.get<string>('DATABASE_NAME'),
        }),
        retryAttempts: 1,
        retryDelay: 0,
      }),
    }),
    UserModule,
    AuthModule,
    CompanyModule,
    ClientModule,
    ContractPricingModule,
    GuardProfileModule,
    JobModule,
    JobApplicationModule,
    AssignmentModule,
    ShiftModule,
    TimesheetModule,
    JobSlotModule,
    JobMatchModule,
    CompanyGuardModule,
    MatchingModule,
    AttendanceModule,
    IncidentModule,
    SiteModule,
    SafetyAlertModule,
    DailyLogModule,
    AttachmentModule,
    AuditLogModule,
    NotificationModule,
    PayrollBatchModule,
    InvoiceBatchModule,
    ReportModule,
    SchedulerModule,
    PayRuleModule,
    ComplianceModule,
    AvailabilityModule,
    LeaveModule,
    CoverageModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
