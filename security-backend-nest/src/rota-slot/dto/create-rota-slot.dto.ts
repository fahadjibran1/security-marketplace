import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateRotaSlotDto {
  @IsInt()
  @Min(1)
  siteId!: number;

  @IsDateString()
  startAt!: string;

  @IsDateString()
  endAt!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  requiredGuardCount?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  checkCallIntervalMinutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  instructions?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  jobId?: number;
}
