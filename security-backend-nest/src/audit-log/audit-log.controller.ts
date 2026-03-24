import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuditLogService } from './audit-log.service';
import { UserRole } from '../user/entities/user.entity';

@UseGuards(JwtAuthGuard)
@Controller('audit-logs')
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  findAll(@Req() req: { user: { role: UserRole } }) {
    if (req.user.role !== UserRole.ADMIN) {
      return [];
    }

    return this.auditLogService.findAll();
  }

  @Get('company')
  findForCompany(@Req() req: { user: { sub: number } }) {
    return this.auditLogService.findForCompany(req.user.sub);
  }
}
