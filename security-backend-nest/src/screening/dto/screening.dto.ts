import { Transform } from 'class-transformer';
import { Equals, IsBoolean, IsDateString, IsEmail, IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { EvidenceCategory, HistoryType, ReferenceStatus, VerificationState } from '../entities/screening.entities';

export class StartScreeningDto { @IsOptional() @IsInt() @Min(1) @Max(10) screeningPeriodYears?: number; }

// The reviewer queue buckets. "needs_review" is the default reviewer workload: everything the
// reviewer can actually progress right now, which is why it spans three derived buckets.
export const SCREENING_QUEUE_FILTERS = ['needs_review','awaiting_review','under_review','needs_guard_action','ready_to_complete','vetted','not_submitted','all'] as const;
export type ScreeningQueueFilter = (typeof SCREENING_QUEUE_FILTERS)[number];
export class ScreeningQueueQueryDto {
  @IsOptional() @IsIn(SCREENING_QUEUE_FILTERS as unknown as string[]) filter?: ScreeningQueueFilter;
  @IsOptional() @Transform(({value})=>typeof value==='string'?value.trim():value) @IsString() @MaxLength(120) q?: string;
  // Query strings arrive as text; the global ValidationPipe transforms, so coerce explicitly.
  @IsOptional() @Transform(({value})=>value===''||value===undefined?undefined:Number(value)) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Transform(({value})=>value===''||value===undefined?undefined:Number(value)) @IsInt() @Min(0) offset?: number;
}
export class UpdateScreeningProfileDto {
  @IsString() @IsNotEmpty() @MaxLength(200) legalFullName!: string;
  @IsOptional() @IsString() @MaxLength(1000) previousNames?: string;
  @IsDateString() dateOfBirth!: string;
  @IsString() @IsNotEmpty() @MaxLength(100) nationality!: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(2000) currentAddress?: string;
  @IsOptional() @IsString() @MaxLength(100) siaLicenceType?: string;
}
export class AddHistoryDto {
  @IsEnum(HistoryType) type!: HistoryType; @IsDateString() startDate!: string;
  @IsOptional() @IsDateString() endDate?: string; @IsBoolean() isCurrent!: boolean;
  @IsOptional() @IsString() @MaxLength(200) organisation?: string; @IsOptional() @IsString() @MaxLength(2000) address?: string;
  @IsOptional() @IsString() @MaxLength(300) contactDetails?: string; @IsString() @IsNotEmpty() @MaxLength(3000) description!: string;
}
export class AddAddressDto { @IsOptional() @IsString() @IsNotEmpty() @MaxLength(2000) address?: string; @IsOptional() @IsString() @MaxLength(200) addressLine1?:string; @IsOptional() @IsString() @MaxLength(200) addressLine2?:string; @IsOptional() @IsString() @MaxLength(150) townCity?:string; @IsOptional() @IsString() @MaxLength(20) postcode?:string; @IsDateString() startDate!: string; @IsOptional() @IsDateString() endDate?: string; @IsBoolean() isCurrent!: boolean; }
export class UpdateCandidateComplianceDto { @IsOptional() @Transform(({value})=>typeof value==='string'?value.trim():value) @Matches(/^\d{16}$/,{message:'SIA licence number must be exactly 16 numeric digits.'}) siaLicenseNumber?:string; @IsOptional() @IsDateString() siaExpiryDate?:string|null; @IsOptional() @IsString() rightToWorkStatus?:string|null; @IsOptional() @IsDateString() rightToWorkExpiryDate?:string|null; }
export class AddReferenceDto {
  @IsInt() historyId!: number; @IsString() @IsNotEmpty() organisation!: string; @IsString() @IsNotEmpty() contactPerson!: string;
  @IsString() @IsNotEmpty() relationship!: string; @IsEmail() businessEmail!: string; @IsOptional() @IsString() phone?: string; @IsOptional() @IsString() postalDetails?: string;
}
export class ConsentDto { @IsString() @IsNotEmpty() @MaxLength(100) consentVersion!: string; }
export class CreateEvidenceDto {
  @IsEnum(EvidenceCategory) category!: EvidenceCategory; @IsString() @IsNotEmpty() originalFileName!: string;
  @IsString() @IsNotEmpty() mimeType!: string; @IsInt() @Min(1) @Max(10485760) sizeBytes!: number;
}
export class VerifyCheckDto { @IsEnum(VerificationState) state!: VerificationState; @IsString() @IsNotEmpty() @MaxLength(200) method!: string; @IsInt() @Min(1) evidenceId!:number; }
export class ReviewReferenceDto {
  @IsEnum(ReferenceStatus) status!: ReferenceStatus;
  @Transform(({value})=>typeof value==='string'?value.trim():value) @IsString() @IsNotEmpty() @IsIn(['Telephone call','Business email response','Official employer contact/details','Written reference','Other approved method']) verificationMethod!: string;
  @Transform(({value})=>typeof value==='string'?value.trim():value) @IsString() @IsNotEmpty() @MaxLength(3000) notes!: string;
  @Equals(true,{message:'Independent source verification must be explicitly confirmed.'}) confirmed!:boolean;
  // What the referee actually confirmed, which may differ from what the candidate claimed.
  @IsOptional() @IsDateString() confirmedStartDate?: string;
  @IsOptional() @IsDateString() confirmedEndDate?: string;
  @IsOptional() @IsBoolean() confirmedIsCurrent?: boolean;
}
export class ReviewActionDto { @Transform(({value})=>typeof value==='string'?value.trim():value) @IsString() @IsNotEmpty() @MaxLength(3000) reason!: string; }
