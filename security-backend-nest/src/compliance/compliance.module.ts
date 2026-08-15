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
import { JobApplication } from '../job-application/entities/job-application.entity';
import { PreHireComplianceAuthorizationService } from './pre-hire-compliance-authorization.service';
import { EvidenceStorageService, S3CompatibleEvidenceStorageService } from './evidence-storage.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ComplianceRecord, GuardDocument, CompanyGuard, JobApplication]),
    CompanyModule,
    GuardProfileModule,
    NotificationModule,
    AuditLogModule,
  ],
  controllers: [ComplianceController],
  providers: [
    ComplianceService,
    GuardComplianceService,
    PreHireComplianceAuthorizationService,
    S3CompatibleEvidenceStorageService,
    { provide: EvidenceStorageService, useExisting: S3CompatibleEvidenceStorageService },
  ],
  exports: [ComplianceService, GuardComplianceService, TypeOrmModule],
})
export class ComplianceModule {}
