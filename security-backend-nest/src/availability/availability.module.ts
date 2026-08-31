import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { CompanyModule } from '../company/company.module';
import { CompanyGuard } from '../company-guard/entities/company-guard.entity';
import { ComplianceModule } from '../compliance/compliance.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { LeaveModule } from '../leave/leave.module';
import { Shift } from '../shift/entities/shift.entity';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';
import { GuardAvailabilityOverride } from './entities/guard-availability-override.entity';
import { GuardAvailabilityRule } from './entities/guard-availability-rule.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([GuardAvailabilityRule, GuardAvailabilityOverride, Shift, CompanyGuard]),
    CompanyModule,
    GuardProfileModule,
    LeaveModule,
    ComplianceModule,
    AuditLogModule,
  ],
  controllers: [AvailabilityController],
  providers: [AvailabilityService],
  exports: [AvailabilityService, TypeOrmModule],
})
export class AvailabilityModule {}
