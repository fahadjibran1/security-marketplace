import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { JobApplicationService } from './job-application.service';
import { CreateJobApplicationDto } from './dto/create-job-application.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';
import { HireApplicationDto } from './dto/hire-application.dto';

@Controller('job-applications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class JobApplicationController {
  constructor(private readonly jobApplicationService: JobApplicationService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findAll() {
    return this.jobApplicationService.findAll();
  }

  @Post()
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  create(@Body() dto: CreateJobApplicationDto) {
    return this.jobApplicationService.create(dto);
  }

  @Post(':id/hire')
  @Roles(UserRole.COMPANY, UserRole.ADMIN)
  hire(@Param('id', ParseIntPipe) id: number, @Body() dto: HireApplicationDto) {
    return this.jobApplicationService.hire(id, dto);
  }
}
