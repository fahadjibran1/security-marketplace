import { IsInt, Min } from 'class-validator';

export class ChangeRotaSlotCheckCallDto {
  @IsInt()
  @Min(5)
  checkCallIntervalMinutes!: number;
}
