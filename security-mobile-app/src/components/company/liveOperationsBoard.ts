// Which shifts the Live Operations board shows for the selected date, and which wait for reconciliation.
// (S4 Live Operations Phase 2.)
//
// THE DEFECTS THIS REPLACES
// The date control filtered the CURRENT live set: a shift had to be operationally current right now before
// the date was even looked at, so picking Tuesday showed only those of today's live shifts that happened to
// start on Tuesday — usually none. And "Today" cleared the date rather than selecting today, which was
// already the default, so pressing it did nothing.
//
// THE RULES
//   no date (the default)   the live view: what the policy says is current now
//   the site's today        the live view, plus every shift scheduled to start today
//   any other day           the shifts scheduled to start on that day, whatever their state now
//
// A shift belongs to the day it STARTS on, on its own site's clock — the same rule the Rota Planner uses
// to place it — so an overnight shift is Tuesday's in both places, and a 00:30 BST start is never pulled
// onto the previous UTC day. In the live and today views an overnight shift from yesterday that is being
// worked now is still on the board, because the policy, not the date, puts it there.
//
// Needs Reconciliation is independent of the date: a shift worked and never booked off more than 24 hours
// ago is always listed, so it can never be hidden by which day happens to be selected.
//
// Pure: no clock of its own, no request, no write. Choosing a date never changes what is stored.

import { classifyLiveOperation, type BoardInclusion, type OperationalShift } from './liveOperationsPolicy';
import { formatSiteDateInput, isSiteDateInput, siteToday } from '../../services/siteTime';

export type BoardDateMode = 'live' | 'today' | 'day';

export type BoardSource = {
  shift: OperationalShift;
  /** Whether a successful Book On exists. */
  bookedOn: boolean;
  /** The shift's own site zone. */
  timeZone: string;
};

export type LiveBoardSelection<T> = {
  mode: BoardDateMode;
  /** The selected day, '' in the live view. */
  date: string;
  board: Array<{ row: T; inclusion: BoardInclusion }>;
  /** Oldest scheduled end first: the longest-unresolved is the first to deal with. */
  reconciliation: T[];
};

/** A usable selected day, or '' (the live view) for an empty or unusable value. */
export function effectiveBoardDate(date: string | null | undefined): string {
  const value = (date || '').trim();
  return isSiteDateInput(value) ? value : '';
}

/** What the selected date means, judged on the reference site's clock. */
export function boardDateMode(date: string | null | undefined, referenceZone: string, now: Date): BoardDateMode {
  const day = effectiveBoardDate(date);
  if (!day) return 'live';
  return day === siteToday(referenceZone, now) ? 'today' : 'day';
}

export function selectLiveBoard<T>(
  rows: readonly T[],
  read: (row: T) => BoardSource,
  options: { now: Date; date: string | null | undefined; referenceZone: string },
): LiveBoardSelection<T> {
  const date = effectiveBoardDate(options.date);
  const mode = boardDateMode(date, options.referenceZone, options.now);

  const board: Array<{ row: T; inclusion: BoardInclusion }> = [];
  const reconciliation: Array<{ row: T; endMs: number }> = [];

  for (const row of rows) {
    const { shift, bookedOn, timeZone } = read(row);
    const decision = classifyLiveOperation(shift, { now: options.now, bookedOn });

    if (decision.reason === 'needs_reconciliation') {
      reconciliation.push({ row, endMs: Date.parse(shift.end) });
    }

    const onSelectedDay = mode !== 'live' && formatSiteDateInput(shift.start, timeZone) === date;

    if (mode === 'day') {
      if (!onSelectedDay) continue;
      board.push({ row, inclusion: decision.include ? decision.reason : scheduledInclusion(decision.reason) });
      continue;
    }

    if (decision.include) {
      board.push({ row, inclusion: decision.reason });
    } else if (onSelectedDay) {
      board.push({ row, inclusion: scheduledInclusion(decision.reason) });
    }
  }

  reconciliation.sort((a, b) => a.endMs - b.endMs);
  return { mode, date, board, reconciliation: reconciliation.map((entry) => entry.row) };
}

function scheduledInclusion(reason: string): BoardInclusion {
  return reason === 'needs_reconciliation' ? 'needs_reconciliation' : 'scheduled_on_day';
}

/** Whole hours since a shift's scheduled end, for the Needs Reconciliation queue. Never negative. */
export function hoursPastEnd(end: string, nowMs: number): number {
  const endMs = Date.parse(end);
  if (!Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.floor((nowMs - endMs) / 3_600_000));
}
