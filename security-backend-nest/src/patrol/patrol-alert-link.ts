import type { EntityManager } from 'typeorm';
import type { AuditLogService } from '../audit-log/audit-log.service';

/**
 * The two-way link between a patrol exception and its SafetyAlert (Patrols P1-B, Migration 69).
 *
 * patrol_exceptions.safetyAlertId → safety_alerts.id, and safety_alerts.patrolExceptionId → patrol_exceptions.id. Acting on
 * either side acts on both, through ONE path: the existing alert lifecycle (SafetyAlertService acknowledge / close, with
 * its type-specific reasons, permissions and audit). After the alert transition is saved, this mirrors it onto the
 * exception and audits that too. The patrol API's exception actions call the same alert methods, so the two can never
 * disagree. An exception with no alert (not actionable under the policy) is acted on directly by PatrolExceptionService.
 *
 * Kept free of Nest providers so SafetyAlertService can call it without importing the Patrol module.
 */

type QueryRunnerLike = Pick<EntityManager, 'query'>;
type AlertLike = { id: number; patrolExceptionId?: number | null; company?: { id: number } | null };

export async function syncPatrolExceptionFromAlert(
  runner: QueryRunnerLike,
  auditLogService: Pick<AuditLogService, 'log'>,
  alert: AlertLike,
  transition: 'acknowledged' | 'resolved',
  userId: number,
  resolution?: { reason: string | null; note: string | null },
): Promise<boolean> {
  if (!alert.patrolExceptionId) return false;
  const now = new Date();
  let rows: any[];
  if (transition === 'acknowledged') {
    rows = unwrap(await runner.query(
      `UPDATE "patrol_exceptions" SET "status" = 'acknowledged', "acknowledgedAt" = $2, "acknowledgedByUserId" = $3, "updatedAt" = now()
        WHERE "id" = $1 AND "status" = 'open' RETURNING "id", "companyId", "status"`,
      [alert.patrolExceptionId, now, userId],
    ));
  } else {
    const annotation = resolution?.note
      ? JSON.stringify([{ at: now.toISOString(), kind: 'resolution_note', text: resolution.note, byUserId: userId }])
      : '[]';
    rows = unwrap(await runner.query(
      `UPDATE "patrol_exceptions" SET "status" = 'resolved', "resolution" = $2, "resolvedByUserId" = $3, "resolvedAt" = $4,
          "acknowledgedAt" = COALESCE("acknowledgedAt", $4), "acknowledgedByUserId" = COALESCE("acknowledgedByUserId", $3),
          "annotations" = "annotations" || $5::jsonb, "updatedAt" = now()
        WHERE "id" = $1 AND "status" <> 'resolved' RETURNING "id", "companyId", "status"`,
      [alert.patrolExceptionId, resolution?.reason ?? null, userId, now, annotation],
    ));
  }
  const row = rows[0];
  if (!row) return false;
  await auditLogService.log({
    company: { id: Number(row.companyId) },
    user: { id: userId },
    action: transition === 'acknowledged' ? 'patrol.exception_acknowledged' : 'patrol.exception_resolved',
    entityType: 'patrol_exception',
    entityId: Number(row.id),
    afterData: {
      status: row.status,
      via: 'safety_alert',
      safetyAlertId: alert.id,
      ...(transition === 'resolved' ? { resolution: resolution?.reason ?? null } : {}),
    },
  });
  return true;
}

/** UPDATE … RETURNING through TypeORM's raw query() answers [rows, count]. */
function unwrap(result: unknown): any[] {
  return Array.isArray(result) && Array.isArray(result[0]) ? (result[0] as any[]) : (result as any[]);
}
