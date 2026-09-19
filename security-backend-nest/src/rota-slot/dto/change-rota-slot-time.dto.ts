import { IsDateString } from 'class-validator';

export class ChangeRotaSlotTimeDto {
  @IsDateString()
  startAt!: string;

  @IsDateString()
  endAt!: string;
}
