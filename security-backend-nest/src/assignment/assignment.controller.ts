import { Controller, Get, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { AssignmentService } from './assignment.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';

@Controller('assignments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AssignmentController {
  constructor(private readonly assignmentService: AssignmentService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findAll() {
    return this.assignmentService.findAll();
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.assignmentService.findOne(id);
  }
}
