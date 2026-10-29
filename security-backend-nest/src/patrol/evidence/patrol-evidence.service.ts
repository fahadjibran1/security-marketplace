import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { effectiveAttendance } from '../../attendance/effective-attendance';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { JwtPayload } from '../../auth/types/jwt-payload.type';
import { CompanyPermission } from '../../company-membership/company-membership-types';
import { CreatePatrolEvidenceHoldDto, RequestPatrolEvidenceUploadDto } from '../dto/patrol-evidence.dto';
import { PatrolAccessService, PatrolGuardActor } from '../patrol-access.service';
import { PatrolConfigService } from '../patrol-config.service';
import { PatrolErrorCode, patrolError } from '../patrol-constants';
import { clockDriftMs, isClockDriftSuspect, syncAcceptanceEndsAt, withinSyncAcceptance } from '../patrol-late-sync';
import { serializeEvidenceMetadata, serializeHold, updateRows } from '../patrol-serializers';
import { patrolObjectKey, siblingKey } from './patrol-evidence-keys';
import { PatrolEvidenceLifecycleService } from './patrol-evidence-lifecycle.service';
import { PATROL_EVIDENCE_MAX_PER_RUN, heldSql, patrolRetentionMode } from './patrol-evidence-shared';
import { PATROL_EVIDENCE_ALLOWED_TYPES, PatrolObjectStore } from './patrol-object-store';

const EXTENSION: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp' };

/**
 * Patrol photo evidence over the API (Patrols P1-C).
 *
 * GUARD (their own run only — anyone else's run or photo is 404, exactly like one that does not exist):
 *   POST /patrols/runs/:id/evidence        an upload intent: declared type (JPEG / PNG / HEIC / WebP), size (≤ cap) and
 *                                          SHA-256; idempotent on clientEvidenceId; returns a presigned PUT (60–300 s) to a
 *                                          key the server chose. Allowed during the shift and inside the post-shift sync
 *                                          acceptance window (P1-B, default 24 h after Book Off); after it, a new photo —
 *                                          or a new URL for one not yet uploaded — is 409 PATROL_SYNC_WINDOW_CLOSED.
 *   POST /patrols/evidence/:id/complete    the server verifies what arrived (PatrolEvidenceLifecycleService.complete).
 *                                          A photo whose URL was issued inside the window can be completed after it: the
 *                                          bytes reached storage while the URL was valid. Repeats return the settled result.
 *   Guards cannot download photos from the server (they hold the original on the device).
 *
 * COMPANY (resolveCompanyContext via PatrolAccessService; another company's id is 404):
 *   GET  /patrols/evidence/:id/download?purpose=   patrols.evidence: a presigned GET (60–300 s), every issue audited
 *                                                  (who, which photo, why) — the URL itself is never logged or audited
 *   POST /patrols/evidence/:id/delete              patrols.holds (Owner / Admin): through the deletion state machine
 *   POST /patrols/evidence/:id/restore             patrols.holds: from quarantine, until the purge
 *   POST /patrols/holds, POST /patrols/holds/:id/release (GET /patrols/holds?status=active|all is PatrolQueryService)   patrols.holds
 *   GET  /patrols/storage-usage                    patrols.holds: live metering per site, exports, totals
 * Every evidence route answers 503 PATROL_EVIDENCE_STORAGE_UNAVAILABLE when storage is not configured (after the caller's
 * own authorisation, so it reveals nothing to anyone else).
 */
