import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../password-policy';

export class ForgotPasswordDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

export class ResendVerificationDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

/**
 * Length bounds on the token keep an oversized body from reaching the hash. The value itself is never
 * echoed back in a validation message.
 */
export class ResetPasswordDto {
  @IsString()
  @MinLength(20, { message: 'This password reset link is invalid or has expired.' })
  @MaxLength(512, { message: 'This password reset link is invalid or has expired.' })
  token!: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` })
  @MaxLength(PASSWORD_MAX_LENGTH, { message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.` })
  newPassword!: string;
}

export class VerifyEmailDto {
  @IsString()
  @MinLength(20, { message: 'This verification link is invalid or has expired.' })
  @MaxLength(512, { message: 'This verification link is invalid or has expired.' })
  token!: string;
}
