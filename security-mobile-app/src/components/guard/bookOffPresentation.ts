// Guard release (20 Oct 2026): every Book Off is confirmed, and an early one says how early.
// Pure — no React / React Native imports — so the exact rule the Guard screen applies is testable.
//
// WHY
// End Shift booked the Guard off on a single tap, however early. On the Android emulator one tap ended a shift
// five hours before its scheduled end, and a Guard cannot undo a Book Off. Owner decision: confirm every Book
// Off, and when it is more than 15 minutes before the scheduled end, show the scheduled end, how early it is
// and a clear warning.
//
// WHAT THIS IS NOT
// A restriction. The backend's early Book Off rules are unchanged and remain the authority: confirming leads
// to exactly the same check-out call, at the moment of confirmation, and nothing here can prevent a Book Off
// the server would accept.

import { formatEarlyDuration } from './bookOnPresentation';

/** More than this many minutes before the scheduled end is an early Book Off and is warned about. */
export const EARLY_BOOK_OFF_WARNING_MINUTES = 15;

export type BookOffDecision = {
  /** Whole minutes before the scheduled end, or 0 when the end has passed. */
  minutesEarly: number;
  early: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
};

/**
 * The confirmation shown before a Book Off. Always a question: Book Off cannot be undone by the Guard.
 *
 * The early boundary is on exact milliseconds: strictly MORE than 15 minutes before the scheduled end is early;
 * 15 minutes or less, or after the end, is a normal Book Off.
 */
export function bookOffDecision(input: {
  /** Scheduled shift end. */
  endMs: number;
  /** Now, from the caller's clock. */
  nowMs: number;
  /** Formats the scheduled end for display in site time, e.g. "19:20". */
  formatEnd: (endMs: number) => string;
}): BookOffDecision {
  const msBeforeEnd = input.endMs - input.nowMs;
  const minutesEarly = Math.max(0, Math.round(msBeforeEnd / 60000));
  const end = input.formatEnd(input.endMs);

  if (msBeforeEnd > EARLY_BOOK_OFF_WARNING_MINUTES * 60000) {
    return {
      minutesEarly,
      early: true,
      title: 'Book Off early?',
      message:
        `Your scheduled end is ${end}.\n` +
        `You are booking off ${formatEarlyDuration(minutesEarly)} early.\n\n` +
        'Control will see an early Book Off. Only book off early if control has agreed. You cannot undo a Book Off.',
      confirmLabel: 'Book Off early',
      cancelLabel: 'Stay on shift',
    };
  }

  return {
    minutesEarly,
    early: false,
    title: 'Book Off now?',
    message:
      `${msBeforeEnd > 0 ? 'Your scheduled end is' : 'Your scheduled end was'} ${end}.\n\n` +
      'Book Off ends your shift and records your departure time. You cannot undo a Book Off.',
    confirmLabel: 'Book Off',
    cancelLabel: 'Stay on shift',
  };
}
