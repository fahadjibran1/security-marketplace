import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompanyGuard } from './entities/company-guard.entity';
import { CompanyGuardService } from './company-guard.service';
import { ComplianceModule } from '../compliance/compliance.module';
import { CompanyGuardController } from './company-guard.controller';
import { CompanyModule } from '../company/company.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';

@Module({
    imports: [TypeOrmModule.forFeature([CompanyGuard]), CompanyModule, GuardProfileModule, ComplianceModule],
  providers: [CompanyGuardService],
  controllers: [CompanyGuardController],
  exports: [CompanyGuardService, TypeOrmModule],
})
export class CompanyGuardModule {}
