import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { PatrolAccessService } from './patrol-access.service';
import { PatrolErrorCode, patrolError } from './patrol-constants';
import { monitorRunFromRow, PatrolMonitorService, resolvePolicy } from './patrol-monitor.service';
import { PatrolQueryService, usableZone } from './patrol-query.service';
import { serializeEvidenceMetadata, serializeException } from './patrol-serializers';
import { localDateOf, wallMinutesToInstant } from './patrol-window.service';

/** The Attention Now queue's cap: the newest 200 cases, with `more` when there are others. */
export const PATROL_ATTENTION_CASE_LIMIT = 200;
/** Today's resolved missed windows listed (the count is always complete). */
export const PATROL_ATTENTION_RESOLVED_LIMIT = 200;
/** Other patrols near the window shown in an investigation (ad-hoc or another window's). */
export const PATROL_INVESTIGATION_RELATED_LIMIT = 10;
const RELATED_MARGIN_MS = 60 * 60_000;
const DAY_MINUTES = 1440;

type Runner = Pick<EntityManager, 'query'>;
type SiteRow = { id: number; name: string; timeZone: string; clientId: number | null; clientName: string | null };

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const personName = (first: string | null, last: string | null) => [first, last].map((p) => (p ?? '').trim()).filter(Boolean).join(' ') || 'Staff member';

/**
 * The unresolved actionable patrol cases of a company (S3 Stage 2, owner decisions C and E, 4 Nov 2026). ONE case per
 * actionable patrol exception — the exception and its one linked safety alert (uq_safety_alerts_patrol_exception) are the
 * same case, never two — plus ONE case per unresolved reconciliation summary alert (an outage's missed windows at a site,
 * or the unjudged horizon), whose underlying exceptions it never resolves.
 *
 * Driven from the indexed side so a poll never walks the alert history: patrol_exceptions by (companyId, status) for the
 * unresolved ones (IDX_patrol_exceptions_company_status), each joined to its alert by primary key; summary alerts through
 * the company's reconciliation runs (a handful of rows) and uq_safety_alerts_patrol_reconciliation.
 *
 * A case is listed while its exception is unresolved. Its `alertStatus` is the action state (open / acknowledged); an
 * exception still open whose alert is closed (a record from before Stage 1 made the two atomic) is listed with
 * `stateMismatch` so it can be settled, rather than hidden.
 */
const CASES_CTE = `WITH cases AS (
  SELECT 'exception'::text AS "kind", e."id" AS "exceptionId", a."id" AS "alertId", e."type"::text AS "type", a."type"::text AS "alertType",
         a."status"::text AS "alertStatus", e."status"::text AS "exceptionStatus", a."priority"::text AS "priority", a."message" AS "message",
         e."siteId" AS "siteId", e."shiftId" AS "shiftId", e."guardId" AS "guardId", e."runId" AS "runId", e."windowKey" AS "windowKey",
         e."scopeKey" AS "scopeKey", e."windowStart" AS "windowStart", e."windowEnd" AS "windowEnd", e."lateEvidenceAt" AS "lateEvidenceAt",
         a."patrolLateSyncAt" AS "patrolLateSyncAt", a."createdAt" AS "raisedAt", a."acknowledgedAt" AS "acknowledgedAt",
         a."acknowledgedByUserId" AS "acknowledgedByUserId", e."reconciliationRunId" AS "reconciliationRunId", a."patrolWindowKey" AS "patrolWindowKey"
    FROM "patrol_exceptions" e
    JOIN "safety_alerts" a ON a."id" = e."safetyAlertId" AND a."companyId" = e."companyId"
   WHERE e."companyId" = $1 AND e."status" IN ('open', 'acknowledged')
  UNION ALL
  SELECT 'reconciliation_summary', NULL, a."id", 'patrol_missed', a."type"::text, a."status"::text, NULL, a."priority"::text, a."message",
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, a."patrolLateSyncAt", a."createdAt", a."acknowledgedAt", a."acknowledgedByUserId",
         r."id", a."patrolWindowKey"
    FROM "patrol_reconciliation_runs" r
    JOIN "safety_alerts" a ON a."patrolReconciliationRunId" = r."id" AND a."companyId" = r."companyId"
   WHERE r."companyId" = $1 AND a."patrolExceptionId" IS NULL AND a."status" <> 'closed'
)`;

