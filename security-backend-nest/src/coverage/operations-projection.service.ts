import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import { AttendanceEvent, AttendanceEventType } from '../attendance/entities/attendance.entity';
import { DailyLog, DailyLogType } from '../daily-log/entities/daily-log.entity';
import {
  SafetyAlert,
  SafetyAlertStatus,
  SafetyAlertType,
} from '../safety-alert/entities/safety-alert.entity';
import { Shift } from '../shift/entities/shift.entity';
import {
  WELFARE_COMPLETION_LOG_TYPES,
  toOperationalCompletions,
} from '../operations/operational-completion';
import { LogBookWindowService } from '../operations/log-book-window.service';
import { OperationalWindowService } from '../operations/operational-window.service';
import { WelfareWindowService } from '../operations/welfare-window.service';
import {
  OperationalCompletion,
  OperationalCompletionKind,
  OperationalWindowState,
  ResolvedOperationalWindow,
} from '../operations/operational-window.types';

/**
 * What the control room needs to read off a board cell at a glance. Derived, never persisted: these
 * are presentation states over the window engine's output, not a new lifecycle to store.
 */
export type WelfarePresentationStatus =
  | 'not_applicable'
  | 'no_book_on'
  | 'current'
  | 'due'
  | 'overdue'
  | 'missed'
  | 'shift_complete';

export type OperationalWindowView = {
  index: number;
  start: string;
  end: string;
};

/**
 * One resolved Welfare window, as the engine decided it.
 *
 * Published so the control-room timeline can draw a marker per window and the operations export can
 * emit a row per window, WITHOUT either of them rebuilding the grid. `state` is the engine's own
 * verdict — completed, due, overdue, missed, not_applicable — passed through unchanged, because a
 * second mapping is how two surfaces start disagreeing.
 *
 * `applicable` is false for a window the Guard was never on duty for: nothing was owed, so the
 * timeline shows it as not-applicable rather than as a gap or a miss.
 */
export type WelfareWindowView = {
  index: number;
  start: string;
  end: string;
  state: OperationalWindowState;
  applicable: boolean;
  /** The first qualifying completion inside the window, or null. */
  completedAt: string | null;
  /** More than one completion in a window is legitimate; the obligation is still met once. */
  completionCount: number;
};

export type WelfareOperationsView = {
  enabled: boolean;
  intervalMinutes: number | null;
  status: WelfarePresentationStatus;
  currentWindow: OperationalWindowView | null;
  /**
   * Every resolved window for the shift, in order. Empty when the shift carries no Welfare
   * obligation. This is the grid the timeline draws and the export rows; it is NOT a second source of
   * truth, it is the same `welfare.windows` the summary counts are derived from.
   */
  windows: WelfareWindowView[];
  lastWelfareAt: string | null;
  nextDueAt: string | null;
  overdueByMinutes: number | null;
  requiredCount: number;
  completedCount: number;
  missedCount: number;
  consecutiveMissed: number;
};

export type LogBookOperationsView = {
  required: boolean;
  intervalMinutes: number | null;
  currentWindow: OperationalWindowView | null;
  currentWindowSubmitted: boolean;
  requiredCount: number;
  submittedCount: number;
  missingCount: number;
  lastEntryAt: string | null;
};

/**
 * The actionable Welfare alert, identified semantically: type missed_checkcall with a NULL window
 * index. Indexed rows are historical evidence and must never reach an urgent queue, which is why
 * this view carries one summary and a count rather than a list of alerts.
 */
export type WelfareSummaryView = {
  id: number;
  status: SafetyAlertStatus;
  message: string;
  acknowledged: boolean;
  createdAt: string;
};

export type ShiftOperationsView = {
  bookOnAt: string | null;
  bookOffAt: string | null;
  timezone: string;
  welfare: WelfareOperationsView;
  logBook: LogBookOperationsView;
  welfareSummary: WelfareSummaryView | null;
  welfareEvidenceCount: number;
  missingBookOff: boolean;
};

/** Shift statuses whose welfare obligation is over: the board should stop asking for checks. */
const SETTLED_SHIFT_STATUSES = new Set(['completed', 'cancelled', 'missed']);

@Injectable()
export class OperationsProjectionService {
  constructor(
    @InjectRepository(AttendanceEvent) private readonly attendanceRepo: Repository<AttendanceEvent>,
    @InjectRepository(DailyLog) private readonly dailyLogRepo: Repository<DailyLog>,
    @InjectRepository(SafetyAlert) private readonly safetyAlertRepo: Repository<SafetyAlert>,
    private readonly windowEngine: OperationalWindowService,
    private readonly welfareWindows: WelfareWindowService,
    private readonly logBookWindows: LogBookWindowService,
  ) {}

