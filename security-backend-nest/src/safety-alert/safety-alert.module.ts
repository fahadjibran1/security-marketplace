import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SafetyAlert } from './entities/safety-alert.entity';
import { SafetyAlertController } from './safety-alert.controller';
import { SafetyAlertService } from './safety-alert.service';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { ShiftModule } from '../shift/shift.module';
import { CompanyModule } from '../company/company.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationModule } from '../notification/notification.module';
import { DailyLog } from '../daily-log/entities/daily-log.entity';
import { AttendanceEvent } from '../attendance/entities/attendance.entity';
import { Shift } from '../shift/entities/shift.entity';
import { OperationsModule } from '../operations/operations.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { ExpoPushClient } from '../welfare-push/expo-push.client';
import { EmergencyPushService } from './emergency-push.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([SafetyAlert, DailyLog, AttendanceEvent, Shift]),
    OperationsModule,
    GuardProfileModule,
    ShiftModule,
    CompanyModule,
    AuditLogModule,
    NotificationModule,
    ComplianceModule,
  ],
  controllers: [SafetyAlertController],
  // S4-EM-01: the Expo client is stateless (ConfigService only), so it is provided here as well as in WelfarePushModule,
  // which imports this module and so cannot be imported by it.
  providers: [SafetyAlertService, EmergencyPushService, ExpoPushClient],
  exports: [SafetyAlertService, TypeOrmModule],
})
export class SafetyAlertModule {}
