import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CompanyModule } from '../company/company.module';
import { PayRuleConfig } from './entities/pay-rule-config.entity';
import { PayRuleController } from './pay-rule.controller';
import { PayRuleService } from './pay-rule.service';

@Module({
  imports: [TypeOrmModule.forFeature([PayRuleConfig]), CompanyModule],
  controllers: [PayRuleController],
  providers: [PayRuleService],
  exports: [PayRuleService, TypeOrmModule],
})
export class PayRuleModule {}
