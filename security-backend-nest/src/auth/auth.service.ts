import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UserService } from '../user/user.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { isCompanyRole, UserRole, UserStatus } from '../user/entities/user.entity';
import { CompanyService } from '../company/company.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { CompanyStatus } from '../company/entities/company.entity';
import { GuardApprovalStatus } from '../guard-profile/entities/guard-profile.entity';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UserService,
    private readonly jwtService: JwtService,
    private readonly companyService: CompanyService,
    private readonly guardProfileService: GuardProfileService
  ) {}

  async register(dto: RegisterDto) {
    const normalizedRole = dto.role === UserRole.COMPANY ? UserRole.COMPANY_ADMIN : dto.role;
    const user = await this.usersService.create({
      email: dto.email,
      password: dto.password,
      role: normalizedRole,
      status: normalizedRole === UserRole.GUARD ? UserStatus.PENDING : UserStatus.ACTIVE,
    });

    if (isCompanyRole(normalizedRole)) {
      if (!dto.companyName || !dto.companyNumber || !dto.address || !dto.contactDetails) {
        throw new BadRequestException('Company fields are required for company role');
      }

      await this.companyService.create({
        userId: user.id,
        name: dto.companyName,
        companyNumber: dto.companyNumber,
        address: dto.address,
        contactDetails: dto.contactDetails,
        status: CompanyStatus.ONBOARDING,
      });
    }

    if (normalizedRole === UserRole.GUARD) {
      if (!dto.fullName || !dto.siaLicenseNumber || !dto.phone) {
        throw new BadRequestException('Guard fields are required for guard role');
      }

      await this.guardProfileService.create({
        userId: user.id,
        fullName: dto.fullName,
        siaLicenseNumber: dto.siaLicenseNumber,
        phone: dto.phone,
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

    await this.usersService.updateLastLogin(user.id);
    return this.signToken(user.id, user.email, user.role, UserStatus.ACTIVE);
  }

  private async signToken(userId: number, email: string, role: UserRole, status: UserStatus) {
    const companyProfile =
      isCompanyRole(role) ? await this.companyService.findByUserId(userId) : null;
    const guardProfile =
      role === UserRole.GUARD ? await this.guardProfileService.findByUserId(userId) : null;

    const payload = { sub: userId, email, role, status };
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
}
