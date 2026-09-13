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
   * Resolution order:
   *  1. CompanyMembership found: enforce status strictly — SUSPENDED/REVOKED → 403, no fallback
   *  2. No membership, legacy owner role (COMPANY/COMPANY_ADMIN): fallback to Company.userId
   *  3. No membership, any other role: fail closed (404)
   *
   * Never trusts a frontend-supplied companyId. Never falls through a non-active membership.
   */
  async resolveCompanyContext(
    userId: number,
    userRole: UserRole,
    requiredPermission?: CompanyPermission,
  ): Promise<CompanyContext> {
    const membership = await this.membershipRepo.findOne({
      where: { userId },
      relations: ['company', 'company.user'],
    });

    if (membership) {
      if (membership.status === CompanyMembershipStatus.SUSPENDED) {
        throw new ForbiddenException('Your company access has been suspended.');
      }
      if (membership.status === CompanyMembershipStatus.REVOKED) {
        throw new ForbiddenException('Your company access has been revoked.');
      }
      // ACTIVE
      if (requiredPermission && !hasPermission(membership.membershipRole, requiredPermission)) {
        throw new ForbiddenException('Insufficient permissions.');
      }
      return { company: membership.company, membershipRole: membership.membershipRole };
    }

    // No membership — legacy fallback only for pre-P1I company owner roles
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
}
