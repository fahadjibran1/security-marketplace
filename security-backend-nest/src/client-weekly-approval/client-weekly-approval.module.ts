import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientWeeklyApprovalRequest } from './entities/client-weekly-approval-request.entity';
import { ClientWeeklyApprovalLine } from './entities/client-weekly-approval-line.entity';
import { ClientShiftDispute } from './entities/client-shift-dispute.entity';
import { ClientWeeklyApprovalService } from './client-weekly-approval.service';
import { ClientPortalWeeklyApprovalService } from './client-portal-weekly-approval.service';
import { ClientWeeklyApprovalController } from './client-weekly-approval.controller';
import { CompanyModule } from '../company/company.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ClientWeeklyApprovalRequest, ClientWeeklyApprovalLine, ClientShiftDispute]),
    CompanyModule,
    CompanyMembershipModule,
    AuditLogModule,
  ],
  controllers: [ClientWeeklyApprovalController],
  providers: [ClientWeeklyApprovalService, ClientPortalWeeklyApprovalService],
  exports: [ClientWeeklyApprovalService, ClientPortalWeeklyApprovalService],
})
export class ClientWeeklyApprovalModule {}
