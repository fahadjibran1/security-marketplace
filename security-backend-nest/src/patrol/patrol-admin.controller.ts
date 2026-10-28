import { Body, Controller, Get, Param, ParseIntPipe, Put, UseGuards } from '@nestjs/common';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserRole } from '../user/entities/user.entity';
import { SetPatrolsEnabledDto } from './dto/patrol.dto';
import { PatrolAdminService } from './patrol-admin.service';

/** S4 platform administration of the per-company Patrol Management switch (audited). */
@Controller('admin/patrols/companies')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class PatrolAdminController {
  constructor(private readonly admin: PatrolAdminService) {}

  @Get(':companyId')
  get(@CurrentUser() user: JwtPayload, @Param('companyId', ParseIntPipe) companyId: number) {
    return this.admin.get(user, companyId);
  }

  @Put(':companyId')
  set(@CurrentUser() user: JwtPayload, @Param('companyId', ParseIntPipe) companyId: number, @Body() dto: SetPatrolsEnabledDto) {
    return this.admin.setEnabled(user, companyId, dto.patrolsEnabled);
  }
}
