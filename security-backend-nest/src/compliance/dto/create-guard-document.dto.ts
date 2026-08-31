import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { GuardDocumentType } from '../entities/guard-document.entity';

export class CreateGuardDocumentDto {
  @IsOptional()
  @IsInt()
  guardId?: number;

  @IsEnum(GuardDocumentType)
  type!: GuardDocumentType;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  originalFileName?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  mimeType?: string;

  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(10 * 1024 * 1024)
  sizeBytes?: number;

  // Compile-time compatibility for direct service tests only. With no validation
  // decorator, the global whitelist rejects this legacy field at the API boundary.
  fileUrl?: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string | null;
}
