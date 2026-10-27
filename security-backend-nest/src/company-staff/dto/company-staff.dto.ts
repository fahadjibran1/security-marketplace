import { IsEmail, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { CompanyMembershipRole } from '../../company-membership/company-membership-types';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../auth/password-policy';

const INVALID_LINK = 'This invitation link is invalid or has expired.';

export class InviteCompanyStaffDto {
  // Surrounding spaces from a paste are not part of an address.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(320)
  email!: string;

  @IsEnum(CompanyMembershipRole, { message: 'Choose a role for this person.' })
  role!: CompanyMembershipRole;
}

export class ChangeCompanyStaffRoleDto {
  @IsEnum(CompanyMembershipRole, { message: 'Choose a role for this person.' })
  role!: CompanyMembershipRole;
}

export class CompanyStaffAuditQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

/** The token travels in the body only, never in a URL the app builds. Its value is never echoed back. */
export class StaffInvitationTokenDto {
  @IsString()
  @MinLength(20, { message: INVALID_LINK })
  @MaxLength(512, { message: INVALID_LINK })
  token!: string;
}

/**
 * Accepting. A new S4 account chooses its own password here, under the same rules registration and password reset
 * apply; an existing account keeps its password and any value sent is ignored.
 */
export class AcceptStaffInvitationDto extends StaffInvitationTokenDto {
  @IsOptional()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` })
  @MaxLength(PASSWORD_MAX_LENGTH, { message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.` })
  newPassword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;
}
