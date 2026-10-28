import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserRole } from '../user/entities/user.entity';
import { CompletePatrolRunDto, PatrolShiftQueryDto, RecordPatrolVisitDto, StartPatrolRunDto } from './dto/patrol.dto';
import { PatrolGuardService } from './patrol-guard.service';

/**
 * Guard patrol routes (Migration 68). Guards only, on their own shift, with the company switch on (404 otherwise).
 * Every write takes a client-generated id and is idempotent. Location fields are refused
 * (400 PATROL_LOCATION_VERIFICATION_DISABLED).
 */
@Controller('patrols')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.GUARD)
export class PatrolGuardController {
  constructor(private readonly guard: PatrolGuardService) {}

  @Get('mine/plan')
  plan(@CurrentUser() user: JwtPayload, @Query() q: PatrolShiftQueryDto) {
    return this.guard.plan(user, q.shiftId);
  }

  @Get('mine/runs')
  myRuns(@CurrentUser() user: JwtPayload, @Query() q: PatrolShiftQueryDto) {
    return this.guard.myRuns(user, q.shiftId);
  }

  @Post('runs')
  startRun(@CurrentUser() user: JwtPayload, @Body() dto: StartPatrolRunDto) {
    return this.guard.startRun(user, dto);
  }

  @Post('runs/:id/visits')
  recordVisit(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: RecordPatrolVisitDto) {
    return this.guard.recordVisit(user, id, dto);
  }

  @Post('runs/:id/complete')
  @HttpCode(200)
  complete(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: CompletePatrolRunDto) {
    return this.guard.completeRun(user, id, dto);
  }
}
