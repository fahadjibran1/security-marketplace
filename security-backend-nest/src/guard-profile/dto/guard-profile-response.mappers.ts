import { GuardProfile } from '../entities/guard-profile.entity';
import { GuardProfileGuardResponseDto } from './guard-profile-guard-response.dto';
import { GuardProfileCompanyResponseDto } from './guard-profile-company-response.dto';
import { CompanyMembershipRole } from '../../company-membership/company-membership-types';
import { CompanyGuardStatus } from '../../company-guard/entities/company-guard.entity';
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

/** GET /guards' company view, plus the right-to-work status the workforce list (GET /company-guards) adds. */
type CompanyGuardView = GuardProfileCompanyResponseDto & { rightToWorkStatus?: string | null };

/** Who is asking (their membership role) and where the guard stands with that company. */
export interface CompanyGuardAccess {
  membershipRole: CompanyMembershipRole;
  relationshipStatus: CompanyGuardStatus;
}

/** Roles that may see a guard's licence details. Finance, Viewer and any role not named here see name and id only. */
const LICENCE_ROLES: ReadonlySet<CompanyMembershipRole> = new Set([
  CompanyMembershipRole.OWNER,
  CompanyMembershipRole.ADMIN,
  CompanyMembershipRole.OPERATIONS,
  CompanyMembershipRole.CONTROL_ROOM,
  CompanyMembershipRole.HR_COMPLIANCE,
]);
/** Roles with an operational or welfare need to contact a guard who currently works for the company. */
const CONTACT_ROLES: ReadonlySet<CompanyMembershipRole> = new Set([
  CompanyMembershipRole.OWNER,
  CompanyMembershipRole.ADMIN,
  CompanyMembershipRole.OPERATIONS,
  CompanyMembershipRole.CONTROL_ROOM,
]);

function companyGuardView(
  entity: GuardProfile,
  access: CompanyGuardAccess,
  includeRightToWork: boolean,
): CompanyGuardView {
  const view: CompanyGuardView = { id: entity.id, fullName: entity.fullName };
  if (!LICENCE_ROLES.has(access.membershipRole)) return view;

  // A former employer (INACTIVE or BLOCKED) keeps the licence number to match its own records, nothing current.
  view.siaLicenseNumber = entity.siaLicenseNumber;
  if (access.relationshipStatus !== CompanyGuardStatus.ACTIVE) return view;

  view.siaExpiryDate = entity.siaExpiryDate ?? null;
  if (includeRightToWork) view.rightToWorkStatus = entity.rightToWorkStatus ?? null;
  if (CONTACT_ROLES.has(access.membershipRole)) view.phone = entity.phone;
  return view;
}

/** GET /guards and GET /guards/:id for a company user. */
export function toCompanyDto(entity: GuardProfile, access: CompanyGuardAccess): GuardProfileCompanyResponseDto {
  return companyGuardView(entity, access, false);
}

/** The guard inside a GET /company-guards row. */
export function toCompanyWorkforceGuardDto(
  entity: GuardProfile,
  access: CompanyGuardAccess,
): CompanyGuardView {
  return companyGuardView(entity, access, true);
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
