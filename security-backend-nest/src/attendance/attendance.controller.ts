import { Body, Controller, ForbiddenException, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { isCompanyRole, UserRole } from '../user/entities/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { RecordAttendanceDto } from './dto/record-attendance.dto';

@Controller('attendance')
@UseGuards(JwtAuthGuard)
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Get('mine')
  @UseGuards(RolesGuard)
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  findMine(@CurrentUser() user: JwtPayload) {
    return this.attendanceService.findMine(user.sub);
  }

  @Get('company')
  getCompanyAttendance(@Req() req: { user: JwtPayload }) {
    const user = req.user;
    console.log('[AttendanceController] GET /attendance/company', {
      sub: user?.sub,
      role: user?.role,
      user,
    });

    if (user.role !== UserRole.ADMIN && !isCompanyRole(user.role)) {
      throw new ForbiddenException('Only company users can access company attendance');
    }

    return this.attendanceService.findForCompany(user);
  }

  @Post('check-in')
  @UseGuards(RolesGuard)
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  checkIn(@CurrentUser() user: JwtPayload, @Body() dto: RecordAttendanceDto) {
    return this.attendanceService.checkIn(user.sub, dto.shiftId, dto.nfcTag, dto.notes);
  }

  @Post('check-out')
  @UseGuards(RolesGuard)
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  checkOut(@CurrentUser() user: JwtPayload, @Body() dto: RecordAttendanceDto) {
    return this.attendanceService.checkOut(user.sub, dto.shiftId, dto.notes);
  }
}