@Injectable()
export class PatrolEvidenceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: PatrolAccessService,
    private readonly config: PatrolConfigService,
    private readonly store: PatrolObjectStore,
    private readonly lifecycle: PatrolEvidenceLifecycleService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ═══════════════════════ Guard ═══════════════════════

  async requestUpload(user: JwtPayload, runId: number, dto: RequestPatrolEvidenceUploadDto, now: Date = new Date()) {
    const actor = await this.access.guardActor(user);
    const run = await this.ownRun(actor, runId);
    this.access.rejectLocation(dto);
    if (!(PATROL_EVIDENCE_ALLOWED_TYPES as readonly string[]).includes(dto.contentType)) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.EVIDENCE_TYPE_NOT_ALLOWED, 'Only JPEG, PNG, HEIC or WebP photos can be uploaded.', {
        allowed: PATROL_EVIDENCE_ALLOWED_TYPES,
      });
    }
    const storage = this.store.config(); // 503 when storage is unavailable
    if (dto.sizeBytes > storage.maxObjectBytes) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.EVIDENCE_TOO_LARGE, `A patrol photo can be at most ${storage.maxObjectBytes} bytes.`, {
        maxBytes: storage.maxObjectBytes,
      });
    }
    const companyId = Number(run.companyId);
    const capturedAtDevice = new Date(dto.capturedAtDevice);
    const existing = await this.findByClientId(companyId, dto.clientEvidenceId);
    if (existing) return this.replayIntent(existing, run, actor, dto, capturedAtDevice, now);

    if (dto.kind === 'checkpoint_photo') {
      if (!dto.visitId) throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'A checkpoint photo needs the visitId of its scan.');
      const [visit] = await this.dataSource.query(`SELECT "id" FROM "patrol_checkpoint_visits" WHERE "id" = $1 AND "runId" = $2 AND "companyId" = $3`, [dto.visitId, runId, companyId]);
      if (!visit) throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'visitId is not a scan of this patrol.');
    } else if (dto.visitId) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'A run photo has no visitId.');
    }
    const flags: string[] = [];
    if (run.shiftStatus !== 'in_progress') {
      await this.assertWithinSyncWindow(run, now);
      flags.push('synced_after_book_off');
    }
    const driftMs = clockDriftMs(now, dto.sentAtDevice ? new Date(dto.sentAtDevice) : null);
    let needsReview = false;
    if (driftMs !== null) {
      const policy = await this.config.effectivePolicy(companyId, Number(run.siteId));
      if (isClockDriftSuspect(driftMs, policy.clockDriftThresholdMinutes)) {
        flags.push('clock_drift_suspect');
        needsReview = true;
      }
    }
    const [{ n }] = await this.dataSource.query(`SELECT count(*)::int AS n FROM "patrol_evidence" WHERE "runId" = $1`, [runId]);
    if (Number(n) >= PATROL_EVIDENCE_MAX_PER_RUN) {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EVIDENCE_LIMIT_REACHED, `A patrol can carry at most ${PATROL_EVIDENCE_MAX_PER_RUN} photos.`);
    }
    const storageKey = patrolObjectKey('evidence', companyId, now, storage.prefix);
    const [inserted] = await this.dataSource.query(
      `INSERT INTO "patrol_evidence" ("companyId", "siteId", "runId", "visitId", "guardId", "shiftId", "kind", "storageKey", "mimeType",
          "declaredSizeBytes", "sha256Client", "capturedAtDevice", "clientEvidenceId", "uploadUrlIssuedAt", "syncFlags", "needsReview")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)
       ON CONFLICT ("companyId", "clientEvidenceId") DO NOTHING RETURNING *`,
      [companyId, run.siteId, runId, dto.visitId ?? null, actor.guardId, run.shiftId, dto.kind, storageKey, dto.contentType, dto.sizeBytes,
        dto.sha256, capturedAtDevice, dto.clientEvidenceId, now, JSON.stringify(flags), needsReview],
    );
    if (!inserted) {
      const winner = await this.findByClientId(companyId, dto.clientEvidenceId);
      return this.replayIntent(winner, run, actor, dto, capturedAtDevice, now);
    }
    await this.auditLogService.log({
      company: { id: companyId },
      user: { id: actor.userId },
      action: 'patrol.evidence_upload_requested',
      entityType: 'patrol_evidence',
      entityId: Number(inserted.id),
      afterData: {
        runId, kind: dto.kind, visitId: dto.visitId ?? null, contentType: dto.contentType, declaredSizeBytes: dto.sizeBytes, sha256: dto.sha256,
        capturedAtDevice: capturedAtDevice.toISOString(), syncFlags: flags, clockDriftMs: driftMs,
      },
    });
    return { evidence: serializeEvidenceMetadata(inserted), upload: this.uploadAccess(inserted, now) };
  }

  private uploadAccess(row: any, now: Date) {
    return this.store.presignUpload(siblingKey(row.storageKey, 'incoming'), {
      contentType: row.mimeType, sizeBytes: Number(row.declaredSizeBytes), sha256Hex: row.sha256Client, now,
    });
  }

  private async replayIntent(row: any, run: any, actor: PatrolGuardActor, dto: RequestPatrolEvidenceUploadDto, capturedAtDevice: Date, now: Date) {
    const same = row
      && Number(row.guardId) === actor.guardId
      && Number(row.runId) === Number(run.id)
      && row.kind === dto.kind
      && (row.visitId == null ? null : Number(row.visitId)) === (dto.visitId ?? null)
      && row.mimeType === dto.contentType
      && Number(row.declaredSizeBytes) === dto.sizeBytes
      && row.sha256Client === dto.sha256
      && new Date(row.capturedAtDevice).getTime() === capturedAtDevice.getTime();
    if (!same) {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.IDEMPOTENCY_CONFLICT,
        'This clientEvidenceId was already used for a different photo. Generate a new id for a new photo.');
    }
    if (!['pending', 'uploaded'].includes(row.uploadStatus)) return { evidence: serializeEvidenceMetadata(row), upload: null };
    // A fresh upload URL is a new acceptance: only during the shift or inside the post-shift window.
    if (run.shiftStatus !== 'in_progress') await this.assertWithinSyncWindow(run, now);
    const [updated] = await updateRows(this.dataSource,
      `UPDATE "patrol_evidence" SET "uploadUrlIssuedAt" = $2, "updatedAt" = now() WHERE "id" = $1 AND "uploadStatus" IN ('pending', 'uploaded') RETURNING *`,
      [row.id, now],
    );
    const current = updated ?? (await this.lifecycle.row(Number(row.id)));
    return { evidence: serializeEvidenceMetadata(current), upload: updated ? this.uploadAccess(updated, now) : null };
  }

  async completeUpload(user: JwtPayload, evidenceId: number, now: Date = new Date()) {
    const actor = await this.access.guardActor(user);
    const [row] = await this.dataSource.query(
      `SELECT e.*, c."patrolsEnabled" FROM "patrol_evidence" e JOIN "companies" c ON c."id" = e."companyId" WHERE e."id" = $1`,
      [evidenceId],
    );
    if (!row || Number(row.guardId) !== actor.guardId) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Photo not found.');
    if (row.patrolsEnabled !== true) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_ENABLED, 'Patrol Management is not available for this company.');
    if (!['pending', 'uploaded'].includes(row.uploadStatus)) return serializeEvidenceMetadata(row);
    if (!row.uploadUrlIssuedAt) throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EVIDENCE_NOT_UPLOADED, 'Request an upload first.');
    const result = await this.lifecycle.complete(evidenceId, { userId: actor.userId, via: 'guard', now, waitMs: 10_000 });
    if (result.outcome === 'not_uploaded') {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EVIDENCE_NOT_UPLOADED, 'The photo has not reached storage yet. Upload it, then complete again.');
    }
    if (result.outcome === 'in_progress') {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EVIDENCE_COMPLETION_IN_PROGRESS, 'This photo is still being verified. Try again shortly.');
    }
    return serializeEvidenceMetadata(result.row);
  }

  /** The Guard's own run (anyone else's is 404), with its shift and the company switch on. */
  private async ownRun(actor: PatrolGuardActor, runId: number) {
    const [run] = await this.dataSource.query(
      `SELECT r.*, s."status" AS "shiftStatus", s."end" AS "shiftEnd", c."patrolsEnabled" FROM "patrol_runs" r
         JOIN "shifts" s ON s."id" = r."shiftId" JOIN "companies" c ON c."id" = r."companyId"
        WHERE r."id" = $1`,
      [runId],
    );
    if (!run || Number(run.guardId) !== actor.guardId) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Patrol not found.');
    if (run.patrolsEnabled !== true) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_ENABLED, 'Patrol Management is not available for this company.');
    return run;
  }

  /** P1-B's post-shift sync acceptance window applies to photos exactly as to scans and completions. */
  private async assertWithinSyncWindow(run: any, now: Date) {
    if (run.shiftStatus !== 'completed') {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.SHIFT_NOT_IN_PROGRESS, 'Patrols can only be recorded during your shift, after Book On.', {
        shiftStatus: run.shiftStatus,
      });
    }
    const policy = await this.config.effectivePolicy(Number(run.companyId), Number(run.siteId));
    const rows = await this.dataSource.query(
      `SELECT "id", "type"::text AS "type", "occurredAt", "recordedAt", "correctionOfEventId", "source" FROM "attendance_events"
        WHERE "shiftId" = $1 AND "guardId" = $2`,
      [run.shiftId, run.guardId],
    );
    const { bookOffAt } = effectiveAttendance(rows);
    const shiftEnd = new Date(run.shiftEnd);
    if (!withinSyncAcceptance(now, bookOffAt, shiftEnd, policy.postShiftSyncHours)) {
      const endsAt = syncAcceptanceEndsAt(bookOffAt, shiftEnd, policy.postShiftSyncHours);
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.SYNC_WINDOW_CLOSED,
        `Patrol data for this shift could only be sent until ${endsAt.toISOString()} (${policy.postShiftSyncHours} h after it ended).`,
        { acceptanceEndsAt: endsAt.toISOString() });
    }
  }

  private async findByClientId(companyId: number, clientEvidenceId: string) {
    const [row] = await this.dataSource.query(`SELECT * FROM "patrol_evidence" WHERE "companyId" = $1 AND "clientEvidenceId" = $2`, [companyId, clientEvidenceId]);
    return row ?? null;
  }

  // ═══════════════════════ Company ═══════════════════════

  private async companyEvidence(companyId: number, id: number) {
    const [row] = await this.dataSource.query(`SELECT * FROM "patrol_evidence" WHERE "id" = $1 AND "companyId" = $2`, [id, companyId]);
    if (!row) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Photo not found.');
    return row;
  }

  async download(user: JwtPayload, id: number, purpose: string, now: Date = new Date()) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_EVIDENCE);
    const row = await this.companyEvidence(actor.companyId, id);
    if (row.uploadStatus !== 'verified' || !['active', 'claimed'].includes(row.retentionStatus)) {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EVIDENCE_NOT_AVAILABLE, 'This photo is not available to view.', {
        uploadStatus: row.uploadStatus, retentionStatus: row.retentionStatus,
      });
    }
    const mime = row.detectedMimeType ?? row.mimeType;
    const access = this.store.presignDownload(row.storageKey, { contentType: mime, fileName: `patrol-evidence-${row.id}.${EXTENSION[mime] ?? 'img'}`, now });
    const ttlSeconds = Math.round((new Date(access.expiresAt).getTime() - now.getTime()) / 1000);
    await this.auditLogService.log({
      company: { id: actor.companyId },
      user: { id: actor.userId },
      action: 'patrol.evidence_accessed',
      entityType: 'patrol_evidence',
      entityId: Number(row.id),
      afterData: { runId: Number(row.runId), siteId: Number(row.siteId), purpose, ttlSeconds, linkExpiresAt: access.expiresAt, sha256: row.sha256Stored },
    });
    return { evidenceId: Number(row.id), method: access.method, url: access.url, expiresAt: access.expiresAt };
  }

  async requestDeletion(user: JwtPayload, id: number, reason: string) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_HOLDS);
    await this.companyEvidence(actor.companyId, id);
    this.store.config();
    return serializeEvidenceMetadata(await this.lifecycle.requestDeletion(actor.companyId, id, actor.userId, reason.trim()));
  }

  async restore(user: JwtPayload, id: number, reason: string) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_HOLDS);
    await this.companyEvidence(actor.companyId, id);
    this.store.config();
    return serializeEvidenceMetadata(await this.lifecycle.restore(actor.companyId, id, actor.userId, reason.trim()));
  }

  // ── Holds ──

  async placeHold(user: JwtPayload, dto: CreatePatrolEvidenceHoldDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_HOLDS);
    const companyId = actor.companyId;
    const target = { evidenceId: dto.evidenceId ?? null, runId: dto.runId ?? null, shiftId: dto.shiftId ?? null, siteId: dto.siteId ?? null,
      fromDate: dto.fromDate ?? null, toDate: dto.toDate ?? null };
    const allowed: Record<string, Array<keyof typeof target>> = {
      evidence: ['evidenceId'], run: ['runId'], shift: ['shiftId'], site_date_range: ['siteId', 'fromDate', 'toDate'],
    };
    const fields = allowed[dto.scope];
    const stray = (Object.keys(target) as Array<keyof typeof target>).filter((k) => target[k] !== null && !fields.includes(k));
    const missing = fields.filter((k) => target[k] === null);
    if (stray.length || missing.length) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, `A ${dto.scope} hold takes exactly: ${fields.join(', ')}.`, { stray, missing });
    }
    if (dto.scope === 'site_date_range' && target.toDate! < target.fromDate!) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'toDate is before fromDate.');
    }
    // Every referenced record must be this company's: another company's id is indistinguishable from one that does not exist.
    const owned: Array<[number | null, string]> = [
      [target.evidenceId, `SELECT 1 FROM "patrol_evidence" WHERE "id" = $1 AND "companyId" = $2`],
      [target.runId, `SELECT 1 FROM "patrol_runs" WHERE "id" = $1 AND "companyId" = $2`],
      [target.shiftId, `SELECT 1 FROM "shifts" WHERE "id" = $1 AND "companyId" = $2`],
      [target.siteId, `SELECT 1 FROM "sites" WHERE "id" = $1 AND "companyId" = $2`],
      [dto.incidentId ?? null, `SELECT 1 FROM "incidents" WHERE "id" = $1 AND "companyId" = $2`],
      [dto.safetyAlertId ?? null, `SELECT 1 FROM "safety_alerts" WHERE "id" = $1 AND "companyId" = $2`],
      [dto.exceptionId ?? null, `SELECT 1 FROM "patrol_exceptions" WHERE "id" = $1 AND "companyId" = $2`],
    ];
    for (const [id, sql] of owned) {
      if (id !== null && !(await this.dataSource.query(sql, [id, companyId])).length) {
        throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Not found.');
      }
    }
    return this.dataSource.transaction(async (manager) => {
      const [hold] = await manager.query(
        `INSERT INTO "patrol_evidence_holds" ("companyId", "scope", "evidenceId", "runId", "shiftId", "siteId", "fromDate", "toDate", "reason", "source",
            "incidentId", "safetyAlertId", "exceptionId", "createdByUserId")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', $10, $11, $12, $13) RETURNING *`,
        [companyId, dto.scope, target.evidenceId, target.runId, target.shiftId, target.siteId, target.fromDate, target.toDate, dto.reason.trim(),
          dto.incidentId ?? null, dto.safetyAlertId ?? null, dto.exceptionId ?? null, actor.userId],
      );
      await this.auditLogService.logInTransaction(manager, {
        company: { id: companyId },
        user: { id: actor.userId },
        action: 'patrol.evidence_hold_placed',
        entityType: 'patrol_evidence_hold',
        entityId: Number(hold.id),
        afterData: { scope: dto.scope, ...target, reason: dto.reason.trim(), incidentId: dto.incidentId ?? null, safetyAlertId: dto.safetyAlertId ?? null,
          exceptionId: dto.exceptionId ?? null },
      });
      // A deletion already claimed but not yet moved is cancelled: held evidence never leaves active.
      const cancelled = await updateRows(manager,
        `UPDATE "patrol_evidence" e SET "retentionStatus" = 'active', "claimToken" = NULL, "claimedAt" = NULL, "deletionReason" = NULL,
            "deletionRequestedByUserId" = NULL, "updatedAt" = now()
          WHERE e."companyId" = $1 AND e."retentionStatus" = 'claimed' AND ${heldSql('e')} RETURNING e."id"`,
        [companyId],
      );
      for (const { id } of cancelled) {
        await this.auditLogService.logInTransaction(manager, {
          company: { id: companyId },
          user: { id: actor.userId },
          action: 'patrol.evidence_deletion_cancelled',
          entityType: 'patrol_evidence',
          entityId: Number(id),
          beforeData: { retentionStatus: 'claimed' },
          afterData: { retentionStatus: 'active', because: 'hold', holdId: Number(hold.id) },
        });
      }
      return serializeHold(hold);
    });
  }

  async releaseHold(user: JwtPayload, id: number, reason: string) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_HOLDS);
    return this.dataSource.transaction(async (manager) => {
      const [hold] = await manager.query(`SELECT * FROM "patrol_evidence_holds" WHERE "id" = $1 AND "companyId" = $2 FOR UPDATE`, [id, actor.companyId]);
      if (!hold) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Hold not found.');
      if (hold.releasedAt) throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.HOLD_RELEASED, 'This hold was already released.');
      const [released] = await updateRows(manager,
        `UPDATE "patrol_evidence_holds" SET "releasedAt" = now(), "releasedByUserId" = $2, "releaseReason" = $3 WHERE "id" = $1 AND "releasedAt" IS NULL RETURNING *`,
        [id, actor.userId, reason.trim()],
      );
      await this.auditLogService.logInTransaction(manager, {
        company: { id: actor.companyId },
        user: { id: actor.userId },
        action: 'patrol.evidence_hold_released',
        entityType: 'patrol_evidence_hold',
        entityId: id,
        beforeData: { releasedAt: null },
        afterData: { scope: hold.scope, releasedAt: new Date(released.releasedAt).toISOString(), reason: reason.trim() },
      });
      return serializeHold(released);
    });
  }

  // ── Metering ──

  async usage(user: JwtPayload) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_HOLDS);
    const rows = await this.dataSource.query(
      `SELECT u.*, s."name" AS "siteName" FROM "patrol_storage_usage" u LEFT JOIN "sites" s ON s."id" = u."siteId"
        WHERE u."companyId" = $1 ORDER BY u."siteId" NULLS LAST`,
      [actor.companyId],
    );
    const sites = rows.filter((r: any) => r.siteId != null).map((r: any) => ({
      siteId: Number(r.siteId), siteName: r.siteName, activeObjects: Number(r.activeObjects), activeBytes: Number(r.activeBytes),
      quarantinedObjects: Number(r.quarantinedObjects), quarantinedBytes: Number(r.quarantinedBytes), updatedAt: new Date(r.updatedAt).toISOString(),
    }));
    const company = rows.find((r: any) => r.siteId == null);
    const exports = { objects: Number(company?.exportObjects ?? 0), bytes: Number(company?.exportBytes ?? 0) };
    const sum = (k: string) => sites.reduce((a: number, s: any) => a + s[k], 0);
    return {
      sites,
      exports,
      totals: {
        objects: sum('activeObjects') + sum('quarantinedObjects') + exports.objects,
        bytes: sum('activeBytes') + sum('quarantinedBytes') + exports.bytes,
        activeObjects: sum('activeObjects'), activeBytes: sum('activeBytes'),
        quarantinedObjects: sum('quarantinedObjects'), quarantinedBytes: sum('quarantinedBytes'),
      },
      retentionMode: patrolRetentionMode(),
      storageConfigured: this.store.available(),
    };
  }
}
