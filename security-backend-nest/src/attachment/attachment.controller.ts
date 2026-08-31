import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AttachmentService } from './attachment.service';
import { CreateAttachmentDto } from './dto/create-attachment.dto';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('attachments')
export class AttachmentController {
  constructor(private readonly attachmentService: AttachmentService) {}

  @Get('mine')
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  findMine(@Req() req: { user: { sub: number } }) {
    return this.attachmentService.findMine(req.user.sub);
  }

  @Get('company')
  @Roles(UserRole.ADMIN, ...COMPANY_VIEW_ROLES)
  findForCompany(@Req() req: { user: { sub: number } }) {
    return this.attachmentService.findForCompany(req.user.sub);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.GUARD, ...COMPANY_ADMIN_ROLES)
  create(
    @Req() req: { user: { sub: number } },
    @Body() dto: CreateAttachmentDto,
  ) {
    return this.attachmentService.createForUser(req.user.sub, dto);
  }
}
