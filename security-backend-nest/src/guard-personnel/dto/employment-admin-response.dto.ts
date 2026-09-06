import { GuardEngagementType, GuardJobRole, GuardPayBasis, GuardWorkingArrangement } from '../entities/company-guard-employment.entity';

export class EmploymentAdminResponseDto {
  companyGuardId!: number;
  companyId!: number;
  companyName!: string;
  guardId!: number;
  engagementType!: GuardEngagementType;
  jobRole!: GuardJobRole;
  customRole!: string | null;
  workingArrangement!: GuardWorkingArrangement;
  startDate!: string;
  endDate!: string | null;
  payBasis!: GuardPayBasis;
  noticePeriodDays!: number | null;
  internalNote!: string | null;
  updatedAt!: string;
}
