import { Body, Controller, Get, Param, ParseIntPipe, Put, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { COMPANY_ADMIN_ROLES } from '../user/entities/user.entity';
import { UpsertClientPortalUserDto } from './dto/upsert-client-portal-user.dto';
import { ClientPortalUserService } from './client-portal-user.service';

@Controller('client-portal-users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ClientPortalUserController {
  constructor(private readonly clientPortalUserService: ClientPortalUserService) {}

  @Get('client/:clientId')
  @Roles(...COMPANY_ADMIN_ROLES)
  listForClient(@CurrentUser() user: JwtPayload, @Param('clientId', ParseIntPipe) clientId: number) {
    return this.clientPortalUserService.listForClient(user.sub, clientId);
  }

  @Put()
  @Roles(...COMPANY_ADMIN_ROLES)
  upsert(@CurrentUser() user: JwtPayload, @Body() dto: UpsertClientPortalUserDto) {
    return this.clientPortalUserService.upsertForCompanyUser(user.sub, dto);
  }
}
