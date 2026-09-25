import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Bounded so an oversized body cannot be used to push work into the hashing path. The length range
 * covers a base64url-encoded 256-bit token with room for future formats; anything outside it fails the
 * same way an unknown code does.
 */
export class RedeemCompanyGuardInvitationDto {
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  code!: string;
}
