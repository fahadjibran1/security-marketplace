import { IsInt, IsString } from 'class-validator';
import { CompanyStatus } from '../entities/company.entity';
import { IsEnum, IsOptional } from 'class-validator';

export class CreateCompanyDto {
  @IsInt()
  userId!: number;

  @IsString()
  name!: string;

  @IsString()
  companyNumber!: string;

  @IsString()
  address!: string;

  @IsString()
  contactDetails!: string;

  @IsOptional()
  @IsEnum(CompanyStatus)
  status?: CompanyStatus;
}
