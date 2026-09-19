import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { RotaWeekQueryDto } from './dto/rota-week-query.dto';
import { RotaWeekService } from './rota-week.service';

@Controller('rota')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RotaController {
  constructor(private readonly rotaWeekService: RotaWeekService) {}

  @Get('week')
  @Roles(...COMPANY_VIEW_ROLES)
  getWeek(@CurrentUser() user: JwtPayload, @Query() query: RotaWeekQueryDto) {
    return this.rotaWeekService.getWeek(user, {
      weekCommencing: query.weekCommencing,
      clientId: query.clientId,
      siteIds: query.siteIds,
      status: query.status,
    });
  }
}
