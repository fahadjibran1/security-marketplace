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
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const databaseUrl = config.get<string>('DATABASE_URL');
        const databaseSsl =
          (config.get<string>('DATABASE_SSL', 'false') || 'false').toLowerCase() === 'true';
        const nodeEnv = config.get<string>('NODE_ENV', 'development');
        const synchronize =
          (config.get<string>('DATABASE_SYNCHRONIZE') ||
            (nodeEnv === 'production' ? 'false' : 'true')
          ).toLowerCase() === 'true';

        if (databaseUrl) {
          return {
            type: 'postgres' as const,
            url: databaseUrl,
            ssl: databaseSsl ? { rejectUnauthorized: false } : false,
            autoLoadEntities: true,
            synchronize,
          };
        }

        return {
          type: 'postgres' as const,
          host: config.get<string>('DATABASE_HOST', 'localhost'),
          port: parseInt(config.get<string>('DATABASE_PORT', '5432'), 10),
          username: config.get<string>('DATABASE_USER', 'postgres'),
          password: config.get<string>('DATABASE_PASSWORD', 'postgres'),
          database: config.get<string>('DATABASE_NAME', 'security_mvp'),
          autoLoadEntities: true,
          synchronize,
        };
      },
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
