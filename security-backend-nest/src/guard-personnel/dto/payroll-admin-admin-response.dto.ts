import { GuardPayFrequency, GuardPayrollPaymentMethod, GuardPayrollStatus } from '../entities/company-guard-payroll.entity';

// Platform Admin view: all fields except payrollNote (company-owned internal data).
export class PayrollAdminAdminResponseDto {
  companyGuardId!: number;
  guardId!: number;
  companyId!: number;
  companyName!: string;
  payrollReference!: string | null;
  payFrequency!: GuardPayFrequency | null;
  payrollPaymentMethod!: GuardPayrollPaymentMethod | null;
  payrollStatus!: GuardPayrollStatus;
  payrollStartDate!: string | null;
  payrollEndDate!: string | null;
  createdAt!: string;
  updatedAt!: string;
}
