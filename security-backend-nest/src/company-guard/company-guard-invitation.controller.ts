import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { CompanyGuardInvitationService } from './company-guard-invitation.service';
import { CreateCompanyGuardInvitationDto } from './dto/create-company-guard-invitation.dto';
import { RedeemCompanyGuardInvitationDto } from './dto/redeem-company-guard-invitation.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthThrottlerGuard } from '../auth/auth-throttler.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { JwtPayload } from '../auth/types/jwt-payload.type';

const requestMeta = (req: Request) => ({
  ipAddress: (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip ?? null,
  userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
});

/**
 * Company side of workforce invitations.
 *
 * COMPANY_VIEW_ROLES opens these routes to company staff; the membership matrix in the service
 * decides who may actually act — guards.manage to issue or revoke, guards.view to list.
 */
@Controller('company-guards/invitations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CompanyGuardInvitationController {
  constructor(private readonly invitations: CompanyGuardInvitationService) {}

  /** Returns the plaintext code exactly once. It is not stored and cannot be retrieved again. */
  @Post()
  @Roles(...COMPANY_VIEW_ROLES)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateCompanyGuardInvitationDto) {
    return this.invitations.createForCompanyUser(user, dto);
  }

  @Get()
  @Roles(...COMPANY_VIEW_ROLES)
  list(@CurrentUser() user: JwtPayload) {
    return this.invitations.listForCompanyUser(user);
  }

  @Post(':id/revoke')
  @Roles(...COMPANY_VIEW_ROLES)
  revoke(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.invitations.revokeForCompanyUser(user, id);
  }
}

/**
 * Guard side. Lives here rather than on GuardProfileController because the service belongs to the
 * company-guard module, and injecting it into the guard-profile module would close a cycle
 * (CompanyGuardModule already imports GuardProfileModule). The URL still reads as the guard's own.
 *
 * All three routes are authenticated as a GUARD and IP-throttled through the same proxy-aware guard
 * the auth routes use, because a code is a bearer secret and these are its only redemption points.
 */
@Controller('guards/me/invitations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class GuardWorkforceInvitationController {
  constructor(private readonly invitations: CompanyGuardInvitationService) {}

  @Post('preview')
  @Roles(UserRole.GUARD)
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  preview(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RedeemCompanyGuardInvitationDto,
    @Req() req: Request,
  ) {
    return this.invitations.previewForGuardUser(user, dto, requestMeta(req));
  }

  @Post('accept')
  @Roles(UserRole.GUARD)
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  accept(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RedeemCompanyGuardInvitationDto,
    @Req() req: Request,
  ) {
    return this.invitations.acceptForGuardUser(user, dto, requestMeta(req));
  }

  @Post('decline')
  @Roles(UserRole.GUARD)
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  decline(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RedeemCompanyGuardInvitationDto,
    @Req() req: Request,
  ) {
    return this.invitations.declineForGuardUser(user, dto, requestMeta(req));
  }
}
