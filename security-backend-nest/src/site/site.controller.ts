import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { SiteService } from './site.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';

@Controller('sites')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SiteController {
  constructor(private readonly siteService: SiteService) {}

  @Get()
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES)
  findAll(@CurrentUser() user: JwtPayload) {
    if (user.role === UserRole.ADMIN) {
      return this.siteService.findAll();
    }

    return this.siteService.findForCompanyUser(user.sub);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.siteService.findOne(id);
  }

  @Post()
  @Roles(...COMPANY_ADMIN_ROLES)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateSiteDto) {
    return this.siteService.createForCompanyUser(user.sub, dto);
  }

  @Patch(':id')
  @Roles(...COMPANY_ADMIN_ROLES)
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSiteDto,
  ) {
    return this.siteService.updateForCompanyUser(user.sub, id, dto);
  }
}
