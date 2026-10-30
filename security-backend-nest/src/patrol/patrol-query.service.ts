import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { PatrolOverviewQueryDto, PatrolRunsQueryDto } from './dto/patrol.dto';
import { PatrolAccessService } from './patrol-access.service';
import { PATROL_RUN_STATUSES, PatrolErrorCode, patrolError } from './patrol-constants';
import { checkpointProgress } from './patrol-state';
import { localDateOf, siteDayBounds } from './patrol-window.service';

const DEFAULT_SITE_TIME_ZONE = 'Europe/London';

/** A site's zone if the runtime knows it, else the S4 default (as the sweep reads a site without one). */
export function usableZone(timeZone: unknown): string {
  if (typeof timeZone !== 'string' || !timeZone) return DEFAULT_SITE_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return timeZone;
  } catch {
    return DEFAULT_SITE_TIME_ZONE;
  }
}
import {
  serializeEvidenceMetadata,
  serializeException,
  serializeHold,
  serializeRun,
  serializeVisit,
} from './patrol-serializers';

const DEFAULT_PAGE_SIZE = 25;

/**
 * Company reads of stored patrol records. Runs, scans and exceptions need patrols.view; photo evidence metadata needs
 * patrols.evidence (a viewer sees only how many photos a run has); holds need patrols.holds. Nothing here schedules
 * or computes due windows — the windows due in a day are PatrolWindowsDayService (#78) — so the overview counts only
 * what is stored.
 */
