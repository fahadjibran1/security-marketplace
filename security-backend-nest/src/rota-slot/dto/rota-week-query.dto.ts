import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class RotaWeekQueryDto {
  /** ISO date YYYY-MM-DD — must be a Monday */
  @IsString()
  weekCommencing!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  clientId?: number;

  /** Comma-separated site IDs or array of numeric IDs */
  @IsOptional()
  @IsString()
  siteIds?: string;

  @IsOptional()
  @IsString()
  status?: string;
}
