import { Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { NotificationService } from './notification.service';
import { UserRole } from '../user/entities/user.entity';

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get('mine')
  findMine(@Req() req: { user: { sub: number } }) {
    return this.notificationService.findMine(req.user.sub);
  }

  @Get('company')
  findForCompany(@Req() req: { user: { sub: number; role: UserRole } }) {
    if (req.user.role === UserRole.ADMIN) {
      return this.notificationService.findMine(req.user.sub);
    }

    return this.notificationService.findForCompany(req.user.sub);
  }

  @Patch(':id/read')
  markRead(
    @Req() req: { user: { sub: number } },
    @Param('id') id: string,
  ) {
    return this.notificationService.markRead(req.user.sub, Number(id));
  }
}
