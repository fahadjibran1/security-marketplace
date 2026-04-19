import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CompanyModule } from '../company/company.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { NotificationModule } from '../notification/notification.module';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { ComplianceRecord } from './entities/compliance-record.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ComplianceRecord]), CompanyModule, GuardProfileModule, NotificationModule],
  controllers: [ComplianceController],
  providers: [ComplianceService],
  exports: [ComplianceService, TypeOrmModule],
})
export class ComplianceModule {}
