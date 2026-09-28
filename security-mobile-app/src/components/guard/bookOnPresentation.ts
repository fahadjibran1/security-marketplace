// UAT-ATT-01: whether a Book On needs confirming, and how early attendance is described.
// Pure — no React / React Native imports — so the exact rule the Guard screen applies is testable.
//
// LOCKED PRODUCT RULE
// An assigned Guard whose shift is in READY state may Book On early, exactly on time, or late. There is
// NO hard early cutoff and no hard late cutoff on the client. Real security operations routinely put a
// Guard on site hours ahead at a site manager's request, and a late Guard must still be able to record
// attendance — S4 records reality rather than preventing attendance from being recorded.
//
// The ONLY thing this module adds is a confirmation for a substantially early Book On, so a mis-tap
// cannot silently start a shift two hours ahead of schedule. That confirmation is a warning, never a
// restriction: `proceed` and a confirmed `confirm` both lead to exactly the same check-in call.
//
// The server is the authority on whether a Book On is allowed at all (assignment, lifecycle, GPS/NFC
// policy, and the stale-shift boundary). Nothing here duplicates those rules, and nothing here may
// prevent a Book On the server would accept.

/** Above this much early, ask first. AT this value or less, Book On proceeds with no interruption. */
export const EARLY_CONFIRM_THRESHOLD_MINUTES = 30;

export type BookOnDecision =
  /** Call the normal check-in path immediately. */
  | { kind: 'proceed' }
  /** Ask first; on confirm, call the very same check-in path. */
  | {
      kind: 'confirm';
      minutesEarly: number;
      title: string;
      message: string;
      confirmLabel: string;
      cancelLabel: string;
    };

/**
 * Minutes until the scheduled start. Negative once the start has passed, so a late Book On is simply a
 * non-positive value and is never treated specially here.
 */
export function minutesUntilStart(startMs: number, nowMs: number): number {
  return Math.round((startMs - nowMs) / 60000);
}

/** "1 hr 42 min" / "45 min" / "2 hr". Plain English, no zero-padding. */
export function formatEarlyDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

/**
 * Whether this Book On should be confirmed first.
 *
 * The comparison is on exact milliseconds, not rounded minutes, so the threshold is a single clean
 * boundary: strictly MORE than 30 minutes early asks; 30 minutes early or less does not.
 */
export function bookOnDecision(input: {
  /** Scheduled shift start. */
  startMs: number;
  /** Now, from the caller's clock. */
  nowMs: number;
  /** Formats the scheduled start for display, e.g. "18:00". */
  formatStart: (startMs: number) => string;
}): BookOnDecision {
  const msEarly = input.startMs - input.nowMs;
  if (msEarly <= EARLY_CONFIRM_THRESHOLD_MINUTES * 60000) return { kind: 'proceed' };

  const minutesEarly = minutesUntilStart(input.startMs, input.nowMs);
  return {
    kind: 'confirm',
    minutesEarly,
    title: 'Book on early?',
    message:
      `Your scheduled start is ${input.formatStart(input.startMs)}.\n` +
      `You are booking on ${formatEarlyDuration(minutesEarly)} early.\n\n` +
      'Your scheduled shift times do not change.',
    confirmLabel: 'Book On',
    cancelLabel: 'Cancel',
  };
}

/**
 * Status copy for a shift that has not reached its scheduled start. `before_shift` is kept purely for
 * presentation; it must never imply Book On is unavailable.
 */
export function beforeShiftStatusLine(startLabel: string, dateLabel: string): string {
  return `Next shift starts ${startLabel} on ${dateLabel}. Book On is available now if you are on site early.`;
}

/** Coaching copy under the action. States the early-attendance rule without promising a schedule change. */
export const BEFORE_SHIFT_GUIDANCE =
  'You can Book On before your scheduled start if you are on site. Your scheduled shift times stay the same, and welfare checks still follow the scheduled start.';
