import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, LessThan, MoreThan, Repository } from 'typeorm';

import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CompanyService } from '../company/company.service';
import { CompanyGuard } from '../company-guard/entities/company-guard.entity';
import {
  GuardRelationshipAccess,
  relationshipStatusesFor,
  requireGuardRelationship,
} from '../company-guard/relationship-access';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { UserRole } from '../user/entities/user.entity';
import { UpsertGuardLeaveDto } from './dto/upsert-guard-leave.dto';
import { GuardLeave, GuardLeaveStatus } from './entities/guard-leave.entity';

/** Stable codes for guard leave requests the guard app can act on (SEC-001B 2B). */
export const LEAVE_COMPANY_REQUIRED = 'LEAVE_COMPANY_REQUIRED';
export const LEAVE_NO_ACTIVE_EMPLOYER = 'LEAVE_NO_ACTIVE_EMPLOYER';

/** The single refusal for guard leave outside the guard's scope, whatever the reason, so none is distinguishable. */
const outsideScope = () => new ForbiddenException('Leave record is outside the permitted scope.');
/** The refusal these routes gave every non-owner before membership resolution; unchanged so clients see no new shape. */
const companyNotFound = () => new NotFoundException('Company not found');

@Injectable()
export class LeaveService {
  constructor(
    @InjectRepository(GuardLeave) private readonly leaveRepo: Repository<GuardLeave>,
    @InjectRepository(CompanyGuard) private readonly companyGuardRepo: Repository<CompanyGuard>,
    private readonly companyService: CompanyService,
    private readonly guardProfileService: GuardProfileService,
    private readonly auditLogService: AuditLogService,
    private readonly membershipService: CompanyMembershipService,
  ) {}

  /**
   * The company's leave records, including those of former guards (history). Leave reasons are HR information:
   * this route stays owner-only, as it was before membership resolution (SEC-001B 2B).
   */
  async listForCompanyUser(userId: number, userRole: UserRole) {
    const { company } = await this.membershipService.resolveOwnerCompanyContext(userId, userRole, companyNotFound);
    return this.leaveRepo.find({ where: { company: { id: company.id } }, order: { startAt: 'DESC' } });
  }

