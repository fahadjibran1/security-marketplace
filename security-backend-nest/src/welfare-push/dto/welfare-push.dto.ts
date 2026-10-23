import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

export class RegisterPushDeviceDto {
  /** An Expo push token. Shape-checked again in the service before anything is stored. */
  @IsString()
  @MaxLength(255)
  @Matches(/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/)
  token!: string;

  @IsIn(['ios', 'android'])
  platform!: 'ios' | 'android';

  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;
}

export class UnregisterPushDeviceDto {
  @IsString()
  @MaxLength(255)
  token!: string;
}

/**
 * A Guard's answer from a Welfare Check notification. The ids are only hints: the server re-resolves the Guard from
 * the session, the shift from the database, and the window from its own clock, and refuses anything that does not match.
 */
export class WelfareActionDto {
  @IsInt()
  @Min(1)
  shiftId!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  reminderId?: number;
}
