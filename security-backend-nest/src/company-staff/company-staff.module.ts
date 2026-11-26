import { Module } from '@nestjs/common';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthModule } from '../auth/auth.module';
import { UserModule } from '../user/user.module';
import { EmailModule } from '../email/email.module';
import { CompanyStaffService } from './company-staff.service';
import { CompanyStaffController, CompanyStaffInvitationAcceptController } from './company-staff.controller';

/** Company staff management: Team list, staff invitations by email, role changes and access revocation. */
@Module({
  imports: [CompanyMembershipModule, AuditLogModule, AuthModule, UserModule, EmailModule],
  controllers: [CompanyStaffController, CompanyStaffInvitationAcceptController],
  providers: [CompanyStaffService],
})
export class CompanyStaffModule {}
