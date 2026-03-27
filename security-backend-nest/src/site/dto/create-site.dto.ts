import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateSiteDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  clientName?: string;

  @IsOptional()
  @IsInt()
  clientId?: number;

  @IsString()
  address!: string;

  @IsOptional()
  @IsString()
  contactDetails?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  requiredGuardCount?: number;

  @IsOptional()
  @IsString()
  operatingDays?: string;

  @IsOptional()
  @IsString()
  operatingStartTime?: string;

  @IsOptional()
  @IsString()
  operatingEndTime?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  welfareCheckIntervalMinutes?: number;

  @IsOptional()
  @IsString()
  specialInstructions?: string;
}
