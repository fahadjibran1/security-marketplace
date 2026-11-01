import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { JwtPayload } from '../../auth/types/jwt-payload.type';
import { CompanyPermission } from '../../company-membership/company-membership-types';
import { PatrolEvidencePatrolsQueryDto, PatrolEvidenceTreeQueryDto } from '../dto/patrol.dto';
import { PatrolAccessService } from '../patrol-access.service';
import { PatrolConfigService } from '../patrol-config.service';
import { PatrolErrorCode, patrolError } from '../patrol-constants';
import { usableZone } from '../patrol-query.service';
import { explainRuns } from '../patrol-run-evaluation';
import { serializeRun } from '../patrol-serializers';
import { addLocalDays, localDateOf, siteDayBounds } from '../patrol-window.service';
import { keyBelongsTo } from './patrol-evidence-keys';
import { renderStampedJpeg, StampFields } from './patrol-evidence-stamp';
import { PatrolObjectStore } from './patrol-object-store';

/** The longest evidence tree range (site-local days, inclusive). */
export const PATROL_EVIDENCE_TREE_MAX_DAYS = 92;
const TREE_DEFAULT_DAYS = 7;

/** A photo that is (or was meant to be) evidence: anything the device sent that S4 did not refuse. */
const PHOTO_BEARING = `e."uploadStatus" NOT IN ('rejected', 'local_corrupt')`;

/**
 * S4 1.3.0 B1 evidence reads (company accounts; the deciding checks are PatrolAccessService's — the caller's company, the
 * Patrols switch, the permission; another company's site, run or photo is 404, exactly like one that does not exist):
 *
 *   GET /patrols/evidence/tree?clientId&siteId&from&to   patrols.view: clients → sites → site-local days with patrols
 *                                                        (counts; patrols with / without photos). Default: the last 7 days.
 *   GET /patrols/evidence/patrols?siteId&date[&photos=only]
 *                                                        patrols.view: one site's patrols on one site-local day as cards
 *                                                        — run, window, Guard (display name), QR scans, verification and
 *                                                        its plain-English explanation; photos (ids, states, links to the
 *                                                        existing thumbnail page and the stamped view) only with
 *                                                        patrols.evidence. QR-only patrols are included; photos=only keeps
 *                                                        patrols with at least one photo.
 *   GET /patrols/evidence/:id/stamped                    patrols.evidence: the verified photo with the S4 stamp, derived per
 *                                                        request and streamed (never stored; the original is only read).
 *                                                        Same availability rule as viewing the original (409
 *                                                        PATROL_EVIDENCE_NOT_AVAILABLE for pending, rejected, quarantined,
 *                                                        purged or tombstoned photos), audited patrol.evidence_stamped_accessed.
 */
