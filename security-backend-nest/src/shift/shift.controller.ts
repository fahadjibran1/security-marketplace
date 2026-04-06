import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ShiftService } from './shift.service';
import { CreateShiftDto } from './dto/create-shift.dto';
import { UpdateShiftDto } from './dto/update-shift.dto';
import { RespondShiftDto } from './dto/respond-shift.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';

@Controller('shifts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ShiftController {
  constructor(private readonly shiftService: ShiftService) {}

  // Get all shifts relevant to logged user
  @Get()
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES, UserRole.GUARD)
  findAll(@CurrentUser() user: JwtPayload) {
    return this.shiftService.findAllForUser(user);
  }

  // Guard specific endpoint (IMPORTANT for mobile app)
  @Get('my')
  @Roles(UserRole.GUARD)
  getMyShifts(@CurrentUser() user: JwtPayload) {
    return this.shiftService.getGuardShifts(user);
  }

  // Create shift (company/admin only)
  @Post()
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateShiftDto) {
    return this.shiftService.createForUser(user, dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES)
  update(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateShiftDto) {
    return this.shiftService.updateForUser(user, id, dto);
  }

  @Patch(':id/respond')
  @Roles(UserRole.GUARD)
  respond(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RespondShiftDto,
  ) {
    return this.shiftService.respondForGuard(user, id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES)
  remove(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.shiftService.removeForUser(user, id);
  }

  // Get single shift (must stay LAST)
  @Get(':id')
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES, UserRole.GUARD)
  findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.shiftService.findOneForUser(user, id);
  }
}
