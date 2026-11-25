import { IsString, MaxLength, MinLength } from 'class-validator';

/** A code from the authenticator app. Its format (6 digits) is checked by the service, so a malformed code counts as a failure. */
export class MfaCodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  code!: string;
}

export class MfaVerifyDto extends MfaCodeDto {
  @IsString()
  @MinLength(20)
  @MaxLength(2048)
  challengeToken!: string;
}
