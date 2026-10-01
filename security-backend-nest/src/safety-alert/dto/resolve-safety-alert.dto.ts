import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { RESOLUTION_NOTE_MAX_LENGTH } from '../resolution-reasons';

/**
 * Closing a safety alert, with the evidence of why.
 *
 * Both fields are optional HERE and conditionally required in the service, because what is required
 * depends on the alert's own type — which the request does not carry and must not be trusted to. The
 * service loads the alert, reads its type, and applies that type's rule.
 *
 * Trimmed on the way in, so a note of spaces cannot satisfy a requirement for an explanation.
 */
export class ResolveSafetyAlertDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  resolutionReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(RESOLUTION_NOTE_MAX_LENGTH)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  resolutionNote?: string;
}
