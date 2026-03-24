import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { JobService } from './job.service';
import { CreateJobDto } from './dto/create-job.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';

@Controller('jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class JobController {
  constructor(private readonly jobService: JobService) {}

  @Get()
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES, UserRole.GUARD)
  findAll() {
    return this.jobService.findAll();
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES, UserRole.GUARD)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.jobService.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES)
  create(@Body() dto: CreateJobDto) {
    return this.jobService.create(dto);
  }
}
