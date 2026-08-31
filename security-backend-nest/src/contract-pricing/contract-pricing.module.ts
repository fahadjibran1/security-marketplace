import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Client } from '../client/entities/client.entity';
import { CompanyModule } from '../company/company.module';
import { Site } from '../site/entities/site.entity';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { ContractPricingController } from './contract-pricing.controller';
import { ContractPricingRule } from './entities/contract-pricing-rule.entity';
import { ContractPricingService } from './contract-pricing.service';

@Module({
  imports: [TypeOrmModule.forFeature([ContractPricingRule, Client, Site, Timesheet]), CompanyModule],
  controllers: [ContractPricingController],
  providers: [ContractPricingService],
  exports: [ContractPricingService, TypeOrmModule],
})
export class ContractPricingModule {}
