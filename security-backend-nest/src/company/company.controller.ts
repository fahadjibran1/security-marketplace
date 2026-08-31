import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { CompanyService } from './company.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { JwtPayload } from '../auth/types/jwt-payload.type';

// RB-006: findAll()/findOne(:id) are platform-admin-only — they return/target
// any tenant's record with no ownership filter. Company-side roles (company,
// company_admin, company_staff) must only ever resolve their own company via
// findMine(), which derives the record from the authenticated JWT (user.sub),
// never from a client-supplied id.
@Controller('companies')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CompanyController {
  constructor(private readonly companyService: CompanyService) {}

  @Get()
  @Roles(UserRole.ADMIN)
  findAll() {
    return this.companyService.findAll();
  }

  @Get('me')
  @Roles(...COMPANY_VIEW_ROLES)
  findMine(@CurrentUser() user: JwtPayload) {
    return this.companyService.findByUserId(user.sub);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.companyService.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateCompanyDto) {
    return this.companyService.create(dto);
  }

  @Patch('me')
  @Roles(...COMPANY_ADMIN_ROLES)
  updateMine(@CurrentUser() user: JwtPayload, @Body() dto: UpdateCompanyDto) {
    return this.companyService.updateByUserId(user.sub, dto);
  }
}
