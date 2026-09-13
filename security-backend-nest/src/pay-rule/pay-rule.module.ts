import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CompanyMembershipModule } from '../company-membership/company-membership.module';
import { PayRuleConfig } from './entities/pay-rule-config.entity';
import { PayRuleController } from './pay-rule.controller';
import { PayRuleService } from './pay-rule.service';

@Module({
  imports: [TypeOrmModule.forFeature([PayRuleConfig]), CompanyMembershipModule],
  controllers: [PayRuleController],
  providers: [PayRuleService],
  exports: [PayRuleService, TypeOrmModule],
})
export class PayRuleModule {}
