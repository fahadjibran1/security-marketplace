import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  GuardEngagementType,
  GuardJobRole,
  GuardPayBasis,
  GuardWorkingArrangement,
} from '../entities/company-guard-employment.entity';

export class UpdateCompanyGuardEmploymentDto {
  @IsOptional()
  @IsEnum(GuardEngagementType)
  engagementType?: GuardEngagementType;

  @IsOptional()
  @IsEnum(GuardJobRole)
  jobRole?: GuardJobRole;

  @IsOptional()
  @ValidateIf((o) => o.customRole !== null)
  @IsString()
  @MaxLength(100)
  customRole?: string | null;

  @IsOptional()
  @IsEnum(GuardWorkingArrangement)
  workingArrangement?: GuardWorkingArrangement;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @ValidateIf((o) => o.endDate !== null)
  @IsDateString()
  endDate?: string | null;

  @IsOptional()
  @IsEnum(GuardPayBasis)
  payBasis?: GuardPayBasis;

  @IsOptional()
  @ValidateIf((o) => o.noticePeriodDays !== null)
  @IsInt()
  @Min(0)
  @Max(365)
  noticePeriodDays?: number | null;

  @IsOptional()
  @ValidateIf((o) => o.internalNote !== null)
  @IsString()
  @MaxLength(1000)
  internalNote?: string | null;
}
