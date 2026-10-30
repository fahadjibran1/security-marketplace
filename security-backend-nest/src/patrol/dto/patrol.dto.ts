import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsInstantString } from '../../common/validators/is-instant-string.validator';
import {
  PATROL_CLIENT_ID_PATTERN,
  PATROL_EXCEPTION_STATUSES,
  PATROL_EXCEPTION_TYPES,
  PATROL_HH_MM_PATTERN,
  PATROL_METHODS,
  PATROL_ORDER_MODES,
  PATROL_REQUIREMENT_SCOPES,
  PATROL_RETENTION_DAYS,
  PATROL_RUN_STATUSES,
} from '../patrol-constants';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** How a company read turns a calendar date into instants: the UTC day, or each site's own local day (#77). */
export const PATROL_DATE_BASES = ['utc', 'site_local'] as const;
export type PatrolDateBasis = (typeof PATROL_DATE_BASES)[number];

/**
 * Location fields are DECLARED (so the global whitelist does not turn them into an anonymous 400) and then REFUSED by
 * the service with PATROL_LOCATION_VERIFICATION_DISABLED: location-based verification is disabled until the privacy
 * assessment, and clients must not send a location for patrols at all. See PATROL_LOCATION_FIELDS.
 */
export class PatrolLocationProbe {
  @Allow() latitude?: unknown;
  @Allow() longitude?: unknown;
  @Allow() lat?: unknown;
  @Allow() lng?: unknown;
  @Allow() lon?: unknown;
  @Allow() accuracy?: unknown;
  @Allow() accuracyMeters?: unknown;
  @Allow() gpsAccuracyMeters?: unknown;
  @Allow() location?: unknown;
  @Allow() coords?: unknown;
  @Allow() coordinates?: unknown;
  @Allow() altitude?: unknown;
  @Allow() distanceMeters?: unknown;
}

// ── Company configuration ─────────────────────────────────────────────────────────────────────────────

/** PUT a policy: fields left out keep their current (or inherited) value. */
export class UpsertPatrolPolicyDto {
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsIn(PATROL_METHODS, { each: true })
  methods?: string[];

  @IsOptional() @IsInt() @Min(0) @Max(20)
  photosPerRun?: number;

  @IsOptional() @IsInt() @Min(0) @Max(5)
  photosPerCheckpoint?: number;

  @IsOptional() @IsIn(PATROL_ORDER_MODES)
  orderMode?: string;

  @IsOptional() @IsInt() @Min(0) @Max(240)
  startGraceMinutes?: number;

  @IsOptional() @IsInt() @Min(5) @Max(720)
  maxPatrolDurationMinutes?: number;

  @IsOptional() @IsInt() @Min(0) @Max(720)
  completionGraceMinutes?: number;

  @IsOptional() @IsInt() @Min(0) @Max(1440)
  syncGraceMinutes?: number;

  @IsOptional() @IsIn(PATROL_REQUIREMENT_SCOPES)
  requirementScope?: string;

  @IsOptional() @IsIn(PATROL_RETENTION_DAYS as unknown as number[])
  retentionDays?: number;

  @IsOptional() @IsBoolean()
  incompleteNeedsAction?: boolean;

  /** P1-B: hours after Book Off in which offline patrol data is still accepted (default 24). */
  @IsOptional() @IsInt() @Min(1) @Max(72)
  postShiftSyncHours?: number;

  /** P1-B: device clock drift beyond this many minutes is flagged (default 5). */
  @IsOptional() @IsInt() @Min(1) @Max(120)
  clockDriftThresholdMinutes?: number;

  /** P1-B: a run started without a schedule needs no matching window (default true). */
  @IsOptional() @IsBoolean()
  allowUnscheduledPatrols?: boolean;

  /** P1-B: evidence still missing at the sync deadline also raises a Live Operations alert (default false). */
  @IsOptional() @IsBoolean()
  escalateUnverified?: boolean;

  /** Refused unless false (location verification is disabled). */
  @IsOptional() @IsBoolean()
  qrRequireProximity?: boolean;

  /** Refused unless null (location verification is disabled). */
  @Allow()
  proximityMeters?: unknown;
}

