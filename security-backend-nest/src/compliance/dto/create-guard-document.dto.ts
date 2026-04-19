import { IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUrl } from 'class-validator';

import { GuardDocumentType } from '../entities/guard-document.entity';

export class CreateGuardDocumentDto {
  @IsOptional()
  @IsInt()
  guardId?: number;

  @IsEnum(GuardDocumentType)
  type!: GuardDocumentType;

  @IsString()
  @IsUrl({ require_tld: false }, { message: 'fileUrl must be a valid URL' })
  fileUrl!: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string | null;
}
