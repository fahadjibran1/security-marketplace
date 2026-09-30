import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Shift } from './entities/shift.entity';
import { CreateShiftDto } from './dto/create-shift.dto';
import { AssignmentService } from '../assignment/assignment.service';
import { Assignment } from '../assignment/entities/assignment.entity';
import { TimesheetService } from '../timesheet/timesheet.service';
import { SiteService } from '../site/site.service';
import { Company } from '../company/entities/company.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { Job } from '../job/entities/job.entity';
import { JobApplication } from '../job-application/entities/job-application.entity';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { isCompanyRole, UserRole } from '../user/entities/user.entity';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { CompanyGuardService } from '../company-guard/company-guard.service';
import { AvailabilityService } from '../availability/availability.service';
import { ComplianceService } from '../compliance/compliance.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { UpdateShiftDto } from './dto/update-shift.dto';
import { RespondShiftDto } from './dto/respond-shift.dto';
import { Site } from '../site/entities/site.entity';
import {
  DEFAULT_SITE_TIME_ZONE,
  hasExplicitUtcOffset,
  siteLocalEndToInstant,
  siteLocalToInstant,
} from '../common/site-time';
import { OperationsProjectionService } from '../coverage/operations-projection.service';
import {
  GuardShiftOperationsView,
  needsGuardOperations,
  toGuardShiftOperations,
} from './guard-shift-operations';
import { resolveShiftWelfareInterval } from './shift-welfare-interval';

/** Length of the optional first shift created with a new site, when no end time is given. */
const DEFAULT_STARTER_SHIFT_HOURS = 8;

/**
 * A Guard's own shift, plus the operational obligations that apply to it.
 *
 * `operations` is null for a shift outside the operational window, which the app renders as "nothing
 * owed" rather than as zeroes.
 */
export type GuardShiftResponse = Shift & { operations: GuardShiftOperationsView | null };

