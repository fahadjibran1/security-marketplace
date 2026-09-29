import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';
import { IsInstantString } from '../../common/validators/is-instant-string.validator';

export class HireApplicationDto {
  @IsOptional()
  @IsBoolean()
  createShift?: boolean;

  @IsOptional()
  @IsString()
  siteName?: string;

  @IsOptional()
  @IsInt()
  siteId?: number;

  // Hiring may create the first shift, so these are scheduled times and must be instants.
  @IsOptional()
  @IsInstantString()
  start?: string;

  @IsOptional()
  @IsInstantString()
  end?: string;
}
