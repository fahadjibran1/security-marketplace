import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { effectiveAttendance } from '../attendance/effective-attendance';
import { PATROL_SWEEP_LOCK_NAMESPACE } from '../operations/advisory-locks';
import { SingleFlightJob, SingleFlightOutcome } from '../scheduler/single-flight-job';
import { EffectivePolicy, PatrolConfigService } from './patrol-config.service';
import { SafetyAlert, SafetyAlertPriority, SafetyAlertStatus, SafetyAlertType } from '../safety-alert/entities/safety-alert.entity';
import { PatrolExceptionType } from './patrol-constants';
import { PatrolExceptionService } from './patrol-exception.service';
import { syncAcceptanceEndsAt } from './patrol-late-sync';
import {
  completionDeadline,
  completionFindings,
  evaluateRequirements,
  runProgressState,
  startDeadline,
  syncDeadline,
  verificationFinalAt,
  verificationState,
} from './patrol-state';
import { PatrolDutyShift, PatrolWindow, PatrolWindowService } from './patrol-window.service';

/** The sweep's cadence, as the safety sweep's. */
export const PATROL_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/**
 * The live sweep's lookback (L): how far before a window's start deadline its start may lie (a day plus the longest
 * grace). The sweep runs every five minutes, so a window is normally judged within minutes of its start deadline. A gap
 * in sweeping (server, database or sweep outage) is closed by the watermark: up to L it is absorbed by a wider live pass,
 * beyond L by bounded reconciliation (#67, below).
 */
export const PATROL_SWEEP_LOOKBACK_HOURS = 26;
/** Reconciliation (#67): start deadlines older than this, at the time a gap is found, are recorded as NOT judged. */
export const PATROL_RECONCILIATION_HORIZON_DAYS = 14;
/** Reconciliation batch bounds: at most 6 h of start deadlines and at most 500 judged windows per batch (one transaction). */
export const PATROL_RECONCILIATION_BATCH_HOURS = 6;
export const PATROL_RECONCILIATION_BATCH_WINDOWS = 500;
/** Batches per company per sweep pass (each its own transaction): ≤ 48 h of catch-up every five minutes. */
export const PATROL_RECONCILIATION_BATCHES_PER_PASS = 8;
/** How many windows a site's reconciliation summary alert lists by name (the rest are counted). */
const SUMMARY_LISTED_WINDOWS = 10;
/** Finished runs are re-evaluated (verification, late evidence) until their verification settles, at most this long. */
const RUN_REVIEW_DAYS = 4;
const HOUR_MS = 3_600_000;
const LOOKBACK_MS = PATROL_SWEEP_LOOKBACK_HOURS * HOUR_MS;

export type PatrolSweepCounters = {
  companies: number;
  companiesSkippedLocked: number;
  windowsJudged: number;
  exceptionsRaised: number;
  alertsRaised: number;
  byType: Partial<Record<PatrolExceptionType, number>>;
  runsClosedGuardReplaced: number;
  runsClosedBySystem: number;
  runsVerified: number;
  /** Reconciliation (#67). */
  reconciliationsStarted: number;
  reconciliationBatches: number;
  reconciledWindows: number;
  reconciledExceptions: number;
  reconciliationsCompleted: number;
  reconciliationAlerts: number;
};

type SiteInfo = { name: string; timezone: string };
type Raise = (input: Parameters<PatrolExceptionService['raise']>[1]) => Promise<boolean>;
type JudgeRange = {
  /** The clock: deadlines must have passed by then. */
  now: Date;
  /** Windows starting before this are never judged (lookback, switch-on time; the schedule's last change applies too). */
  startFloor: Date;
  /** Only windows whose start deadline is after this (exclusive) and at or before deadlineTo (inclusive). */
  deadlineFrom: Date | null;
  deadlineTo: Date;
  /** Reconciliation: at most this many judged windows (ties at the cut-off deadline are kept together). */
  limit?: number;
  reconciliationRunId?: number;
};

/**
 * The patrol sweep (Patrols P1-B). Every five minutes, one run at a time in this process (SingleFlightJob), and per
 * company under a TRY advisory lock (PATROL_SWEEP_LOCK_NAMESPACE, keyed by company id) so a concurrent sweep — another
 * tick or another instance — skips that company instead of doubling up; the unique indexes are the final guard.
 *
 * Only companies with patrolsEnabled = true are read, and the switch is re-checked inside each company's transaction, so
 * turning Patrols off stops the sweep for that company immediately. Welfare is never read or written here.
 *
 * MATERIALISATION. Windows are computed, never stored: a schedule's windows are a pure function of its definition and the
 * site's time zone (patrol-window.service.ts). Rows are written only when something happened: a run (by the Guard), or an
 * exception when a deadline passed unmet. So an hourly schedule on a site with nobody on duty writes nothing at all, and
 * row growth is bounded by real patrols and real exceptions, never by the calendar. A window is judged only when it
 * started after the schedule was last changed and after Patrols was last switched on for the company, so editing a
 * schedule or switching on never raises retrospective exceptions.
 *
 * Each pass, per company:
 *   1. Replace Guard: a run still in progress by a Guard who is no longer the shift's Guard is closed incomplete,
 *      reason guard_replaced (the windows follow the shift; the run keeps who actually performed it).
 *   2. Missed: each due window of each active schedule whose start deadline has passed, for each scope on duty (the site,
 *      or each on-duty shift for per-guard), with no run → patrol_missed.
 *   3. Runs: in progress past the completion deadline → patrol_abandoned; in progress past the post-shift sync acceptance
 *      window → closed_by_system; finished → incomplete / checkpoint missed findings, then verification (verified, flagged,
 *      or unverified at the sync deadline → evidence_unverified, alerted only when the policy escalates it), settled 24 h
 *      after the sync deadline.
 *
 * WATERMARK AND OUTAGE RECONCILIATION (Migration 71, #67). patrol_sweep_watermarks.judgedThrough (J) per company: every
 * window whose start deadline is ≤ J has been judged. It moves only inside the transaction that did the judging, under the
 * company's sweep lock. With J' = max(J, last switch-on):
 *   • now − J' ≤ L (normal; L = 26 h): the live pass judges windows starting from max(J' − L, now − 2L) — a wider pass
 *     after a short gap — and sets J = now. (No watermark yet: today's lookback, then J = now. Nothing is backdated.)
 *   • now − J' > L (an outage longer than the lookback): the live pass still runs every five minutes for recent windows
 *     (from now − 2L, so every deadline after now − L is covered) and normal alerting continues; the gap of deadlines
 *     (J', now − L] is reconciled in bounded batches, oldest first: ≤ 6 h of deadlines and ≤ 500 judged windows per batch,
 *     each batch one transaction that also advances J and the run's throughAt (≤ 8 batches per company per pass). The
 *     catch-up is a patrol_reconciliation_runs row (at most one running per company). Exceptions it raises carry
 *     reconciliationRunId and raise no alert of their own; when it completes, ONE summary alert per (site, run) lists the
 *     missed windows. Deadlines older than now − 14 days are NOT judged: the run records unjudgedFrom / unjudgedTo, it is
 *     audited (patrol.reconciliation_horizon_exceeded) and ONE explicit alert is raised (when the company has a schedule)
 *     — never silently dropped. Audit: patrol.reconciliation_started / _batch / _completed.
 * Reconciliation judges exactly as the live pass does (historical effective attendance, the schedule's last change and the
 * switch-on time as floors, runs — late-synced ones too — satisfying their windows). A crash rolls back the batch; the
 * next pass repeats it, and the exception key (company, windowKey, scopeKey, type) and the alert keys make every repeat a
 * no-op.
 */
