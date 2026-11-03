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

/**
 * S4 1.2.1: a configuration the server accepted but cannot judge as asked (QR scans required on a schedule with no route
 * of required checkpoints). Saving is allowed; the dashboard shows it as "Configuration required". Older backends omit it.
 */
export type PatrolConfigurationWarningCode = 'QR_ROUTE_REQUIRED';
export interface PatrolConfigurationWarning {
  code: PatrolConfigurationWarningCode | string;
  message: string;
  scheduleId?: number | null;
  siteId?: number | null;
}

export interface PatrolSitePolicy {
  siteId: number;
  siteName: string;
  timezone: string | null;
  policy: PatrolEffectivePolicy;
  /** S4 1.2.1; an older backend omits it. */
  configurationWarnings?: PatrolConfigurationWarning[];
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
  /** S4 1.2.1; an older backend omits it. */
  configurationWarnings?: PatrolConfigurationWarning[];
  /** PATCH only (S4 1.2.1): a timing change ends the old schedule and answers with its successor (a NEW id). */
  predecessorId?: number | null;
  timingChanged?: boolean;
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
  /** S4 1.3.0 (Migration 74): 'auto' = the site setup's route of every confirmed checkpoint; absent from older servers. */
  kind?: 'custom' | 'auto';
  supersededByRouteId?: number | null;
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
  /**
   * Company reads (#76): the distinct checkpoints visited by a scan that was not flagged, computed once by the server
   * for the History list and the run detail alike. Absent from the Guard API.
   */
  checkpointsVisited?: number;
  /** Checkpoints on the run's route; null without a route. */
  checkpointsTotal?: number | null;
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
  /** How from / to are read: the UTC day (API default) or each run's site-local day (#77). */
  dateBasis?: 'utc' | 'site_local' | null;
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
  /** S4 1.2.1 (GET /patrols/exceptions only): who acknowledged / resolved it — a display name, never an email. */
  acknowledgedByName?: string | null;
  resolvedByName?: string | null;
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
  /** utc (the API default) or site_local: each site's own local day (#77). */
  dateBasis: 'utc' | 'site_local';
  /** site_local with one site: its zone; null otherwise. Absent from an older API. */
  timeZone?: string | null;
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

/** GET /patrols/windows/day (#78): computed by the server from schedules and site time zones (the P1-B window engine). */
export interface PatrolWindowsDaySite {
  siteId: number;
  timeZone: string;
  date: string;
  dayStart: string;
  dayEnd: string;
  windowsDue: number;
  windowsCompleted: number;
  windowsOutstanding: number;
}

export interface PatrolWindowsDay {
  /** The site-local date counted (null across sites whose "today" differs). */
  date: string | null;
  dateBasis: 'site_local';
  siteId: number | null;
  generatedAt: string;
  /** Windows of active schedules starting in the site-local day. */
  windowsDue: number;
  /** Of those, windows with a completed run. */
  windowsCompleted: number;
  /** due − completed: still to do, in progress, incomplete or missed. */
  windowsOutstanding: number;
  completionBasis: 'window_with_a_completed_run';
  sites: PatrolWindowsDaySite[];
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

/**
 * An exceptional offline recovery grant (issue #68): an Owner / Admin lets ONE Guard send ONE shift's patrol data after
 * the post-shift sync window, until expiresAt (default 24 h, at most 72 h). Data accepted under it is flagged
 * recovered_via_grant and needs review.
 */
export interface PatrolRecoveryGrant {
  id: number;
  shiftId: number;
  guardId: number;
  guardName: string | null;
  siteId: number | null;
  siteName: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  reason: string;
  status: 'active' | 'expired' | 'revoked';
  createdAt: string | null;
  createdByUserId: number;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedByUserId: number | null;
  revokeReason: string | null;
  uses: number;
  lastUsedAt: string | null;
}

export interface PatrolRecoveryGrantInput {
  shiftId: number;
  guardId?: number;
  durationHours?: number;
  reason: string;
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
  /** S4 1.2.1: what the server cannot judge as configured (QR required without a route); older backends omit it. */
  configurationWarnings?: PatrolConfigurationWarning[];
}

export interface GuardPatrolRun extends PatrolRun {
  visits: PatrolVisit[];
}

export interface GuardEvidenceUploadIntent {
  evidence: PatrolEvidence;
  /** A short-lived presigned PUT, or null once the photo is settled. Never logged or stored. */
  upload: { method: 'PUT'; url: string; expiresAt: string; headers: Record<string, string> } | null;
}

// ─── S4 1.3.0: guided site patrol setup (B1 API, B2 dashboard) ─────────────────────────────────────────────────────

export type PatrolSetupMode = 'off' | 'every_shift' | 'per_shift';
export type PatrolEvidenceMode = 'qr' | 'photo' | 'qr_photo';
export type PatrolWindowAnchor = 'scheduled_start' | 'book_on';

export interface PatrolSetupChecklistItem {
  code: 'setup_mode' | 'frequency' | 'confirmed_checkpoints' | 'route_checkpoints' | string;
  ok: boolean;
  text: string;
}

export interface PatrolSetupCheckpoint extends PatrolCheckpoint {
  /** The authorised test scan of the CURRENT label (cleared by a rotation or revocation). */
  confirmed: boolean;
  confirmedAt: string | null;
  confirmedByUserId: number | null;
  confirmedTokenVersion: number | null;
  onCurrentRoute: boolean;
}

/** GET /patrols/sites/:siteId/setup (and the answer to every setup write). */
export interface PatrolSiteSetup {
  siteId: number;
  siteName: string | null;
  timezone: string | null;
  setupMode: PatrolSetupMode | null;
  evidenceMode: PatrolEvidenceMode;
  frequencyMinutes: number | null;
  windowAnchor: PatrolWindowAnchor;
  active: boolean;
  confirmedAt: string | null;
  confirmedByUserId: number | null;
  schedule: { id: number } & Record<string, unknown> | null;
  route: {
    mode: 'auto' | 'custom' | 'none';
    scheduleRouteId: number | null;
    versions: number;
    currentVersion: {
      id: number;
      kind: string;
      name: string;
      createdAt: string;
      checkpoints: Array<{ checkpointId: number; label: string; required: boolean; position: number }>;
    } | null;
  } | null;
  checkpoints: PatrolSetupCheckpoint[];
  checklist: PatrolSetupChecklistItem[];
  ready: boolean;
  warnings: Array<{ code: string; message: string }>;
}

/** PUT /patrols/sites/:siteId/setup. Saving never activates. */
export interface PatrolSiteSetupInput {
  setupMode: PatrolSetupMode;
  evidenceMode: PatrolEvidenceMode;
  frequencyMinutes: number;
  windowAnchor?: PatrolWindowAnchor;
  /** A custom route of the site; null / absent = every confirmed checkpoint (the automatic route). */
  routeId?: number | null;
}

// ─── S4 1.3.0: evidence browsing (Client → Site → Date → Patrol time → Guard) ──────────────────────────────────────

export interface PatrolEvidenceTreeDay {
  date: string;
  patrols: number;
  withPhotos: number;
  withoutPhotos: number;
}

export interface PatrolEvidenceTreeSite {
  siteId: number;
  siteName: string;
  timezone: string;
  patrols: number;
  withPhotos: number;
  days: PatrolEvidenceTreeDay[];
}

export interface PatrolEvidenceTree {
  from: string;
  to: string;
  dateBasis: 'site_local';
  clients: Array<{ clientId: number | null; clientName: string | null; sites: PatrolEvidenceTreeSite[] }>;
}

export interface PatrolEvidenceCardPhoto {
  id: number;
  kind: string;
  uploadStatus: PatrolEvidenceUploadStatus;
  retentionStatus: PatrolEvidenceRetentionStatus;
  capturedAtDevice: string | null;
  receivedAt: string | null;
  verifiedAt: string | null;
  viewable: boolean;
  /** An API path (authenticated), never a signed link. */
  stampedPath: string | null;
}

export interface PatrolEvidenceCard {
  reference: string;
  run: PatrolRun;
  window: { scheduleId: number | null; scheduleName: string | null; anchor: string | null; windowKey: string; start: string; end: string; label: string } | null;
  guard: { id: number; displayName: string };
  photoCount: number;
  photosRestricted: boolean;
  photos: PatrolEvidenceCardPhoto[] | null;
  thumbnailsPath: string | null;
  qrScans: Array<{
    id: number;
    checkpointId: number | null;
    label: string | null;
    result: string;
    flags: string[];
    scannedAtDevice: string | null;
    receivedAtServer: string | null;
  }>;
  verification: { status: PatrolVerificationStatus; code: string; text: string; deadline: string | null };
}

export interface PatrolEvidencePatrols {
  siteId: number;
  siteName: string;
  clientName: string | null;
  timezone: string;
  date: string;
  dayStart: string;
  dayEnd: string;
  photos: 'all' | 'only';
  evidenceRestricted: boolean;
  patrols: PatrolEvidenceCard[];
}

/** S4 1.3.0 B2: a Rota Planner slot's patrol requirement (present only for companies with Patrols on). */
export interface RotaSlotPatrolRequirement {
  value: 'required' | 'not_required' | 'site_default' | 'mixed';
  effectiveRequired: boolean | null;
  source: 'site' | 'shift' | 'mixed';
  summary: string;
  site: {
    setupMode: PatrolSetupMode | null;
    active: boolean;
    frequencyMinutes: number | null;
    windowAnchor: PatrolWindowAnchor;
    summary: string;
  };
}

// ─── Patrol Monitor (S4 Patrol Monitor S1 API, read by the S2 dashboard) ──────────────────────────────────────────

/** Window states, most severe first (the server's MONITOR_WINDOW_STATES). */
export type PatrolMonitorWindowState =
  | 'missed' | 'incomplete' | 'flagged' | 'not_verified' | 'overdue' | 'late_verified' | 'awaiting_check'
  | 'awaiting_verification' | 'in_progress' | 'due' | 'verified' | 'not_judged' | 'not_on_duty' | 'future';
/** An hour cell: a window state, or none (no window that hour), not_required (on duty, nothing owed), off_duty. */
export type PatrolMonitorCellState = PatrolMonitorWindowState | 'none' | 'not_required' | 'off_duty';
export type PatrolMonitorSiteStatus = 'attention' | 'watch' | 'on_track' | 'not_started' | 'no_patrols';

export interface PatrolMonitorCounts {
  windows: number;
  owed: number;
  verified: number;
  verifiedOnTime: number;
  lateVerified: number;
  inProgress: number;
  awaitingVerification: number;
  missed: number;
  missedOpen: number;
  incomplete: number;
  flagged: number;
  notVerified: number;
  overdue: number;
  due: number;
  awaitingCheck: number;
  future: number;
  verificationOverdue: number;
  openExceptions: number;
  openAlerts: number;
}

export interface PatrolMonitorSummarySite {
  siteId: number;
  siteName: string;
  clientId: number | null;
  clientName: string | null;
  timeZone: string;
  /** The site-local day (YYYY-MM-DD) and its instants. */
  date: string;
  dayStart: string;
  dayEnd: string;
  status: PatrolMonitorSiteStatus;
  counts: PatrolMonitorCounts;
  /** The number of lanes (Site Patrol and shift rows). */
  lanes: number;
  nextWindowStart: string | null;
}

export interface PatrolMonitorSummary {
  generatedAt: string;
  dateBasis: 'site_local';
  date: string | null;
  sweep: { judgedThrough: string | null };
  totals: PatrolMonitorCounts & { sites: number; byStatus: Record<PatrolMonitorSiteStatus, number> };
  liveOps: { openPatrolAlerts: number; missedToday: number; missedTodayOpen: number };
  sites: PatrolMonitorSummarySite[];
}

export interface PatrolMonitorHour {
  index: number;
  start: string;
  end: string;
  /** Site-local hour "HH". */
  label: string;
  /** The site's UTC offset in that hour, e.g. "GMT+1". */
  offset: string;
  /** The second of two hours with the same label (the repeated autumn hour). */
  repeated: boolean;
  current: boolean;
}

export interface PatrolMonitorWindow {
  key: string;
  scheduleId: number;
  windowKey: string;
  scopeKey: string;
  anchor: 'clock' | 'shift';
  start: string;
  end: string;
  startDeadline: string;
  state: PatrolMonitorWindowState;
  runId: number | null;
  runGuardId: number | null;
  lateStart: boolean;
  verificationOverdue: boolean;
  exceptionId: number | null;
  exceptionStatus: string | null;
  exceptionIds: number[];
  alertId: number | null;
  alertStatus: string | null;
}

export interface PatrolMonitorCell {
  hour: number;
  state: PatrolMonitorCellState;
  total: number;
  owed: number;
  verified: number;
  windowKeys: string[];
}

export interface PatrolMonitorLane {
  key: string;
  kind: 'site' | 'shift';
  shiftId: number | null;
  guardId: number | null;
  guardName: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  shiftStatus: string | null;
  requirement: { effectiveRequired: boolean; value: string; source: string; summary: string } | null;
  windows: PatrolMonitorWindow[];
  cells: PatrolMonitorCell[];
}

/** A patrol a cell opens: counts only (no evidence object, URL or image). */
export interface PatrolMonitorRun {
  id: number;
  guardId: number;
  guardName: string | null;
  shiftId: number;
  status: PatrolRunStatus;
  verificationStatus: PatrolVerificationStatus;
  lateStart: boolean;
  windowStart: string | null;
  windowEnd: string | null;
  startedAtServer: string;
  startedAtDevice: string;
  completedAtServer: string | null;
  checkpoints: { required: number | null; verified: number | null; scans: number; repeatScans: number; flaggedScans: number; qrRuleMissing: boolean };
  photos: { taken: number; verified: number; missing: number };
}

export interface PatrolMonitorSite {
  generatedAt: string;
  siteId: number;
  siteName: string;
  clientId: number | null;
  clientName: string | null;
  timeZone: string;
  range: { from: string; to: string; date: string | null };
  sweep: { judgedThrough: string | null };
  policy: { requirementScope: PatrolRequirementScope; methods: PatrolMethod[]; startGraceMinutes: number; photoRequired: boolean };
  setup: { active: boolean; mode: string | null };
  status: PatrolMonitorSiteStatus;
  counts: PatrolMonitorCounts;
  nextWindowStart: string | null;
  hours: PatrolMonitorHour[];
  lanes: PatrolMonitorLane[];
  runs: Record<string, PatrolMonitorRun>;
  otherRuns: Array<{ runId: number; reason: 'unscheduled' | 'window_already_covered' | 'unmatched'; exceptionIds: number[] }>;
  exceptions: Record<string, { id: number; type: string; status: string; runId: number | null; alertId: number | null; alertStatus: string | null }>;
}
