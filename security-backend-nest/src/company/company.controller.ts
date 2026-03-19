import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { CompanyService } from './company.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '../user/entities/user.entity';
import { JwtPayload } from '../auth/types/jwt-payload.type';

@Controller('companies')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CompanyController {
  constructor(private readonly companyService: CompanyService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COMPANY)
  findAll() {
    return this.companyService.findAll();
  }

  @Get('me')
  @Roles(UserRole.COMPANY)
  findMine(@CurrentUser() user: JwtPayload) {
    return this.companyService.findByUserId(user.sub);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.COMPANY)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.companyService.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateCompanyDto) {
    return this.companyService.create(dto);
  }

  @Patch('me')
  @Roles(UserRole.COMPANY)
  updateMine(@CurrentUser() user: JwtPayload, @Body() dto: UpdateCompanyDto) {
    return this.companyService.updateByUserId(user.sub, dto);
  }
}