  async listForGuardUser(userId: number) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    return this.leaveRepo.find({ where: { guard: { id: guard.id } }, order: { startAt: 'DESC' } });
  }

  /** The companies the guard can currently send leave to: their ACTIVE employers only. */
  async listLeaveCompaniesForGuardUser(userId: number) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    const links = await this.activeEmployerLinks(guard.id);
    return links
      .map((link) => ({ companyId: link.company.id, name: link.company.name }))
      .sort((a, b) => a.companyId - b.companyId);
  }

  async upsertForCompanyUser(userId: number, userRole: UserRole, dto: UpsertGuardLeaveDto) {
    const { company } = await this.membershipService.resolveOwnerCompanyContext(userId, userRole, companyNotFound);
    if (!dto.guardId) throw new BadRequestException('Guard is required for company leave records.');

    // Creating or changing leave is a write: ACTIVE relationship only (SEC-001B 2A). A former employer keeps reading
    // the leave it recorded (listForCompanyUser) but cannot add or edit it; every refusal looks the same.
    await requireGuardRelationship(
      this.companyGuardRepo, company.id, dto.guardId, GuardRelationshipAccess.WRITE,
      () => new ForbiddenException('Guard does not belong to the current company.'),
    );

    // A company's leave always belongs to its resolved company; a companyId in the body is ignored.
    const { companyId: _ignored, ...companyDto } = dto;
    return this.upsert({
      companyId: company.id,
      guardId: dto.guardId,
      userId,
      dto: companyDto,
      defaultStatus: GuardLeaveStatus.APPROVED,
    });
  }

  /**
   * A guard's own leave request (SEC-001B 2B).
   *
   *  - New request: sent to an ACTIVE employer only. With one ACTIVE employer it is chosen automatically (the guard
   *    app's existing behaviour); with several the guard must name one (`companyId`, 400 LEAVE_COMPANY_REQUIRED
   *    otherwise); with none it is refused (400 LEAVE_NO_ACTIVE_EMPLOYER). An INACTIVE, BLOCKED, unrelated or unknown
   *    `companyId` gets one identical 403.
   *  - Edit (`id`): only the guard's own request, still PENDING, that the guard created, at a company that is still
   *    an ACTIVE employer. APPROVED, REJECTED and company-created leave is never changed by the guard. Every refusal
   *    is the same 403 and changes nothing.
   *  - The status is always PENDING: approval belongs to the company.
   */
  async upsertForGuardUser(userId: number, dto: UpsertGuardLeaveDto) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    const activeCompanyIds = new Set((await this.activeEmployerLinks(guard.id)).map((link) => link.company.id));
    const guardDto: UpsertGuardLeaveDto = { ...dto, guardId: guard.id, status: GuardLeaveStatus.PENDING };

    if (dto.id) {
      const existing = await this.leaveRepo.findOne({ where: { id: dto.id, guard: { id: guard.id } } });
      const companyId = existing?.company?.id;
      if (!existing || !companyId || !activeCompanyIds.has(companyId)) throw outsideScope();
      if (dto.companyId !== undefined && dto.companyId !== companyId) throw outsideScope();
      if (existing.status !== GuardLeaveStatus.PENDING) throw outsideScope();
      if (!(await this.wasCreatedBy(existing.id, userId))) throw outsideScope();
      return this.upsert({
        companyId,
        guardId: guard.id,
        userId,
        dto: guardDto,
        defaultStatus: GuardLeaveStatus.PENDING,
        // Re-checked under a row lock, so a decision the company makes meanwhile is never overwritten.
        requirePendingUnderLock: true,
      });
    }

    let companyId: number;
    if (dto.companyId !== undefined) {
      if (!activeCompanyIds.has(dto.companyId)) throw outsideScope();
      companyId = dto.companyId;
    } else if (activeCompanyIds.size === 1) {
      [companyId] = [...activeCompanyIds];
    } else if (activeCompanyIds.size === 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: LEAVE_NO_ACTIVE_EMPLOYER,
        message: 'Leave can only be requested from a company you currently work for.',
      });
    } else {
      throw new BadRequestException({
        statusCode: 400,
        code: LEAVE_COMPANY_REQUIRED,
        message: 'You work for more than one company. Choose the company this leave request is for.',
      });
    }

    return this.upsert({
      companyId,
      guardId: guard.id,
      userId,
      dto: guardDto,
      defaultStatus: GuardLeaveStatus.PENDING,
    });
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

  /** The guard's relationships that allow writing: ACTIVE only. */
  private activeEmployerLinks(guardId: number) {
    const [status] = relationshipStatusesFor(GuardRelationshipAccess.WRITE);
    return this.companyGuardRepo.find({ where: { guard: { id: guardId }, status } });
  }

  /** Whether this user created the leave record, by its creation audit entry (written with the record). */
  private wasCreatedBy(leaveId: number, userId: number) {
    return this.leaveRepo.manager.getRepository(AuditLog).exists({
      where: { action: 'leave.created', entityType: 'guard_leave', entityId: leaveId, user: { id: userId } },
    });
  }

  private async upsert(input: {
    companyId: number;
    guardId: number;
    userId: number;
    dto: UpsertGuardLeaveDto;
    defaultStatus: GuardLeaveStatus;
    requirePendingUnderLock?: boolean;
  }) {
    const company = await this.companyService.findOne(input.companyId);
    const guard = await this.guardProfileService.findOne(input.guardId);
    const startAt = new Date(input.dto.startAt);
    const endAt = new Date(input.dto.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) {
      throw new BadRequestException('Leave start and end must be valid and ordered.');
    }

    // The change and its audit entry commit together: the creation entry is what records who created a request.
    return this.leaveRepo.manager.transaction(async (manager: EntityManager) => {
      const repo = manager.getRepository(GuardLeave);
      if (input.dto.id && input.requirePendingUnderLock) {
        // A query builder loads no eager joins, so FOR UPDATE applies to guard_leave alone.
        const locked = await repo
          .createQueryBuilder('leave')
          .setLock('pessimistic_write')
          .where('leave.id = :id', { id: input.dto.id })
          .getOne();
        if (!locked || locked.status !== GuardLeaveStatus.PENDING) throw outsideScope();
      }
      const existing = input.dto.id
        ? await repo.findOne({
            where: {
              id: input.dto.id,
              company: { id: company.id },
              guard: { id: guard.id },
            },
          })
        : null;
      if (input.dto.id && !existing) {
        throw outsideScope();
      }

      const beforeData = existing ? { ...existing } : null;
      const leave = existing ?? repo.create({ company, guard });
      leave.leaveType = input.dto.leaveType;
      leave.startAt = startAt;
      leave.endAt = endAt;
      leave.reason = input.dto.reason?.trim() || null;
      leave.status = input.dto.status ?? input.defaultStatus;
      const saved = await repo.save(leave);
      await this.auditLogService.logInTransaction(manager, {
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
    });
  }
}
