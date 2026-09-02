import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '../user/entities/user.entity';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { GuardPersonnelService } from './guard-personnel.service';
import { UpdateGuardIdentityDto } from './dto/update-guard-identity.dto';
import { RevealFieldDto } from './dto/reveal-field.dto';

// P1A access model:
//   GUARD        — read and update own identity; reveal own data (audited)
//   ADMIN        — read any guard identity (masked); reveal any guard data (audited)
//   COMPANY / COMPANY_ADMIN / COMPANY_STAFF — NO ACCESS in P1A
//   CLIENT roles — NO ACCESS

@Controller('guard-personnel')
@UseGuards(JwtAuthGuard, RolesGuard)
export class GuardPersonnelController {
  constructor(private readonly service: GuardPersonnelService) {}

  // Guard self-service ────────────────────────────────────────────────────────

  @Get('me/identity')
  @Roles(UserRole.GUARD)
  getMyIdentity(@CurrentUser() user: JwtPayload) {
    return this.service.getIdentityForGuard(user.sub);
  }

  @Patch('me/identity')
  @Roles(UserRole.GUARD)
  updateMyIdentity(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateGuardIdentityDto,
  ) {
    return this.service.updateIdentityForGuard(user.sub, dto);
  }

  @Post('me/reveal')
  @Roles(UserRole.GUARD)
  revealMyField(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RevealFieldDto,
    @Req() req: Request,
  ) {
    if (dto.field !== 'nino' && dto.field !== 'utr') {
      throw new BadRequestException('field must be "nino" or "utr"');
    }
    return this.service.revealForGuard(user.sub, dto.field, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  // Platform Admin ────────────────────────────────────────────────────────────

  @Get('admin/:id/identity')
  @Roles(UserRole.ADMIN)
  getGuardIdentityAdmin(@Param('id', ParseIntPipe) id: number) {
    return this.service.getIdentityForAdmin(id);
  }

  @Post('admin/:id/reveal')
  @Roles(UserRole.ADMIN)
  revealGuardFieldAdmin(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RevealFieldDto,
    @Req() req: Request,
  ) {
    if (dto.field !== 'nino' && dto.field !== 'utr') {
      throw new BadRequestException('field must be "nino" or "utr"');
    }
    return this.service.revealForAdmin(user.sub, id, dto.field, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }
}
