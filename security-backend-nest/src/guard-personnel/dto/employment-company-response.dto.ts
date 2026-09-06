import { GuardEngagementType, GuardJobRole, GuardPayBasis, GuardWorkingArrangement } from '../entities/company-guard-employment.entity';

export class EmploymentCompanyResponseDto {
  companyGuardId!: number;
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
