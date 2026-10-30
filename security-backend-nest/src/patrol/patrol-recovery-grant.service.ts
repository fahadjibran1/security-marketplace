import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { CreatePatrolRecoveryGrantDto } from './dto/patrol-evidence.dto';
import { PatrolAccessService } from './patrol-access.service';
import { PATROL_RECOVERY_GRANT_DEFAULT_HOURS, PATROL_RECOVERY_GRANT_MAX_HOURS, PatrolErrorCode, patrolError } from './patrol-constants';
import { updateRows } from './patrol-serializers';

const HOUR = 3_600_000;
/** pg_advisory_xact_lock namespace: one grant decision per shift at a time ("72" for Migration 72, "068" for #68). */
export const PATROL_RECOVERY_GRANT_LOCK_NAMESPACE = 72_068;

export type ActiveRecoveryGrant = { id: number; companyId: number; guardId: number; shiftId: number; expiresAt: Date };

/** Which sync path a grant was used on (patrol.recovery_grant_used afterData.step). */
export type RecoveryGrantStep = 'run_start' | 'scan' | 'completion' | 'photo_upload_intent' | 'photo_upload_url_reissued';

/**
 * Exceptional offline recovery grants (issue #68, Migration 72; docs/patrols/P1-follow-ups.md §3).
 *
 * COMPANY (Owner / Admin: patrols.holds, the evidence-custody permission; Operations, Control Room, Viewer and Guards
 * cannot; the company comes only from resolveCompanyContext and another company's shift or grant is 404):
 *   POST /patrols/recovery-grants              issue: one Guard (default: the shift's Guard), one shift, a mandatory reason,
 *                                              durationHours 1–72 (default 24) from now. One active grant per Guard and shift.
 *   GET  /patrols/recovery-grants?status=active|all&shiftId=
 *   POST /patrols/recovery-grants/:id/revoke   with a mandatory reason; an expired or revoked grant cannot be revoked.
 * Issue and revoke are audited in the same transaction as the change (patrol.recovery_grant_issued / _revoked).
 *
 * SYNC (PatrolGuardService, PatrolEvidenceService): consulted ONLY when the standard post-shift sync window has closed,
 * and only for the Guard and shift it names. activeGrant() is the one lookup; recordUse() counts and audits every
 * acceptance it allowed (patrol.recovery_grant_used). Nothing else about the Guard's permissions changes.
 */