@Injectable()
export class PatrolQueryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: PatrolAccessService,
  ) {}

  async listRuns(user: JwtPayload, query: PatrolRunsQueryDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    let where: string;
    let params: unknown[];
    if (query.dateBasis === 'site_local' && (query.from || query.to)) {
      // #77: each run on its own site's local days (the bounds are computed once per site, DST-safe).
      const days = await this.siteDays(actor.companyId, query.siteId ?? null, query.from ?? null, query.to ?? null);
      where = `r."companyId" = $1 AND ($2::int IS NULL OR r."siteId" = $2) AND ($3::text IS NULL OR r."status" = $3)
        AND EXISTS (SELECT 1 FROM unnest($4::int[], $5::timestamptz[], $6::timestamptz[]) AS b("siteId", "fromAt", "toAt")
                     WHERE b."siteId" = r."siteId" AND (b."fromAt" IS NULL OR r."startedAtServer" >= b."fromAt")
                       AND (b."toAt" IS NULL OR r."startedAtServer" < b."toAt"))`;
      params = [actor.companyId, query.siteId ?? null, query.status ?? null, days.siteIds, days.fromAt, days.toAt];
    } else {
      where = `r."companyId" = $1 AND ($2::int IS NULL OR r."siteId" = $2) AND ($3::text IS NULL OR r."status" = $3)
        AND ($4::date IS NULL OR r."startedAtServer" >= ($4::date)::timestamp AT TIME ZONE 'UTC')
        AND ($5::date IS NULL OR r."startedAtServer" < (($5::date) + 1)::timestamp AT TIME ZONE 'UTC')`;
      params = [actor.companyId, query.siteId ?? null, query.status ?? null, query.from ?? null, query.to ?? null];
    }
    const [{ total }] = await this.dataSource.query(`SELECT count(*)::int AS total FROM "patrol_runs" r WHERE ${where}`, params);
    const rows = await this.dataSource.query(
      `SELECT r.*, s."name" AS "siteName", g."fullName" AS "guardName",
              (SELECT count(*)::int FROM "patrol_checkpoint_visits" v WHERE v."runId" = r."id") AS "visitCount",
              (SELECT count(*)::int FROM "patrol_checkpoint_visits" v WHERE v."runId" = r."id" AND v."result" = 'flagged') AS "flaggedVisitCount"
         FROM "patrol_runs" r
         JOIN "sites" s ON s."id" = r."siteId"
         JOIN "guard_profiles" g ON g."id" = r."guardId"
        WHERE ${where}
        ORDER BY r."startedAtServer" DESC, r."id" DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    const progress = await this.progressFor(actor.companyId, rows);
    return {
      items: rows.map((r: any) => ({
        ...serializeRun(r),
        siteName: r.siteName,
        guardName: r.guardName,
        visitCount: Number(r.visitCount),
        flaggedVisitCount: Number(r.flaggedVisitCount),
        ...progress.get(Number(r.id))!,
      })),
      total: Number(total),
      page,
      pageSize,
    };
  }

  async getRun(user: JwtPayload, id: number) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    const run = await this.runRow(actor.companyId, id);
    const visits = await this.dataSource.query(
      `SELECT v.*, c."label" AS "checkpointLabel" FROM "patrol_checkpoint_visits" v
         LEFT JOIN "patrol_checkpoints" c ON c."id" = v."checkpointId"
        WHERE v."runId" = $1 AND v."companyId" = $2 ORDER BY v."scannedAtDevice", v."id"`,
      [id, actor.companyId],
    );
    const exceptions = await this.dataSource.query(
      `SELECT * FROM "patrol_exceptions" WHERE "runId" = $1 AND "companyId" = $2 ORDER BY "createdAt", "id"`,
      [id, actor.companyId],
    );
    const evidenceAllowed = this.access.holds(actor, CompanyPermission.PATROLS_EVIDENCE);
    const evidence = await this.dataSource.query(
      `SELECT * FROM "patrol_evidence" WHERE "runId" = $1 AND "companyId" = $2 ORDER BY "capturedAtDevice", "id"`,
      [id, actor.companyId],
    );
    const progress = await this.progressFor(actor.companyId, [run]);
    return {
      run: { ...serializeRun(run), siteName: run.siteName, guardName: run.guardName, ...progress.get(Number(run.id))! },
      visits: visits.map(serializeVisit),
      exceptions: exceptions.map(serializeException),
      evidenceCount: evidence.length,
      evidenceRestricted: !evidenceAllowed,
      evidence: evidenceAllowed ? evidence.map(serializeEvidenceMetadata) : null,
    };
  }

  /** Photo evidence metadata only (no image access in P1-A). patrols.evidence. */
  async getRunEvidence(user: JwtPayload, id: number) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_EVIDENCE);
    await this.runRow(actor.companyId, id);
    const rows = await this.dataSource.query(
      `SELECT * FROM "patrol_evidence" WHERE "runId" = $1 AND "companyId" = $2 ORDER BY "capturedAtDevice", "id"`,
      [id, actor.companyId],
    );
    return rows.map(serializeEvidenceMetadata);
  }

  /**
   * Simple counts from stored runs for one day (real due / missed scheduling is P1-B). dateBasis utc (the default): the
   * UTC day. site_local (#77): each site's OWN local day of `date` (siteDayBounds — 23 or 25 hours on a DST day), the
   * day basis the dashboard shows everywhere else; `date` defaults to today at the chosen site (Europe/London across
   * all sites).
   */
  async overview(user: JwtPayload, query: PatrolOverviewQueryDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    const siteId = query.siteId ?? null;
    const siteLocal = query.dateBasis === 'site_local';
    let date: string;
    let timeZone: string | null = null;
    // The day clause on an instant column, and its parameters from $3 on.
    let inDay: (column: string) => string;
    let dayParams: unknown[];
    if (siteLocal) {
      const sites = await this.companySites(actor.companyId, siteId);
      timeZone = siteId != null && sites.length ? sites[0].timezone : DEFAULT_SITE_TIME_ZONE;
      date = query.date ?? localDateOf(new Date(), timeZone);
      const days = this.daysFor(sites, date, date);
      inDay = (column) => `EXISTS (SELECT 1 FROM unnest($3::int[], $4::timestamptz[], $5::timestamptz[]) AS b("siteId", "fromAt", "toAt")
                                    WHERE b."siteId" = r."siteId" AND ${column} >= b."fromAt" AND ${column} < b."toAt")`;
      dayParams = [days.siteIds, days.fromAt, days.toAt];
    } else {
      date = query.date ?? new Date().toISOString().slice(0, 10);
      inDay = (column) => `${column} >= ($3::date)::timestamp AT TIME ZONE 'UTC' AND ${column} < (($3::date) + 1)::timestamp AT TIME ZONE 'UTC'`;
      dayParams = [date];
    }
    const statusRows = await this.dataSource.query(
      `SELECT r."status", count(*)::int AS n FROM "patrol_runs" r
        WHERE r."companyId" = $1 AND ($2::int IS NULL OR r."siteId" = $2) AND ${inDay('r."startedAtServer"')}
        GROUP BY r."status"`,
      [actor.companyId, siteId, ...dayParams],
    );
    const runsByStatus = Object.fromEntries(PATROL_RUN_STATUSES.map((s) => [s, 0])) as Record<string, number>;
    for (const r of statusRows) runsByStatus[r.status] = Number(r.n);
    const [counts] = await this.dataSource.query(
      `SELECT
         (SELECT count(*)::int FROM "patrol_runs" WHERE "companyId" = $1 AND ($2::int IS NULL OR "siteId" = $2) AND "status" = 'in_progress') AS "inProgressNow",
         (SELECT count(*)::int FROM "patrol_checkpoint_visits" v JOIN "patrol_runs" r ON r."id" = v."runId"
            WHERE v."companyId" = $1 AND ($2::int IS NULL OR r."siteId" = $2) AND v."result" = 'flagged'
              AND ${inDay('v."receivedAtServer"')}) AS "flaggedScans",
         (SELECT count(*)::int FROM "patrol_exceptions" WHERE "companyId" = $1 AND ($2::int IS NULL OR "siteId" = $2) AND "status" <> 'resolved') AS "openExceptions",
         (SELECT count(*)::int FROM "patrol_checkpoints" WHERE "companyId" = $1 AND ($2::int IS NULL OR "siteId" = $2) AND "active" AND "revokedAt" IS NULL) AS "activeCheckpoints",
         (SELECT count(*)::int FROM "patrol_schedules" WHERE "companyId" = $1 AND ($2::int IS NULL OR "siteId" = $2) AND "active" AND "archivedAt" IS NULL) AS "activeSchedules",
         (SELECT count(*)::int FROM "patrol_routes" WHERE "companyId" = $1 AND ($2::int IS NULL OR "siteId" = $2) AND "active" AND "archivedAt" IS NULL) AS "activeRoutes"`,
      [actor.companyId, siteId, ...dayParams],
    );
    return {
      date,
      dateBasis: siteLocal ? ('site_local' as const) : ('utc' as const),
      /** site_local with one site: that site's zone; across all sites each site is judged on its own (null here). */
      timeZone: siteLocal && siteId != null ? timeZone : null,
      siteId,
      runsStarted: Object.values(runsByStatus).reduce((a, b) => a + b, 0),
      runsByStatus,
      inProgressNow: Number(counts.inProgressNow),
      flaggedScans: Number(counts.flaggedScans),
      openExceptions: Number(counts.openExceptions),
      activeCheckpoints: Number(counts.activeCheckpoints),
      activeSchedules: Number(counts.activeSchedules),
      activeRoutes: Number(counts.activeRoutes),
    };
  }

  /** Evidence holds: active ones by default, or all (with releases) — placing and releasing them is P1-C. patrols.holds. */
  async listHolds(user: JwtPayload, status: 'active' | 'all' = 'active') {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_HOLDS);
    const rows = await this.dataSource.query(
      `SELECT * FROM "patrol_evidence_holds" WHERE "companyId" = $1 AND ($2::boolean OR "releasedAt" IS NULL)
        ORDER BY "createdAt" DESC, "id" DESC LIMIT 1000`,
      [actor.companyId, status === 'all'],
    );
    return rows.map(serializeHold);
  }

  /** The company's sites (or the one asked for, when it is the company's) with their time zones. */
  private async companySites(companyId: number, siteId: number | null): Promise<Array<{ id: number; timezone: string }>> {
    const rows = await this.dataSource.query(
      `SELECT "id", "timezone" FROM "sites" WHERE "companyId" = $1 AND ($2::int IS NULL OR "id" = $2) ORDER BY "id"`,
      [companyId, siteId],
    );
    return rows.map((r: any) => ({ id: Number(r.id), timezone: usableZone(r.timezone) }));
  }

  /**
   * Per site, the instants that bound site-local dates `from` … `to` inclusive (#77): from the first day's midnight to
   * the midnight after the last day, at THAT site's zone (siteDayBounds: the window engine's own conversion, DST-safe).
   * A missing end is open. As parallel arrays for unnest() in SQL.
   */
  private daysFor(sites: Array<{ id: number; timezone: string }>, from: string | null, to: string | null) {
    return {
      siteIds: sites.map((s) => s.id),
      fromAt: sites.map((s) => (from ? siteDayBounds(from, s.timezone).start.toISOString() : null)),
      toAt: sites.map((s) => (to ? siteDayBounds(to, s.timezone).end.toISOString() : null)),
    };
  }

  private async siteDays(companyId: number, siteId: number | null, from: string | null, to: string | null) {
    return this.daysFor(await this.companySites(companyId, siteId), from, to);
  }

  /**
   * Checkpoint progress of runs (#76), computed HERE, once, with the one definition in patrol-state.ts (checkpointProgress
   * / visitedCheckpointIds — the rule checkpoint_missed is judged by), for the History list and the run detail alike, so
   * the two views can never show different counts.
   */
  private async progressFor(companyId: number, runs: any[]) {
    const out = new Map<number, { checkpointsVisited: number; checkpointsTotal: number | null }>();
    if (!runs.length) return out;
    const routeIds = [...new Set(runs.filter((r) => r.routeId != null).map((r) => Number(r.routeId)))];
    const visits = await this.dataSource.query(
      `SELECT "runId", "checkpointId", "result" FROM "patrol_checkpoint_visits" WHERE "companyId" = $1 AND "runId" = ANY($2::int[])`,
      [companyId, runs.map((r) => Number(r.id))],
    );
    const routeCounts = new Map<number, number>();
    if (routeIds.length) {
      const counts = await this.dataSource.query(
        `SELECT "routeId", count(*)::int AS n FROM "patrol_route_checkpoints" WHERE "companyId" = $1 AND "routeId" = ANY($2::int[]) GROUP BY "routeId"`,
        [companyId, routeIds],
      );
      for (const row of counts) routeCounts.set(Number(row.routeId), Number(row.n));
    }
    for (const run of runs) {
      const id = Number(run.id);
      const runVisits = visits
        .filter((v: any) => Number(v.runId) === id)
        .map((v: any) => ({ checkpointId: v.checkpointId == null ? null : Number(v.checkpointId), result: String(v.result) }));
      out.set(id, checkpointProgress(runVisits, run.routeId == null ? null : routeCounts.get(Number(run.routeId)) ?? 0));
    }
    return out;
  }

  private async runRow(companyId: number, id: number) {
    const [run] = await this.dataSource.query(
      `SELECT r.*, s."name" AS "siteName", g."fullName" AS "guardName" FROM "patrol_runs" r
         JOIN "sites" s ON s."id" = r."siteId" JOIN "guard_profiles" g ON g."id" = r."guardId"
        WHERE r."id" = $1 AND r."companyId" = $2`,
      [id, companyId],
    );
    if (!run) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Patrol not found.');
    return run;
  }
}
