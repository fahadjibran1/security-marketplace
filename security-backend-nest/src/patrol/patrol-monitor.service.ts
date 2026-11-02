import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { effectiveAttendance } from '../attendance/effective-attendance';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CompanyPermission } from '../company-membership/company-membership-types';
import { PatrolMonitorSiteQueryDto, PatrolMonitorSummaryQueryDto } from './dto/patrol-monitor.dto';
import { PatrolAccessService } from './patrol-access.service';
import { PATROL_POLICY_DEFAULTS, PatrolErrorCode, patrolError } from './patrol-constants';
import {
  buildSiteModel,
  floorToLocalHour,
  MONITOR_EXCLUDED_SHIFT_STATUSES,
  MonitorCounts,
  MonitorException,
  MonitorPolicy,
  MonitorRun,
  MonitorShift,
  MonitorSiteModel,
  MonitorSiteStatus,
} from './patrol-monitor-model';
import { usableZone } from './patrol-query.service';
import { loadRunEvaluationContext, runRequirements } from './patrol-run-evaluation';
import { scheduleVersionBounds, supersededSince, withVersionBounds } from './patrol-schedule-versions';
import { serializePolicyFields } from './patrol-serializers';
import { setupFor, shiftAnchoredSchedules, siteSetups } from './patrol-shift-context';
import { setupActive } from './patrol-shift-windows';
import { localDateOf, wallMinutesToInstant } from './patrol-window.service';

/** The live view's longest range (a night shift plus context, on one screen). */
export const PATROL_MONITOR_MAX_RANGE_HOURS = 36;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DAY_MINUTES = 1440;
/** The patrol safety-alert types (safety-alert.entity.ts PATROL_ALERT_TYPES; Live Operations shows these). */
const PATROL_ALERT_TYPES = ['patrol_missed', 'patrol_abandoned', 'patrol_incomplete', 'checkpoint_missed', 'patrol_unverified'];
const STATUS_ORDER: MonitorSiteStatus[] = ['attention', 'watch', 'on_track', 'not_started', 'no_patrols'];

type SiteRow = { id: number; name: string; timeZone: string; clientId: number | null; clientName: string | null };
type Range = { from: Date; to: Date };
/** Request-scoped wall-clock conversion caches, one per time zone (dropped with the request; never global). */
type ConversionCaches = Map<string, Map<string, number>> | null;

/** The cache of one zone, or none when caching is off. */
function cacheFor(caches: ConversionCaches, timeZone: string): Map<string, number> | undefined {
  if (!caches) return undefined;
  let cache = caches.get(timeZone);
  if (!cache) {
    cache = new Map();
    caches.set(timeZone, cache);
  }
  return cache;
}

/** siteDayBounds through the zone's request cache: the same two wallMinutesToInstant conversions, each made once. */
function dayBounds(localDate: string, timeZone: string, caches: ConversionCaches): Range {
  const cache = cacheFor(caches, timeZone);
  return { from: new Date(wallMinutesToInstant(localDate, 0, timeZone, cache)), to: new Date(wallMinutesToInstant(localDate, DAY_MINUTES, timeZone, cache)) };
}

/** Site row → company default row → PATROL_POLICY_DEFAULTS (PatrolConfigService.effectivePolicy, from rows read once). */
export function resolvePolicy(rows: any[], siteId: number) {
  const site = rows.find((r) => r.siteId != null && Number(r.siteId) === siteId);
  const company = rows.find((r) => r.siteId == null);
  return serializePolicyFields(site ?? company ?? PATROL_POLICY_DEFAULTS);
}

/**
 * Patrol Monitor (S4 Patrol Monitor S1): read-only, company-scoped (patrols.view; 404 while Patrols is off), one batch
 * of queries per request whatever the number of sites or hours — sites, policies, schedules and versions, setups, shifts
 * and attendance, runs and exceptions in the range, the sweep watermark — and the windows computed in memory by the
 * existing engines (patrol-monitor-model.ts). Nothing is written; no image or evidence object is read.
 *
 *   GET /patrols/monitor/summary          one row per site with patrols (status, counts) and the Live Operations counts
 *   GET /patrols/monitor/sites/:siteId    lanes × hours for one site (the site day, or a live range ≤ 36 h), with the
 *                                         run summaries a cell opens (checkpoint progress, photo counts)
 */
