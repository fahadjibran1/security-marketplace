import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

export class CreateGuardProfileDto {
  @IsInt()
  userId!: number;

  @IsString()
  fullName!: string;

  @IsString()
  siaLicenseNumber!: string;

  @IsString()
  phone!: string;

  @IsOptional()
  @IsBoolean()
  locationSharingEnabled?: boolean;

  @IsOptional()
  @IsString()
  status?: string;
}
