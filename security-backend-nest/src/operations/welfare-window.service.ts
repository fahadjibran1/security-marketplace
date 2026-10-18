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

/**
 * How early a Welfare Check may be made and still count for the window about to start, provided the
 * window it was made in is already met. Owner-approved, 18 October 2026: a Guard who checks in at
 * 23:57, having already checked in at 23:05, has not missed 00:00-01:00. See
 * OperationalWindowService.attribute for the exact rule.
 */
export const WELFARE_EARLY_TOLERANCE_MINUTES = 5;

/**
 * Owner decision, Welfare Phase 5: a final window the Guard booked off part-way through owes a check when
 * they worked at least half of it — 30 minutes of an hourly window, half of any other interval. Less, and
 * it is Ended at Book Off. Exactly half is owed.
 */
export const WELFARE_PARTIAL_WINDOW_MINIMUM_FRACTION = 0.5;

/**
 * How much of one window the Guard was on duty for, from the recorded Book On and Book Off only.
 *
 * Release gate: a partial-window miss (Book On late into the window, or Book Off part-way through it after at
 * least half was worked) must read differently from a full missed window. This does not change the grading
 * — the window engine decides MISSED — it only says how much of the window that grading covered.
 * `partial` is false for a window the Guard was on duty for end to end, or when no Book On is recorded.
 */
export function welfareWindowDuty(
  window: { start: Date; end: Date },
  bookOnAt: Date | null,
  bookOffAt: Date | null,
): { partial: boolean; onDutyMinutes: number; windowMinutes: number; bookedOnLate: boolean; bookedOffEarly: boolean } {
  const start = window.start.getTime();
  const end = window.end.getTime();
  const windowMinutes = Math.round((end - start) / 60_000);
  const on = bookOnAt ? bookOnAt.getTime() : null;
  const off = bookOffAt ? bookOffAt.getTime() : null;
  if (on === null) return { partial: false, onDutyMinutes: windowMinutes, windowMinutes, bookedOnLate: false, bookedOffEarly: false };
  // A whole minute or more off duty makes the window partial; a Book On a few seconds after the start does not.
  const bookedOnLate = on - start >= 60_000 && on < end;
  const bookedOffEarly = off !== null && off > start && end - off >= 60_000;
  const from = Math.max(start, on);
  const to = off === null ? end : Math.min(end, off);
  const onDutyMinutes = Math.max(0, Math.floor((to - from) / 60_000));
  return { partial: bookedOnLate || bookedOffEarly, onDutyMinutes, windowMinutes, bookedOnLate, bookedOffEarly };
}

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
      // Only a check made while genuinely Booked On counts, and one made just before a window starts may
      // count for it. Neither moves or rewrites the check's own timestamp.
      attribution: { earlyToleranceMinutes: WELFARE_EARLY_TOLERANCE_MINUTES, onDutyOnly: true },
      // A partly-worked final window owes a check once half of it was worked (see the constant above). The
      // check, Book On and Book Off keep their recorded times; nothing is created for a window.
      partialWindowAtBookOff: { minimumWorkedFraction: WELFARE_PARTIAL_WINDOW_MINIMUM_FRACTION },
    });
  }
}
