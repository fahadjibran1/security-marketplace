import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import {
  REPLACE_GUARD_REASON_CATEGORY_KEYS,
  REPLACE_GUARD_REASON_MAX_LENGTH,
  ReplaceGuardReasonCategory,
} from '../replace-guard-policy';

export class ReplaceGuardDto {
  @IsInt()
  @Min(1)
  replacementGuardId!: number;

  /** The neutral reason the outgoing Guard is shown (one of a fixed set). */
  @IsString()
  @IsIn(REPLACE_GUARD_REASON_CATEGORY_KEYS)
  reasonCategory!: ReplaceGuardReasonCategory;

  /** Why the Guard is being replaced. Recorded in the audit log only; never shown to either Guard. */
  @IsString()
  @MaxLength(REPLACE_GUARD_REASON_MAX_LENGTH)
  reason!: string;

  /** Required, and only allowed, when an accepted shift has started: the Guard has not booked on. */
  @IsOptional()
  @IsBoolean()
  noShow?: boolean;

  /** Required when the replacement's shift is over the approval threshold (Owner / Admin only). */
  @IsOptional()
  @IsBoolean()
  fatigueAcknowledged?: boolean;
}
