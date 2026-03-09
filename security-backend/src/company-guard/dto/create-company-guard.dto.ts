import { IsEnum, IsInt, IsOptional } from 'class-validator';
import { CompanyGuardRelationshipType, CompanyGuardStatus } from '../entities/company-guard.entity';

export class CreateCompanyGuardDto {
  @IsInt()
  companyId!: number;

  @IsInt()
  guardId!: number;

  @IsOptional()
  @IsEnum(CompanyGuardStatus)
  status?: CompanyGuardStatus;

  @IsOptional()
  @IsEnum(CompanyGuardRelationshipType)
  relationshipType?: CompanyGuardRelationshipType;
}
