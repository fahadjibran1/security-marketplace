import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
import {
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
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification.entity';
import { DailyLog } from '../daily-log/entities/daily-log.entity';
import { AttendanceEvent, AttendanceEventType } from '../attendance/entities/attendance.entity';
import { Shift } from '../shift/entities/shift.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { WelfareWindowService } from '../operations/welfare-window.service';
import { OperationalWindowService } from '../operations/operational-window.service';
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

/** A Book Off is late, not missing, until the shift has been over for a quarter of an hour. */
const MISSING_BOOK_OFF_GRACE_MINUTES = 15;

/**
 * Advisory-lock namespace for the welfare sweep, one lock per shift. Sits beside the admin-operator
 * namespace (534_401_400) so the two can never collide.
 */
const WELFARE_SWEEP_LOCK_NAMESPACE = 534_401_401;

type WelfareSweepCounters = {
  shiftsChecked: number;
  evidenceCreated: number;
  summariesOpened: number;
  summariesEscalated: number;
  summariesResolved: number;
  missingBookOffCreated: number;
  missingBookOffClosed: number;
};

@Injectable()
export class SafetyAlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SafetyAlertService.name);
  private welfareInterval?: NodeJS.Timeout;

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
  ) {}

  onModuleInit() {
    this.welfareInterval = setInterval(() => {
      this.runMissedWelfareChecks().catch((error) =>
        this.logger.error(`Missed welfare check scan failed: ${error?.message || error}`),
      );
    }, 5 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.welfareInterval) clearInterval(this.welfareInterval);
  }

  findAll(): Promise<SafetyAlert[]> {
    return this.safetyAlertRepo.find({ order: { createdAt: 'DESC' } });
  }

  async createForGuard(userId: number, dto: CreateSafetyAlertDto): Promise<SafetyAlert> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    let shift = null;
    if (dto.shiftId) {
      shift = await this.shiftService.findOne(dto.shiftId);
      this.shiftService.assertGuardCanOperateShift(shift, guard.id, 'raise a safety alert');
    }

    const company = shift?.company;
    if (!company) {
      throw new BadRequestException('Safety alerts must be linked to an assigned shift');
    }

    const type = dto.type ?? SafetyAlertType.OTHER;
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
    });

    const counters = {
      shiftsChecked: shifts.length,
      evidenceCreated: 0,
      summariesOpened: 0,
      summariesEscalated: 0,
      summariesResolved: 0,
      missingBookOffCreated: 0,
      missingBookOffClosed: 0,
    };

    if (shifts.length) {
      const shiftIds = shifts.map((shift) => shift.id);

      // Two set-based reads for the whole sweep rather than two per shift. The (shiftId, createdAt)
      // and (shiftId, occurredAt) indexes added by migration 59 serve exactly these.
      const [welfareLogs, attendanceEvents] = await Promise.all([
        this.dailyLogRepo.find({
          where: { shift: { id: In(shiftIds) }, logType: In(WELFARE_COMPLETION_LOG_TYPES) },
          order: { createdAt: 'ASC' },
        }),
        this.attendanceRepo.find({
          where: { shift: { id: In(shiftIds) } },
          order: { occurredAt: 'ASC' },
        }),
      ]);

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
   *   summary already CLOSED and a new miss appears           open a fresh one
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
    const open = await this.safetyAlertRepo.find({
      where: {
        type: SafetyAlertType.MISSING_BOOK_OFF,
        status: In([SafetyAlertStatus.OPEN, SafetyAlertStatus.ACKNOWLEDGED]),
      },
    });
    const shiftIds = open.map((alert) => alert.shift?.id).filter((id): id is number => Boolean(id));
    if (!shiftIds.length) return;

    const checkOuts = await this.attendanceRepo.find({
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
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    return this.safetyAlertRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    });
  }

  async acknowledgeForCompany(userId: number, alertId: number): Promise<SafetyAlert> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const alert = await this.safetyAlertRepo.findOne({ where: { id: alertId } });
    if (!alert) throw new NotFoundException('Safety alert not found');
    if (alert.company.id !== company.id) {
      throw new BadRequestException('This alert does not belong to the current company');
    }

    return this.acknowledge(alert, userId, company);
  }

  async acknowledgeAsAdmin(userId: number, alertId: number): Promise<SafetyAlert> {
    const alert = await this.safetyAlertRepo.findOne({ where: { id: alertId } });
    if (!alert) throw new NotFoundException('Safety alert not found');
    return this.acknowledge(alert, userId, alert.company);
  }

  async closeForCompany(userId: number, alertId: number): Promise<SafetyAlert> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const alert = await this.safetyAlertRepo.findOne({ where: { id: alertId } });
    if (!alert) throw new NotFoundException('Safety alert not found');
    if (alert.company.id !== company.id) {
      throw new BadRequestException('This alert does not belong to the current company');
    }

    return this.close(alert, userId, company);
  }

  async closeAsAdmin(userId: number, alertId: number): Promise<SafetyAlert> {
    const alert = await this.safetyAlertRepo.findOne({ where: { id: alertId } });
    if (!alert) throw new NotFoundException('Safety alert not found');
    return this.close(alert, userId, alert.company);
  }

  private async acknowledge(alert: SafetyAlert, userId: number, company: SafetyAlert['company']) {
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
      afterData: {
        status: saved.status,
        acknowledgedAt: saved.acknowledgedAt,
        acknowledgedByUserId: saved.acknowledgedByUserId,
      },
    });
    return saved;
  }

  private async close(alert: SafetyAlert, userId: number, company: SafetyAlert['company']) {
    if (!alert.acknowledgedAt) {
      alert.acknowledgedAt = new Date();
      alert.acknowledgedByUserId = userId;
    }
    alert.status = SafetyAlertStatus.CLOSED;
    alert.closedAt = new Date();
    alert.closedByUserId = userId;
    const saved = await this.safetyAlertRepo.save(alert);
    await this.auditLogService.log({
      company,
      user: { id: userId },
      action: 'safety_alert.closed',
      entityType: 'safety_alert',
      entityId: saved.id,
      afterData: {
        status: saved.status,
        closedAt: saved.closedAt,
        closedByUserId: saved.closedByUserId,
      },
    });
    return saved;
  }
}
