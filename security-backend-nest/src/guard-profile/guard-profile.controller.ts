import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { GuardProfileService } from './guard-profile.service';
import { CreateGuardProfileDto } from './dto/create-guard-profile.dto';
import { UpdateGuardProfileDto } from './dto/update-guard-profile.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { JwtPayload } from '../auth/types/jwt-payload.type';

@Controller('guards')
@UseGuards(JwtAuthGuard, RolesGuard)
export class GuardProfileController {
  constructor(private readonly guardService: GuardProfileService) {}

  @Get()
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES)
  findAll() {
    return this.guardService.findAll();
  }

  @Get('me')
  @Roles(UserRole.GUARD)
  findMine(@CurrentUser() user: JwtPayload) {
    return this.guardService.findByUserId(user.sub);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES, UserRole.GUARD)
  findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.guardService.findOneForUser(user, id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateGuardProfileDto) {
    return this.guardService.create(dto);
  }

  @Patch(':id/approve')
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES)
  approve(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.guardService.approveForUser(user, id);
  }

  @Patch('me')
  @Roles(UserRole.GUARD)
  updateMine(@CurrentUser() user: JwtPayload, @Body() dto: UpdateGuardProfileDto) {
    return this.guardService.updateByUserId(user.sub, dto);
  }
}
