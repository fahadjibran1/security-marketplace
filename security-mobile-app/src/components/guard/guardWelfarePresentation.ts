// How the Guard's own Welfare Check and Log Book state read on the active shift. (Phase 3D.)
//
// PRESENTATION ONLY. Every value here comes from the backend's operational window engine, via the
// projection now carried on GET /shifts/my. Nothing in this file resolves an interval, builds a window,
// applies a grace period or decides whether a check is owed — the engine did all of that, and the company
// board reads the identical numbers. That is the whole point of Phase 3D: the Guard and their control
// room had different arithmetic, and the Guard had the weaker version.
//
// The status word is the engine's own, mapped to a label rather than recomputed. If the engine says
// `overdue`, this says OVERDUE. It never looks at a clock.

import type { GuardShiftOperations } from '../../types/models';
import { formatInstantTime } from '../../services/siteTime';

export type WelfareTone = 'neutral' | 'good' | 'warning' | 'danger';

export type GuardWelfareCard = {
  /** The status word a Guard reads: DUE, COMPLETED, OVERDUE, MISSED, and the edge cases. */
  label: string;
  tone: WelfareTone;
  /** The next due time on the SITE's clock, or null when nothing is owed. */
  nextDue: string | null;
  /** One supporting line, or null. */
  detail: string | null;
  /** Shown only when there is a standing lapse worth chasing. */
  missedSummary: string | null;
  /** Whether the Welfare Check action should be presented as the priority. */
  actionUrgent: boolean;
};

/**
 * Labels for the engine's statuses, in the Guard's vocabulary.
 *
 * `current` means the window that is open right now has been satisfied — from the Guard's side that is
 * COMPLETED, which is the word the instruction asks for. `not_applicable` and `no_book_on` are the
 * engine's edge cases and must not be dressed up as either a lapse or a completion.
 */
const WELFARE_LABELS: Record<GuardShiftOperations['welfare']['status'], string> = {
  not_applicable: 'NOT REQUIRED',
  no_book_on: 'NOT BOOKED ON',
  current: 'COMPLETED',
  due: 'DUE',
  overdue: 'OVERDUE',
  missed: 'MISSED',
  shift_complete: 'SHIFT COMPLETE',
};

const WELFARE_TONES: Record<GuardShiftOperations['welfare']['status'], WelfareTone> = {
  not_applicable: 'neutral',
  no_book_on: 'warning',
  current: 'good',
  due: 'neutral',
  overdue: 'warning',
  missed: 'danger',
  shift_complete: 'neutral',
};

/** The statuses where recording a Welfare Check is the Guard's priority. */
const URGENT_STATUSES: ReadonlyArray<GuardShiftOperations['welfare']['status']> = ['overdue', 'missed'];

/**
 * The Welfare Check card for the active shift, or null when there is nothing to show.
 *
 * Null when the projection is absent (a shift outside the operational window) or when the shift carries
 * no Welfare obligation at all — showing "0 of 0 completed" would invent an obligation that does not
 * exist.
 */
export function guardWelfareCard(
  operations: GuardShiftOperations | null | undefined,
): GuardWelfareCard | null {
  if (!operations) return null;
  const welfare = operations.welfare;
  if (!welfare.enabled) return null;

  const zone = operations.timezone;
  const nextDue = welfare.nextDueAt ? formatInstantTime(welfare.nextDueAt, zone) : null;

  let detail: string | null = null;
  if (welfare.status === 'overdue' && welfare.overdueByMinutes !== null) {
    detail = `${welfare.overdueByMinutes} min over`;
  } else if (welfare.status === 'current' && welfare.lastWelfareAt) {
    detail = `Last ${formatInstantTime(welfare.lastWelfareAt, zone)}`;
  } else if (welfare.status === 'no_book_on') {
    detail = 'Book On to start your checks';
  } else if (welfare.intervalMinutes) {
    detail = `Every ${welfare.intervalMinutes} min`;
  }

  // Consecutive misses are what a Guard has to act on; the shift total is context.
  let missedSummary: string | null = null;
  if (welfare.consecutiveMissed > 0) {
    missedSummary = `${welfare.consecutiveMissed} missed in a row`;
  } else if (welfare.missedCount > 0) {
    missedSummary = `${welfare.missedCount} missed this shift`;
  }

  return {
    label: WELFARE_LABELS[welfare.status] ?? '—',
    tone: WELFARE_TONES[welfare.status] ?? 'neutral',
    nextDue,
    detail,
    missedSummary,
    actionUrgent: URGENT_STATUSES.includes(welfare.status),
  };
}

export type GuardLogBookCard = {
  label: string;
  tone: WelfareTone;
  detail: string | null;
};

/**
 * The Log Book card, from the same projection.
 *
 * A NULL interval means "as required": entries are welcome and nothing is ever missing, so this says so
 * rather than implying an obligation.
 */
export function guardLogBookCard(
  operations: GuardShiftOperations | null | undefined,
): GuardLogBookCard | null {
  if (!operations) return null;
  const logBook = operations.logBook;

  if (!logBook.required) {
    return { label: 'AS REQUIRED', tone: 'neutral', detail: null };
  }

  const zone = operations.timezone;
  const window = logBook.currentWindow;
  const until = window ? formatInstantTime(window.end, zone) : null;

  if (logBook.currentWindowSubmitted) {
    return {
      label: 'UP TO DATE',
      tone: 'good',
      detail: logBook.lastEntryAt ? `Last ${formatInstantTime(logBook.lastEntryAt, zone)}` : null,
    };
  }

  return {
    label: 'ENTRY DUE',
    tone: 'neutral',
    detail: until ? `By ${until}` : null,
  };
}

/**
 * The shift-status phase for Welfare, taken from the engine rather than derived from a clock.
 *
 * Replaces the old rolling `getNextWelfareDueMs`, which anchored on the last log to arrive and used the
 * shift's interval alone — a different answer from the engine's fixed grid, its grace period and its
 * resolved interval. Returns null when Welfare says nothing about the phase, so the caller keeps whatever
 * phase it had.
 */
export function guardWelfarePhase(
  operations: GuardShiftOperations | null | undefined,
): 'welfare_due' | 'welfare_overdue' | null {
  if (!operations || !operations.welfare.enabled) return null;
  const status = operations.welfare.status;
  if (status === 'overdue' || status === 'missed') return 'welfare_overdue';
  if (status === 'due') return 'welfare_due';
  return null;
}
