import { Controller, Get, UseGuards } from '@nestjs/common';
import { JobSlotService } from './job-slot.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';

@Controller('job-slots')
@UseGuards(JwtAuthGuard, RolesGuard)
export class JobSlotController {
  constructor(private readonly slotService: JobSlotService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COMPANY)
  findAll() {
    return this.slotService.findAll();
  }
}
