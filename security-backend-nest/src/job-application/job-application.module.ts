import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobApplication } from './entities/job-application.entity';
import { JobApplicationController } from './job-application.controller';
import { JobApplicationService } from './job-application.service';
import { JobModule } from '../job/job.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { AssignmentModule } from '../assignment/assignment.module';
import { ShiftModule } from '../shift/shift.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([JobApplication]),
    JobModule,
    GuardProfileModule,
    forwardRef(() => AssignmentModule),
    forwardRef(() => ShiftModule),
    AuditLogModule,
    NotificationModule,
  ],
  controllers: [JobApplicationController],
  providers: [JobApplicationService],
  exports: [JobApplicationService, TypeOrmModule]
})
export class JobApplicationModule {}
