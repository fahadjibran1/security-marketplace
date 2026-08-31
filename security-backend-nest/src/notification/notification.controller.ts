import { Controller, Get, Param, ParseIntPipe, Patch, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { NotificationService } from './notification.service';
import { COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES, UserRole.GUARD)
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
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.notificationService.markRead(req.user.sub, id);
  }
}