@Injectable()
export class PatrolEvidenceReadService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: PatrolAccessService,
    private readonly config: PatrolConfigService,
    private readonly store: PatrolObjectStore,
    private readonly auditLogService: AuditLogService,
  ) {}

  async tree(user: JwtPayload, query: PatrolEvidenceTreeQueryDto, now: Date = new Date()) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    if (query.clientId != null) {
      const [client] = await this.dataSource.query(`SELECT "id" FROM "clients" WHERE "id" = $1 AND "companyId" = $2`, [query.clientId, actor.companyId]);
      if (!client) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Client not found.');
    }
    const sites = await this.dataSource.query(
      `SELECT s."id", s."name", s."timezone", s."clientId", COALESCE(c."name", s."clientName") AS "clientName"
         FROM "sites" s LEFT JOIN "clients" c ON c."id" = s."clientId" AND c."companyId" = s."companyId"
        WHERE s."companyId" = $1 AND ($2::int IS NULL OR s."clientId" = $2) AND ($3::int IS NULL OR s."id" = $3)
        ORDER BY COALESCE(c."name", s."clientName") NULLS LAST, s."name", s."id"`,
      [actor.companyId, query.clientId ?? null, query.siteId ?? null],
    );
    if (query.siteId != null && !sites.length) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.SITE_NOT_FOUND, 'Site not found.');
    const firstZone = usableZone(sites[0]?.timezone);
    const to = query.to ?? localDateOf(now, firstZone);
    const from = query.from ?? addLocalDays(to, -(TREE_DEFAULT_DAYS - 1));
    if (from > to) throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'from must not be after to.');
    if (addLocalDays(from, PATROL_EVIDENCE_TREE_MAX_DAYS - 1) < to) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, `The range is at most ${PATROL_EVIDENCE_TREE_MAX_DAYS} days.`);
    }
    const zones = sites.map((s: any) => usableZone(s.timezone));
    const runs = sites.length
      ? await this.dataSource.query(
        `SELECT r."id", r."siteId", r."startedAtServer", EXISTS (SELECT 1 FROM "patrol_evidence" e WHERE e."runId" = r."id" AND ${PHOTO_BEARING}) AS "hasPhotos"
           FROM "patrol_runs" r
          WHERE r."companyId" = $1
            AND EXISTS (SELECT 1 FROM unnest($2::int[], $3::timestamptz[], $4::timestamptz[]) AS b("siteId", "fromAt", "toAt")
                         WHERE b."siteId" = r."siteId" AND r."startedAtServer" >= b."fromAt" AND r."startedAtServer" < b."toAt")`,
        [actor.companyId, sites.map((s: any) => Number(s.id)),
          zones.map((z: string) => siteDayBounds(from, z).start.toISOString()), zones.map((z: string) => siteDayBounds(to, z).end.toISOString())],
      )
      : [];
    const clients = new Map<string, { clientId: number | null; clientName: string | null; sites: any[] }>();
    sites.forEach((s: any, i: number) => {
      const timeZone = zones[i];
      const siteRuns = runs.filter((r: any) => Number(r.siteId) === Number(s.id));
      const days = new Map<string, { date: string; patrols: number; withPhotos: number; withoutPhotos: number }>();
      for (const r of siteRuns) {
        const date = localDateOf(new Date(r.startedAtServer), timeZone);
        const day = days.get(date) ?? { date, patrols: 0, withPhotos: 0, withoutPhotos: 0 };
        day.patrols += 1;
        if (r.hasPhotos) day.withPhotos += 1;
        else day.withoutPhotos += 1;
        days.set(date, day);
      }
      const key = s.clientId != null ? `id:${s.clientId}` : `name:${s.clientName ?? ''}`;
      const client = clients.get(key) ?? { clientId: s.clientId == null ? null : Number(s.clientId), clientName: s.clientName ?? null, sites: [] as any[] };
      client.sites.push({
        siteId: Number(s.id),
        siteName: s.name,
        timezone: timeZone,
        patrols: siteRuns.length,
        withPhotos: siteRuns.filter((r: any) => r.hasPhotos).length,
        days: [...days.values()].sort((a, b) => b.date.localeCompare(a.date)),
      });
      clients.set(key, client);
    });
    return { from, to, dateBasis: 'site_local' as const, clients: [...clients.values()] };
  }

  async patrols(user: JwtPayload, query: PatrolEvidencePatrolsQueryDto, now: Date = new Date()) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_VIEW);
    const [site] = await this.dataSource.query(
      `SELECT s."id", s."name", s."timezone", COALESCE(c."name", s."clientName") AS "clientName" FROM "sites" s
         LEFT JOIN "clients" c ON c."id" = s."clientId" AND c."companyId" = s."companyId"
        WHERE s."id" = $1 AND s."companyId" = $2`,
      [query.siteId, actor.companyId],
    );
    if (!site) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.SITE_NOT_FOUND, 'Site not found.');
    const timeZone = usableZone(site.timezone);
    const { start, end } = siteDayBounds(query.date, timeZone);
    const evidenceAllowed = this.access.holds(actor, CompanyPermission.PATROLS_EVIDENCE);
    const runs = await this.dataSource.query(
      `SELECT r.*, g."fullName" AS "guardName", sc."name" AS "scheduleName", sc."anchor" AS "scheduleAnchor"
         FROM "patrol_runs" r JOIN "guard_profiles" g ON g."id" = r."guardId" LEFT JOIN "patrol_schedules" sc ON sc."id" = r."scheduleId"
        WHERE r."companyId" = $1 AND r."siteId" = $2 AND r."startedAtServer" >= $3 AND r."startedAtServer" < $4
        ORDER BY r."startedAtServer", r."id"`,
      [actor.companyId, query.siteId, start, end],
    );
    const runIds = runs.map((r: any) => Number(r.id));
    const evidence = runIds.length
      ? await this.dataSource.query(
        `SELECT e."id", e."runId", e."visitId", e."kind", e."uploadStatus", e."retentionStatus", e."capturedAtDevice", e."receivedAt", e."verifiedAt",
                e."storageKey" FROM "patrol_evidence" e WHERE e."companyId" = $1 AND e."runId" = ANY($2::int[]) ORDER BY e."capturedAtDevice", e."id"`,
        [actor.companyId, runIds],
      )
      : [];
    const visits = runIds.length
      ? await this.dataSource.query(
        `SELECT v."id", v."runId", v."checkpointId", v."result", v."flags", v."scannedAtDevice", v."receivedAtServer", c."label"
           FROM "patrol_checkpoint_visits" v LEFT JOIN "patrol_checkpoints" c ON c."id" = v."checkpointId"
          WHERE v."companyId" = $1 AND v."runId" = ANY($2::int[]) ORDER BY v."scannedAtDevice", v."id"`,
        [actor.companyId, runIds],
      )
      : [];
    const policy = await this.config.effectivePolicy(actor.companyId, Number(site.id));
    const explained = await explainRuns(this.dataSource, actor.companyId, runs, async () => policy, now);
    const photoBearing = (e: any) => !['rejected', 'local_corrupt'].includes(e.uploadStatus);
    const cards = [];
    for (const r of runs) {
      const id = Number(r.id);
      const photos = evidence.filter((e: any) => Number(e.runId) === id);
      const photoCount = photos.filter(photoBearing).length;
      if (query.photos === 'only' && photoCount === 0) continue;
      const viewable = (e: any) => e.uploadStatus === 'verified' && ['active', 'claimed'].includes(e.retentionStatus)
        && typeof e.storageKey === 'string' && keyBelongsTo(e.storageKey, actor.companyId);
      cards.push({
        reference: `P-${id}`,
        run: serializeRun(r),
        window: r.windowStart && r.windowEnd ? {
          scheduleId: r.scheduleId == null ? null : Number(r.scheduleId),
          scheduleName: r.scheduleName ?? null,
          anchor: r.scheduleAnchor ?? null,
          windowKey: r.windowKey,
          start: new Date(r.windowStart).toISOString(),
          end: new Date(r.windowEnd).toISOString(),
          label: `${hhmm(new Date(r.windowStart), timeZone)}–${hhmm(new Date(r.windowEnd), timeZone)}`,
        } : null,
        guard: { id: Number(r.guardId), displayName: r.guardName },
        photoCount,
        photosRestricted: !evidenceAllowed,
        photos: evidenceAllowed ? photos.map((e: any) => ({
          id: Number(e.id),
          kind: e.kind,
          uploadStatus: e.uploadStatus,
          retentionStatus: e.retentionStatus,
          capturedAtDevice: e.capturedAtDevice ? new Date(e.capturedAtDevice).toISOString() : null,
          receivedAt: e.receivedAt ? new Date(e.receivedAt).toISOString() : null,
          verifiedAt: e.verifiedAt ? new Date(e.verifiedAt).toISOString() : null,
          viewable: viewable(e),
          stampedPath: viewable(e) ? `/patrols/evidence/${Number(e.id)}/stamped` : null,
        })) : null,
        thumbnailsPath: evidenceAllowed && photoCount ? `/patrols/runs/${id}/evidence/thumbnails` : null,
        qrScans: visits.filter((v: any) => Number(v.runId) === id).map((v: any) => ({
          id: Number(v.id),
          checkpointId: v.checkpointId == null ? null : Number(v.checkpointId),
          label: v.label ?? null,
          result: v.result,
          flags: v.flags ?? [],
          scannedAtDevice: v.scannedAtDevice ? new Date(v.scannedAtDevice).toISOString() : null,
          receivedAtServer: v.receivedAtServer ? new Date(v.receivedAtServer).toISOString() : null,
        })),
        verification: { status: r.verificationStatus, ...(explained.get(id) ?? { code: 'awaiting_check', text: 'Waiting for S4 to check this patrol.', deadline: null }) },
      });
    }
    return {
      siteId: Number(site.id),
      siteName: site.name,
      clientName: site.clientName ?? null,
      timezone: timeZone,
      date: query.date,
      dayStart: start.toISOString(),
      dayEnd: end.toISOString(),
      photos: query.photos === 'only' ? 'only' : 'all',
      evidenceRestricted: !evidenceAllowed,
      patrols: cards,
    };
  }

  /** The stamped JPEG of one verified photo (see the class comment). Returns the bytes to stream; nothing is stored. */
  async stamped(user: JwtPayload, id: number, now: Date = new Date()) {
    const actor = await this.access.companyActor(user, CompanyPermission.PATROLS_EVIDENCE);
    const [row] = await this.dataSource.query(`SELECT * FROM "patrol_evidence" WHERE "id" = $1 AND "companyId" = $2`, [id, actor.companyId]);
    if (!row) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Photo not found.');
    // Exactly the original's rule (PatrolEvidenceService.download): only a verified, active / claimed photo can be viewed.
    if (row.uploadStatus !== 'verified' || !['active', 'claimed'].includes(row.retentionStatus)) {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EVIDENCE_NOT_AVAILABLE, 'This photo is not available to view.', {
        uploadStatus: row.uploadStatus, retentionStatus: row.retentionStatus,
      });
    }
    if (!keyBelongsTo(row.storageKey, actor.companyId)) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Photo not found.');
    const storage = this.store.config(); // 503 when storage is unavailable (after the caller's own authorisation)
    const [ctx] = await this.dataSource.query(
      `SELECT co."name" AS "companyName", s."name" AS "siteName", s."timezone", COALESCE(cl."name", s."clientName") AS "clientName",
              g."fullName" AS "guardName", r."id" AS "runId", r."windowStart", r."windowEnd", sc."name" AS "scheduleName"
         FROM "patrol_runs" r JOIN "companies" co ON co."id" = r."companyId" JOIN "sites" s ON s."id" = r."siteId"
         LEFT JOIN "clients" cl ON cl."id" = s."clientId" AND cl."companyId" = s."companyId"
         JOIN "guard_profiles" g ON g."id" = r."guardId" LEFT JOIN "patrol_schedules" sc ON sc."id" = r."scheduleId"
        WHERE r."id" = $1 AND r."companyId" = $2`,
      [row.runId, actor.companyId],
    );
    if (!ctx) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Photo not found.');
    const original = await this.readObject(row.storageKey, storage.maxObjectBytes);
    const originalSha256 = createHash('sha256').update(original).digest('hex');
    if (row.sha256Stored && originalSha256 !== row.sha256Stored) {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EVIDENCE_STAMP_UNAVAILABLE, 'The stored photo no longer matches its verified fingerprint, so it is not stamped.');
    }
    const fields: StampFields = {
      companyName: ctx.companyName,
      clientName: ctx.clientName ?? null,
      siteName: ctx.siteName,
      guardName: ctx.guardName,
      capturedAtDevice: row.capturedAtDevice ? new Date(row.capturedAtDevice) : null,
      receivedAtServer: row.receivedAt ? new Date(row.receivedAt) : row.verifiedAt ? new Date(row.verifiedAt) : null,
      timeZone: usableZone(ctx.timezone),
      runId: Number(ctx.runId),
      window: ctx.windowStart && ctx.windowEnd ? { start: new Date(ctx.windowStart), end: new Date(ctx.windowEnd), name: ctx.scheduleName ?? null } : null,
    };
    let rendered: Awaited<ReturnType<typeof renderStampedJpeg>>;
    try {
      rendered = await renderStampedJpeg(original, fields);
    } catch {
      throw patrolError(HttpStatus.UNPROCESSABLE_ENTITY, PatrolErrorCode.EVIDENCE_STAMP_UNAVAILABLE,
        'This photo cannot be stamped (its format cannot be read by the server). View the original instead.');
    }
    await this.auditLogService.log({
      company: { id: actor.companyId },
      user: { id: actor.userId },
      action: 'patrol.evidence_stamped_accessed',
      entityType: 'patrol_evidence',
      entityId: Number(row.id),
      afterData: {
        runId: Number(row.runId), siteId: Number(row.siteId), sha256: originalSha256, stampedBytes: rendered.jpeg.length,
        derived: true, stored: false, at: now.toISOString(),
      },
    });
    return { evidenceId: Number(row.id), jpeg: rendered.jpeg, fileName: `patrol-evidence-${Number(row.id)}-stamped.jpg`, originalSha256 };
  }

  /** The object's bytes, bounded (a stored photo is never larger than the upload cap). */
  private async readObject(key: string, maxBytes: number): Promise<Buffer> {
    const stream = await this.store.getStream(key);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes + 1024) {
        stream.destroy();
        throw patrolError(HttpStatus.UNPROCESSABLE_ENTITY, PatrolErrorCode.EVIDENCE_STAMP_UNAVAILABLE, 'This photo is too large to stamp.');
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }
}

function hhmm(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  } catch {
    return at.toISOString().slice(11, 16);
  }
}
