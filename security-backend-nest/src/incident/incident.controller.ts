import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { IncidentService } from './incident.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CreateIncidentDto } from './dto/create-incident.dto';
import { UpdateIncidentStatusDto } from './dto/update-incident-status.dto';

@Controller('incidents')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IncidentController {
  constructor(private readonly incidentService: IncidentService) {}

  @Get('mine')
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  findMine(@CurrentUser() user: JwtPayload) {
    return this.incidentService.findMine(user.sub);
  }

  @Get('company')
  @Roles(UserRole.COMPANY, UserRole.ADMIN)
  findForCompany(@CurrentUser() user: JwtPayload) {
    return this.incidentService.findForCompany(user.sub);
  }

  @Post()
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateIncidentDto) {
    return this.incidentService.createForGuard(user.sub, dto);
  }

  @Patch(':id/status')
  @Roles(UserRole.COMPANY, UserRole.ADMIN)
  updateStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateIncidentStatusDto,
  ) {
    return this.incidentService.updateStatusForCompany(user.sub, id, dto.status);
  }
}
