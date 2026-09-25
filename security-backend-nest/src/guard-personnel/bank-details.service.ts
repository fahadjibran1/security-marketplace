import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { CompanyGuard, CompanyGuardStatus } from '../company-guard/entities/company-guard.entity';
import { CompanyGuardEmployment } from './entities/company-guard-employment.entity';
import { UserRole } from '../user/entities/user.entity';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EncryptionService } from './encryption.service';
import { GuardBankDetails } from './entities/guard-bank-details.entity';
import { UpdateGuardBankDetailsDto } from './dto/update-guard-bank-details.dto';
import { BankDetailsGuardResponseDto } from './dto/bank-details-guard-response.dto';
import { BankDetailsRevealDto } from './dto/bank-details-reveal.dto';
import { BankDetailsCompanyResponseDto } from './dto/bank-details-company-response.dto';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

function normaliseSortCode(raw: string): string {
  const digits = raw.replace(/[-\s]/g, '');
  if (!/^\d{6}$/.test(digits)) {
    throw new BadRequestException('Sort code must be exactly 6 digits (e.g. 12-34-56 or 123456).');
  }
  return digits;
}

function normaliseAccountNumber(raw: string): string {
  const digits = raw.replace(/\s/g, '');
  if (!/^\d{8}$/.test(digits)) {
    throw new BadRequestException('Account number must be exactly 8 digits.');
  }
  return digits;
}

function normaliseHolderName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new BadRequestException('Account holder name must not be blank.');
  if (trimmed.length > 100) throw new BadRequestException('Account holder name must not exceed 100 characters.');
  return trimmed;
}

function maskSortCode(digits: string): string {
  return `••-••-${digits.slice(4)}`;
}

function maskAccountNumber(digits: string): string {
  return `••••${digits.slice(4)}`;
}

@Injectable()
export class BankDetailsService {
  constructor(
    @InjectRepository(GuardProfile)
    private readonly guardRepo: Repository<GuardProfile>,
    @InjectRepository(GuardBankDetails)
    private readonly bankRepo: Repository<GuardBankDetails>,
    @InjectRepository(CompanyGuard)
    private readonly companyGuardRepo: Repository<CompanyGuard>,
    @InjectRepository(CompanyGuardEmployment)
    private readonly employmentRepo: Repository<CompanyGuardEmployment>,
    private readonly encryptionService: EncryptionService,
    private readonly auditLogService: AuditLogService,
    private readonly membershipService: CompanyMembershipService,
  ) {}

  // ── Guard self-service ──────────────────────────────────────────────────────

  async getBankDetailsForGuard(userId: number): Promise<BankDetailsGuardResponseDto> {
    const guard = await this.requireGuardByUserId(userId);
    const record = await this.findWithSensitive(guard.id);
    return this.toGuardDto(guard.id, record);
  }

