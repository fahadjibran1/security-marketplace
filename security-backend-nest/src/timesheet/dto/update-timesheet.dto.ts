import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class UpdateTimesheetDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  hoursWorked?: number;

  @IsOptional()
  @IsString()
  approvalStatus?: string;

  @IsOptional()
  @IsString()
  submittedAt?: string;

  @IsOptional()
  @IsString()
  actualCheckInAt?: string;

  @IsOptional()
  @IsString()
  actualCheckOutAt?: string;

  @IsOptional()
  @IsString()
  guardNote?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  workedMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  breakMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  roundedMinutes?: number;

  @IsOptional()
  @IsString()
  reviewedAt?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  reviewedByUserId?: number;

  @IsOptional()
  @IsString()
  rejectionReason?: string | null;
}
