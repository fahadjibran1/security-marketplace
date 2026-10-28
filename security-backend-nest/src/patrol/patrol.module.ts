import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { patrolEntities } from './entities';
import { PatrolAccessService } from './patrol-access.service';
import { PatrolAdminController } from './patrol-admin.controller';
import { PatrolAdminService } from './patrol-admin.service';
import { PatrolConfigController } from './patrol-config.controller';
import { PatrolConfigService } from './patrol-config.service';
import { PatrolGuardController } from './patrol-guard.controller';
import { PatrolGuardService } from './patrol-guard.service';
import { PatrolQueryService } from './patrol-query.service';

/**
 * Patrol Management, S4 Patrols Phase 1 package P1-A (Migration 68): the data model, the per-company switch, the
 * patrols.* permissions, company configuration and reads, and the Guard's idempotent run / scan / complete API.
 * Scheduling and exceptions (P1-B) and evidence upload, retention and holds (P1-C) build on this module.
 */
@Module({
  imports: [TypeOrmModule.forFeature(patrolEntities), CompanyMembershipModule, AuditLogModule],
  controllers: [PatrolConfigController, PatrolGuardController, PatrolAdminController],
  providers: [PatrolAccessService, PatrolConfigService, PatrolQueryService, PatrolGuardService, PatrolAdminService],
  exports: [PatrolAccessService, PatrolConfigService],
})
export class PatrolModule {}
