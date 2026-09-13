import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Attachment } from './entities/attachment.entity';
import { AttachmentController } from './attachment.controller';
import { AttachmentService } from './attachment.service';
import { UserModule } from '../user/user.module';
import { CompanyModule } from '../company/company.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { Incident } from '../incident/entities/incident.entity';
import { SafetyAlert } from '../safety-alert/entities/safety-alert.entity';
import { DailyLog } from '../daily-log/entities/daily-log.entity';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { Shift } from '../shift/entities/shift.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Attachment, Incident, SafetyAlert, DailyLog, Timesheet, Shift]),
    UserModule,
    CompanyModule,
    CompanyMembershipModule,
  ],
  controllers: [AttachmentController],
  providers: [AttachmentService],
  exports: [AttachmentService],
})
export class AttachmentModule {}
