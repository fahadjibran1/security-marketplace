import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Min } from 'class-validator';
import { IsInstantString } from '../../common/validators/is-instant-string.validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** GET /patrols/monitor/summary (S4 Patrol Monitor S1). */
export class PatrolMonitorSummaryQueryDto {
  /** The site-local date (YYYY-MM-DD), read at each site's own zone; today at each site by default. */
  @IsOptional() @Matches(DATE_ONLY)
  date?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  clientId?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  siteId?: number;
}

/**
 * GET /patrols/monitor/sites/:siteId (S4 Patrol Monitor S1). Either `date` (the site-local day, today by default) or a
 * `from` / `to` instant range of at most 36 hours (the live view), never both.
 */
export class PatrolMonitorSiteQueryDto {
  @IsOptional() @Matches(DATE_ONLY)
  date?: string;

  @IsOptional() @IsInstantString()
  from?: string;

  @IsOptional() @IsInstantString()
  to?: string;
}
