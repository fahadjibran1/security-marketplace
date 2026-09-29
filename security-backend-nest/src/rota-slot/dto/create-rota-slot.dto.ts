import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { IsInstantString } from '../../common/validators/is-instant-string.validator';

export class CreateRotaSlotDto {
  @IsInt()
  @Min(1)
  siteId!: number;

  // Scheduled times are instants, carrying the site's offset. See IsInstantString.
  @IsInstantString()
  startAt!: string;

  @IsInstantString()
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
