import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { PatrolConfigService } from '../patrol-config.service';
import { PatrolErrorCode, patrolError } from '../patrol-constants';
import { PatrolExceptionService } from '../patrol-exception.service';
import { photoExpiresAt } from '../patrol-retention';
import { updateRows } from '../patrol-serializers';
import { freshKeyLike, keyBelongsTo, siblingKey } from './patrol-evidence-keys';
import {
  PATROL_EVIDENCE_COMPLETION_LEASE_MS,
  PATROL_EVIDENCE_QUARANTINE_DAYS,
  PATROL_EVIDENCE_RESTORE_GRACE_DAYS,
  adjustUsage,
  heldSql,
  safeError,
} from './patrol-evidence-shared';
import { ImageInspector, InspectionResult } from './patrol-image-inspector';
import { PatrolObjectStore, PatrolStorageError } from './patrol-object-store';

const DAY = 86_400_000;
/** The order in which a rejection reason is reported when several apply. */
const REJECTION_ORDER = [
  'hash_mismatch', 'size_mismatch', 'too_large', 'not_an_image', 'content_type_mismatch', 'trailing_data', 'truncated',
  'embedded_markup', 'too_small', 'invalid_dimensions',
] as const;

export type CompletionOutcome = 'verified' | 'rejected' | 'already_final' | 'not_uploaded' | 'in_progress';

/**
 * The patrol photo evidence state machine (Patrols P1-C). Everything that changes an evidence row's upload or retention
 * state goes through here, so the rules hold whoever asks (the Guard, an Owner / Admin, or the maintenance job).
 *
 * UPLOAD / VERIFICATION (uploadStatus)
 *   pending ──(object found in storage)──▶ uploaded ──▶ verified | rejected
 *   One verifier at a time (a completion lease, completionToken / completionStartedAt). The Guard's presigned PUT lands
 *   in patrol-incoming/; the verifier COPIES it to a fresh key in patrol/ that only the server can write, then streams
 *   THAT copy through ImageInspector (SHA-256, size, signature, structure, markup). So the bytes hashed are exactly the
 *   bytes kept, and a still-valid upload URL can never change a verified photo. Verified: storageKey points at the copy,
 *   retention starts (30 / 90 days from cloud receipt, the site's policy), live usage +1. Rejected (hash or size mismatch,
 *   not an image, wrong type, polyglot, …): the bytes are QUARANTINED (kept, recoverable for review, then purged), never
 *   silently accepted and never silently dropped. Repeating a completion returns the settled result.
 *
 * RETENTION / DELETION (retentionStatus)
 *   active ──claim──▶ claimed ──move──▶ quarantined ──purge──▶ purged ──object removed──▶ tombstone
 *      ▲                 │                   │
 *      └───── restore ───┴───────────────────┘   (restore: Owner / Admin, until the purge)
 *   - claim       DB first: a retention expiry (maintenance, enforce mode) or a manual Owner / Admin deletion. An active
 *                 hold prevents it (and placing a hold cancels a claim): held evidence never leaves active.
 *   - move        copy to a quarantine key unique to the claim, verify the copy, commit "quarantined" (only if still
 *                 claimed by the same claim), and only THEN remove the primary object. A move that lost a race removes
 *                 only its own copy.
 *   - purge       commit "purged" first (never while held), then remove the objects, then commit "tombstone". A storage
 *                 failure leaves the row purged and is retried on the next pass; the row always records what was deleted
 *                 (SHA-256, size, receipt / verification / quarantine / purge times) — it is never deleted.
 *   - restore     copies the quarantined bytes to a NEW primary key, re-hashes them against sha256Stored, commits
 *                 "active" (only if still quarantined), then removes the quarantine copy. A fresh key means no stale
 *                 deletion can ever touch the restored object.
 * Every transition is audited and moves the live usage counters in the same transaction.
 */
@Injectable()
export class PatrolEvidenceLifecycleService {
  private readonly logger = new Logger(PatrolEvidenceLifecycleService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly store: PatrolObjectStore,
    private readonly auditLogService: AuditLogService,
    private readonly config: PatrolConfigService,
    private readonly exceptions: PatrolExceptionService,
  ) {}

