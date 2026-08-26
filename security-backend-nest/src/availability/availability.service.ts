import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, MoreThan, Not, Repository } from 'typeorm';

import { AuditLogService } from '../audit-log/audit-log.service';
import { CompanyService } from '../company/company.service';
import { CompanyGuard, CompanyGuardStatus } from '../company-guard/entities/company-guard.entity';
import { ComplianceService } from '../compliance/compliance.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { LeaveService } from '../leave/leave.service';
import { Shift } from '../shift/entities/shift.entity';
import { UpsertAvailabilityOverrideDto } from './dto/upsert-availability-override.dto';
import { UpsertAvailabilityRuleDto } from './dto/upsert-availability-rule.dto';
import {
  GuardAvailabilityOverride,
  GuardAvailabilityOverrideStatus,
} from './entities/guard-availability-override.entity';
import { GuardAvailabilityRule } from './entities/guard-availability-rule.entity';

export type GuardEligibilityResult = {
  guardId: number;
  fullName?: string;
  relationshipStatus?: string | null;
  isEligible: boolean;
  availabilityStatus: 'available' | 'unavailable' | 'no_rule';
  hasShiftClash: boolean;
  hasApprovedLeave: boolean;
  complianceValid: boolean;
  reasons: string[];
};

@Injectable()
export class AvailabilityService {
  constructor(
    @InjectRepository(GuardAvailabilityRule) private readonly ruleRepo: Repository<GuardAvailabilityRule>,
    @InjectRepository(GuardAvailabilityOverride) private readonly overrideRepo: Repository<GuardAvailabilityOverride>,
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    @InjectRepository(CompanyGuard) private readonly companyGuardRepo: Repository<CompanyGuard>,
    private readonly companyService: CompanyService,
    private readonly guardProfileService: GuardProfileService,
    private readonly leaveService: LeaveService,
    private readonly complianceService: ComplianceService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async listRulesForCompanyUser(userId: number, guardId?: number) {
    const company = await this.getCompany(userId);
    const guardIds = await this.getCompanyGuardIds(company.id);
    if (!guardIds.length) return [];
    if (guardId && !guardIds.includes(guardId)) {
      throw new ForbiddenException('Guard does not belong to this company.');
    }

    const targetGuardIds = guardId ? [guardId] : guardIds;
    return this.ruleRepo.find({
      where: [
        ...targetGuardIds.map((id) => ({ company: { id: company.id }, guard: { id } })),
        ...targetGuardIds.map((id) => ({ company: IsNull(), guard: { id } })),
      ],
      order: { weekday: 'ASC', startTime: 'ASC' },
    });
  }

  async listOverridesForCompanyUser(userId: number, guardId?: number) {
    const company = await this.getCompany(userId);
    const guardIds = await this.getCompanyGuardIds(company.id);
    if (!guardIds.length) return [];
    if (guardId && !guardIds.includes(guardId)) {
      throw new ForbiddenException('Guard does not belong to this company.');
    }

    const targetGuardIds = guardId ? [guardId] : guardIds;
    return this.overrideRepo.find({
      where: [
        ...targetGuardIds.map((id) => ({ company: { id: company.id }, guard: { id } })),
        ...targetGuardIds.map((id) => ({ company: IsNull(), guard: { id } })),
      ],
      order: { date: 'DESC', startTime: 'ASC' },
    });
  }

  async listRulesForGuardUser(userId: number) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    return this.ruleRepo.find({
      where: { company: IsNull(), guard: { id: guard.id } },
      order: { weekday: 'ASC', startTime: 'ASC' },
    });
  }

