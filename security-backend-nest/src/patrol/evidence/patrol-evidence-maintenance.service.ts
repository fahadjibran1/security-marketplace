import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { PATROL_EVIDENCE_LOCK_NAMESPACE } from '../../operations/advisory-locks';
import { SingleFlightJob, SingleFlightOutcome } from '../../scheduler/single-flight-job';
import { updateRows } from '../patrol-serializers';
import { PatrolEvidenceExportService } from './patrol-evidence-export.service';
import { PatrolEvidenceLifecycleService } from './patrol-evidence-lifecycle.service';
import {
  PATROL_EVIDENCE_BATCH,
  PATROL_EVIDENCE_ORPHAN_MAX_AGE_MS,
  PATROL_EVIDENCE_ORPHAN_MIN_AGE_MS,
  PatrolRetentionMode,
  heldSql,
  patrolRetentionMode,
  safeError,
} from './patrol-evidence-shared';
import { PatrolObjectStore } from './patrol-object-store';

/** The maintenance cadence (as the patrol sweep's). */
export const PATROL_EVIDENCE_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

export type PatrolEvidenceMaintenanceCounters = {
  mode: PatrolRetentionMode;
  storageAvailable: boolean;
  companies: number;
  companiesSkippedLocked: number;
  orphansCompleted: number;
  wouldClaim: number;
  claimed: number;
  quarantined: number;
  cancelledByHold: number;
  wouldPurge: number;
  purged: number;
  purgePending: number;
  primaryRemoved: number;
  failures: number;
  exportsBuilt: number;
  exportsExpired: number;
  snapshots: number;
};

/**
 * Patrol evidence maintenance (Patrols P1-C): every five minutes, one pass at a time in this process (SingleFlightJob
 * 'patrol-evidence-maintenance'), and per company under a session-level TRY advisory lock (PATROL_EVIDENCE_LOCK_NAMESPACE,
 * keyed by company id) so another instance skips that company instead of doubling up. Every step is bounded (100 per
 * company and step) and idempotent; the row-level tokens in PatrolEvidenceLifecycleService are the final guard.
 *
 *   1. orphaned uploads   intents the app never completed (10 min – 7 days old) are verified from what reached storage
 *   2. retention          (PATROL_EVIDENCE_RETENTION_MODE=enforce) verified photos past expiresAt and not held are claimed
 *                         and moved to quarantine; 'report' (the default) only counts and logs what it would do
 *   3. quarantine moves   claims not yet moved (a manual deletion whose move failed, or step 2) are moved, or cancelled if
 *                         a hold now covers them
 *   4. purge              (enforce) quarantined photos past purgeAfter and not held → purged → tombstone; purged rows whose
 *                         object removal failed are retried; quarantined rows whose primary removal failed are retried
 *   5. exports            queued / retryable exports are built; ready ones past 24 h are deleted (always, when storage is up)
 *   6. metering snapshot  today's patrol_storage_usage_daily per site from the live counters
 * Only companies with patrolsEnabled are processed for 1–4 (a switched-off company's evidence is left exactly as it is).
 */
