import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateGuardProfileDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  siaLicenseNumber?: string;

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
