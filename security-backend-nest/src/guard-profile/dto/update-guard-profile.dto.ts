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
  siaExpiryDate?: string;

  @IsOptional()
  @IsString()
  rightToWorkStatus?: string;

  @IsOptional()
  @IsDateString()
  rightToWorkExpiryDate?: string;

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
