import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AttachmentService } from './attachment.service';
import { CreateAttachmentDto } from './dto/create-attachment.dto';

@UseGuards(JwtAuthGuard)
@Controller('attachments')
export class AttachmentController {
  constructor(private readonly attachmentService: AttachmentService) {}

  @Get('mine')
  findMine(@Req() req: { user: { sub: number } }) {
    return this.attachmentService.findMine(req.user.sub);
  }

  @Get('company')
  findForCompany(@Req() req: { user: { sub: number } }) {
    return this.attachmentService.findForCompany(req.user.sub);
  }

  @Post()
  create(
    @Req() req: { user: { sub: number } },
    @Body() dto: CreateAttachmentDto,
  ) {
    return this.attachmentService.createForUser(req.user.sub, dto);
  }
}
