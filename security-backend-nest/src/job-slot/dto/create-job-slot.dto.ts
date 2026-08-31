import { IsInt, IsOptional, IsString } from 'class-validator';

export class CreateJobSlotDto {
  @IsInt()
  jobId!: number;

  @IsInt()
  slotNumber!: number;

  @IsOptional()
  @IsString()
  status?: string;
}
