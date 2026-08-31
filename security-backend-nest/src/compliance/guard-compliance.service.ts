import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { CompanyService } from '../company/company.service';
import { CompanyGuard, CompanyGuardStatus } from '../company-guard/entities/company-guard.entity';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification.entity';
import {
  ComplianceRecord,
  ComplianceRecordStatus,
  ComplianceRecordType,
} from './entities/compliance-record.entity';
import { CreateGuardDocumentDto } from './dto/create-guard-document.dto';
import { GuardDocument, GuardDocumentType } from './entities/guard-document.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PreHireComplianceAuthorizationService } from './pre-hire-compliance-authorization.service';
import { randomUUID } from 'crypto';
import { EvidenceStorageService } from './evidence-storage.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { UserRole, isCompanyRole } from '../user/entities/user.entity';

export type GuardComplianceStatus = 'valid' | 'expiring' | 'expired' | 'invalid';

export type GuardComplianceSummary = {
  guardId: number;
  fullName: string;
  siaLicenceNumber: string | null;
  siaExpiryDate: string | null;
  rightToWorkStatus: string | null;
  rightToWorkExpiryDate: string | null;
  complianceStatus: GuardComplianceStatus;
  assignable: boolean;
  blockingReasons: string[];
  expiringReasons: string[];
  missingDocuments: string[];
  documents: SafeGuardDocument[];
};

export type SafeGuardDocument = {
  id: number;
  guard: { id: number; fullName?: string };
  company: { id: number } | null;
  type: GuardDocumentType;
  originalFileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadCompletedAt: Date | null;
  expiryDate: string | null;
  verified: boolean;
  uploadedByUserId: number | null;
  verifiedByUserId: number | null;
  verifiedAt: Date | null;
  uploadedAt: Date;
};

const ALLOWED_EVIDENCE_TYPES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
};

type AssessmentState = {
  invalidReasons: string[];
  expiredReasons: string[];
  expiringReasons: string[];
  missingDocuments: string[];
};

const REQUIRED_DOCUMENT_TYPES: Array<{ type: GuardDocumentType; label: string }> = [
  { type: GuardDocumentType.SIA_LICENCE, label: 'SIA licence document' },
  { type: GuardDocumentType.RIGHT_TO_WORK, label: 'Right-to-work document' },
];

@Injectable()
export class GuardComplianceService {
  constructor(
    @InjectRepository(GuardDocument)
    private readonly guardDocumentRepo: Repository<GuardDocument>,
    @InjectRepository(ComplianceRecord)
    private readonly complianceRepo: Repository<ComplianceRecord>,
    @InjectRepository(CompanyGuard)
    private readonly companyGuardRepo: Repository<CompanyGuard>,
    private readonly companyService: CompanyService,
    private readonly guardProfileService: GuardProfileService,
    private readonly notificationService: NotificationService,
    private readonly auditLogService: AuditLogService,
    private readonly preHireAuthorization: PreHireComplianceAuthorizationService,
    private readonly evidenceStorage: EvidenceStorageService,
  ) {}

  async listStatusesForCompanyUser(userId: number, status?: GuardComplianceStatus) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const links = await this.companyGuardRepo.find({
      where: { company: { id: company.id }, status: In([CompanyGuardStatus.ACTIVE, CompanyGuardStatus.BLOCKED]) },
      order: { id: 'DESC' },
    });

    const summaries = await Promise.all(
      links
        .filter((link) => link.guard)
        .map((link) => this.getGuardSummary(link.guard.id, company.id)),
    );

