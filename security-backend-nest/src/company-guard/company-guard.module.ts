import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompanyGuard } from './entities/company-guard.entity';
import { CompanyGuardService } from './company-guard.service';
import { ComplianceModule } from '../compliance/compliance.module';
import { CompanyGuardController } from './company-guard.controller';
import { CompanyModule } from '../company/company.module';
import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [TypeOrmModule.forFeature([CompanyGuard]), CompanyModule, CompanyMembershipModule, GuardProfileModule, ComplianceModule, AuditLogModule],
  providers: [CompanyGuardService],
  controllers: [CompanyGuardController],
  exports: [CompanyGuardService, TypeOrmModule],
})
export class CompanyGuardModule {}
