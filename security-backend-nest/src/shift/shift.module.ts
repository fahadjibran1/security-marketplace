import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Shift } from './entities/shift.entity';
import { ShiftController } from './shift.controller';
import { ShiftService } from './shift.service';
import { AssignmentModule } from '../assignment/assignment.module';
import { TimesheetModule } from '../timesheet/timesheet.module';
import { SiteModule } from '../site/site.module';

@Module({
  imports: [TypeOrmModule.forFeature([Shift]), AssignmentModule, TimesheetModule, SiteModule],
  controllers: [ShiftController],
  providers: [ShiftService],
  exports: [ShiftService, TypeOrmModule]
})
export class ShiftModule {}
