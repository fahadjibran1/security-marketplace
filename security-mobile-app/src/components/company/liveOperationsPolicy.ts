// What belongs on the Live Operations board right now. (Phase 3B.)
//
// WHY THIS MODULE EXISTS
// Live Operations is the company's control room, answering three questions: what is happening now, what
// is about to happen, and what needs attention now. It had no inclusion policy at all. The board was
// `shifts` passed through the user's own client/site/guard/date/status filters, so every shift the
// company had ever created appeared on it — Monday's uncovered shift, Tuesday's completed ones, a shift
// three weeks out — and the one shift actually being worked sat somewhere in that list. Historical
// records belong in Rota Planner and Coverage, which is where they still are; none of them are deleted,
// rewritten or hidden from those surfaces by anything here.
//
// TRUE INSTANTS ONLY
// Every decision below compares INSTANTS: `Date.parse` of the stored value against `now`. There is no
// calendar-day concept in the inclusion policy, so there is nothing here for a timezone to get wrong —
// no ISO string slicing, no literal UTC digits, no device-timezone assumption. Live Operations does have
// one calendar-day concept, the user's date filter, and Phase 3A-i already resolves that through the
// site's zone. This module is deliberately the boring half.
//
// EXPIRY WITHOUT A NEW RECORD
// A derived attention item — "Re-cover required", a coverage gap — has nothing to acknowledge, because
// nothing was ever written down. Rather than invent a table to store an acknowledgement in, such an item
// simply stops being current: it is computed from the shift's own schedule, so it ages out on its own.
// Persisted safety alerts are the opposite case. They have a real open/acknowledged/closed lifecycle
// which stays exactly as it is, and NOTHING here expires one.

/** The schedule and lifecycle this policy reads. Deliberately the smallest shape that decides. */
export type OperationalShift = {
  id: number;
  /** Scheduled start, a true instant. */
  start: string;
  /** Scheduled end, a true instant. */
  end: string;
  status: string;
};

/**
 * How far ahead the control room looks. Locked: NOW → +4 HOURS.
 *
 * Also how early a coverage gap becomes the control room's problem rather than the planner's.
 */
export const UPCOMING_HORIZON_MINUTES = 4 * 60;

/**
 * How long work stays operationally current after its scheduled end.
 *
 * Locked at 24 hours. Nothing in the existing operational semantics argued for shorter: the only
 * post-end constant in the system is the 15-minute Book Off grace, which decides when to RAISE a missing
 * Book Off, not how long Control needs to keep seeing it.
 */
export const POST_END_ATTENTION_MINUTES = 24 * 60;

/**
 * How long finished work stays on the board after its scheduled end.
 *
 * Shorter than the attention window on purpose. A shift that completed twenty minutes ago may still need
 * closing out and reads as current; one that completed yesterday is history. An unresolved exception on
 * it does NOT disappear at this boundary — a missing Book Off is a persisted alert and stays in Attention
 * Now on its own lifecycle.
 */
export const SETTLED_CLOSE_OUT_MINUTES = 2 * 60;

const MINUTE_MS = 60_000;

export type InclusionReason =
  /** Being worked now: status says so, or a Book On exists and the shift has started. */
  | 'in_progress'
  /** Actionable and starting inside the horizon. */
  | 'upcoming'
  /** Scheduled start has passed, still actionable, and no successful Book On exists. */
  | 'late_not_booked_on'
  /** Unfilled, rejected or missed while the work still matters. */
  | 'current_coverage_gap'
  /** Finished, inside the close-out tail. */
  | 'closing_out';

export type ExclusionReason =
  /** Starts further ahead than the control room looks. Planning, not operations. */
  | 'beyond_horizon'
  /** Completed or cancelled, past the close-out tail. */
  | 'settled_historical'
  /** Past the post-end attention window. */
  | 'outside_relevance'
  /** No usable schedule to decide with. */
  | 'unknown_schedule';

export type LiveOperationDecision =
  | { include: true; reason: InclusionReason }
  | { include: false; reason: ExclusionReason };

export type ShiftOperationalContext = {
  now: Date;
  /** Whether a successful Book On exists. Attendance evidence, not the status column. */
  bookedOn: boolean;
};

function lifecycle(status: string | null | undefined): string {
  return (status || '').trim().toLowerCase();
}

/**
 * Whether the board should be showing this shift, and why.
 *
 * The reason is not decoration: the board's counts and its metric filters both read it, so a count can
 * no longer disagree with the rows underneath it.
 */
