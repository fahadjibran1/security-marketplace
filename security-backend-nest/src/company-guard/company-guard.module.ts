import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompanyGuard } from './entities/company-guard.entity';
import { CompanyGuardInvitation } from './entities/company-guard-invitation.entity';
import { CompanyGuardService } from './company-guard.service';
import { CompanyGuardInvitationService } from './company-guard-invitation.service';
import { CompanyGuardController } from './company-guard.controller';
import {
  CompanyGuardInvitationController,
  GuardWorkforceInvitationController,
} from './company-guard-invitation.controller';
import { CompanyModule } from '../company/company.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CompanyGuard, CompanyGuardInvitation]),
    CompanyModule,
    CompanyMembershipModule,
    GuardProfileModule,
    AuditLogModule,
    // For the throttler configuration behind the guard-facing redemption routes. forwardRef because
    // AuthModule imports GuardProfileModule, which this module also imports.
    forwardRef(() => AuthModule),
  ],
  providers: [CompanyGuardService, CompanyGuardInvitationService],
  // The invitation controllers are registered first so their more specific paths are matched before
  // the parameterised routes on CompanyGuardController.
  controllers: [
    CompanyGuardInvitationController,
    GuardWorkforceInvitationController,
    CompanyGuardController,
  ],
  exports: [CompanyGuardService, CompanyGuardInvitationService, TypeOrmModule],
})
export class CompanyGuardModule {}
