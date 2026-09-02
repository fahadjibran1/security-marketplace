import { IsOptional, IsString } from 'class-validator';

export class UpdateGuardIdentityDto {
  // Plaintext values are received, validated, then immediately encrypted.
  // Never logged, never stored plaintext, never echoed back in any response.
  @IsOptional()
  @IsString()
  ninoPlaintext?: string;

  @IsOptional()
  @IsString()
  utrPlaintext?: string;
}
