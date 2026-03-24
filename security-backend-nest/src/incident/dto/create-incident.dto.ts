import { IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { IncidentCategory, IncidentSeverity } from '../entities/incident.entity';

export class CreateIncidentDto {
  @IsString()
  title!: string;

  @IsString()
  notes!: string;

  @IsEnum(IncidentSeverity)
  severity!: IncidentSeverity;

  @IsOptional()
  @IsEnum(IncidentCategory)
  category?: IncidentCategory;

  @IsOptional()
  @IsString()
  locationText?: string;

  @IsOptional()
  @IsInt()
  shiftId?: number;
}
