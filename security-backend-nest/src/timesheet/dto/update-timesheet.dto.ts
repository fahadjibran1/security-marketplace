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
  @IsString()
  companyNote?: string | null;

  @IsOptional()
  @IsString()
  correctionReason?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  approvedHours?: number | null;

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
  rejectionReason?: string | null;

  // RB-007: manager-supplied approved duration, in minutes — the payroll-authoritative
  // field. When it differs from the timesheet's verifiedMinutes, overrideReason is required.
  // overrideBy/overrideAt are never client-supplied; the server derives them from the
  // authenticated reviewer and the current time.
  @IsOptional()
  @IsNumber()
  @Min(0)
  approvedMinutes?: number;

  @IsOptional()
  @IsString()
  overrideReason?: string | null;
}
