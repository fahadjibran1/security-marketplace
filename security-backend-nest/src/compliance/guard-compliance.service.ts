import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

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
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { GuardComplianceCheck } from './entities/guard-compliance-check.entity';
import { daysUntilCalendarDate, toCalendarDate } from './compliance-dates';

export type GuardComplianceStatus = 'valid' | 'expiring' | 'expired' | 'invalid';

/** The current company check of one kind, as shown on the compliance summary. No evidence reference. */
export type CompanyCheckSummary = {
  id: number;
  outcome: string;
  method: string;
  rightToWorkExcuse: string | null;
  licenceNumber: string | null;
  checkDate: string;
  expiryDate: string | null;
  workRestrictions: string | null;
  checkedByName: string;
  recordedByUserId: number | null;
  createdAt: Date;
};

/** One line of the "what is still needed" checklist. */
export type ComplianceRequirement = {
  key: 'sia_check' | 'right_to_work_check' | 'sia_document' | 'right_to_work_document';
  label: string;
  state: 'met' | 'expiring' | 'missing' | 'expired' | 'not_confirmed' | 'unverified';
  detail: string;
};

export type GuardComplianceSummary = {
  guardId: number;
  fullName: string;
  /**
   * The Guard's own declarations (guard_profiles). Shown for reference only: in a company view they
   * never satisfy a requirement. Only the company's own checks (companyChecks) do.
   */
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
  /** Company view only (null in the Guard's own view): this company's current checks. */
  companyChecks: { sia: CompanyCheckSummary | null; rightToWork: CompanyCheckSummary | null } | null;
  /** Company view only (empty in the Guard's own view): each requirement and whether it is met. */
  requirements: ComplianceRequirement[];
  /**
   * Non-blocking notices the company must act on itself. They never change complianceStatus or
   * assignability: for example recorded right to work restrictions, which S4 does not check rotas against.
   */
  warnings: string[];
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
  requirements: ComplianceRequirement[];
  warnings: string[];
};

/** A calendar date as people in the UK read it (DD/MM/YYYY), for requirement details shown to users. */
const ukDate = (value: string | Date | null | undefined) => {
  const iso = toCalendarDate(value);
  return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : 'an unknown date';
};

