// Early Book Off and the coverage that remained: how Live Operations words them. (S4 Welfare Phase 4.)
//
// Pilot shift 33 booked off at 02:09 against a 07:00 end and the board called it "Completed", the drawer
// "Closed cleanly". The rule is the backend's (operations/early-book-off.ts): a recorded Book Off MORE than
// 15 minutes before the scheduled end. The coverage assessment comes from the backend too, built from other
// Guards' actual attendance and assignments; this module only words it. Nothing here records, closes or
// alerts anything, and no Book Off time is ever shown that was not recorded.
//
// "Uncovered" is about Guards recorded in S4 only: it is never a claim about people S4 does not record.
//
// Pure: no request, no clock of its own.

import type { EarlyBookOffView } from '../../types/models';

/** The same threshold the backend uses: more than this many minutes before the scheduled end. */
export const EARLY_BOOK_OFF_MINUTES = 15;

/** Minutes a recorded Book Off came before the scheduled end, when more than 15; otherwise null. */
export function earlyBookOffMinutes(scheduledEnd: string | null | undefined, bookOffAt: string | null | undefined): number | null {
  if (!scheduledEnd || !bookOffAt) return null;
  const early = Date.parse(scheduledEnd) - Date.parse(bookOffAt);
  if (!Number.isFinite(early) || !(early > EARLY_BOOK_OFF_MINUTES * 60_000)) return null;
  return Math.floor(early / 60_000);
}

/** "4h 50m", "45m", "2h". */
export function formatDuration(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export const COVERAGE_WORD: Record<EarlyBookOffView['coverage']['status'], string> = {
  maintained: 'Coverage maintained',
  partial: 'Partial coverage gap',
  uncovered: 'Uncovered period',
  undetermined: 'Coverage undetermined',
};

/** Tone for the coverage line: an uncovered or partial gap is the thing to notice. */
export const COVERAGE_TONE: Record<EarlyBookOffView['coverage']['status'], 'good' | 'warning' | 'danger' | 'neutral'> = {
  maintained: 'good',
  partial: 'warning',
  uncovered: 'danger',
  undetermined: 'neutral',
};

/**
 * One sentence on what the evidence shows — never more than it shows. A gap still ahead is said to rest on
 * the schedule.
 */
export function coverageSentence(view: EarlyBookOffView): string {
  const c = view.coverage;
  const shifts = c.coveringShiftIds.length ? ` (shift ${c.coveringShiftIds.map((id) => `#${id}`).join(', ')})` : '';
  const schedule = c.reliesOnSchedule ? ' Part of this is from the schedule: that Guard has not booked on yet.' : '';
  switch (c.status) {
    case 'maintained':
      return `Another Guard covered the rest of the shift${shifts}.${schedule}`;
    case 'partial':
      return `Another Guard covered ${formatDuration(c.coveredMinutes)}${shifts}; ${formatDuration(c.uncoveredMinutes)} had no other Guard recorded in S4 on duty.${schedule}`;
    case 'uncovered':
      return `No other Guard recorded in S4 was on duty or scheduled at this site for the remaining ${formatDuration(view.remainingMinutes)}.`;
    default:
      return `It cannot be confirmed: another Guard's shift overlapping this time was closed without a Book Off, so when they left is not recorded.`;
  }
}
