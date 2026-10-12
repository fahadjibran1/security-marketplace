import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Not, Repository } from 'typeorm';

import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { CompanyGuard, CompanyGuardStatus } from '../company-guard/entities/company-guard.entity';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission, hasPermission } from '../company-membership/company-membership-types';
import { UserRole } from '../user/entities/user.entity';
import {
  ComplianceCheckKind,
  EXCUSES_BY_RIGHT_TO_WORK_METHOD,
  PVN_EXCUSE_MONTHS,
  RIGHT_TO_WORK_CHECK_METHODS,
  RightToWorkExcuse,
  SIA_CHECK_METHODS,
  SIA_LICENCE_NUMBER_PATTERN,
} from './compliance-check-vocabulary';
import { addCalendarMonths, calendarDaysBetween, complianceToday, toCalendarDate } from './compliance-dates';
import { RecordComplianceCheckDto } from './dto/record-compliance-check.dto';
import { GuardComplianceCheck } from './entities/guard-compliance-check.entity';
import { GuardDocument, GuardDocumentType } from './entities/guard-document.entity';

export type SafeComplianceCheck = {
  id: number;
  guardId: number;
  kind: string;
  outcome: string;
  method: string;
  rightToWorkExcuse: string | null;
  licenceNumber: string | null;
  checkDate: string;
  expiryDate: string | null;
  workRestrictions: string | null;
  checkedByName: string;
  /** Present only for callers with compliance.manage; null otherwise. */
  evidenceReference: string | null;
  evidenceDocumentId: number | null;
  recordedByUserId: number | null;
  changeType: string;
  changeReason: string | null;
  supersededAt: Date | null;
  supersededByCheckId: number | null;
  createdAt: Date;
};

type NormalisedCheck = Pick<
  GuardComplianceCheck,
  | 'kind'
  | 'outcome'
  | 'method'
  | 'rightToWorkExcuse'
  | 'licenceNumber'
  | 'checkDate'
  | 'expiryDate'
  | 'workRestrictions'
  | 'checkedByName'
  | 'evidenceReference'
  | 'evidenceDocumentId'
>;

const NOT_ACTIVE_FOR_COMPANY = 'This Guard is not active with your company';

const EVIDENCE_TYPE_BY_KIND: Record<ComplianceCheckKind, GuardDocumentType> = {
  sia: GuardDocumentType.SIA_LICENCE,
  right_to_work: GuardDocumentType.RIGHT_TO_WORK,
};

/**
 * Company-recorded SIA and Right to Work checks.
 *
 * Writes need compliance.manage (Owner, Admin, HR/Compliance) and an ACTIVE relationship between the
 * caller's company and the Guard. The company always comes from the caller's membership. Each write
 * appends a row, supersedes the previous current row and writes an audit entry in one transaction.
 *
 * Nothing here touches guard_profiles, guard_documents.verified or any other company's rows, and
 * there is no way to mark a Guard compliant other than recording the checks the assessment requires.
 */
@Injectable()
export class GuardComplianceCheckService {
  constructor(
    @InjectRepository(GuardComplianceCheck)
    private readonly checkRepo: Repository<GuardComplianceCheck>,
    @InjectRepository(CompanyGuard)
    private readonly companyGuardRepo: Repository<CompanyGuard>,
    @InjectRepository(GuardDocument)
    private readonly guardDocumentRepo: Repository<GuardDocument>,
    private readonly membershipService: CompanyMembershipService,
  ) {}

