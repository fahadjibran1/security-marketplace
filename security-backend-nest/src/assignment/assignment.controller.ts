import { Controller, Get, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { AssignmentService } from './assignment.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';

@Controller('assignments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AssignmentController {
  constructor(private readonly assignmentService: AssignmentService) {}

  @Get()
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES, UserRole.GUARD)
  findAll() {
    return this.assignmentService.findAll();
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES, UserRole.GUARD)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.assignmentService.findOne(id);
  }
}
