import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { GuardProfileService } from './guard-profile.service';
import { CreateGuardProfileDto } from './dto/create-guard-profile.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';

@Controller('guards')
@UseGuards(JwtAuthGuard, RolesGuard)
export class GuardProfileController {
  constructor(private readonly guardService: GuardProfileService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COMPANY)
  findAll() {
    return this.guardService.findAll();
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.guardService.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateGuardProfileDto) {
    return this.guardService.create(dto);
  }
}
