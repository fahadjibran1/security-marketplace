import { IsEnum, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { SafetyAlertPriority, SafetyAlertType } from '../entities/safety-alert.entity';
import { EMERGENCY_MESSAGE_MAX_LENGTH } from '../emergency-alert';

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

  /**
   * Optional for an Emergency (S4-EM-01: no description is required; the server supplies a standard one). Every other
   * Guard-raised type still requires words, which the service enforces after trimming.
   */
  @IsOptional()
  @IsString()
  @MaxLength(EMERGENCY_MESSAGE_MAX_LENGTH)
  message?: string;
}
