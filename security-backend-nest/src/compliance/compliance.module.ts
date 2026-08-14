import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CompanyGuard } from '../company-guard/entities/company-guard.entity';
import { CompanyModule } from '../company/company.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { NotificationModule } from '../notification/notification.module';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { ComplianceRecord } from './entities/compliance-record.entity';
import { GuardDocument } from './entities/guard-document.entity';
import { GuardComplianceService } from './guard-compliance.service';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ComplianceRecord, GuardDocument, CompanyGuard]),
    CompanyModule,
    GuardProfileModule,
    NotificationModule,
    AuditLogModule,
  ],
  controllers: [ComplianceController],
  providers: [ComplianceService, GuardComplianceService],
  exports: [ComplianceService, GuardComplianceService, TypeOrmModule],
})
export class ComplianceModule {}
