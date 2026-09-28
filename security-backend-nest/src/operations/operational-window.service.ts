import { Injectable } from '@nestjs/common';
import {
  OperationalApplicability,
  OperationalWindow,
  OperationalWindowGrid,
  OperationalWindowResolution,
  OperationalWindowState,
  OperationalWindowSummary,
  ResolveOperationalWindowsInput,
  ResolvedOperationalWindow,
} from './operational-window.types';

export const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * A malformed shift (an end date years in the future) would otherwise ask for millions of
 * windows inside the welfare sweep. 2000 windows is ~7 days at the 5-minute minimum interval,
 * far beyond any real shift, so hitting this cap means the shift data is wrong.
 */
export const MAX_WINDOWS_PER_SHIFT = 2000;

/**
 * Deterministic window arithmetic for periodic operational obligations.
 *
 * Pure by design: no repositories, no database, no clock of its own, no knowledge of Welfare
 * Checks or Log Books. Every input is passed in and every method is a function of its arguments,
 * which is what lets Welfare and Log Book share the maths without being able to influence each
 * other. The domain rules live in the thin wrappers above this service.
 *
 * See the TIME INVARIANT note in ./operational-window.types.ts.
 */
@Injectable()
export class OperationalWindowService {
  /**
   * The whole windows of `grid`, in order from the anchor.
   *
   * A partial tail window carries no obligation, so an 18:00–06:30 shift on a 60-minute interval
   * yields 12 windows and not 13 — the final 30 minutes is not a period anyone can be asked to
   * complete.
   */
  windowsFor(grid: OperationalWindowGrid): OperationalWindow[] {
    const intervalMinutes = this.normaliseIntervalMinutes(grid.intervalMinutes);
    if (intervalMinutes === null) return [];

    const anchor = this.timeOf(grid.anchor);
    const limit = this.timeOf(grid.notAfter);
    if (anchor === null || limit === null || limit <= anchor) return [];

    const step = intervalMinutes * MILLISECONDS_PER_MINUTE;
    const count = Math.min(Math.floor((limit - anchor) / step), MAX_WINDOWS_PER_SHIFT);

    const windows: OperationalWindow[] = [];
    for (let index = 0; index < count; index += 1) {
      const start = anchor + index * step;
      windows.push({ index, start: new Date(start), end: new Date(start + step) });
    }
    return windows;
  }

  /**
   * Whether a window carried an obligation.
   *
   * Overlap, not containment: the window the Guard booked on during still counts. An 18:00 shift
   * with Book On at 20:15 leaves 18:00–19:00 and 19:00–20:00 not applicable, and 20:00–21:00
   * applicable, because the Guard was on duty for part of it.
   */
  isApplicable(window: OperationalWindow, applicability: OperationalApplicability): boolean {
    if (applicability.cancelled) return false;

    // No Book On means the Guard was never on duty, so nothing was ever required. The absence is
    // an attendance exception in its own right, not a run of missed checks.
    const bookOn = this.timeOf(applicability.bookOnAt);
    if (bookOn === null) return false;

    const shiftEnd = this.timeOf(applicability.shiftEnd);
    if (shiftEnd === null) return false;

    // A late Book Off never extends the obligation past the scheduled end; an early one truncates it.
    const bookOff = this.timeOf(applicability.bookOffAt);
    const effectiveEnd = bookOff === null ? shiftEnd : Math.min(bookOff, shiftEnd);

    return window.end.getTime() > bookOn && window.start.getTime() < effectiveEnd;
  }

  applicableWindows(
    windows: readonly OperationalWindow[],
    applicability: OperationalApplicability,
  ): OperationalWindow[] {
    return windows.filter((window) => this.isApplicable(window, applicability));
  }

  /** The window containing `at`, honouring the half-open `[start, end)` boundary. */
  windowContaining(windows: readonly OperationalWindow[], at: Date): OperationalWindow | null {
    const instant = this.timeOf(at);
    if (instant === null) return null;
    return (
      windows.find((window) => instant >= window.start.getTime() && instant < window.end.getTime()) ?? null
    );
  }

