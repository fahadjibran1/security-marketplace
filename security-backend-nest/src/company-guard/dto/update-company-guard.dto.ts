import { IsEnum } from 'class-validator';
import { CompanyGuardStatus } from '../entities/company-guard.entity';

export class UpdateCompanyGuardDto {
  @IsEnum(CompanyGuardStatus)
  status!: CompanyGuardStatus;
}
