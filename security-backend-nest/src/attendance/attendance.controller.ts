import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { ManualAttendanceService } from './manual-attendance.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { RecordAttendanceDto } from './dto/record-attendance.dto';
import { AttendanceAuthorisationDto, CorrectAttendanceDto, ManualAttendanceDto } from './dto/manual-attendance.dto';

@Controller('attendance')
@UseGuards(JwtAuthGuard)
export class AttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly manualAttendanceService: ManualAttendanceService,
  ) {}

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

  // ── Manual attendance (Migration 67). Role guards only admit company accounts; the deciding checks (the caller's
  // company, membership role, per-person Control Room authorisation, the 24-hour Owner/Admin rule) are in
  // ManualAttendanceService. Guards and S4 platform administrators are refused there too.

  /** Feature detection for the web, and the limits it shows. Absent (404) on a backend without manual attendance. */
  @Get('manual/capabilities')
  @UseGuards(RolesGuard)
  @Roles(...COMPANY_VIEW_ROLES)
  manualCapabilities(@CurrentUser() user: JwtPayload) {
    return this.manualAttendanceService.capabilities(user);
  }

  @Post('manual/book-on')
  @UseGuards(RolesGuard)
  @Roles(...COMPANY_VIEW_ROLES)
  manualBookOn(@CurrentUser() user: JwtPayload, @Body() dto: ManualAttendanceDto) {
    return this.manualAttendanceService.bookOn(user, dto);
  }

  @Post('manual/book-off')
  @UseGuards(RolesGuard)
  @Roles(...COMPANY_VIEW_ROLES)
  manualBookOff(@CurrentUser() user: JwtPayload, @Body() dto: ManualAttendanceDto) {
    return this.manualAttendanceService.bookOff(user, dto);
  }

  @Post('events/:id/corrections')
  @UseGuards(RolesGuard)
  @Roles(...COMPANY_VIEW_ROLES)
  correct(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: CorrectAttendanceDto) {
    return this.manualAttendanceService.correct(user, id, dto);
  }

  @Get('shifts/:id/history')
  @UseGuards(RolesGuard)
  @Roles(...COMPANY_VIEW_ROLES)
  history(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.manualAttendanceService.history(user, id);
  }

  /** Owner / Admin: authorise (or stop authorising) one Control Room member to manage attendance. */
  @Put('control-room/:userId')
  @UseGuards(RolesGuard)
  @Roles(...COMPANY_VIEW_ROLES)
  setControlRoomAuthorisation(
    @CurrentUser() user: JwtPayload,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: AttendanceAuthorisationDto,
  ) {
    return this.manualAttendanceService.setControlRoomGrant(user, userId, dto.canManageAttendance);
  }
}
