import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { UserService } from '../user/user.service';
import { PublicRegistrationRole, RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { isCompanyRole, UserRole, UserStatus } from '../user/entities/user.entity';
import { CompanyService } from '../company/company.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { CompanyStatus } from '../company/entities/company.entity';
import { GuardApprovalStatus } from '../guard-profile/entities/guard-profile.entity';
import { ClientPortalUserService } from '../client-portal-user/client-portal-user.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { DataSource, QueryFailedError } from 'typeorm';
import { CompanyMembership } from '../company-membership/entities/company-membership.entity';
import {
  CompanyMembershipRole,
  CompanyMembershipStatus,
  CompanyPermission,
  ROLE_PERMISSIONS,
} from '../company-membership/company-membership-types';

const DUPLICATE_SIA_MESSAGE = 'SIA licence number is already registered.';

function uniqueViolation(error: unknown) {
  if (!(error instanceof QueryFailedError)) return null;
  const driver = (error as QueryFailedError & { driverError?: { code?: string; constraint?: string; detail?: string } }).driverError;
  return driver?.code === '23505' ? driver : null;
}

export function isSiaUniqueViolation(error: unknown): boolean {
  const violation = uniqueViolation(error);
  if (!violation) return false;
  return (
    violation.constraint === 'UQ_ccb60d0042497e83f11cadf004d' ||
    violation.constraint === 'guard_profiles_siaLicenseNumber_key' ||
    /\(siaLicenseNumber\)=/i.test(violation.detail || '')
  );
}

function isEmailUniqueViolation(error: unknown): boolean {
  const violation = uniqueViolation(error);
  if (!violation) return false;
  return violation.constraint === 'users_email_key' || /\(email\)=/i.test(violation.detail || '');
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UserService,
    private readonly jwtService: JwtService,
    private readonly companyService: CompanyService,
    private readonly guardProfileService: GuardProfileService,
    private readonly clientPortalUserService: ClientPortalUserService,
    private readonly auditLogService: AuditLogService,
    private readonly dataSource: DataSource,
    @InjectRepository(CompanyMembership)
    private readonly membershipRepo: Repository<CompanyMembership>,
  ) {}

  async register(dto: RegisterDto) {
    const normalizedRole = this.normalizePublicRegistrationRole(dto.role);

    // Validate the complete self-service payload before creating any persistent records.
    if (isCompanyRole(normalizedRole)) {
      if (!dto.companyName || !dto.companyNumber || !dto.address || !dto.contactDetails) {
        throw new BadRequestException('Company fields are required for company role');
      }
    } else if (normalizedRole === UserRole.GUARD) {
      if (!dto.fullName || !dto.siaLicenseNumber || !dto.phone) {
        throw new BadRequestException('Guard fields are required for guard role');
      }
    }

    const normalizedSiaLicenseNumber =
      normalizedRole === UserRole.GUARD ? dto.siaLicenseNumber!.trim() : null;
    if (normalizedSiaLicenseNumber && !/^\d{16}$/.test(normalizedSiaLicenseNumber)) {
      throw new BadRequestException('SIA licence number must be exactly 16 numeric digits.');
    }

    // Account access is independent from profile/compliance vetting. Operational
    // eligibility remains enforced by ComplianceService at hire/assignment/shift.
    const userStatus = UserStatus.ACTIVE;
    let user: Awaited<ReturnType<UserService['create']>>;
    try {
      user = await this.dataSource.transaction(async (manager) => {
        if (
          normalizedSiaLicenseNumber &&
          await this.guardProfileService.findBySiaLicenseNumber(normalizedSiaLicenseNumber, manager)
        ) {
          throw new ConflictException(DUPLICATE_SIA_MESSAGE);
        }

        const createdUser = await this.usersService.create({
          email: dto.email,
          password: dto.password,
          role: normalizedRole,
          status: userStatus,
        }, manager);

        if (isCompanyRole(normalizedRole)) {
          await this.companyService.create({
            userId: createdUser.id,
            name: dto.companyName!,
            companyNumber: dto.companyNumber!,
            address: dto.address!,
            contactDetails: dto.contactDetails!,
            status: CompanyStatus.ONBOARDING,
          }, manager);
        }

        if (normalizedRole === UserRole.GUARD) {
          await this.guardProfileService.create({
            userId: createdUser.id,
            fullName: dto.fullName!.trim(),
            siaLicenseNumber: normalizedSiaLicenseNumber!,
            phone: dto.phone!.trim(),
            locationSharingEnabled: false,
            status: GuardApprovalStatus.PENDING,
            approvalStatus: GuardApprovalStatus.PENDING,
            isApproved: false,
          }, manager);
        }

        return createdUser;
      });
    } catch (error) {
      if (isSiaUniqueViolation(error)) throw new ConflictException(DUPLICATE_SIA_MESSAGE);
      if (isEmailUniqueViolation(error)) throw new ConflictException('Email already exists');
      throw error;
    }

    return this.signToken(user.id, user.email, user.role, user.status);
  }

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException(`Account status ${user.status} is not allowed to log in`);
    }

    await this.usersService.updateLastLogin(user.id);
    return this.signToken(user.id, user.email, user.role, user.status);
  }

  async clientLogin(dto: LoginDto) {
    const clientUser = await this.clientPortalUserService.findByEmail(dto.email);
    if (!clientUser) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, clientUser.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');
    if (!clientUser.isActive) {
      throw new ForbiddenException('Client portal access is disabled for this account');
    }

    await this.clientPortalUserService.updateLastLogin(clientUser.id);
    await this.auditLogService.log({
      company: { id: clientUser.client.company.id },
      user: null,
      action: 'client_portal_user.login',
      entityType: 'client_portal_user',
      entityId: clientUser.id,
      afterData: {
        clientId: clientUser.client.id,
        email: clientUser.email,
        role: clientUser.role,
      },
    });

    return this.signClientToken(clientUser.id, clientUser.email, clientUser.role, clientUser.client.id);
  }

  /**
   * Compute the effective Company permissions for a user, using the live
   * company_memberships row. Called at login time and by /auth/me so the
   * client always receives up-to-date permissions.
   *
   * Resolution mirrors CompanyMembershipService.resolveCompanyContext:
   *  - ACTIVE membership found → use its membershipRole's permission set
   *  - No membership row, legacy COMPANY/COMPANY_ADMIN role → OWNER permissions
   *  - All other cases → empty (no company permissions)
   *
   * Never throws — returns [] on any unexpected error (fail-safe for auth flow).
   */
  async computeCompanyPermissions(userId: number, userRole: UserRole): Promise<string[]> {
    if (!isCompanyRole(userRole)) return [];

    try {
      const membership = await this.membershipRepo.findOne({
        where: { userId, status: CompanyMembershipStatus.ACTIVE },
      });

      if (membership) {
        return Array.from(ROLE_PERMISSIONS[membership.membershipRole] ?? []) as string[];
      }

      // Legacy fallback: pre-P1I owner accounts with no membership row
      if (userRole === UserRole.COMPANY || userRole === UserRole.COMPANY_ADMIN) {
        return Array.from(ROLE_PERMISSIONS[CompanyMembershipRole.OWNER]) as string[];
      }
    } catch {
      // Fail-safe: never break authentication due to a permissions lookup error
    }

    return [];
  }

  /**
   * Build the user-facing session object for the authenticated user.
   * Used by /auth/me to return a fresh session user without re-issuing a JWT.
   */
  async getCurrentUser(userId: number, userRole: UserRole) {
    const companyProfile = isCompanyRole(userRole)
      ? await this.companyService.findByUserId(userId)
      : null;
    const guardProfile = userRole === UserRole.GUARD
      ? await this.guardProfileService.findByUserId(userId)
      : null;
    const companyPermissions = await this.computeCompanyPermissions(userId, userRole);

    return {
      id: userId,
      email: (await this.usersService.findById(userId))?.email ?? '',
      role: userRole,
      companyId: companyProfile?.id,
      guardId: guardProfile?.id,
      ...(companyPermissions.length > 0 ? { companyPermissions } : {}),
    };
  }

  private normalizePublicRegistrationRole(role: PublicRegistrationRole): UserRole {
    switch (role) {
      case PublicRegistrationRole.COMPANY:
      case PublicRegistrationRole.COMPANY_ADMIN:
        return UserRole.COMPANY_ADMIN;
      case PublicRegistrationRole.GUARD:
        return UserRole.GUARD;
      default:
        throw new BadRequestException('Role is not available for public registration');
    }
  }

  private async signToken(userId: number, email: string, role: UserRole, status: UserStatus) {
    const companyProfile =
      isCompanyRole(role) ? await this.companyService.findByUserId(userId) : null;
    const guardProfile =
      role === UserRole.GUARD ? await this.guardProfileService.findByUserId(userId) : null;
    const companyPermissions = await this.computeCompanyPermissions(userId, role);

    const payload = { sub: userId, email, role, status, principalType: 'user' as const };
    return {
      accessToken: this.jwtService.sign(payload),
      user: {
        id: userId,
        email,
        role,
        status,
        companyId: companyProfile?.id,
        guardId: guardProfile?.id,
        ...(companyPermissions.length > 0 ? { companyPermissions } : {}),
      }
    };
  }

  private signClientToken(
    clientPortalUserId: number,
    email: string,
    role: UserRole.CLIENT_ADMIN | UserRole.CLIENT_VIEWER,
    clientId: number,
  ) {
    const payload = {
      sub: clientPortalUserId,
      email,
      role,
      status: 'active' as const,
      principalType: 'client_portal' as const,
      clientId,
    };
    return {
      accessToken: this.jwtService.sign(payload),
      user: {
        id: clientPortalUserId,
        email,
        role,
        status: 'active',
        clientId,
      },
    };
  }
}
