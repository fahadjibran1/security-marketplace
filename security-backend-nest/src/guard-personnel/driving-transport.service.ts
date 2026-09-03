import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { GuardDrivingProfile, DrivingLicenceStatus } from './entities/guard-driving-profile.entity';
import { CompanyGuard, CompanyGuardStatus } from '../company-guard/entities/company-guard.entity';
import { User } from '../user/entities/user.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EncryptionService } from './encryption.service';
import { UpdateDrivingTransportDto } from './dto/update-driving-transport.dto';
import { DrivingTransportGuardResponseDto } from './dto/driving-transport-guard-response.dto';
import { DrivingTransportAdminResponseDto } from './dto/driving-transport-admin-response.dto';
import { DrivingTransportCompanyResponseDto } from './dto/driving-transport-company-response.dto';

export class DrivingLicenceRevealResponseDto {
  field!: 'licenceNumber';
  maskedValue!: string | null;
  revealedValue!: string | null;
}

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

@Injectable()
export class DrivingTransportService {
  constructor(
    @InjectRepository(GuardProfile)
    private readonly guardRepo: Repository<GuardProfile>,
    @InjectRepository(GuardDrivingProfile)
    private readonly drivingRepo: Repository<GuardDrivingProfile>,
    @InjectRepository(CompanyGuard)
    private readonly companyGuardRepo: Repository<CompanyGuard>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly encryptionService: EncryptionService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ── Guard self-service ──────────────────────────────────────────────────────

  async getDrivingForGuard(userId: number): Promise<DrivingTransportGuardResponseDto> {
    const guard = await this.requireGuardByUserId(userId);
    const profile = await this.findProfileWithEnc(guard.id);
    return this.toGuardDto(guard.id, profile);
  }

  async updateDrivingForGuard(
    userId: number,
    dto: UpdateDrivingTransportDto,
    meta: RequestMeta,
  ): Promise<DrivingTransportGuardResponseDto> {
    const guard = await this.requireGuardByUserId(userId);
    const profile = await this.findOrCreateProfile(guard);

    const changedFields: string[] = [];

    if (dto.licenceStatus !== undefined && dto.licenceStatus !== profile.licenceStatus) {
      profile.licenceStatus = dto.licenceStatus;
      changedFields.push('licenceStatus');
      // Clearing the licence number when status reverts to NONE avoids orphan encrypted data.
      if (dto.licenceStatus === DrivingLicenceStatus.NONE) {
        profile.licenceNumberEnc = null;
        changedFields.push('licenceNumber_cleared');
      }
    }

    if (dto.licenceNumberPlaintext !== undefined) {
      if (profile.licenceStatus === DrivingLicenceStatus.NONE) {
        throw new BadRequestException(
          'A licence number cannot be stored when licence status is NONE. Set licenceStatus first.',
        );
      }
      const plaintext = dto.licenceNumberPlaintext.trim().toUpperCase();
      if (plaintext.length < 2 || plaintext.length > 50) {
        throw new BadRequestException('Licence number must be between 2 and 50 characters.');
      }
      const existing = profile.licenceNumberEnc
        ? this.encryptionService.decrypt(profile.licenceNumberEnc)
        : null;
      if (existing !== plaintext) {
        profile.licenceNumberEnc = this.encryptionService.encrypt(plaintext);
        changedFields.push('licenceNumber');
      }
    }

    if (dto.licenceCategories !== undefined) {
      profile.licenceCategories = dto.licenceCategories;
      changedFields.push('licenceCategories');
    }

    if (dto.licenceExpiryDate !== undefined) {
      profile.licenceExpiryDate = dto.licenceExpiryDate;
      changedFields.push('licenceExpiryDate');
    }

    if (dto.willingToDriveToWork !== undefined) {
      profile.willingToDriveToWork = dto.willingToDriveToWork;
      changedFields.push('willingToDriveToWork');
    }

    if (dto.ownsVehicle !== undefined) {
      profile.ownsVehicle = dto.ownsVehicle;
      changedFields.push('ownsVehicle');
    }

    if (dto.hasVehicleAccess !== undefined) {
      profile.hasVehicleAccess = dto.hasVehicleAccess;
      changedFields.push('hasVehicleAccess');
    }

    if (dto.primaryTravelMethod !== undefined) {
      profile.primaryTravelMethod = dto.primaryTravelMethod;
      changedFields.push('primaryTravelMethod');
    }

    if (dto.maxTravelDistanceMiles !== undefined) {
      profile.maxTravelDistanceMiles = dto.maxTravelDistanceMiles;
      changedFields.push('maxTravelDistanceMiles');
    }

    await this.drivingRepo.save(profile);

    if (changedFields.length > 0) {
      await this.auditLogService.log({
        user: { id: userId },
        action: 'guard_personnel.driving_update',
        entityType: 'guard_driving_profile',
        entityId: profile.id,
        afterData: { changedFields },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
    }

    const refreshed = await this.findProfileWithEnc(guard.id);
    return this.toGuardDto(guard.id, refreshed);
  }

  async revealLicenceForGuard(
    userId: number,
    meta: RequestMeta,
  ): Promise<DrivingLicenceRevealResponseDto> {
    const guard = await this.requireGuardByUserId(userId);
    const profile = await this.findProfileWithEnc(guard.id);

    await this.auditLogService.log({
      user: { id: userId },
      action: 'guard_personnel.driving_licence_reveal',
      entityType: 'guard_driving_profile',
      entityId: profile?.id ?? null,
      afterData: { field: 'licenceNumber', requestedBy: 'self' },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return this.buildLicenceRevealResponse(profile);
  }

  // ── Platform Admin ──────────────────────────────────────────────────────────

  async getDrivingForAdmin(guardId: number): Promise<DrivingTransportAdminResponseDto> {
    const guard = await this.requireGuardById(guardId);
    const profile = await this.findProfileWithEnc(guard.id);
    return this.toAdminDto(guard.id, profile);
  }

  async revealLicenceForAdmin(
    adminUserId: number,
    guardId: number,
    meta: RequestMeta,
  ): Promise<DrivingLicenceRevealResponseDto> {
    const guard = await this.requireGuardById(guardId);
    const profile = await this.findProfileWithEnc(guard.id);

    await this.auditLogService.log({
      user: { id: adminUserId },
      action: 'guard_personnel.driving_licence_reveal',
      entityType: 'guard_driving_profile',
      entityId: profile?.id ?? null,
      afterData: { field: 'licenceNumber', requestedBy: 'admin', adminUserId },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return this.buildLicenceRevealResponse(profile);
  }

  // ── Company operational view ────────────────────────────────────────────────

  async getDrivingForCompany(
    companyUserId: number,
    guardId: number,
  ): Promise<DrivingTransportCompanyResponseDto> {
    const companyId = await this.requireCompanyIdForUser(companyUserId);
    await this.requireActiveCompanyGuardRelationship(companyId, guardId);

    const guard = await this.requireGuardById(guardId);
    const profile = await this.drivingRepo.findOne({ where: { guard: { id: guard.id } } });

    return {
      guardId: guard.id,
      primaryTravelMethod: profile?.primaryTravelMethod ?? null,
      maxTravelDistanceMiles: profile?.maxTravelDistanceMiles ?? null,
      willingToDriveToWork: profile?.willingToDriveToWork ?? null,
      hasVehicleAccess: profile?.hasVehicleAccess ?? null,
    };
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

  private async findProfileWithEnc(guardId: number): Promise<GuardDrivingProfile | null> {
    return this.drivingRepo
      .createQueryBuilder('d')
      .addSelect('d.licenceNumberEnc')
      .where('d.guardId = :guardId', { guardId })
      .getOne();
  }

  private async findOrCreateProfile(guard: GuardProfile): Promise<GuardDrivingProfile> {
    const existing = await this.findProfileWithEnc(guard.id);
    if (existing) return existing;
    const created = this.drivingRepo.create({ guard, licenceStatus: DrivingLicenceStatus.NONE });
    return this.drivingRepo.save(created);
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

  private buildLicenceRevealResponse(
    profile: GuardDrivingProfile | null,
  ): DrivingLicenceRevealResponseDto {
    const plaintext = profile?.licenceNumberEnc
      ? this.encryptionService.decrypt(profile.licenceNumberEnc)
      : null;
    return {
      field: 'licenceNumber',
      maskedValue: plaintext ? this.encryptionService.maskLicenceNumber(plaintext) : null,
      revealedValue: plaintext,
    };
  }

  private toGuardDto(
    guardId: number,
    profile: GuardDrivingProfile | null,
  ): DrivingTransportGuardResponseDto {
    const plaintext = profile?.licenceNumberEnc
      ? this.encryptionService.decrypt(profile.licenceNumberEnc)
      : null;
    return {
      guardId,
      licenceStatus: profile?.licenceStatus ?? DrivingLicenceStatus.NONE,
      licenceNumberSet: profile?.licenceNumberEnc != null,
      licenceNumberMasked: plaintext ? this.encryptionService.maskLicenceNumber(plaintext) : null,
      licenceCategories: profile?.licenceCategories ?? null,
      licenceExpiryDate: profile?.licenceExpiryDate ?? null,
      willingToDriveToWork: profile?.willingToDriveToWork ?? null,
      ownsVehicle: profile?.ownsVehicle ?? null,
      hasVehicleAccess: profile?.hasVehicleAccess ?? null,
      primaryTravelMethod: profile?.primaryTravelMethod ?? null,
      maxTravelDistanceMiles: profile?.maxTravelDistanceMiles ?? null,
    };
  }

  private toAdminDto(
    guardId: number,
    profile: GuardDrivingProfile | null,
  ): DrivingTransportAdminResponseDto {
    return {
      ...this.toGuardDto(guardId, profile),
      canReveal: true,
    };
  }
}
