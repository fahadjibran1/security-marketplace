import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Patrol Management (S4 Patrols Phase 1, Migration 68). Vocabulary, owner-approved defaults (28 Oct 2026 corrections)
 * and error codes. The database CHECK constraints in 1720900000014-AddPatrolManagement.ts hold exactly these values;
 * scripts/m68-migration.spec.ts asserts that they agree.
 */

export const PATROL_METHODS = ['qr', 'photo'] as const;
export type PatrolMethod = (typeof PATROL_METHODS)[number];

export const PATROL_ORDER_MODES = ['any', 'strict'] as const;
export type PatrolOrderMode = (typeof PATROL_ORDER_MODES)[number];

/** 'site': one patrol per window covers the site. 'per_guard': every on-duty Guard patrols. */
export const PATROL_REQUIREMENT_SCOPES = ['site', 'per_guard'] as const;
export type PatrolRequirementScope = (typeof PATROL_REQUIREMENT_SCOPES)[number];

/** Evidence retention (days from verified receipt). 90 only by a company Owner or Admin. */
export const PATROL_RETENTION_DAYS = [30, 90] as const;
export type PatrolRetentionDays = (typeof PATROL_RETENTION_DAYS)[number];
export const PATROL_EXTENDED_RETENTION_DAYS = 90;

export const PATROL_RUN_STATUSES = ['in_progress', 'completed', 'incomplete', 'closed_by_system'] as const;
export type PatrolRunStatus = (typeof PATROL_RUN_STATUSES)[number];

/** Completion and verification are separate: a run is Verified only once the server has every required item (P1-B). */
export const PATROL_VERIFICATION_STATUSES = ['pending', 'verified', 'unverified', 'flagged'] as const;
export type PatrolVerificationStatus = (typeof PATROL_VERIFICATION_STATUSES)[number];

export const PATROL_VISIT_METHODS = ['qr', 'nfc', 'manual'] as const;
export const PATROL_VISIT_RESULTS = ['verified', 'unverified', 'flagged'] as const;
export type PatrolVisitResult = (typeof PATROL_VISIT_RESULTS)[number];

/**
 * Reasons a scan is not plain "verified". Stored on the visit; a scan is never silently discarded. "Checkpoint label
 * scanned" is the claim, never "Guard present at checkpoint".
 */
export const PATROL_SCAN_FLAGS = [
  'unsigned_scan', // only a publicId was sent (no signed label payload): unverified
  'signing_key_unavailable', // the server has no PATROL_QR_SIGNING_KEY: unverified
  'malformed_payload', // not an s4cp:1 label
  'unknown_signing_key', // keyId this server does not hold
  'tampered_signature', // MAC does not match
  'unknown_checkpoint', // no checkpoint with that publicId in the run's company
  'wrong_site', // the checkpoint belongs to another site of the company
  'checkpoint_revoked', // the checkpoint was revoked (or deactivated)
  'revoked_label', // an older tokenVersion: the label was reprinted
  'invalid_label_version', // a tokenVersion newer than the checkpoint has ever had
  'not_on_route', // the run follows a route that does not include this checkpoint
  'duplicate_in_run', // the same checkpoint was already scanned in this run
] as const;
export type PatrolScanFlag = (typeof PATROL_SCAN_FLAGS)[number];
/** Flags that only mean "the server could not check the signature", not that anything is wrong. */
export const PATROL_UNVERIFIED_ONLY_FLAGS: readonly PatrolScanFlag[] = ['unsigned_scan', 'signing_key_unavailable'];

export const PATROL_EVIDENCE_UPLOAD_STATUSES = ['pending', 'uploaded', 'verified', 'rejected', 'local_corrupt'] as const;
/** The P1-C deletion state machine: active → claimed → quarantined → purged → tombstone (restore back to active). */
export const PATROL_EVIDENCE_RETENTION_STATUSES = ['active', 'claimed', 'quarantined', 'purged', 'tombstone'] as const;
export const PATROL_EXCEPTION_TYPES = ['patrol_missed', 'patrol_late', 'patrol_incomplete', 'checkpoint_missed', 'evidence_unverified'] as const;
export const PATROL_EXCEPTION_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export const PATROL_HOLD_SCOPES = ['evidence', 'run', 'shift', 'site_date_range'] as const;
export const PATROL_HOLD_SOURCES = ['manual', 'incident', 'alert', 'exception'] as const;

