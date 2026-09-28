import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AvailabilityModule } from '../availability/availability.module';
import { AttendanceEvent } from '../attendance/entities/attendance.entity';
import { DailyLog } from '../daily-log/entities/daily-log.entity';
import { OperationsModule } from '../operations/operations.module';
import { SafetyAlert } from '../safety-alert/entities/safety-alert.entity';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { Shift } from '../shift/entities/shift.entity';
import { CoverageController } from './coverage.controller';
import { CoverageService } from './coverage.service';
import { OperationsProjectionService } from './operations-projection.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Shift, AttendanceEvent, DailyLog, SafetyAlert]),
    CompanyMembershipModule,
    AvailabilityModule,
    OperationsModule,
  ],
  controllers: [CoverageController],
  providers: [CoverageService, OperationsProjectionService],
  exports: [CoverageService, OperationsProjectionService],
})
export class CoverageModule {}
