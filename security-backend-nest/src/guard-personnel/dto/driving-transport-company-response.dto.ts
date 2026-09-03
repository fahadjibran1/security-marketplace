import { PrimaryTravelMethod } from '../entities/guard-driving-profile.entity';

// Company operational view — licence number and licence details are intentionally excluded.
// Companies see only transport capability relevant to site coverage decisions.
export class DrivingTransportCompanyResponseDto {
  guardId!: number;
  primaryTravelMethod!: PrimaryTravelMethod | null;
  maxTravelDistanceMiles!: number | null;
  willingToDriveToWork!: boolean | null;
  hasVehicleAccess!: boolean | null;
}
