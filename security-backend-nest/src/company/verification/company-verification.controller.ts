import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtPayload } from '../../auth/types/jwt-payload.type';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../../user/entities/user.entity';
import { CompanyMembershipService } from '../../company-membership/company-membership.service';
import { CompanyPermission } from '../../company-membership/company-membership-types';
import { CompanyVerificationStatus } from '../company-verification';
import { CompanyVerificationService } from './company-verification.service';
import { CompanyCapability, CompanyCapabilityRequired } from '../company-capability';

export class SetCompanyVerificationDto {
  @IsEnum(CompanyVerificationStatus)
  status!: CompanyVerificationStatus;

  /** Shown to the company. Required to reject or suspend. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class ListCompanyVerificationQueryDto {
  @IsOptional()
  @IsEnum(CompanyVerificationStatus)
  status?: CompanyVerificationStatus;
}

/**
 * SEC-PUBLIC-03: S4 platform administration of company verification (approve, reject, suspend, reinstate). Platform
 * administrators only (UserRole.ADMIN; created solely by the operator CLI). Company users can never reach these routes.
 */
@Controller('admin/companies')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class CompanyVerificationController {
  constructor(private readonly verification: CompanyVerificationService) {}

  @Get('verification')
  list(@Query() query: ListCompanyVerificationQueryDto) {
    return this.verification.list(query.status);
  }

  @Get(':companyId/verification')
  get(@Param('companyId', ParseIntPipe) companyId: number) {
    return this.verification.get(companyId);
  }

  @Get(':companyId/verification/history')
  history(@Param('companyId', ParseIntPipe) companyId: number) {
    return this.verification.history(companyId);
  }

  @Put(':companyId/verification')
  decide(
    @CurrentUser() user: JwtPayload,
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: SetCompanyVerificationDto,
  ) {
    return this.verification.decide(user, companyId, dto.status, dto.reason);
  }
}

export class RequestReconsiderationDto {
  /** Optional: what the company changed. Recorded in the audit log for the administrator. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}

/**
 * The company's own side of verification: its status and reason, and (when rejected) asking S4 to reconsider. The
 * company is always the caller's own (resolveCompanyContext); reconsideration needs company.manage (owner / admin).
 */
@Controller('companies/me/verification')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...COMPANY_VIEW_ROLES)
export class CompanyVerificationSelfController {
  constructor(
    private readonly verification: CompanyVerificationService,
    private readonly membershipService: CompanyMembershipService,
  ) {}

  @Get()
  async status(@CurrentUser() user: JwtPayload) {
    const { company } = await this.membershipService.resolveCompanyContext(user.sub, user.role);
    return this.verification.ownStatus(company.id);
  }

  @Post('reconsideration')
  @HttpCode(200)
  @Roles(...COMPANY_ADMIN_ROLES)
  @CompanyCapabilityRequired(CompanyCapability.RECONSIDERATION)
  async requestReconsideration(@CurrentUser() user: JwtPayload, @Body() dto: RequestReconsiderationDto) {
    const { company } = await this.membershipService.resolveCompanyContext(user.sub, user.role, CompanyPermission.COMPANY_MANAGE);
    return this.verification.requestReconsideration(user, company.id, dto.message);
  }
}
