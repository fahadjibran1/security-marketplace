import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { effectiveAttendance } from '../attendance/effective-attendance';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CompletePatrolRunDto, RecordPatrolVisitDto, StartPatrolRunDto } from './dto/patrol.dto';
import { PatrolAccessService, PatrolGuardActor } from './patrol-access.service';
import { PatrolConfigService } from './patrol-config.service';
import {
  PATROL_REVIEW_FLAGS,
  PATROL_UNVERIFIED_ONLY_FLAGS,
  PatrolErrorCode,
  PatrolScanFlag,
  PatrolSyncFlag,
  PatrolVisitResult,
  patrolError,
} from './patrol-constants';
import { PatrolExceptionService } from './patrol-exception.service';
import {
  adjustForDrift,
  clockDriftMs,
  evaluatePostShiftStart,
  isClockDriftSuspect,
  syncAcceptanceEndsAt,
  withinSyncAcceptance,
} from './patrol-late-sync';
import { checkLabelSignature, parseCheckpointLabel, patrolQrKeyring } from './patrol-qr';
import { serializeRun, serializeVisit, updateRows } from './patrol-serializers';
import { PatrolWindow, windowForStart, windowsBetween } from './patrol-window.service';

const INT32_MAX = 2_147_483_647;
/** The most windows GET /patrols/mine/plan lists (a 24 h shift with a 15-minute schedule has 96). */
const PATROL_PLAN_MAX_WINDOWS = 200;

/**
 * The Guard's side of Patrols (the S4 Guard app; the distributed 1.1.2 app never calls any of this).
 *
 * The Guard acts only on their OWN shift. Starting a run, recording a scan and completing a run need the shift to be
 * in progress; replaying an already-accepted write (same client id, same content) always returns the stored row, even
 * after the shift ends, so an offline outbox can retry safely. Every write is idempotent on a client-generated id that
 * is unique per company: concurrent duplicates resolve to one row (INSERT … ON CONFLICT DO NOTHING, then read), and the
 * same id with different content is 409 PATROL_IDEMPOTENCY_CONFLICT. No location is ever accepted.
 *
 * P1-B (offline sync after Book Off, see patrol-late-sync.ts): once the shift has ended (Book Off), a run in progress may
 * still receive its scans and completion, and a run created offline may first arrive, within the post-shift sync
 * acceptance window (policy postShiftSyncHours, default 24 h after Book Off). Such writes are marked syncedLate; a
 * post-shift-created run is provisional and flagged, needsReview when its legitimacy is only partly supported. The
 * optional sentAtDevice measures device clock drift. A run is assigned at start to the ONE window it is for (the
 * schedule's window containing its drift-adjusted device start, or the window it started late for, within the start
 * grace); evidence arriving after a missed / abandoned alert annotates that exception and downgrades its alert, never
 * closing either (PatrolExceptionService.recordLateEvidence).
 */
