import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { CompanyGuard, CompanyGuardStatus } from '../company-guard/entities/company-guard.entity';
import { User } from '../user/entities/user.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EncryptionService } from './encryption.service';
import {
  CompanyGuardPayroll,
  GuardPayrollStatus,
} from './entities/company-guard-payroll.entity';
import { CreatePayrollAdminDto } from './dto/create-payroll-admin.dto';
import { UpdatePayrollAdminDto } from './dto/update-payroll-admin.dto';
import { PayrollAdminCompanyResponseDto } from './dto/payroll-admin-company-response.dto';
import { PayrollAdminGuardResponseDto } from './dto/payroll-admin-guard-response.dto';
import { PayrollAdminAdminResponseDto } from './dto/payroll-admin-admin-response.dto';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

@Injectable()
export class PayrollAdminService {
  constructor(
    @InjectRepository(GuardProfile)
    private readonly guardRepo: Repository<GuardProfile>,
    @InjectRepository(CompanyGuardPayroll)
    private readonly payrollRepo: Repository<CompanyGuardPayroll>,
    @InjectRepository(CompanyGuard)
    private readonly companyGuardRepo: Repository<CompanyGuard>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly encryptionService: EncryptionService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ── Company: create record (ACTIVE relationship required) ───────────────────

  async createForCompany(
    companyUserId: number,
    guardId: number,
    dto: CreatePayrollAdminDto,
    meta: RequestMeta,
  ): Promise<PayrollAdminCompanyResponseDto> {
    const { companyId, companyGuard } = await this.requireOwnedActiveRelationship(companyUserId, guardId);

    const existing = await this.payrollRepo.findOne({ where: { companyGuardId: companyGuard.id } });
    if (existing) {
      throw new ConflictException('A payroll administration record already exists for this guard. Use PATCH to update it.');
    }

    const startDate = dto.payrollStartDate ?? null;
    const endDate   = dto.payrollEndDate   ?? null;
    this.validateDateRange(startDate, endDate);

    const record = this.payrollRepo.create({
      companyGuardId: companyGuard.id,
      companyGuard,
      companyId,
      payrollReference:     this.normalizeRef(dto.payrollReference),
      payFrequency:         dto.payFrequency         !== undefined ? (dto.payFrequency         ?? null) : null,
      payrollPaymentMethod: dto.payrollPaymentMethod !== undefined ? (dto.payrollPaymentMethod ?? null) : null,
      payrollStatus:        dto.payrollStatus ?? GuardPayrollStatus.ACTIVE,
      payrollStartDate:     startDate,
      payrollEndDate:       endDate,
      payrollNoteEnc:       dto.payrollNote !== undefined && dto.payrollNote !== null
        ? this.encryptionService.encrypt(dto.payrollNote.trim())
        : null,
    });

    const saved = await this.saveWithUniqueCheck(record);

    await this.auditLogService.log({
      user: { id: companyUserId },
      action: 'guard_personnel.payroll_admin_create',
      entityType: 'company_guard_payroll_records',
      entityId: saved.id,
      afterData: {
        companyGuardId: companyGuard.id,
        guardId,
        companyId,
        payrollReference: record.payrollReference ?? null,
        payFrequency: record.payFrequency ?? null,
        payrollPaymentMethod: record.payrollPaymentMethod ?? null,
        payrollStatus: record.payrollStatus,
        payrollStartDate: record.payrollStartDate ?? null,
        payrollEndDate: record.payrollEndDate ?? null,
      },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    const refreshed = await this.findWithNote(companyGuard.id);
    return this.toCompanyDto(refreshed!, guardId, companyId);
  }

  // ── Company: read record (historical access — any relationship status) ───────

  async getForCompany(
    companyUserId: number,
    guardId: number,
  ): Promise<PayrollAdminCompanyResponseDto | null> {
    const { companyId, companyGuard } = await this.requireOwnedRelationship(companyUserId, guardId);
    const record = await this.findWithNote(companyGuard.id);
    if (!record) return null;
    return this.toCompanyDto(record, guardId, companyId);
  }

  // ── Company: update record (ACTIVE relationship required) ───────────────────

  async updateForCompany(
    companyUserId: number,
    guardId: number,
    dto: UpdatePayrollAdminDto,
    meta: RequestMeta,
  ): Promise<PayrollAdminCompanyResponseDto> {
    const { companyId, companyGuard } = await this.requireOwnedActiveRelationship(companyUserId, guardId);

    const record = await this.findWithNote(companyGuard.id);
    if (!record) {
      throw new NotFoundException(
        'No payroll administration record found for this guard. Use POST to create one.',
      );
    }

    const changedFields: string[] = [];

    if (dto.payrollReference !== undefined) {
      const incoming = this.normalizeRef(dto.payrollReference);
      if (incoming !== record.payrollReference) {
        record.payrollReference = incoming;
        changedFields.push('payrollReference');
      }
    }

    if (dto.payFrequency !== undefined) {
      const incoming = dto.payFrequency ?? null;
      if (incoming !== record.payFrequency) {
        record.payFrequency = incoming;
        changedFields.push('payFrequency');
      }
    }

    if (dto.payrollPaymentMethod !== undefined) {
      const incoming = dto.payrollPaymentMethod ?? null;
      if (incoming !== record.payrollPaymentMethod) {
        record.payrollPaymentMethod = incoming;
        changedFields.push('payrollPaymentMethod');
      }
    }

    const prevStatus = record.payrollStatus;
    if (dto.payrollStatus !== undefined && dto.payrollStatus !== record.payrollStatus) {
      record.payrollStatus = dto.payrollStatus;
      changedFields.push('payrollStatus');
    }

    if (dto.payrollStartDate !== undefined) {
      const incoming = dto.payrollStartDate ?? null;
      if (incoming !== record.payrollStartDate) {
        record.payrollStartDate = incoming;
        changedFields.push('payrollStartDate');
      }
    }

    if (dto.payrollEndDate !== undefined) {
      const incoming = dto.payrollEndDate ?? null;
      if (incoming !== record.payrollEndDate) {
        record.payrollEndDate = incoming;
        changedFields.push('payrollEndDate');
      }
    }

    // Validate date range using the post-update effective values.
    this.validateDateRange(record.payrollStartDate, record.payrollEndDate);

    if (dto.payrollNote !== undefined) {
      const incomingPlain = dto.payrollNote !== null ? dto.payrollNote.trim() : null;
      const existingPlain = record.payrollNoteEnc ? this.encryptionService.decrypt(record.payrollNoteEnc) : null;
      if (incomingPlain !== existingPlain) {
        record.payrollNoteEnc = incomingPlain ? this.encryptionService.encrypt(incomingPlain) : null;
        changedFields.push('payrollNote');
      }
    }

    if (changedFields.length === 0) {
      return this.toCompanyDto(record, guardId, companyId);
    }

    await this.saveWithUniqueCheck(record);

    const statusChanged = changedFields.includes('payrollStatus');
    if (statusChanged) {
      await this.auditLogService.log({
        user: { id: companyUserId },
        action: 'guard_personnel.payroll_admin_status_change',
        entityType: 'company_guard_payroll_records',
        entityId: record.id,
        afterData: { companyGuardId: companyGuard.id, guardId, companyId, oldStatus: prevStatus, newStatus: record.payrollStatus },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
    }

    await this.auditLogService.log({
      user: { id: companyUserId },
      action: 'guard_personnel.payroll_admin_update',
      entityType: 'company_guard_payroll_records',
      entityId: record.id,
      afterData: { companyGuardId: companyGuard.id, guardId, companyId, changedFields },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    const refreshed = await this.findWithNote(companyGuard.id);
    return this.toCompanyDto(refreshed!, guardId, companyId);
  }

  // ── Guard: read own records across all companies ────────────────────────────

  async getForGuard(userId: number): Promise<PayrollAdminGuardResponseDto[]> {
    const guard = await this.requireGuardByUserId(userId);
    const records = await this.payrollRepo
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.companyGuard', 'cg')
      .leftJoinAndSelect('cg.company', 'company')
      .leftJoinAndSelect('cg.guard', 'guard')
      .where('guard.id = :guardId', { guardId: guard.id })
      .orderBy('p.createdAt', 'ASC')
      .getMany();
    return records.map((r) => this.toGuardDto(r, guard.id));
  }

  // ── Admin: read all records for any guard ──────────────────────────────────

  async getForAdmin(guardId: number): Promise<PayrollAdminAdminResponseDto[]> {
    await this.requireGuardById(guardId);
    const records = await this.payrollRepo
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.companyGuard', 'cg')
      .leftJoinAndSelect('cg.company', 'company')
      .leftJoinAndSelect('cg.guard', 'guard')
      .where('guard.id = :guardId', { guardId })
      .orderBy('p.createdAt', 'ASC')
      .getMany();
    return records.map((r) => this.toAdminDto(r, guardId));
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

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

  // Read access — any relationship status (historical access for company).
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

  // Write access — ACTIVE relationship required.
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

  // Loads payrollNoteEnc via explicit addSelect (select: false column).
  private async findWithNote(companyGuardId: number): Promise<CompanyGuardPayroll | null> {
    return this.payrollRepo
      .createQueryBuilder('p')
      .addSelect('p.payrollNoteEnc')
      .where('p.companyGuardId = :companyGuardId', { companyGuardId })
      .getOne();
  }

  // Translates a DB-level unique violation on (companyId, payrollReference) into ConflictException.
  private async saveWithUniqueCheck(record: CompanyGuardPayroll): Promise<CompanyGuardPayroll> {
    try {
      return await this.payrollRepo.save(record);
    } catch (err) {
      if (err instanceof QueryFailedError && (err as any).code === '23505') {
        throw new ConflictException('Payroll reference already in use for this company');
      }
      throw err;
    }
  }

  // Trim whitespace, blank-after-trim → null, normalize to uppercase for case-insensitive uniqueness.
  private normalizeRef(ref: string | null | undefined): string | null {
    if (ref === null || ref === undefined) return null;
    const trimmed = ref.trim().toUpperCase();
    return trimmed.length === 0 ? null : trimmed;
  }

  // Validate that startDate does not come after endDate when both are present.
  private validateDateRange(startDate: string | null | undefined, endDate: string | null | undefined): void {
    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('payrollStartDate must not be after payrollEndDate');
    }
  }

  private decryptNote(enc: string | null | undefined): string | null {
    if (!enc) return null;
    return this.encryptionService.decrypt(enc);
  }

  private toCompanyDto(
    record: CompanyGuardPayroll,
    guardId: number,
    companyId: number,
  ): PayrollAdminCompanyResponseDto {
    return {
      companyGuardId:      record.companyGuardId,
      guardId,
      companyId,
      payrollReference:    record.payrollReference    ?? null,
      payFrequency:        record.payFrequency        ?? null,
      payrollPaymentMethod: record.payrollPaymentMethod ?? null,
      payrollStatus:       record.payrollStatus,
      payrollStartDate:    record.payrollStartDate    ?? null,
      payrollEndDate:      record.payrollEndDate      ?? null,
      payrollNote:         this.decryptNote(record.payrollNoteEnc),
      createdAt:           record.createdAt.toISOString(),
      updatedAt:           record.updatedAt.toISOString(),
    };
  }

  private toGuardDto(record: CompanyGuardPayroll, guardId: number): PayrollAdminGuardResponseDto {
    return {
      companyGuardId: record.companyGuardId,
      guardId,
      companyId:      record.companyId,
      companyName:    record.companyGuard.company.name,
      payFrequency:   record.payFrequency   ?? null,
      payrollStatus:  record.payrollStatus,
      payrollStartDate: record.payrollStartDate ?? null,
      payrollEndDate:   record.payrollEndDate   ?? null,
      updatedAt:      record.updatedAt.toISOString(),
    };
  }

  private toAdminDto(record: CompanyGuardPayroll, guardId: number): PayrollAdminAdminResponseDto {
    return {
      companyGuardId:      record.companyGuardId,
      guardId,
      companyId:           record.companyId,
      companyName:         record.companyGuard.company.name,
      payrollReference:    record.payrollReference    ?? null,
      payFrequency:        record.payFrequency        ?? null,
      payrollPaymentMethod: record.payrollPaymentMethod ?? null,
      payrollStatus:       record.payrollStatus,
      payrollStartDate:    record.payrollStartDate    ?? null,
      payrollEndDate:      record.payrollEndDate      ?? null,
      createdAt:           record.createdAt.toISOString(),
      updatedAt:           record.updatedAt.toISOString(),
    };
  }
}
