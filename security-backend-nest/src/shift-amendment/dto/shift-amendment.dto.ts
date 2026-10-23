import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { VERBAL_CONTACT_METHODS } from '../shift-amendment-policy';

/** Instants carry an explicit offset (ISO 8601), so a proposal is never read in the server's local time. */
const ISO_INSTANT = { strict: true, strictSeparator: true };

export class ProposeAmendmentDto {
  @IsISO8601(ISO_INSTANT)
  proposedEnd!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/** A dry-run assessment of a proposed end: the same instant rules as a proposal, nothing else. */
export class AssessAmendmentDto {
  @IsISO8601(ISO_INSTANT)
  proposedEnd!: string;
}

export class ApproveAmendmentDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  statement!: string;

  /** Required (true) when the approver also proposed the extension; recorded as an audited self-approval. */
  @IsOptional()
  @IsBoolean()
  confirmSelfApproval?: boolean;
}

export class WithdrawAmendmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RespondAmendmentDto {
  @IsIn(['accepted', 'declined'])
  response!: 'accepted' | 'declined';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RecordVerbalAgreementDto {
  /** Must equal the proposed end exactly: staff record the terms the Guard agreed to, never different ones. */
  @IsISO8601(ISO_INSTANT)
  agreedEnd!: string;

  @IsIn(VERBAL_CONTACT_METHODS as unknown as string[])
  contactMethod!: (typeof VERBAL_CONTACT_METHODS)[number];

  @IsISO8601(ISO_INSTANT)
  contactAt!: string;

  /** The staff member's confirmation statement, e.g. "Spoke to the Guard by phone; they agreed to stay until 22:00." */
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  confirmation!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class DisputeAmendmentDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ResolveDisputeDto {
  @IsIn(['upheld', 'corrected'])
  resolution!: 'upheld' | 'corrected';

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note!: string;
}

export class UpdateShiftPolicyDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(48)
  fatigueWarningHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(48)
  approvalRequiredHours?: number;

  /** null = no hard limit. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(72)
  hardLimitHours?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(48)
  minRestHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(168)
  weeklyReviewHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(240)
  lastMinuteWarningMinutes?: number;
}

export class ControlRoomAuthorisationDto {
  @IsBoolean()
  canAmendShifts!: boolean;
}

export class CompanyAmendmentsEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}
