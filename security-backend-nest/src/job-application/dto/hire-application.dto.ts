import { IsBoolean, IsDateString, IsInt, IsOptional, IsString } from 'class-validator';

export class HireApplicationDto {
  @IsOptional()
  @IsBoolean()
  createShift?: boolean;

  @IsOptional()
  @IsString()
  siteName?: string;

  @IsOptional()
  @IsInt()
  siteId?: number;

  @IsOptional()
  @IsDateString()
  start?: string;

  @IsOptional()
  @IsDateString()
  end?: string;
}
