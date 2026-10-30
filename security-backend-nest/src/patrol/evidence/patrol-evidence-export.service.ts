import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { JwtPayload } from '../../auth/types/jwt-payload.type';
import { CreatePatrolEvidenceExportDto } from '../dto/patrol-evidence.dto';
import { PatrolAccessService } from '../patrol-access.service';
import { PatrolErrorCode, patrolError } from '../patrol-constants';
import { serializeExport, updateRows } from '../patrol-serializers';
import { keyBelongsTo, patrolObjectKey } from './patrol-evidence-keys';
import {
  PATROL_EXPORT_MAX_ATTEMPTS,
  PATROL_EXPORT_MAX_BYTES,
  PATROL_EXPORT_MAX_ITEMS,
  PATROL_EXPORT_MAX_OPEN_PER_COMPANY,
  PATROL_EXPORT_MAX_RANGE_DAYS,
  PATROL_EXPORT_STALE_RUNNING_MS,
  PATROL_EXPORT_TTL_HOURS,
  adjustUsage,
  heldSql,
  safeError,
} from './patrol-evidence-shared';
import { PatrolObjectStore, PatrolStorageError } from './patrol-object-store';
import { ZipFileWriter } from './patrol-zip-writer';

const EXTENSION: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp' };
export const PATROL_EXPORT_MANIFEST_SCHEMA = 's4.patrol-evidence-export/1';

type Scope = { siteId: number | null; fromDate: string | null; toDate: string | null; runIds: number[] };

/**
 * Bulk evidence exports with a manifest (Patrols P1-C). Owner / Admin (patrols.holds).
 *
 * REQUEST (POST /patrols/exports): a scope — run ids, or a site-local date range of at most 31 days, optionally one site —
 * bounded to 500 photos and 512 MiB, at most 2 exports in flight per company. Recorded (queued) and audited with its
 * purpose; built asynchronously.
 *
 * BUILD: one export at a time per process (claimed with a token, FOR UPDATE SKIP LOCKED, so instances never build the same
 * one). Photos are streamed from storage straight into a ZIP on local disk (stored, not deflated) — never held in memory —
 * and re-hashed on the way (a photo whose bytes no longer match its recorded SHA-256 is still included but marked
 * integrity "mismatch" and audited). The ZIP holds photos/run-{run}/evidence-{id}.{ext}, manifest.json (every photo in
 * scope: ids, run, checkpoint, site, device capture time, server receipt time, SHA-256, verification status, flags, hold
 * status, whether it is included and if not why — not verified, rejected, deleted / quarantined, purged, missing),
 * manifest.csv (the same, spreadsheet-safe) and manifest.json.sha256. The ZIP goes to the private bucket under
 * patrol-exports/ for 24 hours; the export record keeps the SHA-256 of the ZIP and of the manifest.
 *
 * DOWNLOAD (GET /patrols/exports/:id/download): a presigned GET (60–300 s) while ready; every issue audited.
 * EXPIRY (maintenance job): after 24 h the ZIP is deleted and the record becomes "expired" (kept, with its hashes).
 */
@Injectable()
export class PatrolEvidenceExportService {
  private readonly logger = new Logger(PatrolEvidenceExportService.name);
  private chain: Promise<unknown> = Promise.resolve();
  private kickQueued = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly access: PatrolAccessService,
    private readonly store: PatrolObjectStore,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ═══════════════════════ API ═══════════════════════

