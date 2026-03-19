import { IsInt, IsOptional, IsString } from 'class-validator';

export class RecordAttendanceDto {
  @IsInt()
  shiftId!: number;

  @IsOptional()
  @IsString()
  nfcTag?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
