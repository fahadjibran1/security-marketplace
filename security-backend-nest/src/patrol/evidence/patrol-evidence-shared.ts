/**
 * Shared rules for patrol photo evidence (P1-C): timings, bounds, the hold predicate and live storage metering.
 */

/** A deleted photo stays recoverable in quarantine for this long, then (with no hold) it is purged to a tombstone. */
export const PATROL_EVIDENCE_QUARANTINE_DAYS = 7;
/** A restored photo is kept at least this long from the restore, whatever its original expiry (place a hold for longer). */
export const PATROL_EVIDENCE_RESTORE_GRACE_DAYS = 7;
/** One completion (verification) at a time per photo; a lease older than this is taken over. */
export const PATROL_EVIDENCE_COMPLETION_LEASE_MS = 2 * 60 * 1000;
/** Upload intents the app never completed are verified by the maintenance job between these ages. */
export const PATROL_EVIDENCE_ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;
export const PATROL_EVIDENCE_ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Photos one run may carry (policy maxima are 20 per run + 5 per checkpoint; this bounds abuse, not normal use). */
export const PATROL_EVIDENCE_MAX_PER_RUN = 100;
/** Maintenance batch per company and step. */
export const PATROL_EVIDENCE_BATCH = 100;

export const PATROL_EXPORT_MAX_ITEMS = 500;
export const PATROL_EXPORT_MAX_BYTES = 512 * 1024 * 1024;
export const PATROL_EXPORT_MAX_RANGE_DAYS = 31;
export const PATROL_EXPORT_MAX_RUN_IDS = 200;
export const PATROL_EXPORT_MAX_OPEN_PER_COMPANY = 2;
export const PATROL_EXPORT_TTL_HOURS = 24;
export const PATROL_EXPORT_MAX_ATTEMPTS = 3;
export const PATROL_EXPORT_STALE_RUNNING_MS = 30 * 60 * 1000;

/**
 * Thumbnail browsing (issue #79): one page of a run's photos at a time, one short-lived link grant and ONE audit entry
 * (purpose 'browse') per page view. The page size is bounded so a grant never covers more than a screenful.
 */
export const PATROL_EVIDENCE_THUMBNAIL_PAGE_DEFAULT = 12;
export const PATROL_EVIDENCE_THUMBNAIL_PAGE_MAX = 24;

export const PATROL_EVIDENCE_ACCESS_PURPOSES = ['review', 'incident', 'investigation', 'client_request', 'legal', 'audit', 'other'] as const;
export const PATROL_EXPORT_PURPOSES = ['incident', 'investigation', 'client_request', 'legal', 'audit', 'other'] as const;

/**
 * Retention enforcement mode (PATROL_EVIDENCE_RETENTION_MODE):
 *   off      the maintenance job does nothing about retention
 *   report   (default) it counts what it WOULD claim / purge and logs it — nothing is deleted (P1-A's "ships report-only")
 *   enforce  expired photos move into the deletion state machine and quarantined ones past their purge time are purged
 * Manual deletion by an Owner / Admin, rejected uploads and export expiry do not depend on it.
 */
export type PatrolRetentionMode = 'off' | 'report' | 'enforce';
export function patrolRetentionMode(env: NodeJS.ProcessEnv = process.env): PatrolRetentionMode {
  const value = (env.PATROL_EVIDENCE_RETENTION_MODE ?? '').trim().toLowerCase();
  return value === 'off' || value === 'enforce' ? value : 'report';
}

/**
 * SQL: whether the evidence row aliased `e` is under an ACTIVE hold — one on the photo, its run, its shift, or its site
 * for a date range containing its capture date (in the site's own time zone).
 */
export function heldSql(e = 'e'): string {
  return `EXISTS (SELECT 1 FROM "patrol_evidence_holds" h WHERE h."companyId" = ${e}."companyId" AND h."releasedAt" IS NULL AND (
      (h."scope" = 'evidence' AND h."evidenceId" = ${e}."id")
      OR (h."scope" = 'run' AND h."runId" = ${e}."runId")
      OR (h."scope" = 'shift' AND h."shiftId" = ${e}."shiftId")
      OR (h."scope" = 'site_date_range' AND h."siteId" = ${e}."siteId"
          AND (${e}."capturedAtDevice" AT TIME ZONE COALESCE((SELECT st."timezone" FROM "sites" st WHERE st."id" = ${e}."siteId"), 'Europe/London'))::date
              BETWEEN h."fromDate" AND h."toDate")))`;
}

type Runner = { query: (sql: string, params?: unknown[]) => Promise<any> };
export type UsageDelta = Partial<Record<'activeObjects' | 'activeBytes' | 'quarantinedObjects' | 'quarantinedBytes' | 'exportObjects' | 'exportBytes', number>>;
const USAGE_COLUMNS = ['activeObjects', 'activeBytes', 'quarantinedObjects', 'quarantinedBytes', 'exportObjects', 'exportBytes'] as const;

