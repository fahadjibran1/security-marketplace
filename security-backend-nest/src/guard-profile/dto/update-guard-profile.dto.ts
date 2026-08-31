import { IsBoolean, IsDateString, IsOptional, IsString } from 'class-validator';

export class UpdateGuardProfileDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  siaLicenseNumber?: string;

  @IsOptional()
  @IsDateString()
  siaExpiryDate?: string | null;

  @IsOptional()
  @IsString()
  rightToWorkStatus?: string | null;

  @IsOptional()
  @IsDateString()
  rightToWorkExpiryDate?: string | null;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsBoolean()
  locationSharingEnabled?: boolean;

  @IsOptional()
  @IsString()
  status?: string;
}