@Injectable()
export class ShiftService {
  private readonly allowedStatuses = new Set([
    'unfilled',
    'offered',
    'ready',
    'missed',
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
    private readonly membershipService: CompanyMembershipService,
    private readonly guardProfileService: GuardProfileService,
    private readonly companyGuardService: CompanyGuardService,
    private readonly availabilityService: AvailabilityService,
    private readonly complianceService: ComplianceService,
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly operationsProjection: OperationsProjectionService,
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
      const { company } = await this.membershipService.resolveCompanyContext(
        user.sub, user.role, CompanyPermission.SHIFTS_VIEW,
      );

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

  /**
   * The authenticated Guard's own shifts, each carrying the operational obligations that apply to it.
   *
   * AUTHORIZATION IS STRUCTURAL. The query is filtered by the guard profile resolved from the token's
   * own subject, and the caller passes no identifier at all — there is no shift id, guard id or company
   * id in the request to tamper with. A Guard cannot reach another Guard's operations here because
   * there is nothing to change.
   *
   * The projection is the SAME service the company board uses, so the two surfaces cannot disagree.
   * Nothing is recomputed here and nothing is recomputed on the client.
   */
  async getGuardShifts(user: JwtPayload): Promise<GuardShiftResponse[]> {
    const guard = await this.guardProfileService.findByUserId(user.sub);
    if (!guard) {
      throw new NotFoundException('Guard profile not found');
    }

    const shifts = await this.shiftRepo.find({
      where: { guard: { id: guard.id } },
      relations: ['assignment', 'company', 'guard', 'site', 'job', 'jobApplication'],
      order: { start: 'DESC' },
    });

    // Only the shifts where an obligation can currently apply. This is every shift the Guard has ever
    // worked, and a window grid for all of it would be work nobody reads.
    const now = new Date();
    const relevant = shifts.filter((shift) => needsGuardOperations(shift, now));
    const operations = await this.operationsProjection.projectForShifts(relevant, now);

    return shifts.map((shift) => {
      const view = Object.assign(Object.create(Object.getPrototypeOf(shift)), shift) as GuardShiftResponse;
      view.operations = toGuardShiftOperations(operations.get(shift.id));
      return view;
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
      const { company } = await this.membershipService.resolveCompanyContext(
        user.sub, user.role, CompanyPermission.SHIFTS_VIEW,
      );
      if (shift.company.id !== company.id) {
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

  async create(dto: CreateShiftDto, manager?: EntityManager) {
    const shiftRepo = manager?.getRepository(Shift) ?? this.shiftRepo;
    const companyRepo = manager?.getRepository(Company) ?? this.companyRepo;
    const guardRepo = manager?.getRepository(GuardProfile) ?? this.guardRepo;
    const jobRepo = manager?.getRepository(Job) ?? this.jobRepo;
    const jobApplicationRepo = manager?.getRepository(JobApplication) ?? this.jobApplicationRepo;
    // Scheduled times must carry an explicit offset. The DTO enforces this at the HTTP edge; repeating it
    // here covers internal callers, because `new Date('2026-09-29T11:30:00')` would otherwise resolve
    // against the server clock and store a time nobody chose.
    for (const [field, value] of [['start', dto.start], ['end', dto.end]] as const) {
      if (!hasExplicitUtcOffset(String(value ?? ''))) {
        throw new BadRequestException(
          `Shift ${field} must include an explicit UTC offset (for example 2026-09-29T11:30:00+01:00). ` +
            'A date-time without one is a wall clock, not a point in time.',
        );
      }
    }

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
      ? manager
        ? await manager.getRepository(Assignment).findOne({ where: { id: dto.assignmentId } })
        : await this.assignmentService.findOne(dto.assignmentId)
      : null;

    if (dto.assignmentId && !assignment) {
      throw new NotFoundException('Assignment not found');
    }

    const jobApplication = dto.jobApplicationId
      ? await jobApplicationRepo.findOne({
          where: { id: dto.jobApplicationId },
          relations: ['job', 'job.company', 'guard'],
        })
      : assignment?.application ?? null;

    const job = dto.jobId
      ? await jobRepo.findOne({
          where: { id: dto.jobId },
          relations: ['company', 'site'],
        })
      : assignment?.job ?? jobApplication?.job ?? null;

    const company = dto.companyId
      ? await companyRepo.findOne({
          where: { id: dto.companyId },
          relations: ['user'],
        })
      : assignment?.company ?? job?.company ?? null;

    const guard = dto.guardId
      ? await guardRepo.findOne({
          where: { id: dto.guardId },
          relations: ['user'],
        })
      : assignment?.guard ?? jobApplication?.guard ?? null;

    const siteId = dto.siteId;
    const site = manager
      ? await manager.getRepository(Site).findOne({ where: { id: siteId } })
      : await this.siteService.findOne(siteId);
    if (!site) throw new NotFoundException(`Site with id ${siteId} not found`);
    const normalizedStatus = this.normalizeLifecycleStatus(dto.status);

    if (!company) {
      throw new NotFoundException('Company context is required to create a shift');
    }

    if (normalizedStatus && !this.allowedStatuses.has(normalizedStatus)) {
      throw new BadRequestException('Shift status is invalid');
    }

    if (guard) {
      // Every route that attaches a Guard to a shift funnels through here, so the tenancy assertion
      // belongs here rather than in each caller. It is manager-aware because a hire may establish the
      // relationship and create the shift inside one transaction.
      await this.companyGuardService.ensureActiveRelationship(company.id, guard.id, manager);
      await this.complianceService.assertGuardAssignable(company.id, guard.id);
      await this.availabilityService.assertGuardCanTakeShift(company.id, guard.id, start, end);
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
    shift.checkCallIntervalMinutes = resolveShiftWelfareInterval(
      dto.checkCallIntervalMinutes,
      site.welfareCheckIntervalMinutes,
    );
    shift.instructions = dto.instructions?.trim() || null;
    shift.closeOutNotes = dto.closeOutNotes?.trim() || null;
    shift.status = status;

    const savedShift: Shift = await shiftRepo.save(shift);
    const timesheet = savedShift.guard
      ? await this.timesheetService.createForShift(savedShift, manager)
      : null;

    return { shift: savedShift, timesheet };
  }

  async createForUser(user: JwtPayload, dto: CreateShiftDto) {
    if (user.role === UserRole.ADMIN) {
      return this.create(dto);
    }

    const { company } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.SHIFTS_MANAGE,
    );

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

    if (contextGuard) {
      await this.companyGuardService.ensureActiveRelationship(company.id, contextGuard.id);
      await this.complianceService.assertGuardAssignable(company.id, contextGuard.id);
      await this.availabilityService.assertGuardCanTakeShift(company.id, contextGuard.id, new Date(dto.start), new Date(dto.end));
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
      checkCallIntervalMinutes: resolveShiftWelfareInterval(
        dto.checkCallIntervalMinutes,
        site.welfareCheckIntervalMinutes,
      ),
      status: dto.status ?? (contextGuard ? 'offered' : 'unfilled'),
    });
  }

  /**
   * The first shift created alongside a new site, from the date and times on the site form.
   *
   * Those are wall-clock readings AT THE SITE, so they are converted with the site's own timezone. This
   * used to emit an offset-less `${date}T${time}:00`, which resolved against the server clock — the same
   * defect fixed on the client in Phase 1, and the only remaining place the server originated one.
   *
   * A time that does not exist at that site (the hour skipped when the clocks go forward) is rejected
   * rather than shifted, so nobody ends up with a shift at a time they did not ask for.
   */
  async createStarterShiftForSite(params: {
    companyId: number;
    siteId: number;
    createdByUserId?: number;
    date: string;
    startTime: string;
    endTime?: string;
    instructions?: string | null;
    timeZone?: string | null;
  }) {
    const timeZone = params.timeZone?.trim() || DEFAULT_SITE_TIME_ZONE;
    const startTime = params.startTime.trim();

    const start = siteLocalToInstant(params.date, startTime, timeZone);
    if (!start.ok) {
      throw new BadRequestException(start.message);
    }

    const submittedEnd = params.endTime?.trim();
    let endIso: string;
    if (submittedEnd) {
      const end = siteLocalEndToInstant(params.date, startTime, submittedEnd, timeZone);
      if (!end.ok) {
        throw new BadRequestException(end.message);
      }
      endIso = end.iso;
    } else {
      // No end time given: the shift runs eight hours. Added to the INSTANT, so it is eight hours even
      // across a clock change, and never re-parsed as a wall clock that a transition night could move.
      endIso = new Date(start.instant + DEFAULT_STARTER_SHIFT_HOURS * 3600000).toISOString();
    }

    return this.create({
      companyId: params.companyId,
      siteId: params.siteId,
      createdByUserId: params.createdByUserId,
      start: start.iso,
      end: endIso,
      status: 'unfilled',
      instructions: params.instructions ?? undefined,
    });
  }

  save(shift: Shift): Promise<Shift> {
    return this.shiftRepo.save(shift);
  }

  async respondForGuard(user: JwtPayload, id: number, dto: RespondShiftDto): Promise<Shift> {
    const guard = await this.guardProfileService.findByUserId(user.sub);
    if (!guard) {
      throw new NotFoundException('Guard profile not found');
    }

    // Pre-check: shift must exist and belong to this guard
    const preCheck = await this.shiftRepo.findOne({
      where: { id },
      relations: ['company', 'guard'],
    });
    if (!preCheck || !preCheck.guard || preCheck.guard.id !== guard.id) {
      throw new NotFoundException(`Shift with id ${id} not found`);
    }
    if (preCheck.status !== 'offered') {
      throw new BadRequestException('Only offered shifts can be accepted or rejected');
    }

    // On acceptance, re-verify current eligibility
    if (dto.response === 'accepted') {
      await this.companyGuardService.ensureActiveRelationship(preCheck.company.id, guard.id);
      await this.availabilityService.assertGuardCanTakeShift(
        preCheck.company.id, guard.id, preCheck.start, preCheck.end, id,
      );
      await this.complianceService.assertGuardAssignable(preCheck.company.id, guard.id);
    }

    // Atomic conditional UPDATE — only succeeds if status is still 'offered'
    // and this guard is still assigned, preventing race conditions
    const nextStatus = dto.response === 'accepted' ? 'ready' : 'rejected';
    const rows: { id: number }[] = await this.dataSource.query(
      `UPDATE "shifts"
         SET "status" = $1
       WHERE "id" = $2
         AND "guardId" = $3
         AND "status" = 'offered'
       RETURNING "id"`,
      [nextStatus, id, guard.id],
    );

    if (rows.length === 0) {
      const current = await this.shiftRepo.findOne({ where: { id }, relations: ['guard'] });
      if (!current || current.guard?.id !== guard.id) {
        throw new NotFoundException(`Shift with id ${id} not found`);
      }
      const currentNormalized = this.normalizeLifecycleStatus(current.status);
      throw new ConflictException(
        currentNormalized === nextStatus
          ? `Shift is already ${nextStatus}`
          : 'Shift offer is no longer available — the position may have been changed or cancelled',
      );
    }

    await this.auditLogService.log({
      company: { id: preCheck.company.id },
      user: { id: user.sub },
      action: dto.response === 'accepted' ? 'shift.offer_accepted' : 'shift.offer_rejected',
      entityType: 'shift',
      entityId: id,
      afterData: {
        status: nextStatus,
        guardId: guard.id,
        ...(preCheck.rotaSlotId != null ? { rotaSlotId: preCheck.rotaSlotId } : {}),
        ...(dto.reason ? { reason: dto.reason } : {}),
      },
    });

    return this.findOne(id);
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
      user.role === UserRole.ADMIN
        ? shift.company
        : (await this.membershipService.resolveCompanyContext(user.sub, user.role, CompanyPermission.SHIFTS_MANAGE)).company;

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
      // Moving a shift to another site re-materialises the interval from the NEW site, unless the caller
      // states one. Falling back to the shift's existing value keeps a deliberate override intact.
      if (!dto.checkCallIntervalMinutes) {
        shift.checkCallIntervalMinutes = resolveShiftWelfareInterval(
          undefined,
          site.welfareCheckIntervalMinutes ?? shift.checkCallIntervalMinutes,
        );
      }
    }

    const currentStatus = this.normalizeLifecycleStatus(shift.status);
    let nextGuard = shift.guard ?? null;

    if (dto.guardId !== undefined && dto.guardId !== shift.guard?.id) {
      if (dto.guardId) {
        const guard = await this.guardProfileService.findOne(dto.guardId);
        await this.companyGuardService.ensureActiveRelationship(actorCompany.id, guard.id);
        await this.complianceService.assertGuardAssignable(actorCompany.id, guard.id);
        await this.availabilityService.assertGuardCanTakeShift(actorCompany.id, guard.id, nextStart, nextEnd, shift.id);
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
    if (dto.closeOutNotes !== undefined) {
      shift.closeOutNotes = dto.closeOutNotes?.trim() || null;
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
      if (requestedStatus && ['offered', 'ready', 'missed', 'rejected', 'in_progress', 'completed'].includes(requestedStatus)) {
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

    if (['offered', 'ready', 'missed', 'rejected', 'in_progress', 'completed'].includes(requestedStatus) && !params.nextGuardId) {
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
      if (!['unfilled', 'rejected', 'missed'].includes(params.currentStatus)) {
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
      ready: ['in_progress', 'missed', 'cancelled'],
      in_progress: ['completed'],
      completed: [],
      rejected: ['unfilled'],
      missed: ['unfilled', 'cancelled'],
      cancelled: [],
    };

    if (!(allowedTransitions[currentStatus] || []).includes(nextStatus)) {
      throw new BadRequestException(`Shift cannot move from ${currentStatus} to ${nextStatus}`);
    }
  }
}
