import { Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { GuardProfileService } from './guard-profile.service';
import { CreateGuardProfileDto } from './dto/create-guard-profile.dto';
import { UpdateGuardProfileDto } from './dto/update-guard-profile.dto';
import { toAdminDto, toCompanyDto, toGuardDto } from './dto/guard-profile-response.mappers';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { JwtPayload } from '../auth/types/jwt-payload.type';

@Controller('guards')
@UseGuards(JwtAuthGuard, RolesGuard)
export class GuardProfileController {
  constructor(private readonly guardService: GuardProfileService) {}

  @Get()
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES)
  async findAll(@CurrentUser() user: JwtPayload) {
    const entities = await this.guardService.findAllForUser(user);
    if (user.role === UserRole.ADMIN) {
      return entities.map(toAdminDto);
    }
    return entities.map(toCompanyDto);
  }

  @Get('me')
  @Roles(UserRole.GUARD)
  async findMine(@CurrentUser() user: JwtPayload) {
    const guard = await this.guardService.findByUserId(user.sub);
    if (!guard) throw new NotFoundException('Guard profile not found');
    return toGuardDto(guard);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES, UserRole.GUARD)
  async findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    const entity = await this.guardService.findOneForUser(user, id);
    if (user.role === UserRole.ADMIN) return toAdminDto(entity);
    if (user.role === UserRole.GUARD) return toGuardDto(entity);
    return toCompanyDto(entity);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  async create(@Body() dto: CreateGuardProfileDto) {
    const entity = await this.guardService.create(dto);
    return toAdminDto(entity);
  }

  /**
   * Platform Admin only. Approval writes platform-global state on the shared GuardProfile, so it is
   * not something one Company may do: its effect would follow the Guard into every other Company.
   * A Company brings a Guard into its own workforce through the CompanyGuard relationship instead.
   */
  @Patch(':id/approve')
  @Roles(UserRole.ADMIN)
  async approve(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    const entity = await this.guardService.approveForUser(user, id);
    return toAdminDto(entity);
  }

  @Patch('me')
  @Roles(UserRole.GUARD)
  async updateMine(@CurrentUser() user: JwtPayload, @Body() dto: UpdateGuardProfileDto) {
    const entity = await this.guardService.updateByUserId(user.sub, dto);
    return toGuardDto(entity);
  }
}
