import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Manual attendance (Migration 67). Only the shape is checked here; the meaning (explicit time zone, reason, method,
 * note for "other", the time window and who may record what) is checked by manual-attendance-policy.ts, which answers
 * with a machine-readable code.
 */
export class CorrectAttendanceDto {
  /** The ACTUAL time, ISO-8601 with a zone (stored as UTC). */
  @IsString()
  @MaxLength(40)
  occurredAt!: string;

  @IsString()
  @MaxLength(2000)
  reason!: string;

  @IsString()
  @MaxLength(40)
  verificationMethod!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  verificationNote?: string;
}

export class ManualAttendanceDto extends CorrectAttendanceDto {
  @IsInt()
  shiftId!: number;
}

export class AttendanceAuthorisationDto {
  @IsBoolean()
  canManageAttendance!: boolean;
}
