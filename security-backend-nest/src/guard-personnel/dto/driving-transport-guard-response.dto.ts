import { DrivingLicenceStatus, PrimaryTravelMethod } from '../entities/guard-driving-profile.entity';

export class DrivingTransportGuardResponseDto {
  guardId!: number;
  licenceStatus!: DrivingLicenceStatus;
  licenceNumberSet!: boolean;
  licenceNumberMasked!: string | null;
  licenceCategories!: string[] | null;
  licenceExpiryDate!: string | null;
  willingToDriveToWork!: boolean | null;
  ownsVehicle!: boolean | null;
  hasVehicleAccess!: boolean | null;
  primaryTravelMethod!: PrimaryTravelMethod | null;
  maxTravelDistanceMiles!: number | null;
}
