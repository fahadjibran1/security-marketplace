import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { UserRole } from '../user/entities/user.entity';

type AuditLogInput = {
  company?: { id: number } | null;
  user?: { id: number } | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  beforeData?: Record<string, unknown> | null;
  afterData?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

@Injectable()
export class AuditLogService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
    private readonly membershipService: CompanyMembershipService,
  ) {}

  log(input: AuditLogInput): Promise<AuditLog> {
    const logEntry = this.auditLogRepo.create({
      company: input.company ?? null,
      user: input.user ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      beforeData: input.beforeData ?? null,
      afterData: input.afterData ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });

    return this.auditLogRepo.save(logEntry);
  }

  findAll(): Promise<AuditLog[]> {
    return this.auditLogRepo.find({ order: { createdAt: 'DESC' } });
  }

  async findForCompany(userId: number, userRole: UserRole): Promise<AuditLog[]> {
    const { company } = await this.membershipService.resolveCompanyContext(
      userId, userRole, CompanyPermission.COMPLIANCE_VIEW,
    );
    return this.auditLogRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    });
  }
}
