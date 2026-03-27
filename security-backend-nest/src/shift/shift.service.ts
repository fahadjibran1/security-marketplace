import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Shift } from './entities/shift.entity';
import { CreateShiftDto } from './dto/create-shift.dto';
import { AssignmentService } from '../assignment/assignment.service';
import { TimesheetService } from '../timesheet/timesheet.service';
import { SiteService } from '../site/site.service';
import { Company } from '../company/entities/company.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { Job } from '../job/entities/job.entity';
import { JobApplication } from '../job-application/entities/job-application.entity';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CompanyService } from '../company/company.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { isCompanyRole, UserRole } from '../user/entities/user.entity';
import { CompanyGuardService } from '../company-guard/company-guard.service';

@Injectable()
export class ShiftService {
  constructor(
    @InjectRepository(Shift)
    private readonly shiftRepo: Repository<Shift>,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(GuardProfile)
    private readonly guardRepo: Repository<GuardProfile>,
    @InjectRepository(Job)
    private readonly jobRepo: Repository<Job>,
    @InjectRepository(JobApplication)
    private readonly jobApplicationRepo: Repository<JobApplication>,
    private readonly assignmentService: AssignmentService,
    private readonly timesheetService: TimesheetService,
    private readonly siteService: SiteService,
    private readonly companyService: CompanyService,
    private readonly guardProfileService: GuardProfileService,
    private readonly companyGuardService: CompanyGuardService,
  ) {}

  async findAll(): Promise<Shift[]> {
    return this.shiftRepo.find({
      relations: ['assignment', 'company', 'guard', 'site', 'job', 'jobApplication'],
      order: { start: 'DESC' },
    });
  }

  async findAllForUser(user: JwtPayload): Promise<Shift[]> {
    if (user.role === UserRole.ADMIN) {
      return this.findAll();
    }

    if (isCompanyRole(user.role)) {
      const company = await this.companyService.findByUserId(user.sub);
      if (!company) {
        throw new NotFoundException('Company not found');
      }

      return this.shiftRepo.find({
        where: { company: { id: company.id } },
        relations: ['assignment', 'company', 'guard', 'site', 'job', 'jobApplication'],
        order: { start: 'DESC' },
      });
    }

    const guard = await this.guardProfileService.findByUserId(user.sub);
    if (!guard) {
      throw new NotFoundException('Guard profile not found');
    }

    return this.shiftRepo.find({
      where: { guard: { id: guard.id } },
      relations: ['assignment', 'company', 'guard', 'site', 'job', 'jobApplication'],
      order: { start: 'DESC' },
    });
  }

  async getGuardShifts(user: JwtPayload): Promise<Shift[]> {
    const guard = await this.guardProfileService.findByUserId(user.sub);
    if (!guard) {
      throw new NotFoundException('Guard profile not found');
    }

    return this.shiftRepo.find({
      where: { guard: { id: guard.id } },
      relations: ['assignment', 'company', 'guard', 'site', 'job', 'jobApplication'],
      order: { start: 'DESC' },
    });
  }

  async findOne(id: number): Promise<Shift> {
    const shift = await this.shiftRepo.findOne({
      where: { id },
      relations: ['assignment', 'company', 'guard', 'site', 'job', 'jobApplication'],
    });

    if (!shift) {
      throw new NotFoundException(`Shift with id ${id} not found`);
    }

    return shift;
  }

  async findOneForUser(user: JwtPayload, id: number): Promise<Shift> {
    const shift = await this.findOne(id);

    if (user.role === UserRole.ADMIN) {
      return shift;
    }

    if (isCompanyRole(user.role)) {
      const company = await this.companyService.findByUserId(user.sub);
      if (!company || shift.company.id !== company.id) {
        throw new NotFoundException(`Shift with id ${id} not found`);
      }
      return shift;
    }

    const guard = await this.guardProfileService.findByUserId(user.sub);
    if (!guard || shift.guard.id !== guard.id) {
      throw new NotFoundException(`Shift with id ${id} not found`);
    }

    return shift;
  }