export class CreatePatrolScheduleDto {
  @IsInt() @Min(1)
  siteId!: number;

  @IsString() @MinLength(1) @MaxLength(120)
  name!: string;

  @IsOptional() @IsInt() @Min(1)
  routeId?: number | null;

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true })
  daysOfWeek?: number[];

  @Matches(PATROL_HH_MM_PATTERN, { message: 'activeFrom must be site-local HH:mm' })
  activeFrom!: string;

  @Matches(PATROL_HH_MM_PATTERN, { message: 'activeTo must be site-local HH:mm' })
  activeTo!: string;

  @IsInt() @Min(15) @Max(1440)
  frequencyMinutes!: number;

  /** Defaults to frequencyMinutes; never longer than it. */
  @IsOptional() @IsInt() @Min(5) @Max(1440)
  windowMinutes?: number;

  @IsOptional() @Matches(DATE_ONLY)
  startsOn?: string | null;

  @IsOptional() @Matches(DATE_ONLY)
  endsOn?: string | null;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

export class UpdatePatrolScheduleDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  name?: string;

  @IsOptional() @IsInt() @Min(1)
  routeId?: number | null;

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true })
  daysOfWeek?: number[];

  @IsOptional() @Matches(PATROL_HH_MM_PATTERN, { message: 'activeFrom must be site-local HH:mm' })
  activeFrom?: string;

  @IsOptional() @Matches(PATROL_HH_MM_PATTERN, { message: 'activeTo must be site-local HH:mm' })
  activeTo?: string;

  @IsOptional() @IsInt() @Min(15) @Max(1440)
  frequencyMinutes?: number;

  @IsOptional() @IsInt() @Min(5) @Max(1440)
  windowMinutes?: number;

  @IsOptional() @Matches(DATE_ONLY)
  startsOn?: string | null;

  @IsOptional() @Matches(DATE_ONLY)
  endsOn?: string | null;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

export class CreatePatrolCheckpointDto {
  @IsInt() @Min(1)
  siteId!: number;

  @IsString() @MinLength(1) @MaxLength(120)
  label!: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string | null;

  @IsOptional() @IsBoolean()
  photoRequired?: boolean;

  /** Refused (location verification is disabled). */
  @Allow() latitude?: unknown;
  @Allow() longitude?: unknown;
  @Allow() proximityMeters?: unknown;
}

export class UpdatePatrolCheckpointDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  label?: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string | null;

  @IsOptional() @IsBoolean()
  photoRequired?: boolean;

  @IsOptional() @IsBoolean()
  active?: boolean;

  /** Refused (location verification is disabled). */
  @Allow() latitude?: unknown;
  @Allow() longitude?: unknown;
  @Allow() proximityMeters?: unknown;
}

export class PatrolRouteCheckpointInput {
  @IsInt() @Min(1)
  checkpointId!: number;

  @IsOptional() @IsBoolean()
  required?: boolean;
}

export class CreatePatrolRouteDto {
  @IsInt() @Min(1)
  siteId!: number;

  @IsString() @MinLength(1) @MaxLength(120)
  name!: string;

  @IsOptional() @IsIn(PATROL_ORDER_MODES)
  orderMode?: string;

  /** In patrol order: position 1 is the first element. */
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => PatrolRouteCheckpointInput)
  checkpoints!: PatrolRouteCheckpointInput[];
}

export class UpdatePatrolRouteDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  name?: string;

  @IsOptional() @IsIn(PATROL_ORDER_MODES)
  orderMode?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;

  /** Replaces the whole ordered list when present. */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => PatrolRouteCheckpointInput)
  checkpoints?: PatrolRouteCheckpointInput[];
}

// ── Company reads ─────────────────────────────────────────────────────────────────────────────────────

