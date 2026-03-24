import { IsDateString, IsInt, IsOptional, IsString } from 'class-validator';

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

  @IsOptional()
  @IsInt()
  siteId?: number;

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
}