  async upsertBankDetailsForGuard(
    userId: number,
    dto: UpdateGuardBankDetailsDto,
    meta: RequestMeta,
  ): Promise<BankDetailsGuardResponseDto> {
    const guard = await this.requireGuardByUserId(userId);
    const existing = await this.findWithSensitive(guard.id);
    const isCreating = !existing;

    if (isCreating && (!dto.accountHolderName || !dto.sortCode || !dto.accountNumber)) {
      throw new BadRequestException(
        'All three fields are required to set up bank details: accountHolderName, sortCode, accountNumber.',
      );
    }

    const incomingHolder  = dto.accountHolderName !== undefined ? normaliseHolderName(dto.accountHolderName)     : undefined;
    const incomingSort    = dto.sortCode          !== undefined ? normaliseSortCode(dto.sortCode)                 : undefined;
    const incomingAccount = dto.accountNumber     !== undefined ? normaliseAccountNumber(dto.accountNumber)       : undefined;

    const existingHolder  = existing?.accountHolderNameEnc ? this.encryptionService.decrypt(existing.accountHolderNameEnc) : null;
    const existingSort    = existing?.sortCodeEnc           ? this.encryptionService.decrypt(existing.sortCodeEnc)           : null;
    const existingAccount = existing?.accountNumberEnc      ? this.encryptionService.decrypt(existing.accountNumberEnc)      : null;

    const effectiveHolder  = incomingHolder  !== undefined ? incomingHolder  : existingHolder;
    const effectiveSort    = incomingSort    !== undefined ? incomingSort    : existingSort;
    const effectiveAccount = incomingAccount !== undefined ? incomingAccount : existingAccount;

    if (!effectiveHolder || !effectiveSort || !effectiveAccount) {
      throw new BadRequestException(
        'Bank details must remain complete. Provide all three fields or use DELETE to remove the record.',
      );
    }

    if (!isCreating) {
      const holderChanges  = incomingHolder  !== undefined && incomingHolder  !== existingHolder;
      const sortChanges    = incomingSort    !== undefined && incomingSort    !== existingSort;
      const accountChanges = incomingAccount !== undefined && incomingAccount !== existingAccount;
      const anyChange = holderChanges || sortChanges || accountChanges;

      if (anyChange && !dto.confirmReplace) {
        throw new ConflictException('Changing bank details requires confirmReplace: true.');
      }

      if (!anyChange) {
        return this.toGuardDto(guard.id, existing);
      }
    }

    const changedFields: string[] = [];
    const record = existing ?? this.bankRepo.create({ guardId: guard.id, guard });

    if (effectiveHolder !== existingHolder) {
      record.accountHolderNameEnc = this.encryptionService.encrypt(effectiveHolder);
      changedFields.push('accountHolderName');
    }
    if (effectiveSort !== existingSort) {
      record.sortCodeEnc = this.encryptionService.encrypt(effectiveSort);
      changedFields.push('sortCode');
    }
    if (effectiveAccount !== existingAccount) {
      record.accountNumberEnc = this.encryptionService.encrypt(effectiveAccount);
      changedFields.push('accountNumber');
    }

    const saved = await this.bankRepo.save(record);

    await this.auditLogService.log({
      user: { id: userId },
      action: isCreating ? 'guard_personnel.bank_details_create' : 'guard_personnel.bank_details_update',
      entityType: 'guard_bank_details',
      entityId: saved.id,
      afterData: { guardId: guard.id, changedFields },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    const refreshed = await this.findWithSensitive(guard.id);
    return this.toGuardDto(guard.id, refreshed);
  }

  async revealBankDetailsForGuard(userId: number, meta: RequestMeta): Promise<BankDetailsRevealDto> {
    const guard = await this.requireGuardByUserId(userId);
    const record = await this.findWithSensitive(guard.id);

    await this.auditLogService.log({
      user: { id: userId },
      action: 'guard_personnel.bank_details_reveal',
      entityType: 'guard_bank_details',
      entityId: record?.id ?? null,
      afterData: { guardId: guard.id, requestedBy: 'self' },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return this.toRevealDto(guard.id, record);
  }

  async deleteBankDetailsForGuard(userId: number, meta: RequestMeta): Promise<void> {
    const guard = await this.requireGuardByUserId(userId);
    const record = await this.findWithSensitive(guard.id);

    if (!record) return;

    await this.bankRepo.remove(record);

    await this.auditLogService.log({
      user: { id: userId },
      action: 'guard_personnel.bank_details_remove',
      entityType: 'guard_bank_details',
      entityId: null,
      afterData: { guardId: guard.id, action: 'cleared' },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  // ── Company masked access (ACTIVE relationship required) ────────────────────
  // accountHolderName is never exposed to Company — not even masked.

  /**
   * Masked, and only for a Guard this Company has actually engaged.
   *
   * An ACTIVE relationship alone is no longer enough. Under the marketplace model a Guard may be in
   * several Companies' workforces at once, and a Company that has merely accepted someone has no
   * payment reason to see their bank record — not even the last four digits. The employment record
   * for this specific relationship is that reason, so it is required here. It is existing state, not
   * a new flag: the Company creates it when it sets the Guard's engagement terms.
   */
  async getBankDetailsForCompany(
    companyUserId: number,
    companyUserRole: UserRole,
    guardId: number,
  ): Promise<BankDetailsCompanyResponseDto> {
    const companyId = await this.requireCompanyIdForUser(companyUserId, companyUserRole);
    const relationship = await this.requireOwnedActiveRelationship(companyId, guardId);
    await this.requireEngagement(relationship.id);

    const record = await this.findWithSensitive(guardId);
    const bankSet = this.isBankSet(record);
    const sort    = record?.sortCodeEnc    ? this.encryptionService.decrypt(record.sortCodeEnc)    : null;
    const acct    = record?.accountNumberEnc ? this.encryptionService.decrypt(record.accountNumberEnc) : null;

    return {
      guardId,
      bankSet,
      sortCodeMasked:      sort ? maskSortCode(sort)      : null,
      accountNumberMasked: acct ? maskAccountNumber(acct) : null,
      updatedAt: record?.updatedAt?.toISOString() ?? null,
    };
  }

  // ── Admin masked access (P1G-A: no reveal for admin) ───────────────────────

  async getBankDetailsForAdmin(guardId: number): Promise<BankDetailsGuardResponseDto> {
    const guard = await this.requireGuardById(guardId);
    const record = await this.findWithSensitive(guard.id);
    return this.toGuardDto(guard.id, record);
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

  /**
   * Resolved through the membership matrix, so a permitted finance staff member can read and an
   * unpermitted one cannot. The previous lookup read the owned company straight off the user record,
   * which answered only for the account owning the Company row and skipped personnel_bank.view.
   */
  private async requireCompanyIdForUser(userId: number, userRole: UserRole): Promise<number> {
    const { company } = await this.membershipService.resolveCompanyContext(
      userId, userRole, CompanyPermission.PERSONNEL_BANK_VIEW,
    );
    return company.id;
  }

  private async requireOwnedActiveRelationship(companyId: number, guardId: number): Promise<CompanyGuard> {
    const relation = await this.companyGuardRepo.findOne({
      where: {
        company: { id: companyId },
        guard: { id: guardId },
        status: CompanyGuardStatus.ACTIVE,
      },
    });
    if (!relation) {
      throw new ForbiddenException('No active relationship between this company and guard');
    }
    return relation;
  }

  private async requireEngagement(companyGuardId: number): Promise<void> {
    const employment = await this.employmentRepo.findOne({
      where: { companyGuard: { id: companyGuardId } },
    });
    if (!employment) {
      throw new ForbiddenException(
        'Bank details require an employment record for this guard at this company',
      );
    }
  }

  private async findWithSensitive(guardId: number): Promise<GuardBankDetails | null> {
    return this.bankRepo
      .createQueryBuilder('b')
      .addSelect('b.accountHolderNameEnc')
      .addSelect('b.sortCodeEnc')
      .addSelect('b.accountNumberEnc')
      .where('b.guardId = :guardId', { guardId })
      .getOne();
  }

  private isBankSet(record: GuardBankDetails | null): boolean {
    return !!(record?.sortCodeEnc && record?.accountNumberEnc && record?.accountHolderNameEnc);
  }

  private toGuardDto(guardId: number, record: GuardBankDetails | null): BankDetailsGuardResponseDto {
    const bankSet = this.isBankSet(record);
    const sort    = record?.sortCodeEnc    ? this.encryptionService.decrypt(record.sortCodeEnc)    : null;
    const acct    = record?.accountNumberEnc ? this.encryptionService.decrypt(record.accountNumberEnc) : null;
    return {
      guardId,
      bankSet,
      accountHolderNameMasked: bankSet ? '••••••' : null,
      sortCodeMasked:           sort    ? maskSortCode(sort)      : null,
      accountNumberMasked:      acct    ? maskAccountNumber(acct) : null,
      updatedAt: record?.updatedAt?.toISOString() ?? null,
    };
  }

  private toRevealDto(guardId: number, record: GuardBankDetails | null): BankDetailsRevealDto {
    return {
      guardId,
      accountHolderName: record?.accountHolderNameEnc ? this.encryptionService.decrypt(record.accountHolderNameEnc) : null,
      sortCode:           record?.sortCodeEnc          ? this.encryptionService.decrypt(record.sortCodeEnc)          : null,
      accountNumber:      record?.accountNumberEnc     ? this.encryptionService.decrypt(record.accountNumberEnc)     : null,
    };
  }
}
