import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import {
  CreatePatrolCheckpointDto,
  CreatePatrolRouteDto,
  CreatePatrolScheduleDto,
  PatrolExceptionsQueryDto,
  PatrolListQueryDto,
  PatrolOverviewQueryDto,
  PatrolRunsQueryDto,
  PatrolWindowsDayQueryDto,
  UpdatePatrolCheckpointDto,
  UpdatePatrolRouteDto,
  UpdatePatrolScheduleDto,
  ResolvePatrolExceptionDto,
  UpsertPatrolPolicyDto,
} from './dto/patrol.dto';
import { PatrolEvidenceHoldsQueryDto } from './dto/patrol-evidence.dto';
import { PatrolConfigService } from './patrol-config.service';
import { PatrolExceptionService } from './patrol-exception.service';
import { PatrolQueryService } from './patrol-query.service';
import { PatrolWindowsDayService } from './patrol-windows-day.service';

/**
 * Company Patrol Management (Migration 68). Company accounts only (Guards and S4 platform admins are refused by the
 * role guard). The deciding checks — the caller's company, the company's patrolsEnabled switch (404 when off) and the
 * patrols.* permission — are in PatrolAccessService.
 */
@Controller('patrols')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...COMPANY_VIEW_ROLES)
export class PatrolConfigController {
  constructor(
    private readonly config: PatrolConfigService,
    private readonly query: PatrolQueryService,
    private readonly exceptions: PatrolExceptionService,
    private readonly windowsDay: PatrolWindowsDayService,
  ) {}

  // ── Policies (patrols.view / patrols.manage; 90-day retention: Owner / Admin) ──
  @Get('policies')
  getPolicies(@CurrentUser() user: JwtPayload) {
    return this.config.getPolicies(user);
  }

  @Put('policies/default')
  putCompanyDefault(@CurrentUser() user: JwtPayload, @Body() dto: UpsertPatrolPolicyDto) {
    return this.config.upsertPolicy(user, null, dto);
  }

  @Put('policies/sites/:siteId')
  putSitePolicy(@CurrentUser() user: JwtPayload, @Param('siteId', ParseIntPipe) siteId: number, @Body() dto: UpsertPatrolPolicyDto) {
    return this.config.upsertPolicy(user, siteId, dto);
  }

  // ── Schedules ──
  @Get('schedules')
  listSchedules(@CurrentUser() user: JwtPayload, @Query() q: PatrolListQueryDto) {
    return this.config.listSchedules(user, q);
  }

  @Get('schedules/:id')
  getSchedule(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.config.getSchedule(user, id);
  }

  @Post('schedules')
  createSchedule(@CurrentUser() user: JwtPayload, @Body() dto: CreatePatrolScheduleDto) {
    return this.config.createSchedule(user, dto);
  }

  @Patch('schedules/:id')
  updateSchedule(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePatrolScheduleDto) {
    return this.config.updateSchedule(user, id, dto);
  }

  /** Archives (never deletes). */
  @Delete('schedules/:id')
  archiveSchedule(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.config.archiveSchedule(user, id);
  }

  // ── Checkpoints ──
  @Get('checkpoints')
  listCheckpoints(@CurrentUser() user: JwtPayload, @Query() q: PatrolListQueryDto) {
    return this.config.listCheckpoints(user, q);
  }

  @Get('checkpoints/:id')
  getCheckpoint(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.config.getCheckpoint(user, id);
  }

  @Post('checkpoints')
  createCheckpoint(@CurrentUser() user: JwtPayload, @Body() dto: CreatePatrolCheckpointDto) {
    return this.config.createCheckpoint(user, dto);
  }

  @Patch('checkpoints/:id')
  updateCheckpoint(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePatrolCheckpointDto) {
    return this.config.updateCheckpoint(user, id, dto);
  }

  @Post('checkpoints/:id/rotate')
  @HttpCode(200)
  rotateCheckpoint(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.config.rotateCheckpoint(user, id);
  }

  @Post('checkpoints/:id/revoke')
  @HttpCode(200)
  revokeCheckpoint(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.config.revokeCheckpoint(user, id);
  }

  /** The signed QR payload to print (503 PATROL_QR_SIGNING_KEY_UNAVAILABLE without a server key). */
  @Get('checkpoints/:id/label')
  checkpointLabel(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.config.checkpointLabel(user, id);
  }

  // ── Routes ──
  @Get('routes')
  listRoutes(@CurrentUser() user: JwtPayload, @Query() q: PatrolListQueryDto) {
    return this.config.listRoutes(user, q);
  }

  @Get('routes/:id')
  getRoute(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.config.getRoute(user, id);
  }

  @Post('routes')
  createRoute(@CurrentUser() user: JwtPayload, @Body() dto: CreatePatrolRouteDto) {
    return this.config.createRoute(user, dto);
  }

  @Patch('routes/:id')
  updateRoute(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePatrolRouteDto) {
    return this.config.updateRoute(user, id, dto);
  }

  /** Archives (never deletes). */
  @Delete('routes/:id')
  archiveRoute(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.config.archiveRoute(user, id);
  }

  // ── Reads of stored patrols ──
  @Get('overview')
  overview(@CurrentUser() user: JwtPayload, @Query() q: PatrolOverviewQueryDto) {
    return this.query.overview(user, q);
  }

  /** #78: scheduled windows due / completed / outstanding in the site-local day, from the P1-B window engine (patrols.view). */
  @Get('windows/day')
  windowsForDay(@CurrentUser() user: JwtPayload, @Query() q: PatrolWindowsDayQueryDto) {
    return this.windowsDay.day(user, q);
  }

  @Get('runs')
  listRuns(@CurrentUser() user: JwtPayload, @Query() q: PatrolRunsQueryDto) {
    return this.query.listRuns(user, q);
  }

  @Get('runs/:id')
  getRun(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.query.getRun(user, id);
  }

  /** Evidence metadata (patrols.evidence). Viewing a photo: GET /patrols/evidence/:id/download (P1-C). */
  @Get('runs/:id/evidence')
  getRunEvidence(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.query.getRunEvidence(user, id);
  }

  // ── Exceptions (P1-B): patrols.view to list; alerts.manage or patrols.manage to act (owner decision, P1-C). An exception with an alert is acted on through the
  // alert's own lifecycle, so the alert and the exception always agree (the alert endpoints work equally).
  @Get('exceptions')
  listExceptions(@CurrentUser() user: JwtPayload, @Query() q: PatrolExceptionsQueryDto) {
    return this.exceptions.list(user, q);
  }

  @Post('exceptions/:id/acknowledge')
  @HttpCode(200)
  acknowledgeException(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.exceptions.acknowledge(user, id);
  }

  @Post('exceptions/:id/resolve')
  @HttpCode(200)
  resolveException(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: ResolvePatrolExceptionDto) {
    return this.exceptions.resolve(user, id, dto);
  }

  /** Evidence holds (patrols.holds): active by default, ?status=all with releases. Placing / releasing: PatrolEvidenceController. */
  @Get('holds')
  listHolds(@CurrentUser() user: JwtPayload, @Query() q: PatrolEvidenceHoldsQueryDto) {
    return this.query.listHolds(user, q.status === 'all' ? 'all' : 'active');
  }
}
