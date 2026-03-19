import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Timesheet } from './entities/timesheet.entity';
import { TimesheetController } from './timesheet.controller';
import { TimesheetService } from './timesheet.service';
import { CompanyModule } from '../company/company.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';

@Module({
  imports: [TypeOrmModule.forFeature([Timesheet]), CompanyModule, GuardProfileModule],
  controllers: [TimesheetController],
  providers: [TimesheetService],
  exports: [TimesheetService, TypeOrmModule]
})
export class TimesheetModule {}