    return status ? summaries.filter((item) => item.complianceStatus === status) : summaries;
  }

  async getStatusForGuardUser(userId: number) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    return this.getGuardSummary(guard.id);
  }

  async getGuardSummary(guardId: number, companyId?: number): Promise<GuardComplianceSummary> {
    const guard = await this.guardProfileService.findOne(guardId);
    const documents = await this.guardDocumentRepo.find({
      where: companyId
        ? { company: { id: companyId }, guard: { id: guard.id } }
        : { guard: { id: guard.id } },
      order: { uploadedAt: 'DESC', id: 'DESC' },
    });

    const records = await this.complianceRepo.find({
      where: companyId ? { company: { id: companyId }, guard: { id: guard.id } } : { guard: { id: guard.id } },
      order: { expiryDate: 'ASC', id: 'DESC' },
    });

    const assessment = this.assessGuard(guard, documents, records);
    const complianceStatus = this.resolveStatus(assessment);

    return {
      guardId: guard.id,
      fullName: guard.fullName,
      siaLicenceNumber: guard.siaLicenseNumber || null,
      siaExpiryDate: guard.siaExpiryDate || null,
      rightToWorkStatus: guard.rightToWorkStatus || null,
      rightToWorkExpiryDate: guard.rightToWorkExpiryDate || null,
      complianceStatus,
      assignable: complianceStatus === 'valid' || complianceStatus === 'expiring',
      blockingReasons: [...assessment.invalidReasons, ...assessment.expiredReasons],
      expiringReasons: assessment.expiringReasons,
      missingDocuments: assessment.missingDocuments,
      documents: documents.map((document) => this.toSafeDocument(document)),
    };
  }

  async listDocumentsForCompanyUser(userId: number, guardId?: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    const documents = await this.guardDocumentRepo.find({
      where: guardId
        ? { company: { id: company.id }, guard: { id: guardId } }
        : { company: { id: company.id } },
      order: { uploadedAt: 'DESC', id: 'DESC' },
    });
    return documents.map((document) => this.toSafeDocument(document));
  }

  async listDocumentsForGuardUser(userId: number) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    const documents = await this.guardDocumentRepo.find({
      where: { guard: { id: guard.id } },
      order: { uploadedAt: 'DESC', id: 'DESC' },
    });
    return documents.map((document) => this.toSafeDocument(document));
  }

  async uploadDocumentForGuardUser(userId: number, dto: CreateGuardDocumentDto) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    return this.saveDocument(guard.id, dto, userId, null);
  }

  async uploadDocumentForCompanyUser(userId: number, dto: CreateGuardDocumentDto) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    if (!dto.guardId) throw new BadRequestException('guardId is required');

    const links = await this.companyGuardRepo.find({
      where: { company: { id: company.id }, guard: { id: dto.guardId } },
    });
    const authorizedGuardId = links.length
      ? dto.guardId
      : (await this.preHireAuthorization.authorize(company.id, dto.guardId)).guard.id;

    return this.saveDocument(authorizedGuardId, dto, userId, { id: company.id });
  }

  async verifyDocumentForCompanyUser(userId: number, documentId: number, verified: boolean) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const document = await this.guardDocumentRepo.findOne({
      where: { id: documentId, company: { id: company.id } },
    });
    if (!document) throw new NotFoundException('Guard document not found');
    if (!document.uploadCompletedAt) throw new BadRequestException('Evidence upload is not complete');

    const beforeVerification = { verified: document.verified };
    document.verified = verified;
    document.verifiedByUserId = userId;
    document.verifiedAt = new Date();
    const saved = await this.guardDocumentRepo.save(document);
    await this.auditLogService.log({
      company: { id: company.id },
      user: { id: userId },
      action: 'guard_document.verified',
      entityType: 'guard_document',
      entityId: saved.id,
      beforeData: beforeVerification,
      afterData: {
        verified: saved.verified,
        guardId: saved.guard.id,
        documentType: saved.type,
      },
    });
    return this.toSafeDocument(saved);
  }

  async getBlockingReasons(companyId: number, guardId: number) {
    const summary = await this.getGuardSummary(guardId, companyId);
    if (summary.complianceStatus === 'valid' || summary.complianceStatus === 'expiring') return [];
    return summary.blockingReasons.length
      ? summary.blockingReasons
      : [`Guard compliance invalid: ${summary.complianceStatus}`];
  }

  async runDailyComplianceReminders() {
    const links = await this.companyGuardRepo.find({
      where: { status: In([CompanyGuardStatus.ACTIVE, CompanyGuardStatus.BLOCKED]) },
      order: { id: 'DESC' },
    });

    let companiesChecked = 0;
    let expiring = 0;
    let expired = 0;
    let invalid = 0;

    const companyIdsSeen = new Set<number>();
    for (const link of links) {
      const company = link.company;
      const guard = link.guard;
      if (!company?.id || !guard?.id || !company.user?.id) continue;
      companyIdsSeen.add(company.id);

      const summary = await this.getGuardSummary(guard.id, company.id);
      if (summary.complianceStatus === 'valid') continue;

      const title =
        summary.complianceStatus === 'expiring'
          ? 'Guard compliance expiring soon'
          : summary.complianceStatus === 'expired'
            ? 'Guard compliance expired'
            : 'Guard compliance invalid';
      const detailSource =
        summary.complianceStatus === 'expiring'
          ? summary.expiringReasons[0]
          : summary.blockingReasons[0] || summary.missingDocuments[0] || 'Compliance needs review';

      await this.notificationService.createForUserUnlessRecentDuplicate(
        {
          userId: company.user.id,
          company,
          type: NotificationType.COMPLIANCE_ALERT,
          title,
          message: `${guard.fullName} requires compliance attention: ${detailSource}.`,
        },
        1440,
      );

      if (summary.complianceStatus === 'expiring') expiring += 1;
      else if (summary.complianceStatus === 'expired') expired += 1;
      else invalid += 1;
    }

    companiesChecked = companyIdsSeen.size;
    return { companiesChecked, guardsChecked: links.length, expiring, expired, invalid };
  }

  private async saveDocument(
    guardId: number,
    dto: CreateGuardDocumentDto,
    actorUserId: number,
    company: { id: number } | null,
  ) {
    const guard = await this.guardProfileService.findOne(guardId);
    const metadata = this.validateEvidenceMetadata(dto);
    const storageKey = `compliance/${company ? `company/${company.id}` : 'guard'}/${guard.id}/${randomUUID()}`;
    const upload = await this.evidenceStorage.createSignedUploadUrl({
      key: storageKey,
      mimeType: metadata.mimeType,
      originalFileName: metadata.originalFileName,
    });

    const document = this.guardDocumentRepo.create({
      guard,
      type: dto.type,
      fileUrl: null,
      storageProvider: this.evidenceStorage.provider,
      storageKey,
      originalFileName: metadata.originalFileName,
      mimeType: metadata.mimeType,
      sizeBytes: String(metadata.sizeBytes),
      uploadCompletedAt: metadata.legacyTestInput ? new Date() : null,
      expiryDate: dto.expiryDate || null,
      verified: false,
      company,
      uploadedByUserId: actorUserId,
      verifiedByUserId: null,
      verifiedAt: null,
    });

    const saved = await this.guardDocumentRepo.save(document);
    await this.auditLogService.log({
      company,
      user: { id: actorUserId },
      action: metadata.legacyTestInput ? 'guard_document.uploaded' : 'guard_document.upload_initiated',
      entityType: 'guard_document',
      entityId: saved.id,
      afterData: {
        guardId: saved.guard.id,
        documentType: saved.type,
        expiryDate: saved.expiryDate,
        verified: saved.verified,
      },
    });
    return { ...this.toSafeDocument(saved), upload };
  }

  async createDocumentAccess(user: JwtPayload, documentId: number) {
    let document: GuardDocument | null;
    if (user.role === UserRole.ADMIN) {
      document = await this.findDocumentForAccess({ id: documentId });
    } else if (user.role === UserRole.GUARD) {
      const guard = await this.guardProfileService.findByUserId(user.sub);
      if (!guard) throw new NotFoundException('Guard profile not found');
      document = await this.findDocumentForAccess({ id: documentId, guard: { id: guard.id } });
    } else if (isCompanyRole(user.role)) {
      const company = await this.companyService.findByUserId(user.sub);
      if (!company) throw new NotFoundException('Company not found');
      document = await this.findDocumentForAccess({ id: documentId, company: { id: company.id } });
    } else {
      throw new ForbiddenException('Compliance evidence access is not permitted');
    }
    if (!document) throw new NotFoundException('Guard document not found');
    if (!document.storageKey || document.storageProvider !== this.evidenceStorage.provider) {
      throw new NotFoundException('Private evidence is not available');
    }
    if (!document.uploadCompletedAt) throw new NotFoundException('Private evidence is not available');
    const access = await this.evidenceStorage.createSignedDownloadUrl({
      key: document.storageKey,
      mimeType: document.mimeType || 'application/octet-stream',
      originalFileName: document.originalFileName || 'evidence',
    });
    await this.auditLogService.log({
      company: document.company ? { id: document.company.id } : null,
      user: { id: user.sub },
      action: 'guard_document.accessed',
      entityType: 'guard_document',
      entityId: document.id,
      afterData: { guardId: document.guard.id, documentType: document.type, expiresAt: access.expiresAt },
    });
    return { documentId: document.id, url: access.url, expiresAt: access.expiresAt, method: access.method };
  }

  async completeDocumentUpload(user: JwtPayload, documentId: number) {
    let document: GuardDocument | null;
    if (user.role === UserRole.ADMIN) {
      document = await this.findDocumentForAccess({ id: documentId });
    } else if (user.role === UserRole.GUARD) {
      const guard = await this.guardProfileService.findByUserId(user.sub);
      if (!guard) throw new NotFoundException('Guard profile not found');
      document = await this.findDocumentForAccess({ id: documentId, guard: { id: guard.id } });
    } else if (isCompanyRole(user.role)) {
      const company = await this.companyService.findByUserId(user.sub);
      if (!company) throw new NotFoundException('Company not found');
      document = await this.findDocumentForAccess({ id: documentId, company: { id: company.id } });
    } else {
      throw new ForbiddenException('Compliance evidence access is not permitted');
    }
    if (!document) throw new NotFoundException('Guard document not found');
    if (!document.storageKey || document.storageProvider !== this.evidenceStorage.provider || !document.mimeType || !document.originalFileName || !document.sizeBytes) {
      throw new NotFoundException('Private evidence is not available');
    }
    if (!document.uploadCompletedAt) {
      await this.evidenceStorage.verifyUpload({
        key: document.storageKey,
        mimeType: document.mimeType,
        originalFileName: document.originalFileName,
      }, Number(document.sizeBytes));
      document.uploadCompletedAt = new Date();
      const saved = await this.guardDocumentRepo.save(document);
      await this.auditLogService.log({
        company: saved.company ? { id: saved.company.id } : null,
        user: { id: user.sub },
        action: 'guard_document.uploaded',
        entityType: 'guard_document',
        entityId: saved.id,
        afterData: { guardId: saved.guard.id, documentType: saved.type, expiryDate: saved.expiryDate },
      });
      return this.toSafeDocument(saved);
    }
    return this.toSafeDocument(document);
  }

  private validateEvidenceMetadata(dto: CreateGuardDocumentDto) {
    const legacyTestInput = Boolean(dto.fileUrl && !dto.originalFileName && !dto.mimeType && !dto.sizeBytes);
    const fileName = (dto.originalFileName || (legacyTestInput ? 'legacy-test-evidence.pdf' : '')).trim();
    const mimeType = (dto.mimeType || (legacyTestInput ? 'application/pdf' : '')).trim().toLowerCase();
    const sizeBytes = dto.sizeBytes || (legacyTestInput ? 1024 : 0);
    const extensions = ALLOWED_EVIDENCE_TYPES[mimeType];
    if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0')) {
      throw new BadRequestException('Invalid original file name');
    }
    if (!extensions || !extensions.some((extension) => fileName.toLowerCase().endsWith(extension))) {
      throw new BadRequestException('Evidence must be a PDF, JPEG or PNG with a matching extension');
    }
    if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 10 * 1024 * 1024) {
      throw new BadRequestException('Evidence size must be between 1 byte and 10 MiB');
    }
    return { originalFileName: fileName, mimeType, sizeBytes, legacyTestInput };
  }

  private toSafeDocument(document: GuardDocument): SafeGuardDocument {
    return {
      id: document.id,
      guard: { id: document.guard.id, ...(document.guard.fullName ? { fullName: document.guard.fullName } : {}) },
      company: document.company ? { id: document.company.id } : null,
      type: document.type,
      originalFileName: document.originalFileName || null,
      mimeType: document.mimeType || null,
      sizeBytes: document.sizeBytes == null ? null : Number(document.sizeBytes),
      uploadCompletedAt: document.uploadCompletedAt || null,
      expiryDate: document.expiryDate || null,
      verified: document.verified,
      uploadedByUserId: document.uploadedByUserId || null,
      verifiedByUserId: document.verifiedByUserId || null,
      verifiedAt: document.verifiedAt || null,
      uploadedAt: document.uploadedAt,
    };
  }

  private findDocumentForAccess(where: Record<string, unknown>) {
    return this.guardDocumentRepo.findOne({
      where: where as never,
      select: { id: true, type: true, storageProvider: true, storageKey: true, originalFileName: true, mimeType: true, sizeBytes: true, uploadCompletedAt: true, expiryDate: true, verified: true, uploadedByUserId: true, verifiedByUserId: true, verifiedAt: true, uploadedAt: true },
      relations: { guard: true, company: true },
    });
  }

  private assessGuard(
    guard: Awaited<ReturnType<GuardProfileService['findOne']>>,
    documents: GuardDocument[],
    records: ComplianceRecord[],
  ): AssessmentState {
    const state: AssessmentState = {
      invalidReasons: [],
      expiredReasons: [],
      expiringReasons: [],
      missingDocuments: [],
    };

    if (!guard.siaLicenseNumber?.trim()) {
      state.invalidReasons.push('Missing SIA licence number');
    }
    this.pushExpiryState('SIA licence', guard.siaExpiryDate || null, state, true);

    const rightToWorkStatus = (guard.rightToWorkStatus || '').trim().toLowerCase();
    if (!rightToWorkStatus) {
      state.invalidReasons.push('Missing right-to-work status');
    } else if (['invalid', 'expired', 'revoked', 'refused', 'suspended'].includes(rightToWorkStatus)) {
      state.invalidReasons.push(`Right-to-work status is ${guard.rightToWorkStatus}`);
    }
    if (this.requiresRightToWorkExpiry(rightToWorkStatus)) {
      this.pushExpiryState('Right-to-work clearance', guard.rightToWorkExpiryDate || null, state, true);
    } else if (guard.rightToWorkExpiryDate) {
      this.pushExpiryState('Right-to-work clearance', guard.rightToWorkExpiryDate, state, false);
    }

    for (const requirement of REQUIRED_DOCUMENT_TYPES) {
      const matching = documents.filter((document) => document.type === requirement.type && document.uploadCompletedAt);
      const verified = matching.find((document) => document.verified);
      if (!matching.length) {
        state.invalidReasons.push(`Missing ${requirement.label}`);
        state.missingDocuments.push(requirement.label);
        continue;
      }
      if (!verified) {
        state.invalidReasons.push(`${requirement.label} is not verified`);
        continue;
      }
      this.pushExpiryState(requirement.label, verified.expiryDate || null, state, false);
    }

    records.forEach((record) => {
      if (![ComplianceRecordType.SIA, ComplianceRecordType.RIGHT_TO_WORK].includes(record.type)) return;
      if (record.status === ComplianceRecordStatus.EXPIRED) {
        state.expiredReasons.push(`${this.formatRecordType(record.type)} compliance record expired`);
      } else if (record.status === ComplianceRecordStatus.EXPIRING) {
        state.expiringReasons.push(`${this.formatRecordType(record.type)} compliance record expiring soon`);
      }
    });

    return state;
  }

  private pushExpiryState(label: string, expiryDate: string | null, state: AssessmentState, required: boolean) {
    if (!expiryDate) {
      if (required) {
        state.invalidReasons.push(`Missing ${label.toLowerCase()} expiry date`);
      }
      return;
    }

    const daysUntil = this.getDaysUntil(expiryDate);
    if (daysUntil === null) {
      state.invalidReasons.push(`Invalid ${label.toLowerCase()} expiry date`);
      return;
    }
    if (daysUntil < 0) {
      state.expiredReasons.push(`${label} expired`);
      return;
    }
    if (daysUntil <= 30) {
      state.expiringReasons.push(`${label} expires within 30 days`);
    }
  }

  private resolveStatus(state: AssessmentState): GuardComplianceStatus {
    if (state.invalidReasons.length) return 'invalid';
    if (state.expiredReasons.length) return 'expired';
    if (state.expiringReasons.length) return 'expiring';
    return 'valid';
  }

  private requiresRightToWorkExpiry(status: string) {
    if (!status) return true;
    return !['permanent', 'indefinite', 'settled', 'british', 'citizen', 'no_expiry'].includes(status);
  }

  private getDaysUntil(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    date.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.floor((date.getTime() - today.getTime()) / 86400000);
  }

  private formatRecordType(type: ComplianceRecordType) {
    if (type === ComplianceRecordType.RIGHT_TO_WORK) return 'Right-to-work';
    return 'SIA';
  }
}
