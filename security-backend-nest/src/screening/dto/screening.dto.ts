import { IsBoolean, IsDateString, IsEmail, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { EvidenceCategory, HistoryType, ReferenceStatus, VerificationState } from '../entities/screening.entities';

export class StartScreeningDto { @IsOptional() @IsInt() @Min(1) @Max(10) screeningPeriodYears?: number; }
export class UpdateScreeningProfileDto {
  @IsString() @IsNotEmpty() @MaxLength(200) legalFullName!: string;
  @IsOptional() @IsString() @MaxLength(1000) previousNames?: string;
  @IsDateString() dateOfBirth!: string;
  @IsString() @IsNotEmpty() @MaxLength(100) nationality!: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) currentAddress!: string;
  @IsOptional() @IsString() @MaxLength(100) siaLicenceType?: string;
}
export class AddHistoryDto {
  @IsEnum(HistoryType) type!: HistoryType; @IsDateString() startDate!: string;
  @IsOptional() @IsDateString() endDate?: string; @IsBoolean() isCurrent!: boolean;
  @IsOptional() @IsString() @MaxLength(200) organisation?: string; @IsOptional() @IsString() @MaxLength(2000) address?: string;
  @IsOptional() @IsString() @MaxLength(300) contactDetails?: string; @IsString() @IsNotEmpty() @MaxLength(3000) description!: string;
}
export class AddAddressDto { @IsString() @IsNotEmpty() @MaxLength(2000) address!: string; @IsDateString() startDate!: string; @IsOptional() @IsDateString() endDate?: string; @IsBoolean() isCurrent!: boolean; }
export class AddReferenceDto {
  @IsInt() historyId!: number; @IsString() @IsNotEmpty() organisation!: string; @IsString() @IsNotEmpty() contactPerson!: string;
  @IsString() @IsNotEmpty() relationship!: string; @IsEmail() businessEmail!: string; @IsOptional() @IsString() phone?: string; @IsOptional() @IsString() postalDetails?: string;
}
export class ConsentDto { @IsString() @IsNotEmpty() @MaxLength(100) consentVersion!: string; }
export class CreateEvidenceDto {
  @IsEnum(EvidenceCategory) category!: EvidenceCategory; @IsString() @IsNotEmpty() originalFileName!: string;
  @IsString() @IsNotEmpty() mimeType!: string; @IsInt() @Min(1) @Max(10485760) sizeBytes!: number;
}
export class VerifyCheckDto { @IsEnum(VerificationState) state!: VerificationState; @IsString() @IsNotEmpty() @MaxLength(200) method!: string; }
export class ReviewReferenceDto { @IsEnum(ReferenceStatus) status!: ReferenceStatus; @IsBoolean() sourceVerified!: boolean; @IsString() @IsNotEmpty() verificationMethod!: string; @IsOptional() @IsString() @MaxLength(3000) notes?: string; }
export class ReviewActionDto { @IsString() @IsNotEmpty() @MaxLength(3000) reason!: string; }
