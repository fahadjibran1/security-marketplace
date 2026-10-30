/**
 * Patrol Management (S4 Patrols Phase 1) — the company dashboard's view of the P1-A/B/C API.
 *
 * These mirror the backend serializers (security-backend-nest/src/patrol/patrol-serializers.ts and the query / evidence
 * services) field for field. Nothing here is computed on the client: every figure the dashboard shows comes from one
 * of these responses. A storage key, a signing key or a label MAC never appears in any of them.
 */

export type PatrolRunStatus = 'in_progress' | 'completed' | 'incomplete' | 'closed_by_system';
export type PatrolVerificationStatus = 'pending' | 'verified' | 'unverified' | 'flagged';
export type PatrolExceptionType =
  | 'patrol_missed'
  | 'patrol_late'
  | 'patrol_incomplete'
  | 'checkpoint_missed'
  | 'evidence_unverified'
  | 'patrol_abandoned';
export type PatrolExceptionStatus = 'open' | 'acknowledged' | 'resolved';
export type PatrolEvidenceUploadStatus = 'pending' | 'uploaded' | 'verified' | 'rejected' | 'local_corrupt';
export type PatrolEvidenceRetentionStatus = 'active' | 'claimed' | 'quarantined' | 'purged' | 'tombstone';
export type PatrolHoldScope = 'evidence' | 'run' | 'shift' | 'site_date_range';
export type PatrolRequirementScope = 'site' | 'per_guard';
export type PatrolOrderMode = 'any' | 'strict';
export type PatrolMethod = 'qr' | 'photo';

export const PATROL_RUN_STATUSES: PatrolRunStatus[] = ['in_progress', 'completed', 'incomplete', 'closed_by_system'];
export const PATROL_EVIDENCE_ACCESS_PURPOSES = ['review', 'incident', 'investigation', 'client_request', 'legal', 'audit', 'other'] as const;
export const PATROL_EXPORT_PURPOSES = ['incident', 'investigation', 'client_request', 'legal', 'audit', 'other'] as const;
export type PatrolEvidenceAccessPurpose = (typeof PATROL_EVIDENCE_ACCESS_PURPOSES)[number];
export type PatrolExportPurpose = (typeof PATROL_EXPORT_PURPOSES)[number];

export interface PatrolPolicyFields {
  methods: PatrolMethod[];
  photosPerRun: number;
  photosPerCheckpoint: number;
  orderMode: PatrolOrderMode;
  startGraceMinutes: number;
  maxPatrolDurationMinutes: number;
  completionGraceMinutes: number;
  syncGraceMinutes: number;
  requirementScope: PatrolRequirementScope;
  retentionDays: number;
  incompleteNeedsAction: boolean;
  postShiftSyncHours: number;
  clockDriftThresholdMinutes: number;
  allowUnscheduledPatrols: boolean;
  escalateUnverified: boolean;
  qrRequireProximity: boolean;
  proximityMeters: number | null;
}

export interface PatrolEffectivePolicy extends PatrolPolicyFields {
  source: 'site' | 'company' | 'default';
}

export interface PatrolSitePolicy {
  siteId: number;
  siteName: string;
  timezone: string | null;
  policy: PatrolEffectivePolicy;
}

export interface PatrolPolicies {
  defaults: PatrolPolicyFields;
  companyDefault: PatrolEffectivePolicy;
  sites: PatrolSitePolicy[];
  locationVerificationAvailable: boolean;
  extendedRetentionAllowed: boolean;
}

export type PatrolPolicyUpdate = Partial<Omit<PatrolPolicyFields, 'qrRequireProximity' | 'proximityMeters'>>;

