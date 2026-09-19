import { IsInt, Min } from 'class-validator';

export class AssignRotaSlotPositionDto {
  @IsInt()
  @Min(1)
  shiftId!: number;

  @IsInt()
  @Min(1)
  guardId!: number;
}
