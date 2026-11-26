import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthModule } from './auth.module';
import { AccountDeletionAdminController } from './account-deletion-admin.controller';
import { AccountDeletionAdminService } from './account-deletion-admin.service';

/**
 * Platform Admin account-deletion queue. It never closes a company: closing one is a separate, audited decision on the
 * Company verification screen (CompanyVerificationModule), which this module deliberately does not import.
 */
@Module({
  imports: [AuthModule, AuditLogModule],
  controllers: [AccountDeletionAdminController],
  providers: [AccountDeletionAdminService],
})
export class AccountDeletionAdminModule {}
