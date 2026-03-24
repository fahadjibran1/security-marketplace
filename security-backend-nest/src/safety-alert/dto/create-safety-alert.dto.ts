import { IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { SafetyAlertPriority, SafetyAlertType } from '../entities/safety-alert.entity';

export class CreateSafetyAlertDto {
  @IsOptional()
  @IsInt()
  shiftId?: number;

  @IsOptional()
  @IsEnum(SafetyAlertType)
  type?: SafetyAlertType;

  @IsOptional()
  @IsEnum(SafetyAlertPriority)
  priority?: SafetyAlertPriority;

  @IsString()
  message!: string;
}
