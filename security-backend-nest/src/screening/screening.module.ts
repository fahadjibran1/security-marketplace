import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { CompanyGuard } from '../company-guard/entities/company-guard.entity';
import { CompanyModule } from '../company/company.module';
import { EvidenceStorageService, S3CompatibleEvidenceStorageService } from '../compliance/evidence-storage.service';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { GuardScreening, ScreeningAddress, ScreeningConsent, ScreeningEvidence, ScreeningException, ScreeningHistory, ScreeningReference } from './entities/screening.entities';
import { ScreeningController } from './screening.controller';
import { ScreeningService } from './screening.service';

@Module({
  imports:[TypeOrmModule.forFeature([GuardScreening,ScreeningHistory,ScreeningAddress,ScreeningReference,ScreeningEvidence,ScreeningConsent,ScreeningException,CompanyGuard]),GuardProfileModule,CompanyModule,AuditLogModule],
  controllers:[ScreeningController],
  providers:[ScreeningService,S3CompatibleEvidenceStorageService,{provide:EvidenceStorageService,useExisting:S3CompatibleEvidenceStorageService}],
  exports:[ScreeningService],
})
export class ScreeningModule {}
