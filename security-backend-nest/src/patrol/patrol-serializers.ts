/**
 * Response shapes for Patrol Management. Rows are read with raw SQL; these map them to stable JSON (numbers as numbers,
 * instants as ISO strings). Nothing here ever includes a signing key or a label MAC.
 */

/**
 * Rows of an `UPDATE … RETURNING` run through TypeORM's raw query(): the Postgres driver answers UPDATE / DELETE with
 * [rows, affectedCount] (INSERT and SELECT with the rows alone).
 */
export async function updateRows(runner: { query: (sql: string, params?: unknown[]) => Promise<any> }, sql: string, params: unknown[]): Promise<any[]> {
  const result = await runner.query(sql, params);
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
}

const n = (v: unknown): number | null => (v == null ? null : Number(v));
const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
/** A `date` column as YYYY-MM-DD whether the driver returned a string or a Date (process clock is UTC). */
export const dateOnly = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

export function serializePolicyFields(row: any) {
  return {
    methods: row.methods,
    photosPerRun: Number(row.photosPerRun),
    photosPerCheckpoint: Number(row.photosPerCheckpoint),
    orderMode: row.orderMode,
    startGraceMinutes: Number(row.startGraceMinutes),
    maxPatrolDurationMinutes: Number(row.maxPatrolDurationMinutes),
    completionGraceMinutes: Number(row.completionGraceMinutes),
    syncGraceMinutes: Number(row.syncGraceMinutes),
    requirementScope: row.requirementScope,
    retentionDays: Number(row.retentionDays),
    incompleteNeedsAction: Boolean(row.incompleteNeedsAction),
    postShiftSyncHours: Number(row.postShiftSyncHours),
    clockDriftThresholdMinutes: Number(row.clockDriftThresholdMinutes),
    allowUnscheduledPatrols: Boolean(row.allowUnscheduledPatrols),
    escalateUnverified: Boolean(row.escalateUnverified),
    qrRequireProximity: Boolean(row.qrRequireProximity),
    proximityMeters: n(row.proximityMeters),
  };
}

