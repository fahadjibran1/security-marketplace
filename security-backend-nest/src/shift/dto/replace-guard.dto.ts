import { IsInt, IsString, MaxLength, Min } from 'class-validator';
import { REPLACE_GUARD_REASON_MAX_LENGTH } from '../replace-guard-policy';

export class ReplaceGuardDto {
  @IsInt()
  @Min(1)
  replacementGuardId!: number;

  /** Why the Guard is being replaced. Recorded in the audit entry only; never shown to either Guard. */
  @IsString()
  @MaxLength(REPLACE_GUARD_REASON_MAX_LENGTH)
  reason!: string;
}
