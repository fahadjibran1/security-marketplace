import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompanyGuard } from './entities/company-guard.entity';
import { CompanyGuardService } from './company-guard.service';
import { CompanyGuardController } from './company-guard.controller';
import { CompanyModule } from '../company/company.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';

@Module({
  imports: [TypeOrmModule.forFeature([CompanyGuard]), CompanyModule, GuardProfileModule],
  providers: [CompanyGuardService],
  controllers: [CompanyGuardController],
  exports: [CompanyGuardService, TypeOrmModule],
})
export class CompanyGuardModule {}
