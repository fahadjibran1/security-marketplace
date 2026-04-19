import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Company } from '../company/entities/company.entity';
import { CompanyService } from '../company/company.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification.entity';
import { UpsertComplianceRecordDto } from './dto/upsert-compliance-record.dto';
import { GuardComplianceService } from './guard-compliance.service';
import {
  ComplianceRecord,
  ComplianceRecordStatus,
  ComplianceRecordType,
} from './entities/compliance-record.entity';

@Injectable()
export class ComplianceService {
  constructor(
    @InjectRepository(ComplianceRecord) private readonly complianceRepo: Repository<ComplianceRecord>,
    private readonly companyService: CompanyService,
    private readonly guardProfileService: GuardProfileService,
    private readonly notificationService: NotificationService,
    private readonly guardComplianceService: GuardComplianceService,
  ) {}

  async listForCompanyUser(userId: number) {
    const company = await this.getCompanyForUser(userId);
    return this.listForCompany(company.id);
  }

  async listForCompany(companyId: number) {
    const records = await this.complianceRepo.find({
      where: { company: { id: companyId } },
      order: { expiryDate: 'ASC', id: 'DESC' },
    });
    const updated = await this.refreshStatuses(records);
    return updated;
  }

  async listForGuardUser(userId: number) {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    const records = await this.complianceRepo.find({
      where: { guard: { id: guard.id } },
      order: { expiryDate: 'ASC', id: 'DESC' },
    });
    return this.refreshStatuses(records);
  }

  async upsertForCompanyUser(userId: number, dto: UpsertComplianceRecordDto) {
    const company = await this.getCompanyForUser(userId);
    const guard = await this.guardProfileService.findOne(dto.guardId);
    const existing = await this.complianceRepo.findOne({
      where: { company: { id: company.id }, guard: { id: guard.id }, type: dto.type },
    });
    const status = this.deriveStatus(dto.expiryDate);
    const normalized = {
      documentName: dto.documentName.trim(),
      documentNumber: dto.documentNumber?.trim() || null,
      issueDate: dto.issueDate || null,
      expiryDate: dto.expiryDate,
      status,
      reminderSentAt: status === ComplianceRecordStatus.VALID ? null : existing?.reminderSentAt ?? null,
    };
    if (!normalized.documentName) {
      throw new BadRequestException('Document name is required.');
    }
    const record = existing
      ? Object.assign(existing, normalized)
      : this.complianceRepo.create({ ...normalized, company, guard, type: dto.type });
    return this.complianceRepo.save(record);
  }

  async assertGuardAssignable(companyId: number, guardId: number) {
    const blockers = await this.guardComplianceService.getBlockingReasons(companyId, guardId);
    if (blockers.length) {
      throw new ForbiddenException(`Guard compliance invalid: ${blockers[0]}`);
    }
  }

  async getBlockingRecords(companyId: number, guardId: number) {
    return this.guardComplianceService.getBlockingReasons(companyId, guardId);
  }

  async runDailyComplianceReminders() {
    return this.guardComplianceService.runDailyComplianceReminders();
  }

  deriveStatus(expiryDate: string | Date) {
    const expiry = this.toDateOnly(expiryDate);
    if (!expiry) return ComplianceRecordStatus.EXPIRED;
    const today = this.toDateOnly(new Date())!;
    const days = Math.floor((expiry.getTime() - today.getTime()) / 86400000);
    if (days < 0) return ComplianceRecordStatus.EXPIRED;
    if (days <= 30) return ComplianceRecordStatus.EXPIRING;
    return ComplianceRecordStatus.VALID;
  }

  private async refreshStatuses(records: ComplianceRecord[]) {
    const changed: ComplianceRecord[] = [];
    records.forEach((record) => {
      const nextStatus = this.deriveStatus(record.expiryDate);
      if (record.status !== nextStatus) {
        record.status = nextStatus;
        if (nextStatus === ComplianceRecordStatus.VALID) {
          record.reminderSentAt = null;
        }
        changed.push(record);
      }
    });
    if (changed.length) {
      await this.complianceRepo.save(changed);
    }
    return records;
  }

  private async getCompanyForUser(userId: number): Promise<Company> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  private toDateOnly(value: string | Date) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    date.setHours(0, 0, 0, 0);
    return date;
  }
}
