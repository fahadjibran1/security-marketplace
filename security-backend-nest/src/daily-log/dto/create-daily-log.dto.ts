import { IsEnum, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { DailyLogType } from '../entities/daily-log.entity';

/** A daily log message is an operational narrative, not an unbounded text dump. */
export const DAILY_LOG_MESSAGE_MAX_LENGTH = 4000;

export class CreateDailyLogDto {
  @IsInt()
  shiftId!: number;

  @IsString()
  @MaxLength(DAILY_LOG_MESSAGE_MAX_LENGTH)
  message!: string;

  @IsOptional()
  @IsEnum(DailyLogType)
  logType?: DailyLogType;
}
