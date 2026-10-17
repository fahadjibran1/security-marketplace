import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  SHIFT_RECONCILIATION_NOTE_MAX,
  SHIFT_RECONCILIATION_REASONS,
  ShiftReconciliationReason,
} from '../shift-reconciliation';

/** Close without Book Off. A reason is mandatory; "other" also requires a note (checked in the service). */
export class ReconcileShiftDto {
  @IsIn(SHIFT_RECONCILIATION_REASONS as unknown as string[])
  reason!: ShiftReconciliationReason;

  @IsOptional()
  @IsString()
  @MaxLength(SHIFT_RECONCILIATION_NOTE_MAX)
  note?: string | null;
}