/** Owner-approved policy defaults (28 Oct 2026). Separate start and completion deadlines; the deadline logic is P1-B. */
export const PATROL_POLICY_DEFAULTS = Object.freeze({
  methods: ['qr'] as PatrolMethod[],
  photosPerRun: 0,
  photosPerCheckpoint: 0,
  orderMode: 'any' as PatrolOrderMode,
  startGraceMinutes: 15,
  maxPatrolDurationMinutes: 45,
  completionGraceMinutes: 30,
  syncGraceMinutes: 60,
  requirementScope: 'site' as PatrolRequirementScope,
  retentionDays: 30 as PatrolRetentionDays,
  incompleteNeedsAction: true,
  // Location-based verification is DISABLED until the privacy assessment is approved: the fields exist, default off,
  // and the API refuses to enable them (PATROL_LOCATION_VERIFICATION_DISABLED).
  qrRequireProximity: false,
  proximityMeters: null as number | null,
});

export const PATROL_POLICY_LIMITS = Object.freeze({
  photosPerRun: [0, 20],
  photosPerCheckpoint: [0, 5],
  startGraceMinutes: [0, 240],
  maxPatrolDurationMinutes: [5, 720],
  completionGraceMinutes: [0, 720],
  syncGraceMinutes: [0, 1440],
} as const);

export const PATROL_SCHEDULE_FREQUENCY_MINUTES = [15, 1440] as const;
export const PATROL_SCHEDULE_WINDOW_MINUTES = [5, 1440] as const;

/** Client-generated idempotency ids (runs, visits, evidence): URL-safe, 8–64 characters (a UUID fits). */
export const PATROL_CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const PATROL_HH_MM_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Request fields that would carry a device location. Location-based verification is disabled (privacy assessment
 * pending), so a request that sends any of them is REJECTED with PATROL_LOCATION_VERIFICATION_DISABLED rather than
 * silently ignored: clients must not collect or send a location for patrols at all.
 */
export const PATROL_LOCATION_FIELDS = [
  'latitude', 'longitude', 'lat', 'lng', 'lon', 'accuracy', 'accuracyMeters', 'gpsAccuracyMeters', 'location', 'coords', 'coordinates',
  'altitude', 'distanceMeters',
] as const;

export enum PatrolErrorCode {
  NOT_ENABLED = 'PATROLS_NOT_ENABLED',
  FORBIDDEN = 'PATROL_FORBIDDEN',
  NOT_FOUND = 'PATROL_NOT_FOUND',
  SITE_NOT_FOUND = 'PATROL_SITE_NOT_FOUND',
  SHIFT_NOT_FOUND = 'PATROL_SHIFT_NOT_FOUND',
  SHIFT_NOT_IN_PROGRESS = 'PATROL_SHIFT_NOT_IN_PROGRESS',
  SHIFT_HAS_NO_SITE = 'PATROL_SHIFT_HAS_NO_SITE',
  RUN_NOT_IN_PROGRESS = 'PATROL_RUN_NOT_IN_PROGRESS',
  RUN_ALREADY_IN_PROGRESS = 'PATROL_RUN_ALREADY_IN_PROGRESS',
  IDEMPOTENCY_CONFLICT = 'PATROL_IDEMPOTENCY_CONFLICT',
  VALIDATION = 'PATROL_VALIDATION_FAILED',
  LOCATION_VERIFICATION_DISABLED = 'PATROL_LOCATION_VERIFICATION_DISABLED',
  RETENTION_REQUIRES_OWNER_ADMIN = 'PATROL_RETENTION_REQUIRES_OWNER_ADMIN',
  SCHEDULE_NOT_FOR_SITE = 'PATROL_SCHEDULE_NOT_FOR_SITE',
  ROUTE_NOT_FOR_SITE = 'PATROL_ROUTE_NOT_FOR_SITE',
  ROUTE_CHECKPOINT_WRONG_SITE = 'PATROL_ROUTE_CHECKPOINT_WRONG_SITE',
  ROUTE_CHECKPOINT_UNAVAILABLE = 'PATROL_ROUTE_CHECKPOINT_UNAVAILABLE',
  ROUTE_DUPLICATE_CHECKPOINT = 'PATROL_ROUTE_DUPLICATE_CHECKPOINT',
  CHECKPOINT_REVOKED = 'PATROL_CHECKPOINT_REVOKED',
  QR_SIGNING_KEY_UNAVAILABLE = 'PATROL_QR_SIGNING_KEY_UNAVAILABLE',
}

export function patrolError(status: HttpStatus, code: PatrolErrorCode, message: string, details?: Record<string, unknown>) {
  return new HttpException({ statusCode: status, code, message, ...(details ? { details } : {}) }, status);
}
