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

@Module({
  imports: [
    TypeOrmModule.forFeature([SafetyAlert]),
    GuardProfileModule,
    ShiftModule,
    CompanyModule,
    AuditLogModule,
    NotificationModule,
  ],
  controllers: [SafetyAlertController],
  providers: [SafetyAlertService],
  exports: [SafetyAlertService, TypeOrmModule],
})
export class SafetyAlertModule {}
