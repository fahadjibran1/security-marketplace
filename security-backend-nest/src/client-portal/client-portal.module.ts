import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { ClientPortalUserModule } from '../client-portal-user/client-portal-user.module';
import { DailyLog } from '../daily-log/entities/daily-log.entity';
import { Incident } from '../incident/entities/incident.entity';
import { InvoiceBatchModule } from '../invoice-batch/invoice-batch.module';
import { InvoiceBatch } from '../invoice-batch/entities/invoice-batch.entity';
import { SafetyAlert } from '../safety-alert/entities/safety-alert.entity';
import { Shift } from '../shift/entities/shift.entity';
import { Site } from '../site/entities/site.entity';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { ClientPortalController } from './client-portal.controller';
import { ClientPortalService } from './client-portal.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Site, Timesheet, Incident, InvoiceBatch, Shift, SafetyAlert, DailyLog]),
    ClientPortalUserModule,
    InvoiceBatchModule,
    AuditLogModule,
  ],
  controllers: [ClientPortalController],
  providers: [ClientPortalService],
})
export class ClientPortalModule {}
