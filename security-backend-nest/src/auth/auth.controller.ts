import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthThrottlerGuard } from './auth-throttler.guard';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
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
