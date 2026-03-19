import { IsString } from 'class-validator';

export class UpdateIncidentStatusDto {
  @IsString()
  status!: string;
}
