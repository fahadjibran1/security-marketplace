export class UpdateGuardIdentityDto {
  // Plaintext values are received, validated, then immediately encrypted.
  // Never logged, never stored plaintext, never echoed back in any response.
  ninoPlaintext?: string;
  utrPlaintext?: string;
}