  async recordForCompanyUser(userId: number, userRole: UserRole, dto: RecordComplianceCheckDto): Promise<SafeComplianceCheck> {
    const { company } = await this.membershipService.resolveCompanyContext(userId, userRole, CompanyPermission.COMPLIANCE_MANAGE);
    await this.assertActiveRelationship(company.id, dto.guardId);
    const normalised = this.normalise(dto);
    if (normalised.evidenceDocumentId) {
      await this.assertEvidenceDocument(company.id, dto.guardId, dto.kind, normalised.evidenceDocumentId);
    }

    try {
      return await this.recordInTransaction(company.id, userId, dto, normalised);
    } catch (error) {
      // Two writers racing to record the first check: the partial unique index rejects the second.
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException('This check has been updated since you opened it. Reload it and try again.');
      }
      throw error;
    }
  }

  private recordInTransaction(companyId: number, userId: number, dto: RecordComplianceCheckDto, normalised: NormalisedCheck) {
    const company = { id: companyId };
    return this.checkRepo.manager.transaction(async (manager) => {
      const current = await this.lockCurrent(manager, company.id, dto.guardId, dto.kind);
      const changeType = dto.changeType ?? 'new_check';
      const changeReason = dto.changeReason?.trim() || null;

      if (current) {
        if (dto.replacesCheckId !== current.id) {
          throw new ConflictException('This check has been updated since you opened it. Reload it and try again.');
        }
        if (changeType === 'correction' && !changeReason) {
          throw new BadRequestException('Give a reason for correcting the check.');
        }
      } else {
        if (dto.replacesCheckId) {
          throw new ConflictException('This check has been updated since you opened it. Reload it and try again.');
        }
        if (changeType === 'correction') {
          throw new BadRequestException('There is no check to correct yet. Record the check instead.');
        }
      }

      const now = new Date();
      if (current) {
        // Superseded first: the partial unique index allows only one current row.
        await manager.update(GuardComplianceCheck, { id: current.id }, { supersededAt: now });
      }
      const saved = await manager.save(
        manager.create(GuardComplianceCheck, {
          ...normalised,
          companyId: company.id,
          guardId: dto.guardId,
          recordedByUserId: userId,
          changeType,
          changeReason,
          supersededAt: null,
          supersededByCheckId: null,
        }),
      );
      if (current) {
        await manager.update(GuardComplianceCheck, { id: current.id }, { supersededByCheckId: saved.id });
      }

      const isAmendment = Boolean(current);
      await manager.save(
        manager.create(AuditLog, {
          company: { id: company.id },
          user: { id: userId },
          action: isAmendment ? 'guard_compliance_check.amended' : 'guard_compliance_check.recorded',
          entityType: 'guard_compliance_check',
          entityId: saved.id,
          beforeData: current ? { ...this.auditShape(current), checkId: current.id } : null,
          afterData: {
            ...this.auditShape(saved),
            checkId: saved.id,
            guardId: saved.guardId,
            changeType,
            changeReason,
            replacesCheckId: current?.id ?? null,
          },
        }),
      );

      return this.toSafe(saved, true);
    });
  }

  /** Full history for one Guard, newest first. compliance.view; evidence references need manage. */
  async listForCompanyUser(userId: number, userRole: UserRole, guardId: number): Promise<SafeComplianceCheck[]> {
    const { company, membershipRole } = await this.membershipService.resolveCompanyContext(
      userId,
      userRole,
      CompanyPermission.COMPLIANCE_VIEW,
    );
    if (!Number.isInteger(guardId) || guardId < 1) throw new BadRequestException('guardId is required');
    const linked = await this.companyGuardRepo.count({ where: { company: { id: company.id }, guard: { id: guardId } } });
    if (!linked) throw new ForbiddenException(NOT_ACTIVE_FOR_COMPANY);
    const canManage = !membershipRole || hasPermission(membershipRole, CompanyPermission.COMPLIANCE_MANAGE);
    const rows = await this.checkRepo.find({
      where: { companyId: company.id, guardId },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return rows.map((row) => this.toSafe(row, canManage));
  }

  /**
   * Validates one check against the vocabulary and the Home Office rules that S4 can apply without
   * interpretation. Everything returned is trimmed and normalised; nothing is defaulted silently.
   */
  normalise(dto: RecordComplianceCheckDto, today: string = complianceToday()): NormalisedCheck {
    const bad = (message: string): never => {
      throw new BadRequestException(message);
    };
    const checkDate = toCalendarDate(dto.checkDate) ?? bad('Enter the date the check was made.');
    if (calendarDaysBetween(today, checkDate) > 0) bad('The check date cannot be in the future.');
    const expiryInput = dto.expiryDate == null || String(dto.expiryDate).trim() === '' ? null : String(dto.expiryDate);
    const expiryDate = expiryInput === null ? null : toCalendarDate(expiryInput) ?? bad('Enter a valid expiry date.');
    const checkedByName = dto.checkedByName?.trim() || bad('Enter who carried out the check.');
    const evidenceReference = dto.evidenceReference?.trim() || null;
    const evidenceDocumentId = dto.evidenceDocumentId ?? null;
    if (!evidenceReference && !evidenceDocumentId) {
      bad('Enter where the evidence of this check is kept, or link the evidence document.');
    }
    const workRestrictions = dto.workRestrictions?.trim() || null;
    const confirmed = dto.outcome === 'confirmed';

    if (dto.kind === 'sia') {
      if (!(SIA_CHECK_METHODS as readonly string[]).includes(dto.method)) bad('Choose how the SIA licence was checked.');
      if (dto.rightToWorkExcuse) bad('A right to work excuse does not apply to an SIA check.');
      if (workRestrictions) bad('Work restrictions apply to a right to work check, not an SIA check.');
      const licenceNumber = (dto.licenceNumber ?? '').replace(/[\s-]/g, '');
      if (!SIA_LICENCE_NUMBER_PATTERN.test(licenceNumber)) bad('Enter the 16-digit SIA licence number that was checked.');
      if (confirmed) {
        if (!expiryDate) bad('Enter the SIA licence expiry date.');
        if (calendarDaysBetween(checkDate, expiryDate!) < 0) {
          bad('The licence had already expired on the check date. Record the check as not confirmed.');
        }
      }
      return {
        kind: 'sia', outcome: dto.outcome, method: dto.method, rightToWorkExcuse: null, licenceNumber,
        checkDate, expiryDate, workRestrictions: null, checkedByName, evidenceReference, evidenceDocumentId,
      };
    }

    if (!(RIGHT_TO_WORK_CHECK_METHODS as readonly string[]).includes(dto.method)) bad('Choose how the right to work was checked.');
    if (dto.licenceNumber) bad('A licence number does not apply to a right to work check.');
    const method = dto.method as (typeof RIGHT_TO_WORK_CHECK_METHODS)[number];
    let excuse: RightToWorkExcuse | null = null;
    if (confirmed) {
      excuse = (dto.rightToWorkExcuse as RightToWorkExcuse | undefined) ?? bad('Choose whether the right to work is continuous or time-limited.');
      if (!EXCUSES_BY_RIGHT_TO_WORK_METHOD[method].includes(excuse)) {
        bad(method === 'employer_checking_service'
          ? 'An Employer Checking Service result is a Positive Verification Notice (six months).'
          : 'A Positive Verification Notice comes only from the Employer Checking Service.');
      }
      if (excuse === 'continuous') {
        if (expiryDate) bad('A continuous right to work has no expiry date.');
      } else {
        if (!expiryDate) {
          bad(excuse === 'time_limited_pvn'
            ? 'Enter the date the Positive Verification Notice excuse ends.'
            : 'Enter the date the permission to work ends.');
        }
        if (calendarDaysBetween(checkDate, expiryDate!) < 0) {
          bad('The permission had already ended on the check date. Record the check as not confirmed.');
        }
        if (excuse === 'time_limited_pvn' && calendarDaysBetween(addCalendarMonths(checkDate, PVN_EXCUSE_MONTHS), expiryDate!) > 0) {
          bad('A Positive Verification Notice gives an excuse for six months from its date, no longer.');
        }
      }
    } else {
      if (dto.rightToWorkExcuse) bad('A check that did not confirm the right to work has no excuse type.');
      if (expiryDate) bad('A check that did not confirm the right to work has no expiry date.');
    }
    return {
      kind: 'right_to_work', outcome: dto.outcome, method, rightToWorkExcuse: excuse, licenceNumber: null,
      checkDate, expiryDate: confirmed ? expiryDate : null, workRestrictions, checkedByName, evidenceReference,
      evidenceDocumentId,
    };
  }

  /**
   * Writes need an ACTIVE relationship. A pre-hire candidate, an ended or a blocked relationship, an
   * unrelated Guard and a non-existent Guard all get the same 403, so ids cannot be probed.
   */
  private async assertActiveRelationship(companyId: number, guardId: number) {
    if (!Number.isInteger(guardId) || guardId < 1) throw new ForbiddenException(NOT_ACTIVE_FOR_COMPANY);
    const active = await this.companyGuardRepo.count({
      where: { company: { id: companyId }, guard: { id: guardId }, status: CompanyGuardStatus.ACTIVE },
    });
    if (!active) throw new ForbiddenException(NOT_ACTIVE_FOR_COMPANY);
  }

  /** Evidence must be this company's own completed upload, for this Guard, of the matching type. */
  private async assertEvidenceDocument(companyId: number, guardId: number, kind: ComplianceCheckKind, documentId: number) {
    const document = await this.guardDocumentRepo.findOne({
      where: {
        id: documentId,
        company: { id: companyId },
        guard: { id: guardId },
        type: EVIDENCE_TYPE_BY_KIND[kind],
        uploadCompletedAt: Not(IsNull()),
      },
    });
    if (!document) {
      throw new BadRequestException('That evidence document is not a completed upload of the right type for this Guard.');
    }
  }

  private async lockCurrent(manager: EntityManager, companyId: number, guardId: number, kind: string) {
    return manager.findOne(GuardComplianceCheck, {
      where: { companyId, guardId, kind, supersededAt: IsNull() },
      lock: { mode: 'pessimistic_write' },
    });
  }

  private auditShape(check: GuardComplianceCheck) {
    return {
      kind: check.kind,
      outcome: check.outcome,
      method: check.method,
      rightToWorkExcuse: check.rightToWorkExcuse,
      licenceNumber: check.licenceNumber,
      checkDate: check.checkDate,
      expiryDate: check.expiryDate,
      workRestrictions: check.workRestrictions,
      checkedByName: check.checkedByName,
      evidenceReference: check.evidenceReference,
      evidenceDocumentId: check.evidenceDocumentId,
    };
  }

  toSafe(check: GuardComplianceCheck, includeEvidence: boolean): SafeComplianceCheck {
    return {
      id: check.id,
      guardId: check.guardId,
      kind: check.kind,
      outcome: check.outcome,
      method: check.method,
      rightToWorkExcuse: check.rightToWorkExcuse ?? null,
      licenceNumber: check.licenceNumber ?? null,
      checkDate: toCalendarDate(check.checkDate) ?? String(check.checkDate),
      expiryDate: toCalendarDate(check.expiryDate),
      workRestrictions: check.workRestrictions ?? null,
      checkedByName: check.checkedByName,
      evidenceReference: includeEvidence ? check.evidenceReference ?? null : null,
      evidenceDocumentId: includeEvidence ? check.evidenceDocumentId ?? null : null,
      recordedByUserId: check.recordedByUserId ?? null,
      changeType: check.changeType,
      changeReason: check.changeReason ?? null,
      supersededAt: check.supersededAt ?? null,
      supersededByCheckId: check.supersededByCheckId ?? null,
      createdAt: check.createdAt,
    };
  }
}
