import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

import { GuardAvailabilityOverrideStatus } from '../entities/guard-availability-override.entity';

export class UpsertAvailabilityOverrideDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  id?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  guardId?: number;

  @IsDateString()
  date!: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  startTime?: string | null;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  endTime?: string | null;

  @IsEnum(GuardAvailabilityOverrideStatus)
  status!: GuardAvailabilityOverrideStatus;

  @IsOptional()
  @IsString()
  note?: string | null;
}
