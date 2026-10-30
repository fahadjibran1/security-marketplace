import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { OperationsModule } from '../operations/operations.module';
import { SafetyAlertModule } from '../safety-alert/safety-alert.module';
import { patrolEntities } from './entities';
import { PatrolEvidenceController, PatrolEvidenceGuardController } from './evidence/patrol-evidence.controller';
import { PatrolEvidenceExportService } from './evidence/patrol-evidence-export.service';
import { PatrolEvidenceLifecycleService } from './evidence/patrol-evidence-lifecycle.service';
import { PatrolEvidenceMaintenanceService } from './evidence/patrol-evidence-maintenance.service';
import { PatrolEvidenceService } from './evidence/patrol-evidence.service';
import { PatrolObjectStore } from './evidence/patrol-object-store';
import { PatrolAccessService } from './patrol-access.service';
import { PatrolAdminController } from './patrol-admin.controller';
import { PatrolAdminService } from './patrol-admin.service';
import { PatrolConfigController } from './patrol-config.controller';
import { PatrolConfigService } from './patrol-config.service';
import { PatrolExceptionService } from './patrol-exception.service';
import { PatrolGuardController } from './patrol-guard.controller';
import { PatrolGuardService } from './patrol-guard.service';
import { PatrolQueryService } from './patrol-query.service';
import { PatrolRecoveryGrantService } from './patrol-recovery-grant.service';
import { PatrolSweepService } from './patrol-sweep.service';
import { PatrolWindowService } from './patrol-window.service';

/**
 * Patrol Management, S4 Patrols Phase 1 package P1-A (Migration 68): the data model, the per-company switch, the
 * patrols.* permissions, company configuration and reads, and the Guard's idempotent run / scan / complete API.
 * P1-B (Migration 69) adds scheduling: site-local windows (PatrolWindowService), the deadline rules (patrol-state.ts), offline
 * sync after Book Off (patrol-late-sync.ts), exceptions with one SafetyAlert each (PatrolExceptionService) and the
 * five-minute sweep (PatrolSweepService).
 * P1-C (Migration 70) adds photo evidence: private S3-compatible storage (PatrolObjectStore), presigned upload with
 * server-side verification, audited downloads, holds, the deletion state machine with quarantine and restore
 * (PatrolEvidenceLifecycleService), bounded ZIP exports with manifests, live metering, and the five-minute maintenance job
 * (PatrolEvidenceMaintenanceService). See docs/patrols/P1-C-evidence-storage.md.
 * Issue #68 (Migration 72) adds exceptional offline recovery grants (PatrolRecoveryGrantService): an Owner / Admin lets one
 * Guard send one shift's patrol data after the post-shift sync window, time-boxed, audited, flagged recovered_via_grant.
 *
 * Patrol imports SafetyAlertModule (to act on its alerts through the existing lifecycle); the safety-alert side reaches
 * patrol exceptions only through patrol-alert-link.ts (plain SQL), so there is no module cycle.
 */
@Module({
  imports: [TypeOrmModule.forFeature(patrolEntities), CompanyMembershipModule, AuditLogModule, OperationsModule, SafetyAlertModule],
  controllers: [PatrolConfigController, PatrolGuardController, PatrolAdminController, PatrolEvidenceController, PatrolEvidenceGuardController],
  providers: [
    PatrolAccessService, PatrolConfigService, PatrolQueryService, PatrolGuardService, PatrolAdminService,
    PatrolWindowService, PatrolExceptionService, PatrolSweepService,
    PatrolObjectStore, PatrolEvidenceLifecycleService, PatrolEvidenceService, PatrolEvidenceExportService, PatrolEvidenceMaintenanceService,
    PatrolRecoveryGrantService,
  ],
  exports: [PatrolAccessService, PatrolConfigService, PatrolSweepService],
})
export class PatrolModule {}
