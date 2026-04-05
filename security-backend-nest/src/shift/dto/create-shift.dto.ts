import { IsDateString, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateShiftDto {
  @IsOptional()
  @IsInt()
  assignmentId?: number;

  @IsOptional()
  @IsInt()
  companyId?: number;

  @IsOptional()
  @IsInt()
  guardId?: number;

  @IsOptional()
  @IsInt()
  jobId?: number;

  @IsOptional()
  @IsInt()
  jobApplicationId?: number;

  @IsOptional()
  @IsInt()
  createdByUserId?: number;

  @IsInt()
  siteId?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  checkCallIntervalMinutes?: number;

  @IsOptional()
  @IsString()
  siteName?: string;

  @IsDateString()
  start!: string;

  @IsDateString()
  end!: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  instructions?: string;
}
