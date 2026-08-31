import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

import { GuardLeaveStatus, GuardLeaveType } from '../entities/guard-leave.entity';

export class UpsertGuardLeaveDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  id?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  guardId?: number;

  @IsEnum(GuardLeaveType)
  leaveType!: GuardLeaveType;

  @IsDateString()
  startAt!: string;

  @IsDateString()
  endAt!: string;

  @IsOptional()
  @IsString()
  reason?: string | null;

  @IsOptional()
  @IsEnum(GuardLeaveStatus)
  status?: GuardLeaveStatus;
}
