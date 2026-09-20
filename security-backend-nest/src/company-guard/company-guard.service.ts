import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  CompanyGuard,
  CompanyGuardRelationshipType,
  CompanyGuardStatus,
} from './entities/company-guard.entity';
import { CreateCompanyGuardDto } from './dto/create-company-guard.dto';
import { UpdateCompanyGuardDto } from './dto/update-company-guard.dto';
import { CompanyService } from '../company/company.service';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { UserRole } from '../user/entities/user.entity';
import { ComplianceService } from '../compliance/compliance.service';

@Injectable()
export class CompanyGuardService {
  constructor(
    @InjectRepository(CompanyGuard) private readonly companyGuardRepo: Repository<CompanyGuard>,
    private readonly companyService: CompanyService,
    private readonly membershipService: CompanyMembershipService,
    private readonly guardService: GuardProfileService,
    private readonly complianceService: ComplianceService,
    private readonly auditLogService: AuditLogService,
  ) {}

  findAll(): Promise<CompanyGuard[]> {
    return this.companyGuardRepo.find();
  }

  async findAllForUser(user: JwtPayload): Promise<CompanyGuard[]> {
    if (user.role === UserRole.ADMIN) {
      return this.findAll();
    }

    const { company } = await this.membershipService.resolveCompanyContext(user.sub, user.role, CompanyPermission.GUARDS_VIEW);

    return this.companyGuardRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    });
  }

  async create(dto: CreateCompanyGuardDto): Promise<CompanyGuard> {
    const company = await this.companyService.findOne(dto.companyId);
    return this.createForCompany(company.id, dto);
  }

  async createForUser(user: JwtPayload, dto: CreateCompanyGuardDto): Promise<CompanyGuard> {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Direct guard-pool membership requires platform administration or an accepted application');
    }
    return this.create(dto);
  }

  /**
   * Company-authorised link: creates or confirms an ACTIVE CompanyGuard for the
   * authenticated company. Does not run compliance/eligibility checks — those
   * happen at shift-assignment time. Idempotent if relationship already ACTIVE.
   */
  async linkForCompanyUser(user: JwtPayload, guardId: number): Promise<CompanyGuard> {
    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.GUARDS_MANAGE,
    );

    const guard = await this.guardService.findOne(guardId);

    const existing = await this.companyGuardRepo.findOne({
      where: { company: { id: company.id }, guard: { id: guard.id } },
    });

    if (existing) {
      if (existing.status === CompanyGuardStatus.ACTIVE) {
        return existing;
      }
      // Re-activate previously INACTIVE/BLOCKED relationship
      const before = { status: existing.status };
      existing.status = CompanyGuardStatus.ACTIVE;
      const saved = await this.companyGuardRepo.save(existing);
      await this.auditLogService.log({
        company: { id: company.id },
        user: { id: user.sub },
        action: 'company_guard.linked',
        entityType: 'company_guard',
        entityId: saved.id,
        beforeData: before,
        afterData: { status: CompanyGuardStatus.ACTIVE, guardId: guard.id, companyId: company.id },
      });
      return saved;
    }

    const row = this.companyGuardRepo.create({
      company,
      guard,
      status: CompanyGuardStatus.ACTIVE,
      relationshipType: CompanyGuardRelationshipType.APPROVED_CONTRACTOR,
    });
    const saved = await this.companyGuardRepo.save(row);
    await this.auditLogService.log({
      company: { id: company.id },
      user: { id: user.sub },
      action: 'company_guard.linked',
      entityType: 'company_guard',
      entityId: saved.id,
      beforeData: null,
      afterData: { status: CompanyGuardStatus.ACTIVE, guardId: guard.id, companyId: company.id },
    });
    return saved;
  }

  /**
   * Company-authorised status update: ACTIVE ↔ INACTIVE / BLOCKED.
   * Tenant-scoped — company resolved from membership, never trusted from client.
   */
  async updateStatusForCompanyUser(
    user: JwtPayload,
    companyGuardId: number,
    dto: UpdateCompanyGuardDto,
  ): Promise<CompanyGuard> {
    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.GUARDS_MANAGE,
    );

    const relation = await this.companyGuardRepo.findOne({
      where: { id: companyGuardId, company: { id: company.id } },
    });

    if (!relation) {
      throw new NotFoundException('Company guard relationship not found.');
    }

    const before = { status: relation.status };
    relation.status = dto.status;
    const saved = await this.companyGuardRepo.save(relation);
    await this.auditLogService.log({
      company: { id: company.id },
      user: { id: user.sub },
      action: 'company_guard.status_changed',
      entityType: 'company_guard',
      entityId: saved.id,
      beforeData: before,
      afterData: { status: dto.status, guardId: relation.guard.id, companyId: company.id },
    });
    return saved;
  }

  private async createForCompany(companyId: number, dto: CreateCompanyGuardDto): Promise<CompanyGuard> {
    const company = await this.companyService.findOne(companyId);
    const guard = await this.guardService.findOne(dto.guardId);
    if ((dto.status ?? CompanyGuardStatus.ACTIVE) === CompanyGuardStatus.ACTIVE) {
      await this.complianceService.assertGuardAssignable(company.id, guard.id);
    }

    const exists = await this.companyGuardRepo.findOne({
      where: { company: { id: company.id }, guard: { id: guard.id } },
    });
    if (exists) throw new ConflictException('Company-guard relationship already exists');

    const row = this.companyGuardRepo.create({
      company,
      guard,
      status: dto.status ?? CompanyGuardStatus.ACTIVE,
      relationshipType: dto.relationshipType,
    });

    return this.companyGuardRepo.save(row);
  }

  async ensureActiveRelationship(companyId: number, guardId: number): Promise<CompanyGuard> {
    const relation = await this.companyGuardRepo.findOne({
      where: { company: { id: companyId }, guard: { id: guardId }, status: CompanyGuardStatus.ACTIVE },
    });

    if (!relation) {
      throw new ForbiddenException('Guard is not active/approved for this company');
    }

    return relation;
  }

  async ensureRelationship(params: {
    companyId: number;
    guardId: number;
    relationshipType?: CompanyGuard['relationshipType'];
  }, manager?: EntityManager): Promise<CompanyGuard> {
    const relationRepo = manager?.getRepository(CompanyGuard) ?? this.companyGuardRepo;
    const company = await this.companyService.findOne(params.companyId);
    const guard = await this.guardService.findOne(params.guardId);
    await this.complianceService.assertGuardAssignable(company.id, guard.id);

    const existing = await relationRepo.findOne({
      where: { company: { id: company.id }, guard: { id: guard.id } },
    });

    const relation =
      existing ??
      relationRepo.create({
        company,
        guard,
        relationshipType:
          params.relationshipType ?? CompanyGuardRelationshipType.APPROVED_CONTRACTOR,
      });

    relation.status = CompanyGuardStatus.ACTIVE;
    relation.relationshipType =
      params.relationshipType ??
      relation.relationshipType ??
      CompanyGuardRelationshipType.APPROVED_CONTRACTOR;
    return relationRepo.save(relation);
  }
}
