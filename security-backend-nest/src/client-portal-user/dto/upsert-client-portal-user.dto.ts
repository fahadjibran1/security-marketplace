import { IsBoolean, IsEmail, IsEnum, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

import { UserRole } from '../../user/entities/user.entity';

export class UpsertClientPortalUserDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  id?: number;

  @IsInt()
  @Min(1)
  clientId!: number;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  firstName!: string;

  @IsString()
  lastName!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsEnum(UserRole)
  role!: UserRole.CLIENT_ADMIN | UserRole.CLIENT_VIEWER;
}
