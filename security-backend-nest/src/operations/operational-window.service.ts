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
   * not one rolling overdue state. A completion is attributed to exactly one window — the one that
   * contains it, or under an early-check tolerance the next one (see `attribute`) — and satisfies
   * only that window. It never carries back into an earlier window.
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

    const applicable = windows.map((window) => this.isApplicable(window, input.applicability));
    const attributed = this.attribute(windows, applicable, completions, input.applicability, input.attribution);
    const bookOff = this.timeOf(input.applicability.bookOffAt);

    const resolved = windows.map<ResolvedOperationalWindow>((window, index) => {
      const end = window.end.getTime();
      const { all, discharging } = attributed[index];
      // Booked off inside this window: it was only partly worked.
      const cutShort = Boolean(input.holdPartialWindowAtBookOff) && bookOff !== null && bookOff < end;

      return {
        ...window,
        applicable: applicable[index],
        state: this.stateOf({ applicable: applicable[index], completed: discharging.length > 0, cutShort, end, graceMs, now }),
        dueAt: window.end,
        missedFrom: new Date(end + graceMs),
        completedAt: discharging.length > 0 ? new Date(discharging[0]) : null,
        completionCount: all.length,
      };
    });

    return { intervalMinutes, windows: resolved, summary: this.summarise(intervalMinutes, resolved) };
  }

  /**
   * Which window each completion belongs to, and which of them discharge it.
   *
   * Completions are taken in time order, and each decision depends only on earlier completions, so a
   * later entry can never change where an earlier one was attributed — the result is deterministic
   * and stable as a shift goes on.
   *
   * THE EARLY-CHECK TOLERANCE. An entry made in the last `earlyToleranceMinutes` before window N+1
   * starts counts for window N+1 only if window N is ALREADY met by an earlier entry (or N carried no
   * obligation, or the entry falls before the first window). Otherwise it stays in window N. So:
   *   22:05 and 22:57 on an hourly grid   22:05 meets 22:00-23:00, 22:57 meets 23:00-00:00
   *   22:57 alone                          it meets 22:00-23:00; 23:00-00:00 still needs its own
   * The tolerance can therefore never turn a met window into a missed one, and an entry still
   * satisfies only one window. Its real timestamp is kept: nothing is moved or rewritten.
   *
   * With no `attribution`, this is plain half-open containment and every entry discharges.
   */
  private attribute(
    windows: readonly OperationalWindow[],
    applicable: readonly boolean[],
    completions: readonly number[],
    applicability: OperationalApplicability,
    attribution?: ResolveOperationalWindowsInput['attribution'],
  ): { all: number[]; discharging: number[] }[] {
    const result = windows.map(() => ({ all: [] as number[], discharging: [] as number[] }));
    if (!windows.length) return result;

    const toleranceMs =
      Math.max(0, Math.floor(Number(attribution?.earlyToleranceMinutes) || 0)) * MILLISECONDS_PER_MINUTE;
    const bookOn = this.timeOf(applicability.bookOnAt);
    const bookOff = this.timeOf(applicability.bookOffAt);
    const onDuty = (instant: number) =>
      !attribution?.onDutyOnly ||
      (bookOn !== null && instant >= bookOn && (bookOff === null || instant <= bookOff));

    const first = windows[0].start.getTime();
    const last = windows[windows.length - 1].end.getTime();
    // Windows are contiguous and equal, so the containing index is arithmetic, not a search.
    const step = windows[0].end.getTime() - first;

    for (const instant of completions) {
      const containing = instant >= first && instant < last ? Math.floor((instant - first) / step) : -1;
      const counts = onDuty(instant);
      let target = containing;

      if (toleranceMs > 0 && counts) {
        const next = containing === -1 ? (instant < first ? 0 : -1) : containing + 1;
        const nearNext =
          next >= 0 && next < windows.length && instant >= windows[next].start.getTime() - toleranceMs;
        const currentSettled =
          containing === -1 || !applicable[containing] || result[containing].discharging.length > 0;
        if (nearNext && applicable[next] && currentSettled) target = next;
      }

      if (target === -1) continue;
      result[target].all.push(instant);
      if (counts) result[target].discharging.push(instant);
    }
    return result;
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
    return this.trailingMissedWindows(windows).length;
  }

  /** The windows that make up `trailingMissedRun`, most recent first. */
  trailingMissedWindows(windows: readonly ResolvedOperationalWindow[]): ResolvedOperationalWindow[] {
    const run: ResolvedOperationalWindow[] = [];
    for (let index = windows.length - 1; index >= 0; index -= 1) {
      const window = windows[index];
      if (!window.applicable) continue;
      if (
        window.state === OperationalWindowState.DUE ||
        window.state === OperationalWindowState.OVERDUE ||
        window.state === OperationalWindowState.ENDED_AT_BOOK_OFF
      ) {
        continue;
      }
      if (window.state === OperationalWindowState.MISSED) {
        run.push(window);
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
      endedAtBookOffCount: countOf(OperationalWindowState.ENDED_AT_BOOK_OFF),
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
    cutShort: boolean;
    end: number;
    graceMs: number;
    now: number | null;
  }): OperationalWindowState {
    if (!input.applicable) return OperationalWindowState.NOT_APPLICABLE;
    if (input.completed) return OperationalWindowState.COMPLETED;
    if (input.cutShort) return OperationalWindowState.ENDED_AT_BOOK_OFF;
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
