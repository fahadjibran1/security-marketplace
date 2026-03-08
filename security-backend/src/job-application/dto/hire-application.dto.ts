import { IsBoolean, IsDateString, IsOptional, IsString } from 'class-validator';

export class HireApplicationDto {
  @IsOptional()
  @IsBoolean()
  createShift?: boolean;

  @IsOptional()
  @IsString()
  siteName?: string;

  @IsOptional()
  @IsDateString()
  start?: string;

  @IsOptional()
  @IsDateString()
  end?: string;
}
