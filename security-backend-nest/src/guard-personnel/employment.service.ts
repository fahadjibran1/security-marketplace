import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { CompanyGuard, CompanyGuardStatus } from '../company-guard/entities/company-guard.entity';
import { User } from '../user/entities/user.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EncryptionService } from './encryption.service';
import {
  CompanyGuardEmployment,
  GuardJobRole,
} from './entities/company-guard-employment.entity';
import { UpdateCompanyGuardEmploymentDto } from './dto/update-company-guard-employment.dto';
import { EmploymentGuardResponseDto } from './dto/employment-guard-response.dto';
import { EmploymentCompanyResponseDto } from './dto/employment-company-response.dto';
import { EmploymentCompanyStaffResponseDto } from './dto/employment-company-staff-response.dto';
import { EmploymentAdminResponseDto } from './dto/employment-admin-response.dto';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

@Injectable()
export class EmploymentService {
  constructor(
    @InjectRepository(GuardProfile)
    private readonly guardRepo: Repository<GuardProfile>,
    @InjectRepository(CompanyGuardEmployment)
    private readonly employmentRepo: Repository<CompanyGuardEmployment>,
    @InjectRepository(CompanyGuard)
    private readonly companyGuardRepo: Repository<CompanyGuard>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly encryptionService: EncryptionService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ── Guard self-service (read-only list across all companies) ─────────────────

  async getEmploymentsForGuard(userId: number): Promise<EmploymentGuardResponseDto[]> {
    const guard = await this.requireGuardByUserId(userId);
    const records = await this.employmentRepo
      .createQueryBuilder('emp')
      .leftJoinAndSelect('emp.companyGuard', 'cg')
      .leftJoinAndSelect('cg.company', 'company')
      .leftJoinAndSelect('cg.guard', 'guard')
      .where('guard.id = :guardId', { guardId: guard.id })
      .orderBy('emp.startDate', 'DESC')
      .getMany();
    return records.map((r) => this.toGuardDto(guard.id, r));
  }

  // ── Company: create / update employment for an owned guard ──────────────────

  async getEmploymentForCompany(
    companyUserId: number,
    guardId: number,
    meta: RequestMeta,
  ): Promise<EmploymentCompanyResponseDto | null> {
    const { companyId, companyGuard } = await this.requireOwnedRelationship(companyUserId, guardId);
    const record = await this.findWithSensitive(companyGuard.id);
    if (!record) return null;
    await this.auditLogService.log({
      user: { id: companyUserId },
      action: 'guard_personnel.employment_view_sensitive',
      entityType: 'company_guard_employment',
      entityId: record.id,
      afterData: { companyGuardId: companyGuard.id, guardId, companyId },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.toCompanyDto(companyId, guardId, record);
  }

  async upsertEmploymentForCompany(
    companyUserId: number,
    guardId: number,
    dto: UpdateCompanyGuardEmploymentDto,
    meta: RequestMeta,
  ): Promise<EmploymentCompanyResponseDto> {
    const { companyId, companyGuard } = await this.requireOwnedRelationship(companyUserId, guardId);
    const existing = await this.findWithSensitive(companyGuard.id);
    const isCreating = !existing;

    if (isCreating && companyGuard.status !== CompanyGuardStatus.ACTIVE) {
      throw new ForbiddenException(
        'Employment records can only be created while the guard relationship is active',
      );
    }

    if (isCreating) {
      const missing: string[] = [];
      if (!dto.engagementType) missing.push('engagementType');
      if (!dto.jobRole) missing.push('jobRole');
      if (!dto.workingArrangement) missing.push('workingArrangement');
      if (!dto.startDate) missing.push('startDate');
      if (!dto.payBasis) missing.push('payBasis');
      if (missing.length > 0) {
        throw new BadRequestException(
          `Required fields missing for first-time setup: ${missing.join(', ')}`,
        );
      }
    }

    const record = existing ?? this.employmentRepo.create({ companyGuard, companyGuardId: companyGuard.id });
    const changedFields: string[] = [];

    if (dto.engagementType !== undefined && dto.engagementType !== record.engagementType) {
      record.engagementType = dto.engagementType;
      changedFields.push('engagementType');
    }

    if (dto.jobRole !== undefined && dto.jobRole !== record.jobRole) {
      record.jobRole = dto.jobRole;
      changedFields.push('jobRole');
    }

    if (dto.customRole !== undefined) {
      if (dto.customRole === null) {
        if (record.customRole != null) {
          record.customRole = null;
          changedFields.push('customRole');
        }
      } else {
        const trimmed = dto.customRole.trim() || null;
        if (record.customRole !== trimmed) {
          record.customRole = trimmed;
          changedFields.push('customRole');
        }
      }
    }

    // Clear customRole when jobRole is no longer OTHER.
    if (record.jobRole !== GuardJobRole.OTHER && record.customRole != null) {
      record.customRole = null;
    }

    if (dto.workingArrangement !== undefined && dto.workingArrangement !== record.workingArrangement) {
      record.workingArrangement = dto.workingArrangement;
      changedFields.push('workingArrangement');
    }

    if (dto.startDate !== undefined && dto.startDate !== record.startDate) {
      record.startDate = dto.startDate;
      changedFields.push('startDate');
    }

    if (dto.endDate !== undefined) {
      if (dto.endDate === null) {
        if (record.endDate != null) {
          record.endDate = null;
          changedFields.push('endDate');
        }
      } else if (dto.endDate !== record.endDate) {
        record.endDate = dto.endDate;
        changedFields.push('endDate');
      }
    }

    if (dto.payBasis !== undefined && dto.payBasis !== record.payBasis) {
      record.payBasis = dto.payBasis;
      changedFields.push('payBasis');
    }

    if (dto.noticePeriodDays !== undefined) {
      if (dto.noticePeriodDays === null) {
        if (record.noticePeriodDays != null) {
          record.noticePeriodDays = null;
          changedFields.push('noticePeriodDays');
        }
      } else if (dto.noticePeriodDays !== record.noticePeriodDays) {
        record.noticePeriodDays = dto.noticePeriodDays;
        changedFields.push('noticePeriodDays');
      }
    }

    if (dto.internalNote !== undefined) {
      if (dto.internalNote === null) {
        if (record.internalNoteEnc != null) {
          record.internalNoteEnc = null;
          changedFields.push('internalNote');
        }
      } else {
        const trimmed = dto.internalNote.trim();
        const existing = record.internalNoteEnc ? this.encryptionService.decrypt(record.internalNoteEnc) : null;
        if (existing !== (trimmed || null)) {
          record.internalNoteEnc = trimmed ? this.encryptionService.encrypt(trimmed) : null;
          changedFields.push('internalNote');
        }
      }
    }

    this.validateDateRange(record.startDate, record.endDate ?? null);

    const saved = await this.employmentRepo.save(record);

    if (changedFields.length > 0 || isCreating) {
      await this.auditLogService.log({
        user: { id: companyUserId },
        action: isCreating
          ? 'guard_personnel.employment_create'
          : 'guard_personnel.employment_update',
        entityType: 'company_guard_employment',
        entityId: saved.id,
        afterData: {
          companyGuardId: saved.companyGuardId,
          guardId,
          companyId,
          changedFields,
        },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
    }

    const refreshed = await this.findWithSensitive(companyGuard.id);
    return this.toCompanyDto(companyId, guardId, refreshed!);
  }

  // ── Company Staff: read-only summary (no internalNote) ───────────────────────

  async getEmploymentForCompanyStaff(
    companyUserId: number,
    guardId: number,
  ): Promise<EmploymentCompanyStaffResponseDto | null> {
    const { companyGuard } = await this.requireOwnedActiveRelationship(companyUserId, guardId);
    const record = await this.employmentRepo.findOne({
      where: { companyGuardId: companyGuard.id },
    });
    if (!record) return null;
    return this.toCompanyStaffDto(guardId, record);
  }

  // ── Platform Admin ───────────────────────────────────────────────────────────

  async getEmploymentsForAdmin(
    adminUserId: number,
    guardId: number,
    meta: RequestMeta,
  ): Promise<EmploymentAdminResponseDto[]> {
    await this.requireGuardById(guardId);
    const records = await this.employmentRepo
      .createQueryBuilder('emp')
      .addSelect('emp.internalNoteEnc')
      .leftJoinAndSelect('emp.companyGuard', 'cg')
      .leftJoinAndSelect('cg.company', 'company')
      .leftJoinAndSelect('cg.guard', 'guard')
      .where('guard.id = :guardId', { guardId })
      .orderBy('emp.startDate', 'DESC')
      .getMany();

    await this.auditLogService.log({
      user: { id: adminUserId },
      action: 'guard_personnel.employment_view_sensitive',
      entityType: 'company_guard_employment',
      entityId: null,
      afterData: { guardId, requestedBy: 'admin', recordCount: records.length },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return records.map((r) => this.toAdminDto(guardId, r));
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async requireGuardByUserId(userId: number): Promise<GuardProfile> {
    const guard = await this.guardRepo.findOne({ where: { user: { id: userId } } });
    if (!guard) throw new NotFoundException('Guard profile not found');
    return guard;
  }

  private async requireGuardById(guardId: number): Promise<GuardProfile> {
    const guard = await this.guardRepo.findOne({ where: { id: guardId } });
    if (!guard) throw new NotFoundException('Guard profile not found');
    return guard;
  }

  private async requireCompanyIdForUser(userId: number): Promise<number> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['companyProfile'],
    });
    const companyId = user?.companyProfile?.id;
    if (!companyId) throw new ForbiddenException('No company profile associated with this account');
    return companyId;
  }

  // Verifies tenant ownership (Company owns the CompanyGuard) without requiring ACTIVE status.
  // Used for Company/CompanyAdmin GET and PATCH on employment records — employment is HR data
  // that must remain accessible to the owning company after the guard leaves or is blocked.
  private async requireOwnedRelationship(
    companyUserId: number,
    guardId: number,
  ): Promise<{ companyId: number; companyGuard: CompanyGuard }> {
    const companyId = await this.requireCompanyIdForUser(companyUserId);
    const companyGuard = await this.companyGuardRepo.findOne({
      where: {
        company: { id: companyId },
        guard: { id: guardId },
      },
    });
    if (!companyGuard) {
      throw new ForbiddenException('No relationship between this company and guard');
    }
    return { companyId, companyGuard };
  }

  // Verifies ACTIVE status — used for CompanyStaff access where historical records are denied.
  private async requireOwnedActiveRelationship(
    companyUserId: number,
    guardId: number,
  ): Promise<{ companyId: number; companyGuard: CompanyGuard }> {
    const companyId = await this.requireCompanyIdForUser(companyUserId);
    const companyGuard = await this.companyGuardRepo.findOne({
      where: {
        company: { id: companyId },
        guard: { id: guardId },
        status: CompanyGuardStatus.ACTIVE,
      },
    });
    if (!companyGuard) {
      throw new ForbiddenException('No active relationship between this company and guard');
    }
    return { companyId, companyGuard };
  }

  private async findWithSensitive(companyGuardId: number): Promise<CompanyGuardEmployment | null> {
    return this.employmentRepo
      .createQueryBuilder('emp')
      .addSelect('emp.internalNoteEnc')
      .where('emp.companyGuardId = :companyGuardId', { companyGuardId })
      .getOne();
  }

  private validateDateRange(startDate: string | undefined, endDate: string | null): void {
    if (!startDate || !endDate) return;
    if (endDate < startDate) {
      throw new BadRequestException('endDate must not be before startDate');
    }
  }

  private decryptNote(enc: string | null | undefined): string | null {
    if (!enc) return null;
    return this.encryptionService.decrypt(enc);
  }

  private toGuardDto(guardId: number, record: CompanyGuardEmployment): EmploymentGuardResponseDto {
    const cg = record.companyGuard;
    return {
      companyGuardId: record.companyGuardId,
      companyId: cg.company.id,
      companyName: cg.company.name,
      guardId,
      engagementType: record.engagementType,
      jobRole: record.jobRole,
      customRole: record.customRole ?? null,
      workingArrangement: record.workingArrangement,
      startDate: record.startDate,
      endDate: record.endDate ?? null,
      payBasis: record.payBasis,
      noticePeriodDays: record.noticePeriodDays ?? null,
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private toCompanyDto(
    companyId: number,
    guardId: number,
    record: CompanyGuardEmployment,
  ): EmploymentCompanyResponseDto {
    return {
      companyGuardId: record.companyGuardId,
      guardId,
      engagementType: record.engagementType,
      jobRole: record.jobRole,
      customRole: record.customRole ?? null,
      workingArrangement: record.workingArrangement,
      startDate: record.startDate,
      endDate: record.endDate ?? null,
      payBasis: record.payBasis,
      noticePeriodDays: record.noticePeriodDays ?? null,
      internalNote: this.decryptNote(record.internalNoteEnc),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private toCompanyStaffDto(
    guardId: number,
    record: CompanyGuardEmployment,
  ): EmploymentCompanyStaffResponseDto {
    return {
      companyGuardId: record.companyGuardId,
      guardId,
      engagementType: record.engagementType,
      jobRole: record.jobRole,
      customRole: record.customRole ?? null,
      workingArrangement: record.workingArrangement,
      startDate: record.startDate,
      endDate: record.endDate ?? null,
      payBasis: record.payBasis,
      noticePeriodDays: record.noticePeriodDays ?? null,
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private toAdminDto(guardId: number, record: CompanyGuardEmployment): EmploymentAdminResponseDto {
    const cg = record.companyGuard;
    return {
      companyGuardId: record.companyGuardId,
      companyId: cg.company.id,
      companyName: cg.company.name,
      guardId,
      engagementType: record.engagementType,
      jobRole: record.jobRole,
      customRole: record.customRole ?? null,
      workingArrangement: record.workingArrangement,
      startDate: record.startDate,
      endDate: record.endDate ?? null,
      payBasis: record.payBasis,
      noticePeriodDays: record.noticePeriodDays ?? null,
      internalNote: this.decryptNote(record.internalNoteEnc),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
}
