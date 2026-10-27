import { BadRequestException, ConflictException, ForbiddenException, HttpStatus, Inject, Injectable, NotFoundException, Optional, forwardRef } from '@nestjs/common';
import { GuardNotificationService } from '../guard-notification/guard-notification.service';
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
import { isCompanyRole, UserRole, UserStatus } from '../user/entities/user.entity';
import { CompanyMembershipService } from '../company-membership/company-membership.service';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { CompanyGuardService } from '../company-guard/company-guard.service';
import { AvailabilityService } from '../availability/availability.service';
import { ComplianceService } from '../compliance/compliance.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { UpdateShiftDto } from './dto/update-shift.dto';
import { RespondShiftDto } from './dto/respond-shift.dto';
import { ReplaceGuardDto } from './dto/replace-guard.dto';
import {
  NO_SHOW_GRACE_MINUTES,
  REPLACE_GUARD_AUDIT_ACTION,
  REPLACE_GUARD_ERROR_CODES,
  REPLACE_GUARD_REASON_CATEGORIES,
  REPLACE_GUARD_VOID_REASON,
  ReplaceGuardErrorCode,
  assessReplacementFatigue,
  companySafeReplacementFatigue,
  replaceGuardError,
  replaceGuardStateRefusal,
} from './replace-guard-policy';
import { mayPerformAmendmentAction } from '../shift-amendment/shift-amendment-policy';
import { ShiftAmendmentService } from '../shift-amendment/shift-amendment.service';
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
import { offerAcceptanceWindow, shiftOfferExpiredException } from './offer-acceptance-window';
import { lockGuardsForAssignment, returningRows } from '../operations/advisory-locks';
import { assertNoShiftClash } from '../availability/shift-clash';
import {
  COMPANY_FORBIDDEN_TRANSITIONS,
  DELETABLE_STATUSES,
  MISSED_SHIFT_GRACE_MINUTES,
  MaterialShiftTerms,
  REACCEPTANCE_AUDIT_ACTION,
  RETIME_CHECKED_STATUSES,
  SCHEDULE_LOCKED_STATUSES,
  changedFields,
  materialChanges,
  reacceptanceAuditData,
  shiftAuditSnapshot,
} from './shift-edit-policy';

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
    // Optional only so that unit specs constructing this service by hand keep working; the app always injects it.
    @Optional() private readonly guardNotifications?: GuardNotificationService,
    // The shift policy thresholds Replace Guard assesses against. Optional for the same reason; Replace Guard refuses
    // to run without it rather than skip the fatigue check.
    @Optional() private readonly shiftAmendments?: ShiftAmendmentService,
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

  /**
   * Fresh deployment gate at the moment work starts: a Guard's Book On, or a company moving a shift to
   * in_progress by hand. It is exactly the gate assignment runs (ACTIVE relationship, then the company's
   * compliance assessment), re-evaluated now, because a check can expire or be recorded as not confirmed
   * between assignment and the start of the shift. There is no override.
   *
   * It is never applied to Book Off: a Guard already at work must always be able to record leaving.
   */
  async assertGuardMayStartWork(companyId: number, guardId: number): Promise<void> {
    await this.companyGuardService.ensureActiveRelationship(companyId, guardId);
    await this.complianceService.assertGuardAssignable(companyId, guardId);
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

  async create(
    dto: CreateShiftDto,
    manager?: EntityManager,
    eligibilityChecked = false,
  ): Promise<{ shift: Shift; timesheet: Timesheet | null }> {
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
      if (!eligibilityChecked) {
        await this.companyGuardService.ensureActiveRelationship(company.id, guard.id, manager);
        await this.complianceService.assertGuardAssignable(company.id, guard.id);
        await this.availabilityService.assertGuardCanTakeShift(company.id, guard.id, start, end);
      }
      // The overlap check is repeated and the insert made in a transaction holding the Guard's assignment lock. A
      // caller without one (a company or admin create) is re-run inside a new one, without repeating the checks.
      if (!manager) {
        return this.dataSource.transaction((transactionManager) => this.create(dto, transactionManager, true));
      }
      await lockGuardsForAssignment(manager, [guard.id]);
      await assertNoShiftClash(manager, guard.id, start, end);
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

    // A new offer to a Guard (company create, admin create, hire): the Guard's in-app notice is written on this
    // transaction (a shift with a Guard is always created inside one, above) and the push follows its commit.
    if (manager && savedShift.guard && savedShift.status === 'offered') {
      await this.guardNotifications?.shiftOffered(manager, { companyId: company.id, guardId: savedShift.guard.id, shiftId: savedShift.id });
    }

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
      relations: ['company', 'guard', 'site'],
    });
    if (!preCheck || !preCheck.guard || preCheck.guard.id !== guard.id) {
      throw new NotFoundException(`Shift with id ${id} not found`);
    }
    if (preCheck.status !== 'offered') {
      throw new BadRequestException('Only offered shifts can be accepted or rejected');
    }

    // An offer for a shift that has already ended can no longer be accepted (owner rule, 21 Oct 2026). Checked
    // first, on the server clock, so an expired offer gets its own clear answer; the write below re-checks it
    // against the database clock so a request racing the boundary cannot slip through.
    if (dto.response === 'accepted' && offerAcceptanceWindow(new Date(preCheck.start), new Date(preCheck.end), new Date()) === 'ended') {
      throw shiftOfferExpiredException();
    }

    // On acceptance, re-verify current eligibility
    if (dto.response === 'accepted') {
      await this.companyGuardService.ensureActiveRelationship(preCheck.company.id, guard.id);
      await this.availabilityService.assertGuardCanTakeShift(
        preCheck.company.id, guard.id, preCheck.start, preCheck.end, id,
      );
      await this.complianceService.assertGuardAssignable(preCheck.company.id, guard.id);
    }

    const nextStatus = dto.response === 'accepted' ? 'ready' : 'rejected';
    const rows = await this.dataSource.transaction(async (manager) => {
      // An acceptance repeats the overlap check under the Guard's assignment lock, in the same transaction as the
      // write, so a concurrent assignment of this Guard cannot pass in between.
      if (dto.response === 'accepted') {
        await lockGuardsForAssignment(manager, [guard.id]);
        // An acceptance is of the terms checked above. If the company changed the start, end or site since they were
        // read, this would confirm a revised shift that was never checked or seen; it is refused and the Guard
        // responds to the revised offer instead. The row lock holds those terms until this transaction ends.
        const [current] = (await manager.query(
          'SELECT "start", "end", "siteId" FROM "shifts" WHERE "id" = $1 FOR UPDATE',
          [id],
        )) as Array<{ start: Date; end: Date; siteId: number | null }>;
        if (
          current &&
          materialChanges(
            { start: preCheck.start, end: preCheck.end, siteId: preCheck.site?.id ?? null },
            { start: current.start, end: current.end, siteId: current.siteId ?? null },
          ).length > 0
        ) {
          throw new ConflictException(
            'This shift was changed by your company while you were responding. Review the updated shift, then accept or decline it.',
          );
        }
        await assertNoShiftClash(manager, guard.id, preCheck.start, preCheck.end, id);
      }

      // Atomic conditional UPDATE — only succeeds if status is still 'offered'
      // and this guard is still assigned, preventing race conditions. An acceptance also requires the shift not to
      // have ended by the DATABASE clock ("end" is stored as UTC wall time; the process runs in UTC). The clock is
      // statement_timestamp(), not now(): inside this transaction now() is the moment it began, before the checks
      // above, so an offer that ended while they ran would still look open.
      return returningRows<{ id: number }>(await manager.query(
        `UPDATE "shifts"
           SET "status" = $1
         WHERE "id" = $2
           AND "guardId" = $3
           AND "status" = 'offered'
           AND ($1 <> 'ready' OR "end" > (statement_timestamp() AT TIME ZONE 'UTC'))
         RETURNING "id"`,
        [nextStatus, id, guard.id],
      ));
    });

    if (rows.length === 0) {
      const current = await this.shiftRepo.findOne({ where: { id }, relations: ['guard'] });
      if (!current || current.guard?.id !== guard.id) {
        throw new NotFoundException(`Shift with id ${id} not found`);
      }
      // Still exactly 'offered' to this Guard (the UPDATE's own conditions), so the end time is what failed:
      // the offer expired in flight.
      if (dto.response === 'accepted' && current.status === 'offered') {
        throw shiftOfferExpiredException();
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

  /**
   * The company allowed to change or delete this shift: the caller's own, with shifts.manage, and only for
   * a shift that company owns. Platform administrators are not a company and do not bypass this (owner
   * decision, 20 Oct 2026); a shift of another company reads as not found, exactly as findOneForUser does.
   */
  private async companyForShiftChange(user: JwtPayload, shift: Shift): Promise<Company> {
    if (!isCompanyRole(user.role)) {
      throw new ForbiddenException('Only the company that owns a shift can change or delete it.');
    }
    const { company } = await this.membershipService.resolveCompanyContext(user.sub, user.role, CompanyPermission.SHIFTS_MANAGE);
    if (shift.company?.id !== company.id) {
      throw new NotFoundException(`Shift with id ${shift.id} not found`);
    }
    return company;
  }

  async updateForUser(user: JwtPayload, id: number, dto: UpdateShiftDto): Promise<Shift> {
    const shift = await this.findOneForUser(user, id);
    const actorCompany = await this.companyForShiftChange(user, shift);

    const nextStart = dto.start ? new Date(dto.start) : shift.start;
    const nextEnd = dto.end ? new Date(dto.end) : shift.end;
    if (Number.isNaN(nextStart.getTime()) || Number.isNaN(nextEnd.getTime())) {
      throw new BadRequestException('Shift start and end must be valid dates');
    }
    if (nextEnd <= nextStart) {
      throw new BadRequestException('Shift end must be after shift start');
    }

    const currentStatus = this.normalizeLifecycleStatus(shift.status);
    const before = shiftAuditSnapshot(shift);
    const timesChanged = nextStart.getTime() !== shift.start.getTime() || nextEnd.getTime() !== shift.end.getTime();
    const siteChanged = !!dto.siteId && dto.siteId !== shift.site?.id;
    const intervalChanged = !!dto.checkCallIntervalMinutes && dto.checkCallIntervalMinutes !== shift.checkCallIntervalMinutes;

    // A started, finished or decided shift keeps its schedule, site and Welfare Check interval: every welfare
    // window, Live Operations row and export is graded against them.
    if ((timesChanged || siteChanged || intervalChanged) && SCHEDULE_LOCKED_STATUSES.has(currentStatus)) {
      throw new ConflictException(
        `This shift is ${currentStatus.replace('_', ' ')}. Its times, site and Welfare Check interval are part of its record and cannot be changed.`,
      );
    }

    const requestedStatusChange = dto.status?.trim() ? this.normalizeLifecycleStatus(dto.status) : null;
    if (requestedStatusChange && requestedStatusChange !== currentStatus) {
      const forbidden = COMPANY_FORBIDDEN_TRANSITIONS[currentStatus]?.[requestedStatusChange];
      if (forbidden) {
        throw new ConflictException(forbidden);
      }
      if (requestedStatusChange === 'missed') {
        await this.assertMayMarkMissed(shift);
      }
    }

    if (siteChanged) {
      const site = await this.siteService.findOne(dto.siteId!);
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

    // Material-change re-acceptance (owner-approved 22 Oct 2026): the Guard accepted this shift on its start, end and
    // site. Any actual change to one of them returns it to the same Guard as a revised offer, which is not confirmed
    // until they accept it again through /shifts/:id/respond. Notes, instructions and the Welfare Check interval are
    // not material. An offered shift stays offered; in-progress and closed shifts cannot be changed at all (above).
    const acceptedTerms: MaterialShiftTerms = { start: new Date(before.start), end: new Date(before.end), siteId: before.siteId };
    const revisedTerms: MaterialShiftTerms = { start: nextStart, end: nextEnd, siteId: siteChanged ? dto.siteId! : before.siteId };
    const materialFields = materialChanges(acceptedTerms, revisedTerms);
    const reofferedForReacceptance =
      currentStatus === 'ready' &&
      nextStatus === 'ready' &&
      Boolean(nextGuard) &&
      nextGuard!.id === before.guardId &&
      materialFields.length > 0;
    if (reofferedForReacceptance) {
      nextStatus = 'offered';
    }

    // A Guard who keeps a shift whose times change is checked against the new window exactly as a newly assigned
    // Guard is: relationship, compliance, leave, availability and overlap. A refusal leaves the shift exactly as it
    // was. (In-progress and closed shifts cannot be retimed at all; see above.)
    const retimedWithGuard =
      timesChanged && Boolean(nextGuard) && nextGuard!.id === before.guardId && RETIME_CHECKED_STATUSES.has(nextStatus);
    if (retimedWithGuard) {
      await this.companyGuardService.ensureActiveRelationship(actorCompany.id, nextGuard!.id);
      await this.complianceService.assertGuardAssignable(actorCompany.id, nextGuard!.id);
      await this.availabilityService.assertGuardCanTakeShift(actorCompany.id, nextGuard!.id, nextStart, nextEnd, shift.id);
    }

    // ready → in_progress is refused above (COMPANY_FORBIDDEN_TRANSITIONS): a shift starts by Book On. This
    // gate stays as defence in depth, so no future path through here can start work without the Book On check.
    if (nextStatus === 'in_progress' && currentStatus !== 'in_progress' && nextGuard) {
      await this.assertGuardMayStartWork(actorCompany.id, nextGuard.id);
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

    const loadedStatus = before.status;
    const changes = changedFields(before, shiftAuditSnapshot(shift));

    // One transaction: the shift row is locked so a Guard's accept, a Book On or another edit cannot land
    // between the checks above and this write, and the audit entry commits with it.
    const guardAssigned = Boolean(nextGuard) && nextGuard!.id !== before.guardId;
    const savedShift = await this.dataSource.transaction(async (manager) => {
      // A newly assigned Guard, or a Guard whose shift is retimed: take their assignment lock (before the shift row
      // lock) and repeat the overlap check through this transaction, so a concurrent assignment of the same Guard
      // cannot pass in between.
      if (guardAssigned || retimedWithGuard) {
        await lockGuardsForAssignment(manager, [nextGuard!.id]);
        await assertNoShiftClash(manager, nextGuard!.id, nextStart, nextEnd, shift.id);
      }
      const [locked] = await manager.query(`SELECT "status" FROM "shifts" WHERE "id" = $1 FOR UPDATE`, [shift.id]);
      if (!locked || locked.status !== loadedStatus) {
        throw new ConflictException('This shift changed while it was being edited. Reload it and try again.');
      }
      const saved = await manager.getRepository(Shift).save(shift);
      if (Object.keys(changes.after).length > 0) {
        await this.auditLogService.logInTransaction(manager, {
          company: { id: actorCompany.id },
          user: { id: user.sub },
          action: 'shift.updated',
          entityType: 'shift',
          entityId: shift.id,
          beforeData: changes.before,
          afterData: changes.after,
        });
      }
      // Mark Missed has its own entry, with the reason when one was given (optional: an older web release sends none).
      if (nextStatus === 'missed' && currentStatus !== 'missed') {
        await this.auditLogService.logInTransaction(manager, {
          company: { id: actorCompany.id },
          user: { id: user.sub },
          action: 'shift.marked_missed',
          entityType: 'shift',
          entityId: shift.id,
          beforeData: { status: currentStatus, guardId: before.guardId },
          afterData: {
            status: 'missed',
            reason: dto.reason?.trim() || null,
            scheduledStart: new Date(before.start).toISOString(),
            markedAt: new Date().toISOString(),
          },
        });
      }
      // The re-offer has its own entry: the accepted terms, the revised terms, who changed them and why.
      if (reofferedForReacceptance) {
        await this.auditLogService.logInTransaction(manager, {
          company: { id: actorCompany.id },
          user: { id: user.sub },
          action: REACCEPTANCE_AUDIT_ACTION,
          entityType: 'shift',
          entityId: shift.id,
          ...reacceptanceAuditData({
            guardId: nextGuard!.id,
            accepted: acceptedTerms,
            revised: revisedTerms,
            changedFields: materialFields,
            via: 'shift.update',
            rotaSlotId: shift.rotaSlotId ?? null,
          }),
        });
      }

      // The Guard's in-app notice for what this edit means to them, committed with it; the push follows the commit.
      if (this.guardNotifications) {
        const target = { companyId: actorCompany.id, shiftId: shift.id };
        if (reofferedForReacceptance) {
          await this.guardNotifications.shiftReacceptanceRequired(manager, { ...target, guardId: nextGuard!.id });
        } else if (nextStatus === 'offered' && nextGuard && (nextGuard.id !== before.guardId || currentStatus !== 'offered')) {
          await this.guardNotifications.shiftOffered(manager, { ...target, guardId: nextGuard.id });
        }
        // "Withdraw offer" (and cancelling an accepted shift before Book On) tells the Guard who held it.
        if (nextStatus === 'cancelled' && ['offered', 'ready'].includes(currentStatus) && before.guardId) {
          await this.guardNotifications.shiftOfferWithdrawn(manager, { ...target, guardId: before.guardId });
        }
      }

      // The draft timesheet carries the scheduled times; it is kept in step in the same transaction, so a retime and
      // its timesheet commit together or not at all.
      const timesheetRepo = manager.getRepository(Timesheet);
      const timesheets = await timesheetRepo.find({
        where: { shift: { id: saved.id } },
        relations: ['shift', 'guard', 'company'],
      });

      if (saved.guard && timesheets.length === 0) {
        await this.timesheetService.createForShift(saved, manager);
      }

      for (const timesheet of timesheets) {
        timesheet.shift = saved;
        if (!saved.guard) {
          continue;
        }
        timesheet.guard = saved.guard;
        timesheet.company = saved.company;
        timesheet.scheduledStartAt = saved.start;
        timesheet.scheduledEndAt = saved.end;
        await timesheetRepo.save(timesheet);
      }
      return saved;
    });

    return this.findOne(savedShift.id);
  }

  /**
   * Deletes a shift that was never worked or decided. Anything else is part of the operational record:
   * deleting a shift cascades in the database to its attendance events and Welfare Check logs, so a worked
   * shift is never deleted here — it is cancelled. A shift with a timesheet in any state is refused too, and
   * this route never deletes a timesheet. Needs shifts.manage (finding it only needs shifts.view).
   */
  async removeForUser(user: JwtPayload, id: number): Promise<{ success: true }> {
    const shift = await this.findOneForUser(user, id);
    const actorCompany = await this.companyForShiftChange(user, shift);

    const status = this.normalizeLifecycleStatus(shift.status);
    if (shift.rotaSlotId != null) {
      throw new ConflictException('This shift is a rota position. Cancel the position on the rota instead.');
    }
    if (!DELETABLE_STATUSES.has(status)) {
      throw new ConflictException(`This shift is ${status.replace('_', ' ')} and is part of the operational record. It cannot be deleted.`);
    }

    await this.dataSource.transaction(async (manager) => {
      const [locked] = await manager.query(`SELECT "status" FROM "shifts" WHERE "id" = $1 FOR UPDATE`, [shift.id]);
      if (!locked || locked.status !== shift.status) {
        throw new ConflictException('This shift changed while it was being deleted. Reload it and try again.');
      }
      const [{ evidence, timesheet }] = await manager.query(
        `SELECT (EXISTS (SELECT 1 FROM "attendance_events" WHERE "shiftId" = $1)
              OR EXISTS (SELECT 1 FROM "daily_logs" WHERE "shiftId" = $1)
              OR EXISTS (SELECT 1 FROM "safety_alerts" WHERE "shiftId" = $1)
              OR EXISTS (SELECT 1 FROM "incidents" WHERE "shiftId" = $1)) AS "evidence",
                EXISTS (SELECT 1 FROM "timesheets" WHERE "shiftId" = $1) AS "timesheet"`,
        [shift.id],
      );
      if (evidence) {
        throw new ConflictException('This shift has attendance, logs, alerts or incidents recorded against it. It cannot be deleted.');
      }
      // A timesheet is financial and approval evidence in every state — draft, submitted, approved, rejected,
      // returned, in payroll or paid, on an invoice — and client weekly approval lines and disputes point at it.
      // A shift with one is never hard-deleted here, and no timesheet is ever deleted by this route.
      if (timesheet) {
        throw new ConflictException('This shift has a timesheet. It cannot be deleted; cancel it instead.');
      }
      await this.auditLogService.logInTransaction(manager, {
        company: { id: actorCompany.id },
        user: { id: user.sub },
        action: 'shift.deleted',
        entityType: 'shift',
        entityId: shift.id,
        beforeData: { ...shiftAuditSnapshot(shift) },
      });
      // Deleting an offered shift withdraws the offer: the Guard is told (recorded before the row goes; the notice
      // and the push outlive it).
      if (status === 'offered' && shift.guard?.id) {
        await this.guardNotifications?.shiftOfferWithdrawn(manager, { companyId: actorCompany.id, guardId: shift.guard.id, shiftId: shift.id });
      }
      await manager.getRepository(Shift).delete({ id: shift.id });
    });
    return { success: true };
  }

  /**
   * Replace Guard (owner-approved 25 Oct 2026; rules in replace-guard-policy.ts). One transaction moves an offered or
   * accepted shift from the Guard who holds it to another Guard as a fresh offer, tells the outgoing Guard (with the
   * neutral reason category only), offers it to the replacement, voids any open extension proposal of the outgoing
   * Guard, moves the draft timesheet, and writes one audit entry. Company accounts with shifts.manage on the shift's own
   * company only, exactly like an edit. A marketplace hire is refused (its assignment and application are never
   * rewritten here).
   *
   * Lock order (the approved one): the rota slot row (a rota position only, as a rota time change does), then the
   * replacement's Guard assignment lock, then the shift row. A Guard's acceptance or Book On (each: the shift row, then
   * its own checks) or a concurrent replacement therefore decides first or second, never half-way: the loser sees the
   * shift changed.
   *
   * A retried request that already succeeded (the shift is on offer to the same replacement from the latest
   * replacement) answers with the shift as it is and writes and notifies nothing.
   */
  async replaceGuardForUser(user: JwtPayload, id: number, dto: ReplaceGuardDto): Promise<Shift & { replacementAssessment?: unknown }> {
    const E = REPLACE_GUARD_ERROR_CODES;
    const shift = await this.findOneForUser(user, id);
    if (!isCompanyRole(user.role)) {
      throw new ForbiddenException('Only the company that owns a shift can change or delete it.');
    }
    const { company: actorCompany, membershipRole } = await this.membershipService.resolveCompanyContext(
      user.sub, user.role, CompanyPermission.SHIFTS_MANAGE,
    );
    if (shift.company?.id !== actorCompany.id) {
      throw new NotFoundException(`Shift with id ${shift.id} not found`);
    }
    const reason = String(dto.reason ?? '').trim();
    if (!reason) {
      throw replaceGuardError(HttpStatus.BAD_REQUEST, E.REASON_REQUIRED, 'Give a reason for replacing the Guard.');
    }
    const reasonLabel = REPLACE_GUARD_REASON_CATEGORIES[dto.reasonCategory];
    const noShow = dto.noShow === true;
    const replacementGuardId = Number(dto.replacementGuardId);
    const outgoingGuardId = shift.guard?.id ?? null;
    const loadedStatus = shift.status;
    const status = this.normalizeLifecycleStatus(shift.status);

    if (outgoingGuardId === replacementGuardId) {
      if (status === 'offered' && (await this.latestReplacementGuardId(shift.id)) === replacementGuardId) {
        return shift;
      }
      throw replaceGuardError(HttpStatus.UNPROCESSABLE_ENTITY, E.SAME_GUARD, 'This Guard already holds the shift. Choose a different Guard.');
    }
    if (shift.assignment || shift.jobApplication) {
      throw replaceGuardError(HttpStatus.CONFLICT, E.HIRE_LINKED,
        'This shift belongs to a marketplace hire. Its Guard cannot be replaced here; cancel the shift and create a new one for the replacement.');
    }
    const refusal = replaceGuardStateRefusal(
      { status, guardId: outgoingGuardId, startMs: shift.start.getTime(), endMs: shift.end.getTime() },
      Date.now(),
      noShow,
    );
    if (refusal) throw refusal;

    // The replacement's eligibility and the fatigue / rest assessment of their resulting schedule: before the
    // transaction on ordinary connections (as an assignment and an extension do), each refusal with its own code.
    await this.assertReplacementEligible(actorCompany.id, replacementGuardId, shift);
    const fatigue = await this.assessReplacement(actorCompany.id, replacementGuardId, shift);
    if (fatigue.raw.hardLimitExceeded) {
      throw replaceGuardError(HttpStatus.UNPROCESSABLE_ENTITY, E.FATIGUE_LIMIT,
        `This shift is ${fatigue.raw.totalScheduledHours} scheduled hours, over the maximum shift length of ${fatigue.raw.thresholds.hardLimitHours} hours.`,
        { assessment: fatigue.safe });
    }
    if (fatigue.raw.minRestViolated) {
      throw replaceGuardError(HttpStatus.UNPROCESSABLE_ENTITY, E.MIN_REST,
        `This Guard would not have the minimum ${fatigue.raw.thresholds.minRestHours} hours' rest between shifts.`,
        { assessment: fatigue.safe });
    }
    if (fatigue.raw.approvalRequired) {
      // Live Shift Amendments need an approver for this; here the person who may approve says so explicitly.
      if (!mayPerformAmendmentAction(membershipRole, false, 'approve')) {
        throw replaceGuardError(HttpStatus.FORBIDDEN, E.FATIGUE_APPROVER_REQUIRED,
          `This shift is over ${fatigue.raw.thresholds.approvalRequiredHours} scheduled hours. An Owner or Admin must make this replacement.`,
          { assessment: fatigue.safe });
      }
      if (dto.fatigueAcknowledged !== true) {
        throw replaceGuardError(HttpStatus.UNPROCESSABLE_ENTITY, E.FATIGUE_ACKNOWLEDGEMENT_REQUIRED,
          `This shift is over ${fatigue.raw.thresholds.approvalRequiredHours} scheduled hours. Confirm the fatigue assessment to replace the Guard.`,
          { assessment: fatigue.safe });
      }
    }

    const start = new Date(shift.start);
    const end = new Date(shift.end);
    await this.dataSource.transaction(async (manager) => {
      if (shift.rotaSlotId != null) {
        await manager.query(`SELECT "id" FROM "rota_slots" WHERE "id" = $1 FOR UPDATE`, [shift.rotaSlotId]);
      }
      await lockGuardsForAssignment(manager, [replacementGuardId]);
      try {
        await assertNoShiftClash(manager, replacementGuardId, start, end, shift.id);
      } catch (error) {
        if (error instanceof ForbiddenException) {
          throw replaceGuardError(HttpStatus.UNPROCESSABLE_ENTITY, E.OVERLAP, 'This Guard has an overlapping shift.');
        }
        throw error;
      }
      const [locked] = (await manager.query(
        `SELECT "status", "guardId", "assignmentId", "jobApplicationId",
                EXTRACT(EPOCH FROM "start") * 1000 AS "startMs", EXTRACT(EPOCH FROM "end") * 1000 AS "endMs",
                EXTRACT(EPOCH FROM statement_timestamp()) * 1000 AS "nowMs"
           FROM "shifts" WHERE "id" = $1 FOR UPDATE`,
        [shift.id],
      )) as Array<{ status: string; guardId: number | null; assignmentId: number | null; jobApplicationId: number | null;
        startMs: string; endMs: string; nowMs: string }>;
      if (!locked) throw new NotFoundException(`Shift with id ${shift.id} not found`);
      if (
        locked.status !== loadedStatus ||
        (locked.guardId === null ? null : Number(locked.guardId)) !== outgoingGuardId ||
        Number(locked.startMs) !== start.getTime() ||
        Number(locked.endMs) !== end.getTime()
      ) {
        throw replaceGuardError(HttpStatus.CONFLICT, E.CHANGED, 'This shift changed while the Guard was being replaced. Reload it and try again.');
      }
      if (locked.assignmentId !== null || locked.jobApplicationId !== null) {
        throw replaceGuardError(HttpStatus.CONFLICT, E.HIRE_LINKED,
          'This shift belongs to a marketplace hire. Its Guard cannot be replaced here; cancel the shift and create a new one for the replacement.');
      }
      // The same rules again on the database clock, so a request racing the start, the grace or the end cannot slip
      // through.
      const nowMs = Number(locked.nowMs);
      const lockedRefusal = replaceGuardStateRefusal(
        { status, guardId: outgoingGuardId, startMs: Number(locked.startMs), endMs: Number(locked.endMs) },
        nowMs,
        noShow,
      );
      if (lockedRefusal) throw lockedRefusal;

      // Live attendance and financial evidence are never moved to another Guard. Under the row lock a Book On either
      // committed first (and is seen here, or changed the status above) or waits and then finds the shift is not theirs.
      const [{ attendance, lockedTimesheet }] = await manager.query(
        `SELECT (SELECT count(*)::int FROM "attendance_events" WHERE "shiftId" = $1) AS "attendance",
                EXISTS (SELECT 1 FROM "timesheets" WHERE "shiftId" = $1 AND "approvalStatus" <> 'draft') AS "lockedTimesheet"`,
        [shift.id],
      );
      if (Number(attendance) > 0) {
        throw replaceGuardError(HttpStatus.CONFLICT, E.ATTENDANCE_RECORDED,
          'Attendance has been recorded on this shift. Its Guard cannot be replaced.');
      }
      if (lockedTimesheet) {
        throw replaceGuardError(HttpStatus.CONFLICT, E.TIMESHEET_LOCKED, 'This shift has a submitted timesheet. Its Guard cannot be replaced.');
      }

      // Live Shift Amendments apply to in-progress shifts only, so none should be open here; any that is (it belongs
      // to the outgoing Guard) is voided as a Book Off voids one: shift row first, amendment rows second.
      const voided = returningRows<{ id: number; status: string }>(await manager.query(
        `UPDATE "shift_amendments" SET "status" = 'voided', "voidedReason" = $2,
            "voidedAt" = (statement_timestamp() AT TIME ZONE 'UTC'), "updatedAt" = now()
          WHERE "shiftId" = $1 AND "status" IN ('awaiting_approval', 'pending')
          RETURNING "id", "status"`,
        [shift.id, REPLACE_GUARD_VOID_REASON],
      ));
      for (const row of voided) {
        await this.auditLogService.logInTransaction(manager, {
          company: { id: actorCompany.id },
          user: { id: user.sub },
          action: 'shift_amendment.voided',
          entityType: 'shift_amendment',
          entityId: Number(row.id),
          beforeData: { status: 'open' },
          afterData: { status: 'voided', reason: REPLACE_GUARD_VOID_REASON, shiftId: shift.id },
        });
      }

      // Identifiers, the reason category, the actor's free-text reason (authorised history only), the no-show evidence
      // and the fatigue assessment as the company may see it. No names, contact details or site details.
      const audit = await this.auditLogService.logInTransaction(manager, {
        company: { id: actorCompany.id },
        user: { id: user.sub },
        action: REPLACE_GUARD_AUDIT_ACTION,
        entityType: 'shift',
        entityId: shift.id,
        beforeData: { guardId: outgoingGuardId, status },
        afterData: {
          guardId: replacementGuardId,
          status: 'offered',
          reasonCategory: dto.reasonCategory,
          reason,
          ...(noShow
            ? {
                noShow: {
                  scheduledStart: new Date(Number(locked.startMs)).toISOString(),
                  checkedAt: new Date(nowMs).toISOString(),
                  graceMinutes: NO_SHOW_GRACE_MINUTES,
                  attendanceEvents: 0,
                },
              }
            : {}),
          fatigue: fatigue.safe,
          ...(fatigue.raw.approvalRequired ? { fatigueAcknowledged: true } : {}),
          ...(voided.length ? { voidedAmendmentIds: voided.map((row) => Number(row.id)) } : {}),
          ...(shift.rotaSlotId != null ? { rotaSlotId: shift.rotaSlotId } : {}),
        },
      });

      // The outgoing Guard's notice is recorded while they still hold the shift (the recipient check reads this row).
      await this.guardNotifications?.shiftReplaced(manager, {
        companyId: actorCompany.id, guardId: outgoingGuardId!, shiftId: shift.id, replacementKey: audit.id, reasonLabel,
      });

      const moved = returningRows<{ id: number }>(await manager.query(
        `UPDATE "shifts" SET "guardId" = $2, "status" = 'offered'
          WHERE "id" = $1 AND "guardId" = $3 AND "status" = $4 RETURNING "id"`,
        [shift.id, replacementGuardId, outgoingGuardId, loadedStatus],
      ));
      if (!moved.length) {
        throw replaceGuardError(HttpStatus.CONFLICT, E.CHANGED, 'This shift changed while the Guard was being replaced. Reload it and try again.');
      }

      // The draft timesheet follows the shift to its new Guard (non-draft ones were refused above).
      const replacement = await manager.getRepository(GuardProfile).findOneOrFail({ where: { id: replacementGuardId } });
      const timesheetRepo = manager.getRepository(Timesheet);
      const timesheets = await timesheetRepo.find({ where: { shift: { id: shift.id } }, relations: ['shift', 'guard', 'company'] });
      for (const timesheet of timesheets) {
        timesheet.guard = replacement;
        await timesheetRepo.save(timesheet);
      }
      if (!timesheets.length) {
        const saved = await manager.getRepository(Shift).findOneOrFail({ where: { id: shift.id } });
        await this.timesheetService.createForShift(saved, manager);
      }

      // A fresh offer: the replacement accepts it (or not) themselves. Until then it is not confirmed cover.
      await this.guardNotifications?.shiftOffered(manager, { companyId: actorCompany.id, guardId: replacementGuardId, shiftId: shift.id });
    });

    const result = (await this.findOne(shift.id)) as Shift & { replacementAssessment?: unknown };
    result.replacementAssessment = fatigue.safe;
    return result;
  }

  /** The Guard the latest Replace Guard on this shift gave it to, or null. */
  private async latestReplacementGuardId(shiftId: number): Promise<number | null> {
    const [row] = await this.dataSource.query(
      `SELECT ("afterData"->>'guardId')::int AS "guardId" FROM "audit_logs"
        WHERE "entityType" = 'shift' AND "entityId" = $1 AND "action" = $2 ORDER BY "id" DESC LIMIT 1`,
      [shiftId, REPLACE_GUARD_AUDIT_ACTION],
    );
    return row?.guardId == null ? null : Number(row.guardId);
  }

  /**
   * The replacement may take this shift: exactly the checks an assignment runs (relationship, active Guard account,
   * compliance, approved leave, availability, overlap), each refusal with a code. A Guard id this company cannot see
   * reads as not linked, so nothing about another company's Guards is revealed.
   */
  private async assertReplacementEligible(companyId: number, guardId: number, shift: Shift): Promise<void> {
    const E = REPLACE_GUARD_ERROR_CODES;
    const refuse = (code: ReplaceGuardErrorCode, message: string) => replaceGuardError(HttpStatus.UNPROCESSABLE_ENTITY, code, message);
    try {
      await this.companyGuardService.ensureActiveRelationship(companyId, guardId);
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      const [relation] = await this.dataSource.query(
        `SELECT "status" FROM "company_guards" WHERE "companyId" = $1 AND "guardId" = $2`,
        [companyId, guardId],
      );
      if (relation?.status === 'BLOCKED') throw refuse(E.BLOCKED, 'This Guard is blocked for your company.');
      throw refuse(E.NOT_LINKED, 'This Guard is not an active Guard of your company.');
    }
    const profile = await this.guardRepo.findOne({ where: { id: guardId }, relations: ['user'] });
    if (!profile?.user || profile.user.role !== UserRole.GUARD) {
      throw refuse(E.NOT_A_GUARD, 'This profile does not belong to a Guard account.');
    }
    if (profile.user.status !== UserStatus.ACTIVE) {
      throw refuse(E.ACCOUNT_INACTIVE, "This Guard's account is not active.");
    }
    try {
      await this.complianceService.assertGuardAssignable(companyId, guardId);
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      throw refuse(E.COMPLIANCE, error.message);
    }
    const result = await this.availabilityService.evaluateGuardForShift({
      companyId, guardId, startAt: new Date(shift.start), endAt: new Date(shift.end), excludeShiftId: shift.id,
    });
    // The same order and the same refusals as AvailabilityService.assertGuardCanTakeShift.
    if (result.hasShiftClash) throw refuse(E.OVERLAP, 'This Guard has an overlapping shift.');
    if (result.hasApprovedLeave) throw refuse(E.ON_LEAVE, 'This Guard has approved leave during this shift.');
    if (!result.complianceValid) throw refuse(E.COMPLIANCE, 'Guard compliance invalid.');
    if (result.availabilityStatus === 'unavailable') throw refuse(E.UNAVAILABLE, 'This Guard is marked unavailable for this time.');
  }

  /**
   * The replacement's resulting schedule against the Live Shift Amendment thresholds (the company's policy, never looser
   * than the platform safety limits; ShiftAmendmentService.policyFor). Scheduled hours only, over the Guard's shifts at
   * every company (that is what keeps the Guard safe); what the company may see withholds figures another company's
   * shift decides.
   */
  private async assessReplacement(companyId: number, guardId: number, shift: Shift) {
    if (!this.shiftAmendments) throw new Error('Replace Guard needs the shift policy (ShiftAmendmentService)');
    const policy = await this.shiftAmendments.policyFor(companyId);
    const startMs = new Date(shift.start).getTime();
    const endMs = new Date(shift.end).getTime();
    const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
    const [previous] = (await this.dataSource.query(
      `SELECT EXTRACT(EPOCH FROM "end") * 1000 AS "ms", "companyId" FROM "shifts"
        WHERE "guardId" = $1 AND "id" <> $2 AND "end" <= $3::timestamp
          AND "status" IN ('scheduled', 'offered', 'ready', 'in_progress', 'completed')
        ORDER BY "end" DESC LIMIT 1`,
      [guardId, shift.id, ts(startMs)],
    )) as Array<{ ms: string; companyId: number }>;
    const [next] = (await this.dataSource.query(
      `SELECT EXTRACT(EPOCH FROM "start") * 1000 AS "ms", "companyId" FROM "shifts"
        WHERE "guardId" = $1 AND "id" <> $2 AND "start" >= $3::timestamp
          AND "status" IN ('scheduled', 'offered', 'ready', 'in_progress')
        ORDER BY "start" ASC LIMIT 1`,
      [guardId, shift.id, ts(endMs)],
    )) as Array<{ ms: string; companyId: number }>;
    // The 7 days ending at this shift's end: the Guard's other committed or worked shifts, plus this one.
    const windowStart = endMs - 7 * 24 * 3_600_000;
    const [week] = (await this.dataSource.query(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST("end", $4::timestamp) - GREATEST("start", $3::timestamp)))), 0) / 3600 AS "all",
              COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST("end", $4::timestamp) - GREATEST("start", $3::timestamp))))
                FILTER (WHERE "companyId" = $5), 0) / 3600 AS "own"
         FROM "shifts"
        WHERE "guardId" = $1 AND "id" <> $2 AND "status" IN ('offered', 'ready', 'in_progress', 'completed')
          AND "start" < $4::timestamp AND "end" > $3::timestamp`,
      [guardId, shift.id, ts(windowStart), ts(endMs), companyId],
    )) as Array<{ all: string; own: string }>;
    const thisShiftHours = (endMs - Math.max(startMs, windowStart)) / 3_600_000;
    const raw = assessReplacementFatigue({
      startMs,
      endMs,
      nowMs: Date.now(),
      previousShiftEndMs: previous ? Number(previous.ms) : null,
      nextShiftStartMs: next ? Number(next.ms) : null,
      sevenDayScheduledHours: Number(week?.all ?? 0) + thisShiftHours,
      policy,
    });
    const safe = companySafeReplacementFatigue(raw, {
      restBeforeOwnCompany: !previous || Number(previous.companyId) === companyId,
      restAfterOwnCompany: !next || Number(next.companyId) === companyId,
      companySevenDayScheduledHours: Number(week?.own ?? 0) + thisShiftHours,
    });
    return { raw, safe };
  }


  /**
   * Marking a shift missed is a no-show finding. It needs the scheduled start plus the grace to have passed
   * and no Book On — the same rule Live Operations applies — so a future or a worked shift cannot be marked.
   */
  private async assertMayMarkMissed(shift: Shift): Promise<void> {
    if (Date.now() < shift.start.getTime() + MISSED_SHIFT_GRACE_MINUTES * 60_000) {
      throw new ConflictException(
        `A shift can only be marked missed ${MISSED_SHIFT_GRACE_MINUTES} minutes after its scheduled start.`,
      );
    }
    const [{ booked }] = await this.dataSource.query(
      // Effective attendance (Migration 67): any effective Book On, Guard app or manual.
      `SELECT EXISTS (SELECT 1 FROM "effective_attendance_events" WHERE "shiftId" = $1 AND "type" = 'check-in') AS "booked"`,
      [shift.id],
    );
    if (booked) {
      throw new ConflictException('The Guard has booked on to this shift. It cannot be marked missed.');
    }
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

    // A shift that is in progress is completed by the Guard's Book Off (AttendanceService), which records
    // the event, the actual times and the timesheet actuals together. Completing it here would do none of
    // that and record no reason, leaving a "completed" shift indistinguishable from a booked-off one.
    if (currentStatus === 'in_progress' && nextStatus === 'completed') {
      throw new BadRequestException(
        'An in-progress shift is completed by the Guard booking off. It cannot be marked completed by editing the shift.',
      );
    }

    const allowedTransitions: Record<string, string[]> = {
      unfilled: ['offered', 'cancelled'],
      offered: ['ready', 'rejected', 'cancelled'],
      ready: ['in_progress', 'missed', 'cancelled'],
      in_progress: [],
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
