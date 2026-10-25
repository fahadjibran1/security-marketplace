import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import {
  ApproveAmendmentDto,
  AssessAmendmentDto,
  CompanyAmendmentsEnabledDto,
  ControlRoomAuthorisationDto,
  DisputeAmendmentDto,
  ProposeAmendmentDto,
  RecordVerbalAgreementDto,
  ResolveDisputeDto,
  RespondAmendmentDto,
  UpdateShiftPolicyDto,
  WithdrawAmendmentDto,
} from './dto/shift-amendment.dto';
import { ShiftAmendmentService } from './shift-amendment.service';

/**
 * Live Shift Amendments (Phase 1). Role guards here only admit the right kind of account; the deciding checks — the
 * caller's company, membership role, per-person Control Room authorisation, the Guard owning the shift, and whether
 * the company has amendments enabled — are made in ShiftAmendmentService.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ShiftAmendmentController {
  constructor(private readonly service: ShiftAmendmentService) {}

  @Post('shifts/:shiftId/amendments')
  @Roles(...COMPANY_VIEW_ROLES)
  propose(@CurrentUser() user: JwtPayload, @Param('shiftId', ParseIntPipe) shiftId: number, @Body() dto: ProposeAmendmentDto) {
    return this.service.propose(user, shiftId, dto);
  }

  /** Dry run of a proposal: what the company would see, with nothing written. Same permission as proposing. */
  @Post('shifts/:shiftId/amendments/assessment')
  @HttpCode(200)
  @Roles(...COMPANY_VIEW_ROLES)
  assess(@CurrentUser() user: JwtPayload, @Param('shiftId', ParseIntPipe) shiftId: number, @Body() dto: AssessAmendmentDto) {
    return this.service.assessProposal(user, shiftId, dto.proposedEnd);
  }

  @Get('shifts/:shiftId/amendments')
  @Roles(...COMPANY_VIEW_ROLES, UserRole.GUARD)
  listForShift(@CurrentUser() user: JwtPayload, @Param('shiftId', ParseIntPipe) shiftId: number) {
    return this.service.listForShift(user, shiftId);
  }

  @Get('shift-amendments/mine')
  @Roles(UserRole.GUARD)
  listMine(@CurrentUser() user: JwtPayload) {
    return this.service.listMine(user);
  }

  /** The requesting company's staff: id, display name, role (and Control Room authorisation for Owner/Admin). */
  @Get('shift-amendments/staff')
  @Roles(...COMPANY_VIEW_ROLES)
  listStaff(@CurrentUser() user: JwtPayload) {
    return this.service.listStaff(user);
  }

  @Get('shift-amendments/policy')
  @Roles(...COMPANY_VIEW_ROLES)
  getPolicy(@CurrentUser() user: JwtPayload) {
    return this.service.getPolicy(user);
  }

  @Put('shift-amendments/policy')
  @Roles(...COMPANY_VIEW_ROLES)
  updatePolicy(@CurrentUser() user: JwtPayload, @Body() dto: UpdateShiftPolicyDto) {
    return this.service.updatePolicy(user, dto);
  }

  @Put('shift-amendments/control-room/:userId')
  @Roles(...COMPANY_VIEW_ROLES)
  setControlRoomAuthorisation(
    @CurrentUser() user: JwtPayload,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: ControlRoomAuthorisationDto,
  ) {
    return this.service.setControlRoomAuthorisation(user, userId, dto.canAmendShifts);
  }

  /**
   * S4 platform administrator only (owner decision D5). Amendments are standard for every company; this is the
   * emergency per-company switch (off, and back on). A company can never change it for itself.
   */
  @Put('admin/shift-amendments/companies/:companyId')
  @Roles(UserRole.ADMIN)
  setCompanyEnabled(
    @CurrentUser() user: JwtPayload,
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: CompanyAmendmentsEnabledDto,
  ) {
    return this.service.setCompanyEnabled(user, companyId, dto.enabled);
  }

  @Get('shift-amendments/:id')
  @Roles(...COMPANY_VIEW_ROLES, UserRole.GUARD)
  findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(user, id);
  }

  @Post('shift-amendments/:id/approve')
  @HttpCode(200)
  @Roles(...COMPANY_VIEW_ROLES)
  approve(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: ApproveAmendmentDto) {
    return this.service.approve(user, id, dto);
  }

  @Post('shift-amendments/:id/withdraw')
  @HttpCode(200)
  @Roles(...COMPANY_VIEW_ROLES)
  withdraw(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: WithdrawAmendmentDto) {
    return this.service.withdraw(user, id, dto);
  }

  @Post('shift-amendments/:id/record-verbal-agreement')
  @HttpCode(200)
  @Roles(...COMPANY_VIEW_ROLES)
  recordVerbalAgreement(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: RecordVerbalAgreementDto) {
    return this.service.recordVerbalAgreement(user, id, dto);
  }

  @Post('shift-amendments/:id/resolve-dispute')
  @HttpCode(200)
  @Roles(...COMPANY_VIEW_ROLES)
  resolveDispute(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: ResolveDisputeDto) {
    return this.service.resolveDispute(user, id, dto);
  }

  @Patch('shift-amendments/:id/respond')
  @Roles(UserRole.GUARD)
  respond(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: RespondAmendmentDto) {
    return this.service.respond(user, id, dto);
  }

  @Post('shift-amendments/:id/dispute')
  @HttpCode(200)
  @Roles(UserRole.GUARD)
  dispute(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number, @Body() dto: DisputeAmendmentDto) {
    return this.service.dispute(user, id, dto);
  }
}
