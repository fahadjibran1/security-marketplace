import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { PatrolOverviewQueryDto, PatrolRunsQueryDto } from './dto/patrol.dto';
import { PatrolAccessService } from './patrol-access.service';
import { PATROL_RUN_STATUSES, PatrolErrorCode, patrolError } from './patrol-constants';
import { checkpointProgress } from './patrol-state';
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
 * or computes due windows — that is P1-B — so the overview counts only what is stored.
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
    const where = `r."companyId" = $1 AND ($2::int IS NULL OR r."siteId" = $2) AND ($3::text IS NULL OR r."status" = $3)
      AND ($4::date IS NULL OR r."startedAtServer" >= ($4::date)::timestamp AT TIME ZONE 'UTC')
      AND ($5::date IS NULL OR r."startedAtServer" < (($5::date) + 1)::timestamp AT TIME ZONE 'UTC')`;
    const params = [actor.companyId, query.siteId ?? null, query.status ?? null, query.from ?? null, query.to ?? null];
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
        LIMIT $6 OFFSET $7`,
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

  /** Simple counts from stored runs for one UTC day (real due / missed scheduling is P1-B). */
  async overview(user: JwtPayload, query: PatrolOverviewQueryDto) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    const date = query.date ?? new Date().toISOString().slice(0, 10);
    const siteId = query.siteId ?? null;
    const statusRows = await this.dataSource.query(
      `SELECT "status", count(*)::int AS n FROM "patrol_runs"
        WHERE "companyId" = $1 AND ($2::int IS NULL OR "siteId" = $2)
          AND "startedAtServer" >= ($3::date)::timestamp AT TIME ZONE 'UTC'
          AND "startedAtServer" < (($3::date) + 1)::timestamp AT TIME ZONE 'UTC'
        GROUP BY "status"`,
      [actor.companyId, siteId, date],
    );
    const runsByStatus = Object.fromEntries(PATROL_RUN_STATUSES.map((s) => [s, 0])) as Record<string, number>;
    for (const r of statusRows) runsByStatus[r.status] = Number(r.n);
    const [counts] = await this.dataSource.query(
      `SELECT
         (SELECT count(*)::int FROM "patrol_runs" WHERE "companyId" = $1 AND ($2::int IS NULL OR "siteId" = $2) AND "status" = 'in_progress') AS "inProgressNow",
         (SELECT count(*)::int FROM "patrol_checkpoint_visits" v JOIN "patrol_runs" r ON r."id" = v."runId"
            WHERE v."companyId" = $1 AND ($2::int IS NULL OR r."siteId" = $2) AND v."result" = 'flagged'
              AND v."receivedAtServer" >= ($3::date)::timestamp AT TIME ZONE 'UTC'
              AND v."receivedAtServer" < (($3::date) + 1)::timestamp AT TIME ZONE 'UTC') AS "flaggedScans",
         (SELECT count(*)::int FROM "patrol_exceptions" WHERE "companyId" = $1 AND ($2::int IS NULL OR "siteId" = $2) AND "status" <> 'resolved') AS "openExceptions",
         (SELECT count(*)::int FROM "patrol_checkpoints" WHERE "companyId" = $1 AND ($2::int IS NULL OR "siteId" = $2) AND "active" AND "revokedAt" IS NULL) AS "activeCheckpoints",
         (SELECT count(*)::int FROM "patrol_schedules" WHERE "companyId" = $1 AND ($2::int IS NULL OR "siteId" = $2) AND "active" AND "archivedAt" IS NULL) AS "activeSchedules",
         (SELECT count(*)::int FROM "patrol_routes" WHERE "companyId" = $1 AND ($2::int IS NULL OR "siteId" = $2) AND "active" AND "archivedAt" IS NULL) AS "activeRoutes"`,
      [actor.companyId, siteId, date],
    );
    return {
      date,
      dateBasis: 'utc' as const,
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
