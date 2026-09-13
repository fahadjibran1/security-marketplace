import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Company } from '../company/entities/company.entity';
import { UserRole } from '../user/entities/user.entity';
import { CompanyMembership } from './entities/company-membership.entity';
import {
  CompanyMembershipRole,
  CompanyMembershipStatus,
  CompanyPermission,
  hasPermission,
} from './company-membership-types';
import { CompanyService } from '../company/company.service';

export interface CompanyContext {
  company: Company;
  membershipRole: CompanyMembershipRole;
}

@Injectable()
export class CompanyMembershipService {
  constructor(
    @InjectRepository(CompanyMembership)
    private readonly membershipRepo: Repository<CompanyMembership>,
    private readonly companyService: CompanyService,
  ) {}

  /**
   * Canonical company context resolution for all company-scoped operations.
   *
   * Resolution order (deterministic — always queries ACTIVE first):
   *  1. ACTIVE membership found → enforce permission, return context
   *  2. SUSPENDED membership (no ACTIVE) → 403, fail closed, no fallback
   *  3. REVOKED membership (no ACTIVE/SUSPENDED) → 403, fail closed, no fallback
   *  4. No membership row at all, legacy owner role (COMPANY/COMPANY_ADMIN) → legacy Company.userId fallback
   *  5. No membership row at all, any other role (incl. COMPANY_STAFF) → 404, fail closed
   *
   * Querying ACTIVE first is required: a user may have historical REVOKED/SUSPENDED rows
   * for a prior company alongside an ACTIVE row for a current company. Without the status
   * filter, findOne returns a non-deterministic row and may deny valid access.
   *
   * REVOKED users do NOT fall through to the legacy path — revocation must be honoured
   * even for COMPANY/COMPANY_ADMIN owner roles.
   *
   * Never trusts a frontend-supplied companyId. Never falls through a non-active membership.
   */
  async resolveCompanyContext(
    userId: number,
    userRole: UserRole,
    requiredPermission?: CompanyPermission,
  ): Promise<CompanyContext> {
    // Step 1: ACTIVE-first query — deterministic when historical rows exist for other companies
    const activeMembership = await this.membershipRepo.findOne({
      where: { userId, status: CompanyMembershipStatus.ACTIVE },
      relations: ['company'],
    });

    if (activeMembership) {
      if (requiredPermission && !hasPermission(activeMembership.membershipRole, requiredPermission)) {
        throw new ForbiddenException('Insufficient permissions.');
      }
      return { company: activeMembership.company, membershipRole: activeMembership.membershipRole };
    }

    // Step 2: SUSPENDED — fail closed, no fallback regardless of role
    const suspendedMembership = await this.membershipRepo.findOne({
      where: { userId, status: CompanyMembershipStatus.SUSPENDED },
    });
    if (suspendedMembership) {
      throw new ForbiddenException('Your company access has been suspended.');
    }

    // Step 3: REVOKED — fail closed, no fallback even for legacy owner roles
    const revokedMembership = await this.membershipRepo.findOne({
      where: { userId, status: CompanyMembershipStatus.REVOKED },
    });
    if (revokedMembership) {
      throw new ForbiddenException('Your company access has been revoked.');
    }

    // Step 4: No membership row — legacy fallback only for pre-P1I company owners
    const isLegacyOwnerRole =
      userRole === UserRole.COMPANY || userRole === UserRole.COMPANY_ADMIN;
    if (!isLegacyOwnerRole) {
      throw new NotFoundException('Company not found.');
    }

    const company = await this.companyService.findByUserId(userId);
    if (!company) {
      throw new NotFoundException('Company not found.');
    }

    // Defence-in-depth: verify ownership explicitly even though WHERE userId = userId guarantees it
    if (company.user?.id !== userId) {
      throw new ForbiddenException('Company ownership mismatch.');
    }

    if (requiredPermission && !hasPermission(CompanyMembershipRole.OWNER, requiredPermission)) {
      throw new ForbiddenException('Insufficient permissions.');
    }

    return { company, membershipRole: CompanyMembershipRole.OWNER };
  }

  /**
   * Pre-condition check for invitation acceptance (Phase 2 acceptance endpoint must call this).
   *
   * Policy (P1I v1):
   *  - ACTIVE membership → reject: user is already bound to a company
   *  - SUSPENDED membership → reject: user is temporarily disabled but still bound to their company
   *  - REVOKED membership → allow: user has been released from their prior company
   *  - No membership → allow: fresh user, no prior binding
   *
   * SUSPENDED binds a user to their old company. They cannot silently become active at a new
   * company while still retained (even in suspended state) by their previous employer.
   * Only REVOKED fully releases the user to accept a new company invitation.
   */
  async canAcceptInvitation(userId: number): Promise<{ allowed: boolean; reason?: string }> {
    const activeMembership = await this.membershipRepo.findOne({
      where: { userId, status: CompanyMembershipStatus.ACTIVE },
    });
    if (activeMembership) {
      return { allowed: false, reason: 'User already has an active company membership.' };
    }

    const suspendedMembership = await this.membershipRepo.findOne({
      where: { userId, status: CompanyMembershipStatus.SUSPENDED },
    });
    if (suspendedMembership) {
      return {
        allowed: false,
        reason: 'User has a suspended company membership and cannot join another company.',
      };
    }

    return { allowed: true };
  }
}