@Injectable()
export class PatrolSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PatrolSweepService.name);
  private interval?: NodeJS.Timeout;
  private job?: SingleFlightJob;

  constructor(
    private readonly dataSource: DataSource,
    private readonly windows: PatrolWindowService,
    private readonly config: PatrolConfigService,
    private readonly exceptions: PatrolExceptionService,
    private readonly auditLogService: AuditLogService,
  ) {}

  onModuleInit() {
    this.job = new SingleFlightJob(
      'patrol-sweep',
      () => this.sweep(new Date()).catch((error) => this.logger.error(`Patrol sweep failed: ${error?.message || error}`)),
      { overrunAfterMs: 2 * PATROL_SWEEP_INTERVAL_MS },
    );
    this.interval = setInterval(() => void this.tick(), PATROL_SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
    this.job?.stop();
  }

  /** What one timer tick does: start a sweep unless one is already running. Never rejects. */
  tick(): Promise<SingleFlightOutcome> {
    if (!this.job) return Promise.resolve({ ran: false, skippedBecause: 'stopped' });
    return this.job.tick();
  }

  /**
   * One pass. `options.reconciliationBatches` bounds the reconciliation batches per company in this pass (default
   * PATROL_RECONCILIATION_BATCHES_PER_PASS; a certification tool may pass fewer to observe progress batch by batch).
   */
  async sweep(now: Date = new Date(), options: { reconciliationBatches?: number } = {}): Promise<PatrolSweepCounters> {
    const counters: PatrolSweepCounters = {
      companies: 0, companiesSkippedLocked: 0, windowsJudged: 0, exceptionsRaised: 0, alertsRaised: 0, byType: {},
      runsClosedGuardReplaced: 0, runsClosedBySystem: 0, runsVerified: 0,
      reconciliationsStarted: 0, reconciliationBatches: 0, reconciledWindows: 0, reconciledExceptions: 0, reconciliationsCompleted: 0,
      reconciliationAlerts: 0,
    };
    const maxBatches = Math.max(0, options.reconciliationBatches ?? PATROL_RECONCILIATION_BATCHES_PER_PASS);
    const companies = await this.dataSource.query(`SELECT "id" FROM "companies" WHERE "patrolsEnabled" = true ORDER BY "id"`);
    for (const { id } of companies) {
      const companyId = Number(id);
      const live = await this.underCompanyLock(companyId, async (manager) => {
        counters.companies += 1;
        await this.sweepCompany(manager, companyId, now, counters);
      });
      if (live === 'locked') {
        counters.companiesSkippedLocked += 1;
        continue;
      }
      // Reconciliation after a long gap: one committed batch per transaction, oldest first, bounded per pass.
      for (let i = 0; i < maxBatches; i += 1) {
        const step = await this.underCompanyLock(companyId, (manager) => this.reconcileStep(manager, companyId, now, counters));
        if (step !== 'batch') break;
      }
    }
    return counters;
  }

  /**
   * fn inside one transaction holding the company's sweep lock (TRY: another tick or instance holding it means 'locked'),
   * with the switch re-checked inside ('disabled' when it was turned off since the company list was read).
   */
  private async underCompanyLock<T>(companyId: number, fn: (manager: EntityManager) => Promise<T>): Promise<T | 'locked' | 'disabled'> {
    return this.dataSource.transaction(async (manager) => {
      const [{ locked }] = await manager.query('SELECT pg_try_advisory_xact_lock($1, $2) AS locked', [PATROL_SWEEP_LOCK_NAMESPACE, companyId]);
      if (!locked) return 'locked' as const;
      const [company] = await manager.query(`SELECT "patrolsEnabled" FROM "companies" WHERE "id" = $1`, [companyId]);
      if (company?.patrolsEnabled !== true) return 'disabled' as const; // switched off since the list was read
      return fn(manager);
    });
  }

  /** When Patrols was last switched on for the company (windows that started earlier are never judged). */
  private async enabledAt(manager: EntityManager, companyId: number): Promise<Date | null> {
    const [{ enabledAt }] = await manager.query(
      `SELECT max("createdAt") AS "enabledAt" FROM "audit_logs"
        WHERE "companyId" = $1 AND "action" = 'company.patrols_enabled_changed' AND ("afterData"->>'patrolsEnabled') = 'true'`,
      [companyId],
    );
    return enabledAt ? new Date(enabledAt) : null;
  }

  /** The watermark, locked for this transaction; null before the company's first pass with Migration 71. */
  private async watermark(manager: EntityManager, companyId: number): Promise<Date | null> {
    const [row] = await manager.query(`SELECT "judgedThrough" FROM "patrol_sweep_watermarks" WHERE "companyId" = $1 FOR UPDATE`, [companyId]);
    return row ? new Date(row.judgedThrough) : null;
  }

  private async setWatermark(manager: EntityManager, companyId: number, judgedThrough: Date) {
    await manager.query(
      `INSERT INTO "patrol_sweep_watermarks" ("companyId", "judgedThrough", "updatedAt") VALUES ($1, $2, now())
       ON CONFLICT ("companyId") DO UPDATE SET "judgedThrough" = EXCLUDED."judgedThrough", "updatedAt" = now()`,
      [companyId, judgedThrough],
    );
  }

  private async sweepCompany(manager: EntityManager, companyId: number, now: Date, counters: PatrolSweepCounters) {
    const enabledAt = await this.enabledAt(manager, companyId);
    const judgedThrough = await this.watermark(manager, companyId);
    const effective = judgedThrough && enabledAt && enabledAt.getTime() > judgedThrough.getTime() ? enabledAt : judgedThrough;
    const reconciling = effective !== null && now.getTime() - effective.getTime() > LOOKBACK_MS;
    // Normal: the lookback, widened back to (watermark − L) after a short gap, never beyond now − 2L. While reconciling,
    // now − 2L: every deadline after now − L is judged here, everything older by reconciliation batches.
    let floorMs = now.getTime() - LOOKBACK_MS;
    if (effective) floorMs = Math.max(now.getTime() - 2 * LOOKBACK_MS, Math.min(floorMs, effective.getTime() - LOOKBACK_MS));
    const horizonStart = new Date(Math.max(floorMs, enabledAt ? enabledAt.getTime() : floorMs));

    await this.closeReplacedGuardRuns(manager, companyId, now, counters);

    const ctx = await this.companyContext(manager, companyId, horizonStart, counters, false);
    // While reconciling, deadlines up to now − L belong to the reconciliation batches (marked, summarised), not to this pass.
    const deadlineFrom = reconciling ? new Date(now.getTime() - LOOKBACK_MS) : null;
    const live = await this.judgeWindows(manager, companyId, { now, startFloor: horizonStart, deadlineFrom, deadlineTo: now }, ctx.sites, ctx.policyFor, ctx.raise);
    counters.windowsJudged += live.windowsJudged;
    await this.judgeRuns(manager, companyId, now, ctx.sites, ctx.policyFor, ctx.raise, counters);
    // Everything due by now is judged — unless a gap older than the lookback is still being reconciled.
    if (!reconciling) await this.setWatermark(manager, companyId, now);
  }

  /** Sites, a policy cache and the raise function (deduplicated within the transaction; the database is the real guard). */
  private async companyContext(manager: EntityManager, companyId: number, since: Date, counters: PatrolSweepCounters, reconciled: boolean) {
    const sites = new Map<number, SiteInfo>();
    for (const s of await manager.query(`SELECT "id", "name", "timezone" FROM "sites" WHERE "companyId" = $1`, [companyId])) {
      sites.set(Number(s.id), { name: s.name, timezone: s.timezone || 'Europe/London' });
    }
    const policies = new Map<number, EffectivePolicy>();
    const policyFor = async (siteId: number) => {
      let policy = policies.get(siteId);
      if (!policy) {
        policy = await this.config.effectivePolicy(companyId, siteId, manager);
        policies.set(siteId, policy);
      }
      return policy;
    };
    const existing = new Set<string>(
      (await manager.query(
        `SELECT "windowKey", "scopeKey", "type" FROM "patrol_exceptions" WHERE "companyId" = $1 AND "createdAt" > $2`,
        [companyId, new Date(since.getTime() - RUN_REVIEW_DAYS * 86_400_000)],
      )).map((e: any) => `${e.windowKey}|${e.scopeKey}|${e.type}`),
    );
    const raise: Raise = async (input) => {
      const key = `${input.windowKey}|${input.scopeKey}|${input.type}`;
      if (existing.has(key)) return false;
      existing.add(key);
      const result = await this.exceptions.raise(manager, input);
      if (!result.created) return false;
      if (reconciled) {
        counters.reconciledExceptions += 1;
      } else {
        counters.exceptionsRaised += 1;
        if (result.alertId) counters.alertsRaised += 1;
      }
      counters.byType[input.type] = (counters.byType[input.type] ?? 0) + 1;
      return true;
    };
    return { sites, policyFor, raise };
  }

  /** 1. Replace Guard: the outgoing Guard's run in progress closes incomplete (guard_replaced). */
  private async closeReplacedGuardRuns(manager: EntityManager, companyId: number, now: Date, counters: PatrolSweepCounters) {
    const rows = await manager.query(
      `SELECT r."id", r."guardId", r."shiftId", s."guardId" AS "shiftGuardId" FROM "patrol_runs" r JOIN "shifts" s ON s."id" = r."shiftId"
        WHERE r."companyId" = $1 AND r."status" = 'in_progress' AND s."guardId" IS DISTINCT FROM r."guardId"`,
      [companyId],
    );
    for (const row of rows) {
      const result = await manager.query(
        `UPDATE "patrol_runs" SET "status" = 'incomplete', "exceptionReason" = 'guard_replaced', "completedAtServer" = $2, "updatedAt" = now()
          WHERE "id" = $1 AND "status" = 'in_progress' RETURNING "id"`,
        [row.id, now],
      );
      const updated = Array.isArray(result?.[0]) ? result[0] : result;
      if (!updated?.length) continue;
      counters.runsClosedGuardReplaced += 1;
      await this.auditLogService.logInTransaction(manager, {
        company: { id: companyId },
        user: null,
        action: 'patrol.run_closed_guard_replaced',
        entityType: 'patrol_run',
        entityId: Number(row.id),
        beforeData: { status: 'in_progress', guardId: Number(row.guardId) },
        afterData: { status: 'incomplete', exceptionReason: 'guard_replaced', shiftGuardId: row.shiftGuardId == null ? null : Number(row.shiftGuardId) },
      });
    }
  }

  /**
   * 2. Missed windows: each window starting at or after range.startFloor (and after its schedule's last change) whose
   * start deadline is in (deadlineFrom, deadlineTo] and has passed, for each scope on duty, with no run → patrol_missed.
   * Live: raised actionable (one alert each). Reconciliation: marked with the run, no alert of its own, and at most
   * `limit` judged windows (oldest deadlines first). Returns what was judged and the deadline judged through.
   */
  private async judgeWindows(
    manager: EntityManager,
    companyId: number,
    range: JudgeRange,
    sites: Map<number, SiteInfo>,
    policyFor: (siteId: number) => Promise<EffectivePolicy>,
    raise: Raise,
  ): Promise<{ windowsJudged: number; exceptionsRaised: number; judgedThrough: Date }> {
    const { now, startFloor, deadlineFrom, deadlineTo } = range;
    const result = { windowsJudged: 0, exceptionsRaised: 0, judgedThrough: deadlineTo };
    if (startFloor.getTime() >= deadlineTo.getTime()) return result;
    // Shifts that may have been on duty in the range. A cancelled shift is on duty for nothing (its windows are dropped).
    const shifts = await manager.query(
      `SELECT "id", "siteId", "guardId", "status", "start", "end" FROM "shifts"
        WHERE "companyId" = $1 AND "siteId" IS NOT NULL AND "status" IN ('in_progress', 'completed') AND "start" < $2 AND "end" > $3`,
      [companyId, deadlineTo, startFloor],
    );
    if (!shifts.length) return result;
    const shiftIds = shifts.map((s: any) => Number(s.id));
    const attendance = await manager.query(
      `SELECT "id", "shiftId", "type"::text AS "type", "occurredAt", "recordedAt", "correctionOfEventId", "source"
         FROM "attendance_events" WHERE "shiftId" = ANY($1::int[])`,
      [shiftIds],
    );
    const bySite = new Map<number, PatrolDutyShift[]>();
    for (const shift of shifts) {
      const rows = attendance.filter((a: any) => Number(a.shiftId) === Number(shift.id));
      const effective = effectiveAttendance(rows);
      const duty: PatrolDutyShift = {
        shiftId: Number(shift.id),
        guardId: shift.guardId == null ? null : Number(shift.guardId),
        applicability: { bookOnAt: effective.monitoredFrom, bookOffAt: effective.bookOffAt, shiftEnd: new Date(shift.end), cancelled: false },
      };
      const list = bySite.get(Number(shift.siteId)) ?? [];
      list.push(duty);
      bySite.set(Number(shift.siteId), list);
    }
    const schedules = await manager.query(
      `SELECT * FROM "patrol_schedules" WHERE "companyId" = $1 AND "siteId" = ANY($2::int[]) AND "active" AND "archivedAt" IS NULL ORDER BY "id"`,
      [companyId, [...bySite.keys()]],
    );
    if (!schedules.length) return result;
    const runRows = await manager.query(
      `SELECT "scheduleId", "windowKey", "scopeKey" FROM "patrol_runs"
        WHERE "companyId" = $1 AND "windowKey" IS NOT NULL AND "scheduleId" = ANY($2::int[]) AND "windowEnd" > $3`,
      [companyId, schedules.map((s: any) => Number(s.id)), new Date(startFloor.getTime() - 86_400_000)],
    );
    const runKeys = new Set(runRows.map((r: any) => `${r.scheduleId}|${r.windowKey}|${r.scopeKey}`));

    // Every window due in the range, in schedule then time order (the order alerts are raised in).
    const due: Array<{ schedule: any; site: SiteInfo; policy: EffectivePolicy; window: PatrolWindow; deadline: Date; onDuty: PatrolDutyShift[] }> = [];
    for (const schedule of schedules) {
      const siteId = Number(schedule.siteId);
      const site = sites.get(siteId);
      const duty = bySite.get(siteId) ?? [];
      if (!site || !duty.length) continue;
      const policy = await policyFor(siteId);
      // A window is judged only if it started after the schedule was last changed (and after the range's start floor).
      const floor = new Date(Math.max(startFloor.getTime(), new Date(schedule.updatedAt).getTime()));
      const cache = new Map<string, number>();
      for (const window of this.windows.windowsBetween(schedule, site.timezone, floor, deadlineTo, cache)) {
        if (window.start.getTime() < floor.getTime()) continue;
        const deadline = startDeadline(window.end, policy.startGraceMinutes);
        if (now.getTime() < deadline.getTime() || deadline.getTime() > deadlineTo.getTime()) continue;
        if (deadlineFrom && deadline.getTime() <= deadlineFrom.getTime()) continue;
        const onDuty = this.windows.onDutyShifts(window, duty).sort((a, b) => a.shiftId - b.shiftId);
        if (!onDuty.length) continue;
        due.push({ schedule, site, policy, window, deadline, onDuty });
      }
    }
    // Reconciliation bound: the oldest `limit` deadlines (and any window sharing the last one), judged through that deadline.
    let judged = due;
    if (range.limit !== undefined && due.length > range.limit) {
      const cutoff = due.map((d) => d.deadline.getTime()).sort((a, b) => a - b)[range.limit - 1];
      judged = due.filter((d) => d.deadline.getTime() <= cutoff);
      result.judgedThrough = new Date(cutoff);
    }

    const reconciled = range.reconciliationRunId !== undefined;
    for (const { schedule, site, policy, window, deadline, onDuty } of judged) {
      result.windowsJudged += 1;
      const scopes = policy.requirementScope === 'per_guard'
        ? onDuty.map((shift) => ({ scopeKey: `sh${shift.shiftId}`, shift }))
        : [{ scopeKey: 'site', shift: onDuty[0] }];
      for (const scope of scopes) {
        if (runKeys.has(`${schedule.id}|${window.windowKey}|${scope.scopeKey}`)) continue;
        const raised = await raise({
          companyId,
          siteId: Number(schedule.siteId),
          scheduleId: Number(schedule.id),
          shiftId: scope.shift.shiftId,
          runId: null,
          guardId: scope.shift.guardId,
          windowKey: window.windowKey,
          scopeKey: scope.scopeKey,
          type: 'patrol_missed',
          windowStart: window.start,
          windowEnd: window.end,
          // Reconciled: no alert per window; the site's reconciliation summary alert carries them.
          actionable: !reconciled,
          message: `Patrol missed: ${schedule.name} ${this.label(window, site.timezone)} at ${site.name}. No patrol was started by ${this.time(deadline, site.timezone)}.`,
          note: reconciled
            ? `found by outage reconciliation (run ${range.reconciliationRunId}): no run started by the start deadline (window end + ${policy.startGraceMinutes} min)`
            : `no run started by the start deadline (window end + ${policy.startGraceMinutes} min)`,
          now,
          ...(reconciled ? { reconciliationRunId: range.reconciliationRunId } : {}),
        });
        if (raised) result.exceptionsRaised += 1;
      }
    }
    return result;
  }

  // ═══════════════════════ Outage reconciliation (#67) ═══════════════════════

  /**
   * One reconciliation step in the caller's transaction (sweep lock held): start a run when the watermark is more than
   * the lookback behind, judge one bounded batch and advance the watermark with it, and complete the run once caught up.
   * 'batch' when a batch was judged and more may follow; 'completed' / 'none' otherwise.
   */
  private async reconcileStep(manager: EntityManager, companyId: number, now: Date, counters: PatrolSweepCounters): Promise<'none' | 'batch' | 'completed'> {
    const judgedThrough = await this.watermark(manager, companyId);
    if (!judgedThrough) return 'none';
    const enabledAt = await this.enabledAt(manager, companyId);
    const effective = enabledAt && enabledAt.getTime() > judgedThrough.getTime() ? enabledAt : judgedThrough;
    const liveFrom = new Date(now.getTime() - LOOKBACK_MS); // every deadline after this is the live pass's
    const horizon = new Date(now.getTime() - PATROL_RECONCILIATION_HORIZON_DAYS * 86_400_000);
    let [run] = await manager.query(`SELECT * FROM "patrol_reconciliation_runs" WHERE "companyId" = $1 AND "status" = 'running' FOR UPDATE`, [companyId]);

    if (effective.getTime() >= liveFrom.getTime()) {
      if (!run) return 'none';
      await this.completeReconciliation(manager, companyId, run, now, counters);
      return 'completed';
    }
    let from = effective;
    if (from.getTime() < horizon.getTime()) {
      // Older than the horizon: recorded as NOT judged (one audited alert per run), never silently dropped. A run that fell
      // behind the horizon itself (the sweep stopped again mid-catch-up) is completed first and a new one records the gap.
      if (run) {
        await this.completeReconciliation(manager, companyId, run, now, counters, false);
        run = undefined;
      }
      run = await this.startReconciliation(manager, companyId, now, effective, horizon, liveFrom, counters);
      from = horizon;
      await this.setWatermark(manager, companyId, from);
    } else if (!run) {
      run = await this.startReconciliation(manager, companyId, now, from, null, liveFrom, counters);
    }

    const runId = Number(run.id);
    const batchTo = new Date(Math.min(from.getTime() + PATROL_RECONCILIATION_BATCH_HOURS * HOUR_MS, liveFrom.getTime()));
    const ctx = await this.companyContext(manager, companyId, new Date(from.getTime() - LOOKBACK_MS), counters, true);
    const startFloor = new Date(Math.max(from.getTime() - LOOKBACK_MS, enabledAt ? enabledAt.getTime() : 0));
    const judged = await this.judgeWindows(manager, companyId, {
      now, startFloor, deadlineFrom: from, deadlineTo: batchTo, limit: PATROL_RECONCILIATION_BATCH_WINDOWS, reconciliationRunId: runId,
    }, ctx.sites, ctx.policyFor, ctx.raise);
    const through = judged.judgedThrough;
    await manager.query(
      `UPDATE "patrol_reconciliation_runs" SET "throughAt" = $2, "targetAt" = $3, "batches" = "batches" + 1, "windowsJudged" = "windowsJudged" + $4,
          "exceptionsRaised" = "exceptionsRaised" + $5, "updatedAt" = now() WHERE "id" = $1`,
      [runId, through, liveFrom, judged.windowsJudged, judged.exceptionsRaised],
    );
    await this.setWatermark(manager, companyId, through);
    counters.reconciliationBatches += 1;
    counters.reconciledWindows += judged.windowsJudged;
    await this.auditLogService.logInTransaction(manager, {
      company: { id: companyId },
      user: null,
      action: 'patrol.reconciliation_batch',
      entityType: 'patrol_reconciliation_run',
      entityId: runId,
      afterData: {
        deadlinesFrom: from.toISOString(), deadlinesThrough: through.toISOString(), windowsJudged: judged.windowsJudged,
        exceptionsRaised: judged.exceptionsRaised, boundedByWindowLimit: through.getTime() < batchTo.getTime(), detectedAt: now.toISOString(),
      },
    });
    if (through.getTime() >= liveFrom.getTime()) {
      const [current] = await manager.query(`SELECT * FROM "patrol_reconciliation_runs" WHERE "id" = $1`, [runId]);
      await this.completeReconciliation(manager, companyId, current, now, counters);
      return 'completed';
    }
    return 'batch';
  }

  private async startReconciliation(
    manager: EntityManager,
    companyId: number,
    now: Date,
    judgedThrough: Date,
    horizon: Date | null,
    liveFrom: Date,
    counters: PatrolSweepCounters,
  ) {
    const fromAt = horizon ?? judgedThrough;
    const [run] = await manager.query(
      `INSERT INTO "patrol_reconciliation_runs" ("companyId", "fromAt", "throughAt", "targetAt", "horizonDays", "unjudgedFrom", "unjudgedTo", "startedAt")
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [companyId, fromAt, liveFrom, PATROL_RECONCILIATION_HORIZON_DAYS, horizon ? judgedThrough : null, horizon, now],
    );
    counters.reconciliationsStarted += 1;
    const runId = Number(run.id);
    await this.auditLogService.logInTransaction(manager, {
      company: { id: companyId },
      user: null,
      action: 'patrol.reconciliation_started',
      entityType: 'patrol_reconciliation_run',
      entityId: runId,
      afterData: {
        judgedThrough: judgedThrough.toISOString(), fromAt: fromAt.toISOString(), targetAt: liveFrom.toISOString(),
        gapHours: Math.round((now.getTime() - judgedThrough.getTime()) / HOUR_MS), horizonDays: PATROL_RECONCILIATION_HORIZON_DAYS,
        batchHours: PATROL_RECONCILIATION_BATCH_HOURS, batchWindows: PATROL_RECONCILIATION_BATCH_WINDOWS,
        unjudgedFrom: horizon ? judgedThrough.toISOString() : null, unjudgedTo: horizon?.toISOString() ?? null, detectedAt: now.toISOString(),
      },
    });
    if (horizon) {
      const alertId = await this.raiseHorizonAlert(manager, companyId, runId, judgedThrough, horizon, counters);
      await this.auditLogService.logInTransaction(manager, {
        company: { id: companyId },
        user: null,
        action: 'patrol.reconciliation_horizon_exceeded',
        entityType: 'patrol_reconciliation_run',
        entityId: runId,
        afterData: {
          unjudgedFrom: judgedThrough.toISOString(), unjudgedTo: horizon.toISOString(), horizonDays: PATROL_RECONCILIATION_HORIZON_DAYS,
          safetyAlertId: alertId, judged: false, detectedAt: now.toISOString(),
        },
      });
    }
    return run;
  }

  /** Completes a run: one summary alert per site with reconciled missed windows, then the completion audit. Idempotent. */
  private async completeReconciliation(manager: EntityManager, companyId: number, run: any, now: Date, counters: PatrolSweepCounters, advanceWatermark = true) {
    const runId = Number(run.id);
    const bySite = await manager.query(
      `SELECT e."siteId", s."name", s."timezone", count(*)::int AS "windows", min(e."windowStart") AS "firstStart", max(e."windowEnd") AS "lastEnd"
         FROM "patrol_exceptions" e JOIN "sites" s ON s."id" = e."siteId"
        WHERE e."companyId" = $1 AND e."reconciliationRunId" = $2 AND e."type" = 'patrol_missed'
        GROUP BY e."siteId", s."name", s."timezone" ORDER BY e."siteId"`,
      [companyId, runId],
    );
    const summaries: Array<{ siteId: number; windows: number; safetyAlertId: number | null }> = [];
    for (const site of bySite) {
      const timeZone = site.timezone || 'Europe/London';
      const listed = await manager.query(
        `SELECT e."windowStart", e."windowEnd", e."scopeKey", sc."name" AS "scheduleName" FROM "patrol_exceptions" e
           LEFT JOIN "patrol_schedules" sc ON sc."id" = e."scheduleId"
          WHERE e."companyId" = $1 AND e."reconciliationRunId" = $2 AND e."siteId" = $3 AND e."type" = 'patrol_missed'
          ORDER BY e."windowStart", e."id" LIMIT $4`,
        [companyId, runId, site.siteId, SUMMARY_LISTED_WINDOWS],
      );
      const total = Number(site.windows);
      const items = listed.map((w: any) => `${this.dayTime(new Date(w.windowStart), timeZone)}–${this.time(new Date(w.windowEnd), timeZone)} ${w.scheduleName ?? 'patrol'}`);
      const message = `Patrol reconciliation after an outage: ${total} patrol window${total === 1 ? ' was' : 's were'} missed at ${site.name} between `
        + `${this.dayTime(new Date(site.firstStart), timeZone)} and ${this.dayTime(new Date(site.lastEnd), timeZone)}, found when patrol checks resumed. `
        + `${items.join('; ')}${total > items.length ? `; and ${total - items.length} more` : ''}. Review each in Patrols → Exceptions.`;
      const alertId = await this.insertReconciliationAlert(manager, companyId, runId, `reconciliation:site:${Number(site.siteId)}`, message, counters, {
        siteId: Number(site.siteId), windows: total,
      });
      summaries.push({ siteId: Number(site.siteId), windows: total, safetyAlertId: alertId });
    }
    const [completed] = await manager.query(
      `UPDATE "patrol_reconciliation_runs" SET "status" = 'completed', "completedAt" = $2, "updatedAt" = now()
        WHERE "id" = $1 AND "status" = 'running' RETURNING *`,
      [runId, now],
    ).then((r: any) => (Array.isArray(r?.[0]) ? r[0] : r));
    if (!completed) return;
    counters.reconciliationsCompleted += 1;
    // Caught up: the live pass of this same sweep judged every deadline after now − L (its floor was now − 2L while
    // reconciling), and the batches everything before, so the whole history to now is judged. (Not when the run is closed
    // because the gap outran the horizon: a new run takes over from there.)
    if (advanceWatermark) await this.setWatermark(manager, companyId, now);
    await this.auditLogService.logInTransaction(manager, {
      company: { id: companyId },
      user: null,
      action: 'patrol.reconciliation_completed',
      entityType: 'patrol_reconciliation_run',
      entityId: runId,
      afterData: {
        fromAt: new Date(completed.fromAt).toISOString(), throughAt: new Date(completed.throughAt).toISOString(), batches: Number(completed.batches),
        windowsJudged: Number(completed.windowsJudged), exceptionsRaised: Number(completed.exceptionsRaised),
        unjudgedFrom: completed.unjudgedFrom ? new Date(completed.unjudgedFrom).toISOString() : null,
        unjudgedTo: completed.unjudgedTo ? new Date(completed.unjudgedTo).toISOString() : null,
        summaryAlerts: summaries, completedAt: now.toISOString(),
      },
    });
  }

  /** The one alert for start deadlines beyond the horizon (raised when the company has any active patrol schedule). */
  private async raiseHorizonAlert(manager: EntityManager, companyId: number, runId: number, from: Date, to: Date, counters: PatrolSweepCounters) {
    const [schedules] = await manager.query(
      `SELECT count(*)::int AS n, min(s."timezone") AS "timezone" FROM "patrol_schedules" sc JOIN "sites" s ON s."id" = sc."siteId"
        WHERE sc."companyId" = $1 AND sc."active" AND sc."archivedAt" IS NULL`,
      [companyId],
    );
    if (!Number(schedules?.n)) return null;
    const timeZone = schedules.timezone || 'Europe/London';
    const message = `Patrol checks were NOT run for ${this.dayTime(from, timeZone)} to ${this.dayTime(to, timeZone)} (${timeZone}): S4's patrol checks were `
      + `unavailable for longer than the ${PATROL_RECONCILIATION_HORIZON_DAYS}-day reconciliation limit, so missed patrols in that period are not recorded. `
      + 'Review patrol coverage for that period manually.';
    return this.insertReconciliationAlert(manager, companyId, runId, 'reconciliation:horizon', message, counters, { unjudgedFrom: from.toISOString(), unjudgedTo: to.toISOString() });
  }

  /** One reconciliation alert per (run, key) — uq_safety_alerts_patrol_reconciliation makes a repeat a no-op. */
  private async insertReconciliationAlert(
    manager: EntityManager,
    companyId: number,
    runId: number,
    key: string,
    message: string,
    counters: PatrolSweepCounters,
    details: Record<string, unknown>,
  ): Promise<number | null> {
    const result = await manager
      .createQueryBuilder()
      .insert()
      .into(SafetyAlert)
      .values({
        company: { id: companyId },
        guard: null,
        shift: null,
        type: SafetyAlertType.PATROL_MISSED,
        priority: SafetyAlertPriority.HIGH,
        status: SafetyAlertStatus.OPEN,
        welfareWindowIndex: null,
        message,
        patrolWindowKey: key,
        patrolReconciliationRunId: runId,
      } as never)
      .orIgnore()
      .execute();
    const insertedId = Number(((result.identifiers ?? []).filter(Boolean)[0] as { id?: number } | undefined)?.id ?? NaN);
    if (!Number.isFinite(insertedId)) {
      const [existing] = await manager.query(`SELECT "id" FROM "safety_alerts" WHERE "patrolReconciliationRunId" = $1 AND "patrolWindowKey" = $2`, [runId, key]);
      return existing ? Number(existing.id) : null;
    }
    counters.reconciliationAlerts += 1;
    await this.auditLogService.logInTransaction(manager, {
      company: { id: companyId },
      user: null,
      action: 'patrol.reconciliation_alert_raised',
      entityType: 'safety_alert',
      entityId: insertedId,
      afterData: { type: SafetyAlertType.PATROL_MISSED, patrolReconciliationRunId: runId, patrolWindowKey: key, ...details },
    });
    return insertedId;
  }

  /** 3. Runs: abandoned, closed after the sync acceptance window, completion findings and verification. */
  private async judgeRuns(
    manager: EntityManager,
    companyId: number,
    now: Date,
    sites: Map<number, { name: string; timezone: string }>,
    policyFor: (siteId: number) => Promise<EffectivePolicy>,
    raise: Raise,
    counters: PatrolSweepCounters,
  ) {
    const runs = await manager.query(
      `SELECT r.*, s."status" AS "shiftStatus", s."end" AS "shiftEnd", sc."name" AS "scheduleName"
         FROM "patrol_runs" r JOIN "shifts" s ON s."id" = r."shiftId" LEFT JOIN "patrol_schedules" sc ON sc."id" = r."scheduleId"
        WHERE r."companyId" = $1
          AND (r."status" = 'in_progress' OR (r."verificationFinalAt" IS NULL AND r."startedAtDevice" > $2))
        ORDER BY r."id"`,
      [companyId, new Date(now.getTime() - RUN_REVIEW_DAYS * 86_400_000)],
    );
    if (!runs.length) return;
    const runIds = runs.map((r: any) => Number(r.id));
    const visits = await manager.query(
      `SELECT "id", "runId", "checkpointId", "result" FROM "patrol_checkpoint_visits" WHERE "runId" = ANY($1::int[])`,
      [runIds],
    );
    const evidence = await manager.query(
      `SELECT "runId", "visitId", "kind", "uploadStatus" FROM "patrol_evidence" WHERE "runId" = ANY($1::int[])`,
      [runIds],
    );
    const routeIds = [...new Set(runs.filter((r: any) => r.routeId != null).map((r: any) => Number(r.routeId)))];
    const routeCheckpoints = routeIds.length
      ? await manager.query(
        `SELECT rc."routeId", rc."checkpointId", rc."required", c."photoRequired" FROM "patrol_route_checkpoints" rc
           JOIN "patrol_checkpoints" c ON c."id" = rc."checkpointId"
          WHERE rc."routeId" = ANY($1::int[]) AND c."active" AND c."revokedAt" IS NULL`,
        [routeIds],
      )
      : [];
    const photoRequiredAtSite = await manager.query(
      `SELECT "id" FROM "patrol_checkpoints" WHERE "companyId" = $1 AND "photoRequired" AND "active" AND "revokedAt" IS NULL`,
      [companyId],
    );
    const attendanceByShift = new Map<number, any[]>();
    const openShiftIds = [...new Set(runs.filter((r: any) => r.status === 'in_progress' && r.shiftStatus !== 'in_progress').map((r: any) => Number(r.shiftId)))];
    if (openShiftIds.length) {
      for (const a of await manager.query(
        `SELECT "id", "shiftId", "type"::text AS "type", "occurredAt", "recordedAt", "correctionOfEventId", "source" FROM "attendance_events" WHERE "shiftId" = ANY($1::int[])`,
        [openShiftIds],
      )) {
        const list = attendanceByShift.get(Number(a.shiftId)) ?? [];
        list.push(a);
        attendanceByShift.set(Number(a.shiftId), list);
      }
    }

    for (const run of runs) {
      const siteId = Number(run.siteId);
      const site = sites.get(siteId) ?? { name: 'the site', timezone: 'Europe/London' };
      const policy = await policyFor(siteId);
      const runId = Number(run.id);
      const windowEnd = run.windowEnd ? new Date(run.windowEnd) : null;
      const compDl = completionDeadline(new Date(run.startedAtDevice), windowEnd, policy);
      const windowKey = run.windowKey ?? `r${runId}`;
      const scopeKey = run.scopeKey ?? 'site';
      const what = run.scheduleName ? `${run.scheduleName}${windowEnd && run.windowStart ? ` ${this.label({ start: new Date(run.windowStart), end: windowEnd } as PatrolWindow, site.timezone)}` : ''}` : 'Unscheduled patrol';
      const base = {
        companyId, siteId, scheduleId: run.scheduleId == null ? null : Number(run.scheduleId), shiftId: Number(run.shiftId), runId,
        guardId: Number(run.guardId), windowKey, scopeKey, windowStart: run.windowStart ? new Date(run.windowStart) : null, windowEnd, now,
      };

      if (run.status === 'in_progress') {
        if (runProgressState({ status: run.status, completionDeadline: compDl, now }) === 'abandoned') {
          await raise({
            ...base,
            type: 'patrol_abandoned',
            actionable: true,
            message: `Patrol not completed: ${what} at ${site.name} was started but not completed by ${this.time(compDl, site.timezone)}.`,
            note: `in progress at the completion deadline (${compDl.toISOString()})`,
          });
        }
        if (run.shiftStatus !== 'in_progress') {
          const effective = effectiveAttendance(attendanceByShift.get(Number(run.shiftId)) ?? []);
          const closesAt = syncAcceptanceEndsAt(effective.bookOffAt, new Date(run.shiftEnd), policy.postShiftSyncHours);
          if (now.getTime() > closesAt.getTime()) {
            const result = await manager.query(
              `UPDATE "patrol_runs" SET "status" = 'closed_by_system', "completedAtServer" = $2, "verificationStatus" = 'unverified',
                  "verificationFinalAt" = $2, "updatedAt" = now() WHERE "id" = $1 AND "status" = 'in_progress' RETURNING "id"`,
              [runId, now],
            );
            const updated = Array.isArray(result?.[0]) ? result[0] : result;
            if (updated?.length) {
              counters.runsClosedBySystem += 1;
              await this.auditLogService.logInTransaction(manager, {
                company: { id: companyId },
                user: null,
                action: 'patrol.run_closed_by_system',
                entityType: 'patrol_run',
                entityId: runId,
                beforeData: { status: 'in_progress' },
                afterData: { status: 'closed_by_system', reason: 'post_shift_sync_window_closed', syncAcceptanceEndedAt: closesAt.toISOString() },
              });
            }
          }
        }
        continue;
      }
      if (run.status === 'closed_by_system' || run.verificationFinalAt) continue;

      const routeRows = run.routeId == null ? [] : routeCheckpoints.filter((rc: any) => Number(rc.routeId) === Number(run.routeId));
      const runVisits = visits.filter((v: any) => Number(v.runId) === runId);
      const requirements = evaluateRequirements({
        requiredCheckpointIds: routeRows.filter((rc: any) => rc.required).map((rc: any) => Number(rc.checkpointId)),
        photoRequiredCheckpointIds: [
          ...routeRows.filter((rc: any) => rc.photoRequired).map((rc: any) => Number(rc.checkpointId)),
          ...photoRequiredAtSite.map((c: any) => Number(c.id)).filter((id: number) => runVisits.some((v: any) => Number(v.checkpointId) === id)),
        ],
        photosPerRun: policy.photosPerRun,
        photosPerCheckpoint: policy.photosPerCheckpoint,
        visits: runVisits.map((v: any) => ({ visitId: Number(v.id), checkpointId: v.checkpointId == null ? null : Number(v.checkpointId), result: v.result })),
        evidence: evidence.filter((e: any) => Number(e.runId) === runId).map((e: any) => ({
          kind: e.kind, visitId: e.visitId == null ? null : Number(e.visitId), uploadStatus: e.uploadStatus,
        })),
      });
      const pastCompletionDeadline = now.getTime() >= compDl.getTime();
      for (const finding of completionFindings({
        status: run.status,
        exceptionReason: run.exceptionReason ?? null,
        incompleteNeedsAction: policy.incompleteNeedsAction,
        requirements,
      })) {
        // Checkpoints and a stated reason are known at completion; photos may still be in the outbox until the deadline.
        if (finding.type === 'patrol_incomplete' && run.status === 'completed' && !pastCompletionDeadline) continue;
        await raise({
          ...base,
          type: finding.type,
          actionable: finding.actionable,
          message: finding.type === 'checkpoint_missed'
            ? `Checkpoints missed: ${what} at ${site.name} was completed without every required checkpoint.`
            : `Patrol incomplete: ${what} at ${site.name} (${finding.reason}).`,
          note: finding.reason.slice(0, 1000),
        });
      }

      const syncDl = syncDeadline(compDl, policy.syncGraceMinutes);
      const state = verificationState({ requirements, now, syncDeadline: syncDl });
      if (state !== 'pending' && state !== run.verificationStatus) {
        await manager.query(
          `UPDATE "patrol_runs" SET "verificationStatus" = $2::varchar, "verifiedAt" = CASE WHEN $2::varchar = 'verified' THEN $3::timestamptz ELSE "verifiedAt" END, "updatedAt" = now()
            WHERE "id" = $1`,
          [runId, state, now],
        );
        if (state === 'verified') counters.runsVerified += 1;
      }
      if (state === 'unverified' && requirements.photosNotOnServer > 0) {
        await raise({
          ...base,
          type: 'evidence_unverified',
          actionable: policy.escalateUnverified,
          message: `Patrol evidence missing: ${what} at ${site.name} — ${requirements.photosNotOnServer} required photo(s) had not reached S4 by ${this.time(syncDl, site.timezone)}.`,
          note: `${requirements.photosNotOnServer} required photo(s) not on the server at the sync deadline`,
        });
      }
      if (now.getTime() >= verificationFinalAt(syncDl).getTime()) {
        await manager.query(`UPDATE "patrol_runs" SET "verificationFinalAt" = $2, "updatedAt" = now() WHERE "id" = $1 AND "verificationFinalAt" IS NULL`, [runId, now]);
      }
    }
  }

  private label(window: Pick<PatrolWindow, 'start' | 'end'>, timeZone: string) {
    return `${this.time(window.start, timeZone)}–${this.time(window.end, timeZone)}`;
  }

  private time(value: Date, timeZone: string) {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(value);
    } catch {
      return value.toISOString().slice(11, 16);
    }
  }

  /** "Mon 12 Oct 12:00", site-local (reconciliation alerts span days). */
  private dayTime(value: Date, timeZone: string) {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .format(value).replace(',', '');
    } catch {
      return `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    }
  }
}
