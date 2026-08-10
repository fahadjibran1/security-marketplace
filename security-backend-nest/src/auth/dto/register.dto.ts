import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

export enum PublicRegistrationRole {
  COMPANY = 'company',
  COMPANY_ADMIN = 'company_admin',
  GUARD = 'guard',
}

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsEnum(PublicRegistrationRole)
  role!: PublicRegistrationRole;

  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  siaLicenseNumber?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsString()
  companyNumber?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  contactDetails?: string;
}
