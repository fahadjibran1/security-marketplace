import { IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { DailyLogType } from '../entities/daily-log.entity';

export class CreateDailyLogDto {
  @IsInt()
  shiftId!: number;

  @IsString()
  message!: string;

  @IsOptional()
  @IsEnum(DailyLogType)
  logType?: DailyLogType;
}
