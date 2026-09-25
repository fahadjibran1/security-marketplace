import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { CompanyGuardRelationshipType } from '../entities/company-guard.entity';

/**
 * No companyId: the issuing company is always resolved from the authenticated membership context and
 * is never accepted from the request body.
 */
export class CreateCompanyGuardInvitationDto {
  @IsOptional()
  @IsEnum(CompanyGuardRelationshipType)
  relationshipType?: CompanyGuardRelationshipType;

  /**
   * Optional. Binds the code to one SIA licence so a leaked code cannot be claimed by anyone else.
   * Never looked up here — validated for shape only, then compared against the accepting guard's own
   * record, so it cannot be used to test whether a licence exists on the platform.
   */
  @IsOptional()
  @IsString()
  @Length(16, 16, { message: 'SIA licence number must be exactly 16 numeric digits.' })
  targetSiaLicenceNumber?: string;
}
