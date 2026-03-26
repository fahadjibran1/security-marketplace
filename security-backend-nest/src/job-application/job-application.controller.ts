import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { JobApplicationService } from './job-application.service';
import { CreateJobApplicationDto } from './dto/create-job-application.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { HireApplicationDto } from './dto/hire-application.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';

@Controller('job-applications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class JobApplicationController {
  constructor(private readonly jobApplicationService: JobApplicationService) {}

  @Get()
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES, UserRole.GUARD)
  findAll(@CurrentUser() user: JwtPayload) {
    return this.jobApplicationService.findAllForUser(user);
  }

  @Post()
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateJobApplicationDto) {
    return this.jobApplicationService.createForUser(user, dto);
  }

  @Post(':id/hire')
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES)
  hire(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: HireApplicationDto) {
    return this.jobApplicationService.hireForUser(user, id, dto);
  }
}
