import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, In, LessThan, MoreThan, Not, Repository } from 'typeorm';

import { JwtPayload } from '../auth/types/jwt-payload.type';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AvailabilityService } from '../availability/availability.service';
import { CompanyGuardService } from '../company-guard/company-guard.service';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { Shift } from '../shift/entities/shift.entity';
import { Site } from '../site/entities/site.entity';
import { RotaSlot } from './entities/rota-slot.entity';
import {
  AssignMultipleResult,
  AssignPositionInput,
  ChangeRequirementResult,
  CreateSlotInput,
  ListSlotsQuery,
  SlotWithShifts,
} from './rota-slot.types';

// Guard positions whose presence means execution is live or historical
const EXECUTION_LOCK_STATUSES = ['in_progress', 'completed', 'missed'];
// Guard positions that count toward the requiredGuardCount floor
const COMMITTED_STATUSES = ['offered', 'ready', 'in_progress', 'completed', 'missed'];
// Statuses that block cancelling a single position
const CANCEL_BLOCKED_STATUSES = ['in_progress', 'completed', 'missed'];
// Statuses eligible for bulk-cancel during cancelSlot
const BULK_CANCELLABLE_STATUSES = ['unfilled', 'rejected', 'offered', 'ready'];

@Injectable()
export class RotaSlotService {
  constructor(
    @InjectRepository(RotaSlot) private readonly slotRepo: Repository<RotaSlot>,
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    @InjectRepository(Site) private readonly siteRepo: Repository<Site>,
    @InjectRepository(GuardProfile) private readonly guardProfileRepo: Repository<GuardProfile>,
    private readonly dataSource: DataSource,
    private readonly membershipService: CompanyMembershipService,
    private readonly companyGuardService: CompanyGuardService,
    private readonly availabilityService: AvailabilityService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async getSlotForCompany(slotId: number, companyId: number): Promise<RotaSlot> {
    const slot = await this.slotRepo.findOne({ where: { id: slotId, companyId } });
    if (!slot) throw new NotFoundException('Rota slot not found');
    return slot;
  }

  private parseDates(startAt: string, endAt: string): { start: Date; end: Date } {
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException('startAt and endAt must be valid ISO dates');
    }
    if (end <= start) {
      throw new BadRequestException('endAt must be after startAt');
    }
    return { start, end };
  }

  // ── Public service methods ───────────────────────────────────────────────────

  async createSlot(user: JwtPayload, input: CreateSlotInput): Promise<RotaSlot> {
    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.SHIFTS_MANAGE,
    );

    const { start: startAt, end: endAt } = this.parseDates(input.startAt, input.endAt);

    const requiredGuardCount = input.requiredGuardCount ?? 1;
    if (requiredGuardCount < 1) {
      throw new BadRequestException('requiredGuardCount must be at least 1');
    }

    const site = await this.siteRepo.findOne({ where: { id: input.siteId } });
    if (!site || site.company.id !== company.id) {
      throw new NotFoundException('Site not found');
    }

    const checkCallIntervalMinutes =
      input.checkCallIntervalMinutes ?? site.welfareCheckIntervalMinutes;

    const slot = await this.dataSource.transaction(async (manager) => {
      const slotRepo = manager.getRepository(RotaSlot);
      const shiftRepo = manager.getRepository(Shift);

      const saved = await slotRepo.save(
        slotRepo.create({
          companyId: company.id,
          siteId: input.siteId,
          jobId: input.jobId ?? null,
          startAt,
          endAt,
          requiredGuardCount,
          checkCallIntervalMinutes,
          instructions: input.instructions?.trim() || null,
          title: input.title?.trim() || null,
          status: 'active',
        }),
      );

      for (let i = 0; i < requiredGuardCount; i++) {
        await shiftRepo.save(
          shiftRepo.create({
            company,
            site,
            siteName: site.name,
            start: startAt,
            end: endAt,
            checkCallIntervalMinutes,
            instructions: input.instructions?.trim() || null,
            status: 'unfilled',
            rotaSlotId: saved.id,
          }),
        );
      }

      return saved;
    });

    await this.auditLogService.log({
      company: { id: company.id },
      user: { id: user.sub },
      action: 'rota_slot.created',
      entityType: 'rota_slot',
      entityId: slot.id,
      afterData: {
        siteId: slot.siteId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        requiredGuardCount: slot.requiredGuardCount,
      },
    });