export class PatrolRunsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  siteId?: number;

  /**
   * Calendar dates (YYYY-MM-DD), inclusive, on the server start time. Read as UTC days unless dateBasis is site_local,
   * when each run is judged by its OWN site's local day (#77; DST-safe: see siteDayBounds).
   */
  @IsOptional() @Matches(DATE_ONLY)
  from?: string;

  @IsOptional() @Matches(DATE_ONLY)
  to?: string;

  /** utc (the default, unchanged) or site_local. */
  @IsOptional() @IsIn(PATROL_DATE_BASES)
  dateBasis?: PatrolDateBasis;

  @IsOptional() @IsIn(PATROL_RUN_STATUSES)
  status?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize?: number;
}

export class PatrolOverviewQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  siteId?: number;

  /**
   * Calendar date (YYYY-MM-DD). utc (the default): the UTC day, today (UTC) when omitted. site_local (#77): each site's
   * own local day of that date; when omitted, today at the chosen site (or in Europe/London across all sites).
   */
  @IsOptional() @Matches(DATE_ONLY)
  date?: string;

  @IsOptional() @IsIn(PATROL_DATE_BASES)
  dateBasis?: PatrolDateBasis;
}

export class PatrolListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  siteId?: number;

  /** Include archived schedules / routes and revoked checkpoints. */
  @IsOptional() @IsIn(['true', 'false'])
  includeInactive?: string;
}

// ── Guard ─────────────────────────────────────────────────────────────────────────────────────────────

export class PatrolShiftQueryDto {
  @Type(() => Number) @IsInt() @Min(1)
  shiftId!: number;
}

export class StartPatrolRunDto extends PatrolLocationProbe {
  @Matches(PATROL_CLIENT_ID_PATTERN, { message: 'clientRunId must be 8–64 characters of A–Z, a–z, 0–9, _ or -' })
  clientRunId!: string;

  @IsInt() @Min(1)
  shiftId!: number;

  @IsOptional() @IsInt() @Min(1)
  scheduleId?: number | null;

  @IsOptional() @IsInt() @Min(1)
  routeId?: number | null;

  @IsInstantString()
  startedAtDevice!: string;

  /** P1-B: the device clock when this request was sent; the server measures drift from it (optional). */
  @IsOptional() @IsInstantString()
  sentAtDevice?: string;
}

export class RecordPatrolVisitDto extends PatrolLocationProbe {
  @Matches(PATROL_CLIENT_ID_PATTERN, { message: 'clientVisitId must be 8–64 characters of A–Z, a–z, 0–9, _ or -' })
  clientVisitId!: string;

  /** The checkpoint's publicId (32 hex). Without a signed label the scan is recorded as unverified. */
  @IsOptional() @IsString() @Matches(/^[0-9a-f]{32}$/, { message: 'checkpointPublicId must be 32 lowercase hex characters' })
  checkpointPublicId?: string;

  /** The raw label payload as scanned (s4cp:1:…). Preferred: the server verifies its signature. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(256)
  scanPayload?: string;

  @IsInstantString()
  scannedAtDevice!: string;

  /** P1-B: the device clock when this request was sent (optional). */
  @IsOptional() @IsInstantString()
  sentAtDevice?: string;
}

export class CompletePatrolRunDto extends PatrolLocationProbe {
  @IsInstantString()
  completedAtDevice!: string;

  /** Completing with a reason records the run as incomplete. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500)
  exceptionReason?: string;

  /** P1-B: the device clock when this request was sent (optional). */
  @IsOptional() @IsInstantString()
  sentAtDevice?: string;
}

// ── Patrol exceptions (P1-B) ──────────────────────────────────────────────────────────────────────────

export class PatrolExceptionsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  siteId?: number;

  @IsOptional() @IsIn(PATROL_EXCEPTION_STATUSES)
  status?: string;

  @IsOptional() @IsIn(PATROL_EXCEPTION_TYPES)
  type?: string;
}

/** Resolving a patrol exception: a reason from the patrol set (see resolution-reasons.ts) and, for most, a note. */
export class ResolvePatrolExceptionDto {
  @IsString() @MinLength(1) @MaxLength(64)
  resolutionReason!: string;

  @IsOptional() @IsString() @MaxLength(2000)
  resolutionNote?: string;
}

// ── S4 platform admin ─────────────────────────────────────────────────────────────────────────────────

export class SetPatrolsEnabledDto {
  @IsBoolean()
  patrolsEnabled!: boolean;
}
