import { Body, Controller, Get, Param, ParseIntPipe, Patch, UseGuards } from '@nestjs/common';
import { TimesheetService } from './timesheet.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';
import { UpdateTimesheetDto } from './dto/update-timesheet.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';

@Controller('timesheets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TimesheetController {
  constructor(private readonly timesheetService: TimesheetService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findAll() {
    return this.timesheetService.findAll();
  }

  @Get('company')
  @Roles(UserRole.COMPANY, UserRole.ADMIN)
  findForCompany(@CurrentUser() user: JwtPayload) {
    return this.timesheetService.findForCompany(user.sub);
  }

  @Get('mine')
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  findMine(@CurrentUser() user: JwtPayload) {
    return this.timesheetService.findMine(user.sub);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.COMPANY)
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTimesheetDto) {
    return this.timesheetService.update(id, dto);
  }
}
