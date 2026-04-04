import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobApplication } from './entities/job-application.entity';
import { CreateJobApplicationDto } from './dto/create-job-application.dto';
import { JobService } from '../job/job.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { AssignmentService } from '../assignment/assignment.service';
import { HireApplicationDto } from './dto/hire-application.dto';
import { ShiftService } from '../shift/shift.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification.entity';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { isCompanyRole, UserRole } from '../user/entities/user.entity';
import { CompanyService } from '../company/company.service';
import { SiteService } from '../site/site.service';

@Injectable()
export class JobApplicationService {
  constructor(
    @InjectRepository(JobApplication)
    private readonly appRepo: Repository<JobApplication>,
    private readonly jobsService: JobService,
    private readonly guardService: GuardProfileService,
    private readonly assignmentService: AssignmentService,
    private readonly shiftService: ShiftService,
    private readonly auditLogService: AuditLogService,
    private readonly notificationService: NotificationService,
    private readonly companyService: CompanyService,
    private readonly siteService: SiteService,
  ) {}

  findAll(): Promise<JobApplication[]> {
    return this.appRepo.find();
  }

  private async resolveGuardForUser(user: JwtPayload) {
    const guard = await this.guardService.findByUserId(user.sub);
    if (!guard) {
      throw new NotFoundException('Guard profile not found');
    }

    return guard;
  }

  private async createForGuard(jobId: number, guardId: number): Promise<JobApplication> {
    const job = await this.jobsService.findOne(jobId);
    const guard = await this.guardService.findOne(guardId);

    const existing = await this.appRepo.findOne({
      where: {
        job: { id: job.id },
        guard: { id: guard.id },
      },
    });

    if (existing) {
      throw new ConflictException('Application already exists for this guard/job');
    }

    const application = this.appRepo.create({ job, guard, status: 'submitted' });
    return this.appRepo.save(application);
  }

  async findAllForUser(user: JwtPayload): Promise<JobApplication[]> {
    if (user.role === UserRole.ADMIN) {
      return this.findAll();
    }

    if (isCompanyRole(user.role)) {
      const company = await this.companyService.findByUserId(user.sub);
      if (!company) {
        throw new NotFoundException('Company not found');
      }

      return this.appRepo.find({
        where: { job: { company: { id: company.id } } },
        order: { appliedAt: 'DESC' },
      });
    }

    const guard = await this.guardService.findByUserId(user.sub);
    if (!guard) {
      throw new NotFoundException('Guard profile not found');
    }

    return this.appRepo.find({
      where: { guard: { id: guard.id } },
      order: { appliedAt: 'DESC' },
    });
  }

  async findOne(id: number): Promise<JobApplication> {
    const app = await this.appRepo.findOne({ where: { id } });
    if (!app) throw new NotFoundException('Job application not found');
    return app;
  }

  async create(dto: CreateJobApplicationDto, guardId: number): Promise<JobApplication> {
    return this.createForGuard(dto.jobId, guardId);
  }

  async createForUser(user: JwtPayload, dto: CreateJobApplicationDto): Promise<JobApplication> {
    if (user.role === UserRole.ADMIN) {
      throw new BadRequestException('Admin job application creation requires an explicit guard selection flow');
    }

    const guard = await this.resolveGuardForUser(user);

    return this.create(dto, guard.id);
  }

  async hire(applicationId: number, dto: HireApplicationDto) {
    const application = await this.findOne(applicationId);
    if (application.status === 'hired') throw new ConflictException('Application already hired');

    const activeCount = await this.assignmentService.countActiveByJob(application.job.id);
    if (activeCount >= application.job.guardsRequired) {
      throw new ConflictException('Job guard capacity reached');
    }

    application.status = 'hired';
    application.hiredAt = new Date();
    await this.appRepo.save(application);

    const assignment = await this.assignmentService.createFromHire(application);
    const updatedActiveCount = await this.assignmentService.countActiveByJob(application.job.id);
    application.job.status = updatedActiveCount >= application.job.guardsRequired ? 'filled' : 'open';
    await this.jobsService.save(application.job);

    let shiftResult: unknown = null;
    if (dto.createShift) {
      if ((!dto.siteName && !dto.siteId) || !dto.start || !dto.end) {
        throw new BadRequestException('siteId or siteName, start, end are required when createShift=true');
      }

      shiftResult = await this.shiftService.create({
        assignmentId: assignment.id,
        siteId: dto.siteId,
        siteName: dto.siteName,
        start: dto.start,
        end: dto.end
      });
    }

    await this.auditLogService.log({
      company: application.job.company,
      user: application.job.company?.user ? { id: application.job.company.user.id } : null,
      action: 'job_application.hired',
      entityType: 'job_application',
      entityId: application.id,
      afterData: {
        applicationStatus: application.status,
        assignmentId: assignment.id,
      },
    });

    if (application.guard?.user?.id) {
      await this.notificationService.createForUser({
        userId: application.guard.user.id,
        company: application.job.company,
        type: NotificationType.JOB_ASSIGNED,
        title: 'Job assigned',
        message: `You have been hired for ${application.job.title}.`,
      });
    }

    return {
      application,
      assignment,
      shiftBundle: shiftResult
    };
  }

  async hireForUser(user: JwtPayload, applicationId: number, dto: HireApplicationDto) {
    const application = await this.findOne(applicationId);

    if (user.role !== UserRole.ADMIN) {
      const company = await this.companyService.findByUserId(user.sub);
      if (!company) {
        throw new NotFoundException('Company not found');
      }

      if (application.job.company.id !== company.id) {
        throw new ForbiddenException('Job application does not belong to the current company');
      }

      if (dto.siteId) {
        const site = await this.siteService.findOne(dto.siteId);
        if (site.company.id !== company.id) {
          throw new ForbiddenException('Site does not belong to the current company');
        }
      }
    }

    return this.hire(applicationId, dto);
  }
}
