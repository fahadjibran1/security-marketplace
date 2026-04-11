import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { AttendanceEvent } from './entities/attendance.entity';
import { ShiftModule } from '../shift/shift.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { TimesheetModule } from '../timesheet/timesheet.module';
import { AssignmentModule } from '../assignment/assignment.module';
import { CompanyModule } from '../company/company.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AttendanceEvent]),
    ShiftModule,
    GuardProfileModule,
    TimesheetModule,
    AssignmentModule,
    CompanyModule,
  ],
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