export interface PatrolSchedule {
  id: number;
  siteId: number;
  routeId: number | null;
  name: string;
  daysOfWeek: number[] | null;
  activeFrom: string;
  activeTo: string;
  timeBasis: 'site_local';
  frequencyMinutes: number;
  windowMinutes: number;
  startsOn: string | null;
  endsOn: string | null;
  active: boolean;
  archivedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PatrolScheduleInput {
  siteId?: number;
  name?: string;
  routeId?: number | null;
  daysOfWeek?: number[];
  activeFrom?: string;
  activeTo?: string;
  frequencyMinutes?: number;
  windowMinutes?: number;
  startsOn?: string | null;
  endsOn?: string | null;
  active?: boolean;
}

export interface PatrolCheckpoint {
  id: number;
  siteId: number;
  publicId: string;
  label: string;
  description: string | null;
  tokenVersion: number;
  photoRequired: boolean;
  active: boolean;
  rotatedAt: string | null;
  revokedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PatrolCheckpointInput {
  siteId?: number;
  label?: string;
  description?: string | null;
  photoRequired?: boolean;
  active?: boolean;
}

/** The server-issued, server-signed label (GET /patrols/checkpoints/:id/label). The payload is printed verbatim. */
export interface PatrolCheckpointLabel {
  checkpointId: number;
  siteId: number;
  publicId: string;
  label: string;
  tokenVersion: number;
  keyId: string;
  payload: string;
}

export interface PatrolRouteCheckpoint {
  position: number;
  required: boolean;
  checkpointId: number;
  publicId: string;
  label: string;
  active: boolean;
  revoked: boolean;
}

export interface PatrolRoute {
  id: number;
  siteId: number;
  name: string;
  orderMode: PatrolOrderMode;
  active: boolean;
  archivedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  checkpoints?: PatrolRouteCheckpoint[];
}

export interface PatrolRouteInput {
  siteId?: number;
  name?: string;
  orderMode?: PatrolOrderMode;
  active?: boolean;
  checkpoints?: Array<{ checkpointId: number; required?: boolean }>;
}

export interface PatrolRun {
  id: number;
  clientRunId: string;
  siteId: number;
  shiftId: number;
  guardId: number;
  scheduleId: number | null;
  routeId: number | null;
  windowKey: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  status: PatrolRunStatus;
  verificationStatus: PatrolVerificationStatus;
  startedAtDevice: string | null;
  startedAtServer: string | null;
  completedAtDevice: string | null;
  completedAtServer: string | null;
  clockOffsetMs: number | null;
  exceptionReason: string | null;
  syncedLate: boolean;
  lateStart: boolean;
  provisional: boolean;
  needsReview: boolean;
  syncFlags: string[];
  clockDriftMs: number | null;
  verifiedAt: string | null;
  verificationFinalAt: string | null;
  siteName?: string;
  guardName?: string;
  visitCount?: number;
  flaggedVisitCount?: number;
}

export interface PatrolRunsPage {
  items: PatrolRun[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PatrolRunsQuery {
  siteId?: number | null;
  from?: string | null;
  to?: string | null;
  status?: PatrolRunStatus | null;
  page?: number;
  pageSize?: number;
}

export interface PatrolVisit {
  id: number;
  clientVisitId: string;
  runId: number;
  checkpointId: number | null;
  checkpointPublicId: string | null;
  checkpointLabel: string | null;
  method: string;
  result: 'verified' | 'unverified' | 'flagged';
  flags: string[];
  provisional: boolean;
  scannedAtDevice: string | null;
  receivedAtServer: string | null;
  syncedLate: boolean;
  syncFlags: string[];
  clockDriftMs: number | null;
}

export interface PatrolException {
  id: number;
  siteId: number;
  runId: number | null;
  scheduleId: number | null;
  shiftId: number | null;
  windowKey: string;
  scopeKey: string;
  type: PatrolExceptionType;
  status: PatrolExceptionStatus;
  safetyAlertId: number | null;
  note: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string | null;
  guardId: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  acknowledgedAt: string | null;
  lateEvidenceAt: string | null;
  annotations: Array<{ at?: string; kind?: string; text?: string }>;
  alertStatus?: string | null;
  alertPriority?: string | null;
}

/** Metadata only. An image is reached only through GET /patrols/evidence/:id/download (short-lived, audited). */
export interface PatrolEvidence {
  id: number;
  clientEvidenceId: string;
  runId: number;
  visitId: number | null;
  kind: 'run_photo' | 'checkpoint_photo' | string;
  source: string;
  mimeType: string | null;
  sizeBytes: number | null;
  widthPx: number | null;
  heightPx: number | null;
  sha256Client: string;
  sha256Stored: string | null;
  capturedAtDevice: string | null;
  receivedAt: string | null;
  verifiedAt: string | null;
  uploadStatus: PatrolEvidenceUploadStatus;
  retentionDays: number | null;
  expiresAt: string | null;
  retentionStatus: PatrolEvidenceRetentionStatus;
  declaredSizeBytes: number | null;
  detectedMimeType: string | null;
  rejectionReason: string | null;
  syncFlags: string[];
  needsReview: boolean;
  deletionReason: string | null;
  quarantinedAt: string | null;
  purgeAfter: string | null;
  purgedAt: string | null;
  restoredAt: string | null;
  objectDeletedAt: string | null;
}

export interface PatrolRunDetail {
  run: PatrolRun;
  visits: PatrolVisit[];
  exceptions: PatrolException[];
  evidenceCount: number;
  /** True when the caller lacks patrols.evidence: only the count is returned. */
  evidenceRestricted: boolean;
  evidence: PatrolEvidence[] | null;
}

export interface PatrolOverview {
  date: string;
  dateBasis: 'utc';
  siteId: number | null;
  runsStarted: number;
  runsByStatus: Record<PatrolRunStatus, number>;
  inProgressNow: number;
  flaggedScans: number;
  openExceptions: number;
  activeCheckpoints: number;
  activeSchedules: number;
  activeRoutes: number;
}

export interface PatrolHold {
  id: number;
  scope: PatrolHoldScope;
  evidenceId: number | null;
  runId: number | null;
  shiftId: number | null;
  siteId: number | null;
  fromDate: string | null;
  toDate: string | null;
  reason: string;
  source: string;
  createdAt: string | null;
  releasedAt: string | null;
  createdByUserId: number | null;
  releasedByUserId: number | null;
  releaseReason: string | null;
  incidentId: number | null;
  safetyAlertId: number | null;
  exceptionId: number | null;
}

export interface PatrolHoldInput {
  scope: PatrolHoldScope;
  evidenceId?: number;
  runId?: number;
  shiftId?: number;
  siteId?: number;
  fromDate?: string;
  toDate?: string;
  reason: string;
}

export interface PatrolExport {
  id: number;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'expired' | string;
  purpose: string;
  siteId: number | null;
  fromDate: string | null;
  toDate: string | null;
  runIds: number[];
  itemCount: number;
  includedCount: number;
  excludedCount: number;
  includedBytes: number;
  zipBytes: number | null;
  zipSha256: string | null;
  manifestSha256: string | null;
  requestedByUserId: number;
  error: string | null;
  attempts: number;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
}

export interface PatrolExportInput {
  purpose: PatrolExportPurpose;
  siteId?: number;
  fromDate?: string;
  toDate?: string;
  runIds?: number[];
}

/** A short-lived presigned link. Held in memory only until expiresAt; never logged, stored or cached. */
export interface PatrolSignedLink {
  method: string;
  url: string;
  expiresAt: string;
}

/**
 * One page of a run's photo previews (issue #79): GET /patrols/runs/:id/evidence/thumbnails. Each viewable photo carries
 * the same short-lived link as a single view; anything else has url null. One audit entry per page (purpose browse).
 * Held in memory only until expiresAt; never logged, stored or cached.
 */
export interface PatrolEvidenceThumbnailPage {
  runId: number;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  expiresAt: string | null;
  items: Array<{ evidenceId: number; url: string | null; expiresAt: string | null }>;
}

export interface PatrolStorageSite {
  siteId: number;
  siteName: string | null;
  activeObjects: number;
  activeBytes: number;
  quarantinedObjects: number;
  quarantinedBytes: number;
  updatedAt: string;
}

export interface PatrolStorageUsage {
  sites: PatrolStorageSite[];
  exports: { objects: number; bytes: number };
  totals: {
    objects: number;
    bytes: number;
    activeObjects: number;
    activeBytes: number;
    quarantinedObjects: number;
    quarantinedBytes: number;
  };
  retentionMode: 'off' | 'report' | 'enforce' | string;
  storageConfigured: boolean;
}

// ─── Guard app (Patrols P1-E) ───────────────────────────────────────────────────────────────────────────────────────
// GET /patrols/mine/plan and GET /patrols/mine/runs (security-backend-nest/src/patrol/patrol-guard.service.ts). The plan
// carries no signing key, label payload or token version; `windows` are the server's own site-local windows of the shift.

export interface GuardPatrolPlanWindow {
  windowKey: string;
  scheduleId: number;
  scheduleName: string;
  routeId: number | null;
  localDate: string;
  start: string;
  end: string;
  /** A run is already recorded for this window and scope (no Guard is named). */
  covered: boolean;
}

export interface GuardPatrolPlan {
  shift: { id: number; status: string; start: string; end: string };
  site: { id: number; name: string; timezone: string };
  policy: Omit<PatrolPolicyFields, 'qrRequireProximity' | 'proximityMeters'> & { source?: string };
  locationVerification: false;
  schedules: Array<{
    id: number;
    routeId: number | null;
    name: string;
    daysOfWeek: number[] | null;
    activeFrom: string;
    activeTo: string;
    timeBasis: 'site_local';
    frequencyMinutes: number;
    windowMinutes: number;
    startsOn: string | null;
    endsOn: string | null;
  }>;
  routes: Array<{ id: number; name: string; orderMode: PatrolOrderMode; checkpoints: Array<{ position: number; required: boolean; publicId: string; label: string }> }>;
  checkpoints: Array<{ publicId: string; label: string; description: string | null; photoRequired: boolean }>;
  /** Present from P1-E; an older backend omits it (the app then shows no due times rather than inventing them). */
  windows?: GuardPatrolPlanWindow[];
}

export interface GuardPatrolRun extends PatrolRun {
  visits: PatrolVisit[];
}

export interface GuardEvidenceUploadIntent {
  evidence: PatrolEvidence;
  /** A short-lived presigned PUT, or null once the photo is settled. Never logged or stored. */
  upload: { method: 'PUT'; url: string; expiresAt: string; headers: Record<string, string> } | null;
}