export function serializeSchedule(row: any) {
  return {
    id: Number(row.id),
    siteId: Number(row.siteId),
    routeId: n(row.routeId),
    name: row.name,
    daysOfWeek: row.daysOfWeek,
    activeFrom: row.activeFrom,
    activeTo: row.activeTo,
    timeBasis: 'site_local' as const,
    frequencyMinutes: Number(row.frequencyMinutes),
    windowMinutes: Number(row.windowMinutes),
    startsOn: dateOnly(row.startsOn),
    endsOn: dateOnly(row.endsOn),
    active: Boolean(row.active),
    archivedAt: iso(row.archivedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function serializeCheckpoint(row: any) {
  return {
    id: Number(row.id),
    siteId: Number(row.siteId),
    publicId: row.publicId,
    label: row.label,
    description: row.description ?? null,
    tokenVersion: Number(row.tokenVersion),
    photoRequired: Boolean(row.photoRequired),
    active: Boolean(row.active),
    rotatedAt: iso(row.rotatedAt),
    revokedAt: iso(row.revokedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function serializeRoute(row: any, checkpoints: any[] | null) {
  return {
    id: Number(row.id),
    siteId: Number(row.siteId),
    name: row.name,
    orderMode: row.orderMode,
    active: Boolean(row.active),
    archivedAt: iso(row.archivedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    ...(checkpoints
      ? {
          checkpoints: checkpoints.map((c) => ({
            position: Number(c.position),
            required: Boolean(c.required),
            checkpointId: Number(c.checkpointId),
            publicId: c.publicId,
            label: c.label,
            active: Boolean(c.active),
            revoked: c.revokedAt != null,
          })),
        }
      : {}),
  };
}

export function serializeRun(row: any) {
  return {
    id: Number(row.id),
    clientRunId: row.clientRunId,
    siteId: Number(row.siteId),
    shiftId: Number(row.shiftId),
    guardId: Number(row.guardId),
    scheduleId: n(row.scheduleId),
    routeId: n(row.routeId),
    windowKey: row.windowKey ?? null,
    windowStart: iso(row.windowStart),
    windowEnd: iso(row.windowEnd),
    status: row.status,
    verificationStatus: row.verificationStatus,
    startedAtDevice: iso(row.startedAtDevice),
    startedAtServer: iso(row.startedAtServer),
    completedAtDevice: iso(row.completedAtDevice),
    completedAtServer: iso(row.completedAtServer),
    clockOffsetMs: n(row.clockOffsetMs),
    exceptionReason: row.exceptionReason ?? null,
    syncedLate: Boolean(row.syncedLate),
    lateStart: Boolean(row.lateStart),
    provisional: Boolean(row.provisional),
    needsReview: Boolean(row.needsReview),
    syncFlags: row.syncFlags ?? [],
    clockDriftMs: n(row.clockDriftMs),
    verifiedAt: iso(row.verifiedAt),
    verificationFinalAt: iso(row.verificationFinalAt),
  };
}

export function serializeVisit(row: any) {
  return {
    id: Number(row.id),
    clientVisitId: row.clientVisitId,
    runId: Number(row.runId),
    checkpointId: n(row.checkpointId),
    checkpointPublicId: row.scannedPublicId ?? null,
    checkpointLabel: row.checkpointLabel ?? null,
    method: row.method,
    result: row.result,
    flags: row.flags ?? [],
    provisional: Boolean(row.provisional),
    scannedAtDevice: iso(row.scannedAtDevice),
    receivedAtServer: iso(row.receivedAtServer),
    syncedLate: Boolean(row.syncedLate),
    syncFlags: row.syncFlags ?? [],
    clockDriftMs: n(row.clockDriftMs),
  };
}

export function serializeEvidenceMetadata(row: any) {
  return {
    id: Number(row.id),
    clientEvidenceId: row.clientEvidenceId,
    runId: Number(row.runId),
    visitId: n(row.visitId),
    kind: row.kind,
    source: row.source,
    mimeType: row.mimeType ?? null,
    sizeBytes: row.sizeBytes == null ? null : Number(row.sizeBytes),
    widthPx: n(row.widthPx),
    heightPx: n(row.heightPx),
    sha256Client: row.sha256Client,
    sha256Stored: row.sha256Stored ?? null,
    capturedAtDevice: iso(row.capturedAtDevice),
    receivedAt: iso(row.receivedAt),
    verifiedAt: iso(row.verifiedAt),
    uploadStatus: row.uploadStatus,
    retentionDays: n(row.retentionDays),
    expiresAt: iso(row.expiresAt),
    retentionStatus: row.retentionStatus,
    // P1-C (Migration 70). Never a storage key or URL: images are reached only through an audited, short-lived link.
    declaredSizeBytes: row.declaredSizeBytes == null ? null : Number(row.declaredSizeBytes),
    detectedMimeType: row.detectedMimeType ?? null,
    rejectionReason: row.rejectionReason ?? null,
    syncFlags: row.syncFlags ?? [],
    needsReview: Boolean(row.needsReview),
    deletionReason: row.deletionReason ?? null,
    quarantinedAt: iso(row.quarantinedAt),
    purgeAfter: iso(row.purgeAfter),
    purgedAt: iso(row.purgedAt),
    restoredAt: iso(row.restoredAt),
    objectDeletedAt: iso(row.objectDeletedAt),
  };
}

/** An evidence export record (P1-C). Never the storage key; the ZIP is reached only through an audited, short-lived link. */
export function serializeExport(row: any) {
  return {
    id: Number(row.id),
    status: row.status,
    purpose: row.purpose,
    siteId: n(row.siteId),
    fromDate: dateOnly(row.fromDate),
    toDate: dateOnly(row.toDate),
    runIds: (row.runIds ?? []).map(Number),
    itemCount: Number(row.itemCount),
    includedCount: Number(row.includedCount),
    excludedCount: Number(row.excludedCount),
    includedBytes: Number(row.includedBytes),
    zipBytes: row.zipBytes == null ? null : Number(row.zipBytes),
    zipSha256: row.zipSha256 ?? null,
    manifestSha256: row.manifestSha256 ?? null,
    requestedByUserId: Number(row.requestedByUserId),
    error: row.status === 'failed' ? row.error ?? null : null,
    attempts: Number(row.attempts),
    createdAt: iso(row.createdAt),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    expiresAt: iso(row.expiresAt),
  };
}

export function serializeException(row: any) {
  return {
    id: Number(row.id),
    siteId: Number(row.siteId),
    runId: n(row.runId),
    scheduleId: n(row.scheduleId),
    shiftId: n(row.shiftId),
    windowKey: row.windowKey,
    scopeKey: row.scopeKey,
    type: row.type,
    status: row.status,
    safetyAlertId: n(row.safetyAlertId),
    note: row.note ?? null,
    resolution: row.resolution ?? null,
    resolvedAt: iso(row.resolvedAt),
    createdAt: iso(row.createdAt),
    guardId: n(row.guardId),
    windowStart: iso(row.windowStart),
    windowEnd: iso(row.windowEnd),
    acknowledgedAt: iso(row.acknowledgedAt),
    lateEvidenceAt: iso(row.lateEvidenceAt),
    annotations: row.annotations ?? [],
    /** Migration 71 (#67): raised by outage reconciliation (its site's summary alert carries it), else null. */
    reconciliationRunId: n(row.reconciliationRunId),
  };
}

export function serializeHold(row: any) {
  return {
    id: Number(row.id),
    scope: row.scope,
    evidenceId: n(row.evidenceId),
    runId: n(row.runId),
    shiftId: n(row.shiftId),
    siteId: n(row.siteId),
    fromDate: dateOnly(row.fromDate),
    toDate: dateOnly(row.toDate),
    reason: row.reason,
    source: row.source,
    createdAt: iso(row.createdAt),
    releasedAt: iso(row.releasedAt),
    // P1-C: who placed / released it and what it is linked to.
    createdByUserId: n(row.createdByUserId),
    releasedByUserId: n(row.releasedByUserId),
    releaseReason: row.releaseReason ?? null,
    incidentId: n(row.incidentId),
    safetyAlertId: n(row.safetyAlertId),
    exceptionId: n(row.exceptionId),
  };
}
