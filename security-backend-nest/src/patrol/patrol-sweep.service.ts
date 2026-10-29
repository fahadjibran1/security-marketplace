import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { effectiveAttendance } from '../attendance/effective-attendance';
import { PATROL_SWEEP_LOCK_NAMESPACE } from '../operations/advisory-locks';
import { SingleFlightJob, SingleFlightOutcome } from '../scheduler/single-flight-job';
import { EffectivePolicy, PatrolConfigService } from './patrol-config.service';
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
 * How far back windows are judged. The sweep runs every five minutes, so a window is normally judged within minutes of
 * its start deadline; the lookback only matters after an outage or restart, and is bounded (as Welfare's recovery is) to
 * a day plus the longest grace. A longer outage is a documented limit, not an unbounded historical scan.
 */
export const PATROL_SWEEP_LOOKBACK_HOURS = 26;
/** Finished runs are re-evaluated (verification, late evidence) until their verification settles, at most this long. */
const RUN_REVIEW_DAYS = 4;

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

  async sweep(now: Date = new Date()): Promise<PatrolSweepCounters> {
    const counters: PatrolSweepCounters = {
      companies: 0, companiesSkippedLocked: 0, windowsJudged: 0, exceptionsRaised: 0, alertsRaised: 0, byType: {},
      runsClosedGuardReplaced: 0, runsClosedBySystem: 0, runsVerified: 0,
    };
    const companies = await this.dataSource.query(`SELECT "id" FROM "companies" WHERE "patrolsEnabled" = true ORDER BY "id"`);
    for (const { id } of companies) {
      const companyId = Number(id);
      await this.dataSource.transaction(async (manager) => {
        const [{ locked }] = await manager.query('SELECT pg_try_advisory_xact_lock($1, $2) AS locked', [PATROL_SWEEP_LOCK_NAMESPACE, companyId]);
        if (!locked) {
          counters.companiesSkippedLocked += 1;
          return;
        }
        const [company] = await manager.query(`SELECT "patrolsEnabled" FROM "companies" WHERE "id" = $1`, [companyId]);
        if (company?.patrolsEnabled !== true) return; // switched off since the list was read
        counters.companies += 1;
        await this.sweepCompany(manager, companyId, now, counters);
      });
    }
    return counters;
  }

  private async sweepCompany(manager: EntityManager, companyId: number, now: Date, counters: PatrolSweepCounters) {
    const [{ enabledAt }] = await manager.query(
      `SELECT max("createdAt") AS "enabledAt" FROM "audit_logs"
        WHERE "companyId" = $1 AND "action" = 'company.patrols_enabled_changed' AND ("afterData"->>'patrolsEnabled') = 'true'`,
      [companyId],
    );
    const lookbackStart = now.getTime() - PATROL_SWEEP_LOOKBACK_HOURS * 3_600_000;
    const horizonStart = new Date(Math.max(lookbackStart, enabledAt ? new Date(enabledAt).getTime() : lookbackStart));

    await this.closeReplacedGuardRuns(manager, companyId, now, counters);

    const sites = new Map<number, { name: string; timezone: string }>();
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
        [companyId, new Date(horizonStart.getTime() - RUN_REVIEW_DAYS * 86_400_000)],
      )).map((e: any) => `${e.windowKey}|${e.scopeKey}|${e.type}`),
    );
    const raise = async (input: Parameters<PatrolExceptionService['raise']>[1]) => {
      const key = `${input.windowKey}|${input.scopeKey}|${input.type}`;
      if (existing.has(key)) return;
      existing.add(key);
      const result = await this.exceptions.raise(manager, input);
      if (!result.created) return;
      counters.exceptionsRaised += 1;
      counters.byType[input.type] = (counters.byType[input.type] ?? 0) + 1;
      if (result.alertId) counters.alertsRaised += 1;
    };

    await this.judgeWindows(manager, companyId, now, horizonStart, sites, policyFor, raise, counters);
    await this.judgeRuns(manager, companyId, now, sites, policyFor, raise, counters);
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

  /** 2. Missed windows. */
  private async judgeWindows(
    manager: EntityManager,
    companyId: number,
    now: Date,
    horizonStart: Date,
    sites: Map<number, { name: string; timezone: string }>,
    policyFor: (siteId: number) => Promise<EffectivePolicy>,
    raise: (input: Parameters<PatrolExceptionService['raise']>[1]) => Promise<void>,
    counters: PatrolSweepCounters,
  ) {
    if (horizonStart.getTime() >= now.getTime()) return;
    // Shifts that may have been on duty in the horizon. A cancelled shift is on duty for nothing (its windows are dropped).
    const shifts = await manager.query(
      `SELECT "id", "siteId", "guardId", "status", "start", "end" FROM "shifts"
        WHERE "companyId" = $1 AND "siteId" IS NOT NULL AND "status" IN ('in_progress', 'completed') AND "start" < $2 AND "end" > $3`,
      [companyId, now, horizonStart],
    );
    if (!shifts.length) return;
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
    if (!schedules.length) return;
    const runRows = await manager.query(
      `SELECT "scheduleId", "windowKey", "scopeKey" FROM "patrol_runs"
        WHERE "companyId" = $1 AND "windowKey" IS NOT NULL AND "scheduleId" = ANY($2::int[]) AND "windowEnd" > $3`,
      [companyId, schedules.map((s: any) => Number(s.id)), new Date(horizonStart.getTime() - 86_400_000)],
    );
    const runKeys = new Set(runRows.map((r: any) => `${r.scheduleId}|${r.windowKey}|${r.scopeKey}`));

    for (const schedule of schedules) {
      const siteId = Number(schedule.siteId);
      const site = sites.get(siteId);
      const duty = bySite.get(siteId) ?? [];
      if (!site || !duty.length) continue;
      const policy = await policyFor(siteId);
      // A window is judged only if it started after the schedule was last changed (and after the horizon start).
      const floor = new Date(Math.max(horizonStart.getTime(), new Date(schedule.updatedAt).getTime()));
      const cache = new Map<string, number>();
      for (const window of this.windows.windowsBetween(schedule, site.timezone, floor, now, cache)) {
        if (window.start.getTime() < floor.getTime()) continue;
        if (now.getTime() < startDeadline(window.end, policy.startGraceMinutes).getTime()) continue;
        const onDuty = this.windows.onDutyShifts(window, duty).sort((a, b) => a.shiftId - b.shiftId);
        if (!onDuty.length) continue;
        counters.windowsJudged += 1;
        const scopes = policy.requirementScope === 'per_guard'
          ? onDuty.map((shift) => ({ scopeKey: `sh${shift.shiftId}`, shift }))
          : [{ scopeKey: 'site', shift: onDuty[0] }];
        for (const scope of scopes) {
          if (runKeys.has(`${schedule.id}|${window.windowKey}|${scope.scopeKey}`)) continue;
          await raise({
            companyId,
            siteId,
            scheduleId: Number(schedule.id),
            shiftId: scope.shift.shiftId,
            runId: null,
            guardId: scope.shift.guardId,
            windowKey: window.windowKey,
            scopeKey: scope.scopeKey,
            type: 'patrol_missed',
            windowStart: window.start,
            windowEnd: window.end,
            actionable: true,
            message: `Patrol missed: ${schedule.name} ${this.label(window, site.timezone)} at ${site.name}. No patrol was started by ${this.time(startDeadline(window.end, policy.startGraceMinutes), site.timezone)}.`,
            note: `no run started by the start deadline (window end + ${policy.startGraceMinutes} min)`,
            now,
          });
        }
      }
    }
  }

  /** 3. Runs: abandoned, closed after the sync acceptance window, completion findings and verification. */
  private async judgeRuns(
    manager: EntityManager,
    companyId: number,
    now: Date,
    sites: Map<number, { name: string; timezone: string }>,
    policyFor: (siteId: number) => Promise<EffectivePolicy>,
    raise: (input: Parameters<PatrolExceptionService['raise']>[1]) => Promise<void>,
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
}