  async create(dto: CreateShiftDto) {
    const start = new Date(dto.start);
    const end = new Date(dto.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Shift start and end must be valid dates');
    }
    if (end <= start) {
      throw new BadRequestException('Shift end must be after shift start');
    }

    if (!dto.siteId) {
      throw new BadRequestException('Shift creation requires a siteId');
    }

    const assignment = dto.assignmentId
      ? await this.assignmentService.findOne(dto.assignmentId)
      : null;

    const jobApplication = dto.jobApplicationId
      ? await this.jobApplicationRepo.findOne({
          where: { id: dto.jobApplicationId },
          relations: ['job', 'job.company', 'guard'],
        })
      : assignment?.application ?? null;

    const job = dto.jobId
      ? await this.jobRepo.findOne({
          where: { id: dto.jobId },
          relations: ['company', 'site'],
        })
      : assignment?.job ?? jobApplication?.job ?? null;

    const company = dto.companyId
      ? await this.companyRepo.findOne({
          where: { id: dto.companyId },
          relations: ['user'],
        })
      : assignment?.company ?? job?.company ?? null;

    const guard = dto.guardId
      ? await this.guardRepo.findOne({
          where: { id: dto.guardId },
          relations: ['user'],
        })
      : assignment?.guard ?? jobApplication?.guard ?? null;

    const siteId = dto.siteId;
    const site = await this.siteService.findOne(siteId);
    const normalizedStatus = dto.status?.trim().toLowerCase();
    const allowedStatuses = new Set(['draft', 'assigned', 'in_progress', 'completed']);

    if (!company) {
      throw new NotFoundException('Company context is required to create a shift');
    }

    if (!guard) {
      throw new NotFoundException('Guard assignment context is required to create a shift');
    }

    if (normalizedStatus && !allowedStatuses.has(normalizedStatus)) {
      throw new BadRequestException('Shift status is invalid');
    }

    const shift = new Shift();
    shift.assignment = assignment;
    shift.company = company;
    shift.guard = guard;
    shift.site = site;
    shift.job = job;
    shift.jobApplication = jobApplication;
    shift.createdByUserId = dto.createdByUserId ?? company.user?.id ?? null;
    shift.siteName = site.name;
    shift.start = start;
    shift.end = end;
    shift.checkCallIntervalMinutes =
      dto.checkCallIntervalMinutes ?? site.welfareCheckIntervalMinutes ?? 60;
    shift.status = normalizedStatus ?? 'assigned';

    const savedShift: Shift = await this.shiftRepo.save(shift);
    const timesheet = await this.timesheetService.createForShift(savedShift);

    return { shift: savedShift, timesheet };
  }

  async createForUser(user: JwtPayload, dto: CreateShiftDto) {
    if (user.role === UserRole.ADMIN) {
      return this.create(dto);
    }

    const company = await this.companyService.findByUserId(user.sub);
    if (!company) {
      throw new NotFoundException('Company not found');
    }

    const assignment = dto.assignmentId
      ? await this.assignmentService.findOne(dto.assignmentId)
      : null;

    if (assignment && assignment.company.id !== company.id) {
      throw new ForbiddenException('Assignment does not belong to the current company');
    }

    const jobApplication = dto.jobApplicationId
      ? await this.jobApplicationRepo.findOne({
          where: { id: dto.jobApplicationId },
          relations: ['job', 'job.company', 'guard'],
        })
      : assignment?.application ?? null;

    if (jobApplication && jobApplication.job.company.id !== company.id) {
      throw new ForbiddenException('Job application does not belong to the current company');
    }

    const directGuard = dto.guardId
      ? await this.guardProfileService.findOne(dto.guardId)
      : null;
    const contextGuard = assignment?.guard ?? jobApplication?.guard ?? directGuard ?? null;
    if (!contextGuard) {
      throw new ForbiddenException('Shift creation requires a validated guard context');
    }

    if ((assignment || jobApplication) && dto.guardId && dto.guardId !== contextGuard.id) {
      throw new ForbiddenException(
        'Guard must match the validated assignment or application context',
      );
    }

    if (!assignment && !jobApplication) {
      await this.companyGuardService.ensureActiveRelationship(company.id, contextGuard.id);
    }

    const job = dto.jobId
      ? await this.jobRepo.findOne({
          where: { id: dto.jobId },
          relations: ['company', 'site'],
        })
      : assignment?.job ?? jobApplication?.job ?? null;

    if (job && job.company.id !== company.id) {
      throw new ForbiddenException('Job does not belong to the current company');
    }

    if (!dto.siteId) {
      throw new BadRequestException('Shift creation requires a siteId');
    }

    const siteId = dto.siteId;
    const site = await this.siteService.findOne(siteId);
    if (site.company.id !== company.id) {
      throw new ForbiddenException('Site does not belong to the current company');
    }

    return this.create({
      ...dto,
      assignmentId: assignment?.id ?? dto.assignmentId,
      companyId: company.id,
      guardId: contextGuard.id,
      jobId: job?.id ?? dto.jobId,
      jobApplicationId: jobApplication?.id ?? dto.jobApplicationId,
      createdByUserId: user.sub,
      siteId: site.id,
      checkCallIntervalMinutes:
        dto.checkCallIntervalMinutes ?? site.welfareCheckIntervalMinutes ?? undefined,
      status: dto.status ?? 'assigned',
    });
  }

  save(shift: Shift): Promise<Shift> {
    return this.shiftRepo.save(shift);
  }
}
