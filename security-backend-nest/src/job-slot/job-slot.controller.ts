import { Controller, Get, UseGuards } from '@nestjs/common';
import { JobSlotService } from './job-slot.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';

@Controller('job-slots')
@UseGuards(JwtAuthGuard, RolesGuard)
export class JobSlotController {
  constructor(private readonly slotService: JobSlotService) {}

  @Get()
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES)
  findAll(@CurrentUser() user: JwtPayload) {
    return this.slotService.findAllForUser(user);
  }
}
