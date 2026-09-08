import { GuardPayFrequency, GuardPayrollStatus } from '../entities/company-guard-payroll.entity';

export class PayrollAdminCompanyResponseDto {
  companyGuardId!: number;
  guardId!: number;
  companyId!: number;
  payrollReference!: string | null;
  payFrequency!: GuardPayFrequency | null;
  payrollStatus!: GuardPayrollStatus;
  payrollStartDate!: string | null;
  payrollEndDate!: string | null;
  payrollNote!: string | null;
  createdAt!: string;
  updatedAt!: string;
}
