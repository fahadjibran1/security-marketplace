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
  documents: GuardDocument[];
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
      where: { guard: { id: guard.id } },
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
      documents,
    };
  }

  async listDocumentsForCompanyUser(userId: number, guardId?: number) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const links = await this.companyGuardRepo.find({
      where: { company: { id: company.id }, status: In([CompanyGuardStatus.ACTIVE, CompanyGuardStatus.BLOCKED]) },
    });
    const guardIds = links.map((link) => link.guard?.id).filter((id): id is number => Boolean(id));

    if (guardId && !guardIds.includes(guardId)) {
      throw new ForbiddenException('Guard does not belong to the current company');
    }

    if (!guardIds.length) return [];

    const targetGuardIds = guardId ? [guardId] : guardIds;
    return this.guardDocumentRepo.find({
      where: { guard: { id: In(targetGuardIds) } },
      order: { uploadedAt: 'DESC', id: 'DESC' },
    });
  }

  async listDocumentsForGuardUser(userId: number) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    return this.guardDocumentRepo.find({
      where: { guard: { id: guard.id } },
      order: { uploadedAt: 'DESC', id: 'DESC' },
    });
  }

  async uploadDocumentForGuardUser(userId: number, dto: CreateGuardDocumentDto) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    return this.saveDocument(guard.id, dto);
  }

  async uploadDocumentForCompanyUser(userId: number, dto: CreateGuardDocumentDto) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    if (!dto.guardId) throw new BadRequestException('guardId is required');

    const links = await this.companyGuardRepo.find({
      where: { company: { id: company.id }, guard: { id: dto.guardId } },
    });
    if (!links.length) throw new ForbiddenException('Guard does not belong to the current company');

    return this.saveDocument(dto.guardId, dto);
  }

  async verifyDocumentForCompanyUser(userId: number, documentId: number, verified: boolean) {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const document = await this.guardDocumentRepo.findOne({ where: { id: documentId } });
    if (!document) throw new NotFoundException('Guard document not found');

    const link = await this.companyGuardRepo.findOne({
      where: { company: { id: company.id }, guard: { id: document.guard.id } },
    });
    if (!link) throw new ForbiddenException('Guard document is outside the current company scope');

    document.verified = verified;
    return this.guardDocumentRepo.save(document);
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

  private async saveDocument(guardId: number, dto: CreateGuardDocumentDto) {
    const guard = await this.guardProfileService.findOne(guardId);
    const fileUrl = dto.fileUrl.trim();
    if (!fileUrl) throw new BadRequestException('fileUrl is required');

    const document = this.guardDocumentRepo.create({
      guard,
      type: dto.type,
      fileUrl,
      expiryDate: dto.expiryDate || null,
      verified: false,
    });

    return this.guardDocumentRepo.save(document);
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
      const matching = documents.filter((document) => document.type === requirement.type);
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
