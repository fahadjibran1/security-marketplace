import { GuardProfile } from '../entities/guard-profile.entity';
import { GuardProfileGuardResponseDto } from './guard-profile-guard-response.dto';
import { GuardProfileCompanyResponseDto } from './guard-profile-company-response.dto';
import { GuardProfileAdminResponseDto } from './guard-profile-admin-response.dto';

export function toGuardDto(entity: GuardProfile): GuardProfileGuardResponseDto {
  return {
    id: entity.id,
    fullName: entity.fullName,
    phone: entity.phone,
    locationSharingEnabled: entity.locationSharingEnabled,
    approvalStatus: entity.approvalStatus,
    availability: entity.availability,
    siaLicenseNumber: entity.siaLicenseNumber,
    siaExpiryDate: entity.siaExpiryDate ?? null,
    rightToWorkStatus: entity.rightToWorkStatus ?? null,
    rightToWorkExpiryDate: entity.rightToWorkExpiryDate ?? null,
    user: {
      id: entity.user.id,
      email: entity.user.email,
    },
  };
}

export function toCompanyDto(entity: GuardProfile): GuardProfileCompanyResponseDto {
  return {
    id: entity.id,
    fullName: entity.fullName,
    phone: entity.phone,
    approvalStatus: entity.approvalStatus,
    availability: entity.availability,
    siaLicenseNumber: entity.siaLicenseNumber,
    siaExpiryDate: entity.siaExpiryDate ?? null,
    locationSharingEnabled: entity.locationSharingEnabled,
    user: {
      id: entity.user.id,
      email: entity.user.email,
      status: entity.user.status,
    },
  };
}

export function toAdminDto(entity: GuardProfile): GuardProfileAdminResponseDto {
  return {
    id: entity.id,
    fullName: entity.fullName,
    phone: entity.phone,
    locationSharingEnabled: entity.locationSharingEnabled,
    approvalStatus: entity.approvalStatus,
    isApproved: entity.isApproved,
    status: entity.status,
    availability: entity.availability,
    siaLicenseNumber: entity.siaLicenseNumber,
    siaExpiryDate: entity.siaExpiryDate ?? null,
    rightToWorkStatus: entity.rightToWorkStatus ?? null,
    rightToWorkExpiryDate: entity.rightToWorkExpiryDate ?? null,
    notes: entity.notes ?? null,
    user: {
      id: entity.user.id,
      email: entity.user.email,
      status: entity.user.status,
      role: entity.user.role,
      isEmailVerified: entity.user.isEmailVerified,
      lastLoginAt: entity.user.lastLoginAt ?? null,
      createdAt: entity.user.createdAt,
      updatedAt: entity.user.updatedAt,
    },
  };
}
