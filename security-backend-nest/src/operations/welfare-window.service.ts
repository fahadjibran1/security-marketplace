import { Injectable } from '@nestjs/common';
import { DailyLogType } from '../daily-log/entities/daily-log.entity';
import { WELFARE_COMPLETION_LOG_TYPES } from './operational-completion';
import { OperationalWindowService } from './operational-window.service';
import {
  OperationalApplicability,
  OperationalCompletion,
  OperationalCompletionKind,
  OperationalWindowResolution,
} from './operational-window.types';

/** Grace before an unmet Welfare Check window becomes MISSED. Product-locked at 5 minutes. */
export const WELFARE_GRACE_MINUTES = 5;

/** Used when neither the site nor the shift specifies an interval. */
export const WELFARE_DEFAULT_INTERVAL_MINUTES = 60;

/**
 * The sweep has always floored the interval. Keeping the floor prevents a misconfigured
 * one-minute interval from generating an alert storm against a Guard who is doing nothing wrong.
 */
export const WELFARE_MINIMUM_INTERVAL_MINUTES = 5;

export interface WelfareIntervalSource {
  readonly siteWelfareCheckIntervalMinutes?: number | null;
  readonly shiftCheckCallIntervalMinutes?: number | null;
}

export interface WelfareWindowInput {
  /** Scheduled shift start — the grid anchor. */
  readonly shiftStart: Date;
  /** Scheduled shift end — no window extends past it. */
  readonly shiftEnd: Date;
  readonly interval: WelfareIntervalSource;
  readonly completions: readonly OperationalCompletion[];
  readonly applicability: OperationalApplicability;
  readonly now: Date;
}

/**
 * Welfare Check business rules on top of the shared window maths.
 *
 * Pure: it resolves an interval, filters completions to its own kind and delegates the arithmetic.
 * It persists nothing. W2 gives the sweep the job of writing a per-window missed record; this
 * service only ever says what the state is.
 */
@Injectable()
export class WelfareWindowService {
  constructor(private readonly windows: OperationalWindowService) {}

  /**
   * THE authoritative Welfare interval rule:
   *
   *   site.welfareCheckIntervalMinutes ?? shift.checkCallIntervalMinutes ?? 60, floored at 5.
   *
   * This reproduces the long-standing arithmetic in the missed-welfare sweep exactly, including
   * the `Number(x) || 60` fallback that turns 0, NaN and unparseable values into the default. It
   * exists so the sweep, the live projection and the reports stop disagreeing: the reporting paths
   * currently read `shift.checkCallIntervalMinutes` alone and so ignore both the site setting and
   * the floor. W2 repoints them here.
   */
  resolveIntervalMinutes(source: WelfareIntervalSource): number {
    const candidate =
      source.siteWelfareCheckIntervalMinutes ??
      source.shiftCheckCallIntervalMinutes ??
      WELFARE_DEFAULT_INTERVAL_MINUTES;
    const numeric = Number(candidate) || WELFARE_DEFAULT_INTERVAL_MINUTES;
    return Math.max(WELFARE_MINIMUM_INTERVAL_MINUTES, numeric);
  }

  /** Whether a persisted daily-log type counts as a Welfare Check. */
  isWelfareCompletionLogType(logType: DailyLogType): boolean {
    return WELFARE_COMPLETION_LOG_TYPES.includes(logType);
  }

  resolve(input: WelfareWindowInput): OperationalWindowResolution {
    return this.windows.resolve({
      grid: {
        anchor: input.shiftStart,
        intervalMinutes: this.resolveIntervalMinutes(input.interval),
        notAfter: input.shiftEnd,
      },
      applicability: input.applicability,
      // Only Welfare completions. A Log Book entry is not a welfare confirmation, however
      // diligently written, and this filter is what makes that structurally true.
      completions: input.completions
        .filter((completion) => completion.kind === OperationalCompletionKind.WELFARE_CHECK)
        .map((completion) => completion.at),
      now: input.now,
      graceMinutes: WELFARE_GRACE_MINUTES,
    });
  }
}
