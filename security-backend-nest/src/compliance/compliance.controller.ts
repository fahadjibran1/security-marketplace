import { Body, Controller, Get, Param, ParseBoolPipe, ParseIntPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { ComplianceService } from './compliance.service';
import { CreateGuardDocumentDto } from './dto/create-guard-document.dto';
import { UpsertComplianceRecordDto } from './dto/upsert-compliance-record.dto';
import { VerifyGuardDocumentDto } from './dto/verify-guard-document.dto';
import { GuardComplianceService, GuardComplianceStatus } from './guard-compliance.service';

@Controller('compliance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ComplianceController {
  constructor(
    private readonly complianceService: ComplianceService,
    private readonly guardComplianceService: GuardComplianceService,
  ) {}

  @Get()
  @Roles(...COMPANY_VIEW_ROLES)
  list(@CurrentUser() user: JwtPayload) {
    return this.complianceService.listForCompanyUser(user.sub);
  }

  @Get('mine')
  @Roles(UserRole.GUARD)
  listMine(@CurrentUser() user: JwtPayload) {
    return this.complianceService.listForGuardUser(user.sub);
  }

  @Get('statuses')
  @Roles(...COMPANY_VIEW_ROLES)
  listStatuses(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: GuardComplianceStatus,
  ) {
    return this.guardComplianceService.listStatusesForCompanyUser(user.sub, status);
  }

  @Get('mine/status')
  @Roles(UserRole.GUARD)
  mineStatus(@CurrentUser() user: JwtPayload) {
    return this.guardComplianceService.getStatusForGuardUser(user.sub);
  }

  @Get('documents')
  @Roles(...COMPANY_VIEW_ROLES)
  listDocuments(@CurrentUser() user: JwtPayload, @Query('guardId') guardId?: string) {
    return this.guardComplianceService.listDocumentsForCompanyUser(
      user.sub,
      guardId ? Number(guardId) : undefined,
    );
  }

  @Get('documents/mine')
  @Roles(UserRole.GUARD)
  listMyDocuments(@CurrentUser() user: JwtPayload) {
    return this.guardComplianceService.listDocumentsForGuardUser(user.sub);
  }

  @Post('documents')
  @Roles(...COMPANY_ADMIN_ROLES)
  uploadForCompany(@CurrentUser() user: JwtPayload, @Body() dto: CreateGuardDocumentDto) {
    return this.guardComplianceService.uploadDocumentForCompanyUser(user.sub, dto);
  }

  @Post('documents/mine')
  @Roles(UserRole.GUARD)
  uploadMine(@CurrentUser() user: JwtPayload, @Body() dto: CreateGuardDocumentDto) {
    return this.guardComplianceService.uploadDocumentForGuardUser(user.sub, dto);
  }

  @Patch('documents/:id/verify')
  @Roles(...COMPANY_ADMIN_ROLES)
  verifyDocument(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: VerifyGuardDocumentDto,
  ) {
    return this.guardComplianceService.verifyDocumentForCompanyUser(user.sub, id, dto.verified);
  }

  @Post()
  @Roles(...COMPANY_ADMIN_ROLES)
  create(@CurrentUser() user: JwtPayload, @Body() dto: UpsertComplianceRecordDto) {
    return this.complianceService.upsertForCompanyUser(user.sub, dto);
  }

  @Put()
  @Roles(...COMPANY_ADMIN_ROLES)
  update(@CurrentUser() user: JwtPayload, @Body() dto: UpsertComplianceRecordDto) {
    return this.complianceService.upsertForCompanyUser(user.sub, dto);
  }
}
