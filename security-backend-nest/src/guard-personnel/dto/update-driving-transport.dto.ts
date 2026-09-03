import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { DrivingLicenceStatus, PrimaryTravelMethod } from '../entities/guard-driving-profile.entity';

export class UpdateDrivingTransportDto {
  // Must be supplied as true when changing licenceStatus to NONE and existing licence
  // details are present. Guards against accidental data loss from a stray mobile tap.
  @IsOptional()
  @IsBoolean()
  confirmRemoveLicenceDetails?: boolean;
  @IsOptional()
  @IsEnum(DrivingLicenceStatus)
  licenceStatus?: DrivingLicenceStatus;

  // Plaintext is received, validated, then immediately encrypted. Never logged or returned.
  @IsOptional()
  @IsString()
  licenceNumberPlaintext?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  licenceCategories?: string[] | null;

  @IsOptional()
  @IsString()
  licenceExpiryDate?: string | null;

  @IsOptional()
  @IsBoolean()
  willingToDriveToWork?: boolean | null;

  @IsOptional()
  @IsBoolean()
  ownsVehicle?: boolean | null;

  @IsOptional()
  @IsBoolean()
  hasVehicleAccess?: boolean | null;

  @IsOptional()
  @IsEnum(PrimaryTravelMethod)
  primaryTravelMethod?: PrimaryTravelMethod | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(250)
  maxTravelDistanceMiles?: number | null;
}