  async listOverridesForGuardUser(userId: number) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    return this.overrideRepo.find({
      where: { company: IsNull(), guard: { id: guard.id } },
      order: { date: 'DESC', startTime: 'ASC' },
    });
  }

  async upsertRuleForCompanyUser(userId: number, dto: UpsertAvailabilityRuleDto) {
    const company = await this.getCompany(userId);
    if (!dto.guardId) throw new BadRequestException('Guard is required.');
    return this.upsertRule({ userId, companyId: company.id, guardId: dto.guardId, dto });
  }

  async upsertRuleForGuardUser(userId: number, dto: UpsertAvailabilityRuleDto) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    return this.upsertRule({ userId, companyId: null, guardId: guard.id, dto });
  }

  async upsertOverrideForCompanyUser(userId: number, dto: UpsertAvailabilityOverrideDto) {
    const company = await this.getCompany(userId);
    if (!dto.guardId) throw new BadRequestException('Guard is required.');
    await this.ensureCompanyGuard(company.id, dto.guardId);
    return this.upsertOverride({ userId, companyId: company.id, guardId: dto.guardId, dto });
  }

  async upsertOverrideForGuardUser(userId: number, dto: UpsertAvailabilityOverrideDto) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    return this.upsertOverride({ userId, companyId: null, guardId: guard.id, dto });
  }

  async evaluateGuardForShift(input: {
    companyId: number;
    guardId: number;
    startAt: Date;
    endAt: Date;
    excludeShiftId?: number;
  }): Promise<GuardEligibilityResult> {
    const relation = await this.companyGuardRepo.findOne({
      where: { company: { id: input.companyId }, guard: { id: input.guardId } },
    });
    const reasons: string[] = [];
    const hasApprovedLeave = await this.leaveService.hasApprovedLeaveOverlap(
      input.companyId,
      input.guardId,
      input.startAt,
      input.endAt,
    );
    if (hasApprovedLeave) reasons.push('Approved leave overlaps this shift.');
    const hasShiftClash = await this.hasShiftClash(
      input.guardId,
      input.startAt,
      input.endAt,
      input.excludeShiftId,
    );
    if (hasShiftClash) reasons.push('Guard already has an overlapping shift.');
    let complianceValid = true;
    try {
      await this.complianceService.assertGuardAssignable(input.companyId, input.guardId);
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      complianceValid = false;
      reasons.push(`Compliance invalid: ${error.message}`);
    }
    const availabilityStatus = await this.getAvailabilityStatus(
      input.companyId,
      input.guardId,
      input.startAt,
      input.endAt,
    );
    if (availabilityStatus === 'unavailable') reasons.push('Guard is marked unavailable for this time.');
    if (availabilityStatus === 'no_rule') reasons.push('No availability rule found for this time.');

    const hardBlocked =
      hasApprovedLeave || hasShiftClash || !complianceValid || availabilityStatus === 'unavailable';
    return {
      guardId: input.guardId,
      fullName: relation?.guard?.fullName,
      relationshipStatus: relation?.status ?? null,
      isEligible: !hardBlocked,
      availabilityStatus,
      hasShiftClash,
      hasApprovedLeave,
      complianceValid,
      reasons,
    };
  }

  async assertGuardCanTakeShift(
    companyId: number,
    guardId: number,
    startAt: Date,
    endAt: Date,
    excludeShiftId?: number,
  ) {
    const result = await this.evaluateGuardForShift({
      companyId,
      guardId,
      startAt,
      endAt,
      excludeShiftId,
    });
    if (result.hasShiftClash) throw new ForbiddenException('Guard has an overlapping shift assignment.');
    if (result.hasApprovedLeave) throw new ForbiddenException('Guard has approved leave during this shift.');
    if (!result.complianceValid) {
      throw new ForbiddenException(
        result.reasons.find((reason) => reason.includes('Compliance invalid')) ||
          'Guard compliance invalid.',
      );
    }
    if (result.availabilityStatus === 'unavailable') {
      throw new ForbiddenException('Guard is marked unavailable for this time.');
    }
    return result;
  }

  async eligibleGuardsForShift(shift: Shift) {
    const relations = await this.companyGuardRepo.find({
      where: { company: { id: shift.company.id }, status: CompanyGuardStatus.ACTIVE },
      order: { createdAt: 'DESC' },
    });
    return Promise.all(
      relations.map((relation) =>
        this.evaluateGuardForShift({
          companyId: shift.company.id,
          guardId: relation.guard.id,
          startAt: new Date(shift.start),
          endAt: new Date(shift.end),
          excludeShiftId: shift.id,
        }),
      ),
    );
  }

  private async upsertRule(input: {
    userId: number;
    companyId: number | null;
    guardId: number;
    dto: UpsertAvailabilityRuleDto;
  }) {
    if (input.companyId) await this.ensureCompanyGuard(input.companyId, input.guardId);
    const guard = await this.guardProfileService.findOne(input.guardId);
    const company = input.companyId ? await this.companyService.findOne(input.companyId) : null;
    const existing = input.dto.id
      ? await this.ruleRepo.findOne({
          where: {
            id: input.dto.id,
            guard: { id: guard.id },
            company: input.companyId ? { id: input.companyId } : IsNull(),
          },
        })
      : null;
    if (input.dto.id && !existing) {
      throw new ForbiddenException('Availability rule is outside the permitted scope.');
    }
    const beforeData = existing ? { ...existing } : null;
    const rule = existing ?? this.ruleRepo.create({ guard, company });
    Object.assign(rule, {
      company,
      weekday: input.dto.weekday,
      startTime: input.dto.startTime,
      endTime: input.dto.endTime,
      isAvailable: input.dto.isAvailable,
      effectiveFrom: input.dto.effectiveFrom || null,
      effectiveTo: input.dto.effectiveTo || null,
    });
    const saved = await this.ruleRepo.save(rule);
    await this.auditLogService.log({
      company,
      user: { id: input.userId },
      action: existing ? 'availability_rule.updated' : 'availability_rule.created',
      entityType: 'guard_availability_rule',
      entityId: saved.id,
      beforeData,
      afterData: {
        guardId: guard.id,
        weekday: saved.weekday,
        startTime: saved.startTime,
        endTime: saved.endTime,
        isAvailable: saved.isAvailable,
      },
    });
    return saved;
  }

  private async upsertOverride(input: {
    userId: number;
    companyId: number | null;
    guardId: number;
    dto: UpsertAvailabilityOverrideDto;
  }) {
    if (input.companyId) await this.ensureCompanyGuard(input.companyId, input.guardId);
    const guard = await this.guardProfileService.findOne(input.guardId);
    const company = input.companyId ? await this.companyService.findOne(input.companyId) : null;
    const existing = input.dto.id
      ? await this.overrideRepo.findOne({
          where: {
            id: input.dto.id,
            guard: { id: guard.id },
            company: input.companyId ? { id: input.companyId } : IsNull(),
          },
        })
      : null;
    if (input.dto.id && !existing) {
      throw new ForbiddenException('Availability override is outside the permitted scope.');
    }
    const beforeData = existing ? { ...existing } : null;
    const row = existing ?? this.overrideRepo.create({ guard, company });
    Object.assign(row, {
      company,
      date: input.dto.date,
      startTime: input.dto.startTime || null,
      endTime: input.dto.endTime || null,
      status: input.dto.status,
      note: input.dto.note?.trim() || null,
    });
    const saved = await this.overrideRepo.save(row);
    await this.auditLogService.log({
      company,
      user: { id: input.userId },
      action: existing ? 'availability_override.updated' : 'availability_override.created',
      entityType: 'guard_availability_override',
      entityId: saved.id,
      beforeData,
      afterData: {
        guardId: guard.id,
        date: saved.date,
        status: saved.status,
        startTime: saved.startTime,
        endTime: saved.endTime,
      },
    });
    return saved;
  }

  private async getAvailabilityStatus(
    companyId: number,
    guardId: number,
    startAt: Date,
    endAt: Date,
  ): Promise<'available' | 'unavailable' | 'no_rule'> {
    const shiftDate = this.dateKey(startAt);
    const overrides = await this.overrideRepo.find({
      where: [
        { company: { id: companyId }, guard: { id: guardId }, date: shiftDate },
        { company: IsNull(), guard: { id: guardId }, date: shiftDate },
      ],
      order: { company: { id: 'DESC' }, id: 'DESC' },
    });
    const matchingOverride = overrides.find((override) =>
      this.windowMatches(override.startTime, override.endTime, startAt, endAt),
    );
    if (matchingOverride) {
      return matchingOverride.status === GuardAvailabilityOverrideStatus.AVAILABLE
        ? 'available'
        : 'unavailable';
    }

    const rules = await this.ruleRepo.find({
      where: [
        { company: { id: companyId }, guard: { id: guardId }, weekday: startAt.getDay() },
        { company: IsNull(), guard: { id: guardId }, weekday: startAt.getDay() },
      ],
      order: { company: { id: 'DESC' }, startTime: 'ASC' },
    });
    const matchingRule = rules.find(
      (rule) =>
        this.ruleEffective(rule, startAt) &&
        this.windowMatches(rule.startTime, rule.endTime, startAt, endAt),
    );
    if (!matchingRule) return 'no_rule';
    return matchingRule.isAvailable ? 'available' : 'unavailable';
  }

  private async hasShiftClash(
    guardId: number,
    startAt: Date,
    endAt: Date,
    excludeShiftId?: number,
  ) {
    const where: any = {
      guard: { id: guardId },
      status: In(['scheduled', 'offered', 'ready', 'in_progress']),
      start: LessThan(endAt),
      end: MoreThan(startAt),
    };
    if (excludeShiftId) where.id = Not(excludeShiftId);
    const count = await this.shiftRepo.count({ where });
    return count > 0;
  }

  private windowMatches(
    startTime: string | null | undefined,
    endTime: string | null | undefined,
    shiftStart: Date,
    shiftEnd: Date,
  ) {
    if (!startTime || !endTime) return true;
    const startMinutes = this.minutes(startTime);
    const endMinutes = this.minutes(endTime);
    const shiftStartMinutes = shiftStart.getHours() * 60 + shiftStart.getMinutes();
    const shiftEndMinutes =
      shiftEnd.getHours() * 60 +
      shiftEnd.getMinutes() +
      (this.dateKey(shiftEnd) !== this.dateKey(shiftStart) ? 1440 : 0);
    const normalizedEnd = endMinutes <= startMinutes ? endMinutes + 1440 : endMinutes;
    return shiftStartMinutes >= startMinutes && shiftEndMinutes <= normalizedEnd;
  }

  private ruleEffective(rule: GuardAvailabilityRule, shiftStart: Date) {
    const date = this.dateKey(shiftStart);
    if (rule.effectiveFrom && date < rule.effectiveFrom) return false;
    if (rule.effectiveTo && date > rule.effectiveTo) return false;
    return true;
  }

  private async getCompany(userId: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  private async getCompanyGuardIds(companyId: number) {
    const rows = await this.companyGuardRepo.find({ where: { company: { id: companyId } } });
    return rows.map((row) => row.guard.id);
  }

  private async ensureCompanyGuard(companyId: number, guardId: number) {
    const relation = await this.companyGuardRepo.findOne({
      where: { company: { id: companyId }, guard: { id: guardId } },
    });
    if (!relation) throw new ForbiddenException('Guard does not belong to this company.');
    return relation;
  }

  private dateKey(value: Date) {
    return value.toISOString().slice(0, 10);
  }

  private minutes(value: string) {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  }
}
