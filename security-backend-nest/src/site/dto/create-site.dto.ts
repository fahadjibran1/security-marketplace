import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, registerDecorator, ValidationOptions } from 'class-validator';

/**
 * A site's timezone reaches Intl.DateTimeFormat when the billing week is computed
 * (client-weekly-approval). An unusable zone would throw there — long after the site was created —
 * so it is rejected at the point of entry instead.
 */
export function IsIanaTimeZone(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isIanaTimeZone', target: object.constructor, propertyName, options,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string' || !value.trim()) return false;
          try { new Intl.DateTimeFormat('en-GB', { timeZone: value.trim() }); return true; } catch { return false; }
        },
        defaultMessage: () => 'timezone must be a valid IANA timezone, for example Europe/London',
      },
    });
  };
}

export class CreateSiteDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  clientName?: string;

  @IsOptional()
  @IsInt()
  clientId?: number;

  @IsString()
  address!: string;

  @IsOptional()
  @IsString()
  contactDetails?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  requiredGuardCount?: number;

  @IsOptional()
  @IsString()
  operatingDays?: string;

  @IsOptional()
  @IsString()
  operatingStartTime?: string;

  @IsOptional()
  @IsString()
  operatingEndTime?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  welfareCheckIntervalMinutes?: number;

  @IsOptional()
  @IsString()
  specialInstructions?: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @IsOptional()
  @IsInt()
  @Min(25)
  @Max(5000)
  geofenceRadiusMeters?: number;

  @IsOptional()
  @IsBoolean()
  requireGpsCheckIn?: boolean;

  @IsOptional()
  @IsString()
  attendanceNfcTag?: string;

  @IsOptional()
  @IsBoolean()
  requireNfcCheckIn?: boolean;

  /** Per site, not per company: one company can operate sites in different zones. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @IsIanaTimeZone()
  timezone?: string;

  @IsOptional()
  @IsString()
  initialShiftDate?: string;

  @IsOptional()
  @IsString()
  initialShiftStartTime?: string;

  @IsOptional()
  @IsString()
  initialShiftEndTime?: string;
}
