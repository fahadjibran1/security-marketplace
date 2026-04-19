import { IsInt, IsNumber, IsOptional, Matches, Min } from 'class-validator';

export class UpsertPayRuleConfigDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  overtimeThresholdHours?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  overtimeMultiplier?: number;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  nightStart?: string | null;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  nightEnd?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  nightMultiplier?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  weekendMultiplier?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  bankHolidayMultiplier?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minimumPaidHours?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  unpaidBreakMinutes?: number;
}
