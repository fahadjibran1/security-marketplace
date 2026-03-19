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
import { MatchingModule } from './matching/matching.module';
import { CompanyGuardModule } from './company-guard/company-guard.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        autoLoadEntities: true,
        synchronize: true,
        ssl:
          config.get<string>('DATABASE_SSL', 'true') === 'true'
            ? { rejectUnauthorized: false }
            : false,
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
    CompanyGuardModule,
    JobSlotModule,
    JobMatchModule,
    MatchingModule,
  ],
})
export class AppModule {}