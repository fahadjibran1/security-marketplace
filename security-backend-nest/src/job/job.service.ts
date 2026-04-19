import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from './entities/job.entity';
import { CreateJobDto } from './dto/create-job.dto';
import { CompanyService } from '../company/company.service';
import { SiteService } from '../site/site.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { isCompanyRole, UserRole } from '../user/entities/user.entity';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class JobService {
  constructor(
    @InjectRepository(Job) private readonly jobRepo: Repository<Job>,
    private readonly companyService: CompanyService,
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

  async findAllForUser(user: JwtPayload): Promise<Job[]> {
    if (user.role === UserRole.ADMIN) {
      return this.findAll();
    }

    if (isCompanyRole(user.role)) {
      const company = await this.companyService.findByUserId(user.sub);
      if (!company) {
        throw new NotFoundException('Company not found');
      }

      return this.jobRepo.find({
        where: { company: { id: company.id } },
        order: { id: 'DESC' },
      });
    }

    return this.jobRepo.find({
      where: { status: 'open' },
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number): Promise<Job> {
    const job = await this.jobRepo.findOne({ where: { id } });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  async findOneForUser(user: JwtPayload, id: number): Promise<Job> {
    const job = await this.findOne(id);

    if (user.role === UserRole.ADMIN) {
      return job;
    }

    if (isCompanyRole(user.role)) {
      const company = await this.companyService.findByUserId(user.sub);
      if (!company || job.company.id !== company.id) {
        throw new NotFoundException('Job not found');
      }
      return job;
    }

    if (job.status !== 'open') {
      throw new NotFoundException('Job not found');
    }

    return job;
  }

  async createForUser(user: JwtPayload, dto: CreateJobDto): Promise<Job> {
    if (user.role === UserRole.ADMIN) {
      return this.create(dto);
    }

    const company = await this.companyService.findByUserId(user.sub);
    if (!company) {
      throw new NotFoundException('Company not found');
    }

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

  save(job: Job): Promise<Job> {
    return this.jobRepo.save(job);
  }
}
