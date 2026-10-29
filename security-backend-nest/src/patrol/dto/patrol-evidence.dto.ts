import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { IsInstantString } from '../../common/validators/is-instant-string.validator';
import { PATROL_CLIENT_ID_PATTERN, PATROL_HOLD_SCOPES } from '../patrol-constants';
import { PATROL_EVIDENCE_ACCESS_PURPOSES, PATROL_EXPORT_MAX_RUN_IDS, PATROL_EXPORT_PURPOSES } from '../evidence/patrol-evidence-shared';
import { PatrolLocationProbe } from './patrol.dto';

const DATE_ONLY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * The Guard asks to upload one photo of a run (Patrols P1-C). Idempotent on clientEvidenceId; the declared type, size and
 * SHA-256 are what the server will hold the upload to. Location fields are refused (PatrolLocationProbe).
 */
export class RequestPatrolEvidenceUploadDto extends PatrolLocationProbe {
  @Matches(PATROL_CLIENT_ID_PATTERN, { message: 'clientEvidenceId must be 8–64 characters of A–Z, a–z, 0–9, _ or -' })
  clientEvidenceId!: string;

  @IsIn(['run_photo', 'checkpoint_photo'])
  kind!: 'run_photo' | 'checkpoint_photo';

  /** checkpoint_photo: the scan it belongs to (a visit of this run). */
  @IsOptional() @IsInt() @Min(1)
  visitId?: number;

  /** Checked against the allow-list by the service (PATROL_EVIDENCE_TYPE_NOT_ALLOWED). */
  @IsString() @MaxLength(64)
  contentType!: string;

  /** Checked against the configured cap by the service (PATROL_EVIDENCE_TOO_LARGE). */
  @IsInt() @Min(1)
  sizeBytes!: number;

  @Matches(/^[0-9a-f]{64}$/, { message: 'sha256 must be 64 lowercase hex characters' })
  sha256!: string;

  @IsInstantString()
  capturedAtDevice!: string;

  @IsOptional() @IsInstantString()
  sentAtDevice?: string;
}

export class PatrolEvidenceAccessQueryDto {
  @IsIn(PATROL_EVIDENCE_ACCESS_PURPOSES)
  purpose!: string;
}

export class PatrolEvidenceReasonDto {
  @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}

export class CreatePatrolEvidenceHoldDto {
  @IsIn(PATROL_HOLD_SCOPES)
  scope!: string;

  @IsOptional() @IsInt() @Min(1)
  evidenceId?: number;

  @IsOptional() @IsInt() @Min(1)
  runId?: number;

  @IsOptional() @IsInt() @Min(1)
  shiftId?: number;

  @IsOptional() @IsInt() @Min(1)
  siteId?: number;

  @IsOptional() @Matches(DATE_ONLY)
  fromDate?: string;

  @IsOptional() @Matches(DATE_ONLY)
  toDate?: string;

  @IsString() @MinLength(3) @MaxLength(1000)
  reason!: string;

  /** Optional links (each must be this company's). */
  @IsOptional() @IsInt() @Min(1)
  incidentId?: number;

  @IsOptional() @IsInt() @Min(1)
  safetyAlertId?: number;

  @IsOptional() @IsInt() @Min(1)
  exceptionId?: number;
}

export class ReleasePatrolEvidenceHoldDto {
  @IsString() @MinLength(3) @MaxLength(1000)
  reason!: string;
}

export class CreatePatrolEvidenceExportDto {
  @IsIn(PATROL_EXPORT_PURPOSES)
  purpose!: string;

  @IsOptional() @IsInt() @Min(1)
  siteId?: number;

  @IsOptional() @Matches(DATE_ONLY)
  fromDate?: string;

  @IsOptional() @Matches(DATE_ONLY)
  toDate?: string;

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(PATROL_EXPORT_MAX_RUN_IDS) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true })
  runIds?: number[];
}

export class PatrolEvidenceHoldsQueryDto {
  @IsOptional() @IsIn(['active', 'all'])
  status?: string;
}

export class PatrolEvidenceListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500)
  limit?: number;
}
