import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserRole } from '../user/entities/user.entity';
import {
  AccountDeletionAdminService,
  DELETION_VERIFICATION_METHODS,
  DELETION_VERIFICATION_NOTE_MAX,
  type DeletionVerificationMethod,
} from './account-deletion-admin.service';
import { JwtPayload } from './types/jwt-payload.type';

export class RecordDeletionRequestDto {
  /** The address the emailed request came from, which must be the account's registered email. */
  @IsEmail()
  @MaxLength(320)
  email!: string;

  /** How the administrator checked that the request really came from the account holder. */
  @IsIn(DELETION_VERIFICATION_METHODS)
  verificationMethod!: DeletionVerificationMethod;

  /** A short note on that check (no personal data needed); audited with the request. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(DELETION_VERIFICATION_NOTE_MAX)
  verificationNote!: string;
}

export class CompleteDeletionRequestDto {
  /** Must be true to complete a request an administrator recorded from an email; not needed for in-app requests. */
  @IsOptional()
  @IsBoolean()
  identityConfirmed?: boolean;
}

/**
 * The Platform Admin account-deletion queue: recorded requests from every account type, recording a request received by
 * email (with how it was verified), a read-only pre-completion summary, and completing a request. Platform
 * administrators only (UserRole.ADMIN, created solely by the operator CLI).
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
    return this.requests.recordRequestByEmail(admin, dto.email, dto.verificationMethod, dto.verificationNote);
  }

  /** What completing the request would meet: owned companies' status, shifts and open obligations. Ids and counts only. */
  @Get('users/:userId/preview')
  previewUser(@CurrentUser() admin: JwtPayload, @Param('userId', ParseIntPipe) userId: number) {
    return this.requests.previewUser(admin, userId);
  }

  @Post('users/:userId/complete')
  @HttpCode(200)
  completeUser(
    @CurrentUser() admin: JwtPayload,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: CompleteDeletionRequestDto,
  ) {
    return this.requests.completeUser(admin, userId, dto.identityConfirmed);
  }

  @Post('client-portal-users/:clientPortalUserId/complete')
  @HttpCode(200)
  completeClientPortalUser(
    @CurrentUser() admin: JwtPayload,
    @Param('clientPortalUserId', ParseIntPipe) clientPortalUserId: number,
    @Body() dto: CompleteDeletionRequestDto,
  ) {
    return this.requests.completeClientPortalUser(admin, clientPortalUserId, dto.identityConfirmed);
  }
}
