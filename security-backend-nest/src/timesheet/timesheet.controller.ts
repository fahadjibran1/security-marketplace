import { Body, Controller, Get, Param, ParseIntPipe, Patch, UseGuards } from '@nestjs/common';
import { TimesheetService } from './timesheet.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { UpdateTimesheetDto } from './dto/update-timesheet.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';

@Controller('timesheets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TimesheetController {
  constructor(private readonly timesheetService: TimesheetService) {}

  @Get()
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES, UserRole.GUARD)
  findAll(@CurrentUser() user: JwtPayload) {
    return this.timesheetService.findAllForUser(user);
  }

  @Get('company')
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES)
  findForCompany(@CurrentUser() user: JwtPayload) {
    return this.timesheetService.findForCompany(user.sub);
  }

  @Get('mine')
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  findMine(@CurrentUser() user: JwtPayload) {
    return this.timesheetService.findMine(user.sub);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES, UserRole.GUARD)
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTimesheetDto,
  ) {
    if (user.role === UserRole.ADMIN) {
      return this.timesheetService.update(id, dto);
    }

    if (user.role === UserRole.GUARD) {
      return this.timesheetService.updateMine(user.sub, id, dto);
    }

    return this.timesheetService.updateForCompany(user.sub, id, dto);
  }

  @Patch(':id/submit')
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  submitMine(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTimesheetDto,
  ) {
    if (user.role === UserRole.ADMIN) {
      return this.timesheetService.update(id, {
        ...dto,
        approvalStatus: 'submitted',
        submittedAt: new Date().toISOString(),
      });
    }

    return this.timesheetService.submitMine(user.sub, id, dto);
  }
}
