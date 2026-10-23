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
import { EarlyBookOffService } from './early-book-off.service';
import { RotaSlot } from '../rota-slot/entities/rota-slot.entity';
import { WelfareReminder } from '../welfare-push/entities/welfare-reminder.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Shift, AttendanceEvent, DailyLog, SafetyAlert, RotaSlot, WelfareReminder]),
    CompanyMembershipModule,
    AvailabilityModule,
    OperationsModule,
  ],
  controllers: [CoverageController],
  providers: [CoverageService, OperationsProjectionService, EarlyBookOffService],
  exports: [CoverageService, OperationsProjectionService, EarlyBookOffService],
})
export class CoverageModule {}
