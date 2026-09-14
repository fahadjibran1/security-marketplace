import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { RecordAttendanceDto } from './dto/record-attendance.dto';

@Controller('attendance')
@UseGuards(JwtAuthGuard)
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Get('mine')
  @UseGuards(RolesGuard)
  @Roles(UserRole.GUARD)
  findMine(@CurrentUser() user: JwtPayload) {
    return this.attendanceService.findMine(user.sub);
  }

  @Get('company')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES)
  getCompanyAttendance(@CurrentUser() user: JwtPayload) {
    return this.attendanceService.findForCompany(user);
  }

  @Post('check-in')
  @UseGuards(RolesGuard)
  @Roles(UserRole.GUARD)
  checkIn(@CurrentUser() user: JwtPayload, @Body() dto: RecordAttendanceDto) {
    return this.attendanceService.checkIn(user.sub, dto);
  }

  @Post('check-out')
  @UseGuards(RolesGuard)
  @Roles(UserRole.GUARD)
  checkOut(@CurrentUser() user: JwtPayload, @Body() dto: RecordAttendanceDto) {
    return this.attendanceService.checkOut(user.sub, dto);
  }
}
