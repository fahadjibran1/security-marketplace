import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { RecordAttendanceDto } from './dto/record-attendance.dto';

@Controller('attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Get('mine')
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  findMine(@CurrentUser() user: JwtPayload) {
    return this.attendanceService.findMine(user.sub);
  }

  @Get('company')
  @Roles(UserRole.COMPANY, UserRole.COMPANY_ADMIN, UserRole.COMPANY_STAFF, UserRole.ADMIN)
  findCompany(@CurrentUser() user: JwtPayload) {
    return this.attendanceService.findForCompany(user);
  }

  @Post('check-in')
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  checkIn(@CurrentUser() user: JwtPayload, @Body() dto: RecordAttendanceDto) {
    return this.attendanceService.checkIn(user.sub, dto.shiftId, dto.nfcTag, dto.notes);
  }

  @Post('check-out')
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  checkOut(@CurrentUser() user: JwtPayload, @Body() dto: RecordAttendanceDto) {
    return this.attendanceService.checkOut(user.sub, dto.shiftId, dto.notes);
  }
}
