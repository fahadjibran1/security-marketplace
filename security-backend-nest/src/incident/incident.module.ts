import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Incident } from './entities/incident.entity';
import { IncidentController } from './incident.controller';
import { IncidentService } from './incident.service';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { ShiftModule } from '../shift/shift.module';
import { CompanyModule } from '../company/company.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Incident]),
    GuardProfileModule,
    ShiftModule,
    CompanyModule,
    AuditLogModule,
    NotificationModule,
  ],
  controllers: [IncidentController],
  providers: [IncidentService],
  exports: [IncidentService],
})
export class IncidentModule {}
