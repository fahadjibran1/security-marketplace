import { IsInt, Min } from 'class-validator';

export class ChangeRotaSlotRequirementDto {
  @IsInt()
  @Min(1)
  requiredGuardCount!: number;
}
