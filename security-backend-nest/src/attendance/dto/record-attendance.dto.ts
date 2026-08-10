import { IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class RecordAttendanceDto {
  @IsInt()
  shiftId!: number;

  @IsOptional()
  @IsString()
  nfcTag?: string;

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
  @IsNumber()
  @Min(0)
  gpsAccuracyMeters?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
