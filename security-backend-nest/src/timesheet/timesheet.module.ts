import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Timesheet } from './entities/timesheet.entity';
import { TimesheetController } from './timesheet.controller';
import { TimesheetService } from './timesheet.service';

@Module({
  imports: [TypeOrmModule.forFeature([Timesheet])],
  controllers: [TimesheetController],
  providers: [TimesheetService],
  exports: [TimesheetService, TypeOrmModule]
})
export class TimesheetModule {}
