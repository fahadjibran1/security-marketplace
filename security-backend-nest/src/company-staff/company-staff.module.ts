import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthModule } from '../auth/auth.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { EmailModule } from '../email/email.module';
import { UserModule } from '../user/user.module';
import { CompanyStaffController, StaffInvitationAcceptanceController } from './company-staff.controller';
import { CompanyStaffService } from './company-staff.service';

@Module({
  imports: [AuthModule, AuditLogModule, CompanyMembershipModule, EmailModule, UserModule],
  controllers: [CompanyStaffController, StaffInvitationAcceptanceController],
  providers: [CompanyStaffService],
  exports: [CompanyStaffService],
})
export class CompanyStaffModule {}
