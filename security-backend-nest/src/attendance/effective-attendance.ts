/**
 * Effective attendance (Migration 67). THE one rule every reader uses to turn a shift's raw attendance rows into its
 * Book On and Book Off. Pure: no I/O, no clock.
 *
 * Rows are append-only. A correction is a new row whose `correctionOfEventId` points at the row it corrects (same shift
 * and type, enforced by the database), each row is corrected at most once, and only the tip may be corrected, so each
 * (shift, type) has one linear chain of any length. The EFFECTIVE row of a chain is its tip: the row no other row
 * corrects. The SQL equivalent is the view `effective_attendance_events`.
 *
 *   bookOn / bookOff   the effective check-in / check-out rows (null when none)
 *   bookOnAt/bookOffAt their occurredAt: the actual times. Hours, reports and lateness use these.
 *   attendedFrom       = bookOnAt
 *   monitoredFrom      = max(bookOnAt, firstKnownAt), firstKnownAt = the Book On chain ROOT row's recordedAt when it is manual
 *                        (its occurredAt when it is a Guard-app row, whose occurredAt is the server time): when S4 first knew the Guard was on duty. Welfare (and Log Book) windows are
 *                        judged from here, so a Book On recorded late, or corrected to an earlier time, never creates
 *                        retrospective missed checks. Pass it as the welfare engine's `bookOnAt`.
 *
 * Defensive fallback: if a set somehow holds more than one tip of a type (not possible after Migration 67's one-root
 * index; possible only for data the migration preflight would have refused), the old reading applies — the earliest
 * check-in and the latest check-out — so no reader becomes stricter or looser than it was.
 */
export type AttendanceRowLike = {
  id: number;
  type: string;
  occurredAt: Date | string;
  recordedAt?: Date | string | null;
  correctionOfEventId?: number | null;
  source?: string | null;
};

export type EffectiveAttendance<T extends AttendanceRowLike> = {
  bookOn: T | null;
  bookOff: T | null;
  bookOnAt: Date | null;
  bookOffAt: Date | null;
  attendedFrom: Date | null;
  monitoredFrom: Date | null;
  bookOnSource: string | null;
  bookOffSource: string | null;
  bookOnCorrected: boolean;
  bookOffCorrected: boolean;
  /** Where verified actuals derived from these rows come from: any correction wins, then any manual row. */
  verifiedSource: 'guard_app' | 'manual' | 'corrected';
};

export const CHECK_IN = 'check-in';
export const CHECK_OUT = 'check-out';

const time = (value: Date | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/** The rows no other row in the set corrects: each chain's tip. Order is preserved. */
export function effectiveEvents<T extends AttendanceRowLike>(events: readonly T[]): T[] {
  const corrected = new Set<number>();
  for (const event of events) {
    if (event.correctionOfEventId !== null && event.correctionOfEventId !== undefined) corrected.add(Number(event.correctionOfEventId));
  }
  return events.filter((event) => !corrected.has(Number(event.id)));
}

/** The first row of the chain `event` belongs to, within the set (stops at a missing link). */
export function chainRoot<T extends AttendanceRowLike>(events: readonly T[], event: T): T {
  const byId = new Map(events.map((e) => [Number(e.id), e]));
  let current = event;
  const seen = new Set<number>();
  while (current.correctionOfEventId !== null && current.correctionOfEventId !== undefined && !seen.has(Number(current.id))) {
    seen.add(Number(current.id));
    const previous = byId.get(Number(current.correctionOfEventId));
    if (!previous) break;
    current = previous;
  }
  return current;
}

export function effectiveAttendance<T extends AttendanceRowLike>(events: readonly T[]): EffectiveAttendance<T> {
  const tips = effectiveEvents(events);
  const pick = (type: string, prefer: 'earliest' | 'latest'): T | null => {
    let chosen: T | null = null;
    let chosenMs = 0;
    for (const event of tips) {
      if (event.type !== type) continue;
      const ms = time(event.occurredAt);
      if (ms === null) continue;
      if (chosen === null || (prefer === 'earliest' ? ms < chosenMs : ms > chosenMs)) {
        chosen = event;
        chosenMs = ms;
      }
    }
    return chosen;
  };
  const bookOn = pick(CHECK_IN, 'earliest');
  const bookOff = pick(CHECK_OUT, 'latest');
  const bookOnMs = bookOn ? time(bookOn.occurredAt) : null;
  const bookOffMs = bookOff ? time(bookOff.occurredAt) : null;

  let monitoredFrom: Date | null = null;
  if (bookOn && bookOnMs !== null) {
    const root = chainRoot(events, bookOn);
    // A Guard-app row's occurredAt IS the server time of the request (S4 knew at that instant), so it is the first
    // known time; recordedAt (equal to it in production) is only consulted for a manual root, where the stated actual
    // time and the time it was recorded differ.
    const firstKnownMs = root.source === 'manual'
      ? time(root.recordedAt) ?? time(root.occurredAt) ?? bookOnMs
      : time(root.occurredAt) ?? bookOnMs;
    monitoredFrom = new Date(Math.max(bookOnMs, firstKnownMs));
  }

  const isCorrection = (event: T | null) => Boolean(event && event.correctionOfEventId !== null && event.correctionOfEventId !== undefined);
  const bookOnCorrected = isCorrection(bookOn);
  const bookOffCorrected = isCorrection(bookOff);
  const anyManual = [bookOn, bookOff].some((event) => event?.source === 'manual');

  return {
    bookOn,
    bookOff,
    bookOnAt: bookOnMs === null ? null : new Date(bookOnMs),
    bookOffAt: bookOffMs === null ? null : new Date(bookOffMs),
    attendedFrom: bookOnMs === null ? null : new Date(bookOnMs),
    monitoredFrom,
    bookOnSource: bookOn?.source ?? (bookOn ? 'guard_app' : null),
    bookOffSource: bookOff?.source ?? (bookOff ? 'guard_app' : null),
    bookOnCorrected,
    bookOffCorrected,
    verifiedSource: bookOnCorrected || bookOffCorrected ? 'corrected' : anyManual ? 'manual' : 'guard_app',
  };
}

/** Rows grouped by their shift id (`shift.id`, or a raw `shiftId`). */
export function groupAttendanceByShift<T extends { shift?: { id: number } | null; shiftId?: number | null }>(
  events: readonly T[],
): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const event of events) {
    const id = event.shift?.id ?? event.shiftId ?? undefined;
    if (id === undefined || id === null) continue;
    const bucket = grouped.get(Number(id));
    if (bucket) bucket.push(event);
    else grouped.set(Number(id), [event]);
  }
  return grouped;
}
