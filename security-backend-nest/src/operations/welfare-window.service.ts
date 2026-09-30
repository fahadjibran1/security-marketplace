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
   *   shift.checkCallIntervalMinutes ?? site.welfareCheckIntervalMinutes ?? 60, floored at 5.
   *
   * THE ORDER MATTERS AND IT USED TO BE THE WRONG WAY ROUND.
   * It read the SITE first, and because `sites.welfareCheckIntervalMinutes` is NOT NULL with a default,
   * the site value always existed — so the per-shift value could never win and was effectively dead.
   * Real UAT proved it: shift 16 and its rota slot both stored the 15 minutes the operator entered, the
   * site carried the 60-minute default, and the platform generated ONE 60-minute window instead of four
   * 15-minute ones. Missed checks then read zero, correctly for 60 and wrongly for what was asked.
   *
   * A value entered against a specific shift or rota slot is a deliberate instruction about that shift;
   * the site value is the default for shifts that say nothing. So the specific beats the general, and
   * the system default applies only when neither is set.
   *
   * The `Number(x) || 60` coercion and the five-minute floor are unchanged: 0, NaN and unparseable
   * values still fall back to the default, and a misconfigured one-minute interval still cannot generate
   * an alert storm against a Guard who is doing nothing wrong.
   */
  resolveIntervalMinutes(source: WelfareIntervalSource): number {
    const candidate =
      source.shiftCheckCallIntervalMinutes ??
      source.siteWelfareCheckIntervalMinutes ??
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
