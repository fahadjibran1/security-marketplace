import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Shift } from './entities/shift.entity';
import { ShiftController } from './shift.controller';
import { ShiftService } from './shift.service';
import { AssignmentModule } from '../assignment/assignment.module';
import { TimesheetModule } from '../timesheet/timesheet.module';
import { SiteModule } from '../site/site.module';
import { Company } from '../company/entities/company.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { Job } from '../job/entities/job.entity';
import { JobApplication } from '../job-application/entities/job-application.entity';
import { CompanyModule } from '../company/company.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { CompanyGuardModule } from '../company-guard/company-guard.module';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { ComplianceModule } from '../compliance/compliance.module';
import { AvailabilityModule } from '../availability/availability.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Shift, Company, GuardProfile, Job, JobApplication, Timesheet]),
    AssignmentModule,
    TimesheetModule,
    forwardRef(() => SiteModule),
    CompanyModule,
    GuardProfileModule,
    CompanyGuardModule,
    ComplianceModule,
    AvailabilityModule,
  ],
  controllers: [ShiftController],
  providers: [ShiftService],
  exports: [ShiftService, TypeOrmModule]
})
export class ShiftModule {}
