import { GuardApprovalStatus, GuardAvailability } from '../entities/guard-profile.entity';

export class GuardProfileCompanyResponseDto {
  id!: number;
  fullName!: string;
  phone!: string;
  approvalStatus!: GuardApprovalStatus;
  availability!: GuardAvailability;
  siaLicenseNumber!: string;
  siaExpiryDate?: string | null;
  locationSharingEnabled!: boolean;
  user!: {
    id: number;
    email: string;
    status: string;
  };
}
