import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateRotaSlotMetadataDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string | null;

  @IsOptional()
  @IsString()
  instructions?: string | null;

  /**
   * S4 1.3.0 B2: sets the patrol requirement of every open position of the slot ('site_default' = the site's guided
   * setup decides). Completed, missed and cancelled positions keep theirs (part of their record).
   */
  @IsOptional()
  @IsIn(['required', 'not_required', 'site_default'])
  patrolRequirement?: 'required' | 'not_required' | 'site_default' | null;
}
