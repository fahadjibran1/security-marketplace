import { IsEnum, IsOptional, IsString } from 'class-validator';
import { IncidentStatus } from '../entities/incident.entity';

export class UpdateIncidentStatusDto {
  @IsEnum(IncidentStatus)
  status!: IncidentStatus;

  @IsOptional()
  @IsString()
  notes?: string;
}
