import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttendanceEvent } from '../attendance/entities/attendance.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { DailyLog } from '../daily-log/entities/daily-log.entity';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { OperationsModule } from '../operations/operations.module';
import { SafetyAlertModule } from '../safety-alert/safety-alert.module';
import { Shift } from '../shift/entities/shift.entity';
import { ShiftModule } from '../shift/shift.module';
import { PushDevice } from './entities/push-device.entity';
import { WelfareReminder } from './entities/welfare-reminder.entity';
import { ExpoPushClient } from './expo-push.client';
import { WelfarePushController } from './welfare-push.controller';
import { WelfarePushService } from './welfare-push.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([PushDevice, WelfareReminder, Shift, DailyLog, AttendanceEvent]),
    AuditLogModule,
    GuardProfileModule,
    OperationsModule,
    SafetyAlertModule,
    ShiftModule,
  ],
  controllers: [WelfarePushController],
  providers: [WelfarePushService, ExpoPushClient],
  exports: [WelfarePushService],
})
export class WelfarePushModule {}
