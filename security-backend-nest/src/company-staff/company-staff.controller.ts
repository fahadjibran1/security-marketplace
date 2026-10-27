import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { AuthThrottlerGuard } from '../auth/auth-throttler.guard';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { CompanyStaffService } from './company-staff.service';
import {
  AcceptStaffInvitationDto,
  ChangeCompanyStaffRoleDto,
  CompanyStaffAuditQueryDto,
  InviteCompanyStaffDto,
  StaffInvitationTokenDto,
} from './dto/company-staff.dto';

const requestMeta = (req: Request) => ({
  ipAddress: (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip ?? null,
  userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
});

/**
 * Company staff management. COMPANY_VIEW_ROLES lets company accounts reach the routes; the service then requires
 * staff.manage (Owner / Admin) through CompanyMembershipService, which fails closed on a suspended or removed
 * membership. Guards, platform administrators and client portal accounts are refused by the role guard. Every target
 * is looked up inside the caller's own company, so another company's staff member is a 404.
 *
 * Control Room grants are NOT duplicated here: the web uses the existing PUT /shift-amendments/control-room/:userId
 * (canAmendShifts) and PUT /attendance/control-room/:userId (canManageAttendance).
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

  @Get('audit')
  @Roles(...COMPANY_VIEW_ROLES)
  audit(@CurrentUser() user: JwtPayload, @Query() query: CompanyStaffAuditQueryDto) {
    return this.staff.auditHistory(user, query.limit);
  }

  /** The invitation link is emailed to the invitee only. It is never returned here. */
  @Post('invitations')
  @Roles(...COMPANY_VIEW_ROLES)
  invite(@CurrentUser() user: JwtPayload, @Body() dto: InviteCompanyStaffDto) {
    return this.staff.invite(user, dto);
  }

  @Post('invitations/:id/resend')
  @HttpCode(200)
  @Roles(...COMPANY_VIEW_ROLES)
  resend(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.staff.resendInvitation(user, id);
  }

  @Post('invitations/:id/revoke')
  @HttpCode(200)
  @Roles(...COMPANY_VIEW_ROLES)
  revoke(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.staff.revokeInvitation(user, id);
  }

  @Patch('members/:userId/role')
  @Roles(...COMPANY_VIEW_ROLES)
  changeRole(
    @CurrentUser() user: JwtPayload,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: ChangeCompanyStaffRoleDto,
  ) {
    return this.staff.changeRole(user, userId, dto.role);
  }

  @Post('members/:userId/suspend')
  @HttpCode(200)
  @Roles(...COMPANY_VIEW_ROLES)
  suspend(@CurrentUser() user: JwtPayload, @Param('userId', ParseIntPipe) userId: number) {
    return this.staff.suspend(user, userId);
  }

  @Post('members/:userId/reactivate')
  @HttpCode(200)
  @Roles(...COMPANY_VIEW_ROLES)
  reactivate(@CurrentUser() user: JwtPayload, @Param('userId', ParseIntPipe) userId: number) {
    return this.staff.reactivate(user, userId);
  }

  @Post('members/:userId/remove')
  @HttpCode(200)
  @Roles(...COMPANY_VIEW_ROLES)
  remove(@CurrentUser() user: JwtPayload, @Param('userId', ParseIntPipe) userId: number) {
    return this.staff.remove(user, userId);
  }
}

/**
 * The invitee's side, behind the emailed /accept-invitation link. Unauthenticated, like password reset: the link is a
 * bearer secret only that inbox received. IP-throttled through the same proxy-aware guard the auth routes use.
 */
@Controller('auth/staff-invitations')
@UseGuards(AuthThrottlerGuard)
export class StaffInvitationAcceptanceController {
  constructor(private readonly staff: CompanyStaffService) {}

  @Post('preview')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  preview(@Body() dto: StaffInvitationTokenDto) {
    return this.staff.preview(dto.token);
  }

  @Post('accept')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  accept(@Body() dto: AcceptStaffInvitationDto, @Req() req: Request) {
    return this.staff.accept(dto, requestMeta(req));
  }
}
