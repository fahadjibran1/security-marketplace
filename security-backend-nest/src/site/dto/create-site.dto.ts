import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

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
