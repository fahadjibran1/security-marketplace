import { IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { GuardApprovalStatus, GuardAvailability } from '../entities/guard-profile.entity';

export class CreateGuardProfileDto {
  @IsInt()
  userId!: number;

  @IsString()
  fullName!: string;

  @IsString()
  siaLicenseNumber!: string;

  @IsOptional()
  @IsDateString()
  siaExpiryDate?: string;

  @IsOptional()
  @IsString()
  rightToWorkStatus?: string;

  @IsOptional()
  @IsDateString()
  rightToWorkExpiryDate?: string;

  @IsString()
  phone!: string;

  @IsOptional()
  @IsBoolean()
  locationSharingEnabled?: boolean;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsEnum(GuardAvailability)
  availability?: GuardAvailability;

  @IsOptional()
  @IsEnum(GuardApprovalStatus)
  approvalStatus?: GuardApprovalStatus;

  @IsOptional()
  @IsBoolean()
  isApproved?: boolean;
}