  /**
   * Build the operational monitoring block for a set of shifts.
   *
   * Four set-based reads for the whole board rather than four per shift: the caller has already
   * scoped the shifts to one company, so every read here is bounded by those ids and the migration 59
   * indexes serve them directly. Returned as a Map so the caller can attach each block to its row.
   */
  async projectForShifts(shifts: Shift[], now = new Date()): Promise<Map<number, ShiftOperationsView>> {
    const projections = new Map<number, ShiftOperationsView>();
    if (!shifts.length) return projections;

    const shiftIds = shifts.map((shift) => shift.id);
    const [attendance, welfareLogs, logBookLogs, alerts] = await Promise.all([
      this.attendanceRepo.find({ where: { shift: { id: In(shiftIds) } }, order: { occurredAt: 'ASC' } }),
      this.dailyLogRepo.find({
        where: { shift: { id: In(shiftIds) }, logType: In(WELFARE_COMPLETION_LOG_TYPES) },
        order: { createdAt: 'ASC' },
      }),
      this.dailyLogRepo.find({
        where: { shift: { id: In(shiftIds) }, logType: DailyLogType.LOG_BOOK },
        order: { createdAt: 'ASC' },
      }),
      this.safetyAlertRepo.find({
        where: [
          // The actionable Welfare summary, never the indexed evidence rows.
          {
            shift: { id: In(shiftIds) },
            type: SafetyAlertType.MISSED_CHECKCALL,
            welfareWindowIndex: IsNull(),
            status: In([SafetyAlertStatus.OPEN, SafetyAlertStatus.ACKNOWLEDGED]),
          },
          {
            shift: { id: In(shiftIds) },
            type: SafetyAlertType.MISSING_BOOK_OFF,
            status: In([SafetyAlertStatus.OPEN, SafetyAlertStatus.ACKNOWLEDGED]),
          },
        ],
        order: { createdAt: 'DESC' },
      }),
    ]);

    const attendanceByShift = this.groupBy(attendance, (event) => event.shift?.id);
    const welfareByShift = this.groupBy(welfareLogs, (log) => log.shift?.id);
    const logBookByShift = this.groupBy(logBookLogs, (log) => log.shift?.id);
    const alertsByShift = this.groupBy(alerts, (alert) => alert.shift?.id);

    for (const shift of shifts) {
      projections.set(
        shift.id,
        this.projectShift(
          shift,
          attendanceByShift.get(shift.id) ?? [],
          welfareByShift.get(shift.id) ?? [],
          logBookByShift.get(shift.id) ?? [],
          alertsByShift.get(shift.id) ?? [],
          now,
        ),
      );
    }
    return projections;
  }

  private projectShift(
    shift: Shift,
    attendance: AttendanceEvent[],
    welfareLogs: DailyLog[],
    logBookLogs: DailyLog[],
    alerts: SafetyAlert[],
    now: Date,
  ): ShiftOperationsView {
    const timezone = shift.site?.timezone || 'Europe/London';
    const shiftStart = new Date(shift.start);
    const shiftEnd = new Date(shift.end);
    const status = (shift.status || '').trim().toLowerCase();
    const cancelled = status === 'cancelled';
    const settled = SETTLED_SHIFT_STATUSES.has(status);

    const bookOnAt = this.earliest(attendance, AttendanceEventType.CHECK_IN);
    const bookOffAt = this.latest(attendance, AttendanceEventType.CHECK_OUT);
    const applicability = { bookOnAt, bookOffAt, shiftEnd, cancelled };

    // One classified batch, filtered by each obligation to its own kind — the same structural
    // separation the sweep relies on, so a Log Book entry can never satisfy a Welfare window here.
    const welfareCompletions = toOperationalCompletions(welfareLogs);
    const logBookCompletions: OperationalCompletion[] = logBookLogs.map((log) => ({
      at: log.createdAt,
      kind: OperationalCompletionKind.LOG_BOOK,
    }));

    const welfare = this.welfareWindows.resolve({
      shiftStart,
      shiftEnd,
      interval: {
        siteWelfareCheckIntervalMinutes: shift.site?.welfareCheckIntervalMinutes,
        shiftCheckCallIntervalMinutes: shift.checkCallIntervalMinutes,
      },
      completions: welfareCompletions,
      applicability,
      now,
    });

    const logBookInterval = shift.site?.logBookIntervalMinutes ?? null;
    const logBook = this.logBookWindows.resolve({
      shiftStart,
      shiftEnd,
      intervalMinutes: logBookInterval,
      completions: logBookCompletions,
      applicability,
      now,
    });

    const currentWelfareWindow = this.currentApplicableWindow(welfare.windows, now);
    const currentLogBookWindow = this.currentApplicableWindow(logBook.windows, now);
    const consecutiveMissed = this.windowEngine.trailingMissedRun(welfare.windows);

    const lastWelfareAt = welfareLogs.length
      ? welfareLogs[welfareLogs.length - 1].createdAt.toISOString()
      : null;
    const lastLogBookAt = logBookLogs.length
      ? logBookLogs[logBookLogs.length - 1].createdAt.toISOString()
      : null;

    const summaryAlert = alerts.find(
      (alert) => alert.type === SafetyAlertType.MISSED_CHECKCALL && alert.welfareWindowIndex == null,
    );
    const missingBookOffAlert = alerts.find((alert) => alert.type === SafetyAlertType.MISSING_BOOK_OFF);

    return {
      bookOnAt: bookOnAt ? bookOnAt.toISOString() : null,
      bookOffAt: bookOffAt ? bookOffAt.toISOString() : null,
      timezone,
      welfare: {
        enabled: welfare.windows.length > 0,
        intervalMinutes: welfare.intervalMinutes,
        status: this.welfareStatus({
          cancelled,
          settled,
          bookOnAt,
          currentWindow: currentWelfareWindow,
          consecutiveMissed,
        }),
        currentWindow: this.toWindowView(currentWelfareWindow),
        windows: welfare.windows.map((window) => this.toWelfareWindowView(window)),
        lastWelfareAt,
        nextDueAt: currentWelfareWindow ? currentWelfareWindow.end.toISOString() : null,
        overdueByMinutes:
          currentWelfareWindow && currentWelfareWindow.state === OperationalWindowState.OVERDUE
            ? Math.max(0, Math.floor((now.getTime() - currentWelfareWindow.end.getTime()) / 60000))
            : null,
        requiredCount: welfare.summary.requiredCount,
        completedCount: welfare.summary.completedCount,
        missedCount: welfare.summary.missedCount,
        consecutiveMissed,
      },
      logBook: {
        // NULL interval means "as required": entries are welcome, nothing is ever missing.
        required: logBookInterval !== null && logBook.windows.length > 0,
        intervalMinutes: logBook.intervalMinutes,
        currentWindow: this.toWindowView(currentLogBookWindow),
        currentWindowSubmitted: Boolean(
          currentLogBookWindow && currentLogBookWindow.completionCount > 0,
        ),
        requiredCount: logBook.summary.requiredCount,
        submittedCount: logBook.summary.completedCount,
        missingCount: logBook.summary.missedCount,
        lastEntryAt: lastLogBookAt,
      },
      welfareSummary: summaryAlert
        ? {
            id: summaryAlert.id,
            status: summaryAlert.status,
            message: summaryAlert.message,
            acknowledged: summaryAlert.status === SafetyAlertStatus.ACKNOWLEDGED,
            createdAt: summaryAlert.createdAt.toISOString(),
          }
        : null,
      // A count, deliberately, not a list: twenty-four missed windows are twenty-four records but
      // must never become twenty-four items in the control room's queue.
      welfareEvidenceCount: welfare.summary.missedCount,
      missingBookOff: Boolean(missingBookOffAlert),
    };
  }

