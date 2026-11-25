import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { CompanyStaffService } from './company-staff.service';
import {
  AcceptCompanyStaffInvitationDto,
  ChangeCompanyStaffRoleDto,
  InviteCompanyStaffDto,
} from './dto/company-staff.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { AuthThrottlerGuard } from '../auth/auth-throttler.guard';
import { resolveClientIp } from '../common/http/client-ip';
import { CompanyCapability, CompanyCapabilityRequired } from '../company/company-capability';

const requestMeta = (req: Request) => ({
  ipAddress: resolveClientIp(req),
  userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
});

/**
 * Company staff management (Team). COMPANY_VIEW_ROLES opens the routes to company users; the service decides who may
 * act: the Owner and members holding staff.manage, never beyond their own authority (company-staff-policy.ts).
 *
 * Capabilities (SEC-PUBLIC-03): inviting someone new is new_operations (approved companies only). Changing a role is
 * internal set-up. Cancelling an invitation and revoking a member's access only ever REMOVE access, so they are
 * account-level and never withheld — a suspended company must still be able to shut a person out.
 */
@Controller('company-staff')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CompanyStaffController {
  constructor(private readonly staff: CompanyStaffService) {}

  @Get()
  @Roles(...COMPANY_VIEW_ROLES)
  list(@CurrentUser() user: JwtPayload) {
    return this.staff.list(user);
  }

  @Post('invitations')
  @Roles(...COMPANY_VIEW_ROLES)
  @CompanyCapabilityRequired(CompanyCapability.NEW_OPERATIONS)
  invite(@CurrentUser() user: JwtPayload, @Body() dto: InviteCompanyStaffDto, @Req() req: Request) {
    return this.staff.invite(user, dto, requestMeta(req));
  }

  @Post('invitations/:id/cancel')
  @HttpCode(200)
  @Roles(...COMPANY_VIEW_ROLES)
  @CompanyCapabilityRequired(CompanyCapability.ACCOUNT)
  cancel(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.staff.cancelInvitation(user, id, requestMeta(req));
  }

  @Patch('members/:userId/role')
  @Roles(...COMPANY_VIEW_ROLES)
  @CompanyCapabilityRequired(CompanyCapability.SETUP)
  changeRole(
    @CurrentUser() user: JwtPayload,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: ChangeCompanyStaffRoleDto,
    @Req() req: Request,
  ) {
    return this.staff.changeRole(user, userId, dto.role, requestMeta(req));
  }

  @Post('members/:userId/revoke')
  @HttpCode(200)
  @Roles(...COMPANY_VIEW_ROLES)
  @CompanyCapabilityRequired(CompanyCapability.ACCOUNT)
  revoke(@CurrentUser() user: JwtPayload, @Param('userId', ParseIntPipe) userId: number, @Req() req: Request) {
    return this.staff.revokeAccess(user, userId, requestMeta(req));
  }
}

/**
 * The emailed link's only redemption point. Public (the invited person has no account yet), and IP-throttled through
 * the same proxy-aware guard the auth routes use, because the token is a bearer secret.
 */
@Controller('company-staff-invitations')
export class CompanyStaffInvitationAcceptController {
  constructor(private readonly staff: CompanyStaffService) {}

  @Post('accept')
  @HttpCode(200)
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @CompanyCapabilityRequired(CompanyCapability.ACCOUNT)
  accept(@Body() dto: AcceptCompanyStaffInvitationDto, @Req() req: Request) {
    return this.staff.accept(dto, requestMeta(req));
  }
}
