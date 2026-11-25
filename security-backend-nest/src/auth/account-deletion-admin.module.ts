import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { CompanyVerificationModule } from '../company/verification/company-verification.module';
import { AuthModule } from './auth.module';
import { AccountDeletionAdminController } from './account-deletion-admin.controller';
import { AccountDeletionAdminService } from './account-deletion-admin.service';

/**
 * Platform Admin account-deletion queue. A module of its own so AuthModule does not have to import company
 * verification (which closes an owner's companies on completion).
 */
@Module({
  imports: [AuthModule, CompanyVerificationModule, AuditLogModule],
  controllers: [AccountDeletionAdminController],
  providers: [AccountDeletionAdminService],
})
export class AccountDeletionAdminModule {}
