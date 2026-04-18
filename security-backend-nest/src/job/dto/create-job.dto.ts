import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateJobDto {
  @IsOptional()
  @IsInt()
  companyId?: number;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsInt()
  @Min(1)
  guardsRequired!: number;

  @IsNumber()
  @Min(0)
  hourlyRate!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  billingRate?: number | null;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsInt()
  siteId?: number;
}
