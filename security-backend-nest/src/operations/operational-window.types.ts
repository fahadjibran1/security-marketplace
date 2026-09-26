/**
 * Shared vocabulary for periodic operational obligations.
 *
 * Two product features share this maths and nothing else: WELFARE CHECK (a periodic safety
 * confirmation) and LOG BOOK (a periodic written narrative). They have separate intervals,
 * separate completion kinds and separate consequences for being missed; only the window
 * arithmetic is common.
 *
 * TIME INVARIANT
 * --------------
 * Every value in this file is an *instant*. Window arithmetic is duration arithmetic on epoch
 * milliseconds, so a 60-minute window is 60 real minutes always — including across a DST
 * transition, where the local clock reading of a boundary jumps but the elapsed time does not.
 * Windows are never built by incrementing a local clock hour.
 *
 * `site.timezone` is for display and Operations Log day bucketing only. It must never take part
 * in deciding whether an interval has elapsed.
 */

/**
 * A half-open instant range `[start, end)`.
 *
 * Half-open matters: with a 60-minute interval anchored at 18:00, 18:59:59.999 belongs to
 * window 0 and 19:00:00.000 belongs to window 1. No instant belongs to two windows.
 */
export interface OperationalWindow {
  readonly index: number;
  readonly start: Date;
  readonly end: Date;
}

export enum OperationalWindowState {
  /** At least one qualifying completion landed inside the window. */
  COMPLETED = 'completed',
  /** The window has not yet elapsed. */
  DUE = 'due',
  /** Elapsed and unmet, but still inside the grace period. */
  OVERDUE = 'overdue',
  /** Elapsed and unmet beyond the grace period. */
  MISSED = 'missed',
  /** The Guard was not on duty for this window, so nothing was ever required. */
  NOT_APPLICABLE = 'not_applicable',
}

/**
 * Domain-level classification of something a Guard did that can satisfy an obligation.
 *
 * Deliberately NOT the persisted `daily_logs.logType` enum. `LOG_BOOK` has no persisted
 * counterpart until Migration 59, and the hyphenated values here cannot be mistaken for
 * database enum literals by a future reader.
 */
export enum OperationalCompletionKind {
  WELFARE_CHECK = 'welfare-check',
  LOG_BOOK = 'log-book',
  /** Recorded activity that satisfies no periodic obligation, e.g. a voluntary observation. */
  UNCLASSIFIED = 'unclassified',
}

export interface OperationalCompletion {
  readonly at: Date;
  readonly kind: OperationalCompletionKind;
}

/**
 * The window grid for one shift and one obligation.
 *
 * The grid is anchored to the *scheduled* shift start, never to the actual Book On time, so the
 * expected check times are the same for every Guard on that shift and do not move when someone
 * books on late.
 */
export interface OperationalWindowGrid {
  readonly anchor: Date;
  /** `null` means there is no periodic obligation at all (Log Book "As required"). */
  readonly intervalMinutes: number | null;
  /** Scheduled shift end. No window may extend past it. */
  readonly notAfter: Date;
}

/**
 * What the Guard actually did about attendance, which decides which windows carried an
 * obligation. Requirements apply only while the Guard was genuinely Booked On: a late or absent
 * Book On is an attendance exception, not a retrospective pile of missed checks.
 */
export interface OperationalApplicability {
  /** Actual Book On. `null` (never booked on) means nothing was ever required. */
  readonly bookOnAt: Date | null;
  /** Actual Book Off, if the Guard has booked off. */
  readonly bookOffAt: Date | null;
  /** Scheduled shift end. A late Book Off never extends obligation past this. */
  readonly shiftEnd: Date;
  /** A cancelled shift carries no obligation at all. */
  readonly cancelled?: boolean;
}

export interface ResolvedOperationalWindow extends OperationalWindow {
  readonly state: OperationalWindowState;
  readonly applicable: boolean;
  /** `end` — the moment the obligation falls due. */
  readonly dueAt: Date;
  /** `end + grace` — the moment an unmet obligation becomes MISSED, inclusive. */
  readonly missedFrom: Date;
  /** The first qualifying completion inside the window, if any. */
  readonly completedAt: Date | null;
  /**
   * Every qualifying completion inside the window. More than one is legitimate and each is
   * retained for the Operations Log; the obligation is still satisfied exactly once.
   */
  readonly completionCount: number;
}

export interface OperationalWindowSummary {
  readonly intervalMinutes: number | null;
  /** Applicable windows — what the Guard was actually obliged to do. */
  readonly requiredCount: number;
  readonly completedCount: number;
  readonly dueCount: number;
  readonly overdueCount: number;
  readonly missedCount: number;
  readonly notApplicableCount: number;
  /**
   * `completed / required`, to two decimal places, or `null` when nothing was required.
   *
   * Never reported as 0% for "no obligation". Note that on an in-progress shift `requiredCount`
   * includes windows that have not yet elapsed, so callers showing live state should prefer the
   * raw counts to this percentage.
   */
  readonly compliancePercent: number | null;
}

export interface OperationalWindowResolution {
  readonly intervalMinutes: number | null;
  readonly windows: ResolvedOperationalWindow[];
  readonly summary: OperationalWindowSummary;
}

export interface ResolveOperationalWindowsInput {
  readonly grid: OperationalWindowGrid;
  readonly applicability: OperationalApplicability;
  readonly completions: readonly Date[];
  readonly now: Date;
  readonly graceMinutes: number;
}
