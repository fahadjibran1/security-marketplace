import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Job } from './entities/job.entity';
import { CreateJobDto } from './dto/create-job.dto';
import { CompanyService } from '../company/company.service';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { SiteService } from '../site/site.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { isCompanyRole, UserRole } from '../user/entities/user.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { GuardJobView, toGuardJobView } from './dto/guard-job.view';
import { CompanyVerificationStatus, isCompanyApproved } from '../company/company-verification';

@Injectable()
export class JobService {
  constructor(
    @InjectRepository(Job) private readonly jobRepo: Repository<Job>,
    private readonly companyService: CompanyService,
    private readonly membershipService: CompanyMembershipService,
    private readonly siteService: SiteService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreateJobDto): Promise<Job> {
    if (!dto.companyId) {
      throw new BadRequestException('companyId is required for admin job creation');
    }

    const company = await this.companyService.findOne(dto.companyId);
    const site = dto.siteId ? await this.siteService.findOne(dto.siteId) : null;
    const job = this.jobRepo.create({
      company,
      site,
      title: dto.title,
      description: dto.description,
      guardsRequired: dto.guardsRequired,
      hourlyRate: dto.hourlyRate,
      billingRate: dto.billingRate ?? null,
      status: dto.status ?? 'open'
    });
    const saved = await this.jobRepo.save(job);
    await this.auditLogService.log({
      company,
      user: company.user ? { id: company.user.id } : null,
      action: 'job.created',
      entityType: 'job',
      entityId: saved.id,
      beforeData: null,
      afterData: {
        hourlyRate: saved.hourlyRate,
        billingRate: saved.billingRate,
        status: saved.status,
        siteId: saved.site?.id ?? null,
      },
    });
    return saved;
  }

  findAll(): Promise<Job[]> {
    return this.jobRepo.find();
  }

  async findAllForUser(user: JwtPayload): Promise<Job[] | GuardJobView[]> {
    if (user.role === UserRole.ADMIN) {
      return this.findAll();
    }

    if (isCompanyRole(user.role)) {
      const { company } = await this.membershipService.resolveCompanyContext(user.sub, user.role, CompanyPermission.SHIFTS_VIEW);

      return this.jobRepo.find({
        where: { company: { id: company.id } },
        order: { id: 'DESC' },
      });
    }

    // SEC-PUBLIC-01 / 03: a Guard discovers only the open jobs of APPROVED companies, and only through the Guard view —
    // never the raw entity, whose eager relations carry the company owner's account, the site's client contacts and
    // the billing rate of every tenant.
    if (user.role !== UserRole.GUARD) throw new NotFoundException('Job not found');
    const jobs = await this.jobRepo.find({
      where: { status: 'open', company: { verificationStatus: CompanyVerificationStatus.APPROVED } },
      order: { id: 'DESC' },
    });
    return jobs.map(toGuardJobView);
  }

  /**
   * A job a Guard may apply for: open, and posted by an APPROVED company. Anything else is "Job not found", the same
   * answer as for an id that does not exist, so a Guard cannot probe for unapproved companies' jobs.
   */
  async findApplicableForGuard(id: number): Promise<Job> {
    const job = await this.findOne(id);
    if (job.status !== 'open' || !isCompanyApproved(job.company)) {
      throw new NotFoundException('Job not found');
    }
    return job;
  }

  async findOne(id: number): Promise<Job> {
    const job = await this.jobRepo.findOne({ where: { id } });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  async findOneForUser(user: JwtPayload, id: number): Promise<Job | GuardJobView> {
    if (user.role === UserRole.ADMIN) {
      return this.findOne(id);
    }

    if (isCompanyRole(user.role)) {
      const job = await this.findOne(id);
      const { company } = await this.membershipService.resolveCompanyContext(user.sub, user.role, CompanyPermission.SHIFTS_VIEW);
      if (job.company.id !== company.id) {
        throw new NotFoundException('Job not found');
      }
      return job;
    }

    if (user.role !== UserRole.GUARD) throw new NotFoundException('Job not found');
    return toGuardJobView(await this.findApplicableForGuard(id));
  }

  async createForUser(user: JwtPayload, dto: CreateJobDto): Promise<Job> {
    if (user.role === UserRole.ADMIN) {
      return this.create(dto);
    }

    const { company } = await this.membershipService.resolveCompanyContext(user.sub, user.role, CompanyPermission.SHIFTS_MANAGE);

    const site = dto.siteId ? await this.siteService.findOne(dto.siteId) : null;
    if (site && site.company.id !== company.id) {
      throw new ForbiddenException('Site does not belong to the current company');
    }

    const job = this.jobRepo.create({
      company,
      site,
      title: dto.title,
      description: dto.description,
      guardsRequired: dto.guardsRequired,
      hourlyRate: dto.hourlyRate,
      billingRate: dto.billingRate ?? null,
      status: dto.status ?? 'open',
    });

    const saved = await this.jobRepo.save(job);
    await this.auditLogService.log({
      company,
      user: { id: user.sub },
      action: 'job.created',
      entityType: 'job',
      entityId: saved.id,
      beforeData: null,
      afterData: {
        hourlyRate: saved.hourlyRate,
        billingRate: saved.billingRate,
        status: saved.status,
        siteId: saved.site?.id ?? null,
      },
    });
    return saved;
  }

  save(job: Job, manager?: EntityManager): Promise<Job> {
    return (manager?.getRepository(Job) ?? this.jobRepo).save(job);
  }
}
