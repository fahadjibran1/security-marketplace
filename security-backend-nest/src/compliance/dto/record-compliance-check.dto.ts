import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import {
  CHECK_CHANGE_TYPES,
  COMPLIANCE_CHECK_KINDS,
  COMPLIANCE_CHECK_OUTCOMES,
  ComplianceCheckChangeType,
  ComplianceCheckKind,
  ComplianceCheckOutcome,
  RIGHT_TO_WORK_CHECK_METHODS,
  RIGHT_TO_WORK_EXCUSES,
  SIA_CHECK_METHODS,
} from '../compliance-check-vocabulary';

/**
 * Records a company's SIA or Right to Work check. The company is never taken from the body: it is
 * resolved from the caller's membership. Cross-field rules (which method suits which kind, when an
 * expiry is required) are enforced in GuardComplianceCheckService.normalise.
 */
export class RecordComplianceCheckDto {
  @IsInt()
  @Min(1)
  guardId!: number;

  @IsIn(COMPLIANCE_CHECK_KINDS)
  kind!: ComplianceCheckKind;

  @IsIn(COMPLIANCE_CHECK_OUTCOMES)
  outcome!: ComplianceCheckOutcome;

  @IsIn([...SIA_CHECK_METHODS, ...RIGHT_TO_WORK_CHECK_METHODS])
  method!: string;

  @IsOptional()
  @IsIn(RIGHT_TO_WORK_EXCUSES)
  rightToWorkExcuse?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  licenceNumber?: string | null;

  @IsString()
  checkDate!: string;

  @IsOptional()
  @IsString()
  expiryDate?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  workRestrictions?: string | null;

  @IsString()
  @MaxLength(120)
  checkedByName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  evidenceReference?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  evidenceDocumentId?: number | null;

  /** Required when a current check exists: the id the caller is replacing (stale-edit protection). */
  @IsOptional()
  @IsInt()
  @Min(1)
  replacesCheckId?: number | null;

  @IsOptional()
  @IsIn(CHECK_CHANGE_TYPES)
  changeType?: ComplianceCheckChangeType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  changeReason?: string | null;
}
