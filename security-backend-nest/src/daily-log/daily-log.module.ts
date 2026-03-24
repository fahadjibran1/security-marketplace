import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DailyLog } from './entities/daily-log.entity';
import { DailyLogController } from './daily-log.controller';
import { DailyLogService } from './daily-log.service';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { ShiftModule } from '../shift/shift.module';
import { CompanyModule } from '../company/company.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DailyLog]),
    GuardProfileModule,
    ShiftModule,
    CompanyModule,
    AuditLogModule,
  ],
  controllers: [DailyLogController],
  providers: [DailyLogService],
  exports: [DailyLogService, TypeOrmModule],
})
export class DailyLogModule {}
