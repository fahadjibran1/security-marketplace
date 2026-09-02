import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EncryptionService } from './encryption.service';
import { UpdateGuardIdentityDto } from './dto/update-guard-identity.dto';
import { GuardIdentityGuardResponseDto } from './dto/guard-identity-guard-response.dto';
import { GuardIdentityAdminResponseDto } from './dto/guard-identity-admin-response.dto';
import { RevealResponseDto } from './dto/reveal-field.dto';

// UK NINO — 2 restricted letters + 6 digits + 1 letter (A-D).
// Certain prefixes are administratively reserved and not issued.
const NINO_INVALID_PREFIXES = new Set(['BG', 'GB', 'NK', 'KN', 'TN', 'NT', 'ZZ']);
const NINO_REGEX = /^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/;

function isValidNino(normalised: string): boolean {
  if (!NINO_REGEX.test(normalised)) return false;
  return !NINO_INVALID_PREFIXES.has(normalised.slice(0, 2));
}

function isValidUtr(normalised: string): boolean {
  return /^\d{10}$/.test(normalised);
}

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

@Injectable()
export class GuardPersonnelService {
  constructor(
    @InjectRepository(GuardProfile)
    private readonly guardRepo: Repository<GuardProfile>,
    private readonly encryptionService: EncryptionService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async getIdentityForGuard(userId: number): Promise<GuardIdentityGuardResponseDto> {
    const guard = await this.findWithSensitiveByUserId(userId);
    return this.toGuardDto(guard);
  }

  async updateIdentityForGuard(
    userId: number,
    dto: UpdateGuardIdentityDto,
    meta: RequestMeta,
  ): Promise<GuardIdentityGuardResponseDto> {
    const guard = await this.findWithSensitiveByUserId(userId);

    const updates: Partial<Pick<GuardProfile, 'ninoEnc' | 'ninoHmac' | 'utrEnc'>> = {};
    const changedFields: string[] = [];

    if (dto.ninoPlaintext !== undefined) {
      const normalised = dto.ninoPlaintext.replace(/\s/g, '').toUpperCase();
      if (!isValidNino(normalised)) {
        throw new BadRequestException(
          'National Insurance number format is not valid. Expected format: AB 12 34 56 C',
        );
      }
      const newHmac = this.encryptionService.hmac(normalised);

      // Uniqueness check via HMAC without decryption
      const conflict = await this.guardRepo
        .createQueryBuilder('g')
        .select('g.id')
        .addSelect('g.ninoHmac')
        .where('g.ninoHmac = :hmac AND g.id != :id', { hmac: newHmac, id: guard.id })
        .getOne();
      if (conflict) {
        throw new ConflictException(
          'This National Insurance number is already registered with another account.',
        );
      }

      // Only update if the NINO is actually changing (HMAC mismatch = different value)
      if (guard.ninoHmac !== newHmac) {
        updates.ninoEnc = this.encryptionService.encrypt(normalised);
        updates.ninoHmac = newHmac;
        changedFields.push('nino');
      }
    }

    if (dto.utrPlaintext !== undefined) {
      const normalised = dto.utrPlaintext.replace(/\s/g, '');
      if (!isValidUtr(normalised)) {
        throw new BadRequestException('Unique Taxpayer Reference must be exactly 10 digits.');
      }
      // Decrypt existing UTR for equality comparison only — result is never logged or returned
      const existingUtr = guard.utrEnc ? this.encryptionService.decrypt(guard.utrEnc) : null;
      if (existingUtr !== normalised) {
        updates.utrEnc = this.encryptionService.encrypt(normalised);
        changedFields.push('utr');
      }
    }

    if (Object.keys(updates).length > 0) {
      await this.guardRepo
        .createQueryBuilder()
        .update(GuardProfile)
        .set(updates)
        .where('id = :id', { id: guard.id })
        .execute();
    }

    // Emit audit event for each identity mutation, listing only field names — no values
    if (changedFields.length > 0) {
      await this.auditLogService.log({
        user: { id: userId },
        action: 'guard_personnel.identity_update',
        entityType: 'guard_profile',
        entityId: guard.id,
        afterData: { changedFields },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
    }

    // Re-fetch with sensitive columns to return accurate masked values
    const updated = await this.findWithSensitiveByUserId(userId);
    return this.toGuardDto(updated);
  }

  async revealForGuard(
    userId: number,
    field: 'nino' | 'utr',
    meta: RequestMeta,
  ): Promise<RevealResponseDto> {
    if (field !== 'nino' && field !== 'utr') {
      throw new BadRequestException('field must be "nino" or "utr"');
    }
    const guard = await this.findWithSensitiveByUserId(userId);

    // Guards revealing their own data is still audited for accountability
    await this.auditLogService.log({
      user: { id: userId },
      action: 'guard_personnel.identity_reveal',
      entityType: 'guard_profile',
      entityId: guard.id,
      afterData: { field, requestedBy: 'self' },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return this.buildRevealResponse(guard, field);
  }

  async getIdentityForAdmin(guardId: number): Promise<GuardIdentityAdminResponseDto> {
    const guard = await this.findWithSensitiveById(guardId);
    return this.toAdminDto(guard);
  }

  async revealForAdmin(
    adminUserId: number,
    guardId: number,
    field: 'nino' | 'utr',
    meta: RequestMeta,
  ): Promise<RevealResponseDto> {
    if (field !== 'nino' && field !== 'utr') {
      throw new BadRequestException('field must be "nino" or "utr"');
    }
    const guard = await this.findWithSensitiveById(guardId);

    await this.auditLogService.log({
      user: { id: adminUserId },
      action: 'guard_personnel.identity_reveal',
      entityType: 'guard_profile',
      entityId: guard.id,
      afterData: { field, requestedBy: 'admin', adminUserId },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return this.buildRevealResponse(guard, field);
  }

  private buildRevealResponse(guard: GuardProfile, field: 'nino' | 'utr'): RevealResponseDto {
    if (field === 'nino') {
      const plaintext = guard.ninoEnc ? this.encryptionService.decrypt(guard.ninoEnc) : null;
      return {
        field: 'nino',
        maskedValue: plaintext ? this.encryptionService.maskNino(plaintext) : null,
        revealedValue: plaintext,
      };
    }
    const plaintext = guard.utrEnc ? this.encryptionService.decrypt(guard.utrEnc) : null;
    return {
      field: 'utr',
      maskedValue: plaintext ? this.encryptionService.maskUtr(plaintext) : null,
      revealedValue: plaintext,
    };
  }

  private toGuardDto(guard: GuardProfile): GuardIdentityGuardResponseDto {
    const ninoPlaintext = guard.ninoEnc ? this.encryptionService.decrypt(guard.ninoEnc) : null;
    const utrPlaintext = guard.utrEnc ? this.encryptionService.decrypt(guard.utrEnc) : null;
    return {
      guardId: guard.id,
      ninoSet: guard.ninoEnc != null,
      ninoMasked: ninoPlaintext ? this.encryptionService.maskNino(ninoPlaintext) : null,
      utrSet: guard.utrEnc != null,
      utrMasked: utrPlaintext ? this.encryptionService.maskUtr(utrPlaintext) : null,
    };
  }

  private toAdminDto(guard: GuardProfile): GuardIdentityAdminResponseDto {
    const ninoPlaintext = guard.ninoEnc ? this.encryptionService.decrypt(guard.ninoEnc) : null;
    const utrPlaintext = guard.utrEnc ? this.encryptionService.decrypt(guard.utrEnc) : null;
    return {
      guardId: guard.id,
      ninoSet: guard.ninoEnc != null,
      ninoMasked: ninoPlaintext ? this.encryptionService.maskNino(ninoPlaintext) : null,
      utrSet: guard.utrEnc != null,
      utrMasked: utrPlaintext ? this.encryptionService.maskUtr(utrPlaintext) : null,
      canReveal: true,
    };
  }

  private async findWithSensitiveByUserId(userId: number): Promise<GuardProfile> {
    // Two-query pattern: first locate by user ID using the standard repo,
    // then re-fetch with select:false columns explicitly added.
    const basic = await this.guardRepo.findOne({ where: { user: { id: userId } } });
    if (!basic) throw new NotFoundException('Guard profile not found');
    return this.findWithSensitiveById(basic.id);
  }

  private async findWithSensitiveById(guardId: number): Promise<GuardProfile> {
    const guard = await this.guardRepo
      .createQueryBuilder('g')
      .addSelect('g.ninoEnc')
      .addSelect('g.ninoHmac')
      .addSelect('g.utrEnc')
      .leftJoinAndSelect('g.user', 'u')
      .where('g.id = :id', { id: guardId })
      .getOne();
    if (!guard) throw new NotFoundException('Guard profile not found');
    return guard;
  }
}
