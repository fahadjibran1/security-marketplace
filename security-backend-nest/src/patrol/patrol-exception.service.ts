import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CompanyPermission, PATROL_ALERT_ACT_PERMISSIONS } from '../company-membership/company-membership-types';
import { SafetyAlert, SafetyAlertPriority, SafetyAlertStatus, SafetyAlertType } from '../safety-alert/entities/safety-alert.entity';
import {
  alertRequiresResolutionNote,
  PATROL_LATE_SYNC_RESOLUTION,
  PATROL_RESOLUTION_REASONS,
} from '../safety-alert/resolution-reasons';
import { SafetyAlertService } from '../safety-alert/safety-alert.service';
import { PatrolExceptionsQueryDto, ResolvePatrolExceptionDto } from './dto/patrol.dto';
import { PatrolAccessService } from './patrol-access.service';
import { PatrolErrorCode, PatrolExceptionType, patrolError } from './patrol-constants';
import { serializeException, updateRows } from './patrol-serializers';

/** Which alert carries which exception type. 'patrol_late' never raises one (a late start is a run flag). */
export const PATROL_EXCEPTION_ALERT_TYPE: Partial<Record<PatrolExceptionType, SafetyAlertType>> = {
  patrol_missed: SafetyAlertType.PATROL_MISSED,
  patrol_abandoned: SafetyAlertType.PATROL_ABANDONED,
  patrol_incomplete: SafetyAlertType.PATROL_INCOMPLETE,
  checkpoint_missed: SafetyAlertType.CHECKPOINT_MISSED,
  evidence_unverified: SafetyAlertType.PATROL_UNVERIFIED,
};

const ALERT_PRIORITY: Partial<Record<PatrolExceptionType, SafetyAlertPriority>> = {
  patrol_missed: SafetyAlertPriority.HIGH,
  patrol_abandoned: SafetyAlertPriority.HIGH,
  patrol_incomplete: SafetyAlertPriority.MEDIUM,
  checkpoint_missed: SafetyAlertPriority.MEDIUM,
  evidence_unverified: SafetyAlertPriority.MEDIUM,
};

export type RaisePatrolException = {
  companyId: number;
  siteId: number;
  scheduleId: number | null;
  shiftId: number | null;
  runId: number | null;
  guardId: number | null;
  windowKey: string;
  scopeKey: string;
  type: PatrolExceptionType;
  windowStart: Date | null;
  windowEnd: Date | null;
  /** Whether it needs action: then ONE SafetyAlert carries it into the existing alert queue (Live Operations). */
  actionable: boolean;
  /** The alert's message, as raised (never rewritten afterwards). */
  message: string;
  /** What the engine found, kept on the exception. */
  note: string | null;
  now: Date;
  /** Migration 71 (#67): the reconciliation run that raised it (never set by the live sweep). */
  reconciliationRunId?: number | null;
};

export type LateEvidenceKind = 'run_started_after_alert' | 'run_completed_after_alert' | 'scan_after_alert' | 'photo_after_alert';

/**
 * Patrol exceptions and their alerts (Patrols P1-B, Migration 69).
 *
 * RAISE. An exception is raised at most ONCE per (company, windowKey, scopeKey, type), ever: an insert that also checks
 * that no row of that key exists in any status (so resolving an exception never makes the sweep raise it again), with
 * ON CONFLICT DO NOTHING against M68's partial unique index for two sweeps racing. An actionable exception raises exactly
 * one SafetyAlert — the existing .orIgnore() pattern against M69's partial unique index on safety_alerts.patrolExceptionId —
 * and both rows point at each other. Exception, alert and their audit entries commit in the caller's transaction.
 *
 * LATE EVIDENCE. Evidence that reaches the server after a missed / abandoned exception was raised is APPLIED (the run uses
 * its device times, provisionally) and RECORDED: the exception gets an annotation ("evidence received after alert") and
 * lateEvidenceAt; its alert, if still open, is downgraded to low priority, annotated and from then on offers the
 * resolution "patrol_completed_late_sync". Nothing is closed automatically, and no exception, alert message or audit
 * entry is rewritten or deleted.
 *
 * ACT. Acknowledge / resolve go through the existing alert lifecycle when the exception has an alert (so the alert and
 * the exception always agree, see patrol-alert-link.ts), or straight onto the exception when it has none.
 */
