import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

import { ComplianceRecordType } from '../entities/compliance-record.entity';

export class UpsertComplianceRecordDto {
  @IsInt()
  @Min(1)
  guardId!: number;

  @IsEnum(ComplianceRecordType)
  type!: ComplianceRecordType;

  @IsString()
  documentName!: string;

  @IsOptional()
  @IsString()
  documentNumber?: string | null;

  @IsOptional()
  @IsDateString()
  issueDate?: string | null;

  @IsDateString()
  expiryDate!: string;
}
