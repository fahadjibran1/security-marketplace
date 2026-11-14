import { Body, Controller, Get, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { DailyLogService } from './daily-log.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CreateDailyLogDto } from './dto/create-daily-log.dto';
import { CompanyResponsePrivacyInterceptor } from '../common/privacy/company-response-privacy';

@Controller('daily-logs')
@UseInterceptors(CompanyResponsePrivacyInterceptor)
@UseGuards(JwtAuthGuard, RolesGuard)
export class DailyLogController {
  constructor(private readonly dailyLogService: DailyLogService) {}

  @Get('mine')
  @Roles(UserRole.GUARD)
  findMine(@CurrentUser() user: JwtPayload) {
    return this.dailyLogService.findMine(user.sub);
  }

  @Get('company')
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES)
  findForCompany(@CurrentUser() user: JwtPayload) {
    if (user.role === UserRole.ADMIN) {
      return this.dailyLogService.findAll();
    }

    return this.dailyLogService.findForCompany(user.sub, user.role);
  }

  @Post()
  @Roles(UserRole.GUARD)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateDailyLogDto) {
    return this.dailyLogService.createForGuard(user.sub, dto);
  }
}
