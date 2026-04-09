import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
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
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { UpdateShiftDto } from './dto/update-shift.dto';
import { RespondShiftDto } from './dto/respond-shift.dto';

@Injectable()
export class ShiftService {
  private readonly allowedStatuses = new Set([
    'unfilled',
    'offered',
    'ready',
    'cancelled',
    'rejected',
    'in_progress',
    'completed',
  ]);

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
    @InjectRepository(Timesheet)
    private readonly timesheetRepo: Repository<Timesheet>,
    private readonly assignmentService: AssignmentService,
    private readonly timesheetService: TimesheetService,
    @Inject(forwardRef(() => SiteService))
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
    if (!guard || !shift.guard || shift.guard.id !== guard.id) {
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
    const normalizedStatus = this.normalizeLifecycleStatus(dto.status);

    if (!company) {
      throw new NotFoundException('Company context is required to create a shift');
    }

    if (normalizedStatus && !this.allowedStatuses.has(normalizedStatus)) {
      throw new BadRequestException('Shift status is invalid');
    }

    const status = this.resolveInitialStatus({
      requestedStatus: normalizedStatus,
      hasGuard: Boolean(guard),
    });

    const shift = new Shift();
    shift.assignment = assignment;
    shift.company = company;
    shift.guard = guard ?? null;
    shift.site = site;
    shift.job = job;
    shift.jobApplication = jobApplication;
    shift.createdByUserId = dto.createdByUserId ?? company.user?.id ?? null;
    shift.siteName = site.name;
    shift.start = start;
    shift.end = end;
    shift.checkCallIntervalMinutes =
      dto.checkCallIntervalMinutes ?? site.welfareCheckIntervalMinutes ?? 60;
    shift.instructions = dto.instructions?.trim() || null;
    shift.status = status;

    const savedShift: Shift = await this.shiftRepo.save(shift);
    const timesheet = savedShift.guard
      ? await this.timesheetService.createForShift(savedShift)
      : null;

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

    if ((assignment || jobApplication) && dto.guardId && contextGuard && dto.guardId !== contextGuard.id) {
      throw new ForbiddenException(
        'Guard must match the validated assignment or application context',
      );
    }

    if (contextGuard && !assignment && !jobApplication) {
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
      guardId: contextGuard?.id,
      jobId: job?.id ?? dto.jobId,
      jobApplicationId: jobApplication?.id ?? dto.jobApplicationId,
      createdByUserId: user.sub,
      siteId: site.id,
      checkCallIntervalMinutes:
        dto.checkCallIntervalMinutes ?? site.welfareCheckIntervalMinutes ?? undefined,
      status: dto.status ?? (contextGuard ? 'offered' : 'unfilled'),
    });
  }

  async createStarterShiftForSite(params: {
    companyId: number;
    siteId: number;
    createdByUserId?: number;
    date: string;
    startTime: string;
    endTime?: string;
    instructions?: string | null;
  }) {
    const start = `${params.date}T${params.startTime}:00`;

    let endDate = params.date;
    let endTime = params.endTime?.trim();
    if (!endTime) {
      const startDate = new Date(start);
      startDate.setHours(startDate.getHours() + 8);
      endDate = startDate.toISOString().slice(0, 10);
      endTime = startDate.toISOString().slice(11, 16);
    } else if (endTime <= params.startTime) {
      const nextDay = new Date(`${params.date}T00:00:00`);
      nextDay.setDate(nextDay.getDate() + 1);
      endDate = nextDay.toISOString().slice(0, 10);
    }

    return this.create({
      companyId: params.companyId,
      siteId: params.siteId,
      createdByUserId: params.createdByUserId,
      start,
      end: `${endDate}T${endTime}:00`,
      status: 'unfilled',
      instructions: params.instructions ?? undefined,
    });
  }

  save(shift: Shift): Promise<Shift> {
    return this.shiftRepo.save(shift);
  }

  async respondForGuard(user: JwtPayload, id: number, dto: RespondShiftDto): Promise<Shift> {
    const shift = await this.findOneForUser(user, id);
    const guard = await this.guardProfileService.findByUserId(user.sub);
    if (!guard) {
      throw new NotFoundException('Guard profile not found');
    }

    if (!shift.guard || shift.guard.id !== guard.id) {
      throw new ForbiddenException('This shift is not assigned to the current guard');
    }

    if (shift.status !== 'offered') {
      throw new BadRequestException('Only offered shifts can be accepted or rejected');
    }

    shift.status = dto.response === 'accepted' ? 'ready' : 'rejected';
    const savedShift = await this.shiftRepo.save(shift);

    return this.findOne(savedShift.id);
  }

  assertGuardCanOperateShift(shift: Shift, guardId: number, action: string): void {
    const assignedGuardId = shift.guard?.id ?? shift.assignment?.guard?.id;
    if (assignedGuardId !== guardId) {
      throw new BadRequestException('This shift is not assigned to the current guard');
    }

    const normalizedStatus = this.normalizeLifecycleStatus(shift.status);
    if (normalizedStatus !== 'in_progress') {
      throw new BadRequestException(
        `Shift must be in progress before a guard can ${action}`,
      );
    }
  }

  async updateForUser(user: JwtPayload, id: number, dto: UpdateShiftDto): Promise<Shift> {
    const shift = await this.findOneForUser(user, id);
    const actorCompany =
      user.role === UserRole.ADMIN ? shift.company : await this.companyService.findByUserId(user.sub);

    if (!actorCompany) {
      throw new NotFoundException('Company not found');
    }

    const nextStart = dto.start ? new Date(dto.start) : shift.start;
    const nextEnd = dto.end ? new Date(dto.end) : shift.end;
    if (Number.isNaN(nextStart.getTime()) || Number.isNaN(nextEnd.getTime())) {
      throw new BadRequestException('Shift start and end must be valid dates');
    }
    if (nextEnd <= nextStart) {
      throw new BadRequestException('Shift end must be after shift start');
    }

    if (dto.siteId && dto.siteId !== shift.site?.id) {
      const site = await this.siteService.findOne(dto.siteId);
      if (site.company.id !== actorCompany.id) {
        throw new ForbiddenException('Site does not belong to the current company');
      }
      shift.site = site;
      shift.siteName = site.name;
      if (!dto.checkCallIntervalMinutes) {
        shift.checkCallIntervalMinutes = site.welfareCheckIntervalMinutes ?? shift.checkCallIntervalMinutes;
      }
    }

    const currentStatus = this.normalizeLifecycleStatus(shift.status);
    let nextGuard = shift.guard ?? null;

    if (dto.guardId !== undefined && dto.guardId !== shift.guard?.id) {
      if (dto.guardId) {
        const guard = await this.guardProfileService.findOne(dto.guardId);
        await this.companyGuardService.ensureActiveRelationship(actorCompany.id, guard.id);
        nextGuard = guard;
      } else {
        nextGuard = null;
      }
    }

    if (dto.start) {
      shift.start = nextStart;
    }
    if (dto.end) {
      shift.end = nextEnd;
    }
    let nextStatus = currentStatus;
    const requestedStatus = dto.status !== undefined ? this.normalizeLifecycleStatus(dto.status) : null;

    if (dto.status?.trim()) {
      nextStatus = this.resolveUpdatedStatus({
        currentStatus,
        requestedStatus,
        currentGuardId: shift.guard?.id ?? null,
        nextGuardId: nextGuard?.id ?? null,
      });
    } else if (dto.guardId !== undefined) {
      nextStatus = this.resolveStatusFromGuardChange({
        currentStatus,
        currentGuardId: shift.guard?.id ?? null,
        nextGuardId: nextGuard?.id ?? null,
      });
    }

    if (nextStatus === 'unfilled') {
      nextGuard = null;
    }

    shift.guard = nextGuard;
    shift.status = nextStatus;
    if (dto.checkCallIntervalMinutes) {
      shift.checkCallIntervalMinutes = dto.checkCallIntervalMinutes;
    }
    if (dto.instructions !== undefined) {
      shift.instructions = dto.instructions?.trim() || null;
    }

    const savedShift = await this.shiftRepo.save(shift);
    const timesheets = await this.timesheetRepo.find({
      where: { shift: { id: savedShift.id } },
      relations: ['shift', 'guard', 'company'],
    });

    if (savedShift.guard && timesheets.length === 0) {
      await this.timesheetService.createForShift(savedShift);
    }

    for (const timesheet of timesheets) {
      timesheet.shift = savedShift;
      if (!savedShift.guard) {
        continue;
      }
      timesheet.guard = savedShift.guard;
      timesheet.company = savedShift.company;
      timesheet.scheduledStartAt = savedShift.start;
      timesheet.scheduledEndAt = savedShift.end;
      await this.timesheetRepo.save(timesheet);
    }

    return this.findOne(savedShift.id);
  }

  async removeForUser(user: JwtPayload, id: number): Promise<{ success: true }> {
    const shift = await this.findOneForUser(user, id);
    await this.timesheetRepo.delete({ shift: { id: shift.id } });
    await this.shiftRepo.delete({ id: shift.id });
    return { success: true };
  }

  normalizeLifecycleStatus(status?: string | null): string {
    const normalizedStatus = status?.trim().toLowerCase() || '';

    switch (normalizedStatus) {
      case 'planned':
      case 'unassigned':
      case 'scheduled':
        return 'unfilled';
      case 'assigned':
      case 'accepted':
        return normalizedStatus === 'accepted' ? 'ready' : 'offered';
      default:
        return normalizedStatus || 'unfilled';
    }
  }

  private resolveInitialStatus(params: {
    requestedStatus?: string | null;
    hasGuard: boolean;
  }): string {
    const requestedStatus = params.requestedStatus || null;

    if (requestedStatus && !this.allowedStatuses.has(requestedStatus)) {
      throw new BadRequestException('Shift status is invalid');
    }

    if (!params.hasGuard) {
      if (requestedStatus && ['offered', 'ready', 'rejected', 'in_progress', 'completed'].includes(requestedStatus)) {
        throw new BadRequestException('This shift status requires a guard assignment');
      }

      return requestedStatus ?? 'unfilled';
    }

    if (!requestedStatus || requestedStatus === 'unfilled') {
      return 'offered';
    }

    if (!['offered', 'cancelled'].includes(requestedStatus)) {
      throw new BadRequestException('New assigned shifts must start as offered or cancelled');
    }

    return requestedStatus;
  }

  private resolveUpdatedStatus(params: {
    currentStatus: string;
    requestedStatus: string | null;
    currentGuardId: number | null;
    nextGuardId: number | null;
  }): string {
    const requestedStatus = params.requestedStatus;

    if (!requestedStatus || !this.allowedStatuses.has(requestedStatus)) {
      throw new BadRequestException('Shift status is invalid');
    }

    if (requestedStatus === 'unfilled' && params.nextGuardId) {
      throw new BadRequestException('Unfilled shifts cannot keep a guard assignment');
    }

    if (['offered', 'ready', 'rejected', 'in_progress', 'completed'].includes(requestedStatus) && !params.nextGuardId) {
      throw new BadRequestException('This shift status requires a guard assignment');
    }

    this.assertTransition(params.currentStatus, requestedStatus);
    return requestedStatus;
  }

  private resolveStatusFromGuardChange(params: {
    currentStatus: string;
    currentGuardId: number | null;
    nextGuardId: number | null;
  }): string {
    if (params.currentGuardId === params.nextGuardId) {
      return params.currentStatus;
    }

    if (!params.nextGuardId) {
      if (!['unfilled', 'rejected'].includes(params.currentStatus)) {
        throw new BadRequestException('Only unfilled or rejected shifts can be cleared back to the guard pool');
      }
      return 'unfilled';
    }

    if (params.currentStatus === 'cancelled') {
      throw new BadRequestException('Cancelled shifts cannot be reassigned');
    }

    if (['ready', 'in_progress', 'completed'].includes(params.currentStatus)) {
      throw new BadRequestException('This shift is already committed or closed and cannot be reassigned');
    }

    return 'offered';
  }

  private assertTransition(currentStatus: string, nextStatus: string): void {
    if (currentStatus === nextStatus) {
      return;
    }

    const allowedTransitions: Record<string, string[]> = {
      unfilled: ['offered', 'cancelled'],
      offered: ['ready', 'rejected', 'cancelled'],
      ready: ['in_progress', 'cancelled'],
      in_progress: ['completed'],
      completed: [],
      rejected: ['unfilled'],
      cancelled: [],
    };

    if (!(allowedTransitions[currentStatus] || []).includes(nextStatus)) {
      throw new BadRequestException(`Shift cannot move from ${currentStatus} to ${nextStatus}`);
    }
  }
}
