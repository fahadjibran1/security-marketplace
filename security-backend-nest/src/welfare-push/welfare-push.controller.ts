import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserRole } from '../user/entities/user.entity';
import { RegisterPushDeviceDto, UnregisterPushDeviceDto, WelfareActionDto } from './dto/welfare-push.dto';
import { WelfarePushService } from './welfare-push.service';

/**
 * Guard-only. Every action needs a valid session (the access token in the Authorization header, never in a
 * notification): an expired session gets 401 and the app asks the Guard to sign in before anything is recorded.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.GUARD)
export class WelfarePushController {
  constructor(private readonly welfarePushService: WelfarePushService) {}

  @Post('push-devices')
  @HttpCode(200)
  register(@CurrentUser() user: JwtPayload, @Body() dto: RegisterPushDeviceDto) {
    return this.welfarePushService.registerDevice(user.sub, dto);
  }

  @Post('push-devices/unregister')
  @HttpCode(200)
  unregister(@CurrentUser() user: JwtPayload, @Body() dto: UnregisterPushDeviceDto) {
    return this.welfarePushService.unregisterDevice(user.sub, dto.token);
  }

  /** I'm Safe. Records a Welfare Check only when the server says one is due for this Guard on this shift now. */
  @Post('welfare-checks/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() user: JwtPayload, @Body() dto: WelfareActionDto) {
    return this.welfarePushService.confirmSafe(user.sub, dto);
  }

  /** Need Help. Raises the existing panic alert to the Control Room; never a Welfare Check. */
  @Post('welfare-checks/need-help')
  @HttpCode(200)
  needHelp(@CurrentUser() user: JwtPayload, @Body() dto: WelfareActionDto) {
    return this.welfarePushService.needHelp(user.sub, dto);
  }
}
