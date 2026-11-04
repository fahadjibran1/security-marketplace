import { Controller, Get, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { PatrolOperationsService } from './patrol-operations.service';

/**
 * S3 Control Room patrol operations (owner-approved S3 Stage 2): read-only company reads under new paths only — no existing
 * route, payload or Guard API changes. Company accounts only (role guard); the company, the Patrols switch (404 while off),
 * patrols.view and, for photo metadata, patrols.evidence are checked in PatrolAccessService.
 */
@Controller('patrols')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...COMPANY_VIEW_ROLES)
export class PatrolOperationsController {
  constructor(private readonly operations: PatrolOperationsService) {}

  @Get('operations/attention')
  attention(@CurrentUser() user: JwtPayload) {
    return this.operations.attention(user);
  }

  @Get('exceptions/:id/investigation')
  investigation(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.operations.investigation(user, id);
  }
}