export function classifyLiveOperation(
  shift: OperationalShift,
  ctx: ShiftOperationalContext,
): LiveOperationDecision {
  const start = Date.parse(shift.start);
  const end = Date.parse(shift.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { include: false, reason: 'unknown_schedule' };
  }

  const nowMs = ctx.now.getTime();
  const status = lifecycle(shift.status);
  const minutesSinceEnd = (nowMs - end) / MINUTE_MS;
  const minutesUntilStart = (start - nowMs) / MINUTE_MS;

  // A — genuinely in progress. Every one of them, with no time bound: a shift someone is standing on is
  // the control room's first responsibility whatever the clock says, and an in_progress shift whose end
  // passed long ago is itself the exception Control needs to see.
  if (status === 'in_progress') {
    return { include: true, reason: 'in_progress' };
  }

  // Finished work, inside its close-out tail. The tail has a lower bound too, so a shift cancelled for
  // next week does not qualify merely by having no end behind it yet.
  if (status === 'completed' || status === 'cancelled') {
    const withinTail =
      minutesSinceEnd <= SETTLED_CLOSE_OUT_MINUTES && minutesUntilStart <= UPCOMING_HORIZON_MINUTES;
    return withinTail
      ? { include: true, reason: 'closing_out' }
      : { include: false, reason: 'settled_historical' };
  }

  // B and C — assigned or offered, awaiting the guard.
  if (status === 'ready' || status === 'offered' || status === 'assigned' || status === 'accepted') {
    if (nowMs < start) {
      return minutesUntilStart <= UPCOMING_HORIZON_MINUTES
        ? { include: true, reason: 'upcoming' }
        : { include: false, reason: 'beyond_horizon' };
    }
    if (minutesSinceEnd > POST_END_ATTENTION_MINUTES) {
      return { include: false, reason: 'outside_relevance' };
    }
    // The start has passed. Attendance decides what this is: a Book On means the work is being done
    // whatever the status column still says, and its absence is the exception Control chases.
    return ctx.bookedOn
      ? { include: true, reason: 'in_progress' }
      : { include: true, reason: 'late_not_booked_on' };
  }

  // D — coverage problems, and anything whose status this policy does not recognise. An unrecognised
  // status stays VISIBLE while the work is current: hiding operational work is the dangerous direction
  // for a control room, so the fallback errs towards showing it and lets it age out like everything else.
  if (minutesUntilStart > UPCOMING_HORIZON_MINUTES) {
    return { include: false, reason: 'beyond_horizon' };
  }
  if (minutesSinceEnd > POST_END_ATTENTION_MINUTES) {
    return { include: false, reason: 'outside_relevance' };
  }
  return { include: true, reason: 'current_coverage_gap' };
}

/** Convenience over {@link classifyLiveOperation} for callers that only need the yes/no. */
export function isCurrentOperation(shift: OperationalShift, ctx: ShiftOperationalContext): boolean {
  return classifyLiveOperation(shift, ctx).include;
}

/**
 * The board's rows, in the order given, with each row's reason attached.
 *
 * Generic over the row so the screen can keep enriching rows however it likes; this only needs to know
 * how to read the schedule and the Book On out of one.
 */
export function selectCurrentOperations<T>(
  rows: readonly T[],
  read: (row: T) => { shift: OperationalShift; bookedOn: boolean },
  now: Date,
): Array<{ row: T; reason: InclusionReason }> {
  const current: Array<{ row: T; reason: InclusionReason }> = [];
  for (const row of rows) {
    const { shift, bookedOn } = read(row);
    const decision = classifyLiveOperation(shift, { now, bookedOn });
    if (decision.include) current.push({ row, reason: decision.reason });
  }
  return current;
}

// ─── Attention Now ────────────────────────────────────────────────────────────

/**
 * Attention categories computed from a shift's own schedule, with nothing persisted behind them.
 *
 * These are the ones that expire. "Re-cover required" was the reported defect: derived from the uncovered
 * list with no time bound and no acknowledgement path, so Monday's uncovered shift was still in
 * Wednesday's queue with no way for anyone to clear it.
 */
export const DERIVED_ATTENTION_CATEGORIES: readonly string[] = [
  'uncovered_shift',
  'missed_shift',
  'rejected_offer',
  'late_start',
  'upcoming_risk',
];

/**
 * Attention categories backed by a safety_alert or incident row.
 *
 * These are NEVER expired here. They carry a real open/acknowledged/closed lifecycle, someone clears them
 * deliberately, and ageing one out of the queue would lose a record of something unresolved.
 */
export const PERSISTED_ATTENTION_CATEGORIES: readonly string[] = [
  'panic',
  'incident',
  'missed_check_call',
  'safety',
  /** Phase 3C: a Guard-raised Site Request. Persisted as safety_alerts.site_request. */
  'site_request',
];

export function isDerivedAttentionCategory(category: string): boolean {
  return DERIVED_ATTENTION_CATEGORIES.includes(category);
}

/**
 * Whether a derived attention item is still current.
 *
 * Same schedule arithmetic as the board, so the queue and the board agree about what "now" covers. A
 * derived item with no shift behind it cannot be expired by schedule, so it is kept: this function only
 * ever removes something it can positively date.
 */
export function isDerivedAttentionCurrent(
  item: { category: string; shiftId?: number | null },
  shift: OperationalShift | null | undefined,
  now: Date,
): boolean {
  if (!isDerivedAttentionCategory(item.category)) return true;
  if (!shift) return true;

  const end = Date.parse(shift.end);
  const start = Date.parse(shift.start);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return true;

  const nowMs = now.getTime();
  if ((start - nowMs) / MINUTE_MS > UPCOMING_HORIZON_MINUTES) return false;
  return (nowMs - end) / MINUTE_MS <= POST_END_ATTENTION_MINUTES;
}

/**
 * Attention Now, with expired derived items removed.
 *
 * `shiftOf` returns the shift an item refers to, or null when there is none to date it by.
 */
export function selectCurrentAttention<T extends { category: string; shiftId?: number | null }>(
  items: readonly T[],
  shiftOf: (item: T) => OperationalShift | null | undefined,
  now: Date,
): T[] {
  return items.filter((item) => isDerivedAttentionCurrent(item, shiftOf(item), now));
}

/**
 * The actionable Welfare alerts only.
 *
 * A missed Welfare Check writes two kinds of row: durable per-window evidence, carrying the window index,
 * and one shift-level summary with a NULL index. Twenty-four missed windows are twenty-four records but a
 * single thing to act on, and the backend's own board projection has always drawn this distinction. The
 * company alert list does not, so the queue and the "Missed Check Calls" count both multiplied by the
 * number of missed windows.
 */
export function isActionableWelfareAlert(alert: { welfareWindowIndex?: number | null }): boolean {
  return alert.welfareWindowIndex == null;
}