/**
 * S3 Control Room patrol operations (owner-approved S3 Stage 2, 4 Nov 2026): two READ-ONLY, company-scoped reads for Live
 * Operations. Nothing is written — no audit entry, no state change — and no image, signed link or evidence object is read.
 *
 *   GET /patrols/operations/attention              the unresolved actionable patrol cases (newest 200, `more` when capped),
 *                                                  their counts, and today's missed windows (site-local days) including the
 *                                                  resolved ones
 *   GET /patrols/exceptions/:id/investigation      one case: site, client, shift, Guard, scheduled window, the patrol that
 *                                                  covered it (status, verification explanation, QR progress and missing
 *                                                  checkpoints, photo counts, delayed evidence), patrols near it, other
 *                                                  cases of the same window, and — only with patrols.evidence — the photo
 *                                                  metadata (never a file or a link)
 *
 * Both need patrols.view (and Patrols on for the company: 404 otherwise), exactly as every other patrol read.
 */
@Injectable()
export class PatrolOperationsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: PatrolAccessService,
    private readonly monitor: PatrolMonitorService,
    private readonly query: PatrolQueryService,
  ) {}

  async attention(user: JwtPayload, now: Date = new Date()) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    const companyId = actor.companyId;
    return this.snapshot(async (db) => {
      const sites = await this.sites(db, companyId);
      const siteById = new Map(sites.map((s) => [s.id, s]));
      // One wall-clock conversion per zone and date, not per site (a request-scoped cache per zone, as the Monitor keeps).
      const zoneCaches = new Map<string, Map<string, number>>();
      const days = sites.map((s) => {
        const date = localDateOf(now, s.timeZone);
        if (!zoneCaches.has(s.timeZone)) zoneCaches.set(s.timeZone, new Map());
        const cache = zoneCaches.get(s.timeZone);
        return { siteId: s.id, date, from: new Date(wallMinutesToInstant(date, 0, s.timeZone, cache)), to: new Date(wallMinutesToInstant(date, DAY_MINUTES, s.timeZone, cache)) };
      });

      const [totals] = await db.query(
        `${CASES_CTE}
         SELECT count(*)::int AS "cases",
                count(DISTINCT "alertId") FILTER (WHERE "alertStatus" <> 'closed')::int AS "openAlerts",
                count(*) FILTER (WHERE "alertStatus" = 'acknowledged')::int AS "acknowledged",
                count(*) FILTER (WHERE "kind" = 'exception' AND "exceptionStatus" <> "alertStatus")::int AS "mismatched"
           FROM cases`,
        [companyId],
      );
      const caseRows = await db.query(
        `${CASES_CTE} SELECT * FROM cases ORDER BY "raisedAt" DESC, "alertId" DESC LIMIT ${PATROL_ATTENTION_CASE_LIMIT}`,
        [companyId],
      );

      // Today's missed windows, per site-local day: one patrol_missed exception per window and scope (never re-raised), any
      // status, including windows found by outage reconciliation. A window belongs to the day it starts (overnight included).
      const dayArgs = [companyId, days.map((d) => d.siteId), days.map((d) => d.from.toISOString()), days.map((d) => d.to.toISOString()),
        // (A company with no sites has no day: the queries below are skipped, so no bound is computed.)
        days.length ? new Date(Math.min(...days.map((d) => d.from.getTime()))).toISOString() : null,
        days.length ? new Date(Math.max(...days.map((d) => d.to.getTime()))).toISOString() : null];
      // The overall [earliest midnight, latest midnight) bound keeps the scan to about a day of exceptions whatever the history.
      const DAY_JOIN = `FROM "patrol_exceptions" e
        JOIN unnest($2::int[], $3::timestamptz[], $4::timestamptz[]) AS b("siteId", "fromAt", "toAt") ON b."siteId" = e."siteId"
       WHERE e."companyId" = $1 AND e."type" = 'patrol_missed' AND e."windowStart" >= $5 AND e."windowStart" < $6
         AND e."windowStart" >= b."fromAt" AND e."windowStart" < b."toAt"`;
      const [missed] = days.length
        ? await db.query(
          `SELECT count(DISTINCT (e."siteId", e."windowKey", e."scopeKey"))::int AS "total",
                  count(DISTINCT (e."siteId", e."windowKey", e."scopeKey")) FILTER (WHERE e."status" <> 'resolved')::int AS "open"
             ${DAY_JOIN}`,
          dayArgs,
        )
        : [{ total: 0, open: 0 }];
      const resolvedRows = days.length
        ? await db.query(
          `SELECT e."id", e."siteId", e."shiftId", e."guardId", e."windowKey", e."scopeKey", e."windowStart", e."windowEnd", e."safetyAlertId",
                  e."resolution", e."resolvedAt", e."resolvedByUserId", e."acknowledgedAt", e."acknowledgedByUserId", e."reconciliationRunId"
             ${DAY_JOIN} AND e."status" = 'resolved'
            ORDER BY e."resolvedAt" DESC, e."id" DESC LIMIT ${PATROL_ATTENTION_RESOLVED_LIMIT}`,
          dayArgs,
        )
        : [];

      // A summary's affected windows: its reconciliation run's missed exceptions at its site (the summary resolves none).
      const summaries = caseRows.filter((r: any) => r.kind === 'reconciliation_summary');
      const affected = new Map<string, { total: number; open: number }>();
      if (summaries.length) {
        const rows = await db.query(
          `SELECT "reconciliationRunId", "siteId", count(*)::int AS "total", count(*) FILTER (WHERE "status" <> 'resolved')::int AS "open"
             FROM "patrol_exceptions" WHERE "companyId" = $1 AND "reconciliationRunId" = ANY($2::int[]) AND "type" = 'patrol_missed'
            GROUP BY 1, 2`,
          [companyId, [...new Set(summaries.map((r: any) => Number(r.reconciliationRunId)))]],
        );
        for (const r of rows) affected.set(`${r.reconciliationRunId}:${r.siteId}`, { total: Number(r.total), open: Number(r.open) });
      }

      const guards = await this.guardNames(db, [...caseRows, ...resolvedRows].map((r: any) => num(r.guardId)));
      const people = await this.userNames(db, [...caseRows.map((r: any) => num(r.acknowledgedByUserId)), ...resolvedRows.flatMap((r: any) => [num(r.resolvedByUserId), num(r.acknowledgedByUserId)])]);
      const siteOf = (id: number | null) => (id == null ? null : siteById.get(id) ?? null);
      const siteJson = (s: SiteRow | null) => (s ? { id: s.id, name: s.name, clientId: s.clientId, clientName: s.clientName, timeZone: s.timeZone } : null);

      const cases = caseRows.map((r: any) => {
        const summary = r.kind === 'reconciliation_summary';
        const summarySiteId = summary ? summarySite(r.patrolWindowKey) : null;
        const site = siteOf(summary ? summarySiteId : num(r.siteId));
        return {
          caseKey: summary ? `alert:${Number(r.alertId)}` : `exception:${Number(r.exceptionId)}`,
          kind: r.kind as 'exception' | 'reconciliation_summary',
          exceptionId: num(r.exceptionId),
          alertId: Number(r.alertId),
          type: r.type,
          alertType: r.alertType,
          status: r.alertStatus as 'open' | 'acknowledged' | 'closed',
          exceptionStatus: r.exceptionStatus ?? null,
          stateMismatch: !summary && r.exceptionStatus !== r.alertStatus,
          priority: r.priority,
          message: r.message,
          site: siteJson(site),
          siteDate: r.windowStart && site ? localDateOf(new Date(r.windowStart), site.timeZone) : null,
          shiftId: num(r.shiftId),
          guardId: num(r.guardId),
          guardName: r.guardId == null ? null : guards.get(Number(r.guardId)) ?? null,
          runId: num(r.runId),
          windowKey: r.windowKey ?? null,
          scopeKey: r.scopeKey ?? null,
          windowStart: iso(r.windowStart),
          windowEnd: iso(r.windowEnd),
          raisedAt: iso(r.raisedAt),
          acknowledgedAt: iso(r.acknowledgedAt),
          acknowledgedByName: r.acknowledgedByUserId == null ? null : people.get(Number(r.acknowledgedByUserId)) ?? null,
          lateEvidence: Boolean(r.lateEvidenceAt || r.patrolLateSyncAt),
          reconciliationRunId: num(r.reconciliationRunId),
          affectedWindows: summary
            ? summarySiteId == null ? null : affected.get(`${r.reconciliationRunId}:${summarySiteId}`) ?? { total: 0, open: 0 }
            : null,
        };
      });

      const missedTotal = Number(missed.total);
      const missedOpen = Number(missed.open);
      return {
        generatedAt: now.toISOString(),
        dateBasis: 'site_local' as const,
        limit: PATROL_ATTENTION_CASE_LIMIT,
        counts: {
          patrolAlerts: Number(totals.cases),
          openPatrolAlerts: Number(totals.openAlerts),
          acknowledged: Number(totals.acknowledged),
          stateMismatches: Number(totals.mismatched),
          missedToday: missedTotal,
          missedTodayOpen: missedOpen,
          missedTodayResolved: missedTotal - missedOpen,
        },
        cases,
        more: Number(totals.cases) > cases.length,
        resolvedMissedToday: {
          items: resolvedRows.map((r: any) => {
            const site = siteOf(Number(r.siteId));
            return {
              exceptionId: Number(r.id),
              alertId: num(r.safetyAlertId),
              site: siteJson(site),
              siteDate: site ? localDateOf(new Date(r.windowStart), site.timeZone) : null,
              shiftId: num(r.shiftId),
              guardId: num(r.guardId),
              guardName: r.guardId == null ? null : guards.get(Number(r.guardId)) ?? null,
              windowKey: r.windowKey,
              scopeKey: r.scopeKey,
              windowStart: iso(r.windowStart),
              windowEnd: iso(r.windowEnd),
              resolution: r.resolution ?? null,
              resolvedAt: iso(r.resolvedAt),
              resolvedByName: r.resolvedByUserId == null ? null : people.get(Number(r.resolvedByUserId)) ?? null,
              acknowledgedByName: r.acknowledgedByUserId == null ? null : people.get(Number(r.acknowledgedByUserId)) ?? null,
              reconciliationRunId: num(r.reconciliationRunId),
            };
          }),
          more: missedTotal - missedOpen > resolvedRows.length,
        },
      };
    });
  }

  async investigation(user: JwtPayload, exceptionId: number, now: Date = new Date()) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    const companyId = actor.companyId;
    const evidenceAllowed = this.access.holds(actor, CompanyPermission.PATROLS_EVIDENCE);
    return this.snapshot(async (db) => {
      const [e] = await db.query(`SELECT * FROM "patrol_exceptions" WHERE "id" = $1 AND "companyId" = $2`, [exceptionId, companyId]);
      if (!e) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Patrol exception not found.');

      const [alert] = e.safetyAlertId
        ? await db.query(
          `SELECT "id", "type"::text AS "type", "status"::text AS "status", "priority"::text AS "priority", "message", "createdAt", "acknowledgedAt",
                  "acknowledgedByUserId", "closedAt", "closedByUserId", "resolutionReason", "resolutionNote", "patrolLateSyncAt", "patrolAnnotation"
             FROM "safety_alerts" WHERE "id" = $1 AND "companyId" = $2`,
          [e.safetyAlertId, companyId],
        )
        : [];
      const [site] = await this.sites(db, companyId, Number(e.siteId));
      const [shift] = e.shiftId
        ? await db.query(`SELECT "id", "start", "end", "status"::text AS "status", "guardId" FROM "shifts" WHERE "id" = $1 AND "companyId" = $2`, [e.shiftId, companyId])
        : [];

      // The patrol that covered (or failed) this window: the exception's own run, else a run of the same window and scope.
      const [run] = e.runId
        ? await db.query(`SELECT * FROM "patrol_runs" WHERE "id" = $1 AND "companyId" = $2`, [e.runId, companyId])
        : e.windowKey
          ? await db.query(
            // scheduleId first, so UQ_patrol_runs_schedule_window_scope finds it without walking the company's runs.
            `SELECT * FROM "patrol_runs" WHERE "companyId" = $1 AND ${e.scheduleId == null ? `"scheduleId" IS NULL AND $4::int IS NULL` : `"scheduleId" = $4`} AND "windowKey" = $2 AND "scopeKey" = $3
              ORDER BY "startedAtServer" DESC, "id" DESC LIMIT 1`,
            [companyId, e.windowKey, e.scopeKey, e.scheduleId ?? null],
          )
          : [];

      // Patrols near the window that are not this window's: ad-hoc (no window) or another window's, on the same shift (or
      // at the site for a site-wide window). Bounded in time and number.
      const anchorFrom = new Date(e.windowStart ?? run?.startedAtServer ?? e.createdAt);
      const anchorTo = new Date(e.windowEnd ?? anchorFrom);
      const related = await db.query(
        `SELECT * FROM "patrol_runs"
          WHERE "companyId" = $1 AND "siteId" = $2 AND ($3::int IS NULL OR "shiftId" = $3) AND ($4::int IS NULL OR "id" <> $4)
            AND ("windowKey" IS NULL OR NOT ("windowKey" = $5 AND "scopeKey" = $6))
            AND "startedAtServer" >= $7 AND "startedAtServer" < $8
          ORDER BY "startedAtServer", "id" LIMIT ${PATROL_INVESTIGATION_RELATED_LIMIT}`,
        [companyId, e.siteId, e.shiftId ?? null, run?.id ?? null, e.windowKey ?? '', e.scopeKey ?? '',
          new Date(anchorFrom.getTime() - RELATED_MARGIN_MS), new Date(anchorTo.getTime() + RELATED_MARGIN_MS)],
      );
      const otherCases = e.windowKey
        ? await db.query(
          `SELECT x."id", x."type", x."status", x."safetyAlertId", a."status"::text AS "alertStatus" FROM "patrol_exceptions" x
             LEFT JOIN "safety_alerts" a ON a."id" = x."safetyAlertId"
            WHERE x."companyId" = $1 AND x."windowKey" = $2 AND x."scopeKey" = $3 AND x."id" <> $4 ORDER BY x."id" LIMIT 20`,
          [companyId, e.windowKey, e.scopeKey, e.id],
        )
        : [];

      const runs = [run, ...related].filter(Boolean);
      const policyRows = runs.length ? await db.query(`SELECT * FROM "patrol_policies" WHERE "companyId" = $1`, [companyId]) : [];
      const summaries = runs.length
        ? await this.monitor.runSummaries(companyId, runs.map(monitorRunFromRow), resolvePolicy(policyRows, Number(e.siteId)), { detail: true })
        : new Map<number, any>();
      const explained = runs.length ? await this.query.explanations(companyId, runs, now) : new Map<number, unknown>();
      const missingIds: number[] = run ? summaries.get(Number(run.id))?.missingCheckpointIds ?? [] : [];
      const labels = missingIds.length
        ? new Map<number, string>((await db.query(`SELECT "id", "label" FROM "patrol_checkpoints" WHERE "companyId" = $1 AND "id" = ANY($2::int[])`, [companyId, missingIds]))
          .map((c: any) => [Number(c.id), c.label]))
        : new Map<number, string>();

      // Photo counts for everyone with patrols.view (as the Monitor shows them); per-photo metadata only with patrols.evidence.
      const [photoCounts] = run
        ? await db.query(
          `SELECT count(*)::int AS "total",
                  count(*) FILTER (WHERE "uploadStatus" = 'verified')::int AS "verified",
                  count(*) FILTER (WHERE "uploadStatus" NOT IN ('verified', 'rejected', 'local_corrupt'))::int AS "pending",
                  count(*) FILTER (WHERE "uploadStatus" IN ('rejected', 'local_corrupt'))::int AS "rejected",
                  count(*) FILTER (WHERE $3::timestamptz IS NOT NULL AND "receivedAt" > $3)::int AS "receivedAfterWindow"
             FROM "patrol_evidence" WHERE "runId" = $1 AND "companyId" = $2`,
          [run.id, companyId, e.windowEnd ?? null],
        )
        : [null];
      const evidenceRows = run && evidenceAllowed
        ? await db.query(`SELECT * FROM "patrol_evidence" WHERE "runId" = $1 AND "companyId" = $2 ORDER BY "capturedAtDevice", "id"`, [run.id, companyId])
        : [];

      const guardIds = [num(e.guardId), num(shift?.guardId), ...runs.map((r: any) => num(r.guardId))];
      const guards = await this.guardNames(db, guardIds);
      const people = await this.userNames(db, [num(e.acknowledgedByUserId), num(e.resolvedByUserId), num(alert?.acknowledgedByUserId), num(alert?.closedByUserId)]);
      const named = (id: unknown) => (id == null ? null : people.get(Number(id)) ?? null);
      const runJson = (r: any) => {
        const s = summaries.get(Number(r.id));
        const { missingCheckpointIds: _ids, ...summary } = s ?? {};
        return {
          ...summary,
          guardName: guards.get(Number(r.guardId)) ?? null,
          windowKey: r.windowKey ?? null,
          scopeKey: r.scopeKey ?? null,
          unscheduled: r.windowKey == null,
          syncedLate: r.syncedLate === true,
          syncFlags: Array.isArray(r.syncFlags) ? r.syncFlags.map(String) : [],
          verificationExplanation: explained.get(Number(r.id)) ?? null,
        };
      };

      return {
        generatedAt: now.toISOString(),
        exception: { ...serializeException(e), acknowledgedByName: named(e.acknowledgedByUserId), resolvedByName: named(e.resolvedByUserId) },
        alert: alert
          ? {
            id: Number(alert.id), type: alert.type, status: alert.status, priority: alert.priority, message: alert.message,
            raisedAt: iso(alert.createdAt), acknowledgedAt: iso(alert.acknowledgedAt), acknowledgedByName: named(alert.acknowledgedByUserId),
            closedAt: iso(alert.closedAt), closedByName: named(alert.closedByUserId), resolutionReason: alert.resolutionReason ?? null,
            resolutionNote: alert.resolutionNote ?? null, patrolLateSyncAt: iso(alert.patrolLateSyncAt), patrolAnnotation: alert.patrolAnnotation ?? null,
          }
          : null,
        site: site ? { id: site.id, name: site.name, clientId: site.clientId, clientName: site.clientName, timeZone: site.timeZone } : null,
        siteDate: e.windowStart && site ? localDateOf(new Date(e.windowStart), site.timeZone) : null,
        shift: shift
          ? { id: Number(shift.id), start: iso(shift.start), end: iso(shift.end), status: shift.status, guardId: num(shift.guardId), guardName: shift.guardId == null ? null : guards.get(Number(shift.guardId)) ?? null }
          : null,
        guard: e.guardId == null ? null : { id: Number(e.guardId), name: guards.get(Number(e.guardId)) ?? null },
        scheduledWindow: { scheduleId: num(e.scheduleId), windowKey: e.windowKey ?? null, scopeKey: e.scopeKey ?? null, start: iso(e.windowStart), end: iso(e.windowEnd) },
        run: run
          ? { ...runJson(run), missingCheckpoints: missingIds.map((id) => ({ id, label: labels.get(id) ?? null })) }
          : null,
        evidence: {
          restricted: !evidenceAllowed,
          counts: photoCounts
            ? { total: Number(photoCounts.total), verified: Number(photoCounts.verified), pending: Number(photoCounts.pending), rejected: Number(photoCounts.rejected) }
            : null,
          items: evidenceAllowed ? evidenceRows.map(serializeEvidenceMetadata) : null,
        },
        delayedEvidence: {
          exceptionLateEvidenceAt: iso(e.lateEvidenceAt),
          alertLateSyncAt: iso(alert?.patrolLateSyncAt),
          runSyncedLate: run ? run.syncedLate === true : null,
          receivedAfterWindow: photoCounts ? Number(photoCounts.receivedAfterWindow) : null,
        },
        relatedPatrols: related.map(runJson),
        otherCasesForWindow: otherCases.map((x: any) => ({
          exceptionId: Number(x.id), type: x.type, status: x.status, alertId: num(x.safetyAlertId), alertStatus: x.alertStatus ?? null,
        })),
      };
    });
  }

  /**
   * One READ ONLY, REPEATABLE READ transaction for a whole read: every count and list of a response comes from the same
   * snapshot (a controller resolving a case meanwhile never makes the count and the list disagree), and the database itself
   * refuses any write.
   */
  private snapshot<T>(work: (db: Runner) => Promise<T>): Promise<T> {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      return work(manager);
    });
  }

  private async sites(db: Runner, companyId: number, siteId: number | null = null): Promise<SiteRow[]> {
    const rows = await db.query(
      `SELECT s."id", s."name", s."timezone", s."clientId", COALESCE(c."name", s."clientName") AS "clientName"
         FROM "sites" s LEFT JOIN "clients" c ON c."id" = s."clientId" AND c."companyId" = s."companyId"
        WHERE s."companyId" = $1 AND ($2::int IS NULL OR s."id" = $2) ORDER BY s."id"`,
      [companyId, siteId],
    );
    return rows.map((r: any) => ({ id: Number(r.id), name: r.name, timeZone: usableZone(r.timezone), clientId: num(r.clientId), clientName: r.clientName ?? null }));
  }

  private async guardNames(db: Runner, ids: Array<number | null>): Promise<Map<number, string>> {
    const unique = [...new Set(ids.filter((id): id is number => id != null))];
    if (!unique.length) return new Map();
    const rows = await db.query(`SELECT "id", "fullName" FROM "guard_profiles" WHERE "id" = ANY($1::int[])`, [unique]);
    return new Map(rows.map((r: any) => [Number(r.id), r.fullName]));
  }

  /** Display names only (first and last name, never an email). */
  private async userNames(db: Runner, ids: Array<number | null>): Promise<Map<number, string>> {
    const unique = [...new Set(ids.filter((id): id is number => id != null))];
    if (!unique.length) return new Map();
    const rows = await db.query(`SELECT "id", "firstName", "lastName" FROM "users" WHERE "id" = ANY($1::int[])`, [unique]);
    return new Map(rows.map((r: any) => [Number(r.id), personName(r.firstName, r.lastName)]));
  }
}

/** A reconciliation summary's site, from its patrolWindowKey ('reconciliation:site:{siteId}'); null for the horizon alert. */
function summarySite(patrolWindowKey: string | null): number | null {
  const m = /^reconciliation:site:(\d+)$/.exec(patrolWindowKey ?? '');
  return m ? Number(m[1]) : null;
}