  private audit(manager: EntityManager | null, input: { companyId: number; userId: number | null; action: string; entityId: number; beforeData?: Record<string, unknown>; afterData: Record<string, unknown> }) {
    const entry = {
      company: { id: input.companyId },
      user: input.userId ? { id: input.userId } : null,
      action: input.action,
      entityType: 'patrol_evidence',
      entityId: input.entityId,
      beforeData: input.beforeData ?? null,
      afterData: input.afterData,
    };
    return manager ? this.auditLogService.logInTransaction(manager, entry) : this.auditLogService.log(entry);
  }

  async row(id: number): Promise<any> {
    const [row] = await this.dataSource.query(`SELECT * FROM "patrol_evidence" WHERE "id" = $1`, [id]);
    return row ?? null;
  }

  async isHeld(id: number, runner: { query: EntityManager['query'] } = this.dataSource): Promise<boolean> {
    const [row] = await runner.query(`SELECT ${heldSql('e')} AS "held" FROM "patrol_evidence" e WHERE e."id" = $1`, [id]);
    return row?.held === true;
  }

  // ══════════════════════════ Upload completion ══════════════════════════

  /**
   * Verifies the uploaded object of a pending photo. Idempotent: a settled photo returns its result. `wait` lets a caller
   * (the Guard's completion request) wait briefly for a concurrent verification of the same photo instead of failing.
   */
  async complete(id: number, opts: { userId: number | null; via: 'guard' | 'maintenance'; now?: Date; waitMs?: number }): Promise<{ outcome: CompletionOutcome; row: any }> {
    const now = opts.now ?? new Date();
    let row = await this.row(id);
    if (!row) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Photo not found.');
    if (!['pending', 'uploaded'].includes(row.uploadStatus)) return { outcome: 'already_final', row };
    const config = this.store.config(); // 503 when storage is unavailable
    const token = randomUUID();
    const [leased] = await updateRows(this.dataSource,
      `UPDATE "patrol_evidence" SET "completionToken" = $2, "completionStartedAt" = $3
        WHERE "id" = $1 AND "uploadStatus" IN ('pending', 'uploaded')
          AND ("completionToken" IS NULL OR "completionStartedAt" < $4)
        RETURNING *`,
      [id, token, now, new Date(now.getTime() - PATROL_EVIDENCE_COMPLETION_LEASE_MS)],
    );
    if (!leased) {
      const deadline = Date.now() + (opts.waitMs ?? 0);
      for (;;) {
        row = await this.row(id);
        if (!['pending', 'uploaded'].includes(row.uploadStatus)) return { outcome: 'already_final', row };
        if (Date.now() >= deadline) return { outcome: 'in_progress', row };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    row = leased;
    const companyId = Number(row.companyId);
    const release = () => this.dataSource.query(
      `UPDATE "patrol_evidence" SET "completionToken" = NULL, "completionStartedAt" = NULL WHERE "id" = $1 AND "completionToken" = $2`, [id, token]);
    if (!keyBelongsTo(row.storageKey, companyId)) {
      await release();
      throw new Error(`patrol evidence ${id} has a key outside its company`);
    }
    const incomingKey = siblingKey(row.storageKey, 'incoming');
    const attemptKey = freshKeyLike(row.storageKey, 'evidence', token);
    const quarantineKey = freshKeyLike(row.storageKey, 'quarantine', token);
    // Everything before the commit only ever writes this attempt's own keys (attemptKey, quarantineKey — unique to the
    // lease), so a failure here removes exactly those and nothing a committed record points at.
    let decision: { inspection: InspectionResult | null; rejection: string | null; reasons: string[]; observedSize: number };
    try {
      const incoming = await this.store.head(incomingKey);
      if (!incoming.exists) {
        await release();
        return { outcome: 'not_uploaded', row: await this.row(id) };
      }
      const [marked] = await updateRows(this.dataSource,
        `UPDATE "patrol_evidence" SET "uploadStatus" = 'uploaded', "receivedAt" = COALESCE("receivedAt", $3), "updatedAt" = now()
          WHERE "id" = $1 AND "completionToken" = $2 AND "uploadStatus" IN ('pending', 'uploaded') RETURNING *`,
        [id, token, now],
      );
      if (!marked) return { outcome: 'already_final', row: await this.row(id) };
      row = marked;

      if (incoming.size > config.maxObjectBytes) {
        // Not read at all: quarantined as it is (server-side copy).
        decision = { inspection: null, rejection: 'too_large', reasons: ['too_large'], observedSize: incoming.size };
        await this.copyVerified(incomingKey, quarantineKey, incoming.size);
      } else {
        await this.store.copy(incomingKey, attemptKey);
        const inspection = await this.inspect(attemptKey, row.mimeType);
        const reasons = [
          ...(inspection.sha256 !== row.sha256Client ? ['hash_mismatch'] : []),
          ...(row.declaredSizeBytes != null && Number(row.declaredSizeBytes) !== inspection.size ? ['size_mismatch'] : []),
          ...(inspection.size > config.maxObjectBytes ? ['too_large'] : []),
          ...inspection.problems,
        ];
        const rejection = REJECTION_ORDER.find((r) => reasons.includes(r)) ?? null;
        decision = { inspection, rejection, reasons, observedSize: inspection.size };
        if (rejection) await this.copyVerified(attemptKey, quarantineKey, inspection.size);
      }
    } catch (error) {
      await release().catch(() => undefined);
      await this.store.delete(attemptKey).catch(() => undefined);
      await this.store.delete(quarantineKey).catch(() => undefined);
      if (error instanceof HttpException) throw error;
      // A storage failure, or a stream cut mid-read: nothing was committed, the photo stays pending, the client retries.
      this.logger.warn(JSON.stringify({ event: 'patrol_evidence_completion_storage_error', evidenceId: id, error: safeError(error) }));
      throw patrolError(HttpStatus.SERVICE_UNAVAILABLE, PatrolErrorCode.EVIDENCE_STORAGE_UNAVAILABLE,
        'Patrol photo storage could not be reached. Try again shortly; the photo stays on the device until it is confirmed.');
    }

    if (!decision.rejection && decision.inspection) return this.commitVerified(row, token, attemptKey, incomingKey, quarantineKey, decision.inspection, opts, now);
    return this.commitRejected(row, token, attemptKey, incomingKey, quarantineKey, decision.observedSize, decision.inspection, decision.rejection!, decision.reasons, opts, now);
  }

  /** Copy, then confirm the copy exists with the expected size. */
  private async copyVerified(source: string, target: string, size: number) {
    await this.store.copy(source, target);
    const copied = await this.store.head(target);
    if (!copied.exists || copied.size !== size) throw new PatrolStorageError('copy', null, 'copy_unverified');
  }

  private async inspect(key: string, declaredMime: string): Promise<InspectionResult> {
    const inspector = new ImageInspector();
    const stream = await this.store.getStream(key);
    for await (const chunk of stream) inspector.update(chunk as Buffer);
    return inspector.finish(declaredMime);
  }


  private async commitVerified(row: any, token: string, attemptKey: string, incomingKey: string, quarantineKey: string, inspection: InspectionResult,
    opts: { userId: number | null; via: string }, now: Date): Promise<{ outcome: CompletionOutcome; row: any }> {
    const companyId = Number(row.companyId);
    const siteId = Number(row.siteId);
    const runId = Number(row.runId);
    const receivedAt = row.receivedAt ? new Date(row.receivedAt) : now;
    let updated: any = null;
    try {
      const policy = await this.config.effectivePolicy(companyId, siteId);
      const retentionDays = Number(policy.retentionDays) === 90 ? 90 : 30;
      const expiresAt = photoExpiresAt(receivedAt, retentionDays);
      updated = await this.dataSource.transaction(async (manager) => {
        const [done] = await updateRows(manager,
          `UPDATE "patrol_evidence" SET "uploadStatus" = 'verified', "storageKey" = $3, "sizeBytes" = $4, "sha256Stored" = $5,
              "detectedMimeType" = $6, "widthPx" = $7, "heightPx" = $8, "verifiedAt" = $9, "retentionDays" = $10, "expiresAt" = $11,
              "rejectionReason" = NULL, "completionToken" = NULL, "completionStartedAt" = NULL, "updatedAt" = now()
            WHERE "id" = $1 AND "completionToken" = $2 AND "uploadStatus" = 'uploaded' RETURNING *`,
          [row.id, token, attemptKey, inspection.size, inspection.sha256, inspection.detectedMime, inspection.width, inspection.height, now,
            retentionDays, expiresAt],
        );
        if (!done) return null;
        await adjustUsage(manager, companyId, siteId, { activeObjects: 1, activeBytes: inspection.size });
        await this.audit(manager, {
          companyId, userId: opts.userId, action: 'patrol.evidence_verified', entityId: Number(row.id),
          beforeData: { uploadStatus: 'uploaded' },
          afterData: {
            uploadStatus: 'verified', runId, kind: row.kind, sizeBytes: inspection.size, sha256: inspection.sha256,
            detectedMimeType: inspection.detectedMime, receivedAt: receivedAt.toISOString(), retentionDays, expiresAt: expiresAt.toISOString(),
            syncFlags: row.syncFlags ?? [], via: opts.via,
          },
        });
        // Evidence reaching the server after its run's "evidence missing" exception annotates that exception and downgrades
        // its alert, exactly as P1-B's late scans do — in this same transaction. Nothing is ever closed automatically.
        const late = await this.exceptions.recordLateEvidence(manager, {
          companyId, runId, kind: 'photo_after_alert', match: { runId, types: ['evidence_unverified'] },
          deviceTime: row.capturedAtDevice ? new Date(row.capturedAtDevice) : null, now, userId: opts.userId,
        });
        if (late > 0) {
          const addFlag = `(SELECT COALESCE(jsonb_agg(DISTINCT f), '[]'::jsonb) FROM jsonb_array_elements("syncFlags" || '["evidence_after_alert"]'::jsonb) AS f)`;
          await manager.query(`UPDATE "patrol_evidence" SET "syncFlags" = ${addFlag}, "updatedAt" = now() WHERE "id" = $1`, [row.id]);
          await manager.query(`UPDATE "patrol_runs" SET "syncedLate" = true, "syncFlags" = ${addFlag}, "updatedAt" = now() WHERE "id" = $1`, [runId]);
        }
        return done;
      });
    } catch (error) {
      // Nothing committed: release the lease and remove only this attempt's copies.
      await this.dataSource.query(`UPDATE "patrol_evidence" SET "completionToken" = NULL, "completionStartedAt" = NULL WHERE "id" = $1 AND "completionToken" = $2`, [row.id, token]).catch(() => undefined);
      await this.store.delete(attemptKey).catch(() => undefined);
      throw error;
    }
    if (!updated) {
      // Another verifier settled it (this one's lease had expired): drop this attempt's copies only.
      await this.store.delete(attemptKey).catch(() => undefined);
      await this.store.delete(quarantineKey).catch(() => undefined);
      return { outcome: 'already_final', row: await this.row(Number(row.id)) };
    }
    // Committed. From here only the transient incoming object is removed (best effort; a bucket lifecycle rule backs it up).
    await this.store.delete(incomingKey).catch(() => undefined);
    return { outcome: 'verified', row: await this.row(Number(row.id)) };
  }

  private async commitRejected(row: any, token: string, attemptKey: string, incomingKey: string, quarantineKey: string, observedSize: number,
    inspection: InspectionResult | null, rejection: string, reasons: string[], opts: { userId: number | null; via: string }, now: Date,
  ): Promise<{ outcome: CompletionOutcome; row: any }> {
    const companyId = Number(row.companyId);
    const siteId = Number(row.siteId);
    const size = inspection?.size ?? observedSize;
    const purgeAfter = new Date(now.getTime() + PATROL_EVIDENCE_QUARANTINE_DAYS * DAY);
    let updated: any = null;
    try {
      updated = await this.dataSource.transaction(async (manager) => {
        const [done] = await updateRows(manager,
          `UPDATE "patrol_evidence" SET "uploadStatus" = 'rejected', "rejectionReason" = $3, "sizeBytes" = $4, "sha256Stored" = $5,
              "detectedMimeType" = $6, "widthPx" = $7, "heightPx" = $8, "retentionStatus" = 'quarantined', "quarantineKey" = $9,
              "quarantinedAt" = $10, "purgeAfter" = $11, "deletionReason" = 'rejected_upload', "needsReview" = true,
              "completionToken" = NULL, "completionStartedAt" = NULL, "updatedAt" = now()
            WHERE "id" = $1 AND "completionToken" = $2 AND "uploadStatus" = 'uploaded' AND "retentionStatus" = 'active' RETURNING *`,
          [row.id, token, rejection, size, inspection?.sha256 ?? null, inspection?.detectedMime ?? null, inspection?.width ?? null,
            inspection?.height ?? null, quarantineKey, now, purgeAfter],
        );
        if (!done) return null;
        await adjustUsage(manager, companyId, siteId, { quarantinedObjects: 1, quarantinedBytes: size });
        await this.audit(manager, {
          companyId, userId: opts.userId, action: 'patrol.evidence_rejected', entityId: Number(row.id),
          beforeData: { uploadStatus: 'uploaded' },
          afterData: {
            uploadStatus: 'rejected', retentionStatus: 'quarantined', rejectionReason: rejection, reasons, runId: Number(row.runId),
            declaredSha256: row.sha256Client, storedSha256: inspection?.sha256 ?? null,
            declaredSizeBytes: row.declaredSizeBytes == null ? null : Number(row.declaredSizeBytes),
            sizeBytes: size, declaredMimeType: row.mimeType, detectedMimeType: inspection?.detectedMime ?? null,
            purgeAfter: purgeAfter.toISOString(), via: opts.via,
          },
        });
        return done;
      });
    } catch (error) {
      await this.dataSource.query(`UPDATE "patrol_evidence" SET "completionToken" = NULL, "completionStartedAt" = NULL WHERE "id" = $1 AND "completionToken" = $2`, [row.id, token]).catch(() => undefined);
      await this.store.delete(attemptKey).catch(() => undefined);
      await this.store.delete(quarantineKey).catch(() => undefined);
      throw error;
    }
    if (!updated) {
      await this.store.delete(quarantineKey).catch(() => undefined);
      await this.store.delete(attemptKey).catch(() => undefined);
      return { outcome: 'already_final', row: await this.row(Number(row.id)) };
    }
    // The quarantined copy is verified and committed: the transient copies can go (never the quarantined one).
    await this.store.delete(attemptKey).catch(() => undefined);
    await this.store.delete(incomingKey).catch(() => undefined);
    await this.dataSource.query(`UPDATE "patrol_evidence" SET "primaryDeletedAt" = $2 WHERE "id" = $1 AND "primaryDeletedAt" IS NULL`, [row.id, now]).catch(() => undefined);
    return { outcome: 'rejected', row: await this.row(Number(row.id)) };
  }

  // ══════════════════════════ Deletion state machine ══════════════════════════

  /** Manual deletion (Owner / Admin): claim now (refused while held), then move to quarantine (retried later on failure). */
  async requestDeletion(companyId: number, id: number, userId: number, reason: string, now = new Date()) {
    const claimed = await this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query(`SELECT * FROM "patrol_evidence" WHERE "id" = $1 AND "companyId" = $2 FOR UPDATE`, [id, companyId]);
      if (!row) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Photo not found.');
      if (row.uploadStatus !== 'verified' || row.retentionStatus !== 'active') {
        throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EVIDENCE_NOT_AVAILABLE, 'Only a verified photo that has not been deleted can be deleted.', {
          uploadStatus: row.uploadStatus, retentionStatus: row.retentionStatus,
        });
      }
      if (await this.isHeld(id, manager)) {
        throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EVIDENCE_HELD, 'This photo is under an evidence hold and cannot be deleted.');
      }
      const [done] = await updateRows(manager,
        `UPDATE "patrol_evidence" SET "retentionStatus" = 'claimed', "claimToken" = gen_random_uuid(), "claimedAt" = $2, "deletionReason" = 'manual',
            "deletionRequestedByUserId" = $3, "updatedAt" = now()
          WHERE "id" = $1 AND "retentionStatus" = 'active' RETURNING *`,
        [id, now, userId],
      );
      await this.audit(manager, {
        companyId, userId, action: 'patrol.evidence_deletion_requested', entityId: id,
        beforeData: { retentionStatus: 'active' },
        afterData: { retentionStatus: 'claimed', deletionReason: 'manual', reason, runId: Number(row.runId), sha256: row.sha256Stored },
      });
      return done;
    });
    await this.moveToQuarantine(claimed, { userId, now }).catch((error) => {
      this.logger.warn(JSON.stringify({ event: 'patrol_evidence_quarantine_deferred', evidenceId: id, error: safeError(error) }));
    });
    return this.row(id);
  }

  /** claimed → quarantined. Safe to repeat and to race (see the class comment). */
  async moveToQuarantine(row: any, opts: { userId: number | null; now?: Date }): Promise<'quarantined' | 'cancelled_hold' | 'superseded'> {
    const now = opts.now ?? new Date();
    const id = Number(row.id);
    const companyId = Number(row.companyId);
    if (row.retentionStatus !== 'claimed' || !row.claimToken) return 'superseded';
    if (await this.isHeld(id)) {
      const cancelled = await this.dataSource.transaction(async (manager) => {
        const [done] = await updateRows(manager,
          `UPDATE "patrol_evidence" SET "retentionStatus" = 'active', "claimToken" = NULL, "claimedAt" = NULL, "deletionReason" = NULL,
              "deletionRequestedByUserId" = NULL, "updatedAt" = now()
            WHERE "id" = $1 AND "retentionStatus" = 'claimed' AND "claimToken" = $2 RETURNING "id"`,
          [id, row.claimToken],
        );
        if (done) {
          await this.audit(manager, {
            companyId, userId: opts.userId, action: 'patrol.evidence_deletion_cancelled', entityId: id,
            beforeData: { retentionStatus: 'claimed', deletionReason: row.deletionReason }, afterData: { retentionStatus: 'active', because: 'hold' },
          });
        }
        return Boolean(done);
      });
      return cancelled ? 'cancelled_hold' : 'superseded';
    }
    const quarantineKey = freshKeyLike(row.storageKey, 'quarantine', row.claimToken);
    try {
      const existing = await this.store.head(quarantineKey);
      if (!existing.exists) await this.store.copy(row.storageKey, quarantineKey);
      const copied = existing.exists ? existing : await this.store.head(quarantineKey);
      if (!copied.exists || copied.size !== Number(row.sizeBytes)) throw new PatrolStorageError('quarantine', null, 'copy_unverified');
    } catch (error) {
      await this.recordFailure(id, 'claimed', error);
      throw error;
    }
    const purgeAfter = new Date(now.getTime() + PATROL_EVIDENCE_QUARANTINE_DAYS * DAY);
    const moved = await this.dataSource.transaction(async (manager) => {
      const [done] = await updateRows(manager,
        `UPDATE "patrol_evidence" SET "retentionStatus" = 'quarantined', "quarantineKey" = $3, "quarantinedAt" = $4, "purgeAfter" = $5,
            "lastDeletionError" = NULL, "updatedAt" = now()
          WHERE "id" = $1 AND "retentionStatus" = 'claimed' AND "claimToken" = $2 RETURNING *`,
        [id, row.claimToken, quarantineKey, now, purgeAfter],
      );
      if (!done) return null;
      const size = Number(row.sizeBytes);
      await adjustUsage(manager, companyId, Number(row.siteId), { activeObjects: -1, activeBytes: -size, quarantinedObjects: 1, quarantinedBytes: size });
      await this.audit(manager, {
        companyId, userId: opts.userId, action: 'patrol.evidence_quarantined', entityId: id,
        beforeData: { retentionStatus: 'claimed' },
        afterData: { retentionStatus: 'quarantined', deletionReason: row.deletionReason, purgeAfter: purgeAfter.toISOString(), sha256: row.sha256Stored, sizeBytes: size },
      });
      return done;
    });
    if (!moved) {
      const current = await this.row(id);
      // Someone else finished this same claim (same key): leave it. Otherwise (restored meanwhile) this copy is an orphan.
      if (!(current?.retentionStatus === 'quarantined' && current.quarantineKey === quarantineKey)) await this.store.delete(quarantineKey).catch(() => undefined);
      return 'superseded';
    }
    await this.removePrimary(moved);
    return 'quarantined';
  }

  /** Removes the primary object of a quarantined photo (its copy is committed); records the confirmation. */
  async removePrimary(row: any): Promise<void> {
    try {
      await this.store.delete(row.storageKey);
      await this.dataSource.query(
        `UPDATE "patrol_evidence" SET "primaryDeletedAt" = now() WHERE "id" = $1 AND "storageKey" = $2 AND "primaryDeletedAt" IS NULL
            AND "retentionStatus" IN ('quarantined', 'purged', 'tombstone')`,
        [row.id, row.storageKey],
      );
    } catch (error) {
      await this.recordFailure(Number(row.id), 'quarantined', error);
    }
  }

  /** quarantined → purged → tombstone, for a photo whose quarantine has ended and that is not held. */
  async purge(row: any, opts: { userId: number | null; now?: Date }): Promise<'tombstone' | 'purged_pending' | 'skipped'> {
    const now = opts.now ?? new Date();
    const id = Number(row.id);
    const companyId = Number(row.companyId);
    if (row.retentionStatus === 'quarantined') {
      const started = await this.dataSource.transaction(async (manager) => {
        const [done] = await updateRows(manager,
          `UPDATE "patrol_evidence" e SET "retentionStatus" = 'purged', "purgedAt" = $2, "updatedAt" = now()
            WHERE e."id" = $1 AND e."retentionStatus" = 'quarantined' AND e."purgeAfter" <= $2 AND NOT ${heldSql('e')} RETURNING *`,
          [id, now],
        );
        if (done) {
          await this.audit(manager, {
            companyId, userId: opts.userId, action: 'patrol.evidence_purge_started', entityId: id,
            beforeData: { retentionStatus: 'quarantined' }, afterData: { retentionStatus: 'purged', purgedAt: now.toISOString() },
          });
        }
        return done;
      });
      if (!started) return 'skipped';
      row = started;
    }
    if (row.retentionStatus !== 'purged') return 'skipped';
    try {
      if (row.quarantineKey) await this.store.delete(row.quarantineKey);
      if (!row.primaryDeletedAt && row.storageKey) {
        await this.store.delete(row.storageKey);
        await this.store.delete(siblingKey(row.storageKey, 'incoming'));
      }
    } catch (error) {
      await this.recordFailure(id, 'purged', error);
      return 'purged_pending';
    }
    const done = await this.dataSource.transaction(async (manager) => {
      const [tomb] = await updateRows(manager,
        `UPDATE "patrol_evidence" SET "retentionStatus" = 'tombstone', "objectDeletedAt" = $2, "primaryDeletedAt" = COALESCE("primaryDeletedAt", $2),
            "lastDeletionError" = NULL, "updatedAt" = now()
          WHERE "id" = $1 AND "retentionStatus" = 'purged' RETURNING *`,
        [id, now],
      );
      if (!tomb) return null;
      const size = Number(tomb.sizeBytes ?? 0);
      await adjustUsage(manager, companyId, Number(tomb.siteId), { quarantinedObjects: -1, quarantinedBytes: -size });
      await this.audit(manager, {
        companyId, userId: opts.userId, action: 'patrol.evidence_purged', entityId: id,
        beforeData: { retentionStatus: 'purged' },
        afterData: {
          retentionStatus: 'tombstone', uploadStatus: tomb.uploadStatus, deletionReason: tomb.deletionReason, sha256: tomb.sha256Stored ?? tomb.sha256Client,
          sizeBytes: size, receivedAt: tomb.receivedAt ? new Date(tomb.receivedAt).toISOString() : null,
          verifiedAt: tomb.verifiedAt ? new Date(tomb.verifiedAt).toISOString() : null,
          quarantinedAt: tomb.quarantinedAt ? new Date(tomb.quarantinedAt).toISOString() : null, objectDeletedAt: now.toISOString(),
        },
      });
      return tomb;
    });
    return done ? 'tombstone' : 'skipped';
  }

  /** Owner / Admin restore of a claimed or quarantined (verified) photo. */
  async restore(companyId: number, id: number, userId: number, reason: string, now = new Date()): Promise<any> {
    const row = await this.row(id);
    if (!row || Number(row.companyId) !== companyId) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Photo not found.');
    if (row.uploadStatus !== 'verified' || !['claimed', 'quarantined'].includes(row.retentionStatus)) {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EVIDENCE_STATE_CONFLICT, 'Only a deleted, verified photo still in quarantine can be restored.', {
        uploadStatus: row.uploadStatus, retentionStatus: row.retentionStatus,
      });
    }
    const keepUntil = new Date(now.getTime() + PATROL_EVIDENCE_RESTORE_GRACE_DAYS * DAY);
    if (row.retentionStatus === 'claimed') {
      const done = await this.dataSource.transaction(async (manager) => {
        const [restored] = await updateRows(manager,
          `UPDATE "patrol_evidence" SET "retentionStatus" = 'active', "claimToken" = NULL, "claimedAt" = NULL, "deletionReason" = NULL,
              "deletionRequestedByUserId" = NULL, "restoredAt" = $3, "expiresAt" = GREATEST(COALESCE("expiresAt", $4), $4), "updatedAt" = now()
            WHERE "id" = $1 AND "retentionStatus" = 'claimed' AND "claimToken" = $2 RETURNING *`,
          [id, row.claimToken, now, keepUntil],
        );
        if (restored) {
          await this.audit(manager, {
            companyId, userId, action: 'patrol.evidence_restored', entityId: id,
            beforeData: { retentionStatus: 'claimed', deletionReason: row.deletionReason }, afterData: { retentionStatus: 'active', reason, expiresAt: new Date(restored.expiresAt).toISOString() },
          });
        }
        return restored;
      });
      if (!done) return this.restore(companyId, id, userId, reason, now); // it moved on meanwhile: retry from its new state
      return done;
    }
    const newKey = freshKeyLike(row.storageKey, 'evidence');
    try {
      await this.store.copy(row.quarantineKey, newKey);
      const check = await this.inspect(newKey, row.mimeType);
      if (check.sha256 !== row.sha256Stored) {
        await this.store.delete(newKey).catch(() => undefined);
        throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EVIDENCE_STATE_CONFLICT, 'The quarantined copy does not match the recorded SHA-256; it was not restored.');
      }
    } catch (error) {
      if (error instanceof PatrolStorageError) {
        await this.store.delete(newKey).catch(() => undefined);
        throw patrolError(HttpStatus.SERVICE_UNAVAILABLE, PatrolErrorCode.EVIDENCE_STORAGE_UNAVAILABLE, 'Patrol photo storage could not be reached. Try again shortly.');
      }
      throw error;
    }
    const restored = await this.dataSource.transaction(async (manager) => {
      const [done] = await updateRows(manager,
        `UPDATE "patrol_evidence" SET "retentionStatus" = 'active', "storageKey" = $3, "quarantineKey" = NULL, "quarantinedAt" = NULL, "purgeAfter" = NULL,
            "primaryDeletedAt" = NULL, "claimToken" = NULL, "claimedAt" = NULL, "deletionReason" = NULL, "deletionRequestedByUserId" = NULL,
            "restoredAt" = $4, "expiresAt" = GREATEST(COALESCE("expiresAt", $5), $5), "lastDeletionError" = NULL, "deletionAttempts" = 0, "updatedAt" = now()
          WHERE "id" = $1 AND "retentionStatus" = 'quarantined' AND "quarantineKey" = $2 RETURNING *`,
        [id, row.quarantineKey, newKey, now, keepUntil],
      );
      if (!done) return null;
      const size = Number(row.sizeBytes);
      await adjustUsage(manager, companyId, Number(row.siteId), { quarantinedObjects: -1, quarantinedBytes: -size, activeObjects: 1, activeBytes: size });
      await this.audit(manager, {
        companyId, userId, action: 'patrol.evidence_restored', entityId: id,
        beforeData: { retentionStatus: 'quarantined', deletionReason: row.deletionReason },
        afterData: { retentionStatus: 'active', reason, sha256: row.sha256Stored, expiresAt: new Date(done.expiresAt).toISOString() },
      });
      return done;
    });
    if (!restored) {
      await this.store.delete(newKey).catch(() => undefined);
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EVIDENCE_STATE_CONFLICT, 'This photo changed state while it was being restored (it may have been purged).');
    }
    await this.store.delete(row.quarantineKey).catch(() => undefined);
    if (!row.primaryDeletedAt && row.storageKey !== newKey) await this.store.delete(row.storageKey).catch(() => undefined);
    return restored;
  }

  private async recordFailure(id: number, status: string, error: unknown) {
    await this.dataSource.query(
      `UPDATE "patrol_evidence" SET "deletionAttempts" = "deletionAttempts" + 1, "lastDeletionError" = $3, "updatedAt" = now()
        WHERE "id" = $1 AND "retentionStatus" = $2`,
      [id, status, safeError(error)],
    );
  }
}
