import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateContractPricingRuleDto {
  @IsInt()
  @Min(1)
  clientId!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  siteId?: number | null;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  priority?: number;

  @IsOptional()
  @IsString()
  effectiveFrom?: string | null;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  billingRate?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minimumBillableHours?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  roundUpToMinutes?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  graceMinutes?: number | null;

  @IsOptional()
  @IsBoolean()
  appliesOnMonday?: boolean;

  @IsOptional()
  @IsBoolean()
  appliesOnTuesday?: boolean;

  @IsOptional()
  @IsBoolean()
  appliesOnWednesday?: boolean;

  @IsOptional()
  @IsBoolean()
  appliesOnThursday?: boolean;

  @IsOptional()
  @IsBoolean()
  appliesOnFriday?: boolean;

  @IsOptional()
  @IsBoolean()
  appliesOnSaturday?: boolean;

  @IsOptional()
  @IsBoolean()
  appliesOnSunday?: boolean;

  @IsOptional()
  @IsString()
  startTime?: string | null;

  @IsOptional()
  @IsString()
  endTime?: string | null;

  @IsOptional()
  @IsBoolean()
  appliesOnBankHoliday?: boolean | null;

  @IsOptional()
  @IsBoolean()
  appliesOnWeekendOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  appliesOnOvernightShift?: boolean | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  flatCallOutFee?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  deductionHoursBeforeBilling?: number | null;

  @IsOptional()
  @IsString()
  notes?: string | null;
}
