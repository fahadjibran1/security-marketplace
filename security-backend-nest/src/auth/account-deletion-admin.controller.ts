import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { IsEmail, MaxLength } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserRole } from '../user/entities/user.entity';
import { AccountDeletionAdminService } from './account-deletion-admin.service';
import { JwtPayload } from './types/jwt-payload.type';

export class RecordDeletionRequestDto {
  /** The address the emailed request came from, which must be the account's registered email. */
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

/**
 * The Platform Admin account-deletion queue: recorded requests from every account type, recording a request received by
 * email, and completing a request. Platform administrators only (UserRole.ADMIN, created solely by the operator CLI).
 */
@Controller('admin/account-deletion-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AccountDeletionAdminController {
  constructor(private readonly requests: AccountDeletionAdminService) {}

  @Get()
  list(@CurrentUser() admin: JwtPayload) {
    return this.requests.listPending(admin);
  }

  @Post()
  @HttpCode(200)
  record(@CurrentUser() admin: JwtPayload, @Body() dto: RecordDeletionRequestDto) {
    return this.requests.recordRequestByEmail(admin, dto.email);
  }

  @Post('users/:userId/complete')
  @HttpCode(200)
  completeUser(@CurrentUser() admin: JwtPayload, @Param('userId', ParseIntPipe) userId: number) {
    return this.requests.completeUser(admin, userId);
  }

  @Post('client-portal-users/:clientPortalUserId/complete')
  @HttpCode(200)
  completeClientPortalUser(
    @CurrentUser() admin: JwtPayload,
    @Param('clientPortalUserId', ParseIntPipe) clientPortalUserId: number,
  ) {
    return this.requests.completeClientPortalUser(admin, clientPortalUserId);
  }
}
