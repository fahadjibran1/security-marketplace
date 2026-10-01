import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { IncidentService } from './incident.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CreateIncidentDto } from './dto/create-incident.dto';
import { UpdateIncidentStatusDto } from './dto/update-incident-status.dto';
import { INCIDENT_RESOLUTION_REASONS } from '../safety-alert/resolution-reasons';

@Controller('incidents')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IncidentController {
  constructor(private readonly incidentService: IncidentService) {}

  @Get('mine')
  @Roles(UserRole.GUARD)
  findMine(@CurrentUser() user: JwtPayload) {
    return this.incidentService.findMine(user.sub);
  }

  @Get('company')
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES)
  findForCompany(@CurrentUser() user: JwtPayload) {
    if (user.role === UserRole.ADMIN) {
      return this.incidentService.findAll();
    }
    return this.incidentService.findForCompany(user.sub, user.role);
  }

  @Post()
  @Roles(UserRole.GUARD)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateIncidentDto) {
    return this.incidentService.createForGuard(user.sub, dto);
  }

  @Patch(':id/status')
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES)
  updateStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateIncidentStatusDto,
  ) {
    // `notes` is the deprecated alias for `resolutionNote` and loses to it when both are sent. See
    // the DTO: it was accepted and discarded before, so honouring it here fixes a silent data loss
    // without changing what the field ever appeared to mean.
    const resolution = {
      resolutionReason: dto.resolutionReason,
      resolutionNote: dto.resolutionNote ?? dto.notes,
    };
    const hasResolution = Boolean(resolution.resolutionReason || resolution.resolutionNote);

    if (user.role === UserRole.ADMIN) {
      return this.incidentService.updateStatusAsAdmin(
        user.sub, id, dto.status, hasResolution ? resolution : undefined,
      );
    }
    return this.incidentService.updateStatusForCompany(
      user.sub, user.role, id, dto.status, hasResolution ? resolution : undefined,
    );
  }

  /** The reasons an incident may be resolved with, so the UI offers nothing the API will refuse. */
  @Get('resolution-reasons')
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES)
  resolutionReasons() {
    return {
      reasons: INCIDENT_RESOLUTION_REASONS.map((value) => ({ value, noteRequired: true })),
    };
  }
}
