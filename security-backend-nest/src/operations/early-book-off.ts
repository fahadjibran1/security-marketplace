/**
 * Early Book Off and the coverage that remained (S4 Welfare & Reporting Remediation, Phase 4).
 *
 * Pure: no repository, no clock of its own. The service beside it reads the evidence; this decides what
 * that evidence shows, and nothing here writes, closes, alerts or invents an event.
 *
 * EARLY BOOK OFF. A recorded Book Off MORE than 15 minutes before the scheduled end. Exactly 15 minutes
 * early is not early; 15 minutes and one second is. The remaining scheduled time is real elapsed time from
 * the Book Off to the scheduled end (a clock change does not add or lose an hour). Payable hours are not
 * touched: the timesheet already records what was worked.
 *
 * COVERAGE. The question is whether ANOTHER S4 Guard covered the site for the rest of the scheduled shift —
 * the gap [Book Off, scheduled end). It is answered from evidence, segment by segment:
 *
 *   present    another shift at the same site whose Guard was booked on (actual attendance: from its Book
 *              On to its Book Off, or to now while it is still in progress)
 *   planned    the gap is still in the future, and another shift at the site is scheduled for it with a
 *              Guard assigned or already on duty (a schedule, not attendance, and said so)
 *   unknown    another shift booked on but closed without a Book Off: when that Guard left cannot be known
 *   none       none of the above
 *
 *   maintained    every part of the gap is present or planned
 *   undetermined  some part is unknown and the rest does not establish coverage throughout
 *   partial       some of the gap is covered and some is not
 *   uncovered     no other S4 Guard was on duty, or scheduled, at any point in the gap
 *
 * "Uncovered" therefore means no other S4-recorded Guard — never a claim about people S4 does not record.
 * Every other shift at the site counts once, however many there are: a replacement created for the gap, an
 * overlapping shift that was already running, or a second Guard on a two-Guard site. Whether the site's
 * planned headcount was kept (two Guards required, one left) is reported beside it, not folded into it.
 */

export const EARLY_BOOK_OFF_MINUTES = 15;
const MS = 60_000;

/** Statuses whose Guard is not on site at all. */
const NO_PRESENCE_STATUSES = new Set(['cancelled', 'unfilled', 'rejected', 'missed', 'offered']);
/** Statuses whose Guard is assigned and expected, before Book On. */
const ASSIGNED_STATUSES = new Set(['ready', 'accepted', 'in_progress']);

export type CoverageStatus = 'maintained' | 'partial' | 'uncovered' | 'undetermined';

export type EarlyBookOff = {
  /** Whole minutes between the Book Off and the scheduled end. */
  minutesEarly: number;
  /** The same span, the remaining scheduled time. */
  remainingMinutes: number;
};

/** The early-departure facts for a Book Off, or null when it is not more than 15 minutes before the end. */
export function earlyBookOff(scheduledEnd: Date, bookOffAt: Date | null): EarlyBookOff | null {
  if (!bookOffAt) return null;
  const early = scheduledEnd.getTime() - bookOffAt.getTime();
  if (!(early > EARLY_BOOK_OFF_MINUTES * MS)) return null;
  const minutes = Math.floor(early / MS);
  return { minutesEarly: minutes, remainingMinutes: minutes };
}

export type OtherShiftEvidence = {
  shiftId: number;
  status: string;
  start: Date;
  end: Date;
  /** A Guard is assigned to it. */
  hasGuard: boolean;
  bookOnAt: Date | null;
  bookOffAt: Date | null;
};

export type CoverageSegment = { from: Date; to: Date; kind: 'present' | 'planned' | 'unknown' | 'none'; shiftIds: number[] };

export type CoverageAssessment = {
  status: CoverageStatus;
  /** Minutes of the gap with another Guard on duty (or, for the future part, scheduled). */
  coveredMinutes: number;
  /** Minutes with no other Guard on duty or scheduled. */
  uncoveredMinutes: number;
  /** Minutes where it cannot be known. */
  unknownMinutes: number;
  /** True when part of the answer rests on a schedule rather than attendance (the gap is still ahead). */
  reliesOnSchedule: boolean;
  /** The other shifts that provided coverage, by id. */
  coveringShiftIds: number[];
  segments: CoverageSegment[];
};

type Interval = { from: number; to: number; kind: 'present' | 'planned' | 'unknown'; shiftId: number };