@Injectable()
export class PatrolRecoveryGrantService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: PatrolAccessService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ═══════════════════════ Sync side ═══════════════════════

  /** The unrevoked, unexpired grant for exactly this Guard on exactly this shift of this company, or null. */
  async activeGrant(companyId: number, guardId: number, shiftId: number, now: Date, manager?: EntityManager): Promise<ActiveRecoveryGrant | null> {
    const [row] = await (manager ?? this.dataSource).query(
      `SELECT "id", "companyId", "guardId", "shiftId", "expiresAt" FROM "patrol_sync_recovery_grants"
        WHERE "companyId" = $1 AND "guardId" = $2 AND "shiftId" = $3 AND "revokedAt" IS NULL AND "expiresAt" > $4
        ORDER BY "expiresAt" DESC, "id" DESC LIMIT 1`,
      [companyId, guardId, shiftId, now],
    );
    return row
      ? { id: Number(row.id), companyId: Number(row.companyId), guardId: Number(row.guardId), shiftId: Number(row.shiftId), expiresAt: new Date(row.expiresAt) }
      : null;
  }

  /** Every (shiftId, guardId) of the company with an active grant at `now` (the sweep keeps their runs open). */
  async activeGrantKeys(manager: EntityManager, companyId: number, now: Date): Promise<Set<string>> {
    const rows = await manager.query(
      `SELECT DISTINCT "shiftId", "guardId" FROM "patrol_sync_recovery_grants" WHERE "companyId" = $1 AND "revokedAt" IS NULL AND "expiresAt" > $2`,
      [companyId, now],
    );
    return new Set(rows.map((r: any) => grantKey(Number(r.shiftId), Number(r.guardId))));
  }

  /** Count and audit one acceptance a grant allowed. */
  async recordUse(grant: ActiveRecoveryGrant, input: { userId: number; step: RecoveryGrantStep; entityType: string; entityId: number; runId: number; now: Date }) {
    await this.dataSource.query(
      `UPDATE "patrol_sync_recovery_grants" SET "uses" = "uses" + 1, "lastUsedAt" = $2 WHERE "id" = $1`,
      [grant.id, input.now],
    );
    await this.auditLogService.log({
      company: { id: grant.companyId },
      user: { id: input.userId },
      action: 'patrol.recovery_grant_used',
      entityType: 'patrol_sync_recovery_grant',
      entityId: grant.id,
      afterData: {
        step: input.step,
        entityType: input.entityType,
        entityId: input.entityId,
        runId: input.runId,
        shiftId: grant.shiftId,
        guardId: grant.guardId,
        expiresAt: grant.expiresAt.toISOString(),
        acceptedAt: input.now.toISOString(),
        flag: 'recovered_via_grant',
      },
    });
  }

  // ═══════════════════════ Company side ═══════════════════════

  async issue(user: JwtPayload, dto: CreatePatrolRecoveryGrantDto, now: Date = new Date()) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_HOLDS);
    const reason = dto.reason.trim();
    if (reason.length < 3) throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'Give a reason of at least 3 characters.');
    const hours = dto.durationHours ?? PATROL_RECOVERY_GRANT_DEFAULT_HOURS;
    if (!Number.isInteger(hours) || hours < 1 || hours > PATROL_RECOVERY_GRANT_MAX_HOURS) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, `A recovery grant lasts 1 to ${PATROL_RECOVERY_GRANT_MAX_HOURS} hours.`);
    }
    const [shift] = await this.dataSource.query(
      `SELECT "id", "companyId", "guardId", "siteId", "status"::text AS "status" FROM "shifts" WHERE "id" = $1 AND "companyId" = $2`,
      [dto.shiftId, actor.companyId],
    );
    // Another company's shift is indistinguishable from one that does not exist.
    if (!shift) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.SHIFT_NOT_FOUND, 'Shift not found.');
    if (!['in_progress', 'completed'].includes(shift.status) || shift.siteId == null) {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.RECOVERY_GRANT_INELIGIBLE,
        'Patrol data can only be recovered for a shift that was worked (in progress or completed) at a site.', { shiftStatus: shift.status });
    }
    const guardId = dto.guardId ?? (shift.guardId == null ? null : Number(shift.guardId));
    if (guardId == null) throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.RECOVERY_GRANT_INELIGIBLE, 'This shift has no Guard.');
    if (guardId !== Number(shift.guardId)) {
      // A Guard no longer on the shift (replaced) qualifies only if they actually worked or patrolled it.
      const [worked] = await this.dataSource.query(
        `SELECT 1 FROM "attendance_events" WHERE "shiftId" = $1 AND "guardId" = $2
          UNION ALL SELECT 1 FROM "patrol_runs" WHERE "shiftId" = $1 AND "guardId" = $2 AND "companyId" = $3 LIMIT 1`,
        [shift.id, guardId, actor.companyId],
      );
      if (!worked) throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.RECOVERY_GRANT_INELIGIBLE, 'That Guard was not on this shift.');
    }
    const expiresAt = new Date(now.getTime() + hours * HOUR);
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [PATROL_RECOVERY_GRANT_LOCK_NAMESPACE, shift.id]);
      const existing = await this.activeGrant(actor.companyId, guardId, Number(shift.id), now, manager);
      if (existing) {
        throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.RECOVERY_GRANT_ACTIVE,
          'This Guard already has an active recovery grant for this shift. Revoke it first to issue a different one.', {
            grantId: existing.id, expiresAt: existing.expiresAt.toISOString(),
          });
      }
      const [row] = await manager.query(
        `INSERT INTO "patrol_sync_recovery_grants" ("companyId", "guardId", "shiftId", "reason", "createdByUserId", "createdAt", "expiresAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [actor.companyId, guardId, shift.id, reason, actor.userId, now, expiresAt],
      );
      await this.auditLogService.logInTransaction(manager, {
        company: { id: actor.companyId },
        user: { id: actor.userId },
        action: 'patrol.recovery_grant_issued',
        entityType: 'patrol_sync_recovery_grant',
        entityId: Number(row.id),
        afterData: { shiftId: Number(shift.id), guardId, reason, durationHours: hours, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString() },
      });
      return serializeRecoveryGrant(await this.withNames(manager, row), now);
    });
  }

  async revoke(user: JwtPayload, id: number, reasonInput: string, now: Date = new Date()) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_HOLDS);
    const reason = reasonInput.trim();
    if (reason.length < 3) throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'Give a reason of at least 3 characters.');
    return this.dataSource.transaction(async (manager) => {
      const [grant] = await manager.query(`SELECT * FROM "patrol_sync_recovery_grants" WHERE "id" = $1 AND "companyId" = $2 FOR UPDATE`, [id, actor.companyId]);
      if (!grant) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Recovery grant not found.');
      if (grant.revokedAt) throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.RECOVERY_GRANT_ENDED, 'This recovery grant was already revoked.');
      if (new Date(grant.expiresAt).getTime() <= now.getTime()) {
        throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.RECOVERY_GRANT_ENDED, 'This recovery grant has already expired.');
      }
      const [revoked] = await updateRows(manager,
        `UPDATE "patrol_sync_recovery_grants" SET "revokedAt" = $2, "revokedByUserId" = $3, "revokeReason" = $4
          WHERE "id" = $1 AND "revokedAt" IS NULL RETURNING *`,
        [id, now, actor.userId, reason],
      );
      await this.auditLogService.logInTransaction(manager, {
        company: { id: actor.companyId },
        user: { id: actor.userId },
        action: 'patrol.recovery_grant_revoked',
        entityType: 'patrol_sync_recovery_grant',
        entityId: id,
        beforeData: { revokedAt: null, expiresAt: new Date(grant.expiresAt).toISOString(), uses: Number(grant.uses) },
        afterData: { shiftId: Number(grant.shiftId), guardId: Number(grant.guardId), revokedAt: now.toISOString(), reason },
      });
      return serializeRecoveryGrant(await this.withNames(manager, revoked), now);
    });
  }

  async list(user: JwtPayload, query: { status?: string; shiftId?: number }, now: Date = new Date()) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_HOLDS);
    const rows = await this.dataSource.query(
      `SELECT g.*, gp."fullName" AS "guardName", s."siteId" AS "siteId", s."siteName" AS "shiftSiteName", s."start" AS "shiftStart", s."end" AS "shiftEnd"
         FROM "patrol_sync_recovery_grants" g
         JOIN "shifts" s ON s."id" = g."shiftId" AND s."companyId" = g."companyId"
         LEFT JOIN "guard_profiles" gp ON gp."id" = g."guardId"
        WHERE g."companyId" = $1 AND ($2::int IS NULL OR g."shiftId" = $2)
          AND ($3::boolean OR (g."revokedAt" IS NULL AND g."expiresAt" > $4))
        ORDER BY g."createdAt" DESC, g."id" DESC LIMIT 500`,
      [actor.companyId, query.shiftId ?? null, query.status === 'all', now],
    );
    return rows.map((row: any) => serializeRecoveryGrant(row, now));
  }

  private async withNames(manager: EntityManager, row: any) {
    const [names] = await manager.query(
      `SELECT gp."fullName" AS "guardName", s."siteId" AS "siteId", s."siteName" AS "shiftSiteName", s."start" AS "shiftStart", s."end" AS "shiftEnd"
         FROM "shifts" s LEFT JOIN "guard_profiles" gp ON gp."id" = $2 WHERE s."id" = $1`,
      [row.shiftId, row.guardId],
    );
    return { ...row, ...(names ?? {}) };
  }
}

export function grantKey(shiftId: number, guardId: number): string {
  return `${shiftId}:${guardId}`;
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

export function serializeRecoveryGrant(row: any, now: Date) {
  const status = row.revokedAt ? 'revoked' : new Date(row.expiresAt).getTime() <= now.getTime() ? 'expired' : 'active';
  return {
    id: Number(row.id),
    shiftId: Number(row.shiftId),
    guardId: Number(row.guardId),
    guardName: row.guardName ?? null,
    siteId: row.siteId == null ? null : Number(row.siteId),
    siteName: row.shiftSiteName ?? null,
    shiftStart: iso(row.shiftStart),
    shiftEnd: iso(row.shiftEnd),
    reason: row.reason,
    status,
    createdAt: iso(row.createdAt),
    createdByUserId: Number(row.createdByUserId),
    expiresAt: iso(row.expiresAt),
    revokedAt: iso(row.revokedAt),
    revokedByUserId: row.revokedByUserId == null ? null : Number(row.revokedByUserId),
    revokeReason: row.revokeReason ?? null,
    uses: Number(row.uses),
    lastUsedAt: iso(row.lastUsedAt),
  };
}
