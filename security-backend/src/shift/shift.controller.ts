import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ShiftService } from './shift.service';
import { CreateShiftDto } from './dto/create-shift.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';

@Controller('shifts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ShiftController {
  constructor(private readonly shiftService: ShiftService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findAll() {
    return this.shiftService.findAll();
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.COMPANY)
  create(@Body() dto: CreateShiftDto) {
    return this.shiftService.create(dto);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.shiftService.findOne(id);
  }
}
