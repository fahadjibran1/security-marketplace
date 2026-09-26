import { Injectable } from '@nestjs/common';
import { OperationalWindowService } from './operational-window.service';
import {
  OperationalApplicability,
  OperationalCompletion,
  OperationalCompletionKind,
  OperationalWindowResolution,
} from './operational-window.types';

/** Grace before an unmet Log Book window counts as missing. Product-locked at 5 minutes. */
export const LOG_BOOK_GRACE_MINUTES = 5;

export interface LogBookWindowInput {
  /** Scheduled shift start — the grid anchor, exactly as for Welfare. */
  readonly shiftStart: Date;
  /** Scheduled shift end — no window extends past it. */
  readonly shiftEnd: Date;
  /**
   * The future `sites.logBookIntervalMinutes`, passed in because the column does not exist until
   * Migration 59.
   *
   * `null` means "As required": voluntary entries are still welcome and still recorded, but no
   * period carries an obligation and nothing can ever be missing. That is why the column will be
   * nullable — a NOT NULL DEFAULT 60 would impose an hourly written-log duty on every existing
   * site the moment the migration ran.
   */
  readonly intervalMinutes: number | null;
  readonly completions: readonly OperationalCompletion[];
  readonly applicability: OperationalApplicability;
  readonly now: Date;
}

/**
 * Log Book business rules on top of the shared window maths.
 *
 * A separate feature that happens to share arithmetic with Welfare, not a variant of it. The
 * interval comes from its own setting, the completions come from its own kind, and a missing
 * period is an operational exception rather than a safety alert — so unlike Welfare, W2 will
 * derive missing periods on read and persist nothing.
 */
@Injectable()
export class LogBookWindowService {
  constructor(private readonly windows: OperationalWindowService) {}

  resolve(input: LogBookWindowInput): OperationalWindowResolution {
    return this.windows.resolve({
      grid: {
        anchor: input.shiftStart,
        intervalMinutes: input.intervalMinutes,
        notAfter: input.shiftEnd,
      },
      applicability: input.applicability,
      // Only Log Book completions. A Welfare Check is one tap and proves presence; it is not the
      // written narrative this obligation asks for, and this filter is what keeps that true.
      completions: input.completions
        .filter((completion) => completion.kind === OperationalCompletionKind.LOG_BOOK)
        .map((completion) => completion.at),
      now: input.now,
      graceMinutes: LOG_BOOK_GRACE_MINUTES,
    });
  }
}