@Injectable()
export class PatrolMonitorService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: PatrolAccessService,
  ) {}

  async summary(user: JwtPayload, query: PatrolMonitorSummaryQueryDto, now: Date = new Date()) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    const companyId = actor.companyId;
    if (query.clientId != null) {
      const [client] = await this.dataSource.query(`SELECT "id" FROM "clients" WHERE "id" = $1 AND "companyId" = $2`, [query.clientId, companyId]);
      if (!client) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Client not found.');
    }
    const sites = await this.sites(companyId, query.siteId ?? null, query.clientId ?? null);
    if (query.siteId != null && !sites.length) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.SITE_NOT_FOUND, 'Site not found.');
    const caches = this.conversionCaches();
    const days = new Map<number, Range & { date: string }>();
    for (const s of sites) {
      const date = query.date ?? localDateOf(now, s.timeZone);
      days.set(s.id, { date, ...dayBounds(date, s.timeZone, caches) });
    }
    const loaded = await this.load(companyId, sites, (s) => days.get(s.id)!, now, caches);
    const rows = sites
      .map((s) => ({ site: s, day: days.get(s.id)!, model: loaded.models.get(s.id)!, configured: loaded.configured.has(s.id) }))
      .filter((r) => r.configured || query.siteId != null)
      .map(({ site, day, model }) => ({
        siteId: site.id,
        siteName: site.name,
        clientId: site.clientId,
        clientName: site.clientName,
        timeZone: site.timeZone,
        date: day.date,
        dayStart: day.from.toISOString(),
        dayEnd: day.to.toISOString(),
        status: model.status,
        counts: model.counts,
        lanes: model.lanes.length,
        nextWindowStart: model.nextWindowStart,
      }))
      .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.siteName.localeCompare(b.siteName) || a.siteId - b.siteId);

    const totals = Object.fromEntries(Object.keys(rows[0]?.counts ?? emptyCounts()).map((k) => [k, rows.reduce((n, r) => n + (r.counts as any)[k], 0)])) as MonitorCounts;
    const byStatus = Object.fromEntries(STATUS_ORDER.map((s) => [s, rows.filter((r) => r.status === s).length])) as Record<MonitorSiteStatus, number>;
    const dates = [...new Set(rows.map((r) => r.date))];
    return {
      generatedAt: now.toISOString(),
      dateBasis: 'site_local' as const,
      date: query.date ?? (dates.length === 1 ? dates[0] : null),
      sweep: { judgedThrough: loaded.judgedThrough?.toISOString() ?? null },
      totals: { sites: rows.length, byStatus, ...totals },
      liveOps: await this.liveOps(companyId, now, caches),
      sites: rows,
    };
  }

  async site(user: JwtPayload, siteId: number, query: PatrolMonitorSiteQueryDto, now: Date = new Date()) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    const companyId = actor.companyId;
    const [site] = await this.sites(companyId, siteId, null);
    if (!site) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.SITE_NOT_FOUND, 'Site not found.');
    const caches = this.conversionCaches();
    const range = this.siteRange(site, query, now, caches);
    const loaded = await this.load(companyId, [site], () => range, now, caches);
    const model = loaded.models.get(site.id)!;
    const policy = loaded.policies.get(site.id)!;

    // The run summaries the cells open: who did it, checkpoint progress (unique required checkpoints, repeats never
    // counted twice), photo counts. Counts only — no evidence object, URL or image is read here.
    const runs = loaded.runs.filter((r) => r.siteId === site.id);
    const runSummaries = await this.runSummaries(companyId, runs, policy);
    const guardIds = [...new Set([...runs.map((r) => r.guardId), ...loaded.shifts.filter((s) => s.siteId === site.id && s.guardId != null).map((s) => s.guardId!)])];
    const guardNames = await this.guardNames(guardIds);
    const exceptionIds = new Set([...model.lanes.flatMap((l) => l.windows.flatMap((w) => w.exceptionIds)), ...model.otherRuns.flatMap((o) => o.exceptionIds)]);
    const exceptions = loaded.exceptions.filter((e) => exceptionIds.has(e.id));
    return {
      generatedAt: now.toISOString(),
      siteId: site.id,
      siteName: site.name,
      clientId: site.clientId,
      clientName: site.clientName,
      timeZone: site.timeZone,
      range: { from: range.from.toISOString(), to: range.to.toISOString(), date: range.date },
      sweep: { judgedThrough: loaded.judgedThrough?.toISOString() ?? null },
      policy: {
        requirementScope: policy.requirementScope,
        methods: policy.methods,
        startGraceMinutes: policy.startGraceMinutes,
        photoRequired: policy.methods.includes('photo') || policy.photosPerRun > 0,
      },
      setup: { active: setupActive(loaded.setups.get(site.id)!), mode: loaded.setups.get(site.id)!.setupMode },
      status: model.status,
      counts: model.counts,
      nextWindowStart: model.nextWindowStart,
      hours: model.hours,
      lanes: model.lanes.map((l) => ({ ...l, guardName: l.guardId == null ? null : guardNames.get(l.guardId) ?? null })),
      runs: Object.fromEntries(runs.map((r) => [r.id, { ...runSummaries.get(r.id)!, guardName: guardNames.get(r.guardId) ?? null }])),
      otherRuns: model.otherRuns,
      exceptions: Object.fromEntries(exceptions.map((e) => [e.id, {
        id: e.id, type: e.type, status: e.status, runId: e.runId, alertId: e.safetyAlertId, alertStatus: e.alertStatus,
      }])),
    };
  }

  /** The site day (date, today by default) or a live range [from, to) of at most 36 h, starting on a site-local hour. */
  private siteRange(site: SiteRow, query: PatrolMonitorSiteQueryDto, now: Date, caches: ConversionCaches): Range & { date: string | null } {
    const invalid = (message: string) => patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, message);
    if (query.from || query.to) {
      if (query.date) throw invalid('Give either date or from and to, not both.');
      if (!query.from || !query.to) throw invalid('from and to go together.');
      const from = floorToLocalHour(new Date(query.from), site.timeZone);
      const to = new Date(query.to);
      if (!(to.getTime() > from.getTime())) throw invalid('to must be after from.');
      if (to.getTime() - from.getTime() > PATROL_MONITOR_MAX_RANGE_HOURS * HOUR_MS) {
        throw invalid(`The range is at most ${PATROL_MONITOR_MAX_RANGE_HOURS} hours.`);
      }
      return { from, to, date: null };
    }
    const date = query.date ?? localDateOf(now, site.timeZone);
    return { ...dayBounds(date, site.timeZone, caches), date };
  }

  /**
   * One request's conversion caches (one per time zone), so a clock schedule's windows are computed once per site and
   * the conversions are shared by every site in the zone. Null computes every lane on its own — the original path, which
   * the equivalence tests use as the reference.
   */
  protected conversionCaches(): ConversionCaches {
    return new Map();
  }

  private async sites(companyId: number, siteId: number | null, clientId: number | null): Promise<SiteRow[]> {
    const rows = await this.dataSource.query(
      `SELECT s."id", s."name", s."timezone", s."clientId", COALESCE(c."name", s."clientName") AS "clientName"
         FROM "sites" s LEFT JOIN "clients" c ON c."id" = s."clientId" AND c."companyId" = s."companyId"
        WHERE s."companyId" = $1 AND ($2::int IS NULL OR s."id" = $2) AND ($3::int IS NULL OR s."clientId" = $3)
        ORDER BY s."name", s."id"`,
      [companyId, siteId, clientId],
    );
    return rows.map((r: any) => ({
      id: Number(r.id), name: r.name, timeZone: usableZone(r.timezone),
      clientId: r.clientId == null ? null : Number(r.clientId), clientName: r.clientName ?? null,
    }));
  }

  /** Everything the model needs for these sites, in one batch of company-scoped queries (never one per site or hour). */
  private async load(companyId: number, sites: SiteRow[], rangeOf: (s: SiteRow) => Range, now: Date, caches: ConversionCaches) {
    const siteIds = sites.map((s) => s.id);
    const ranges = new Map(sites.map((s) => [s.id, rangeOf(s)]));
    const minFrom = new Date(Math.min(...[...ranges.values()].map((r) => r.from.getTime()), now.getTime()));
    const maxTo = new Date(Math.max(...[...ranges.values()].map((r) => r.to.getTime()), now.getTime()));
    const policyRows = await this.dataSource.query(`SELECT * FROM "patrol_policies" WHERE "companyId" = $1`, [companyId]);
    const policies = new Map(siteIds.map((id) => [id, resolvePolicy(policyRows, id)]));
    const versions = await scheduleVersionBounds(this.dataSource, companyId);
    const since = new Date(minFrom.getTime() - DAY_MS);
    const clock = siteIds.length
      ? (await this.dataSource.query(
        `SELECT * FROM "patrol_schedules" WHERE "companyId" = $1 AND "siteId" = ANY($2::int[]) AND "anchor" = 'clock'
            AND (("active" AND "archivedAt" IS NULL) OR "id" = ANY($3::int[])) ORDER BY "id"`,
        [companyId, siteIds, supersededSince(versions, since)],
      )).map((s: any) => withVersionBounds(s, versions))
      : [];
    const setups = await siteSetups(this.dataSource, companyId, siteIds);
    const setupBySite = new Map(siteIds.map((id) => [id, setupFor(setups, id)]));
    const activeSites = siteIds.filter((id) => setupActive(setupBySite.get(id)!));
    const shiftSchedules = activeSites.length ? await shiftAnchoredSchedules(this.dataSource, companyId, activeSites, versions, since) : [];

    // Shifts across the ranges (a shift-anchored window belongs to a shift that may have started before the range).
    const shiftRows = siteIds.length
      ? await this.dataSource.query(
        `SELECT "id", "siteId", "guardId", "status"::text AS "status", "start", "end", "patrolRequirement" FROM "shifts"
          WHERE "companyId" = $1 AND "siteId" = ANY($2::int[]) AND "start" < $3 AND "end" > $4 AND NOT ("status"::text = ANY($5::text[]))`,
        [companyId, siteIds, maxTo, minFrom, MONITOR_EXCLUDED_SHIFT_STATUSES],
      )
      : [];
    const attendance = shiftRows.length
      ? await this.dataSource.query(
        `SELECT "id", "shiftId", "type"::text AS "type", "occurredAt", "recordedAt", "correctionOfEventId", "source"
           FROM "attendance_events" WHERE "shiftId" = ANY($1::int[])`,
        [shiftRows.map((s: any) => Number(s.id))],
      )
      : [];
    const attendanceByShift = new Map<number, any[]>();
    for (const a of attendance) attendanceByShift.set(Number(a.shiftId), [...(attendanceByShift.get(Number(a.shiftId)) ?? []), a]);
    const shifts: Array<MonitorShift & { siteId: number }> = shiftRows.map((s: any) => {
      // As the sweep reads duty (judgeWindows): the shift's effective attendance, every row of the shift.
      const eff = effectiveAttendance(attendanceByShift.get(Number(s.id)) ?? []);
      return {
        id: Number(s.id), siteId: Number(s.siteId), guardId: s.guardId == null ? null : Number(s.guardId), status: String(s.status),
        start: new Date(s.start), end: new Date(s.end), patrolRequirement: s.patrolRequirement ?? null,
        monitoredFrom: eff.monitoredFrom ?? null, bookOnAt: eff.bookOnAt ?? null, bookOffAt: eff.bookOffAt ?? null,
      };
    });

    // Runs for windows starting in the ranges, and runs with no window started in them (unscheduled / already covered).
    const runRows = siteIds.length
      ? await this.dataSource.query(
        `SELECT "id", "siteId", "routeId", "scheduleId", "windowKey", "scopeKey", "windowStart", "windowEnd", "status", "verificationStatus",
                "lateStart", "startedAtDevice", "startedAtServer", "completedAtServer", "guardId", "shiftId", "syncFlags"
           FROM "patrol_runs"
          WHERE "companyId" = $1 AND "siteId" = ANY($2::int[])
            AND (("windowStart" >= $3 AND "windowStart" < $4) OR ("windowStart" IS NULL AND "startedAtServer" >= $3 AND "startedAtServer" < $4))`,
        [companyId, siteIds, minFrom, maxTo],
      )
      : [];
    const runs: MonitorRun[] = runRows
      .map((r: any) => ({
        id: Number(r.id), siteId: Number(r.siteId), routeId: r.routeId == null ? null : Number(r.routeId), scheduleId: r.scheduleId == null ? null : Number(r.scheduleId),
        windowKey: r.windowKey ?? null, scopeKey: r.scopeKey ?? null,
        windowStart: r.windowStart ? new Date(r.windowStart) : null, windowEnd: r.windowEnd ? new Date(r.windowEnd) : null,
        status: String(r.status), verificationStatus: String(r.verificationStatus), lateStart: r.lateStart === true,
        startedAtDevice: new Date(r.startedAtDevice), startedAtServer: new Date(r.startedAtServer),
        completedAtServer: r.completedAtServer ? new Date(r.completedAtServer) : null,
        guardId: Number(r.guardId), shiftId: Number(r.shiftId), syncFlags: Array.isArray(r.syncFlags) ? r.syncFlags.map(String) : [],
      }))
      .filter((r: any) => {
        const range = ranges.get(r.siteId)!;
        const at = (r.windowStart ?? r.startedAtServer).getTime();
        return at >= range.from.getTime() && at < range.to.getTime();
      });
    const runIds = runs.map((r) => r.id);
    const exceptionRows = siteIds.length
      ? await this.dataSource.query(
        `SELECT e."id", e."siteId", e."type", e."status", e."windowKey", e."scopeKey", e."runId", e."safetyAlertId", a."status" AS "alertStatus"
           FROM "patrol_exceptions" e LEFT JOIN "safety_alerts" a ON a."id" = e."safetyAlertId"
          WHERE e."companyId" = $1 AND e."siteId" = ANY($2::int[])
            AND ((e."windowStart" >= $3 AND e."windowStart" < $4) OR e."runId" = ANY($5::int[]))`,
        [companyId, siteIds, minFrom, maxTo, runIds],
      )
      : [];
    const exceptions: Array<MonitorException & { siteId: number }> = exceptionRows.map((e: any) => ({
      id: Number(e.id), siteId: Number(e.siteId), type: String(e.type), status: String(e.status), windowKey: e.windowKey ?? null,
      scopeKey: e.scopeKey ?? null, runId: e.runId == null ? null : Number(e.runId),
      safetyAlertId: e.safetyAlertId == null ? null : Number(e.safetyAlertId), alertStatus: e.alertStatus ?? null,
    }));
    const [watermark] = await this.dataSource.query(`SELECT "judgedThrough" FROM "patrol_sweep_watermarks" WHERE "companyId" = $1`, [companyId]);
    const judgedThrough = watermark ? new Date(watermark.judgedThrough) : null;

    const models = new Map<number, MonitorSiteModel>();
    const configured = new Set<number>();
    for (const site of sites) {
      const policy = policies.get(site.id)!;
      const siteClock = clock.filter((s: any) => Number(s.siteId) === site.id);
      const siteShiftSchedules = shiftSchedules.filter((s: any) => Number(s.siteId) === site.id);
      if (siteClock.length || siteShiftSchedules.length) configured.add(site.id);
      const range = ranges.get(site.id)!;
      models.set(site.id, buildSiteModel({
        now,
        from: range.from,
        to: range.to,
        timeZone: site.timeZone,
        policy: policy as unknown as MonitorPolicy,
        setup: setupBySite.get(site.id)!,
        clockSchedules: siteClock,
        shiftSchedules: siteShiftSchedules,
        shifts: shifts.filter((s) => s.siteId === site.id),
        runs: runs.filter((r) => r.siteId === site.id),
        exceptions: exceptions.filter((e) => e.siteId === site.id),
        judgedThrough,
        conversionCache: cacheFor(caches, site.timeZone),
      }));
    }
    return { models, configured, policies, setups: setupBySite, shifts, runs, exceptions, judgedThrough };
  }

  /**
   * Live Operations counts (company-wide, as Live Operations lists them):
   *   openPatrolAlerts   patrol safety alerts that are not closed — exactly the patrol items Attention Now shows. Each
   *                      actionable exception has exactly one alert, so nothing is counted twice; a reconciliation
   *                      summary alert is one item however many windows it covers.
   *   missedToday        missed patrol WINDOWS (patrol_missed exceptions, one per window and scope) whose window started
   *                      today at their site (site-local day), in any status — the history of the day, including windows
   *                      found by outage reconciliation; missedTodayOpen = those not resolved.
   */
  private async liveOps(companyId: number, now: Date, caches: ConversionCaches) {
    const [alerts] = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM "safety_alerts" WHERE "companyId" = $1 AND "type"::text = ANY($2::text[]) AND "status"::text <> 'closed'`,
      [companyId, PATROL_ALERT_TYPES],
    );
    const sites = await this.sites(companyId, null, null);
    const days = sites.map((s) => dayBounds(localDateOf(now, s.timeZone), s.timeZone, caches));
    const [missed] = sites.length
      ? await this.dataSource.query(
        `SELECT count(DISTINCT (e."windowKey", e."scopeKey"))::int AS "total",
                count(DISTINCT (e."windowKey", e."scopeKey")) FILTER (WHERE e."status" <> 'resolved')::int AS "open"
           FROM "patrol_exceptions" e
           JOIN unnest($2::int[], $3::timestamptz[], $4::timestamptz[]) AS b("siteId", "fromAt", "toAt") ON b."siteId" = e."siteId"
          WHERE e."companyId" = $1 AND e."type" = 'patrol_missed' AND e."windowStart" >= b."fromAt" AND e."windowStart" < b."toAt"`,
        [companyId, sites.map((s) => s.id), days.map((d) => d.from.toISOString()), days.map((d) => d.to.toISOString())],
      )
      : [{ total: 0, open: 0 }];
    return { openPatrolAlerts: Number(alerts.n), missedToday: Number(missed.total), missedTodayOpen: Number(missed.open) };
  }

  /** Per run: checkpoint progress and photo counts (the sweep's own requirement rule; counts only, no evidence object). */
  private async runSummaries(companyId: number, runs: MonitorRun[], policy: ReturnType<typeof resolvePolicy>) {
    const out = new Map<number, any>();
    if (!runs.length) return out;
    const ctx = await loadRunEvaluationContext(this.dataSource, companyId, runs);
    const scanRows = await this.dataSource.query(
      `SELECT "runId", count(*)::int AS "scans", count(*) FILTER (WHERE "result" = 'flagged')::int AS "flagged",
              count(*) FILTER (WHERE "flags" @> '["duplicate_in_run"]'::jsonb)::int AS "repeats"
         FROM "patrol_checkpoint_visits" WHERE "companyId" = $1 AND "runId" = ANY($2::int[]) GROUP BY "runId"`,
      [companyId, runs.map((r) => r.id)],
    );
    const scans = new Map<number, any>(scanRows.map((r: any) => [Number(r.runId), r]));
    const qr = policy.methods.includes('qr');
    for (const run of runs) {
      const req = runRequirements(run, policy, ctx);
      // QR required: the run's route version's required, active, unrevoked checkpoints (the verification rule's set; no
      // route ⇒ 0 and qrRuleMissing). QR not required (photo-only): no checkpoint set at all.
      const required = qr ? ctx.routeCheckpoints.filter((rc: any) => run.routeId != null && Number(rc.routeId) === run.routeId && rc.required).length : null;
      const evidence = ctx.evidence.filter((e: any) => Number(e.runId) === run.id);
      const s = scans.get(run.id);
      out.set(run.id, {
        id: run.id,
        guardId: run.guardId,
        shiftId: run.shiftId,
        status: run.status,
        verificationStatus: run.verificationStatus,
        lateStart: run.lateStart,
        windowStart: run.windowStart?.toISOString() ?? null,
        windowEnd: run.windowEnd?.toISOString() ?? null,
        startedAtServer: run.startedAtServer.toISOString(),
        startedAtDevice: run.startedAtDevice.toISOString(),
        completedAtServer: run.completedAtServer?.toISOString() ?? null,
        checkpoints: {
          // Unique required checkpoints verified, of the required set; repeat scans never count twice.
          required,
          verified: required == null ? null : Math.max(0, required - req.missingCheckpointIds.length),
          scans: Number(s?.scans ?? 0),
          repeatScans: Number(s?.repeats ?? 0),
          flaggedScans: Number(s?.flagged ?? 0),
          qrRuleMissing: req.qrRuleMissing,
        },
        photos: {
          taken: evidence.filter((e: any) => !['rejected', 'local_corrupt'].includes(e.uploadStatus)).length,
          verified: evidence.filter((e: any) => e.uploadStatus === 'verified' && ['active', 'claimed'].includes(e.retentionStatus ?? 'active')).length,
          missing: req.missingRunPhotos + req.missingCheckpointPhotos,
        },
      });
    }
    return out;
  }

  private async guardNames(ids: number[]): Promise<Map<number, string>> {
    if (!ids.length) return new Map();
    const rows = await this.dataSource.query(`SELECT "id", "fullName" FROM "guard_profiles" WHERE "id" = ANY($1::int[])`, [ids]);
    return new Map(rows.map((r: any) => [Number(r.id), r.fullName]));
  }
}

function emptyCounts(): MonitorCounts {
  return {
    windows: 0, owed: 0, verified: 0, verifiedOnTime: 0, lateVerified: 0, inProgress: 0, awaitingVerification: 0, missed: 0,
    missedOpen: 0, incomplete: 0, flagged: 0, notVerified: 0, overdue: 0, due: 0, awaitingCheck: 0, future: 0,
    verificationOverdue: 0, openExceptions: 0, openAlerts: 0,
  };
}
