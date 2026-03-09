import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CompanyGuardService } from './company-guard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';
import { CreateCompanyGuardDto } from './dto/create-company-guard.dto';

@Controller('company-guards')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CompanyGuardController {
  constructor(private readonly companyGuardService: CompanyGuardService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COMPANY)
  findAll() {
    return this.companyGuardService.findAll();
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.COMPANY)
  create(@Body() dto: CreateCompanyGuardDto) {
    return this.companyGuardService.create(dto);
  }
}
