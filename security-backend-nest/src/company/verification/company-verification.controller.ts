import { Body, Controller, Get, Param, ParseIntPipe, Put, Query, UseGuards } from '@nestjs/common';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtPayload } from '../../auth/types/jwt-payload.type';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../../user/entities/user.entity';
import { CompanyVerificationStatus } from '../company-verification';
import { CompanyVerificationService } from './company-verification.service';

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

  @Put(':companyId/verification')
  decide(
    @CurrentUser() user: JwtPayload,
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: SetCompanyVerificationDto,
  ) {
    return this.verification.decide(user, companyId, dto.status, dto.reason);
  }
}
