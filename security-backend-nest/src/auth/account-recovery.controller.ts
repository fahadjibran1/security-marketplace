import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthThrottlerGuard } from './auth-throttler.guard';
import { AccountRecoveryService } from './account-recovery.service';
import {
  ForgotPasswordDto,
  ResendVerificationDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto/account-recovery.dto';

/**
 * Unauthenticated account recovery: the caller has no session, which is the reason they are here.
 * Every endpoint is throttled per client address; issuing endpoints are additionally limited per
 * account inside the service, silently, so the limit cannot be used to probe for accounts.
 */
@Controller('auth')
@UseGuards(AuthThrottlerGuard)
export class AccountRecoveryController {
  constructor(private readonly recovery: AccountRecoveryService) {}

  @Post('forgot-password')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.recovery.forgotPassword(dto.email);
  }

  @Post('reset-password')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.recovery.resetPassword(dto.token, dto.newPassword);
  }

  @Post('verify-email')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.recovery.verifyEmail(dto.token);
  }

  @Post('resend-verification')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.recovery.resendVerification(dto.email);
  }
}