  /**
   * The applicable window containing `now`, which is what "current" means on the board.
   *
   * Deliberately the live window rather than the oldest missed one: after a lapse the control room
   * needs to know what is expected next, not to be pinned to the first window that was missed. Once
   * the shift has run past its scheduled end there is no current window at all.
   */
  private currentApplicableWindow(
    windows: readonly ResolvedOperationalWindow[],
    now: Date,
  ): ResolvedOperationalWindow | null {
    const instant = now.getTime();
    // A window inside its grace period wins over the one that has just opened. Both are true at the
    // same moment, and the overdue one is what the control room has to chase; showing the new window
    // as merely "due" would hide the lapse for five minutes.
    const inGrace = windows.find(
      (window) => window.applicable && window.state === OperationalWindowState.OVERDUE,
    );
    if (inGrace) return inGrace;
    return (
      windows.find(
        (window) =>
          window.applicable && instant >= window.start.getTime() && instant < window.end.getTime(),
      ) ?? null
    );
  }

  private welfareStatus(input: {
    cancelled: boolean;
    settled: boolean;
    bookOnAt: Date | null;
    currentWindow: ResolvedOperationalWindow | null;
    consecutiveMissed: number;
  }): WelfarePresentationStatus {
    if (input.cancelled) return 'not_applicable';
    // No Book On is an attendance exception, never a welfare breach.
    if (!input.bookOnAt) return 'no_book_on';
    if (input.settled) return 'shift_complete';
    if (!input.currentWindow) {
      // Past the scheduled end, or before the grid opens: nothing is currently owed, but a standing
      // lapse still needs to read as a lapse.
      return input.consecutiveMissed > 0 ? 'missed' : 'not_applicable';
    }
    if (input.currentWindow.state === OperationalWindowState.OVERDUE) return 'overdue';
    if (input.currentWindow.state === OperationalWindowState.COMPLETED) {
      // A completed current window with an unresolved run behind it is still a lapse to chase.
      return input.consecutiveMissed > 0 ? 'missed' : 'current';
    }
    return input.consecutiveMissed > 0 ? 'missed' : 'due';
  }

  private toWindowView(window: ResolvedOperationalWindow | null): OperationalWindowView | null {
    if (!window) return null;
    return { index: window.index, start: window.start.toISOString(), end: window.end.toISOString() };
  }

  /** The engine's verdict for one window, published verbatim. Nothing is recomputed or re-mapped. */
  private toWelfareWindowView(window: ResolvedOperationalWindow): WelfareWindowView {
    return {
      index: window.index,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      state: window.state,
      applicable: window.applicable,
      completedAt: window.completedAt ? window.completedAt.toISOString() : null,
      completionCount: window.completionCount,
    };
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
}
