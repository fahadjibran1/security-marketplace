import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { CompanyGuardService } from './company-guard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { CreateCompanyGuardDto } from './dto/create-company-guard.dto';
import { UpdateCompanyGuardDto } from './dto/update-company-guard.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';

@Controller('company-guards')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CompanyGuardController {
  constructor(private readonly companyGuardService: CompanyGuardService) {}

  @Get()
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES)
  findAll(@CurrentUser() user: JwtPayload) {
    return this.companyGuardService.findAllForUser(user);
  }

  /**
   * Platform ADMIN: direct create with trusted companyId from DTO.
   * Company GUARDS_MANAGE users: link an existing guard into their own company,
   *   companyId from DTO is ignored (resolved from membership).
   */
  @Post()
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateCompanyGuardDto) {
    if (user.role === UserRole.ADMIN) {
      return this.companyGuardService.createForUser(user, dto);
    }
    return this.companyGuardService.linkForCompanyUser(user, dto.guardId);
  }

  /**
   * Update CompanyGuard status (ACTIVE / INACTIVE / BLOCKED).
   * Tenant-scoped — company resolved from membership.
   */
  @Patch(':id')
  @Roles(...COMPANY_VIEW_ROLES)
  updateStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCompanyGuardDto,
  ) {
    return this.companyGuardService.updateStatusForCompanyUser(user, id, dto);
  }
}
