import { PartialType } from '@nestjs/swagger';
import { CreateContractPricingRuleDto } from './create-contract-pricing-rule.dto';

export class UpdateContractPricingRuleDto extends PartialType(CreateContractPricingRuleDto) {}
