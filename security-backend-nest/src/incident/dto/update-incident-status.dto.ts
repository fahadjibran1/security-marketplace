import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { IncidentStatus } from '../entities/incident.entity';
import { INCIDENT_RESOLUTION_REASONS, RESOLUTION_NOTE_MAX_LENGTH } from '../../safety-alert/resolution-reasons';

export class UpdateIncidentStatusDto {
  @IsEnum(IncidentStatus)
  status!: IncidentStatus;

  /**
   * DEPRECATED, and kept working on purpose.
   *
   * This field was always accepted and then silently discarded by `applyStatusUpdate` — a resolution
   * explanation typed by a control room went nowhere. The global pipe runs with
   * `forbidNonWhitelisted`, so simply deleting it would turn any existing caller that sends `notes`
   * into a 400; and leaving it discarded would keep losing the evidence.
   *
   * It is therefore an alias for `resolutionNote`, honoured ONLY when `resolutionNote` is absent.
   * That is the meaning the field always appeared to have, now actually implemented — it has never
   * been stored anywhere else, so nothing can be reading it with a different meaning today.
   */
  @IsOptional()
  @IsString()
  @MaxLength(RESOLUTION_NOTE_MAX_LENGTH)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  notes?: string;

  /** A stable machine value from the incident reason set. Never the words shown on screen. */
  @IsOptional()
  @IsString()
  @IsIn(INCIDENT_RESOLUTION_REASONS as unknown as string[])
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  resolutionReason?: string;

  /** What the resolver wrote. Stored beside the incident, never over the guard's own report. */
  @IsOptional()
  @IsString()
  @MaxLength(RESOLUTION_NOTE_MAX_LENGTH)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  resolutionNote?: string;
}
