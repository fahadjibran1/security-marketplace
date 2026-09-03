import { DrivingLicenceStatus, PrimaryTravelMethod } from '../entities/guard-driving-profile.entity';

// Company operational view — licence number (masked or full) is intentionally excluded.
// All fields are self-declared; no verification status is implied by this response.
// Only accessible by a company with an ACTIVE relationship with the guard.
export class DrivingTransportCompanyResponseDto {
  guardId!: number;
  licenceStatus!: DrivingLicenceStatus;
  licenceCategories!: string[] | null;
  licenceExpiryDate!: string | null;
  willingToDriveToWork!: boolean | null;
  ownsVehicle!: boolean | null;
  hasVehicleAccess!: boolean | null;
  primaryTravelMethod!: PrimaryTravelMethod | null;
  maxTravelDistanceMiles!: number | null;
}
