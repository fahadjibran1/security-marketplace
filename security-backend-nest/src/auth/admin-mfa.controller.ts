import { Body, Controller, Get, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { resolveClientIp } from '../common/http/client-ip';
import { UserRole } from '../user/entities/user.entity';
import { AdminMfaChallengeGuard, AdminMfaEnrolmentGuard } from './admin-mfa.guards';
import { AdminMfaService } from './admin-mfa.service';
import { AuthThrottlerGuard, LOGIN_REQUESTS_PER_MINUTE } from './auth-throttler.guard';
import { MOBILE_CLIENT_HEADER } from './auth.constants';
import { AuthService } from './auth.service';
import { MfaCodeDto, MfaVerifyDto } from './dto/admin-mfa.dto';
import { JwtPayload } from './types/jwt-payload.type';

/**
 * Platform Admin two-step verification (authenticator app). Every route is Platform Admin only.
 *
 *   POST /auth/mfa/verify          second step of sign-in: { challengeToken, code } → the normal sign-in response
 *   GET  /auth/mfa/status          enrolled / pending / required
 *   POST /auth/mfa/totp/enrol      start enrolment: the secret and otpauth:// URI, shown once
 *   POST /auth/mfa/totp/confirm    { code } activates it → a fresh two-step session (the normal sign-in response)
 *   POST /auth/mfa/totp/disable    { code } turns it off (refused while PLATFORM_ADMIN_MFA_REQUIRED is on)
 *
 * status / enrol / confirm also accept the enrolment token a password sign-in returns while the rollout flag is on
 * and the admin has not enrolled. Wrong codes are limited by LoginAttemptLimiter ('mfa' scope) and audited.
 */
@Controller('auth/mfa')
@Roles(UserRole.ADMIN)
export class AdminMfaController {
  constructor(
    private readonly mfa: AdminMfaService,
    private readonly authService: AuthService,
  ) {}

  @Post('verify')
  @UseGuards(AuthThrottlerGuard, AdminMfaChallengeGuard, RolesGuard)
  @Throttle({ default: { limit: LOGIN_REQUESTS_PER_MINUTE, ttl: 60_000 } })
  async verify(
    @CurrentUser() user: JwtPayload,
    @Body() dto: MfaVerifyDto,
    @Req() req: unknown,
    @Headers(MOBILE_CLIENT_HEADER) client?: string,
  ) {
    await this.mfa.verifyLoginCode(user.sub, dto.code, resolveClientIp(req as never));
    return this.authService.completeAdminMfaSignIn(user.sub, client === 'mobile');
  }

  @Get('status')
  @UseGuards(AdminMfaEnrolmentGuard, RolesGuard)
  status(@CurrentUser() user: JwtPayload) {
    return this.mfa.status(user.sub);
  }

  @Post('totp/enrol')
  @HttpCode(200)
  @UseGuards(AuthThrottlerGuard, AdminMfaEnrolmentGuard, RolesGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  enrol(@CurrentUser() user: JwtPayload, @Req() req: unknown) {
    return this.mfa.startEnrolment(user.sub, resolveClientIp(req as never));
  }

  @Post('totp/confirm')
  @UseGuards(AuthThrottlerGuard, AdminMfaEnrolmentGuard, RolesGuard)
  @Throttle({ default: { limit: LOGIN_REQUESTS_PER_MINUTE, ttl: 60_000 } })
  async confirm(
    @CurrentUser() user: JwtPayload,
    @Body() dto: MfaCodeDto,
    @Req() req: unknown,
    @Headers(MOBILE_CLIENT_HEADER) client?: string,
  ) {
    await this.mfa.confirmEnrolment(user.sub, dto.code, resolveClientIp(req as never));
    return this.authService.completeAdminMfaSignIn(user.sub, client === 'mobile');
  }

  @Post('totp/disable')
  @HttpCode(200)
  @UseGuards(AuthThrottlerGuard, JwtAuthGuard, RolesGuard)
  @Throttle({ default: { limit: LOGIN_REQUESTS_PER_MINUTE, ttl: 60_000 } })
  async disable(@CurrentUser() user: JwtPayload, @Body() dto: MfaCodeDto, @Req() req: unknown) {
    await this.mfa.disable(user.sub, dto.code, resolveClientIp(req as never));
    return { enrolled: false };
  }
}