  /**
   * Resolve every window of the grid against the completions that qualified for it.
   *
   * Each window resolves independently: three consecutive unmet windows are three MISSED windows,
   * not one rolling overdue state. A completion satisfies only the window that contains it — it
   * never carries forward into the next window or back into the previous one.
   *
   * Applicability wins over completion. A completion inside a window the Guard was not on duty for
   * is still counted in `completionCount`, so the Operations Log can show the entry, but the
   * window stays NOT_APPLICABLE because no obligation existed to discharge.
   */
  resolve(input: ResolveOperationalWindowsInput): OperationalWindowResolution {
    const intervalMinutes = this.normaliseIntervalMinutes(input.grid.intervalMinutes);
    const windows = this.windowsFor(input.grid);

    const graceMs = Math.max(0, Number(input.graceMinutes) || 0) * MILLISECONDS_PER_MINUTE;
    const now = this.timeOf(input.now);
    const completions = input.completions
      .map((completion) => this.timeOf(completion))
      .filter((instant): instant is number => instant !== null)
      .sort((left, right) => left - right);

    const resolved = windows.map<ResolvedOperationalWindow>((window) => {
      const start = window.start.getTime();
      const end = window.end.getTime();
      const inside = completions.filter((instant) => instant >= start && instant < end);
      const applicable = this.isApplicable(window, input.applicability);

      return {
        ...window,
        applicable,
        state: this.stateOf({ applicable, completed: inside.length > 0, end, graceMs, now }),
        dueAt: window.end,
        missedFrom: new Date(end + graceMs),
        completedAt: inside.length > 0 ? new Date(inside[0]) : null,
        completionCount: inside.length,
      };
    });

    return { intervalMinutes, windows: resolved, summary: this.summarise(intervalMinutes, resolved) };
  }

  /**
   * How many windows in a row, counting back from the most recent settled one, were missed.
   *
   * This is what a control room needs: not how many windows a shift missed in total, but how long
   * the obligation has been unmet right now. Windows that carried no obligation are skipped, and a
   * window still inside its grace period is passed over rather than counted, so the run only ever
   * reflects settled outcomes. A completed window ends the run.
   */
  trailingMissedRun(windows: readonly ResolvedOperationalWindow[]): number {
    let run = 0;
    for (let index = windows.length - 1; index >= 0; index -= 1) {
      const window = windows[index];
      if (!window.applicable) continue;
      if (
        window.state === OperationalWindowState.DUE ||
        window.state === OperationalWindowState.OVERDUE
      ) {
        continue;
      }
      if (window.state === OperationalWindowState.MISSED) {
        run += 1;
        continue;
      }
      break;
    }
    return run;
  }

  summarise(
    intervalMinutes: number | null,
    windows: readonly ResolvedOperationalWindow[],
  ): OperationalWindowSummary {
    const countOf = (state: OperationalWindowState) =>
      windows.filter((window) => window.state === state).length;

    const requiredCount = windows.filter((window) => window.applicable).length;
    const completedCount = countOf(OperationalWindowState.COMPLETED);

    return {
      intervalMinutes,
      requiredCount,
      completedCount,
      dueCount: countOf(OperationalWindowState.DUE),
      overdueCount: countOf(OperationalWindowState.OVERDUE),
      missedCount: countOf(OperationalWindowState.MISSED),
      notApplicableCount: countOf(OperationalWindowState.NOT_APPLICABLE),
      compliancePercent:
        requiredCount > 0 ? Math.round((completedCount / requiredCount) * 10000) / 100 : null,
    };
  }

  /**
   * `null` for "no periodic obligation". Anything that is not a usable positive number of minutes
   * is treated as no obligation rather than guessed at, so bad configuration cannot invent
   * missed periods. Whole minutes only, to keep window boundaries on clean instants.
   */
  private normaliseIntervalMinutes(value: number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return Math.floor(numeric);
  }

  private stateOf(input: {
    applicable: boolean;
    completed: boolean;
    end: number;
    graceMs: number;
    now: number | null;
  }): OperationalWindowState {
    if (!input.applicable) return OperationalWindowState.NOT_APPLICABLE;
    if (input.completed) return OperationalWindowState.COMPLETED;
    // Without a usable clock nothing can be declared late; DUE is the only honest answer.
    if (input.now === null || input.now < input.end) return OperationalWindowState.DUE;
    if (input.now < input.end + input.graceMs) return OperationalWindowState.OVERDUE;
    return OperationalWindowState.MISSED;
  }

  private timeOf(value: Date | null | undefined): number | null {
    if (!(value instanceof Date)) return null;
    const instant = value.getTime();
    return Number.isNaN(instant) ? null : instant;
  }
}
