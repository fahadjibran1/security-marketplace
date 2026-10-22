import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AvailabilityModule } from '../availability/availability.module';
import { CompanyGuardModule } from '../company-guard/company-guard.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { EmailModule } from '../email/email.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { CompanyShiftPolicy } from './entities/company-shift-policy.entity';
import { ShiftAmendment } from './entities/shift-amendment.entity';
import { ShiftAmendmentController } from './shift-amendment.controller';
import { ShiftAmendmentService } from './shift-amendment.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ShiftAmendment, CompanyShiftPolicy]),
    AuditLogModule,
    AvailabilityModule,
    CompanyGuardModule,
    CompanyMembershipModule,
    ComplianceModule,
    EmailModule,
    GuardProfileModule,
  ],
  controllers: [ShiftAmendmentController],
  providers: [ShiftAmendmentService],
  exports: [ShiftAmendmentService],
})
export class ShiftAmendmentModule {}
