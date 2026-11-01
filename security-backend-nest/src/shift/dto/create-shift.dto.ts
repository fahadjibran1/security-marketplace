import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { IsInstantString } from '../../common/validators/is-instant-string.validator';

export class CreateShiftDto {
  @IsOptional()
  @IsInt()
  assignmentId?: number;

  @IsOptional()
  @IsInt()
  companyId?: number;

  @IsOptional()
  @IsInt()
  guardId?: number;

  @IsOptional()
  @IsInt()
  jobId?: number;

  @IsOptional()
  @IsInt()
  jobApplicationId?: number;

  @IsOptional()
  @IsInt()
  createdByUserId?: number;

  @IsInt()
  siteId?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  checkCallIntervalMinutes?: number;

  @IsOptional()
  @IsString()
  siteName?: string;

  // Scheduled times are instants, carrying the site's offset. See IsInstantString.
  @IsInstantString()
  start!: string;

  @IsInstantString()
  end!: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  instructions?: string;

  @IsOptional()
  @IsString()
  closeOutNotes?: string;

  /**
   * S4 1.3.0 B1: whether this shift must patrol — 'required', 'not_required', or 'site_default' / null for the site's
   * patrol setup (shifts.manage, as every shift write). A change mid-shift applies to future patrol windows only.
   */
  @IsOptional()
  @IsIn(['required', 'not_required', 'site_default'])
  patrolRequirement?: 'required' | 'not_required' | 'site_default' | null;
}
