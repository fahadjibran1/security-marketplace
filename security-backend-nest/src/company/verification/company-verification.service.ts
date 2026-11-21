import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Company } from '../entities/company.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { JwtPayload } from '../../auth/types/jwt-payload.type';
import {
  COMPANY_VERIFICATION_REASON_REQUIRED,
  COMPANY_VERIFICATION_TRANSITIONS,
  CompanyVerificationStatus,
} from '../company-verification';

/** What an S4 platform administrator sees to decide a company's verification. */
export interface CompanyVerificationAdminView {
  id: number;
  name: string;
  companyNumber: string;
  address: string;
  contactDetails: string;
  verificationStatus: CompanyVerificationStatus;
  verificationNote: string | null;
  verificationDecidedAt: Date | null;
  owner: { id: number; email: string; phone: string | null } | null;
}

function adminView(company: Company): CompanyVerificationAdminView {
  return {
    id: company.id,
    name: company.name,
    companyNumber: company.companyNumber,
    address: company.address,
    contactDetails: company.contactDetails,
    verificationStatus: company.verificationStatus,
    verificationNote: company.verificationNote ?? null,
    verificationDecidedAt: company.verificationDecidedAt ?? null,
    owner: company.user ? { id: company.user.id, email: company.user.email, phone: company.user.phone ?? null } : null,
  };
}

/**
 * SEC-PUBLIC-03: S4 platform administrators decide company verification. Every decision is a permitted transition
 * (COMPANY_VERIFICATION_TRANSITIONS), applied only if the company is still in the state the administrator saw
 * (compare-and-set, so two administrators cannot silently overwrite each other), and audited as
 * company.verification_changed with the before and after state.
 */
@Injectable()
export class CompanyVerificationService {
  constructor(
    @InjectRepository(Company) private readonly companies: Repository<Company>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(status?: CompanyVerificationStatus): Promise<CompanyVerificationAdminView[]> {
    const rows = await this.companies.find({
      where: status ? { verificationStatus: status } : {},
      order: { id: 'ASC' },
    });
    return rows.map(adminView);
  }

  async get(companyId: number): Promise<CompanyVerificationAdminView> {
    const company = await this.companies.findOne({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Company not found');
    return adminView(company);
  }

  async decide(
    admin: JwtPayload,
    companyId: number,
    target: CompanyVerificationStatus,
    reason?: string | null,
  ): Promise<CompanyVerificationAdminView> {
    const company = await this.companies.findOne({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Company not found');

    const from = company.verificationStatus;
    if (!COMPANY_VERIFICATION_TRANSITIONS[from]?.includes(target)) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'COMPANY_VERIFICATION_TRANSITION_NOT_ALLOWED',
        message: `A company that is ${from} cannot be moved to ${target}.`,
      });
    }

    const note = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
    if (COMPANY_VERIFICATION_REASON_REQUIRED.includes(target) && !note) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'COMPANY_VERIFICATION_REASON_REQUIRED',
        message: 'A reason is required to reject or suspend a company; the company is shown it.',
      });
    }

    const decidedAt = new Date();
    const result = await this.companies
      .createQueryBuilder()
      .update(Company)
      .set({ verificationStatus: target, verificationNote: note, verificationDecidedAt: decidedAt })
      .where('id = :companyId AND "verificationStatus" = :from', { companyId, from })
      .execute();
    if (!result.affected) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'COMPANY_VERIFICATION_CHANGED',
        message: 'This company\'s verification changed while you were deciding. Reload it and decide again.',
      });
    }

    await this.auditLogService.log({
      company: { id: company.id },
      user: { id: admin.sub },
      action: 'company.verification_changed',
      entityType: 'company',
      entityId: company.id,
      beforeData: { verificationStatus: from, verificationNote: company.verificationNote ?? null },
      afterData: { verificationStatus: target, verificationNote: note },
    });

    return this.get(companyId);
  }
}
