import {
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
  Query,
  UseGuards,
} from '@nestjs/common';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_ADMIN_ROLES, COMPANY_VIEW_ROLES } from '../user/entities/user.entity';
import { AssignMultipleRotaSlotPositionsDto } from './dto/assign-multiple-rota-slot-positions.dto';
import { AssignRotaSlotPositionDto } from './dto/assign-rota-slot-position.dto';
import { ChangeRotaSlotCheckCallDto } from './dto/change-rota-slot-check-call.dto';
import { ChangeRotaSlotRequirementDto } from './dto/change-rota-slot-requirement.dto';
import { ChangeRotaSlotTimeDto } from './dto/change-rota-slot-time.dto';
import { CreateRotaSlotDto } from './dto/create-rota-slot.dto';
import { ListRotaSlotsDto } from './dto/list-rota-slots.dto';
import { UpdateRotaSlotMetadataDto } from './dto/update-rota-slot-metadata.dto';
import { toSlotDetail, toSlotSummary } from './rota-slot.mapper';
import { RotaSlotService } from './rota-slot.service';

@Controller('rota-slots')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RotaSlotController {
  constructor(private readonly rotaSlotService: RotaSlotService) {}

  @Get()
  @Roles(...COMPANY_VIEW_ROLES)
  async list(@CurrentUser() user: JwtPayload, @Query() query: ListRotaSlotsDto) {
    const results = await this.rotaSlotService.listSlots(user, {
      from: query.from,
      to: query.to,
      siteId: query.siteId,
      clientId: query.clientId,
      status: query.status,
    });
    const now = new Date();
    return results.map(({ slot, shifts }) => toSlotSummary(slot, shifts, now));
  }

  @Get(':id')
  @Roles(...COMPANY_VIEW_ROLES)
  async findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    const { slot, shifts } = await this.rotaSlotService.getSlotDetail(user, id);
    return toSlotDetail(slot, shifts);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(...COMPANY_ADMIN_ROLES)
  async create(@CurrentUser() user: JwtPayload, @Body() dto: CreateRotaSlotDto) {
    const slot = await this.rotaSlotService.createSlot(user, {
      siteId: dto.siteId,
      startAt: dto.startAt,
      endAt: dto.endAt,
      requiredGuardCount: dto.requiredGuardCount,
      checkCallIntervalMinutes: dto.checkCallIntervalMinutes,
      instructions: dto.instructions,
      title: dto.title,
      jobId: dto.jobId,
    });
    // Re-load with site relation for the response
    const { slot: detail, shifts } = await this.rotaSlotService.getSlotDetail(user, slot.id);
    return toSlotDetail(detail, shifts);
  }

  @Patch(':id')
  @Roles(...COMPANY_ADMIN_ROLES)
  async updateMetadata(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRotaSlotMetadataDto,
  ) {
    await this.rotaSlotService.updateMetadata(user, id, {
      title: dto.title,
      instructions: dto.instructions,
    });
    const { slot, shifts } = await this.rotaSlotService.getSlotDetail(user, id);
    return toSlotDetail(slot, shifts);
  }

  @Patch(':id/requirement')
  @Roles(...COMPANY_ADMIN_ROLES)
  async changeRequirement(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangeRotaSlotRequirementDto,
  ) {
    const result = await this.rotaSlotService.changeRequirement(user, id, dto.requiredGuardCount);
    const now = new Date();
    const { slot, shifts } = await this.rotaSlotService.getSlotDetail(user, id);
    return {
      slot: toSlotSummary(slot, shifts, now),
      addedShiftIds: result.addedShiftIds,
      cancelledShiftIds: result.cancelledShiftIds,
    };
  }

  @Patch(':id/time')
  @Roles(...COMPANY_ADMIN_ROLES)
  async changeTime(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangeRotaSlotTimeDto,
  ) {
    await this.rotaSlotService.changeTime(user, id, {
      startAt: dto.startAt,
      endAt: dto.endAt,
    });
    const { slot, shifts } = await this.rotaSlotService.getSlotDetail(user, id);
    return toSlotDetail(slot, shifts);
  }

  @Patch(':id/check-call')
  @Roles(...COMPANY_ADMIN_ROLES)
  async changeCheckCall(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangeRotaSlotCheckCallDto,
  ) {
    await this.rotaSlotService.changeCheckCallInterval(user, id, dto.checkCallIntervalMinutes);
    const { slot, shifts } = await this.rotaSlotService.getSlotDetail(user, id);
    return toSlotDetail(slot, shifts);
  }

  @Post(':id/assign')
  @Roles(...COMPANY_ADMIN_ROLES)
  async assignPosition(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignRotaSlotPositionDto,
  ) {
    await this.rotaSlotService.assignPosition(user, id, {
      shiftId: dto.shiftId,
      guardId: dto.guardId,
    });
    const { slot, shifts } = await this.rotaSlotService.getSlotDetail(user, id);
    return toSlotDetail(slot, shifts);
  }

  @Post(':id/assign-multiple')
  @Roles(...COMPANY_ADMIN_ROLES)
  async assignMultiple(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignMultipleRotaSlotPositionsDto,
  ) {
    /**
     * HTTP status decision: 200 with { assigned, failed } partial-success body.
     *
     * 207 Multi-Status is technically correct for partial success but is uncommon
     * in this codebase and creates friction with frontend/API tooling that checks
     * 2xx. Returning 200 with an explicit failed[] array is consistent with the
     * existing pattern and lets callers inspect partial failures without treating
     * the request as an error.
     */
    const result = await this.rotaSlotService.assignMultiple(user, id, dto.assignments);
    return result;
  }

  @Delete(':id/positions/:shiftId')
  @Roles(...COMPANY_ADMIN_ROLES)
  async cancelPosition(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Param('shiftId', ParseIntPipe) shiftId: number,
  ) {
    await this.rotaSlotService.cancelPosition(user, id, shiftId);
    const { slot, shifts } = await this.rotaSlotService.getSlotDetail(user, id);
    return toSlotDetail(slot, shifts);
  }

  @Post(':id/cancel')
  @Roles(...COMPANY_ADMIN_ROLES)
  async cancelSlot(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.rotaSlotService.cancelSlot(user, id);
    const { slot, shifts } = await this.rotaSlotService.getSlotDetail(user, id);
    return toSlotDetail(slot, shifts);
  }
}