    return slot;
  }

  async changeRequirement(
    user: JwtPayload,
    slotId: number,
    newCount: number,
  ): Promise<ChangeRequirementResult> {
    if (newCount < 1) {
      throw new BadRequestException('requiredGuardCount must be at least 1');
    }

    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.SHIFTS_MANAGE,
    );

    const result = await this.dataSource.transaction(async (manager) => {
      const slotRepo = manager.getRepository(RotaSlot);
      const shiftRepo = manager.getRepository(Shift);

      const slot = await slotRepo
        .createQueryBuilder('slot')
        .setLock('pessimistic_write')
        .where('slot.id = :id AND slot.companyId = :companyId', {
          id: slotId, companyId: company.id,
        })
        .getOne();

      if (!slot) throw new NotFoundException('Rota slot not found');
      if (slot.status === 'cancelled') {
        throw new UnprocessableEntityException('Cancelled slots cannot be modified');
      }

      const executionLocked = await shiftRepo.count({
        where: { rotaSlotId: slotId, status: In(EXECUTION_LOCK_STATUSES) },
      });
      if (executionLocked > 0) {
        throw new UnprocessableEntityException(
          'Requirement cannot be changed after shift execution has begun',
        );
      }

      const addedShiftIds: number[] = [];
      const cancelledShiftIds: number[] = [];
      const currentCount = slot.requiredGuardCount;

      if (newCount === currentCount) {
        return { slot, addedShiftIds, cancelledShiftIds };
      }

      if (newCount > currentCount) {
        const site = await manager.getRepository(Site).findOne({ where: { id: slot.siteId } });
        if (!site) throw new NotFoundException('Site not found');

        for (let i = 0; i < newCount - currentCount; i++) {
          const saved = await shiftRepo.save(
            shiftRepo.create({
              company: { id: slot.companyId } as any,
              site,
              siteName: site.name,
              start: slot.startAt,
              end: slot.endAt,
              checkCallIntervalMinutes: slot.checkCallIntervalMinutes,
              instructions: slot.instructions,
              status: 'unfilled',
              rotaSlotId: slotId,
            }),
          );
          addedShiftIds.push(saved.id);
        }
      } else {
        const floor = await shiftRepo.count({
          where: { rotaSlotId: slotId, status: In(COMMITTED_STATUSES) },
        });

        if (newCount < floor) {
          throw new UnprocessableEntityException(
            `Cannot reduce below ${floor} — that many guards are already committed`,
          );
        }

        const removeCount = currentCount - newCount;
        const unfilledCandidates = await shiftRepo.find({
          where: { rotaSlotId: slotId, status: 'unfilled' },
          order: { id: 'DESC' },
        });
        const rejectedCandidates = await shiftRepo.find({
          where: { rotaSlotId: slotId, status: 'rejected' },
          order: { id: 'DESC' },
        });

        const candidates = [...unfilledCandidates, ...rejectedCandidates].slice(0, removeCount);
        for (const candidate of candidates) {
          candidate.status = 'cancelled';
          await shiftRepo.save(candidate);
          cancelledShiftIds.push(candidate.id);
        }
      }

      slot.requiredGuardCount = newCount;
      await slotRepo.save(slot);

      return { slot, addedShiftIds, cancelledShiftIds };
    });

    await this.auditLogService.log({
      company: { id: company.id },
      user: { id: user.sub },
      action: 'rota_slot.requirement_changed',
      entityType: 'rota_slot',
      entityId: slotId,
      afterData: { requiredGuardCount: newCount },
    });

    return result;
  }

  async changeTime(
    user: JwtPayload,
    slotId: number,
    input: { startAt: string; endAt: string },
  ): Promise<RotaSlot> {
    const { start: startAt, end: endAt } = this.parseDates(input.startAt, input.endAt);

    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.SHIFTS_MANAGE,
    );

    const slot = await this.dataSource.transaction(async (manager) => {
      const slotRepo = manager.getRepository(RotaSlot);
      const shiftRepo = manager.getRepository(Shift);

      const slot = await slotRepo
        .createQueryBuilder('slot')
        .setLock('pessimistic_write')
        .where('slot.id = :id AND slot.companyId = :companyId', {
          id: slotId, companyId: company.id,
        })
        .getOne();

      if (!slot) throw new NotFoundException('Rota slot not found');
      if (slot.status === 'cancelled') {
        throw new UnprocessableEntityException('Cancelled slots cannot be modified');
      }

      const allShifts = await shiftRepo.find({ where: { rotaSlotId: slotId } });

      if (allShifts.some((s) => EXECUTION_LOCK_STATUSES.includes(s.status))) {
        throw new UnprocessableEntityException(
          'Time cannot be changed after execution has begun',
        );
      }

      // Re-validate assigned guards against the new window, excluding each guard's own shift
      const conflicts: Array<{ guardId: number; reason: string }> = [];
      for (const s of allShifts) {
        if (!s.guard || ['cancelled', 'unfilled', 'rejected'].includes(s.status)) continue;
        try {
          await this.availabilityService.assertGuardCanTakeShift(
            company.id, s.guard.id, startAt, endAt, s.id,
          );
        } catch (err: any) {
          conflicts.push({ guardId: s.guard.id, reason: err.message });
        }
      }

      if (conflicts.length > 0) {
        throw new UnprocessableEntityException({
          message: 'Time change conflicts with assigned guards',
          conflicts,
        });
      }

      slot.startAt = startAt;
      slot.endAt = endAt;
      await slotRepo.save(slot);

      for (const s of allShifts) {
        if (s.status === 'cancelled') continue;
        s.start = startAt;
        s.end = endAt;
        await shiftRepo.save(s);
      }

      return slot;
    });

    await this.auditLogService.log({
      company: { id: company.id },
      user: { id: user.sub },
      action: 'rota_slot.time_changed',
      entityType: 'rota_slot',
      entityId: slotId,
      afterData: { startAt, endAt },
    });

    return slot;
  }

  async changeCheckCallInterval(
    user: JwtPayload,
    slotId: number,
    minutes: number,
  ): Promise<RotaSlot> {
    if (minutes < 1) {
      throw new BadRequestException('checkCallIntervalMinutes must be at least 1');
    }

    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.SHIFTS_MANAGE,
    );

    const slot = await this.dataSource.transaction(async (manager) => {
      const slotRepo = manager.getRepository(RotaSlot);
      const shiftRepo = manager.getRepository(Shift);

      const slot = await slotRepo
        .createQueryBuilder('slot')
        .setLock('pessimistic_write')
        .where('slot.id = :id AND slot.companyId = :companyId', {
          id: slotId, companyId: company.id,
        })
        .getOne();

      if (!slot) throw new NotFoundException('Rota slot not found');
      if (slot.status === 'cancelled') {
        throw new UnprocessableEntityException('Cancelled slots cannot be modified');
      }

      slot.checkCallIntervalMinutes = minutes;
      await slotRepo.save(slot);

      // Propagate to active, non-terminal child shifts
      await shiftRepo.update(
        { rotaSlotId: slotId, status: Not(In(['cancelled', 'completed', 'missed'])) },
        { checkCallIntervalMinutes: minutes },
      );

      return slot;
    });

    await this.auditLogService.log({
      company: { id: company.id },
      user: { id: user.sub },
      action: 'rota_slot.check_call_interval_changed',
      entityType: 'rota_slot',
      entityId: slotId,
      afterData: { checkCallIntervalMinutes: minutes },
    });

    return slot;
  }

  async assignPosition(
    user: JwtPayload,
    slotId: number,
    input: AssignPositionInput,
  ): Promise<Shift> {
    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.SHIFTS_MANAGE,
    );

    const slot = await this.getSlotForCompany(slotId, company.id);
    if (slot.status === 'cancelled') {
      throw new UnprocessableEntityException('Cannot assign to a cancelled slot');
    }

    const guard = await this.guardProfileRepo.findOne({ where: { id: input.guardId } });
    if (!guard) throw new NotFoundException('Guard not found');

    const shift = await this.shiftRepo.findOne({
      where: { id: input.shiftId, rotaSlotId: slotId },
    });
    if (!shift || shift.company.id !== company.id) {
      throw new NotFoundException('Position not found in this slot');
    }

    if (shift.status !== 'unfilled') {
      throw new ConflictException('This position is no longer available for assignment');
    }

    await this.companyGuardService.ensureActiveRelationship(company.id, guard.id);
    await this.availabilityService.assertGuardCanTakeShift(
      company.id, guard.id, slot.startAt, slot.endAt,
    );

    // Atomic conditional UPDATE: succeeds only if still unfilled and unassigned at write time
    const rows: { id: number }[] = await this.dataSource.query(
      `UPDATE "shifts"
         SET "guardId" = $1, "status" = 'offered'
       WHERE "id" = $2
         AND "rotaSlotId" = $3
         AND "guardId" IS NULL
         AND "status" = 'unfilled'
       RETURNING "id"`,
      [guard.id, input.shiftId, slotId],
    );

    if (rows.length === 0) {
      throw new ConflictException(
        'This position has already been filled or is no longer available',
      );
    }

    await this.auditLogService.log({
      company: { id: company.id },
      user: { id: user.sub },
      action: 'rota_slot.position_assigned',
      entityType: 'shift',
      entityId: input.shiftId,
      afterData: { guardId: guard.id, slotId },
    });

    return this.shiftRepo.findOneOrFail({ where: { id: input.shiftId } });
  }

  async assignMultiple(
    user: JwtPayload,
    slotId: number,
    assignments: Array<{ shiftId: number; guardId: number }>,
  ): Promise<AssignMultipleResult> {
    const result: AssignMultipleResult = { assigned: [], failed: [] };

    for (const entry of assignments) {
      try {
        await this.assignPosition(user, slotId, entry);
        result.assigned.push({ shiftId: entry.shiftId, guardId: entry.guardId });
      } catch (err: any) {
        result.failed.push({
          shiftId: entry.shiftId,
          guardId: entry.guardId,
          reason: err.message ?? 'Unknown error',
        });
      }
    }

    return result;
  }

  async cancelPosition(
    user: JwtPayload,
    slotId: number,
    shiftId: number,
  ): Promise<Shift> {
    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.SHIFTS_MANAGE,
    );

    await this.getSlotForCompany(slotId, company.id);

    const shift = await this.shiftRepo.findOne({
      where: { id: shiftId, rotaSlotId: slotId },
    });
    if (!shift || shift.company.id !== company.id) {
      throw new NotFoundException('Position not found in this slot');
    }

    if (shift.status === 'cancelled') {
      return shift; // Idempotent
    }

    if (CANCEL_BLOCKED_STATUSES.includes(shift.status)) {
      throw new UnprocessableEntityException(
        `Cannot cancel a position with status '${shift.status}'`,
      );
    }

    shift.status = 'cancelled';
    const saved = await this.shiftRepo.save(shift);

    await this.auditLogService.log({
      company: { id: company.id },
      user: { id: user.sub },
      action: 'rota_slot.position_cancelled',
      entityType: 'shift',
      entityId: shiftId,
      afterData: { status: 'cancelled', slotId },
    });

    return saved;
  }

  async replacePosition(
    user: JwtPayload,
    slotId: number,
    rejectedShiftId: number,
  ): Promise<Shift> {
    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.SHIFTS_MANAGE,
    );

    const replacement = await this.dataSource.transaction(async (manager) => {
      const slotRepo = manager.getRepository(RotaSlot);
      const shiftRepo = manager.getRepository(Shift);

      const slot = await slotRepo
        .createQueryBuilder('slot')
        .setLock('pessimistic_write')
        .where('slot.id = :id AND slot.companyId = :companyId', {
          id: slotId, companyId: company.id,
        })
        .getOne();

      if (!slot) throw new NotFoundException('Rota slot not found');
      if (slot.status === 'cancelled') {
        throw new UnprocessableEntityException('Cannot create replacement for a cancelled slot');
      }

      const targetShift = await shiftRepo.findOne({
        where: { id: rejectedShiftId, rotaSlotId: slotId },
      });
      if (!targetShift || targetShift.company.id !== company.id) {
        throw new NotFoundException('Position not found in this slot');
      }
      if (targetShift.status !== 'rejected') {
        throw new UnprocessableEntityException(
          `Only rejected positions can be replaced — this position has status '${targetShift.status}'`,
        );
      }

      // Count forward-going positions (unfilled/offered/ready/in_progress) to determine
      // whether replacement capacity already exists. Slot lock ensures serializability.
      const activeShifts = await shiftRepo.find({ where: { rotaSlotId: slotId } });
      const forward = activeShifts.filter(
        (s) => !['cancelled', 'rejected', 'missed'].includes(s.status),
      ).length;

      if (forward >= slot.requiredGuardCount) {
        throw new ConflictException(
          'Replacement capacity already exists for this slot — no additional position created',
        );
      }

      const site = await manager.getRepository(Site).findOne({ where: { id: slot.siteId } });
      if (!site) throw new NotFoundException('Site not found');

      return shiftRepo.save(
        shiftRepo.create({
          company: { id: slot.companyId } as any,
          site,
          siteName: site.name,
          start: slot.startAt,
          end: slot.endAt,
          checkCallIntervalMinutes: slot.checkCallIntervalMinutes,
          instructions: slot.instructions,
          status: 'unfilled',
          rotaSlotId: slotId,
        }),
      );
    });

    await this.auditLogService.log({
      company: { id: company.id },
      user: { id: user.sub },
      action: 'rota_slot.position_replaced',
      entityType: 'shift',
      entityId: rejectedShiftId,
      afterData: { replacementShiftId: replacement.id, slotId },
    });

    return this.shiftRepo.findOneOrFail({ where: { id: replacement.id } });
  }

  async cancelSlot(user: JwtPayload, slotId: number): Promise<RotaSlot> {
    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.SHIFTS_MANAGE,
    );

    const slot = await this.dataSource.transaction(async (manager) => {
      const slotRepo = manager.getRepository(RotaSlot);
      const shiftRepo = manager.getRepository(Shift);

      const slot = await slotRepo
        .createQueryBuilder('slot')
        .setLock('pessimistic_write')
        .where('slot.id = :id AND slot.companyId = :companyId', {
          id: slotId, companyId: company.id,
        })
        .getOne();

      if (!slot) throw new NotFoundException('Rota slot not found');
      if (slot.status === 'cancelled') return slot; // Idempotent

      const liveCount = await shiftRepo.count({
        where: { rotaSlotId: slotId, status: 'in_progress' },
      });
      if (liveCount > 0) {
        throw new UnprocessableEntityException(
          'Slot cannot be cancelled while guards are on shift',
        );
      }

      await shiftRepo.update(
        { rotaSlotId: slotId, status: In(BULK_CANCELLABLE_STATUSES) },
        { status: 'cancelled' },
      );

      slot.status = 'cancelled';
      await slotRepo.save(slot);

      return slot;
    });

    await this.auditLogService.log({
      company: { id: company.id },
      user: { id: user.sub },
      action: 'rota_slot.cancelled',
      entityType: 'rota_slot',
      entityId: slotId,
      afterData: { status: 'cancelled' },
    });

    return slot;
  }

  // ── Read methods ─────────────────────────────────────────────────────────────

  async listSlots(user: JwtPayload, query: ListSlotsQuery): Promise<SlotWithShifts[]> {
    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.SHIFTS_VIEW,
    );

    const now = new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(now.getTime() - 7 * 86400000);
    const to = query.to
      ? new Date(query.to + (query.to.length === 10 ? 'T23:59:59Z' : ''))
      : new Date(now.getTime() + 14 * 86400000);

    const whereClause: any = {
      companyId: company.id,
      startAt: LessThan(to),
      endAt: MoreThan(from),
    };

    if (query.siteId) whereClause.siteId = query.siteId;
    if (query.status) whereClause.status = query.status;

    const slots = await this.slotRepo.find({
      where: whereClause,
      relations: ['site'],
      order: { startAt: 'ASC' },
    });

    // Filter by clientId (via site relation)
    const filtered = query.clientId
      ? slots.filter((s) => s.site?.client?.id === query.clientId)
      : slots;

    if (filtered.length === 0) return [];

    const slotIds = filtered.map((s) => s.id);
    const allShifts = await this.shiftRepo.find({ where: { rotaSlotId: In(slotIds) } });

    const shiftsBySlotId = new Map<number, Shift[]>();
    for (const shift of allShifts) {
      if (shift.rotaSlotId == null) continue;
      const arr = shiftsBySlotId.get(shift.rotaSlotId) ?? [];
      arr.push(shift);
      shiftsBySlotId.set(shift.rotaSlotId, arr);
    }

    return filtered.map((slot) => ({
      slot,
      shifts: shiftsBySlotId.get(slot.id) ?? [],
    }));
  }

  async getSlotDetail(user: JwtPayload, slotId: number): Promise<SlotWithShifts> {
    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.SHIFTS_VIEW,
    );

    const slot = await this.slotRepo.findOne({
      where: { id: slotId, companyId: company.id },
      relations: ['site'],
    });
    if (!slot) throw new NotFoundException('Rota slot not found');

    const shifts = await this.shiftRepo.find({ where: { rotaSlotId: slotId } });
    return { slot, shifts };
  }

  async updateMetadata(
    user: JwtPayload,
    slotId: number,
    input: { title?: string | null; instructions?: string | null },
  ): Promise<RotaSlot> {
    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.SHIFTS_MANAGE,
    );

    const slot = await this.getSlotForCompany(slotId, company.id);
    if (slot.status === 'cancelled') {
      throw new UnprocessableEntityException('Cancelled slots cannot be modified');
    }

    if (input.title !== undefined) slot.title = input.title?.trim() || null;
    if (input.instructions !== undefined) slot.instructions = input.instructions?.trim() || null;

    const saved = await this.slotRepo.save(slot);

    await this.auditLogService.log({
      company: { id: company.id },
      user: { id: user.sub },
      action: 'rota_slot.metadata_updated',
      entityType: 'rota_slot',
      entityId: slotId,
      afterData: { title: slot.title, instructions: slot.instructions },
    });

    return saved;
  }
}
