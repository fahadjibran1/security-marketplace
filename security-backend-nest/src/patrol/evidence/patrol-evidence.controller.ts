import { Body, Controller, Get, Header, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtPayload } from '../../auth/types/jwt-payload.type';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { COMPANY_VIEW_ROLES, UserRole } from '../../user/entities/user.entity';
import {
  CreatePatrolEvidenceExportDto,
  CreatePatrolEvidenceHoldDto,
  PatrolEvidenceAccessQueryDto,
  PatrolEvidenceReasonDto,
  ReleasePatrolEvidenceHoldDto,
  RequestPatrolEvidenceUploadDto,
} from '../dto/patrol-evidence.dto';
import { PatrolEvidenceExportService } from './patrol-evidence-export.service';
import { PatrolEvidenceService } from './patrol-evidence.service';

/**
 * Company patrol evidence routes (Patrols P1-C). Company accounts only; the deciding checks — the caller's company from
 * resolveCompanyContext, the company's patrolsEnabled switch (404 when off) and the patrols.* permission — are in
 * PatrolAccessService. Responses that carry a presigned URL are never cached.
 */
@Controller('patrols')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...COMPANY_VIEW_ROLES)
export class PatrolEvidenceController {
  constructor(
    private readonly evidence: PatrolEvidenceService,
    private readonly exports: PatrolEvidenceExportService,
  ) {}

  /** patrols.evidence: a short-lived, audited link to one verified photo. */
  @Get('evidence/:id/download')
  @Header('Cache-Control', 'no-store')
  download(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Query() q: PatrolEvidenceAccessQueryDto) {
    return this.evidence.download(user, id, q.purpose);
  }

  /** patrols.holds (Owner / Admin): delete through the state machine (quarantined, recoverable until the purge). */
  @Post('evidence/:id/delete')
  @HttpCode(200)
  remove(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: PatrolEvidenceReasonDto) {
    return this.evidence.requestDeletion(user, id, dto.reason);
  }

  /** patrols.holds: restore a deleted photo from quarantine. */
  @Post('evidence/:id/restore')
  @HttpCode(200)
  restore(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: PatrolEvidenceReasonDto) {
    return this.evidence.restore(user, id, dto.reason);
  }

  /** patrols.holds: place an evidence hold (photo, run, shift, or site and date range). */
  @Post('holds')
  placeHold(@CurrentUser() user: JwtPayload, @Body() dto: CreatePatrolEvidenceHoldDto) {
    return this.evidence.placeHold(user, dto);
  }

  @Post('holds/:id/release')
  @HttpCode(200)
  releaseHold(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: ReleasePatrolEvidenceHoldDto) {
    return this.evidence.releaseHold(user, id, dto.reason);
  }

  /** patrols.holds: live storage metering per site, exports and totals. */
  @Get('storage-usage')
  usage(@CurrentUser() user: JwtPayload) {
    return this.evidence.usage(user);
  }

  // ── Exports (patrols.holds) ──
  @Post('exports')
  @HttpCode(202)
  requestExport(@CurrentUser() user: JwtPayload, @Body() dto: CreatePatrolEvidenceExportDto) {
    return this.exports.request(user, dto);
  }

  @Get('exports')
  listExports(@CurrentUser() user: JwtPayload) {
    return this.exports.list(user);
  }

  @Get('exports/:id')
  getExport(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.exports.get(user, id);
  }

  @Get('exports/:id/download')
  @Header('Cache-Control', 'no-store')
  downloadExport(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.exports.download(user, id);
  }
}

/** The Guard's photo routes (their own run only). */
@Controller('patrols')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.GUARD)
export class PatrolEvidenceGuardController {
  constructor(private readonly evidence: PatrolEvidenceService) {}

  /** An idempotent upload intent: returns the record and a short-lived presigned PUT (null once settled). */
  @Post('runs/:id/evidence')
  @Header('Cache-Control', 'no-store')
  requestUpload(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: RequestPatrolEvidenceUploadDto) {
    return this.evidence.requestUpload(user, id, dto);
  }

  /** The server verifies what arrived; repeating returns the settled result. */
  @Post('evidence/:id/complete')
  @HttpCode(200)
  complete(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.evidence.completeUpload(user, id);
  }
}
