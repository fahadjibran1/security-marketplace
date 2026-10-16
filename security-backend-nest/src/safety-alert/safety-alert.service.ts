import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, MoreThan, Repository } from 'typeorm';
import {
  GUARD_RAISABLE_ALERT_TYPES,
  SafetyAlert,
  SafetyAlertPriority,
  SafetyAlertStatus,
  SafetyAlertType,
} from './entities/safety-alert.entity';
import { CreateSafetyAlertDto } from './dto/create-safety-alert.dto';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { ShiftService } from '../shift/shift.service';
import { CompanyService } from '../company/company.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ResolveSafetyAlertDto } from './dto/resolve-safety-alert.dto';
import { alertRequiresResolutionNote, alertResolutionReasons } from './resolution-reasons';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification.entity';
import { DailyLog } from '../daily-log/entities/daily-log.entity';
import { AttendanceEvent, AttendanceEventType } from '../attendance/entities/attendance.entity';
import { Shift } from '../shift/entities/shift.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { WelfareWindowService } from '../operations/welfare-window.service';
import { OperationalWindowService } from '../operations/operational-window.service';
import { GuardComplianceService } from '../compliance/guard-compliance.service';
import { CompanyMembership } from '../company-membership/entities/company-membership.entity';
import {
  CompanyMembershipRole,
  CompanyMembershipStatus,
  CompanyPermission,
  hasPermission,
} from '../company-membership/company-membership-types';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { Notification } from '../notification/entities/notification.entity';
import {
  COMPLIANCE_LAPSE_MONITOR_HOURS_AFTER_END,
  ComplianceLapse,
  complianceLapsesFrom,
  describeLapse,
  lapseAlertMessage,
} from './compliance-lapse';
// What satisfies a Welfare Check — a Guard's scheduled "check call" or a supervisor "welfare check" — is now
// decided in one place, alongside the window engine, rather than by a list local to this sweep.
import {
  WELFARE_COMPLETION_LOG_TYPES,
  toOperationalCompletions,
} from '../operations/operational-completion';
import {
  OperationalWindowResolution,
  OperationalWindowState,
  ResolvedOperationalWindow,
} from '../operations/operational-window.types';
import { SingleFlightJob, SingleFlightOutcome } from '../scheduler/single-flight-job';

/** A Book Off is late, not missing, until the shift has been over for a quarter of an hour. */
const MISSING_BOOK_OFF_GRACE_MINUTES = 15;

/**
 * Advisory-lock namespace for the welfare sweep, one lock per shift. Sits beside the admin-operator
 * namespace (534_401_400) so the two can never collide.
 */
const WELFARE_SWEEP_LOCK_NAMESPACE = 534_401_401;

/** Advisory-lock namespace for the compliance lapse sweep, one lock per shift. */
const COMPLIANCE_LAPSE_LOCK_NAMESPACE = 534_401_402;

/** The safety sweep's cadence, unchanged by Performance P2. */
const SAFETY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** A sweep still running after two intervals is reported at error level on every skipped tick. */
const SAFETY_SWEEP_OVERRUN_MS = 2 * SAFETY_SWEEP_INTERVAL_MS;

/**
 * What the sweeps read from a shift: its company (and the company's owner account, who is notified), its
 * guard (or the assignment's guard), and its site (timezone, Welfare interval, name). Performance P2: the
 * shift's eager graph also joined the company's and guard's users, the job, the application and the
 * assignment's own job, company and application, and the site's company and client - on every in-progress
 * shift, every five minutes, whether or not anyone was signed in. None of that is read here.
 */
const SWEEP_SHIFT_READ = {
  relations: { company: { user: true }, guard: true, assignment: { guard: true }, site: true },
  loadEagerRelations: false,
} as const;

/** Rows grouped by shift need only their own columns and the shift's id. */
const SWEEP_CHILD_READ = { relations: { shift: true }, loadEagerRelations: false } as const;

export type ComplianceLapseSweepCounters = {
  shiftsChecked: number;
  shiftsSkippedLocked: number;
  alertsRaised: number;
  notificationsCreated: number;
};

type WelfareSweepCounters = {
  shiftsChecked: number;
  evidenceCreated: number;
  summariesOpened: number;
  summariesEscalated: number;
  summariesResolved: number;
  summariesSuppressed: number;
  missingBookOffCreated: number;
  missingBookOffClosed: number;
};

