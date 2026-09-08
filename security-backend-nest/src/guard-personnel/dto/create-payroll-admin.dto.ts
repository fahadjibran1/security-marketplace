import { IsDateString, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { GuardPayFrequency, GuardPayrollStatus } from '../entities/company-guard-payroll.entity';

export class CreatePayrollAdminDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  payrollReference?: string | null;

  @IsOptional()
  @IsEnum(GuardPayFrequency)
  payFrequency?: GuardPayFrequency | null;

  @IsOptional()
  @IsEnum(GuardPayrollStatus)
  payrollStatus?: GuardPayrollStatus;

  @IsOptional()
  @IsDateString()
  payrollStartDate?: string | null;

  @IsOptional()
  @IsDateString()
  payrollEndDate?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  payrollNote?: string | null;
}
