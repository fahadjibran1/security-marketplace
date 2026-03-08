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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DATABASE_HOST', 'localhost'),
        port: config.get<number>('DATABASE_PORT', 5432),
        username: config.get<string>('DATABASE_USER', 'postgres'),
        password: config.get<string>('DATABASE_PASSWORD', 'postgres'),
        database: config.get<string>('DATABASE_NAME', 'security_mvp'),
        autoLoadEntities: true,
        synchronize: true,
        ssl: config.get<string>('DATABASE_SSL', 'false') === 'true' ? { rejectUnauthorized: false } : false
      })
    }),
    UserModule,
    AuthModule,
    CompanyModule,
    GuardProfileModule,
    JobModule,
    JobApplicationModule,
    AssignmentModule,
    ShiftModule,
    TimesheetModule
  ]
})
export class AppModule {}