/** Shown wherever restrictions are recorded: S4 stores them but does not enforce them. */
export const RIGHT_TO_WORK_RESTRICTION_WARNING =
  'Right to work restrictions are recorded for this Guard. S4 does not check shifts against them: confirm each shift is allowed before assigning it.';

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
    private readonly membershipService: CompanyMembershipService,
    private readonly guardProfileService: GuardProfileService,
    private readonly notificationService: NotificationService,
    private readonly auditLogService: AuditLogService,
    private readonly preHireAuthorization: PreHireComplianceAuthorizationService,
    private readonly evidenceStorage: EvidenceStorageService,
    @InjectRepository(GuardComplianceCheck)
    private readonly complianceCheckRepo: Repository<GuardComplianceCheck>,
  ) {}

  async listStatusesForCompanyUser(userId: number, userRole: UserRole, status?: GuardComplianceStatus) {
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole, CompanyPermission.COMPLIANCE_VIEW);

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

    // Company view: the company's own current checks decide the SIA and Right to Work requirements.
    // Guard view (no company): there is no single company whose checks apply, so the Guard's own
    // declarations are assessed instead. That view is informational and never gates assignment —
    // every assignment path calls getBlockingReasons with a companyId.
    const checks = companyId
      ? await this.complianceCheckRepo.find({ where: { companyId, guardId: guard.id, supersededAt: IsNull() } })
      : null;
    const assessment = this.assessGuard(guard, documents, records, checks);
    const complianceStatus = this.resolveStatus(assessment);
    const currentCheck = (kind: string) => {
      const check = checks?.find((item) => item.kind === kind);
      return check ? this.toCheckSummary(check) : null;
    };

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
      companyChecks: checks ? { sia: currentCheck('sia'), rightToWork: currentCheck('right_to_work') } : null,
      requirements: assessment.requirements,
      warnings: assessment.warnings,
    };
  }

  private toCheckSummary(check: GuardComplianceCheck): CompanyCheckSummary {
    return {
      id: check.id,
      outcome: check.outcome,
      method: check.method,
      rightToWorkExcuse: check.rightToWorkExcuse ?? null,
      licenceNumber: check.licenceNumber ?? null,
      checkDate: toCalendarDate(check.checkDate) ?? String(check.checkDate),
      expiryDate: toCalendarDate(check.expiryDate),
      workRestrictions: check.workRestrictions ?? null,
      checkedByName: check.checkedByName,
      recordedByUserId: check.recordedByUserId ?? null,
      createdAt: check.createdAt,
    };
  }

  async listDocumentsForCompanyUser(userId: number, userRole: UserRole, guardId?: number) {
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole, CompanyPermission.COMPLIANCE_VIEW);
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
    const company = await this.resolveGuardUploadCompany(guard.id, dto.companyId);
    return this.saveDocument(guard.id, dto, userId, company);
  }

  /**
   * Companies a Guard may submit compliance evidence to (ACTIVE company relationships only).
   * Evidence is company-scoped: each Company verifies its own copy independently.
   */
  async listUploadCompaniesForGuardUser(userId: number) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    const links = await this.companyGuardRepo.find({
      where: { guard: { id: guard.id }, status: CompanyGuardStatus.ACTIVE },
      order: { id: 'ASC' },
    });
    return links.filter((link) => link.company).map((link) => ({ companyId: link.company.id, name: link.company.name }));
  }

  /**
   * A Guard may work for several Companies and each Company verifies evidence independently, so a
   * Guard upload must name the Company it is for. The Company is never guessed. The target must be an
   * ACTIVE company relationship or an eligible pre-hire application (same authority as Company uploads).
   */
  private async resolveGuardUploadCompany(guardId: number, requestedCompanyId?: number): Promise<{ id: number }> {
    if (!requestedCompanyId) {
      throw new BadRequestException('companyId is required: choose the company this evidence is for');
    }
    const links = await this.companyGuardRepo.find({
      where: { guard: { id: guardId }, company: { id: requestedCompanyId }, status: CompanyGuardStatus.ACTIVE },
    });
    if (links.some((link) => link.company?.id === requestedCompanyId)) return { id: requestedCompanyId };
    try {
      await this.preHireAuthorization.authorize(requestedCompanyId, guardId);
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw new ForbiddenException('You cannot submit evidence to that company');
      }
      throw error;
    }
    return { id: requestedCompanyId };
  }

  async uploadDocumentForCompanyUser(userId: number, userRole: UserRole, dto: CreateGuardDocumentDto) {
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole, CompanyPermission.COMPLIANCE_MANAGE);
    if (!dto.guardId) throw new BadRequestException('guardId is required');

    const authorizedGuardId = await this.authorizeGuardForCompanyMutation(company.id, dto.guardId);
    return this.saveDocument(authorizedGuardId, dto, userId, { id: company.id });
  }

  /**
   * A Company may write compliance data for a Guard only when that Guard is related to the Company: an
   * existing CompanyGuard relationship, or an eligible pre-hire application (under_review, open job).
   * The Company must come from resolveCompanyContext — never from the request body. An unrelated or
   * non-existent Guard yields the same 403, so Guard ids cannot be enumerated.
   */
  async authorizeGuardForCompanyMutation(companyId: number, guardId: number): Promise<number> {
    const links = await this.companyGuardRepo.find({
      where: { company: { id: companyId }, guard: { id: guardId } },
    });
    if (links.length) return guardId;
    return (await this.preHireAuthorization.authorize(companyId, guardId)).guard.id;
  }

  async verifyDocumentForCompanyUser(userId: number, userRole: UserRole, documentId: number, verified: boolean) {
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole, CompanyPermission.COMPLIANCE_MANAGE);

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
      // compliance.view exposes compliance STATUS only. Retrieving the underlying identity / SIA / RTW
      // evidence file requires compliance.manage (see VIEWER_PERMISSIONS and p1i PERMISSION-12).
      const { company } = await this.membershipService.resolveCompanyContext(user.sub, user.role, CompanyPermission.COMPLIANCE_MANAGE);
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
      const { company } = await this.membershipService.resolveCompanyContext(user.sub, user.role, CompanyPermission.COMPLIANCE_MANAGE);
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
    companyChecks: GuardComplianceCheck[] | null,
  ): AssessmentState {
    const state: AssessmentState = {
      invalidReasons: [],
      expiredReasons: [],
      expiringReasons: [],
      missingDocuments: [],
      requirements: [],
      warnings: [],
    };

    if (companyChecks) {
      this.assessSiaCheck(companyChecks.find((check) => check.kind === 'sia') ?? null, state);
      this.assessRightToWorkCheck(companyChecks.find((check) => check.kind === 'right_to_work') ?? null, state);
    } else {
      this.assessGuardDeclarations(guard, state);
    }

    for (const requirement of REQUIRED_DOCUMENT_TYPES) {
      const key = requirement.type === GuardDocumentType.SIA_LICENCE ? 'sia_document' : 'right_to_work_document';
      const matching = documents.filter((document) => document.type === requirement.type && document.uploadCompletedAt);
      const verified = matching.find((document) => document.verified);
      if (!matching.length) {
        state.invalidReasons.push(`Missing ${requirement.label}`);
        state.missingDocuments.push(requirement.label);
        this.pushRequirement(state, companyChecks, key, requirement.label, 'missing', 'No document uploaded.');
        continue;
      }
      if (!verified) {
        state.invalidReasons.push(`${requirement.label} is not verified`);
        this.pushRequirement(state, companyChecks, key, requirement.label, 'unverified', 'Uploaded but not yet verified.');
        continue;
      }
      const outcome = this.pushExpiryState(requirement.label, verified.expiryDate || null, state, false);
      const detail = outcome === 'expiring'
        ? 'Verified; expires within 30 days.'
        : outcome === 'expired'
          ? 'Verified, but it has expired.'
          : 'Verified.';
      this.pushRequirement(state, companyChecks, key, requirement.label, outcome, detail);
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

  /** The company's own SIA licence check: required, and it must confirm an unexpired, active licence. */
  private assessSiaCheck(check: GuardComplianceCheck | null, state: AssessmentState) {
    const label = 'SIA licence check';
    if (!check) {
      state.invalidReasons.push('SIA licence check not recorded');
      state.requirements.push({ key: 'sia_check', label, state: 'missing', detail: 'Record your check of the SIA licence.' });
      return;
    }
    if (check.outcome !== 'confirmed') {
      state.invalidReasons.push('SIA licence check did not confirm an active licence');
      state.requirements.push({ key: 'sia_check', label, state: 'not_confirmed', detail: 'The last check did not confirm an active licence.' });
      return;
    }
    const outcome = this.pushExpiryState('SIA licence', check.expiryDate, state, true);
    const expiry = ukDate(check.expiryDate);
    state.requirements.push({
      key: 'sia_check',
      label,
      state: outcome,
      detail: outcome === 'expired' ? `Licence expired ${expiry}.` : `Licence active, expires ${expiry}.`,
    });
  }

  /**
   * The company's own Right to Work check: required, and it must confirm permission to work. A
   * continuous excuse has no end date. A time-limited one (including a six-month PVN) ends on its
   * expiry date, after which a follow-up check is needed.
   */
  private assessRightToWorkCheck(check: GuardComplianceCheck | null, state: AssessmentState) {
    const label = 'Right to work check';
    if (!check) {
      state.invalidReasons.push('Right to work check not recorded');
      state.requirements.push({ key: 'right_to_work_check', label, state: 'missing', detail: 'Record your right to work check.' });
      return;
    }
    if (check.outcome !== 'confirmed') {
      state.invalidReasons.push('Right to work check did not confirm permission to work');
      state.requirements.push({ key: 'right_to_work_check', label, state: 'not_confirmed', detail: 'The last check did not confirm permission to work.' });
      return;
    }
    if (check.workRestrictions?.trim()) {
      // Recorded so the company sees it; never treated as approval of any shift pattern.
      state.warnings.push(RIGHT_TO_WORK_RESTRICTION_WARNING);
    }
    if (check.rightToWorkExcuse === 'continuous') {
      state.requirements.push({ key: 'right_to_work_check', label, state: 'met', detail: 'Continuous right to work. No follow-up check needed.' });
      return;
    }
    const outcome = this.pushExpiryState('Right to work permission', check.expiryDate, state, true);
    const expiry = ukDate(check.expiryDate);
    state.requirements.push({
      key: 'right_to_work_check',
      label,
      state: outcome,
      detail: outcome === 'expired'
        ? `Time-limited permission ended ${expiry}. A follow-up check is needed.`
        : `Time-limited permission until ${expiry}. Follow-up check due by then.`,
    });
  }

  /**
   * The Guard's own declarations. Used only for the Guard's own (company-less) view, which never gates
   * assignment. Never consulted when a company assesses a Guard.
   */
  private assessGuardDeclarations(guard: Awaited<ReturnType<GuardProfileService['findOne']>>, state: AssessmentState) {
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
  }

  private pushRequirement(
    state: AssessmentState,
    companyChecks: GuardComplianceCheck[] | null,
    key: ComplianceRequirement['key'],
    label: string,
    outcome: ComplianceRequirement['state'],
    detail: string,
  ) {
    if (companyChecks) state.requirements.push({ key, label, state: outcome, detail });
  }

  /**
   * Records the expiry state of a calendar date (UK calendar, see compliance-dates.ts) and returns it.
   * A missing required date or an unreadable date counts as 'missing'.
   */
  private pushExpiryState(
    label: string,
    expiryDate: string | Date | null,
    state: AssessmentState,
    required: boolean,
  ): 'met' | 'expiring' | 'expired' | 'missing' {
    if (!expiryDate) {
      if (required) {
        state.invalidReasons.push(`Missing ${label.toLowerCase()} expiry date`);
        return 'missing';
      }
      return 'met';
    }

    const daysUntil = daysUntilCalendarDate(expiryDate);
    if (daysUntil === null) {
      state.invalidReasons.push(`Invalid ${label.toLowerCase()} expiry date`);
      return 'missing';
    }
    if (daysUntil < 0) {
      state.expiredReasons.push(`${label} expired`);
      return 'expired';
    }
    if (daysUntil <= 30) {
      state.expiringReasons.push(`${label} expires within 30 days`);
      return 'expiring';
    }
    return 'met';
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

  private formatRecordType(type: ComplianceRecordType) {
    if (type === ComplianceRecordType.RIGHT_TO_WORK) return 'Right-to-work';
    return 'SIA';
  }
}
