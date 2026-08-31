import { GuardApprovalStatus, GuardAvailability } from '../entities/guard-profile.entity';

export class GuardProfileGuardResponseDto {
  id!: number;
  fullName!: string;
  phone!: string;
  locationSharingEnabled!: boolean;
  approvalStatus!: GuardApprovalStatus;
  availability!: GuardAvailability;
  siaLicenseNumber!: string;
  siaExpiryDate?: string | null;
  rightToWorkStatus?: string | null;
  rightToWorkExpiryDate?: string | null;
  user!: {
    id: number;
    email: string;
  };
}
