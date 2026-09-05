import { IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { EmergencyContactRelationship } from '../entities/guard-emergency-contact.entity';

// Phone: optional leading +, then digits/spaces/hyphens/dots/parens, 7–20 chars total.
// Conservative — rejects clearly invalid input without enforcing E.164 normalisation.
export const PHONE_PATTERN = /^\+?[\d\s\-().]{7,20}$/;
export const PHONE_MESSAGE =
  'Phone number must be 7–20 characters and contain only digits, spaces, hyphens, dots, or parentheses.';

export class UpdateEmergencyContactDto {
  // Plaintext received; immediately encrypted in service. Never logged or returned as ciphertext.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  contactName?: string;

  @IsOptional()
  @IsEnum(EmergencyContactRelationship)
  relationship?: EmergencyContactRelationship;

  // Only relevant when relationship = OTHER.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  customRelationship?: string | null;

  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  primaryPhone?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  alternatePhone?: string | null;
}
