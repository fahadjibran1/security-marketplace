import { Body, Controller, Get, Headers, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthThrottlerGuard } from './auth-throttler.guard';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { MOBILE_CLIENT_HEADER } from './auth.constants';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from './types/jwt-payload.type';
import { UserRole } from '../user/entities/user.entity';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  /**
   * Exchange a renewable session for a fresh access token. Deliberately unauthenticated — the
   * caller's access token has usually just expired, which is the whole reason they are here.
   * The refresh token itself is the credential. Throttled because it is an unauthenticated
   * endpoint that performs a database lookup.
   */
  @Post('refresh')
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  refresh(@Body() dto: RefreshDto) {
    // An absent token falls through to the same generic 401 as an invalid one.
    return this.authService.refresh(dto.refreshToken ?? '');
  }

  /**
   * Revoke the presented session. Authenticated so a captured refresh token cannot be used to
   * log somebody else out, and idempotent so a client that retries never sees an error.
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  logout(@CurrentUser() user: JwtPayload, @Body() dto: RefreshDto) {
    return this.authService.logout(user.sub, dto.refreshToken);
  }

  @Post('client-login')
  @UseGuards(AuthThrottlerGuard)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  clientLogin(@Body() dto: LoginDto) {
    return this.authService.clientLogin(dto);
  }

  /**
   * Returns the current user's profile with fresh effective company permissions.
   * Call on app bootstrap after session restore to avoid stale cached permissions.
   * Accessible to all authenticated principals (company, guard, admin, client).
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMe(@CurrentUser() user: JwtPayload) {
    return this.authService.getCurrentUser(user.sub, user.role as UserRole);
  }
}