  async request(user: JwtPayload, dto: CreatePatrolEvidenceExportDto, now: Date = new Date()) {
    const actor = await this.access.evidenceLifecycleActor(user);
    const companyId = actor.companyId;
    const scope: Scope = { siteId: dto.siteId ?? null, fromDate: dto.fromDate ?? null, toDate: dto.toDate ?? null, runIds: dto.runIds ?? [] };
    if (!scope.runIds.length && !(scope.fromDate && scope.toDate)) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'An export needs runIds, or a fromDate and toDate.');
    }
    if ((scope.fromDate === null) !== (scope.toDate === null)) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'Give both fromDate and toDate, or neither.');
    }
    if (scope.fromDate && scope.toDate) {
      const days = (Date.parse(`${scope.toDate}T00:00:00Z`) - Date.parse(`${scope.fromDate}T00:00:00Z`)) / 86_400_000 + 1;
      if (days < 1) throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.VALIDATION, 'toDate is before fromDate.');
      if (days > PATROL_EXPORT_MAX_RANGE_DAYS) {
        throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.EXPORT_TOO_LARGE, `An export covers at most ${PATROL_EXPORT_MAX_RANGE_DAYS} days.`);
      }
    }
    if (scope.siteId !== null && !(await this.dataSource.query(`SELECT 1 FROM "sites" WHERE "id" = $1 AND "companyId" = $2`, [scope.siteId, companyId])).length) {
      throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.SITE_NOT_FOUND, 'Site not found.');
    }
    if (scope.runIds.length) {
      const [{ n }] = await this.dataSource.query(`SELECT count(*)::int AS n FROM "patrol_runs" WHERE "id" = ANY($1::int[]) AND "companyId" = $2`, [scope.runIds, companyId]);
      if (Number(n) !== scope.runIds.length) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Patrol not found.');
    }
    this.store.config(); // 503 when storage is unavailable
    const rows = await this.scopeRows(companyId, scope);
    const bytes = rows.filter(includable).reduce((a: number, r: any) => a + Number(r.sizeBytes ?? 0), 0);
    if (rows.length > PATROL_EXPORT_MAX_ITEMS || bytes > PATROL_EXPORT_MAX_BYTES) {
      throw patrolError(HttpStatus.BAD_REQUEST, PatrolErrorCode.EXPORT_TOO_LARGE,
        `An export holds at most ${PATROL_EXPORT_MAX_ITEMS} photos and ${PATROL_EXPORT_MAX_BYTES} bytes; narrow the scope.`,
        { maxItems: PATROL_EXPORT_MAX_ITEMS, maxBytes: PATROL_EXPORT_MAX_BYTES, items: Math.min(rows.length, PATROL_EXPORT_MAX_ITEMS + 1) });
    }
    const created = await this.dataSource.transaction(async (manager) => {
      // Serialise per company so the in-flight bound holds under concurrent requests.
      await manager.query(`SELECT "id" FROM "companies" WHERE "id" = $1 FOR UPDATE`, [companyId]);
      const [{ open }] = await manager.query(
        `SELECT count(*)::int AS open FROM "patrol_evidence_exports" WHERE "companyId" = $1 AND "status" IN ('queued', 'running')`, [companyId]);
      if (Number(open) >= PATROL_EXPORT_MAX_OPEN_PER_COMPANY) {
        throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EXPORT_LIMIT_REACHED, `At most ${PATROL_EXPORT_MAX_OPEN_PER_COMPANY} exports can be in progress at once.`);
      }
      const [row] = await manager.query(
        `INSERT INTO "patrol_evidence_exports" ("companyId", "requestedByUserId", "purpose", "siteId", "fromDate", "toDate", "runIds", "itemCount")
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING *`,
        [companyId, actor.userId, dto.purpose, scope.siteId, scope.fromDate, scope.toDate, JSON.stringify(scope.runIds), rows.length],
      );
      await this.auditLogService.logInTransaction(manager, {
        company: { id: companyId },
        user: { id: actor.userId },
        action: 'patrol.evidence_export_requested',
        entityType: 'patrol_evidence_export',
        entityId: Number(row.id),
        afterData: { purpose: dto.purpose, ...scope, itemCount: rows.length, includableBytes: bytes, requestedAt: now.toISOString() },
      });
      return row;
    });
    this.kick();
    return serializeExport(created);
  }

  async list(user: JwtPayload) {
    const actor = await this.access.evidenceLifecycleActor(user);
    const rows = await this.dataSource.query(`SELECT * FROM "patrol_evidence_exports" WHERE "companyId" = $1 ORDER BY "createdAt" DESC, "id" DESC LIMIT 200`, [actor.companyId]);
    return rows.map(serializeExport);
  }

  async get(user: JwtPayload, id: number) {
    const actor = await this.access.evidenceLifecycleActor(user);
    return serializeExport(await this.companyExport(actor.companyId, id));
  }

  async download(user: JwtPayload, id: number, now: Date = new Date()) {
    const actor = await this.access.evidenceLifecycleActor(user);
    const row = await this.companyExport(actor.companyId, id);
    if (row.status !== 'ready' || !row.expiresAt || new Date(row.expiresAt).getTime() <= now.getTime()) {
      throw patrolError(HttpStatus.CONFLICT, PatrolErrorCode.EXPORT_NOT_READY, 'This export is not ready, or has expired.', { status: row.status });
    }
    const access = this.store.presignDownload(row.storageKey, { contentType: 'application/zip', fileName: `patrol-evidence-export-${row.id}.zip`, now });
    await this.auditLogService.log({
      company: { id: actor.companyId },
      user: { id: actor.userId },
      action: 'patrol.evidence_export_downloaded',
      entityType: 'patrol_evidence_export',
      entityId: Number(row.id),
      afterData: { purpose: row.purpose, zipSha256: row.zipSha256, manifestSha256: row.manifestSha256, linkExpiresAt: access.expiresAt },
    });
    return { exportId: Number(row.id), method: access.method, url: access.url, expiresAt: access.expiresAt, zipSha256: row.zipSha256, manifestSha256: row.manifestSha256 };
  }

  private async companyExport(companyId: number, id: number) {
    const [row] = await this.dataSource.query(`SELECT * FROM "patrol_evidence_exports" WHERE "id" = $1 AND "companyId" = $2`, [id, companyId]);
    if (!row) throw patrolError(HttpStatus.NOT_FOUND, PatrolErrorCode.NOT_FOUND, 'Export not found.');
    return row;
  }

  // ═══════════════════════ Build ═══════════════════════

  /** Starts a build pass soon, in this process, one at a time (requests do not wait for it). */
  kick(): void {
    if (this.kickQueued) return;
    this.kickQueued = true;
    this.chain = this.chain
      .then(() => {
        this.kickQueued = false;
        return this.processPending();
      })
      .catch((error) => this.logger.error(JSON.stringify({ event: 'patrol_export_pass_failed', error: safeError(error) })));
  }

  /** Resolves when any build pass started by kick() has finished. */
  whenIdle(): Promise<unknown> {
    return this.chain;
  }

  /** Builds every claimable export (queued, retryable failed, or stale running). Returns how many were attempted. */
  async processPending(now: Date = new Date(), limit = 5): Promise<number> {
    if (!this.store.available()) return 0;
    let attempted = 0;
    for (; attempted < limit; attempted += 1) {
      const [claimed] = await updateRows(this.dataSource,
        `UPDATE "patrol_evidence_exports" SET "status" = 'running', "claimToken" = gen_random_uuid(), "claimedAt" = $1,
            "startedAt" = COALESCE("startedAt", $1), "attempts" = "attempts" + 1, "error" = NULL, "updatedAt" = now()
          WHERE "id" = (
            SELECT "id" FROM "patrol_evidence_exports"
             WHERE "status" = 'queued' OR ("status" = 'failed' AND "attempts" < $2 AND "updatedAt" < $4) OR ("status" = 'running' AND "claimedAt" < $3)
             ORDER BY "id" LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING *`,
        // A failed build is retried on a later pass (≥ 5 minutes on), never immediately, so a failing store is not hammered.
        [now, PATROL_EXPORT_MAX_ATTEMPTS, new Date(now.getTime() - PATROL_EXPORT_STALE_RUNNING_MS), new Date(now.getTime() - 5 * 60 * 1000)],
      );
      if (!claimed) break;
      await this.build(claimed, now);
    }
    return attempted;
  }

  private async scopeRows(companyId: number, scope: Scope) {
    return this.dataSource.query(
      `SELECT e.*, s."name" AS "siteName", v."checkpointId", c."label" AS "checkpointLabel", ${heldSql('e')} AS "held"
         FROM "patrol_evidence" e
         JOIN "patrol_runs" r ON r."id" = e."runId" AND r."companyId" = e."companyId"
         JOIN "sites" s ON s."id" = e."siteId" AND s."companyId" = e."companyId"
         LEFT JOIN "patrol_checkpoint_visits" v ON v."id" = e."visitId" AND v."companyId" = e."companyId"
         LEFT JOIN "patrol_checkpoints" c ON c."id" = v."checkpointId" AND c."companyId" = e."companyId"
        WHERE e."companyId" = $1
          AND ($2::int IS NULL OR e."siteId" = $2)
          AND ($3::date IS NULL OR (e."capturedAtDevice" AT TIME ZONE COALESCE(s."timezone", 'Europe/London'))::date >= $3::date)
          AND ($4::date IS NULL OR (e."capturedAtDevice" AT TIME ZONE COALESCE(s."timezone", 'Europe/London'))::date <= $4::date)
          AND (cardinality($5::int[]) = 0 OR e."runId" = ANY($5::int[]))
        ORDER BY e."runId", e."capturedAtDevice", e."id"
        LIMIT ${PATROL_EXPORT_MAX_ITEMS + 1}`,
      [companyId, scope.siteId, scope.fromDate, scope.toDate, scope.runIds],
    );
  }

  private async build(exp: any, now: Date) {
    const companyId = Number(exp.companyId);
    const token = exp.claimToken as string;
    const tmp = path.join(os.tmpdir(), `s4-patrol-export-${randomUUID()}.zip`);
    let uploadedKey: string | null = null;
    let zip: ZipFileWriter | null = null;
    try {
      // An export already requested is built whether or not Patrols is still switched on (#71): the switch stops new
      // patrol activity, never the handling of evidence that already exists.
      const config = this.store.config();
      const scope: Scope = { siteId: exp.siteId == null ? null : Number(exp.siteId), fromDate: dateOnly(exp.fromDate), toDate: dateOnly(exp.toDate), runIds: (exp.runIds ?? []).map(Number) };
      const rows = await this.scopeRows(companyId, scope);
      const includableBytes = rows.filter(includable).reduce((a: number, r: any) => a + Number(r.sizeBytes ?? 0), 0);
      if (rows.length > PATROL_EXPORT_MAX_ITEMS || includableBytes > PATROL_EXPORT_MAX_BYTES) throw new Error('scope_exceeds_bounds');

      zip = await ZipFileWriter.create(tmp);
      const items: any[] = [];
      let includedBytes = 0;
      for (const row of rows) {
        const item = manifestItem(row);
        if (includable(row) && keyBelongsTo(row.storageKey, companyId)) {
          const fileName = `photos/run-${Number(row.runId)}/evidence-${Number(row.id)}.${EXTENSION[row.detectedMimeType ?? row.mimeType] ?? 'img'}`;
          try {
            const stream = await this.store.getStream(row.storageKey);
            const hash = createHash('sha256');
            const { size } = await zip.addStream(fileName, stream, new Date(row.capturedAtDevice), (chunk) => hash.update(chunk));
            const sha = hash.digest('hex');
            item.included = true;
            item.fileName = fileName;
            item.exportedSizeBytes = size;
            item.integrity = sha === row.sha256Stored ? 'ok' : 'mismatch';
            includedBytes += size;
            if (item.integrity === 'mismatch') {
              await this.auditLogService.log({
                company: { id: companyId }, user: null, action: 'patrol.evidence_integrity_mismatch', entityType: 'patrol_evidence', entityId: Number(row.id),
                afterData: { exportId: Number(exp.id), recordedSha256: row.sha256Stored, exportedSha256: sha },
              });
            }
          } catch (error) {
            if (!(error instanceof PatrolStorageError && error.code === 'not_found')) throw error;
            item.included = false;
            item.exclusionReason = 'object_missing';
            await this.auditLogService.log({
              company: { id: companyId }, user: null, action: 'patrol.evidence_object_missing', entityType: 'patrol_evidence', entityId: Number(row.id),
              afterData: { exportId: Number(exp.id), retentionStatus: row.retentionStatus },
            });
          }
        }
        items.push(item);
      }
      const included = items.filter((i) => i.included).length;
      const manifest = {
        schema: PATROL_EXPORT_MANIFEST_SCHEMA,
        exportId: Number(exp.id),
        companyId,
        generatedAt: now.toISOString(),
        purpose: exp.purpose,
        requestedByUserId: Number(exp.requestedByUserId),
        scope,
        counts: { items: items.length, included, excluded: items.length - included, held: items.filter((i) => i.held).length },
        includedBytes,
        hashAlgorithm: 'sha256',
        items,
      };
      const manifestJson = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      const manifestSha256 = createHash('sha256').update(manifestJson).digest('hex');
      await zip.addBuffer('manifest.json', manifestJson, now);
      await zip.addBuffer('manifest.csv', Buffer.from(manifestCsv(items), 'utf8'), now);
      await zip.addBuffer('manifest.json.sha256', Buffer.from(`${manifestSha256}  manifest.json\n`, 'utf8'), now);
      const zipBytes = await zip.close();
      zip = null;
      const zipSha256 = await sha256File(tmp);
      const key = patrolObjectKey('export', companyId, now, config.prefix);
      await this.store.putFile(key, tmp, { sizeBytes: zipBytes, contentType: 'application/zip', sha256Hex: zipSha256 });
      uploadedKey = key;
      const expiresAt = new Date(now.getTime() + PATROL_EXPORT_TTL_HOURS * 3_600_000);
      const ready = await this.dataSource.transaction(async (manager) => {
        const [done] = await updateRows(manager,
          `UPDATE "patrol_evidence_exports" SET "status" = 'ready', "storageKey" = $3, "zipBytes" = $4, "zipSha256" = $5, "manifestSha256" = $6,
              "itemCount" = $7, "includedCount" = $8, "excludedCount" = $9, "includedBytes" = $10, "completedAt" = $11, "expiresAt" = $12,
              "claimToken" = NULL, "claimedAt" = NULL, "error" = NULL, "updatedAt" = now()
            WHERE "id" = $1 AND "status" = 'running' AND "claimToken" = $2 RETURNING *`,
          [exp.id, token, key, zipBytes, zipSha256, manifestSha256, items.length, included, items.length - included, includedBytes, now, expiresAt],
        );
        if (!done) return null;
        await adjustUsage(manager, companyId, null, { exportObjects: 1, exportBytes: zipBytes });
        await this.auditLogService.logInTransaction(manager, {
          company: { id: companyId }, user: null, action: 'patrol.evidence_export_ready', entityType: 'patrol_evidence_export', entityId: Number(exp.id),
          beforeData: { status: 'running' },
          afterData: { status: 'ready', items: items.length, included, excluded: items.length - included, zipBytes, zipSha256, manifestSha256, expiresAt: expiresAt.toISOString() },
        });
        return done;
      });
      if (!ready) await this.store.delete(key).catch(() => undefined); // another builder took it over
    } catch (error) {
      if (zip) await zip.abort();
      if (uploadedKey) await this.store.delete(uploadedKey).catch(() => undefined);
      const reason = safeError(error);
      this.logger.warn(JSON.stringify({ event: 'patrol_export_failed', exportId: Number(exp.id), error: reason }));
      await this.dataSource.transaction(async (manager) => {
        const [failed] = await updateRows(manager,
          `UPDATE "patrol_evidence_exports" SET "status" = 'failed', "error" = $3, "claimToken" = NULL, "claimedAt" = NULL, "updatedAt" = now()
            WHERE "id" = $1 AND "status" = 'running' AND "claimToken" = $2 RETURNING "attempts"`,
          [exp.id, token, reason],
        );
        if (failed) {
          await this.auditLogService.logInTransaction(manager, {
            company: { id: companyId }, user: null, action: 'patrol.evidence_export_failed', entityType: 'patrol_evidence_export', entityId: Number(exp.id),
            afterData: { error: reason, attempts: Number(failed.attempts), willRetry: Number(failed.attempts) < PATROL_EXPORT_MAX_ATTEMPTS },
          });
        }
      }).catch(() => undefined);
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
  }

  /** Deletes expired export ZIPs (the records stay, with their hashes). */
  async expire(now: Date = new Date(), limit = 50): Promise<number> {
    if (!this.store.available()) return 0;
    const due = await this.dataSource.query(
      `SELECT * FROM "patrol_evidence_exports" WHERE "status" = 'ready' AND "expiresAt" <= $1 ORDER BY "expiresAt" LIMIT $2`, [now, limit]);
    let expired = 0;
    for (const exp of due) {
      try {
        await this.store.delete(exp.storageKey);
      } catch (error) {
        this.logger.warn(JSON.stringify({ event: 'patrol_export_expiry_deferred', exportId: Number(exp.id), error: safeError(error) }));
        continue;
      }
      await this.dataSource.transaction(async (manager) => {
        const [done] = await updateRows(manager,
          `UPDATE "patrol_evidence_exports" SET "status" = 'expired', "objectDeletedAt" = $2, "updatedAt" = now() WHERE "id" = $1 AND "status" = 'ready' RETURNING *`,
          [exp.id, now],
        );
        if (!done) return;
        expired += 1;
        await adjustUsage(manager, Number(exp.companyId), null, { exportObjects: -1, exportBytes: -Number(exp.zipBytes ?? 0) });
        await this.auditLogService.logInTransaction(manager, {
          company: { id: Number(exp.companyId) }, user: null, action: 'patrol.evidence_export_expired', entityType: 'patrol_evidence_export', entityId: Number(exp.id),
          beforeData: { status: 'ready' }, afterData: { status: 'expired', zipSha256: exp.zipSha256, objectDeletedAt: now.toISOString() },
        });
      });
    }
    return expired;
  }
}

