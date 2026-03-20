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
import { HealthController } from './health.controller';
import { buildNestTypeOrmOptions } from './database/typeorm.config';
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildNestTypeOrmOptions({
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
    }),
    UserModule,
    AuthModule,
    CompanyModule,
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
  ],
  controllers: [HealthController],
})
export class AppModule {}