/**
 * Moves the live counters, in the caller's transaction (so metering commits or rolls back with the state change that
 * caused it). siteId null is the company row (exports). Never below zero; scripts/patrol-evidence.spec.ts proves the
 * counters equal a recount through every transition (recountUsage).
 */
export async function adjustUsage(runner: Runner, companyId: number, siteId: number | null, delta: UsageDelta): Promise<void> {
  const values = USAGE_COLUMNS.map((c) => Math.trunc(delta[c] ?? 0));
  if (values.every((v) => v === 0)) return;
  const target = siteId === null ? `("companyId") WHERE "siteId" IS NULL` : `("companyId", "siteId") WHERE "siteId" IS NOT NULL`;
  await runner.query(
    `INSERT INTO "patrol_storage_usage" ("companyId", "siteId", ${USAGE_COLUMNS.map((c) => `"${c}"`).join(', ')}, "updatedAt")
     VALUES ($1, $2, ${USAGE_COLUMNS.map((_, i) => `GREATEST(0, $${i + 3}::bigint)`).join(', ')}, now())
     ON CONFLICT ${target} DO UPDATE SET ${USAGE_COLUMNS.map((c, i) => `"${c}" = GREATEST(0, "patrol_storage_usage"."${c}" + $${i + 3}::bigint)`).join(', ')}, "updatedAt" = now()`,
    [companyId, siteId, ...values],
  );
}

/** The counters recomputed from the records themselves (for reconciliation and the tests). */
export async function recountUsage(runner: Runner, companyId: number) {
  const sites = await runner.query(
    `SELECT "siteId",
        count(*) FILTER (WHERE "uploadStatus" = 'verified' AND "retentionStatus" IN ('active', 'claimed'))::int AS "activeObjects",
        COALESCE(sum("sizeBytes") FILTER (WHERE "uploadStatus" = 'verified' AND "retentionStatus" IN ('active', 'claimed')), 0)::bigint AS "activeBytes",
        count(*) FILTER (WHERE "retentionStatus" IN ('quarantined', 'purged'))::int AS "quarantinedObjects",
        COALESCE(sum("sizeBytes") FILTER (WHERE "retentionStatus" IN ('quarantined', 'purged')), 0)::bigint AS "quarantinedBytes"
       FROM "patrol_evidence" WHERE "companyId" = $1 GROUP BY "siteId" ORDER BY "siteId"`,
    [companyId],
  );
  const [exports] = await runner.query(
    `SELECT count(*)::int AS "exportObjects", COALESCE(sum("zipBytes"), 0)::bigint AS "exportBytes"
       FROM "patrol_evidence_exports" WHERE "companyId" = $1 AND "status" = 'ready'`,
    [companyId],
  );
  return {
    sites: sites.map((r: any) => ({
      siteId: Number(r.siteId), activeObjects: Number(r.activeObjects), activeBytes: Number(r.activeBytes),
      quarantinedObjects: Number(r.quarantinedObjects), quarantinedBytes: Number(r.quarantinedBytes),
    })).filter((r: any) => r.activeObjects || r.activeBytes || r.quarantinedObjects || r.quarantinedBytes),
    exportObjects: Number(exports.exportObjects),
    exportBytes: Number(exports.exportBytes),
  };
}

/** The stored counters in the same shape as recountUsage. */
export async function storedUsage(runner: Runner, companyId: number) {
  const rows = await runner.query(`SELECT * FROM "patrol_storage_usage" WHERE "companyId" = $1 ORDER BY "siteId" NULLS LAST`, [companyId]);
  const company = rows.find((r: any) => r.siteId == null);
  return {
    sites: rows.filter((r: any) => r.siteId != null).map((r: any) => ({
      siteId: Number(r.siteId), activeObjects: Number(r.activeObjects), activeBytes: Number(r.activeBytes),
      quarantinedObjects: Number(r.quarantinedObjects), quarantinedBytes: Number(r.quarantinedBytes),
    })).filter((r: any) => r.activeObjects || r.activeBytes || r.quarantinedObjects || r.quarantinedBytes),
    exportObjects: Number(company?.exportObjects ?? 0),
    exportBytes: Number(company?.exportBytes ?? 0),
  };
}

/** A storage / processing error reduced to something safe to store and log (never a URL or a credential). */
export function safeError(error: unknown): string {
  const e = error as { operation?: string; status?: number | null; code?: string; message?: string };
  if (e && typeof e.operation === 'string' && typeof e.code === 'string') return `storage ${e.operation} ${e.status ?? 'network'} ${e.code}`.slice(0, 500);
  const message = String(e?.message ?? error).replace(/https?:\/\/\S+/g, '[url]').replace(/X-Amz-[A-Za-z]+=[^&\s]+/g, '[redacted]');
  return message.slice(0, 500);
}
