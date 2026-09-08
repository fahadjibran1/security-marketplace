import { GuardPayFrequency, GuardPayrollStatus } from '../entities/company-guard-payroll.entity';

// Restricted view: Guard sees frequency, status, and dates only.
// payrollReference and payrollNote are company-only and excluded.
export class PayrollAdminGuardResponseDto {
  companyGuardId!: number;
  guardId!: number;
  companyId!: number;
  companyName!: string;
  payFrequency!: GuardPayFrequency | null;
  payrollStatus!: GuardPayrollStatus;
  payrollStartDate!: string | null;
  payrollEndDate!: string | null;
  updatedAt!: string;
}