/** What one other shift contributes inside [from, to), given the clock. */
function contributions(other: OtherShiftEvidence, from: number, to: number, now: number): Interval[] {
  const status = (other.status || '').trim().toLowerCase();
  const out: Interval[] = [];
  const add = (a: number, b: number, kind: Interval['kind']) => {
    const lo = Math.max(a, from);
    const hi = Math.min(b, to);
    if (hi > lo) out.push({ from: lo, to: hi, kind, shiftId: other.shiftId });
  };
  if (NO_PRESENCE_STATUSES.has(status)) return out;
  const start = other.start.getTime();
  const end = other.end.getTime();
  if (other.bookOnAt) {
    const on = other.bookOnAt.getTime();
    if (other.bookOffAt) {
      add(on, other.bookOffAt.getTime(), 'present');
    } else if (status === 'in_progress') {
      // On duty now: present up to now, and expected (planned) for the rest of its schedule.
      add(on, now, 'present');
      add(now, end, 'planned');
    } else {
      // Booked on, then closed without a Book Off: when this Guard left is not recorded.
      add(on, end, 'unknown');
    }
    return out;
  }
  // Not booked on: only a future part of the gap can rest on the schedule, and only with a Guard assigned.
  if (other.hasGuard && ASSIGNED_STATUSES.has(status)) add(Math.max(start, now), end, 'planned');
  return out;
}

/** The coverage of [from, to) by the other shifts at the same site. */
export function assessCoverage(from: Date, to: Date, others: readonly OtherShiftEvidence[], now: Date): CoverageAssessment {
  const a = from.getTime();
  const b = to.getTime();
  const nowMs = now.getTime();
  const intervals = others.flatMap((o) => contributions(o, a, b, nowMs));

  const cuts = new Set<number>([a, b]);
  for (const i of intervals) { cuts.add(i.from); cuts.add(i.to); }
  const points = [...cuts].filter((p) => p >= a && p <= b).sort((x, y) => x - y);

  const segments: CoverageSegment[] = [];
  for (let k = 0; k + 1 < points.length; k += 1) {
    const lo = points[k];
    const hi = points[k + 1];
    if (hi <= lo) continue;
    const here = intervals.filter((i) => i.from <= lo && i.to >= hi);
    const kind: CoverageSegment['kind'] = here.some((i) => i.kind === 'present') ? 'present'
      : here.some((i) => i.kind === 'planned') ? 'planned'
      : here.some((i) => i.kind === 'unknown') ? 'unknown'
      : 'none';
    const ids = [...new Set(here.filter((i) => i.kind === kind).map((i) => i.shiftId))];
    const last = segments[segments.length - 1];
    if (last && last.kind === kind && last.to.getTime() === lo && last.shiftIds.join(',') === ids.join(',')) {
      last.to = new Date(hi);
    } else {
      segments.push({ from: new Date(lo), to: new Date(hi), kind, shiftIds: ids });
    }
  }

  const minutes = (kind: CoverageSegment['kind']) =>
    Math.round(segments.filter((s) => s.kind === kind).reduce((n, s) => n + (s.to.getTime() - s.from.getTime()), 0) / MS);
  const covered = minutes('present') + minutes('planned');
  const uncovered = minutes('none');
  const unknown = minutes('unknown');
  const status: CoverageStatus = segments.every((s) => s.kind === 'present' || s.kind === 'planned') ? 'maintained'
    : unknown > 0 ? 'undetermined'
    : covered > 0 ? 'partial'
    : 'uncovered';

  return {
    status,
    coveredMinutes: covered,
    uncoveredMinutes: uncovered,
    unknownMinutes: unknown,
    reliesOnSchedule: segments.some((s) => s.kind === 'planned'),
    coveringShiftIds: [...new Set(segments.filter((s) => s.kind === 'present' || s.kind === 'planned').flatMap((s) => s.shiftIds))],
    segments,
  };
}

/** "Coverage maintained", "Partial coverage gap", "Uncovered period", "Coverage undetermined". */
export const COVERAGE_STATUS_WORD: Record<CoverageStatus, string> = {
  maintained: 'Coverage maintained',
  partial: 'Partial coverage gap',
  uncovered: 'Uncovered period',
  undetermined: 'Coverage undetermined',
};

/** "4h 51m" from minutes. */
export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
