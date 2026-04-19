import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditLogService } from './audit-log.service';
import { COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('audit-logs')
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  @Roles(UserRole.ADMIN)
  findAll(@Req() req: { user: { role: UserRole } }) {
    return this.auditLogService.findAll();
  }

  @Get('company')
  @Roles(...COMPANY_VIEW_ROLES)
  findForCompany(@Req() req: { user: { sub: number } }) {
    return this.auditLogService.findForCompany(req.user.sub);
  }
}
