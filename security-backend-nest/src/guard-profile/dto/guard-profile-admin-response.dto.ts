import { GuardApprovalStatus, GuardAvailability } from '../entities/guard-profile.entity';

export class GuardProfileAdminResponseDto {
  id!: number;
  fullName!: string;
  phone!: string;
  locationSharingEnabled!: boolean;
  approvalStatus!: GuardApprovalStatus;
  isApproved!: boolean;
  status!: string;
  availability!: GuardAvailability;
  siaLicenseNumber!: string;
  siaExpiryDate?: string | null;
  rightToWorkStatus?: string | null;
  rightToWorkExpiryDate?: string | null;
  notes?: string | null;
  user!: {
    id: number;
    email: string;
    status: string;
    role: string;
    isEmailVerified: boolean;
    lastLoginAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
}
