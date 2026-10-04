import { Body, Controller, ForbiddenException, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AccountDeletionService } from './account-deletion.service';
import { AuthThrottlerGuard } from './auth-throttler.guard';
import { ConfirmAccountDeletionDto } from './dto/account-deletion.dto';
import { JwtPayload } from './types/jwt-payload.type';

/**
 * The signed-in account holder's own account. Only an S4 user account may use these — a client portal
 * login is a different principal with its own table and is not deleted through here.
 */
@Controller('account')
@UseGuards(JwtAuthGuard)
export class AccountController {
  constructor(private readonly deletion: AccountDeletionService) {}

  private userId(user: JwtPayload) {
    if (user.principalType === 'client_portal') {
      throw new ForbiddenException('Client portal accounts are managed by the company that invited you.');
    }
    return user.sub;
  }

  @Get('deletion')
  deletionStatus(@CurrentUser() user: JwtPayload) {
    return this.deletion.status(this.userId(user));
  }

  @Post('deletion/request')
  @HttpCode(200)
  requestDeletion(@CurrentUser() user: JwtPayload) {
    return this.deletion.requestDeletion(this.userId(user));
  }

  /** Throttled: it checks a password, so it must not become a password-guessing endpoint. */
  @Post('deletion/confirm')
  @HttpCode(200)
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  confirmDeletion(@CurrentUser() user: JwtPayload, @Body() dto: ConfirmAccountDeletionDto) {
    return this.deletion.completeDeletion(this.userId(user), dto.password);
  }
}
