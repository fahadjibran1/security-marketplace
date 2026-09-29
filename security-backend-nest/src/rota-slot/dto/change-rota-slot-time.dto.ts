import { IsInstantString } from '../../common/validators/is-instant-string.validator';

export class ChangeRotaSlotTimeDto {
  // Scheduled times are instants, carrying the site's offset. See IsInstantString.
  @IsInstantString()
  startAt!: string;

  @IsInstantString()
  endAt!: string;
}
