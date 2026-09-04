import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import {
  GuardEmergencyContact,
  EmergencyContactRelationship,
} from './entities/guard-emergency-contact.entity';
import { CompanyGuard, CompanyGuardStatus } from '../company-guard/entities/company-guard.entity';
import { User } from '../user/entities/user.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EncryptionService } from './encryption.service';
import { UpdateEmergencyContactDto, PHONE_PATTERN } from './dto/update-emergency-contact.dto';
import { EmergencyContactGuardResponseDto } from './dto/emergency-contact-guard-response.dto';
import { EmergencyContactAdminResponseDto } from './dto/emergency-contact-admin-response.dto';
import { EmergencyContactCompanyResponseDto } from './dto/emergency-contact-company-response.dto';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

function normalisePhone(raw: string): string {
  // Trim whitespace only — do not silently rewrite the number.
  return raw.trim();
}

function validatePhone(value: string, fieldName: string): string {
  const normalised = normalisePhone(value);
  if (!PHONE_PATTERN.test(normalised)) {
    throw new BadRequestException(
      `${fieldName}: must be 7–20 characters and contain only digits, spaces, hyphens, dots, or parentheses.`,
    );
  }
  return normalised;
}

@Injectable()
export class EmergencyContactService {
  constructor(
    @InjectRepository(GuardProfile)
    private readonly guardRepo: Repository<GuardProfile>,
    @InjectRepository(GuardEmergencyContact)
    private readonly ecRepo: Repository<GuardEmergencyContact>,
    @InjectRepository(CompanyGuard)
    private readonly companyGuardRepo: Repository<CompanyGuard>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly encryptionService: EncryptionService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ── Guard self-service ──────────────────────────────────────────────────────

  async getEmergencyContactForGuard(
    userId: number,
  ): Promise<EmergencyContactGuardResponseDto | null> {
    const guard = await this.requireGuardByUserId(userId);
    const record = await this.findWithSensitive(guard.id);
    if (!record) return null;
    return this.toGuardDto(guard.id, record);
  }

  async upsertEmergencyContactForGuard(
    userId: number,
    dto: UpdateEmergencyContactDto,
    meta: RequestMeta,
  ): Promise<EmergencyContactGuardResponseDto> {
    const guard = await this.requireGuardByUserId(userId);
    const existing = await this.findWithSensitive(guard.id);

    const isCreating = !existing;

    // On creation all required fields must be present.
    if (isCreating) {
      const missing: string[] = [];
      if (!dto.contactName) missing.push('contactName');
      if (!dto.relationship) missing.push('relationship');
      if (!dto.primaryPhone) missing.push('primaryPhone');
      if (missing.length > 0) {
        throw new BadRequestException(
          `Required fields missing for first-time setup: ${missing.join(', ')}`,
        );
      }
    }

    const record = existing ?? this.ecRepo.create({ guard });
    const changedFields: string[] = [];

    if (dto.contactName !== undefined) {
      const plaintext = dto.contactName.trim();
      if (plaintext.length < 1 || plaintext.length > 100) {
        throw new BadRequestException('Contact name must be between 1 and 100 characters.');
      }
      const newEnc = this.encryptionService.encrypt(plaintext);
      // Detect change by decrypting existing only when needed
      const existingPlaintext = record.contactNameEnc
        ? this.encryptionService.decrypt(record.contactNameEnc)
        : null;
      if (existingPlaintext !== plaintext) {
        record.contactNameEnc = newEnc;
        changedFields.push('contactName');
      }
    }

    if (dto.relationship !== undefined && dto.relationship !== record.relationship) {
      record.relationship = dto.relationship;
      changedFields.push('relationship');
    }

    if (dto.customRelationship !== undefined) {
      const val = dto.customRelationship?.trim() ?? null;
      if (val !== (record.customRelationship ?? null)) {
        record.customRelationship = val;
        changedFields.push('customRelationship');
      }
    }

    if (dto.primaryPhone !== undefined) {
      const normalised = validatePhone(dto.primaryPhone, 'primaryPhone');
      const existingPlaintext = record.primaryPhoneEnc
        ? this.encryptionService.decrypt(record.primaryPhoneEnc)
        : null;
      if (existingPlaintext !== normalised) {
        record.primaryPhoneEnc = this.encryptionService.encrypt(normalised);
        changedFields.push('primaryPhone');
      }
    }

    if (dto.alternatePhone !== undefined) {
      if (dto.alternatePhone === null) {
        if (record.alternatePhoneEnc != null) {
          record.alternatePhoneEnc = null;
          changedFields.push('alternatePhone');
        }
      } else {
        const normalised = validatePhone(dto.alternatePhone, 'alternatePhone');
        const existingPlaintext = record.alternatePhoneEnc
          ? this.encryptionService.decrypt(record.alternatePhoneEnc)
          : null;
        if (existingPlaintext !== normalised) {
          record.alternatePhoneEnc = this.encryptionService.encrypt(normalised);
          changedFields.push('alternatePhone');
        }
      }
    }

    // Clear customRelationship when relationship is no longer OTHER
    if (
      record.relationship !== EmergencyContactRelationship.OTHER &&
      record.customRelationship != null
    ) {
      record.customRelationship = null;
    }

    const saved = await this.ecRepo.save(record);

    if (changedFields.length > 0 || isCreating) {
      await this.auditLogService.log({
        user: { id: userId },
        action: 'guard_personnel.emergency_contact_update',
        entityType: 'guard_emergency_contact',
        entityId: saved.id,
        afterData: { changedFields },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
    }

    const refreshed = await this.findWithSensitive(guard.id);
    return this.toGuardDto(guard.id, refreshed!);
  }

  async removeEmergencyContactForGuard(userId: number, meta: RequestMeta): Promise<void> {
    const guard = await this.requireGuardByUserId(userId);
    const record = await this.ecRepo.findOne({ where: { guard: { id: guard.id } } });
    if (!record) throw new NotFoundException('No emergency contact to remove');

    await this.ecRepo.remove(record);

    await this.auditLogService.log({
      user: { id: userId },
      action: 'guard_personnel.emergency_contact_remove',
      entityType: 'guard_emergency_contact',
      entityId: record.id,
      afterData: { removed: true },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  // ── Platform Admin ──────────────────────────────────────────────────────────

  async getEmergencyContactForAdmin(
    adminUserId: number,
    guardId: number,
    meta: RequestMeta,
  ): Promise<EmergencyContactAdminResponseDto | null> {
    await this.requireGuardById(guardId);
    const record = await this.findWithSensitive(guardId);

    // Audit the read — admin accessing third-party personal data warrants a log entry.
    await this.auditLogService.log({
      user: { id: adminUserId },
      action: 'guard_personnel.emergency_contact_view',
      entityType: 'guard_emergency_contact',
      entityId: record?.id ?? null,
      afterData: { guardId, requestedBy: 'admin' },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    if (!record) return null;
    return this.toAdminDto(guardId, record);
  }

  // ── Company operational view ────────────────────────────────────────────────

  async getEmergencyContactForCompany(
    companyUserId: number,
    guardId: number,
    meta: RequestMeta,
  ): Promise<EmergencyContactCompanyResponseDto | null> {
    const companyId = await this.requireCompanyIdForUser(companyUserId);
    await this.requireActiveCompanyGuardRelationship(companyId, guardId);
    await this.requireGuardById(guardId);

    const record = await this.findWithSensitive(guardId);

    // Audit: company accessing third-party PII for an active guard.
    // No phone values in metadata — only IDs.
    await this.auditLogService.log({
      user: { id: companyUserId },
      action: 'guard_personnel.emergency_contact_view',
      entityType: 'guard_emergency_contact',
      entityId: record?.id ?? null,
      afterData: { guardId, companyId, requestedBy: 'company' },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    if (!record) return null;
    return this.toCompanyDto(guardId, record);
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

  private async findWithSensitive(guardId: number): Promise<GuardEmergencyContact | null> {
    return this.ecRepo
      .createQueryBuilder('ec')
      .addSelect('ec.contactNameEnc')
      .addSelect('ec.primaryPhoneEnc')
      .addSelect('ec.alternatePhoneEnc')
      .where('ec.guard = :guardId', { guardId })
      .getOne();
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

  private async requireActiveCompanyGuardRelationship(
    companyId: number,
    guardId: number,
  ): Promise<void> {
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
  }

  private decrypt(enc: string | null | undefined): string | null {
    if (!enc) return null;
    return this.encryptionService.decrypt(enc);
  }

  private toGuardDto(
    guardId: number,
    record: GuardEmergencyContact,
  ): EmergencyContactGuardResponseDto {
    return {
      guardId,
      contactName: this.encryptionService.decrypt(record.contactNameEnc),
      relationship: record.relationship,
      customRelationship: record.customRelationship ?? null,
      primaryPhone: this.encryptionService.decrypt(record.primaryPhoneEnc),
      alternatePhone: this.decrypt(record.alternatePhoneEnc),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private toAdminDto(
    guardId: number,
    record: GuardEmergencyContact,
  ): EmergencyContactAdminResponseDto {
    return {
      guardId,
      contactName: this.encryptionService.decrypt(record.contactNameEnc),
      relationship: record.relationship,
      customRelationship: record.customRelationship ?? null,
      primaryPhone: this.encryptionService.decrypt(record.primaryPhoneEnc),
      alternatePhone: this.decrypt(record.alternatePhoneEnc),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private toCompanyDto(
    guardId: number,
    record: GuardEmergencyContact,
  ): EmergencyContactCompanyResponseDto {
    return {
      guardId,
      contactName: this.encryptionService.decrypt(record.contactNameEnc),
      relationship: record.relationship,
      customRelationship: record.customRelationship ?? null,
      primaryPhone: this.encryptionService.decrypt(record.primaryPhoneEnc),
      alternatePhone: this.decrypt(record.alternatePhoneEnc),
    };
  }
}
