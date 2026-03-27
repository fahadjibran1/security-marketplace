import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CompanyGuardService } from './company-guard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { CreateCompanyGuardDto } from './dto/create-company-guard.dto';
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

  @Post()
  @Roles(UserRole.ADMIN, ...COMPANY_ADMIN_ROLES)
  create(@Body() dto: CreateCompanyGuardDto) {
    return this.companyGuardService.create(dto);
  }
}
