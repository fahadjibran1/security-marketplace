import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CompletePatrolRunDto, RecordPatrolVisitDto, StartPatrolRunDto } from './dto/patrol.dto';
import { PatrolAccessService, PatrolGuardActor } from './patrol-access.service';
import { PatrolConfigService } from './patrol-config.service';
import { PATROL_UNVERIFIED_ONLY_FLAGS, PatrolErrorCode, PatrolScanFlag, PatrolVisitResult, patrolError } from './patrol-constants';
import { checkLabelSignature, parseCheckpointLabel, patrolQrKeyring } from './patrol-qr';
import { serializeRun, serializeVisit, updateRows } from './patrol-serializers';

const INT32_MAX = 2_147_483_647;

/**
 * The Guard's side of Patrols (the S4 Guard app; the distributed 1.1.2 app never calls any of this).
 *
 * The Guard acts only on their OWN shift. Starting a run, recording a scan and completing a run need the shift to be
 * in progress; replaying an already-accepted write (same client id, same content) always returns the stored row, even
 * after the shift ends, so an offline outbox can retry safely. Every write is idempotent on a client-generated id that
 * is unique per company: concurrent duplicates resolve to one row (INSERT … ON CONFLICT DO NOTHING, then read), and the
 * same id with different content is 409 PATROL_IDEMPOTENCY_CONFLICT. No location is ever accepted.
 */
@Injectable()
export class PatrolGuardService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: PatrolAccessService,
    private readonly config: PatrolConfigService,
    private readonly auditLogService: AuditLogService,
  ) {}

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
    };
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

    this.access.assertShiftInProgress(shift);
    if (shift.siteId == null) {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.SHIFT_HAS_NO_SITE, 'This shift has no site, so it has no patrols.');
    }
    let routeId = dto.routeId ?? null;
    if (dto.scheduleId != null) {
      const [schedule] = await this.dataSource.query(
        `SELECT "id", "siteId", "routeId", "active", "archivedAt" FROM "patrol_schedules" WHERE "id" = $1 AND "companyId" = $2`,
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

    let inserted: any;
    try {
      [inserted] = await this.dataSource.query(
        `INSERT INTO "patrol_runs" ("companyId", "siteId", "shiftId", "guardId", "startedByUserId", "scheduleId", "routeId",
            "startedAtDevice", "startedAtServer", "clockOffsetMs", "clientRunId")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT ("companyId", "clientRunId") DO NOTHING RETURNING *`,
        [shift.companyId, shift.siteId, shift.id, actor.guardId, actor.userId, dto.scheduleId ?? null, routeId, startedAtDevice, now,
          clockOffsetMs, dto.clientRunId],
      );
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
    if (inserted) return serializeRun(inserted);
    // A concurrent request with the same clientRunId won the insert: answer with that row, or 409 if it differs.
    const winner = await this.findRunByClientId(shift.companyId, dto.clientRunId);
    return this.replayRun(winner, actor, dto, startedAtDevice);
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

  async recordVisit(user: JwtPayload, runId: number, dto: RecordPatrolVisitDto) {
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
    if (run.shiftStatus !== 'in_progress') {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.SHIFT_NOT_IN_PROGRESS, 'Patrols can only be recorded during your shift, after Book On.', {
        shiftStatus: run.shiftStatus,
      });
    }

    const verdict = await this.verifyScan(run, parsed, Boolean(dto.scanPayload), scannedPublicId);
    const [inserted] = await this.dataSource.query(
      `INSERT INTO "patrol_checkpoint_visits" ("companyId", "runId", "checkpointId", "scannedPublicId", "scannedTokenVersion", "scannedKeyId",
          "scanPayload", "method", "result", "flags", "provisional", "scannedAtDevice", "clientVisitId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'qr', $8, $9::jsonb, true, $10, $11)
       ON CONFLICT ("companyId", "clientVisitId") DO NOTHING RETURNING *`,
      [companyId, runId, verdict.checkpointId, scannedPublicId, parsed?.tokenVersion ?? null, parsed?.keyId ?? null, scanPayload,
        verdict.result, JSON.stringify(verdict.flags), scannedAtDevice, dto.clientVisitId],
    );
    if (!inserted) {
      const winner = await this.findVisitByClientId(companyId, dto.clientVisitId);
      return this.replayVisit(winner, runId, scanPayload, scannedPublicId, scannedAtDevice);
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
    if (run.shiftStatus !== 'in_progress') {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.SHIFT_NOT_IN_PROGRESS, 'Patrols can only be recorded during your shift, after Book On.', {
        shiftStatus: run.shiftStatus,
      });
    }
    const [updated] = await updateRows(this.dataSource,
      `UPDATE "patrol_runs" SET "status" = $2, "completedAtDevice" = $3, "completedAtServer" = $4, "exceptionReason" = $5, "updatedAt" = now()
        WHERE "id" = $1 AND "status" = 'in_progress' RETURNING *`,
      [runId, reason ? 'incomplete' : 'completed', completedAtDevice, now, reason],
    );
    if (updated) return serializeRun(updated);
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
      `SELECT r.*, s."status" AS "shiftStatus", c."patrolsEnabled" FROM "patrol_runs" r
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