@Injectable()
export class PatrolEvidenceMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PatrolEvidenceMaintenanceService.name);
  private interval?: NodeJS.Timeout;
  private job?: SingleFlightJob;

  constructor(
    private readonly dataSource: DataSource,
    private readonly store: PatrolObjectStore,
    private readonly lifecycle: PatrolEvidenceLifecycleService,
    private readonly exports: PatrolEvidenceExportService,
    private readonly auditLogService: AuditLogService,
  ) {}

  onModuleInit() {
    this.job = new SingleFlightJob(
      'patrol-evidence-maintenance',
      () => this.run(new Date()).catch((error) => this.logger.error(`Patrol evidence maintenance failed: ${safeError(error)}`)),
      { overrunAfterMs: 2 * PATROL_EVIDENCE_MAINTENANCE_INTERVAL_MS },
    );
    this.interval = setInterval(() => void this.tick(), PATROL_EVIDENCE_MAINTENANCE_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
    this.job?.stop();
  }

  /** What one timer tick does: start a pass unless one is already running. Never rejects. */
  tick(): Promise<SingleFlightOutcome> {
    if (!this.job) return Promise.resolve({ ran: false, skippedBecause: 'stopped' });
    return this.job.tick();
  }

  async run(now: Date = new Date(), mode: PatrolRetentionMode = patrolRetentionMode()): Promise<PatrolEvidenceMaintenanceCounters> {
    const c: PatrolEvidenceMaintenanceCounters = {
      mode, storageAvailable: this.store.available(), companies: 0, companiesSkippedLocked: 0, orphansCompleted: 0, wouldClaim: 0, claimed: 0,
      quarantined: 0, cancelledByHold: 0, wouldPurge: 0, purged: 0, purgePending: 0, primaryRemoved: 0, failures: 0, exportsBuilt: 0,
      exportsExpired: 0, snapshots: 0,
    };
    if (!c.storageAvailable) return c; // nothing can be verified, moved or deleted without storage
    const companies = await this.dataSource.query(`SELECT "id" FROM "companies" WHERE "patrolsEnabled" = true ORDER BY "id"`);
    for (const { id } of companies) {
      const companyId = Number(id);
      const runner = this.dataSource.createQueryRunner();
      try {
        await runner.connect();
        const [{ locked }] = await runner.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [PATROL_EVIDENCE_LOCK_NAMESPACE, companyId]);
        if (!locked) {
          c.companiesSkippedLocked += 1;
          continue;
        }
        try {
          c.companies += 1;
          await this.company(companyId, now, mode, c);
        } finally {
          await runner.query('SELECT pg_advisory_unlock($1, $2)', [PATROL_EVIDENCE_LOCK_NAMESPACE, companyId]);
        }
      } catch (error) {
        c.failures += 1;
        this.logger.error(JSON.stringify({ event: 'patrol_evidence_maintenance_company_failed', companyId, error: safeError(error) }));
      } finally {
        await runner.release();
      }
    }
    c.exportsBuilt = await this.exports.processPending(now);
    c.exportsExpired = await this.exports.expire(now);
    c.snapshots = await this.snapshot(now);
    if (mode === 'report' && (c.wouldClaim || c.wouldPurge)) {
      this.logger.log(JSON.stringify({ event: 'patrol_evidence_retention_report', wouldClaim: c.wouldClaim, wouldPurge: c.wouldPurge }));
    }
    return c;
  }

  private async company(companyId: number, now: Date, mode: PatrolRetentionMode, c: PatrolEvidenceMaintenanceCounters) {
    // 1. Orphaned uploads.
    const orphans = await this.dataSource.query(
      `SELECT "id" FROM "patrol_evidence" WHERE "companyId" = $1 AND "uploadStatus" IN ('pending', 'uploaded')
          AND "uploadUrlIssuedAt" BETWEEN $2 AND $3 AND ("completionToken" IS NULL OR "completionStartedAt" < $4)
        ORDER BY "id" LIMIT $5`,
      [companyId, new Date(now.getTime() - PATROL_EVIDENCE_ORPHAN_MAX_AGE_MS), new Date(now.getTime() - PATROL_EVIDENCE_ORPHAN_MIN_AGE_MS),
        new Date(now.getTime() - 2 * 60 * 1000), PATROL_EVIDENCE_BATCH],
    );
    for (const { id } of orphans) {
      try {
        const result = await this.lifecycle.complete(Number(id), { userId: null, via: 'maintenance', now });
        if (result.outcome === 'verified' || result.outcome === 'rejected') c.orphansCompleted += 1;
      } catch (error) {
        c.failures += 1;
        this.logger.warn(JSON.stringify({ event: 'patrol_evidence_orphan_failed', evidenceId: Number(id), error: safeError(error) }));
      }
    }

    // 2. Retention claims.
    if (mode === 'report') {
      const [{ n }] = await this.dataSource.query(
        `SELECT count(*)::int AS n FROM "patrol_evidence" e WHERE e."companyId" = $1 AND e."retentionStatus" = 'active' AND e."uploadStatus" = 'verified'
            AND e."expiresAt" <= $2 AND NOT ${heldSql('e')}`, [companyId, now]);
      c.wouldClaim += Number(n);
      const [{ p }] = await this.dataSource.query(
        `SELECT count(*)::int AS p FROM "patrol_evidence" e WHERE e."companyId" = $1 AND e."retentionStatus" = 'quarantined' AND e."purgeAfter" <= $2
            AND NOT ${heldSql('e')}`, [companyId, now]);
      c.wouldPurge += Number(p);
    }
    if (mode === 'enforce') {
      await this.dataSource.transaction(async (manager) => {
        const claimed = await updateRows(manager,
          `UPDATE "patrol_evidence" SET "retentionStatus" = 'claimed', "claimToken" = gen_random_uuid(), "claimedAt" = $2,
              "deletionReason" = 'retention_expired', "updatedAt" = now()
            WHERE "id" IN (
              SELECT e."id" FROM "patrol_evidence" e WHERE e."companyId" = $1 AND e."retentionStatus" = 'active' AND e."uploadStatus" = 'verified'
                 AND e."expiresAt" <= $2 AND NOT ${heldSql('e')}
               ORDER BY e."expiresAt", e."id" LIMIT $3 FOR UPDATE SKIP LOCKED)
            RETURNING "id", "expiresAt", "retentionDays", "sha256Stored"`,
          [companyId, now, PATROL_EVIDENCE_BATCH],
        );
        for (const row of claimed) {
          await this.auditLogService.logInTransaction(manager, {
            company: { id: companyId }, user: null, action: 'patrol.evidence_retention_claimed', entityType: 'patrol_evidence', entityId: Number(row.id),
            beforeData: { retentionStatus: 'active' },
            afterData: { retentionStatus: 'claimed', deletionReason: 'retention_expired', expiresAt: new Date(row.expiresAt).toISOString(), retentionDays: Number(row.retentionDays) },
          });
        }
        c.claimed += claimed.length;
      });
    }

    // 3. Quarantine moves (any claim: retention, or a manual deletion whose move failed).
    const claims = await this.dataSource.query(
      `SELECT * FROM "patrol_evidence" WHERE "companyId" = $1 AND "retentionStatus" = 'claimed' ORDER BY "claimedAt", "id" LIMIT $2`,
      [companyId, PATROL_EVIDENCE_BATCH],
    );
    for (const row of claims) {
      try {
        const result = await this.lifecycle.moveToQuarantine(row, { userId: null, now });
        if (result === 'quarantined') c.quarantined += 1;
        if (result === 'cancelled_hold') c.cancelledByHold += 1;
      } catch (error) {
        c.failures += 1;
        this.logger.warn(JSON.stringify({ event: 'patrol_evidence_quarantine_failed', evidenceId: Number(row.id), error: safeError(error) }));
      }
    }

    // 4. Purge (enforce), and retries of unfinished object removals (always: they finish decisions already committed).
    if (mode === 'enforce') {
      const due = await this.dataSource.query(
        `SELECT e.* FROM "patrol_evidence" e WHERE e."companyId" = $1 AND e."retentionStatus" = 'quarantined' AND e."purgeAfter" <= $2
            AND NOT ${heldSql('e')} ORDER BY e."purgeAfter", e."id" LIMIT $3`,
        [companyId, now, PATROL_EVIDENCE_BATCH],
      );
      for (const row of due) {
        const result = await this.lifecycle.purge(row, { userId: null, now }).catch((error) => {
          c.failures += 1;
          this.logger.warn(JSON.stringify({ event: 'patrol_evidence_purge_failed', evidenceId: Number(row.id), error: safeError(error) }));
          return 'skipped' as const;
        });
        if (result === 'tombstone') c.purged += 1;
        if (result === 'purged_pending') c.purgePending += 1;
      }
    }
    const unfinished = await this.dataSource.query(
      `SELECT * FROM "patrol_evidence" WHERE "companyId" = $1 AND "retentionStatus" = 'purged' ORDER BY "purgedAt", "id" LIMIT $2`,
      [companyId, PATROL_EVIDENCE_BATCH],
    );
    for (const row of unfinished) {
      const result = await this.lifecycle.purge(row, { userId: null, now }).catch(() => 'skipped' as const);
      if (result === 'tombstone') c.purged += 1;
      if (result === 'purged_pending') c.purgePending += 1;
    }
    const leftovers = await this.dataSource.query(
      `SELECT * FROM "patrol_evidence" WHERE "companyId" = $1 AND "retentionStatus" = 'quarantined' AND "uploadStatus" = 'verified'
          AND "primaryDeletedAt" IS NULL ORDER BY "id" LIMIT $2`,
      [companyId, PATROL_EVIDENCE_BATCH],
    );
    for (const row of leftovers) {
      await this.lifecycle.removePrimary(row);
      c.primaryRemoved += 1;
    }
  }

  /** Today's (UTC) per-site snapshot of the live counters into patrol_storage_usage_daily (Migration 68). */
  private async snapshot(now: Date): Promise<number> {
    const day = now.toISOString().slice(0, 10);
    const rows = await this.dataSource.query(
      `INSERT INTO "patrol_storage_usage_daily" ("companyId", "siteId", "day", "objects", "bytes", "computedAt")
       SELECT "companyId", "siteId", $1::date, "activeObjects" + "quarantinedObjects", "activeBytes" + "quarantinedBytes", now()
         FROM "patrol_storage_usage" WHERE "siteId" IS NOT NULL
       ON CONFLICT ("companyId", "siteId", "day") DO UPDATE SET "objects" = EXCLUDED."objects", "bytes" = EXCLUDED."bytes", "computedAt" = now()
       RETURNING "id"`,
      [day],
    );
    return rows.length;
  }
}