@Injectable()
export class PatrolGuardService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: PatrolAccessService,
    private readonly config: PatrolConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly exceptions: PatrolExceptionService,
  ) {}

  /** The Guard's own effective Book On / Book Off on a shift (Migration 67 rules), from their attendance rows. */
  private async guardAttendance(shiftId: number, guardId: number): Promise<{ bookOnAt: Date | null; bookOffAt: Date | null }> {
    const rows = await this.dataSource.query(
      `SELECT "id", "type"::text AS "type", "occurredAt", "recordedAt", "correctionOfEventId", "source" FROM "attendance_events"
        WHERE "shiftId" = $1 AND "guardId" = $2`,
      [shiftId, guardId],
    );
    const effective = effectiveAttendance(rows);
    return { bookOnAt: effective.bookOnAt, bookOffAt: effective.bookOffAt };
  }

  /**
   * A new write to a run whose shift has ended: allowed only inside the post-shift sync acceptance window (else 409
   * PATROL_SYNC_WINDOW_CLOSED). A shift that did not end normally (cancelled, never started) keeps P1-A's refusal.
   */
  private async assertPostShiftWrite(run: any, now: Date) {
    if (run.shiftStatus !== 'completed') {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.SHIFT_NOT_IN_PROGRESS, 'Patrols can only be recorded during your shift, after Book On.', {
        shiftStatus: run.shiftStatus,
      });
    }
    const policy = await this.config.effectivePolicy(Number(run.companyId), Number(run.siteId));
    const attendance = await this.guardAttendance(Number(run.shiftId), Number(run.guardId));
    const shiftEnd = new Date(run.shiftEnd);
    if (!withinSyncAcceptance(now, attendance.bookOffAt, shiftEnd, policy.postShiftSyncHours)) {
      const endsAt = syncAcceptanceEndsAt(attendance.bookOffAt, shiftEnd, policy.postShiftSyncHours);
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.SYNC_WINDOW_CLOSED,
        `Patrol data for this shift could only be sent until ${endsAt.toISOString()} (${policy.postShiftSyncHours} h after it ended).`,
        { acceptanceEndsAt: endsAt.toISOString() });
    }
    return { policy, attendance, shiftEnd };
  }

  /** Everything the app needs to patrol this shift's site offline: policy, schedules, routes, checkpoint publicIds. */
  async plan(user: JwtPayload, shiftId: number) {
    const actor = await this.access.guardActor(user);
    const shift = await this.access.guardShift(actor, shiftId);
    if (shift.siteId == null) {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.SHIFT_HAS_NO_SITE, 'This shift has no site, so it has no patrols.');
    }
    const [site] = await this.dataSource.query(`SELECT "id", "name", "timezone" FROM "sites" WHERE "id" = $1`, [shift.siteId]);
    const policy = await this.config.effectivePolicy(shift.companyId, shift.siteId);
    const schedules = await this.dataSource.query(
      `SELECT "id", "routeId", "name", "daysOfWeek", "activeFrom", "activeTo", "frequencyMinutes", "windowMinutes",
              "startsOn"::text AS "startsOn", "endsOn"::text AS "endsOn"
         FROM "patrol_schedules" WHERE "companyId" = $1 AND "siteId" = $2 AND "active" AND "archivedAt" IS NULL ORDER BY "name", "id"`,
      [shift.companyId, shift.siteId],
    );
    const checkpoints = await this.dataSource.query(
      `SELECT "publicId", "label", "description", "photoRequired" FROM "patrol_checkpoints"
        WHERE "companyId" = $1 AND "siteId" = $2 AND "active" AND "revokedAt" IS NULL ORDER BY "label", "id"`,
      [shift.companyId, shift.siteId],
    );
    const routes = await this.dataSource.query(
      `SELECT "id", "name", "orderMode" FROM "patrol_routes"
        WHERE "companyId" = $1 AND "siteId" = $2 AND "active" AND "archivedAt" IS NULL ORDER BY "name", "id"`,
      [shift.companyId, shift.siteId],
    );
    const routeOut = [];
    for (const route of routes) {
      const items = await this.dataSource.query(
        `SELECT rc."position", rc."required", c."publicId", c."label" FROM "patrol_route_checkpoints" rc
           JOIN "patrol_checkpoints" c ON c."id" = rc."checkpointId"
          WHERE rc."routeId" = $1 AND c."active" AND c."revokedAt" IS NULL ORDER BY rc."position"`,
        [route.id],
      );
      routeOut.push({
        id: Number(route.id),
        name: route.name,
        orderMode: route.orderMode,
        checkpoints: items.map((i: any) => ({ position: Number(i.position), required: Boolean(i.required), publicId: i.publicId, label: i.label })),
      });
    }
    const { qrRequireProximity: _q, proximityMeters: _p, ...policyOut } = policy;
    const windows = await this.shiftWindows(shift, site?.timezone || 'Europe/London', schedules, policy.requirementScope);
    return {
      shift: { id: shift.id, status: shift.status, start: new Date(shift.start).toISOString(), end: new Date(shift.end).toISOString() },
      site: { id: Number(site.id), name: site.name, timezone: site.timezone },
      policy: policyOut,
      locationVerification: false,
      schedules: schedules.map((s: any) => ({
        id: Number(s.id),
        routeId: s.routeId == null ? null : Number(s.routeId),
        name: s.name,
        daysOfWeek: s.daysOfWeek,
        activeFrom: s.activeFrom,
        activeTo: s.activeTo,
        timeBasis: 'site_local',
        frequencyMinutes: Number(s.frequencyMinutes),
        windowMinutes: Number(s.windowMinutes),
        startsOn: s.startsOn ?? null,
        endsOn: s.endsOn ?? null,
      })),
      routes: routeOut,
      checkpoints: checkpoints.map((c: any) => ({ publicId: c.publicId, label: c.label, description: c.description ?? null, photoRequired: Boolean(c.photoRequired) })),
      windows,
    };
  }

  /**
   * Patrols P1-E: the scheduled windows of this shift (every active schedule's window overlapping the shift's start → end),
   * computed by the same site-local engine the sweep judges with, so the Guard app never derives a due time itself.
   * `covered` says a run is already recorded for that window and the policy's scope (site-wide, or this shift when
   * per-Guard) — it names no Guard. At most PATROL_PLAN_MAX_WINDOWS, earliest first.
   */
  private async shiftWindows(shift: { id: number; companyId: number; siteId: number | null; start: Date; end: Date }, timeZone: string, schedules: any[], scope: string) {
    if (!schedules.length || shift.siteId == null) return [];
    const from = new Date(shift.start);
    const to = new Date(shift.end);
    const cache = new Map<string, number>();
    const all = schedules
      .flatMap((s: any) => windowsBetween(
        { id: Number(s.id), daysOfWeek: s.daysOfWeek, activeFrom: s.activeFrom, activeTo: s.activeTo, frequencyMinutes: Number(s.frequencyMinutes),
          windowMinutes: Number(s.windowMinutes), startsOn: s.startsOn ?? null, endsOn: s.endsOn ?? null },
        timeZone, from, to, cache,
      ).map((w) => ({ w, schedule: s })))
      .sort((a, b) => a.w.start.getTime() - b.w.start.getTime() || a.w.windowKey.localeCompare(b.w.windowKey))
      .slice(0, PATROL_PLAN_MAX_WINDOWS);
    if (!all.length) return [];
    const scopeKey = scope === 'per_guard' ? `sh${shift.id}` : 'site';
    const covered = await this.dataSource.query(
      `SELECT DISTINCT "windowKey" FROM "patrol_runs" WHERE "companyId" = $1 AND "siteId" = $2 AND "scopeKey" = $3 AND "windowKey" = ANY($4::text[])`,
      [shift.companyId, shift.siteId, scopeKey, all.map((x) => x.w.windowKey)],
    );
    const coveredKeys = new Set(covered.map((r: any) => r.windowKey));
    return all.map(({ w, schedule }) => ({
      windowKey: w.windowKey,
      scheduleId: w.scheduleId,
      scheduleName: schedule.name,
      routeId: schedule.routeId == null ? null : Number(schedule.routeId),
      localDate: w.localDate,
      start: w.start.toISOString(),
      end: w.end.toISOString(),
      covered: coveredKeys.has(w.windowKey),
    }));
  }

  async myRuns(user: JwtPayload, shiftId: number) {
    const actor = await this.access.guardActor(user);
    const shift = await this.access.guardShift(actor, shiftId);
    const runs = await this.dataSource.query(
      `SELECT * FROM "patrol_runs" WHERE "shiftId" = $1 AND "guardId" = $2 AND "companyId" = $3 ORDER BY "startedAtServer", "id"`,
      [shift.id, actor.guardId, shift.companyId],
    );
    const visits = runs.length
      ? await this.dataSource.query(
          `SELECT v.*, c."label" AS "checkpointLabel" FROM "patrol_checkpoint_visits" v
             LEFT JOIN "patrol_checkpoints" c ON c."id" = v."checkpointId"
            WHERE v."runId" = ANY($1::int[]) ORDER BY v."scannedAtDevice", v."id"`,
          [runs.map((r: any) => r.id)],
        )
      : [];
    return runs.map((r: any) => ({
      ...serializeRun(r),
      visits: visits.filter((v: any) => Number(v.runId) === Number(r.id)).map(serializeVisit),
    }));
  }

  // ── Start ──────────────────────────────────────────────────────────────────────────────────────────

  async startRun(user: JwtPayload, dto: StartPatrolRunDto, now: Date = new Date()) {
    const actor = await this.access.guardActor(user);
    const shift = await this.access.guardShift(actor, dto.shiftId);
    this.access.rejectLocation(dto);
    const startedAtDevice = new Date(dto.startedAtDevice);

    const replay = await this.findRunByClientId(shift.companyId, dto.clientRunId);
    if (replay) return this.replayRun(replay, actor, dto, startedAtDevice);

    // P1-B: a run may first reach the server after Book Off (offline). Only for a shift that ended normally, from a Guard
    // who booked on to it; every other state keeps P1-A's refusal.
    const postShift = shift.status !== 'in_progress';
    let attendance: { bookOnAt: Date | null; bookOffAt: Date | null } | null = null;
    if (postShift) {
      if (shift.status !== 'completed') this.access.assertShiftInProgress(shift);
      attendance = await this.guardAttendance(shift.id, actor.guardId);
      if (!attendance.bookOnAt) {
        throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.SYNC_NOT_BOOKED_ON, 'This patrol cannot be accepted: you did not Book On to this shift.');
      }
    }
    if (shift.siteId == null) {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.SHIFT_HAS_NO_SITE, 'This shift has no site, so it has no patrols.');
    }
    let routeId = dto.routeId ?? null;
    let schedule: any = null;
    if (dto.scheduleId != null) {
      [schedule] = await this.dataSource.query(
        `SELECT "id", "siteId", "routeId", "active", "archivedAt", "daysOfWeek", "activeFrom", "activeTo", "frequencyMinutes", "windowMinutes",
                "startsOn"::text AS "startsOn", "endsOn"::text AS "endsOn"
           FROM "patrol_schedules" WHERE "id" = $1 AND "companyId" = $2`,
        [dto.scheduleId, shift.companyId],
      );
      if (!schedule || Number(schedule.siteId) !== shift.siteId || !schedule.active || schedule.archivedAt) {
        throw patrolError(HttpStatus.UNPROCESSABLE_ENTITY, PatrolErrorCode.SCHEDULE_NOT_FOR_SITE, 'That patrol schedule is not active for this shift\'s site.');
      }
      if (routeId == null && schedule.routeId != null) routeId = Number(schedule.routeId);
    }
    if (routeId != null) {
      const [route] = await this.dataSource.query(
        `SELECT "id", "siteId", "active", "archivedAt" FROM "patrol_routes" WHERE "id" = $1 AND "companyId" = $2`,
        [routeId, shift.companyId],
      );
      if (!route || Number(route.siteId) !== shift.siteId || !route.active || route.archivedAt) {
        throw patrolError(HttpStatus.UNPROCESSABLE_ENTITY, PatrolErrorCode.ROUTE_NOT_FOR_SITE, 'That patrol route is not active for this shift\'s site.');
      }
    }
    const offset = now.getTime() - startedAtDevice.getTime();
    const clockOffsetMs = Math.abs(offset) > INT32_MAX ? null : offset;

    // P1-B: drift, the window this run is for, and (after Book Off) whether it is legitimate.
    const policy = await this.config.effectivePolicy(shift.companyId, shift.siteId);
    const driftMs = clockDriftMs(now, dto.sentAtDevice ? new Date(dto.sentAtDevice) : null);
    const adjustedStart = adjustForDrift(startedAtDevice, driftMs);
    let assigned: { window: PatrolWindow; lateStart: boolean } | null = null;
    if (schedule) {
      const [site] = await this.dataSource.query(`SELECT "timezone" FROM "sites" WHERE "id" = $1`, [shift.siteId]);
      assigned = windowForStart(schedule, site?.timezone || 'Europe/London', adjustedStart, policy.startGraceMinutes);
    }
    const flags: PatrolSyncFlag[] = [];
    if (postShift && attendance) {
      const decision = evaluatePostShiftStart({
        now,
        bookOnAt: attendance.bookOnAt,
        bookOffAt: attendance.bookOffAt,
        shiftEnd: new Date(shift.end),
        postShiftSyncHours: policy.postShiftSyncHours,
        clockDriftThresholdMinutes: policy.clockDriftThresholdMinutes,
        startedAtDevice,
        driftMs,
        scheduled: schedule != null,
        matchingWindow: assigned != null,
        allowUnscheduledPatrols: policy.allowUnscheduledPatrols,
      });
      if (!decision.accept) {
        throw patrolError(HttpStatus.CONFLICT, decision.code, decision.message,
          decision.acceptanceEndsAt ? { acceptanceEndsAt: decision.acceptanceEndsAt.toISOString() } : undefined);
      }
      flags.push(...decision.flags);
    } else if (isClockDriftSuspect(driftMs, policy.clockDriftThresholdMinutes)) {
      flags.push('clock_drift_suspect');
    }
    const scopeKey = policy.requirementScope === 'per_guard' ? `sh${shift.id}` : 'site';

    const insertRun = async (withWindow: boolean) => {
      const window = withWindow ? assigned : null;
      const runFlags = withWindow || !assigned ? flags : [...flags, 'window_already_covered' as PatrolSyncFlag];
      const [row] = await this.dataSource.query(
        `INSERT INTO "patrol_runs" ("companyId", "siteId", "shiftId", "guardId", "startedByUserId", "scheduleId", "routeId",
            "startedAtDevice", "startedAtServer", "clockOffsetMs", "clientRunId", "windowKey", "windowStart", "windowEnd", "scopeKey",
            "lateStart", "provisional", "syncedLate", "needsReview", "syncFlags", "clockDriftMs")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17, $18, $19::jsonb, $20)
         ON CONFLICT ("companyId", "clientRunId") DO NOTHING RETURNING *`,
        [shift.companyId, shift.siteId, shift.id, actor.guardId, actor.userId, dto.scheduleId ?? null, routeId, startedAtDevice, now,
          clockOffsetMs, dto.clientRunId, window?.window.windowKey ?? null, window?.window.start ?? null, window?.window.end ?? null, scopeKey,
          window?.lateStart ?? false, postShift, runFlags.some((f) => PATROL_REVIEW_FLAGS.includes(f)), JSON.stringify(runFlags), driftMs],
      );
      return row;
    };

    let inserted: any;
    try {
      try {
        inserted = await insertRun(true);
      } catch (error) {
        // The window already has a run for this scope (another Guard covered the site, or a duplicate): this run is still
        // recorded, satisfying no window.
        if (!isUniqueViolation(error, 'UQ_patrol_runs_schedule_window_scope')) throw error;
        inserted = await insertRun(false);
      }
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_patrol_runs_one_open_per_guard_shift')) {
        // A concurrent duplicate of THIS request can trip the one-open index before the clientRunId arbiter sees it.
        const sameClientId = await this.findRunByClientId(shift.companyId, dto.clientRunId);
        if (sameClientId) return this.replayRun(sameClientId, actor, dto, startedAtDevice);
        const [open] = await this.dataSource.query(
          `SELECT "id", "clientRunId" FROM "patrol_runs" WHERE "shiftId" = $1 AND "guardId" = $2 AND "status" = 'in_progress'`,
          [shift.id, actor.guardId],
        );
        throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.RUN_ALREADY_IN_PROGRESS, 'Finish your patrol in progress before starting another.', {
          runId: open ? Number(open.id) : null,
          clientRunId: open?.clientRunId ?? null,
        });
      }
      throw error;
    }
    if (inserted) return serializeRun(await this.afterRunCreated(inserted, actor, flags, now));
    // A concurrent request with the same clientRunId won the insert: answer with that row, or 409 if it differs.
    const winner = await this.findRunByClientId(shift.companyId, dto.clientRunId);
    return this.replayRun(winner, actor, dto, startedAtDevice);
  }

  /** Audit a flagged acceptance; annotate a missed exception of the window this late-arriving run is for. */
  private async afterRunCreated(row: any, actor: PatrolGuardActor, flags: PatrolSyncFlag[], now: Date) {
    const companyId = Number(row.companyId);
    let current = row;
    if (row.windowKey) {
      const annotated = await this.exceptions.recordLateEvidence(this.dataSource, {
        companyId,
        runId: Number(row.id),
        kind: 'run_started_after_alert',
        match: { windowKey: row.windowKey, scopeKey: row.scopeKey, types: ['patrol_missed'] },
        deviceTime: new Date(row.startedAtDevice),
        now,
        userId: actor.userId,
      });
      if (annotated > 0) current = await this.markLate(Number(row.id), ['evidence_after_alert'], false);
    }
    const allFlags: PatrolSyncFlag[] = current.syncFlags ?? flags;
    if (allFlags.length) {
      await this.auditLogService.log({
        company: { id: companyId },
        user: { id: actor.userId },
        action: 'patrol.late_sync_flagged',
        entityType: 'patrol_run',
        entityId: Number(row.id),
        afterData: {
          shiftId: Number(row.shiftId),
          flags: allFlags,
          provisional: Boolean(current.provisional),
          needsReview: Boolean(current.needsReview),
          startedAtDevice: new Date(row.startedAtDevice).toISOString(),
          startedAtServer: new Date(row.startedAtServer).toISOString(),
          clockDriftMs: current.clockDriftMs == null ? null : Number(current.clockDriftMs),
          windowKey: row.windowKey ?? null,
        },
      });
    }
    return current;
  }

  /** Mark a run as having synced late, adding flags (deduplicated) and optionally needsReview. */
  private async markLate(runId: number, add: PatrolSyncFlag[], needsReview: boolean) {
    const [row] = await updateRows(this.dataSource,
      `UPDATE "patrol_runs" SET "syncedLate" = true,
          "syncFlags" = (SELECT COALESCE(jsonb_agg(DISTINCT f), '[]'::jsonb) FROM jsonb_array_elements("syncFlags" || $2::jsonb) AS f),
          "needsReview" = "needsReview" OR $3, "updatedAt" = now()
        WHERE "id" = $1 RETURNING *`,
      [runId, JSON.stringify(add), needsReview],
    );
    return row;
  }

  private async findRunByClientId(companyId: number, clientRunId: string) {
    const [row] = await this.dataSource.query(`SELECT * FROM "patrol_runs" WHERE "companyId" = $1 AND "clientRunId" = $2`, [companyId, clientRunId]);
    return row ?? null;
  }

  private replayRun(row: any, actor: PatrolGuardActor, dto: StartPatrolRunDto, startedAtDevice: Date) {
    const same = row
      && Number(row.guardId) === actor.guardId
      && Number(row.shiftId) === dto.shiftId
      && (row.scheduleId == null ? null : Number(row.scheduleId)) === (dto.scheduleId ?? null)
      && (dto.routeId == null || (row.routeId != null && Number(row.routeId) === dto.routeId))
      && new Date(row.startedAtDevice).getTime() === startedAtDevice.getTime();
    if (!same) throw idempotencyConflict('clientRunId');
    return serializeRun(row);
  }

  // ── Scan ───────────────────────────────────────────────────────────────────────────────────────────

  async recordVisit(user: JwtPayload, runId: number, dto: RecordPatrolVisitDto, now: Date = new Date()) {
    const actor = await this.access.guardActor(user);
    const run = await this.ownRun(actor, runId);
    this.access.rejectLocation(dto);
    if (!dto.scanPayload && !dto.checkpointPublicId) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'Send the scanned label (scanPayload) or the checkpointPublicId.');
    }
    const parsed = dto.scanPayload ? parseCheckpointLabel(dto.scanPayload) : null;
    if (parsed && dto.checkpointPublicId && parsed.publicId !== dto.checkpointPublicId) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'checkpointPublicId does not match the scanned label.');
    }
    const scanPayload = dto.scanPayload?.trim() ?? null;
    const scannedPublicId = parsed?.publicId ?? dto.checkpointPublicId ?? null;
    const scannedAtDevice = new Date(dto.scannedAtDevice);
    const companyId = Number(run.companyId);

    const replay = await this.findVisitByClientId(companyId, dto.clientVisitId);
    if (replay) return this.replayVisit(replay, runId, scanPayload, scannedPublicId, scannedAtDevice);

    if (run.status !== 'in_progress') {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.RUN_NOT_IN_PROGRESS, 'This patrol is already finished.', { runStatus: run.status });
    }
    const syncFlags: PatrolSyncFlag[] = [];
    let thresholdMinutes: number | null = null;
    if (run.shiftStatus !== 'in_progress') {
      const { policy } = await this.assertPostShiftWrite(run, now);
      syncFlags.push('synced_after_book_off');
      thresholdMinutes = policy.clockDriftThresholdMinutes;
    }
    const driftMs = clockDriftMs(now, dto.sentAtDevice ? new Date(dto.sentAtDevice) : null);
    if (driftMs !== null) {
      thresholdMinutes ??= (await this.config.effectivePolicy(companyId, Number(run.siteId))).clockDriftThresholdMinutes;
      if (isClockDriftSuspect(driftMs, thresholdMinutes)) syncFlags.push('clock_drift_suspect');
    }

    const verdict = await this.verifyScan(run, parsed, Boolean(dto.scanPayload), scannedPublicId);
    const [inserted] = await this.dataSource.query(
      `INSERT INTO "patrol_checkpoint_visits" ("companyId", "runId", "checkpointId", "scannedPublicId", "scannedTokenVersion", "scannedKeyId",
          "scanPayload", "method", "result", "flags", "provisional", "scannedAtDevice", "clientVisitId", "syncedLate", "syncFlags", "clockDriftMs",
          "receivedAtServer")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'qr', $8, $9::jsonb, true, $10, $11, $12, $13::jsonb, $14, $15)
       ON CONFLICT ("companyId", "clientVisitId") DO NOTHING RETURNING *`,
      [companyId, runId, verdict.checkpointId, scannedPublicId, parsed?.tokenVersion ?? null, parsed?.keyId ?? null, scanPayload,
        verdict.result, JSON.stringify(verdict.flags), scannedAtDevice, dto.clientVisitId, syncFlags.includes('synced_after_book_off'),
        JSON.stringify(syncFlags), driftMs, now],
    );
    if (!inserted) {
      const winner = await this.findVisitByClientId(companyId, dto.clientVisitId);
      return this.replayVisit(winner, runId, scanPayload, scannedPublicId, scannedAtDevice);
    }
    const lateScan = await this.exceptions.recordLateEvidence(this.dataSource, {
      companyId,
      runId,
      kind: 'scan_after_alert',
      match: { runId, types: ['patrol_abandoned'] },
      deviceTime: scannedAtDevice,
      now,
      userId: actor.userId,
    });
    if (syncFlags.length || lateScan > 0) {
      const runFlags: PatrolSyncFlag[] = [
        ...(syncFlags.includes('synced_after_book_off') ? ['synced_after_book_off' as PatrolSyncFlag] : []),
        ...(lateScan > 0 ? ['evidence_after_alert' as PatrolSyncFlag] : []),
      ];
      if (runFlags.length) await this.markLate(runId, runFlags, false);
      if (syncFlags.length) {
        await this.auditLogService.log({
          company: { id: companyId },
          user: { id: actor.userId },
          action: 'patrol.late_sync_flagged',
          entityType: 'patrol_checkpoint_visit',
          entityId: Number(inserted.id),
          afterData: { runId, flags: syncFlags, scannedAtDevice: scannedAtDevice.toISOString(), receivedAtServer: now.toISOString(), clockDriftMs: driftMs },
        });
      }
    }
    if (verdict.result === 'flagged') {
      await this.auditLogService.log({
        company: { id: companyId },
        user: { id: actor.userId },
        action: 'patrol.scan_flagged',
        entityType: 'patrol_checkpoint_visit',
        entityId: Number(inserted.id),
        afterData: { runId, checkpointId: verdict.checkpointId, flags: verdict.flags },
      });
    }
    return serializeVisit({ ...inserted, checkpointLabel: verdict.checkpointLabel });
  }

  /**
   * Server-side check of one scan. Never rejects the scan: the result and its reasons are stored on the visit.
   *   verified    a signed label, valid MAC, current version, an active checkpoint of the run's site (and route)
   *   unverified  nothing wrong was found but the signature could not be checked (publicId only, or no server key)
   *   flagged     anything suspicious (tampered, revoked, wrong site, unknown, duplicate, off-route …)
   */
  private async verifyScan(run: any, parsed: ReturnType<typeof parseCheckpointLabel>, hadPayload: boolean, publicId: string | null) {
    const flags: PatrolScanFlag[] = [];
    let checkpoint: any = null;
    if (hadPayload && !parsed) flags.push('malformed_payload');
    if (publicId) {
      [checkpoint] = await this.dataSource.query(
        `SELECT "id", "siteId", "label", "tokenVersion", "active", "revokedAt" FROM "patrol_checkpoints" WHERE "publicId" = $1 AND "companyId" = $2`,
        [publicId, run.companyId],
      );
    }
    if (!checkpoint) {
      if (publicId) flags.push('unknown_checkpoint');
    } else {
      if (Number(checkpoint.siteId) !== Number(run.siteId)) flags.push('wrong_site');
      if (checkpoint.revokedAt || !checkpoint.active) flags.push('checkpoint_revoked');
      if (run.routeId != null) {
        const [onRoute] = await this.dataSource.query(
          `SELECT 1 FROM "patrol_route_checkpoints" WHERE "routeId" = $1 AND "checkpointId" = $2`,
          [run.routeId, checkpoint.id],
        );
        if (!onRoute) flags.push('not_on_route');
      }
      const [dup] = await this.dataSource.query(
        `SELECT 1 FROM "patrol_checkpoint_visits" WHERE "runId" = $1 AND "checkpointId" = $2 LIMIT 1`,
        [run.id, checkpoint.id],
      );
      if (dup) flags.push('duplicate_in_run');
    }
    if (parsed) {
      const signature = checkLabelSignature(parsed, patrolQrKeyring());
      if (signature === 'no_key') flags.push('signing_key_unavailable');
      else if (signature === 'unknown_key') flags.push('unknown_signing_key');
      else if (signature === 'invalid') flags.push('tampered_signature');
      else if (checkpoint) {
        // Only a genuinely signed label says anything about its version.
        if (parsed.tokenVersion < Number(checkpoint.tokenVersion)) flags.push('revoked_label');
        else if (parsed.tokenVersion > Number(checkpoint.tokenVersion)) flags.push('invalid_label_version');
      }
    } else if (!hadPayload) {
      flags.push('unsigned_scan');
    }
    const result: PatrolVisitResult = flags.length === 0
      ? 'verified'
      : flags.every((f) => PATROL_UNVERIFIED_ONLY_FLAGS.includes(f)) ? 'unverified' : 'flagged';
    return { checkpointId: checkpoint ? Number(checkpoint.id) : null, checkpointLabel: checkpoint?.label ?? null, flags, result };
  }

  private async findVisitByClientId(companyId: number, clientVisitId: string) {
    const [row] = await this.dataSource.query(
      `SELECT v.*, c."label" AS "checkpointLabel" FROM "patrol_checkpoint_visits" v
         LEFT JOIN "patrol_checkpoints" c ON c."id" = v."checkpointId"
        WHERE v."companyId" = $1 AND v."clientVisitId" = $2`,
      [companyId, clientVisitId],
    );
    return row ?? null;
  }

  private replayVisit(row: any, runId: number, scanPayload: string | null, publicId: string | null, scannedAtDevice: Date) {
    const same = row
      && Number(row.runId) === runId
      && (row.scanPayload ?? null) === scanPayload
      && (row.scannedPublicId ?? null) === publicId
      && new Date(row.scannedAtDevice).getTime() === scannedAtDevice.getTime();
    if (!same) throw idempotencyConflict('clientVisitId');
    return serializeVisit(row);
  }

  // ── Complete ───────────────────────────────────────────────────────────────────────────────────────

  async completeRun(user: JwtPayload, runId: number, dto: CompletePatrolRunDto, now: Date = new Date()) {
    const actor = await this.access.guardActor(user);
    const run = await this.ownRun(actor, runId);
    this.access.rejectLocation(dto);
    const completedAtDevice = new Date(dto.completedAtDevice);
    const reason = dto.exceptionReason?.trim() || null;
    if (dto.exceptionReason !== undefined && !reason) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'exceptionReason cannot be blank.');
    }
    if (run.status !== 'in_progress') return this.replayCompletion(run, completedAtDevice, reason);
    const flags: PatrolSyncFlag[] = [];
    const driftMs = clockDriftMs(now, dto.sentAtDevice ? new Date(dto.sentAtDevice) : null);
    let thresholdMinutes: number | null = null;
    if (run.shiftStatus !== 'in_progress') {
      const { policy, attendance, shiftEnd } = await this.assertPostShiftWrite(run, now);
      thresholdMinutes = policy.clockDriftThresholdMinutes;
      flags.push('synced_after_book_off');
      if (adjustForDrift(completedAtDevice, driftMs).getTime() > (attendance.bookOffAt ?? shiftEnd).getTime()) flags.push('completed_after_book_off');
    }
    if (driftMs !== null) {
      thresholdMinutes ??= (await this.config.effectivePolicy(Number(run.companyId), Number(run.siteId))).clockDriftThresholdMinutes;
      if (isClockDriftSuspect(driftMs, thresholdMinutes)) flags.push('clock_drift_suspect');
    }
    const mergedFlags = [...new Set([...(run.syncFlags ?? []), ...flags])] as PatrolSyncFlag[];
    const [updated] = await updateRows(this.dataSource,
      `UPDATE "patrol_runs" SET "status" = $2, "completedAtDevice" = $3, "completedAtServer" = $4, "exceptionReason" = $5,
          "syncedLate" = "syncedLate" OR $6, "syncFlags" = $7::jsonb, "needsReview" = "needsReview" OR $8, "updatedAt" = now()
        WHERE "id" = $1 AND "status" = 'in_progress' RETURNING *`,
      [runId, reason ? 'incomplete' : 'completed', completedAtDevice, now, reason, flags.includes('synced_after_book_off'),
        JSON.stringify(mergedFlags), flags.some((f) => PATROL_REVIEW_FLAGS.includes(f))],
    );
    if (updated) {
      let current = updated;
      const late = await this.exceptions.recordLateEvidence(this.dataSource, {
        companyId: Number(run.companyId),
        runId,
        kind: 'run_completed_after_alert',
        match: { runId, types: ['patrol_abandoned'] },
        deviceTime: completedAtDevice,
        now,
        userId: actor.userId,
      });
      if (late > 0) current = await this.markLate(runId, ['evidence_after_alert'], false);
      if (flags.length) {
        await this.auditLogService.log({
          company: { id: Number(run.companyId) },
          user: { id: actor.userId },
          action: 'patrol.late_sync_flagged',
          entityType: 'patrol_run',
          entityId: runId,
          afterData: { step: 'complete', flags, completedAtDevice: completedAtDevice.toISOString(), completedAtServer: now.toISOString(), clockDriftMs: driftMs },
        });
      }
      return serializeRun(current);
    }
    // A concurrent completion won: same content → that row; different → 409.
    const [current] = await this.dataSource.query(`SELECT * FROM "patrol_runs" WHERE "id" = $1`, [runId]);
    return this.replayCompletion(current, completedAtDevice, reason);
  }

  private replayCompletion(run: any, completedAtDevice: Date, reason: string | null) {
    if (run.status === 'closed_by_system') {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.RUN_NOT_IN_PROGRESS, 'This patrol was closed by the system.', { runStatus: run.status });
    }
    const same = run.completedAtDevice != null
      && new Date(run.completedAtDevice).getTime() === completedAtDevice.getTime()
      && (run.exceptionReason ?? null) === reason;
    if (!same) throw idempotencyConflict('completion');
    return serializeRun(run);
  }

  /** The Guard's own run (anyone else's is 404), with its shift status and the company switch on. */
  private async ownRun(actor: PatrolGuardActor, runId: number) {
    const [run] = await this.dataSource.query(
      `SELECT r.*, s."status" AS "shiftStatus", s."end" AS "shiftEnd", c."patrolsEnabled" FROM "patrol_runs" r
         JOIN "shifts" s ON s."id" = r."shiftId" JOIN "companies" c ON c."id" = r."companyId"
        WHERE r."id" = $1`,
      [runId],
    );
    if (!run || Number(run.guardId) !== actor.guardId) {
      throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Patrol not found.');
    }
    if (run.patrolsEnabled !== true) {
      throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_ENABLED, 'Patrol Management is not available for this company.');
    }
    return run;
  }
}

function idempotencyConflict(what: string) {
  return patrolError(
    HttpStatus.CONFLICT,
    PatrolErrorCode.IDEMPOTENCY_CONFLICT,
    `This ${what} was already used for a different request. Generate a new id for a new action.`,
  );
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const driverError = (error as QueryFailedError & { driverError?: { code?: string; constraint?: string } })?.driverError;
  return error instanceof QueryFailedError && driverError?.code === '23505' && driverError?.constraint === constraint;
}