@Injectable()
export class SafetyAlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SafetyAlertService.name);
  private welfareInterval?: NodeJS.Timeout;
  private safetySweep?: SingleFlightJob;

  constructor(
    @InjectRepository(SafetyAlert)
    private readonly safetyAlertRepo: Repository<SafetyAlert>,
    @InjectRepository(DailyLog)
    private readonly dailyLogRepo: Repository<DailyLog>,
    @InjectRepository(AttendanceEvent)
    private readonly attendanceRepo: Repository<AttendanceEvent>,
    @InjectRepository(Shift)
    private readonly shiftRepo: Repository<Shift>,
    private readonly guardProfileService: GuardProfileService,
    private readonly shiftService: ShiftService,
    private readonly companyService: CompanyService,
    private readonly auditLogService: AuditLogService,
    private readonly notificationService: NotificationService,
    private readonly welfareWindowService: WelfareWindowService,
    private readonly windowEngine: OperationalWindowService,
    private readonly dataSource: DataSource,
    private readonly guardComplianceService: GuardComplianceService,
  ) {}

  /**
   * The backend's own five-minute sweep. Started by the application at boot, independent of any page being
   * open, and re-established by every deploy or restart. Each scan logs its own failure and the next tick
   * simply runs again; a failing welfare scan never stops the compliance scan. Per-shift advisory locks and
   * unique indexes make overlapping or concurrent runs safe.
   *
   * Performance P2: one sweep at a time in this process. A tick that arrives while the previous sweep is
   * still running is skipped and logged rather than started beside it (scheduler/single-flight-job). Both
   * scans recompute everything from the database on each run, so the next tick does whatever a skipped one
   * would have done: a missed Welfare window, a missing Book Off or a lapse is deferred, never lost.
   */
  onModuleInit() {
    this.safetySweep = new SingleFlightJob(
      'safety-sweep',
      () =>
        this.runMissedWelfareChecks()
          .catch((error) => this.logger.error(`Missed welfare check scan failed: ${error?.message || error}`))
          .then(() => this.runComplianceLapseScan())
          .catch((error) => this.logger.error(`Compliance lapse scan failed: ${error?.message || error}`)),
      { overrunAfterMs: SAFETY_SWEEP_OVERRUN_MS },
    );
    this.welfareInterval = setInterval(() => void this.triggerSafetySweep(), SAFETY_SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.welfareInterval) clearInterval(this.welfareInterval);
    this.safetySweep?.stop();
  }

  /** What one timer tick does: start a sweep unless one is already running. Never rejects. */
  triggerSafetySweep(): Promise<SingleFlightOutcome> {
    if (!this.safetySweep) return Promise.resolve({ ran: false, skippedBecause: 'stopped' });
    return this.safetySweep.tick();
  }

  safetySweepStats() {
    return this.safetySweep?.stats() ?? null;
  }

  findAll(): Promise<SafetyAlert[]> {
    return this.safetyAlertRepo.find({ order: { createdAt: 'DESC' } });
  }

  async createForGuard(userId: number, dto: CreateSafetyAlertDto): Promise<SafetyAlert> {
    // System-generated types (missed Welfare Check, Missing Book Off, compliance lapse, ...) come only from
    // the server's own sweeps. A Guard may raise only the types in GUARD_RAISABLE_ALERT_TYPES; checked
    // first, before anything is looked up, so a forged type learns nothing about shifts.
    const type = dto.type ?? SafetyAlertType.OTHER;
    if (!GUARD_RAISABLE_ALERT_TYPES.includes(type)) {
      throw new BadRequestException('This alert type is raised by S4 only.');
    }
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    // The company, site and Guard all come from the authenticated Guard and THEIR OWN in-progress shift.
    // Nothing else in the request can name a company, site or Guard (the global whitelist rejects any
    // such field). A shift that does not exist and a shift that is someone else's are refused with the
    // same answer, so shift ids cannot be probed.
    let shift = null;
    if (dto.shiftId) {
      try {
        shift = await this.shiftService.findOne(dto.shiftId);
      } catch (error) {
        if (error instanceof NotFoundException) {
          throw new BadRequestException('This shift is not assigned to the current guard');
        }
        throw error;
      }
      this.shiftService.assertGuardCanOperateShift(shift, guard.id, 'raise a safety alert');
    }

    const company = shift?.company;
    if (!company) {
      throw new BadRequestException('Safety alerts must be linked to an assigned shift');
    }

    const priority =
      type === SafetyAlertType.PANIC
        ? SafetyAlertPriority.CRITICAL
        : dto.priority ?? SafetyAlertPriority.MEDIUM;

    const safetyAlert = this.safetyAlertRepo.create({
      company,
      guard,
      shift,
      type,
      priority,
      message: dto.message.trim(),
      status: SafetyAlertStatus.OPEN,
    });

    const saved = await this.safetyAlertRepo.save(safetyAlert);
    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'safety_alert.created',
      entityType: 'safety_alert',
      entityId: saved.id,
      afterData: {
        type: saved.type,
        priority: saved.priority,
        status: saved.status,
      },
    });

    if (company.user?.id) {
      const isPanic = saved.type === SafetyAlertType.PANIC;
      await this.notificationService.createForUser({
        userId: company.user.id,
        company,
        type: NotificationType.ALERT_RAISED,
        title: isPanic ? 'CRITICAL: Panic alert raised' : 'Safety alert raised',
        message: `${guard.user?.firstName ?? 'A guard'} raised a ${saved.type.replace('_', ' ')} alert.`,
      });
    }

    return saved;
  }

  /**
   * Resolve every Welfare Check window of every live shift and persist one durable record per window
   * that was missed.
   *
   * The old sweep kept a single rolling deadline from the most recent contact, so a Guard out of
   * touch for twenty-four hours produced exactly one alert and then silence. Windows are now fixed by
   * the schedule and each one settles on its own, so the same lapse produces twenty-four records.
   *
   * All window arithmetic belongs to WelfareWindowService; this method only reads state, writes
   * evidence, and maintains the one alert a control room should act on.
   */
  async runMissedWelfareChecks() {
    const now = new Date();
    const shifts = await this.shiftRepo.find({
      where: { status: 'in_progress' },
      order: { start: 'ASC' },
      ...SWEEP_SHIFT_READ,
    });

    const counters = {
      shiftsChecked: shifts.length,
      evidenceCreated: 0,
      summariesOpened: 0,
      summariesEscalated: 0,
      summariesResolved: 0,
      summariesSuppressed: 0,
      missingBookOffCreated: 0,
      missingBookOffClosed: 0,
    };

    if (shifts.length) {
      const shiftIds = shifts.map((shift) => shift.id);

      // Two set-based reads for the whole sweep rather than two per shift. The (shiftId, createdAt)
      // and (shiftId, occurredAt) indexes added by migration 59 serve exactly these. One after the other
      // (Performance P2), so the two reads never take two pooled connections at once.
      const welfareLogs = await this.dailyLogRepo.find({
        ...SWEEP_CHILD_READ,
        where: { shift: { id: In(shiftIds) }, logType: In(WELFARE_COMPLETION_LOG_TYPES) },
        order: { createdAt: 'ASC' },
      });
      const attendanceEvents = await this.attendanceRepo.find({
        ...SWEEP_CHILD_READ,
        where: { shift: { id: In(shiftIds) } },
        order: { occurredAt: 'ASC' },
      });

      const logsByShift = this.groupBy(welfareLogs, (log) => log.shift?.id);
      const attendanceByShift = this.groupBy(attendanceEvents, (event) => event.shift?.id);

      for (const shift of shifts) {
        await this.processShiftWelfare(
          shift,
          logsByShift.get(shift.id) ?? [],
          attendanceByShift.get(shift.id) ?? [],
          now,
          counters,
        );
      }
    }

    // Independent of the shift scan: a Book Off moves the shift to 'completed', so the shift that
    // needs its missing-Book-Off alert closing is no longer 'in_progress' and would never be revisited.
    await this.resolveMissingBookOffAlerts(counters);

    return counters;
  }

  /**
   * One shift's worth of work, serialised against other sweeps by an advisory lock held for the
   * transaction. A second concurrent sweep skips this shift rather than waiting, and picks it up on
   * its next pass; the unique indexes remain the final guard either way.
   */
  private async processShiftWelfare(
    shift: Shift,
    welfareLogs: DailyLog[],
    attendanceEvents: AttendanceEvent[],
    now: Date,
    counters: WelfareSweepCounters,
  ) {
    const guard = shift.guard ?? shift.assignment?.guard;
    if (!guard?.id || !shift.company?.id) return;

    const bookOnAt = this.earliest(attendanceEvents, AttendanceEventType.CHECK_IN);
    const bookOffAt = this.latest(attendanceEvents, AttendanceEventType.CHECK_OUT);

    const resolution = this.welfareWindowService.resolve({
      shiftStart: new Date(shift.start),
      shiftEnd: new Date(shift.end),
      interval: {
        siteWelfareCheckIntervalMinutes: shift.site?.welfareCheckIntervalMinutes,
        shiftCheckCallIntervalMinutes: shift.checkCallIntervalMinutes,
      },
      completions: toOperationalCompletions(welfareLogs),
      applicability: {
        bookOnAt,
        bookOffAt,
        shiftEnd: new Date(shift.end),
        cancelled: shift.status === 'cancelled',
      },
      now,
    });

    await this.dataSource.transaction(async (manager) => {
      const [{ locked }] = await manager.query('SELECT pg_try_advisory_xact_lock($1, $2) AS locked', [
        WELFARE_SWEEP_LOCK_NAMESPACE,
        shift.id,
      ]);
      if (!locked) return;

      for (const window of resolution.windows) {
        if (window.state !== OperationalWindowState.MISSED) continue;
        await this.recordWelfareMiss(manager, shift, guard, window, resolution.intervalMinutes, counters);
      }

      await this.maintainWelfareSummary(manager, shift, guard, resolution, counters);
      await this.maintainMissingBookOff(manager, shift, guard, bookOnAt, bookOffAt, now, counters);
    });
  }

  /**
   * Durable evidence for one missed window.
   *
   * Written with ON CONFLICT DO NOTHING against the partial unique index on
   * (shiftId, welfareWindowIndex), so repeated and concurrent sweeps converge on exactly one row per
   * window without a read-then-write race. The insert's own result tells us whether the row is new,
   * which is what keeps the audit trail free of duplicates.
   *
   * Recorded as CLOSED with no closing user: this is a record of something that already happened, not
   * a task. The actionable item is the single shift-level summary, which is what keeps a long lapse
   * from flooding the control room with one open alert per hour.
   */
  private async recordWelfareMiss(
    manager: EntityManager,
    shift: Shift,
    guard: GuardProfile,
    window: ResolvedOperationalWindow,
    intervalMinutes: number | null,
    counters: WelfareSweepCounters,
  ) {
    const timezone = shift.site?.timezone;
    const detectedAt = new Date();
    const inserted = await manager
      .createQueryBuilder()
      .insert()
      .into(SafetyAlert)
      .values({
        company: { id: shift.company.id },
        guard: { id: guard.id },
        shift: { id: shift.id },
        type: SafetyAlertType.MISSED_CHECKCALL,
        priority: SafetyAlertPriority.HIGH,
        status: SafetyAlertStatus.CLOSED,
        closedAt: detectedAt,
        welfareWindowIndex: window.index,
        message: `Welfare Check missed - ${this.formatWindowLabel(window, timezone)}`,
      })
      .orIgnore()
      .execute();

    const identifiers = (inserted.identifiers ?? []).filter(Boolean);
    if (!identifiers.length) return;

    counters.evidenceCreated += 1;
    await this.auditLogService.log({
      company: shift.company,
      user: null,
      action: 'welfare_check.window_missed',
      entityType: 'safety_alert',
      entityId: Number((identifiers[0] as { id?: number }).id),
      afterData: {
        shiftId: shift.id,
        guardId: guard.id,
        intervalMinutes,
        welfareWindowIndex: window.index,
        windowStart: window.start.toISOString(),
        windowEnd: window.end.toISOString(),
        dueAt: window.dueAt.toISOString(),
        missedFrom: window.missedFrom.toISOString(),
      },
    });
  }

  /**
   * At most one active shift-level summary, and it is the alert a control room acts on.
   *
   * The rule, deliberately the smallest that fits the existing OPEN / ACKNOWLEDGED / CLOSED lifecycle:
   *
   *   trailing run of missed windows > 0, no active summary   open one (OPEN, HIGH)
   *   trailing run grows, summary already active              rewrite the message only
   *   trailing run is 0 (latest settled window completed)     close the active summary
   *   summary CLOSED, a miss recorded after that closure      open a fresh one; the same misses never reopen it
   *
   * Status is never changed while misses continue, so a summary someone has ACKNOWLEDGED keeps that
   * state and does not silently revert to OPEN just because the sweep ran again: a human has taken
   * ownership, and the escalating message is what tells them it is getting worse.
   *
   * An alert left OPEN by the old rolling sweep matches this query and is adopted as the summary
   * rather than duplicated beside it, which is the role it already played.
   */
  private async maintainWelfareSummary(
    manager: EntityManager,
    shift: Shift,
    guard: GuardProfile,
    resolution: OperationalWindowResolution,
    counters: WelfareSweepCounters,
  ) {
    const missedRun = this.windowEngine.trailingMissedRun(resolution.windows);
    const active = await manager.findOne(SafetyAlert, {
      where: {
        shift: { id: shift.id },
        type: SafetyAlertType.MISSED_CHECKCALL,
        welfareWindowIndex: IsNull(),
        status: In([SafetyAlertStatus.OPEN, SafetyAlertStatus.ACKNOWLEDGED]),
      },
      order: { createdAt: 'DESC' },
      // Only the summary's own columns are read or changed (status, closedAt, message); relations that are
      // not loaded are left untouched when it is saved. Performance P2.
      loadEagerRelations: false,
    });

    if (missedRun === 0) {
      if (!active) return;
      active.status = SafetyAlertStatus.CLOSED;
      active.closedAt = new Date();
      const resolved = await manager.save(active);
      counters.summariesResolved += 1;
      await this.auditLogService.log({
        company: shift.company,
        user: null,
        action: 'welfare_check.summary_resolved',
        entityType: 'safety_alert',
        entityId: resolved.id,
        afterData: { shiftId: shift.id, guardId: guard.id, status: resolved.status },
      });
      return;
    }

    const message = `Welfare overdue - ${missedRun} consecutive check${missedRun === 1 ? '' : 's'} missed`;

    if (!active) {
      if (!(await this.hasMissSinceLastSummaryClosed(manager, shift, resolution))) {
        counters.summariesSuppressed += 1;
        return;
      }
      const created = await manager.save(
        manager.create(SafetyAlert, {
          company: shift.company,
          guard,
          shift,
          type: SafetyAlertType.MISSED_CHECKCALL,
          priority: SafetyAlertPriority.HIGH,
          status: SafetyAlertStatus.OPEN,
          welfareWindowIndex: null,
          message,
        }),
      );
      counters.summariesOpened += 1;
      await this.auditLogService.log({
        company: shift.company,
        user: null,
        action: 'welfare_check.summary_opened',
        entityType: 'safety_alert',
        entityId: created.id,
        afterData: { shiftId: shift.id, guardId: guard.id, missedRun },
      });
      if (shift.company.user?.id) {
        await this.notificationService.createForUser({
          userId: shift.company.user.id,
          company: shift.company,
          type: NotificationType.ALERT_RAISED,
          title: 'Missed welfare check',
          message: `${guard.fullName || 'A guard'} has missed a welfare check for ${shift.siteName}.`,
        });
      }
      return;
    }

    if (active.message === message) return;

    active.message = message;
    const escalated = await manager.save(active);
    counters.summariesEscalated += 1;
    await this.auditLogService.log({
      company: shift.company,
      user: null,
      action: 'welfare_check.summary_escalated',
      entityType: 'safety_alert',
      entityId: escalated.id,
      afterData: { shiftId: shift.id, guardId: guard.id, missedRun, status: escalated.status },
    });
    if (shift.company.user?.id) {
      await this.notificationService.createForUserUnlessRecentDuplicate(
        {
          userId: shift.company.user.id,
          company: shift.company,
          type: NotificationType.ALERT_RAISED,
          title: 'Missed welfare check',
          message: `${guard.fullName || 'A guard'} has now missed ${missedRun} welfare checks for ${shift.siteName}.`,
        },
        Math.max(5, resolution.intervalMinutes ?? 60),
      );
    }
  }

  /**
   * Whether the current run of misses contains a miss the control room has not already dealt with.
   *
   * A summary that has been closed — by a person, or by the sweep when a later check was completed — is
   * not opened again for the same misses. Before this rule, a shift whose Guard never booked off kept its
   * trailing run above zero forever, so every sweep after a controller closed the summary created a fresh
   * one for exactly the same missed windows.
   *
   * "Not already dealt with" is judged from the per-window evidence: a run window whose evidence row was
   * recorded after the most recent summary closure is a miss nobody had been shown when they closed it,
   * including one the sweep only caught up on after the closure. The comparison uses the evidence row's
   * own detection time (`closedAt`, set as it is inserted) rather than the window's schedule.
   */
  private async hasMissSinceLastSummaryClosed(
    manager: EntityManager,
    shift: Shift,
    resolution: OperationalWindowResolution,
  ) {
    const lastClosed = await manager.findOne(SafetyAlert, {
      where: {
        shift: { id: shift.id },
        type: SafetyAlertType.MISSED_CHECKCALL,
        welfareWindowIndex: IsNull(),
        status: SafetyAlertStatus.CLOSED,
      },
      order: { closedAt: { direction: 'DESC', nulls: 'LAST' }, id: 'DESC' },
      loadEagerRelations: false,
    });
    if (!lastClosed) return true;

    const runIndexes = this.windowEngine.trailingMissedWindows(resolution.windows).map((window) => window.index);
    if (!runIndexes.length) return false;

    // Both instants are compared inside the database, so neither passes through a JS Date. A summary
    // closed before closedAt was recorded falls back to its last update, which is when it was closed.
    const [{ n }] = await manager.query(
      `SELECT count(*)::int AS n FROM safety_alerts evidence
         WHERE evidence."shiftId" = $1 AND evidence.type = $2 AND evidence."welfareWindowIndex" = ANY($3::int[])
           AND COALESCE(evidence."closedAt", evidence."createdAt") >
               (SELECT COALESCE(summary."closedAt", summary."updatedAt") FROM safety_alerts summary WHERE summary.id = $4)`,
      [shift.id, SafetyAlertType.MISSED_CHECKCALL, runIndexes, lastClosed.id],
    );
    return Number(n) > 0;
  }

  /**
   * The Guard booked on and the shift's scheduled end passed more than fifteen minutes ago with no
   * Book Off recorded. One alert per shift, enforced by a partial unique index.
   *
   * Never raised for a shift that was cancelled or never booked on: an absent Guard is already covered
   * by the missed-shift mechanisms and is not a missing Book Off.
   */
  private async maintainMissingBookOff(
    manager: EntityManager,
    shift: Shift,
    guard: GuardProfile,
    bookOnAt: Date | null,
    bookOffAt: Date | null,
    now: Date,
    counters: WelfareSweepCounters,
  ) {
    if (bookOffAt || !bookOnAt || shift.status === 'cancelled') return;

    const shiftEnd = new Date(shift.end);
    if (Number.isNaN(shiftEnd.getTime())) return;
    if (now.getTime() <= shiftEnd.getTime() + MISSING_BOOK_OFF_GRACE_MINUTES * 60 * 1000) return;

    const inserted = await manager
      .createQueryBuilder()
      .insert()
      .into(SafetyAlert)
      .values({
        company: { id: shift.company.id },
        guard: { id: guard.id },
        shift: { id: shift.id },
        type: SafetyAlertType.MISSING_BOOK_OFF,
        priority: SafetyAlertPriority.MEDIUM,
        status: SafetyAlertStatus.OPEN,
        welfareWindowIndex: null,
        message: `Shift ended at ${this.formatTimeOfDay(shiftEnd, shift.site?.timezone)} - no Book Off recorded.`,
      })
      .orIgnore()
      .execute();

    const identifiers = (inserted.identifiers ?? []).filter(Boolean);
    if (!identifiers.length) return;

    counters.missingBookOffCreated += 1;
    await this.auditLogService.log({
      company: shift.company,
      user: null,
      action: 'shift.missing_book_off',
      entityType: 'safety_alert',
      entityId: Number((identifiers[0] as { id?: number }).id),
      afterData: {
        shiftId: shift.id,
        guardId: guard.id,
        scheduledEndAt: shiftEnd.toISOString(),
        bookOnAt: bookOnAt.toISOString(),
        graceMinutes: MISSING_BOOK_OFF_GRACE_MINUTES,
      },
    });
  }

  /**
   * A late Book Off answers the alert, so close it. History is preserved: the row stays, with its
   * original creation time and any acknowledgement intact.
   */
  private async resolveMissingBookOffAlerts(counters: WelfareSweepCounters) {
    // The alert's company (for its audit entry) and shift id are all this reads; the alert is saved with
    // only status and closedAt changed, and relations that were not loaded are left untouched.
    const open = await this.safetyAlertRepo.find({
      where: {
        type: SafetyAlertType.MISSING_BOOK_OFF,
        status: In([SafetyAlertStatus.OPEN, SafetyAlertStatus.ACKNOWLEDGED]),
      },
      relations: { company: true, shift: true },
      loadEagerRelations: false,
    });
    const shiftIds = open.map((alert) => alert.shift?.id).filter((id): id is number => Boolean(id));
    if (!shiftIds.length) return;

    const checkOuts = await this.attendanceRepo.find({
      ...SWEEP_CHILD_READ,
      where: { shift: { id: In(shiftIds) }, type: AttendanceEventType.CHECK_OUT },
    });
    const bookedOff = new Set(checkOuts.map((event) => event.shift?.id).filter(Boolean));

    for (const alert of open) {
      if (!alert.shift?.id || !bookedOff.has(alert.shift.id)) continue;
      alert.status = SafetyAlertStatus.CLOSED;
      alert.closedAt = new Date();
      const saved = await this.safetyAlertRepo.save(alert);
      counters.missingBookOffClosed += 1;
      await this.auditLogService.log({
        company: alert.company,
        user: null,
        action: 'shift.missing_book_off_resolved',
        entityType: 'safety_alert',
        entityId: saved.id,
        afterData: { shiftId: alert.shift.id, status: saved.status },
      });
    }
  }

  /**
   * Compliance lapse sweep (Migration 63).
   *
   * For every in_progress shift still operationally live (scheduled end within the last
   * COMPLIANCE_LAPSE_MONITOR_HOURS_AFTER_END hours), re-reads the shift company's own assessment of the Guard
   * and raises one critical compliance_lapse alert per lapsed SIA / Right to Work check: expired, recorded as
   * not confirmed, or missing.
   *
   * It only ever ADDS an alert, an audit entry and in-app notifications. It never books the Guard off,
   * changes the shift, removes the Guard, reassigns cover or overrides compliance. Closing the alert is a
   * company decision made through the existing acknowledge / close lifecycle.
   *
   * Idempotent and concurrency-safe: a per-shift advisory lock (skip if held) plus two partial unique
   * indexes (one active alert per company + shift + category; one alert per distinct lapse ever) with
   * ON CONFLICT DO NOTHING, so repeated sweeps and concurrent instances converge on one row.
   */
  async runComplianceLapseScan(now: Date = new Date()): Promise<ComplianceLapseSweepCounters> {
    const watchFrom = new Date(now.getTime() - COMPLIANCE_LAPSE_MONITOR_HOURS_AFTER_END * 3_600_000);
    const shifts = await this.shiftRepo.find({
      where: { status: 'in_progress', end: MoreThan(watchFrom) },
      order: { start: 'ASC' },
      ...SWEEP_SHIFT_READ,
    });
    const counters: ComplianceLapseSweepCounters = { shiftsChecked: 0, shiftsSkippedLocked: 0, alertsRaised: 0, notificationsCreated: 0 };

    for (const shift of shifts) {
      const guard = shift.guard ?? shift.assignment?.guard;
      if (!guard?.id || !shift.company?.id) continue;
      counters.shiftsChecked += 1;
      const summary = await this.guardComplianceService.getGuardSummary(guard.id, shift.company.id);
      const lapses = complianceLapsesFrom(summary);
      if (!lapses.length) continue;

      await this.dataSource.transaction(async (manager) => {
        const [{ locked }] = await manager.query('SELECT pg_try_advisory_xact_lock($1, $2) AS locked', [
          COMPLIANCE_LAPSE_LOCK_NAMESPACE,
          shift.id,
        ]);
        if (!locked) {
          counters.shiftsSkippedLocked += 1;
          return;
        }
        for (const lapse of lapses) {
          await this.raiseComplianceLapse(manager, shift, guard, lapse, now, counters);
        }
      });
    }
    return counters;
  }

  /** One lapse: insert-or-ignore the alert; only a NEW row gets an audit entry and notifications. */
  private async raiseComplianceLapse(
    manager: EntityManager,
    shift: Shift,
    guard: GuardProfile,
    lapse: ComplianceLapse,
    now: Date,
    counters: ComplianceLapseSweepCounters,
  ) {
    const inserted = await manager
      .createQueryBuilder()
      .insert()
      .into(SafetyAlert)
      .values({
        company: { id: shift.company.id },
        guard: { id: guard.id },
        shift: { id: shift.id },
        type: SafetyAlertType.COMPLIANCE_LAPSE,
        // Critical so it ranks with the most urgent work. Never type PANIC: every SOS / emergency surface
        // keys on the panic type, so this cannot be counted or shown as an SOS.
        priority: SafetyAlertPriority.CRITICAL,
        status: SafetyAlertStatus.OPEN,
        welfareWindowIndex: null,
        complianceCategory: lapse.category,
        complianceReason: lapse.reason,
        lapseKey: lapse.key,
        message: lapseAlertMessage(lapse),
      })
      .orIgnore()
      .execute();
    const identifiers = (inserted.identifiers ?? []).filter(Boolean);
    if (!identifiers.length) return;
    const alertId = Number((identifiers[0] as { id?: number }).id);
    counters.alertsRaised += 1;

    // Same transaction as the alert: the alert, its audit entry and its notifications commit together.
    await manager.save(
      manager.create(AuditLog, {
        company: { id: shift.company.id },
        user: null,
        action: 'shift.compliance_lapse_detected',
        entityType: 'safety_alert',
        entityId: alertId,
        afterData: {
          shiftId: shift.id,
          guardId: guard.id,
          siteId: shift.site?.id ?? null,
          category: lapse.category,
          reason: lapse.reason,
          checkId: lapse.checkId,
          detectedAt: now.toISOString(),
        },
      }),
    );

    const siteName = shift.site?.name || shift.siteName || 'the site';
    const recipients = await this.lapseRecipients(manager, shift.company.id);
    for (const userId of recipients.compliance) {
      await manager.save(
        manager.create(Notification, {
          user: { id: userId },
          company: { id: shift.company.id },
          type: NotificationType.COMPLIANCE_ALERT,
          title: 'Urgent compliance review required',
          message: `${guard.fullName || 'A Guard'} is on shift at ${siteName}: ${describeLapse(lapse)}. Review it now in Live Operations. S4 has not ended the shift.`,
        }),
      );
      counters.notificationsCreated += 1;
    }

    // Operations and Control Room run the live shift, so they are told an urgent eligibility review is
    // needed — but not what lapsed: no check category, reason, expiry, licence, immigration status or
    // evidence. The compliance detail stays with compliance-authorised roles.
    const window = `${this.formatTimeOfDay(new Date(shift.start), shift.site?.timezone)}-${this.formatTimeOfDay(new Date(shift.end), shift.site?.timezone)}`;
    for (const userId of recipients.operational) {
      await manager.save(
        manager.create(Notification, {
          user: { id: userId },
          company: { id: shift.company.id },
          type: NotificationType.COMPLIANCE_ALERT,
          title: 'Urgent eligibility review required',
          message: `${guard.fullName || 'The assigned Guard'} on the ${window} shift at ${siteName} needs an urgent eligibility review by your compliance team. S4 has not ended the shift; Book Off remains available.`,
        }),
      );
      counters.notificationsCreated += 1;
    }
  }

  /**
   * Who is told, by what they may know. In-app only: no email, SMS, WhatsApp or push. Never another
   * company's people and never Guards.
   *   compliance  — the company owner account and active members with compliance.manage (Owner, Admin,
   *                 HR / Compliance): the full, non-evidential reason.
   *   operational — active Operations and Control Room members: an eligibility review notice only.
   * Each user is in at most one list.
   */
  private async lapseRecipients(manager: EntityManager, companyId: number): Promise<{ compliance: number[]; operational: number[] }> {
    const [owner] = await manager.query('SELECT "userId" FROM "companies" WHERE id = $1', [companyId]);
    const members = await manager.getRepository(CompanyMembership).find({
      where: { companyId, status: CompanyMembershipStatus.ACTIVE },
    });
    const compliance = new Set<number>();
    const operational = new Set<number>();
    if (owner?.userId) compliance.add(Number(owner.userId));
    for (const member of members) {
      if (hasPermission(member.membershipRole, CompanyPermission.COMPLIANCE_MANAGE)) compliance.add(member.userId);
    }
    for (const member of members) {
      const operationalRole =
        member.membershipRole === CompanyMembershipRole.OPERATIONS || member.membershipRole === CompanyMembershipRole.CONTROL_ROOM;
      if (operationalRole && !compliance.has(member.userId)) operational.add(member.userId);
    }
    const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
    return { compliance: sorted(compliance), operational: sorted(operational) };
  }

  private formatWindowLabel(window: ResolvedOperationalWindow, timezone?: string | null): string {
    return `${this.formatTimeOfDay(window.start, timezone)}-${this.formatTimeOfDay(window.end, timezone)}`;
  }

  /**
   * Local wall-clock time at the site, so "21:00-22:00" reads the way the Guard and the control room
   * experienced it. Display only: every stored and audited value stays a UTC instant.
   */
  private formatTimeOfDay(value: Date, timezone?: string | null): string {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone || 'Europe/London',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(value);
    } catch {
      return value.toISOString().slice(11, 16);
    }
  }

  private earliest(events: AttendanceEvent[], type: AttendanceEventType): Date | null {
    const times = events
      .filter((event) => event.type === type && event.occurredAt instanceof Date)
      .map((event) => event.occurredAt.getTime());
    return times.length ? new Date(Math.min(...times)) : null;
  }

  private latest(events: AttendanceEvent[], type: AttendanceEventType): Date | null {
    const times = events
      .filter((event) => event.type === type && event.occurredAt instanceof Date)
      .map((event) => event.occurredAt.getTime());
    return times.length ? new Date(Math.max(...times)) : null;
  }

  private groupBy<T>(items: T[], keyOf: (item: T) => number | undefined): Map<number, T[]> {
    const grouped = new Map<number, T[]>();
    for (const item of items) {
      const key = keyOf(item);
      if (key === undefined) continue;
      const bucket = grouped.get(key);
      if (bucket) bucket.push(item);
      else grouped.set(key, [item]);
    }
    return grouped;
  }

  async findMine(userId: number): Promise<SafetyAlert[]> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    return this.safetyAlertRepo.find({
      where: { guard: { id: guard.id } },
      order: { createdAt: 'DESC' },
    });
  }

  async findForCompany(userId: number): Promise<SafetyAlert[]> {
    const actor = await this.alertActor(userId);
    if (actor.owner) {
      return this.safetyAlertRepo.find({
        where: { company: { id: actor.companyId } },
        order: { createdAt: 'DESC' },
      });
    }
    // A company member (not the owner account) sees only its own company's compliance lapse alerts, and
    // only with compliance.view. Every other alert type stays as before: owner and Platform Admin only.
    if (!hasPermission(actor.role, CompanyPermission.COMPLIANCE_VIEW)) throw new NotFoundException('Company not found');
    return this.safetyAlertRepo.find({
      where: { company: { id: actor.companyId }, type: SafetyAlertType.COMPLIANCE_LAPSE },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Who is acting on a company alert. The company owner account (the legacy owner, resolved exactly as
   * before) may act on any of its company's alerts. Anyone else must hold an ACTIVE company membership;
   * what that member may do is decided per alert by memberMayActOn.
   */
  private async alertActor(
    userId: number,
  ): Promise<{ owner: true; companyId: number; company: SafetyAlert['company'] } | { owner: false; companyId: number; role: CompanyMembershipRole }> {
    const company = await this.companyService.findByUserId(userId);
    if (company) return { owner: true, companyId: company.id, company };
    const membership = await this.dataSource.getRepository(CompanyMembership).findOne({
      where: { userId, status: CompanyMembershipStatus.ACTIVE },
    });
    if (!membership) throw new NotFoundException('Company not found');
    return { owner: false, companyId: membership.companyId, role: membership.membershipRole };
  }

  /**
   * A company member (Owner / Admin / HR-Compliance membership, i.e. compliance.manage) may acknowledge and
   * resolve its own company's COMPLIANCE LAPSE alerts and nothing else: panic / SOS, welfare, Missing Book
   * Off, site requests and incidents stay with the owner account and Platform Admin, as before.
   */
  private assertMemberMayAct(role: CompanyMembershipRole, alert: SafetyAlert) {
    if (alert.type !== SafetyAlertType.COMPLIANCE_LAPSE) {
      throw new ForbiddenException('Your role can act only on compliance alerts.');
    }
    if (!hasPermission(role, CompanyPermission.COMPLIANCE_MANAGE)) {
      throw new ForbiddenException('Insufficient permissions.');
    }
  }

  async acknowledgeForCompany(userId: number, alertId: number): Promise<SafetyAlert> {
    const actor = await this.alertActor(userId);

    const alert = await this.safetyAlertRepo.findOne({ where: { id: alertId } });
    if (!alert) throw new NotFoundException('Safety alert not found');
    if (alert.company.id !== actor.companyId) {
      throw new BadRequestException('This alert does not belong to the current company');
    }
    if (!actor.owner) this.assertMemberMayAct(actor.role, alert);

    return this.acknowledge(alert, userId, actor.owner ? actor.company : alert.company);
  }

  async acknowledgeAsAdmin(userId: number, alertId: number): Promise<SafetyAlert> {
    const alert = await this.safetyAlertRepo.findOne({ where: { id: alertId } });
    if (!alert) throw new NotFoundException('Safety alert not found');
    return this.acknowledge(alert, userId, alert.company);
  }

  async closeForCompany(
    userId: number,
    alertId: number,
    resolution?: ResolveSafetyAlertDto,
  ): Promise<SafetyAlert> {
    const actor = await this.alertActor(userId);

    const alert = await this.safetyAlertRepo.findOne({ where: { id: alertId } });
    if (!alert) throw new NotFoundException('Safety alert not found');
    if (alert.company.id !== actor.companyId) {
      throw new BadRequestException('This alert does not belong to the current company');
    }
    if (!actor.owner) this.assertMemberMayAct(actor.role, alert);

    return this.close(alert, userId, actor.owner ? actor.company : alert.company, resolution);
  }

  async closeAsAdmin(
    userId: number,
    alertId: number,
    resolution?: ResolveSafetyAlertDto,
  ): Promise<SafetyAlert> {
    const alert = await this.safetyAlertRepo.findOne({ where: { id: alertId } });
    if (!alert) throw new NotFoundException('Safety alert not found');
    return this.close(alert, userId, alert.company, resolution);
  }

  /**
   * What the resolve dialog may offer for this alert.
   *
   * Served from the same functions the close path validates against, so the UI cannot drift into
   * offering a reason the API would refuse — and `noteRequired` tells it which choices need words
   * without the client re-deriving the rule.
   */
  async resolutionOptions(userId: number, alertId: number, asAdmin: boolean) {
    const alert = await this.safetyAlertRepo.findOne({ where: { id: alertId } });
    if (!alert) throw new NotFoundException('Safety alert not found');

    if (!asAdmin) {
      const actor = await this.alertActor(userId);
      if (alert.company.id !== actor.companyId) {
        throw new BadRequestException('This alert does not belong to the current company');
      }
      if (!actor.owner) this.assertMemberMayAct(actor.role, alert);
    }

    return {
      alertId: alert.id,
      type: alert.type,
      reasons: alertResolutionReasons(alert.type).map((reason) => ({
        value: reason,
        noteRequired: alertRequiresResolutionNote(alert.type, reason),
      })),
    };
  }

  /**
   * The resolution evidence for THIS alert, validated against its own type.
   *
   * The type comes from the stored row, never from the request: a caller cannot widen the reason set
   * by claiming the alert is something it is not. A reason outside the type's set is refused rather
   * than stored, because a Missing Book Off closed as "network signal issue" is a sentence that is
   * not true about that record, and no later report can tell it apart from one that is.
   */
  private resolveEvidence(alert: SafetyAlert, resolution?: ResolveSafetyAlertDto) {
    const reason = resolution?.resolutionReason?.trim() || null;
    const note = resolution?.resolutionNote?.trim() || null;

    const allowed = alertResolutionReasons(alert.type);

    // A compliance lapse is evidence of how possible illegal or unlicensed working was handled, and nothing
    // closes one automatically: closing it ALWAYS states a reason and a note, even from a caller that sends
    // no body (the legacy no-payload close stays available for every other type).
    if (alert.type === SafetyAlertType.COMPLIANCE_LAPSE && !reason) {
      throw new BadRequestException('A resolution reason and note are required to close a compliance lapse alert.');
    }

    // Manual closure always states a reason. The automatic paths — a late Book Off answering its own
    // alert, a completed window closing the welfare summary — call `close()` with no resolution at
    // all and are deliberately unaffected: the system did not form a view, so it records none.
    if (resolution && !reason) {
      throw new BadRequestException('A resolution reason is required to close this alert.');
    }

    if (reason && !allowed.includes(reason)) {
      throw new BadRequestException(
        `"${reason}" is not a resolution reason for a ${alert.type} alert.`,
      );
    }

    if (reason && alertRequiresResolutionNote(alert.type, reason) && !note) {
      throw new BadRequestException(
        reason === 'other'
          ? 'A resolution note is required when the reason is "other".'
          : 'A resolution note is required to close this alert.',
      );
    }

    return { reason, note };
  }

  /** The lifecycle state of an alert before a transition, so the audit entry records what changed. */
  private transitionBefore(alert: SafetyAlert) {
    return {
      status: alert.status,
      acknowledgedAt: alert.acknowledgedAt ?? null,
      acknowledgedByUserId: alert.acknowledgedByUserId ?? null,
      closedAt: alert.closedAt ?? null,
      closedByUserId: alert.closedByUserId ?? null,
      resolutionReason: alert.resolutionReason ?? null,
    };
  }

  private async acknowledge(alert: SafetyAlert, userId: number, company: SafetyAlert['company']) {
    const beforeData = this.transitionBefore(alert);
    alert.status = SafetyAlertStatus.ACKNOWLEDGED;
    alert.acknowledgedAt = new Date();
    alert.acknowledgedByUserId = userId;
    const saved = await this.safetyAlertRepo.save(alert);
    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'safety_alert.acknowledged',
      entityType: 'safety_alert',
      entityId: saved.id,
      // The previous status, so the transition itself is auditable rather than only its outcome.
      beforeData,
      afterData: {
        type: saved.type,
        status: saved.status,
        acknowledgedAt: saved.acknowledgedAt,
        acknowledgedByUserId: saved.acknowledgedByUserId,
      },
    });
    return saved;
  }

  private async close(
    alert: SafetyAlert,
    userId: number,
    company: SafetyAlert['company'],
    resolution?: ResolveSafetyAlertDto,
  ) {
    // Validated before anything is mutated: a refused resolution must leave the alert exactly as it
    // was, still open and still in the queue.
    const { reason, note } = this.resolveEvidence(alert, resolution);
    const beforeData = this.transitionBefore(alert);

    if (!alert.acknowledgedAt) {
      alert.acknowledgedAt = new Date();
      alert.acknowledgedByUserId = userId;
    }
    alert.status = SafetyAlertStatus.CLOSED;
    alert.closedAt = new Date();
    alert.closedByUserId = userId;
    if (reason) alert.resolutionReason = reason;
    if (note) alert.resolutionNote = note;

    const saved = await this.safetyAlertRepo.save(alert);
    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'safety_alert.closed',
      entityType: 'safety_alert',
      entityId: saved.id,
      beforeData,
      afterData: {
        type: saved.type,
        status: saved.status,
        closedAt: saved.closedAt,
        closedByUserId: saved.closedByUserId,
        resolutionReason: saved.resolutionReason ?? null,
        resolutionNote: saved.resolutionNote ?? null,
      },
    });
    return saved;
  }
}
