import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
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

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UserService,
    private readonly jwtService: JwtService,
    private readonly companyService: CompanyService,
    private readonly guardProfileService: GuardProfileService,
    private readonly clientPortalUserService: ClientPortalUserService,
    private readonly auditLogService: AuditLogService,
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

    const userStatus = normalizedRole === UserRole.GUARD ? UserStatus.PENDING : UserStatus.ACTIVE;
    const user = await this.usersService.create({
      email: dto.email,
      password: dto.password,
      role: normalizedRole,
      status: userStatus,
    });

    if (isCompanyRole(normalizedRole)) {
      await this.companyService.create({
        userId: user.id,
        name: dto.companyName!,
        companyNumber: dto.companyNumber!,
        address: dto.address!,
        contactDetails: dto.contactDetails!,
        status: CompanyStatus.ONBOARDING,
      });
    }

    if (normalizedRole === UserRole.GUARD) {
      await this.guardProfileService.create({
        userId: user.id,
        fullName: dto.fullName!,
        siaLicenseNumber: dto.siaLicenseNumber!,
        phone: dto.phone!,
        locationSharingEnabled: false,
        status: GuardApprovalStatus.PENDING,
        approvalStatus: GuardApprovalStatus.PENDING,
        isApproved: false,
      });
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
