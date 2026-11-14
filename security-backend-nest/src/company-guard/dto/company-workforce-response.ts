import { CompanyMembershipRole } from '../../company-membership/company-membership-types';
import { GuardProfileCompanyResponseDto } from '../../guard-profile/dto/guard-profile-company-response.dto';
import { toCompanyWorkforceGuardDto } from '../../guard-profile/dto/guard-profile-response.mappers';
import {
  CompanyGuard,
  CompanyGuardRelationshipType,
  CompanyGuardStatus,
} from '../entities/company-guard.entity';

/**
 * The guard in a workforce row: GET /guards' company view plus the right-to-work status the workforce list shows,
 * under the same rules as SIA expiry (ACTIVE relationship, a role other than Finance or Viewer).
 */
export interface CompanyWorkforceGuardResponseDto extends GuardProfileCompanyResponseDto {
  rightToWorkStatus?: string | null;
}

/**
 * One row of a company's workforce list (GET /company-guards, and the result of the company's own PATCH/POST on a
 * relationship). Same shape the Company Portal reads: the relationship's id, status, type and dates, the company's
 * id and name, and the guard as the caller's role and this relationship's status allow.
 */
export interface CompanyWorkforceRelationDto {
  id: number;
  status: CompanyGuardStatus;
  relationshipType: CompanyGuardRelationshipType | null;
  acceptedAt: Date | null;
  createdAt: Date;
  company: { id: number; name: string };
  guard: CompanyWorkforceGuardResponseDto;
}

export function toCompanyWorkforceRelationDto(
  relation: CompanyGuard,
  membershipRole: CompanyMembershipRole,
): CompanyWorkforceRelationDto {
  return {
    id: relation.id,
    status: relation.status,
    relationshipType: relation.relationshipType ?? null,
    acceptedAt: relation.acceptedAt ?? null,
    createdAt: relation.createdAt,
    company: { id: relation.company.id, name: relation.company.name },
    guard: toCompanyWorkforceGuardDto(relation.guard, { membershipRole, relationshipStatus: relation.status }),
  };
}
