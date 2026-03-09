import { IsInt } from 'class-validator';

export class CreateInternalAssignmentDto {
  @IsInt()
  jobSlotId!: number;

  @IsInt()
  guardId!: number;
}