@Injectable()
export class PatrolExceptionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: PatrolAccessService,
    private readonly auditLogService: AuditLogService,
    private readonly safetyAlertService: SafetyAlertService,
  ) {}

  async raise(manager: EntityManager, input: RaisePatrolException): Promise<{ created: boolean; exceptionId: number | null; alertId: number | null }> {
    const [inserted] = await manager.query(
      `INSERT INTO "patrol_exceptions" ("companyId", "siteId", "runId", "scheduleId", "shiftId", "windowKey", "scopeKey", "type", "note",
          "guardId", "windowStart", "windowEnd", "reconciliationRunId")
       SELECT $1::int, $2::int, $3::int, $4::int, $5::int, $6::varchar, $7::varchar, $8::varchar, $9::varchar, $10::int, $11::timestamptz, $12::timestamptz, $13::int
        WHERE NOT EXISTS (SELECT 1 FROM "patrol_exceptions" WHERE "companyId" = $1::int AND "windowKey" = $6::varchar AND "scopeKey" = $7::varchar AND "type" = $8::varchar)
       ON CONFLICT DO NOTHING RETURNING "id"`,
      [input.companyId, input.siteId, input.runId, input.scheduleId, input.shiftId, input.windowKey, input.scopeKey, input.type,
        input.note?.slice(0, 1000) ?? null, input.guardId, input.windowStart, input.windowEnd, input.reconciliationRunId ?? null],
    );
    if (!inserted) return { created: false, exceptionId: null, alertId: null };
    const exceptionId = Number(inserted.id);
    await this.auditLogService.logInTransaction(manager, {
      company: { id: input.companyId },
      user: null,
      action: 'patrol.exception_raised',
      entityType: 'patrol_exception',
      entityId: exceptionId,
      afterData: {
        type: input.type,
        windowKey: input.windowKey,
        scopeKey: input.scopeKey,
        siteId: input.siteId,
        scheduleId: input.scheduleId,
        shiftId: input.shiftId,
        runId: input.runId,
        guardId: input.guardId,
        windowStart: input.windowStart?.toISOString() ?? null,
        windowEnd: input.windowEnd?.toISOString() ?? null,
        actionable: input.actionable,
        detectedAt: input.now.toISOString(),
        ...(input.reconciliationRunId ? { reconciled: true, reconciliationRunId: input.reconciliationRunId } : {}),
      },
    });

    const alertType = PATROL_EXCEPTION_ALERT_TYPE[input.type];
    if (!input.actionable || !alertType) return { created: true, exceptionId, alertId: null };
    const result = await manager
      .createQueryBuilder()
      .insert()
      .into(SafetyAlert)
      .values({
        company: { id: input.companyId },
        guard: input.guardId ? { id: input.guardId } : null,
        shift: input.shiftId ? { id: input.shiftId } : null,
        type: alertType,
        priority: ALERT_PRIORITY[input.type] ?? SafetyAlertPriority.MEDIUM,
        status: SafetyAlertStatus.OPEN,
        welfareWindowIndex: null,
        message: input.message,
        patrolExceptionId: exceptionId,
        patrolRunId: input.runId,
        patrolWindowKey: input.windowKey,
      } as never)
      .orIgnore()
      .execute();
    let alertId = Number(((result.identifiers ?? []).filter(Boolean)[0] as { id?: number } | undefined)?.id ?? NaN);
    if (!Number.isFinite(alertId)) {
      const [existing] = await manager.query(`SELECT "id" FROM "safety_alerts" WHERE "patrolExceptionId" = $1`, [exceptionId]);
      if (!existing) return { created: true, exceptionId, alertId: null };
      alertId = Number(existing.id);
    }
    await manager.query(`UPDATE "patrol_exceptions" SET "safetyAlertId" = $2 WHERE "id" = $1 AND "safetyAlertId" IS NULL`, [exceptionId, alertId]);
    await this.auditLogService.logInTransaction(manager, {
      company: { id: input.companyId },
      user: null,
      action: 'patrol.alert_raised',
      entityType: 'safety_alert',
      entityId: alertId,
      afterData: { type: alertType, patrolExceptionId: exceptionId, patrolRunId: input.runId, patrolWindowKey: input.windowKey, shiftId: input.shiftId },
    });
    return { created: true, exceptionId, alertId };
  }

  /**
   * Evidence arrived after a missed / abandoned exception was raised: annotate (once per run and kind), never close or
   * rewrite. `match` selects the exceptions: a window's missed exception, or a run's abandoned one. Returns how many
   * exceptions were annotated.
   */
  async recordLateEvidence(
    runner: Pick<EntityManager, 'query'>,
    input: {
      companyId: number;
      runId: number;
      kind: LateEvidenceKind;
      match: { windowKey: string; scopeKey: string; types: PatrolExceptionType[] } | { runId: number; types: PatrolExceptionType[] };
      deviceTime: Date | null;
      now: Date;
      userId: number | null;
    },
  ): Promise<number> {
    const rows = 'windowKey' in input.match
      ? await runner.query(
        `SELECT * FROM "patrol_exceptions" WHERE "companyId" = $1 AND "windowKey" = $2 AND "scopeKey" = $3 AND "type" = ANY($4::text[]) ORDER BY "id"`,
        [input.companyId, input.match.windowKey, input.match.scopeKey, input.match.types],
      )
      : await runner.query(
        `SELECT * FROM "patrol_exceptions" WHERE "companyId" = $1 AND "runId" = $2 AND "type" = ANY($3::text[]) ORDER BY "id"`,
        [input.companyId, input.match.runId, input.match.types],
      );
    let annotated = 0;
    for (const exception of rows) {
      const already = (exception.annotations ?? []).some((a: any) => a?.kind === input.kind && Number(a?.runId) === input.runId);
      if (already) continue;
      const text = 'evidence received after alert';
      const entry = {
        at: input.now.toISOString(),
        kind: input.kind,
        text,
        runId: input.runId,
        deviceTime: input.deviceTime?.toISOString() ?? null,
      };
      await runner.query(
        `UPDATE "patrol_exceptions" SET "annotations" = "annotations" || $2::jsonb, "lateEvidenceAt" = COALESCE("lateEvidenceAt", $3), "updatedAt" = now()
          WHERE "id" = $1`,
        [exception.id, JSON.stringify([entry]), input.now],
      );
      annotated += 1;
      await this.auditInRunner(runner, {
        companyId: input.companyId,
        userId: input.userId,
        action: 'patrol.late_evidence_received',
        entityType: 'patrol_exception',
        entityId: Number(exception.id),
        afterData: { type: exception.type, runId: input.runId, kind: input.kind, deviceTime: entry.deviceTime, receivedAt: entry.at },
      });
      if (exception.safetyAlertId) {
        const [alert] = await runner.query(`SELECT "id", "status", "priority", "patrolLateSyncAt" FROM "safety_alerts" WHERE "id" = $1`, [exception.safetyAlertId]);
        if (alert && alert.status !== SafetyAlertStatus.CLOSED) {
          const note = `Evidence received after alert (${input.kind.replace(/_/g, ' ')}, run ${input.runId}). Confirm before resolving: patrol completed — late sync.`;
          await runner.query(
            `UPDATE "safety_alerts" SET "priority" = 'low', "patrolLateSyncAt" = COALESCE("patrolLateSyncAt", $2), "patrolAnnotation" = $3, "updatedAt" = now()
              WHERE "id" = $1 AND "status" <> 'closed'`,
            [alert.id, input.now, note.slice(0, 500)],
          );
          await this.auditInRunner(runner, {
            companyId: input.companyId,
            userId: input.userId,
            action: 'safety_alert.patrol_late_sync',
            entityType: 'safety_alert',
            entityId: Number(alert.id),
            beforeData: { priority: alert.priority, status: alert.status, patrolLateSyncAt: alert.patrolLateSyncAt ?? null },
            afterData: { priority: 'low', status: alert.status, patrolLateSyncAt: (alert.patrolLateSyncAt ? new Date(alert.patrolLateSyncAt) : input.now).toISOString(), annotation: note },
          });
        }
      }
    }
    return annotated;
  }

  private auditInRunner(
    runner: Pick<EntityManager, 'query'>,
    input: { companyId: number; userId: number | null; action: string; entityType: string; entityId: number; beforeData?: Record<string, unknown>; afterData: Record<string, unknown> },
  ) {
    const manager = (runner as EntityManager).getRepository ? (runner as EntityManager) : null;
    const entry = {
      company: { id: input.companyId },
      user: input.userId ? { id: input.userId } : null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      beforeData: input.beforeData ?? null,
      afterData: input.afterData,
    };
    return manager ? this.auditLogService.logInTransaction(manager, entry) : this.auditLogService.log(entry);
  }

  // ── Company API (patrols.view to read; alerts.manage or patrols.manage to act — owner decision, P1-C) ──

  async list(user: JwtPayload, query: PatrolExceptionsQueryDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    const rows = await this.dataSource.query(
      `SELECT e.*, a."status" AS "alertStatus", a."priority" AS "alertPriority" FROM "patrol_exceptions" e
         LEFT JOIN "safety_alerts" a ON a."id" = e."safetyAlertId"
        WHERE e."companyId" = $1 AND ($2::int IS NULL OR e."siteId" = $2) AND ($3::text IS NULL OR e."status" = $3)
          AND ($4::text IS NULL OR e."type" = $4)
        ORDER BY e."createdAt" DESC, e."id" DESC LIMIT 200`,
      [actor.companyId, query.siteId ?? null, query.status ?? null, query.type ?? null],
    );
    return rows.map((r: any) => ({ ...serializeException(r), alertStatus: r.alertStatus ?? null, alertPriority: r.alertPriority ?? null }));
  }

  async acknowledge(user: JwtPayload, id: number) {
    const actor = await this.access.companyActorAny(user, PATROL_ALERT_ACT_PERMISSIONS);
    const exception = await this.row(actor.companyId, id);
    if (exception.status === 'resolved') {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EXCEPTION_RESOLVED, 'This patrol exception is already resolved.');
    }
    if (exception.safetyAlertId) {
      const [alert] = await this.dataSource.query(`SELECT "status" FROM "safety_alerts" WHERE "id" = $1`, [exception.safetyAlertId]);
      if (alert && alert.status === SafetyAlertStatus.OPEN) {
        await this.safetyAlertService.acknowledgePatrolAlert(actor.userId, actor.companyId, Number(exception.safetyAlertId));
        return serializeException(await this.row(actor.companyId, id));
      }
    }
    if (exception.status === 'open') {
      await this.dataSource.transaction(async (manager) => {
        const [updated] = await updateRows(manager,
          `UPDATE "patrol_exceptions" SET "status" = 'acknowledged', "acknowledgedAt" = now(), "acknowledgedByUserId" = $2, "updatedAt" = now()
            WHERE "id" = $1 AND "status" = 'open' RETURNING *`,
          [id, actor.userId],
        );
        if (updated) {
          await this.auditLogService.logInTransaction(manager, {
            company: { id: actor.companyId },
            user: { id: actor.userId },
            action: 'patrol.exception_acknowledged',
            entityType: 'patrol_exception',
            entityId: id,
            beforeData: { status: 'open' },
            afterData: { status: 'acknowledged', via: 'patrols' },
          });
        }
      });
    }
    return serializeException(await this.row(actor.companyId, id));
  }

  async resolve(user: JwtPayload, id: number, dto: ResolvePatrolExceptionDto) {
    const actor = await this.access.companyActorAny(user, PATROL_ALERT_ACT_PERMISSIONS);
    const exception = await this.row(actor.companyId, id);
    if (exception.status === 'resolved') {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EXCEPTION_RESOLVED, 'This patrol exception is already resolved.');
    }
    const reason = dto.resolutionReason.trim();
    const note = dto.resolutionNote?.trim() || null;
    if (exception.safetyAlertId) {
      const [alert] = await this.dataSource.query(`SELECT "status" FROM "safety_alerts" WHERE "id" = $1`, [exception.safetyAlertId]);
      if (alert && alert.status !== SafetyAlertStatus.CLOSED) {
        // The alert's own lifecycle validates the reason for its type and mirrors the result onto this exception.
        await this.safetyAlertService.closePatrolAlert(actor.userId, actor.companyId, Number(exception.safetyAlertId), {
          resolutionReason: reason,
          ...(note ? { resolutionNote: note } : {}),
        });
        return serializeException(await this.row(actor.companyId, id));
      }
    }
    if (!(PATROL_RESOLUTION_REASONS as readonly string[]).includes(reason)) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.RESOLUTION_INVALID, `"${reason}" is not a patrol resolution reason.`);
    }
    if (reason === PATROL_LATE_SYNC_RESOLUTION && !exception.lateEvidenceAt) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.RESOLUTION_INVALID, 'No evidence has been received after this exception, so it cannot be resolved as a late sync.');
    }
    if (alertRequiresResolutionNote(SafetyAlertType.PATROL_MISSED, reason) && !note) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.RESOLUTION_INVALID, 'A resolution note is required for this reason.');
    }
    await this.dataSource.transaction(async (manager) => {
      const annotation = note ? JSON.stringify([{ at: new Date().toISOString(), kind: 'resolution_note', text: note, byUserId: actor.userId }]) : '[]';
      const [updated] = await updateRows(manager,
        `UPDATE "patrol_exceptions" SET "status" = 'resolved', "resolution" = $2, "resolvedByUserId" = $3, "resolvedAt" = now(),
            "acknowledgedAt" = COALESCE("acknowledgedAt", now()), "acknowledgedByUserId" = COALESCE("acknowledgedByUserId", $3),
            "annotations" = "annotations" || $4::jsonb, "updatedAt" = now()
          WHERE "id" = $1 AND "status" <> 'resolved' RETURNING *`,
        [id, reason, actor.userId, annotation],
      );
      if (updated) {
        await this.auditLogService.logInTransaction(manager, {
          company: { id: actor.companyId },
          user: { id: actor.userId },
          action: 'patrol.exception_resolved',
          entityType: 'patrol_exception',
          entityId: id,
          beforeData: { status: exception.status },
          afterData: { status: 'resolved', resolution: reason, via: 'patrols' },
        });
      }
    });
    return serializeException(await this.row(actor.companyId, id));
  }

  private async row(companyId: number, id: number) {
    const [row] = await this.dataSource.query(`SELECT * FROM "patrol_exceptions" WHERE "id" = $1 AND "companyId" = $2`, [id, companyId]);
    if (!row) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Patrol exception not found.');
    return row;
  }
}
