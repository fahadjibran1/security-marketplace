import { GuardAvailability } from '../entities/guard-profile.entity';

/**
 * approvalStatus is deliberately absent. It is platform-global legacy state that no longer affects
 * anything a Company can do, and a Company reading "approved" here would take it for an S4
 * endorsement of a Guard S4 may never have looked at. Screening state is served separately and
 * honestly by GET /screening/company/outcomes.
 */
export class GuardProfileCompanyResponseDto {
  id!: number;
  fullName!: string;
  phone!: string;
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
