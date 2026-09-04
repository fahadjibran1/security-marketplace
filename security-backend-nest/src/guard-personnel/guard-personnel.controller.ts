import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { DrivingTransportService } from './driving-transport.service';
import { UpdateDrivingTransportDto } from './dto/update-driving-transport.dto';
import { EmergencyContactService } from './emergency-contact.service';
import { UpdateEmergencyContactDto } from './dto/update-emergency-contact.dto';

// P1A access model:
//   GUARD        — read and update own identity; reveal own data (audited)
//   ADMIN        — read any guard identity (masked); reveal any guard data (audited)
//   COMPANY / COMPANY_ADMIN / COMPANY_STAFF — NO ACCESS in P1A
//   CLIENT roles — NO ACCESS

// P1D access model:
//   GUARD        — read and update own driving & transport; reveal own licence number (audited)
//   ADMIN        — read any guard driving data (masked); reveal any licence number (audited)
//   COMPANY / COMPANY_ADMIN / COMPANY_STAFF — operational view only (no licence number)
//   CLIENT roles — NO ACCESS

// P1E access model:
//   GUARD        — read, upsert, and delete own emergency contact
//   ADMIN        — read any guard emergency contact (audited — third-party PII)
//   COMPANY / COMPANY_ADMIN / COMPANY_STAFF — operational read only; active relationship enforced; audited
//   CLIENT roles — NO ACCESS

@Controller('guard-personnel')
@UseGuards(JwtAuthGuard, RolesGuard)
export class GuardPersonnelController {
  constructor(
    private readonly service: GuardPersonnelService,
    private readonly drivingService: DrivingTransportService,
    private readonly emergencyContactService: EmergencyContactService,
  ) {}

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
    @Req() req: Request,
  ) {
    return this.service.updateIdentityForGuard(user.sub, dto, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
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

  // P1D — Driving & Transport: Guard self-service ─────────────────────────────

  @Get('me/driving-transport')
  @Roles(UserRole.GUARD)
  getMyDrivingTransport(@CurrentUser() user: JwtPayload) {
    return this.drivingService.getDrivingForGuard(user.sub);
  }

  @Patch('me/driving-transport')
  @Roles(UserRole.GUARD)
  updateMyDrivingTransport(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateDrivingTransportDto,
    @Req() req: Request,
  ) {
    return this.drivingService.updateDrivingForGuard(user.sub, dto, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post('me/driving-licence/reveal')
  @Roles(UserRole.GUARD)
  revealMyDrivingLicenceNumber(@CurrentUser() user: JwtPayload, @Req() req: Request) {
    return this.drivingService.revealLicenceForGuard(user.sub, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  // P1D — Driving & Transport: Platform Admin ─────────────────────────────────

  @Get('admin/:id/driving-transport')
  @Roles(UserRole.ADMIN)
  getGuardDrivingTransportAdmin(@Param('id', ParseIntPipe) id: number) {
    return this.drivingService.getDrivingForAdmin(id);
  }

  @Post('admin/:id/driving-licence/reveal')
  @Roles(UserRole.ADMIN)
  revealGuardDrivingLicenceAdmin(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    return this.drivingService.revealLicenceForAdmin(user.sub, id, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  // P1D — Driving & Transport: Company operational view ───────────────────────

  @Get('company/guard/:guardId/driving-transport')
  @Roles(UserRole.COMPANY, UserRole.COMPANY_ADMIN, UserRole.COMPANY_STAFF)
  getGuardDrivingTransportForCompany(
    @CurrentUser() user: JwtPayload,
    @Param('guardId', ParseIntPipe) guardId: number,
  ) {
    return this.drivingService.getDrivingForCompany(user.sub, guardId);
  }

  // P1E — Emergency Contact: Guard self-service ────────────────────────────────

  @Get('me/emergency-contact')
  @Roles(UserRole.GUARD)
  getMyEmergencyContact(@CurrentUser() user: JwtPayload) {
    return this.emergencyContactService.getEmergencyContactForGuard(user.sub);
  }

  @Patch('me/emergency-contact')
  @Roles(UserRole.GUARD)
  upsertMyEmergencyContact(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateEmergencyContactDto,
    @Req() req: Request,
  ) {
    return this.emergencyContactService.upsertEmergencyContactForGuard(user.sub, dto, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Delete('me/emergency-contact')
  @Roles(UserRole.GUARD)
  @HttpCode(HttpStatus.NO_CONTENT)
  removeMyEmergencyContact(@CurrentUser() user: JwtPayload, @Req() req: Request) {
    return this.emergencyContactService.removeEmergencyContactForGuard(user.sub, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  // P1E — Emergency Contact: Platform Admin ───────────────────────────────────

  @Get('admin/:id/emergency-contact')
  @Roles(UserRole.ADMIN)
  getGuardEmergencyContactAdmin(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    return this.emergencyContactService.getEmergencyContactForAdmin(user.sub, id, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  // P1E — Emergency Contact: Company operational view ─────────────────────────

  @Get('company/guard/:guardId/emergency-contact')
  @Roles(UserRole.COMPANY, UserRole.COMPANY_ADMIN)
  getGuardEmergencyContactForCompany(
    @CurrentUser() user: JwtPayload,
    @Param('guardId', ParseIntPipe) guardId: number,
    @Req() req: Request,
  ) {
    return this.emergencyContactService.getEmergencyContactForCompany(user.sub, guardId, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }
}