function includable(row: any): boolean {
  return row.uploadStatus === 'verified' && ['active', 'claimed'].includes(row.retentionStatus);
}

function exclusionReason(row: any): string | null {
  if (includable(row)) return null;
  if (row.uploadStatus === 'rejected') return 'rejected_upload';
  if (['pending', 'uploaded', 'local_corrupt'].includes(row.uploadStatus)) return 'not_verified';
  if (row.retentionStatus === 'quarantined') return 'deleted_in_quarantine';
  return 'purged';
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const dateOnly = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

function manifestItem(row: any) {
  return {
    evidenceId: Number(row.id),
    clientEvidenceId: row.clientEvidenceId,
    runId: Number(row.runId),
    visitId: row.visitId == null ? null : Number(row.visitId),
    kind: row.kind,
    checkpointId: row.checkpointId == null ? null : Number(row.checkpointId),
    checkpointLabel: row.checkpointLabel ?? null,
    siteId: Number(row.siteId),
    siteName: row.siteName,
    shiftId: Number(row.shiftId),
    guardId: Number(row.guardId),
    capturedAtDevice: iso(row.capturedAtDevice),
    serverReceivedAt: iso(row.receivedAt),
    verifiedAt: iso(row.verifiedAt),
    sha256Declared: row.sha256Client,
    sha256: row.sha256Stored ?? null,
    sizeBytes: row.sizeBytes == null ? null : Number(row.sizeBytes),
    mimeType: row.detectedMimeType ?? row.mimeType ?? null,
    verificationStatus: row.uploadStatus,
    rejectionReason: row.rejectionReason ?? null,
    retentionStatus: row.retentionStatus,
    expiresAt: iso(row.expiresAt),
    syncFlags: row.syncFlags ?? [],
    needsReview: Boolean(row.needsReview),
    held: row.held === true,
    included: false as boolean,
    exclusionReason: exclusionReason(row) as string | null,
    fileName: null as string | null,
    exportedSizeBytes: null as number | null,
    integrity: null as 'ok' | 'mismatch' | null,
  };
}

const CSV_COLUMNS = [
  'evidenceId', 'runId', 'visitId', 'kind', 'checkpointId', 'checkpointLabel', 'siteId', 'siteName', 'shiftId', 'capturedAtDevice', 'serverReceivedAt',
  'verifiedAt', 'sha256', 'sizeBytes', 'mimeType', 'verificationStatus', 'rejectionReason', 'retentionStatus', 'held', 'included', 'exclusionReason',
  'integrity', 'syncFlags', 'needsReview', 'fileName',
] as const;

/** RFC 4180 CSV; a text cell that a spreadsheet would treat as a formula is prefixed with an apostrophe. */
export function manifestCsv(items: any[]): string {
  const cell = (value: unknown) => {
    let text = value == null ? '' : Array.isArray(value) ? value.join(' ') : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [CSV_COLUMNS.join(','), ...items.map((item) => CSV_COLUMNS.map((c) => cell(item[c])).join(','))].join('\r\n') + '\r\n';
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
