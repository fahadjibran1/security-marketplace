import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, MoreThan, Repository } from 'typeorm';

import { AuditLogService } from '../audit-log/audit-log.service';
import { CompanyService } from '../company/company.service';
import { CompanyGuard } from '../company-guard/entities/company-guard.entity';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { UpsertGuardLeaveDto } from './dto/upsert-guard-leave.dto';
import { GuardLeave, GuardLeaveStatus } from './entities/guard-leave.entity';

@Injectable()
export class LeaveService {
  constructor(
    @InjectRepository(GuardLeave) private readonly leaveRepo: Repository<GuardLeave>,
    @InjectRepository(CompanyGuard) private readonly companyGuardRepo: Repository<CompanyGuard>,
    private readonly companyService: CompanyService,
    private readonly guardProfileService: GuardProfileService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async listForCompanyUser(userId: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    return this.leaveRepo.find({ where: { company: { id: company.id } }, order: { startAt: 'DESC' } });
  }

  async listForGuardUser(userId: number) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    return this.leaveRepo.find({ where: { guard: { id: guard.id } }, order: { startAt: 'DESC' } });
  }

  async upsertForCompanyUser(userId: number, dto: UpsertGuardLeaveDto) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    if (!dto.guardId) throw new BadRequestException('Guard is required for company leave records.');
    return this.upsert({ companyId: company.id, guardId: dto.guardId, userId, dto, defaultStatus: GuardLeaveStatus.APPROVED });
  }

  async upsertForGuardUser(userId: number, dto: UpsertGuardLeaveDto) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    const relation = await this.companyGuardRepo.findOne({ where: { guard: { id: guard.id } }, order: { createdAt: 'DESC' } });
    const companyId = relation?.company?.id;
    if (!companyId) throw new BadRequestException('Leave requires an existing company relationship.');
    return this.upsert({ companyId, guardId: guard.id, userId, dto, defaultStatus: GuardLeaveStatus.PENDING });
  }

  async hasApprovedLeaveOverlap(companyId: number, guardId: number, startAt: Date, endAt: Date) {
    const count = await this.leaveRepo.count({
      where: {
        company: { id: companyId },
        guard: { id: guardId },
        status: GuardLeaveStatus.APPROVED,
        startAt: LessThan(endAt),
        endAt: MoreThan(startAt),
      },
    });
    return count > 0;
  }

  async listApprovedLeaveOverlaps(companyId: number, guardId: number, startAt: Date, endAt: Date) {
    return this.leaveRepo.find({
      where: {
        company: { id: companyId },
        guard: { id: guardId },
        status: GuardLeaveStatus.APPROVED,
        startAt: LessThan(endAt),
        endAt: MoreThan(startAt),
      },
      order: { startAt: 'ASC' },
    });
  }

  private async upsert(input: {
    companyId: number;
    guardId: number;
    userId: number;
    dto: UpsertGuardLeaveDto;
    defaultStatus: GuardLeaveStatus;
  }) {
    const company = await this.companyService.findOne(input.companyId);
    const guard = await this.guardProfileService.findOne(input.guardId);
    const startAt = new Date(input.dto.startAt);
    const endAt = new Date(input.dto.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) {
      throw new BadRequestException('Leave start and end must be valid and ordered.');
    }
    const existing = input.dto.id
      ? await this.leaveRepo.findOne({ where: { id: input.dto.id, company: { id: company.id }, guard: { id: guard.id } } })
      : null;
    const beforeData = existing ? { ...existing } : null;
    const leave = existing ?? this.leaveRepo.create({ company, guard });
    leave.leaveType = input.dto.leaveType;
    leave.startAt = startAt;
    leave.endAt = endAt;
    leave.reason = input.dto.reason?.trim() || null;
    leave.status = input.dto.status ?? input.defaultStatus;
    const saved = await this.leaveRepo.save(leave);
    await this.auditLogService.log({
      company,
      user: { id: input.userId },
      action: existing ? 'leave.updated' : 'leave.created',
      entityType: 'guard_leave',
      entityId: saved.id,
      beforeData,
      afterData: {
        guardId: guard.id,
        leaveType: saved.leaveType,
        startAt: saved.startAt,
        endAt: saved.endAt,
        status: saved.status,
      },
    });
    return saved;
  }
}
