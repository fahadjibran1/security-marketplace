import { Type } from 'class-transformer';
import { IsArray, IsInt, Min, ValidateNested } from 'class-validator';

class PositionAssignmentItem {
  @IsInt()
  @Min(1)
  shiftId!: number;

  @IsInt()
  @Min(1)
  guardId!: number;
}

export class AssignMultipleRotaSlotPositionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PositionAssignmentItem)
  assignments!: PositionAssignmentItem[];
}
