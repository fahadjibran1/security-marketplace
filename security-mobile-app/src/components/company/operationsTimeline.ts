// The control-room Operations Timeline. (Phase 4A.)
//
// WHAT THIS REPLACES
// Live Operations presented a flat table: one row per shift, columns for site, guard, scheduled time,
// attendance, status, risk, alerts. A controller could read one shift at a time and had to hold the rest
// in their head. It could not answer "who is on at 21:00 across all my sites", and it could not show a
// Welfare history at all — only the current window's status word.
//
// This module computes the timeline's geometry and nothing else. It is pure, so every rule below is
// executed by tests rather than eyeballed in a browser:
//
//   - which shifts belong on the visible axis, and where their bars start and end
//   - where each Welfare window marker sits, and which state it carries
//   - where NOW is
//   - how a site's rows group, including several guards and overlapping shifts
//   - what the attendance labels say
//
// TWO RULES IT DOES NOT BREAK
//
// 1. IT NEVER COMPUTES A WELFARE WINDOW. The backend's operational window engine resolves the grid and
//    publishes it (`operations.welfare.windows`); this module positions what it is given and passes the
//    engine's own state through. A second grid on the client is exactly how a controller and a Guard
//    start disagreeing, which Phase 3D existed to end.
//
// 2. IT REASONS IN INSTANTS, RENDERS IN SITE TIME. Every position is arithmetic on epoch milliseconds.
//    Every label goes through the shared site-time module with the SITE's zone. There is no date
//    slicing, no device zone and no UTC digit anywhere, so an overnight shift and a site in another
//    timezone both come out right.

import {
  DEFAULT_SITE_TIME_ZONE,
  formatInstantTime,
  formatSiteDateInput,
  zoneOffsetMs,
} from '../../services/siteTime';
import type { GuardOperationalWindow, ShiftOperationsView, WelfareWindowAlertView } from '../../types/models';
import { isAwaitingBookOn, welfareAlertWord } from './welfareMonitoring';
import { isAwaitingReconciliation, isBookOffOverdue } from './liveOperationsPolicy';

// ─── the visible axis ─────────────────────────────────────────────────────────

/** The ranges a controller can choose. 8 hours is the default working view. */
export const TIMELINE_RANGES = [4, 8, 12, 24] as const;
export type TimelineRangeHours = (typeof TIMELINE_RANGES)[number];
export const DEFAULT_TIMELINE_RANGE: TimelineRangeHours = 8;

/**
 * How far before `now` the default window starts, as a fraction of the range.
 *
 * A third behind, two thirds ahead. A control room needs more of what is coming than of what has gone —
 * but not none of what has gone, because the reason a Guard is late is always in the recent past.
 */
export const NOW_OFFSET_FRACTION = 1 / 3;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export type TimelineWindow = {
  /** Inclusive start of the visible axis, epoch ms. */
  startMs: number;
  /** Exclusive end of the visible axis, epoch ms. */
  endMs: number;
  rangeHours: TimelineRangeHours;
};

/**
 * The visible axis for a range, positioned around an anchor instant.
 *
 * Snapped down to the hour so the column headers are whole hours in the SITE's zone — a controller reads
 * "21:00", not "20:47". Snapping uses the site's own offset, so a zone on a half-hour offset still lands
 * on its own hour boundaries.
 */
export function resolveTimelineWindow(
  anchorMs: number,
  rangeHours: TimelineRangeHours,
  timeZone: string = DEFAULT_SITE_TIME_ZONE,
): TimelineWindow {
  const span = rangeHours * HOUR_MS;
  const rawStart = anchorMs - span * NOW_OFFSET_FRACTION;

  // Snap to the SITE's hour boundary, not the UTC one. Shifting into site-local time before flooring is
  // what makes a zone on a half-hour offset (India, Newfoundland) land on its own :00, rather than on
  // :30 as a UTC floor would.
  const offset = zoneOffsetMs(new Date(rawStart), timeZone);
  const startMs = Math.floor((rawStart + offset) / HOUR_MS) * HOUR_MS - offset;

  return { startMs, endMs: startMs + span, rangeHours };
}

/** Shift the visible axis by whole hours — the Earlier / Later controls. */
export function panTimelineWindow(window: TimelineWindow, hours: number): TimelineWindow {
  return {
    startMs: window.startMs + hours * HOUR_MS,
    endMs: window.endMs + hours * HOUR_MS,
    rangeHours: window.rangeHours,
  };
}

/** Whole-hour tick marks across the axis, labelled on the SITE's clock. */
export function timelineHourTicks(
  window: TimelineWindow,
  timeZone: string,
): Array<{ ms: number; fraction: number; label: string }> {
  const ticks: Array<{ ms: number; fraction: number; label: string }> = [];
  const span = window.endMs - window.startMs;
  for (let ms = window.startMs; ms < window.endMs; ms += HOUR_MS) {
    ticks.push({
      ms,
      fraction: (ms - window.startMs) / span,
      label: formatInstantTime(new Date(ms).toISOString(), timeZone),
    });
  }
  return ticks;
}

/**
 * Where an instant sits on the axis, as a 0..1 fraction, or null when it is off-axis.
 *
 * Returning null rather than clamping is deliberate for the NOW marker: a clamped marker pinned to an
 * edge would claim "now" is somewhere it is not.
 */
export function axisFraction(ms: number, window: TimelineWindow): number | null {
  if (!Number.isFinite(ms)) return null;
  if (ms < window.startMs || ms > window.endMs) return null;
  return (ms - window.startMs) / (window.endMs - window.startMs);
}

/**
 * Where the horizontal viewport should sit so NOW is in shot, in pixels from the axis's left edge.
 *
 * At 24h the axis is wider than any screen, so opening it scrolled to the left means a controller is shown
 * lunchtime while the work they are watching is at 21:00 — an apparently empty board. This puts NOW a
 * third of the way across the viewport, the same proportion the window itself uses, and clamps to the
 * scrollable range so the axis can never be scrolled past its own ends.
 *
 * It is the VIEWPORT that moves. The window of instants is untouched, so Earlier / Now / Later and the
 * NOW line still mean exactly what they meant before.
 */
export function nowScrollOffset(
  nowFraction: number | null,
  contentWidth: number,
  viewportWidth: number,
  offsetFraction: number = NOW_OFFSET_FRACTION,
): number {
  if (nowFraction === null || !Number.isFinite(nowFraction)) return 0;
  if (!(contentWidth > viewportWidth) || !(viewportWidth > 0)) return 0;
  const target = nowFraction * contentWidth - viewportWidth * offsetFraction;
  return Math.max(0, Math.min(target, contentWidth - viewportWidth));
}

// ─── bars ─────────────────────────────────────────────────────────────────────

export type TimelineSpan = {
  /** Left edge as a 0..1 fraction of the axis. */
  startFraction: number;
  /** Width as a 0..1 fraction of the axis. */
  widthFraction: number;
  /** True when the bar begins before the visible axis, so the UI can show a leading cue. */
  clippedStart: boolean;
  /** True when the bar continues past the visible axis. */
  clippedEnd: boolean;
  /**
   * Phase 4: the shift's bar ended before this view, but the row is still drawn because its Book Off is
   * overdue. The UI shows a marker at the left edge rather than a bar, so the board and the timeline keep
   * agreeing about what is outstanding without stretching the bar to now.
   */
  endedBeforeWindow?: boolean;
};

/**
 * A shift's bar, clipped to the axis, or null when it does not overlap at all.
 *
 * Clipping is what makes an overnight shift work: a 20:00-08:00 shift viewed at 02:00 is a bar that
 * starts before the axis and ends after it, and the two clipped flags let the UI say so instead of
 * pretending the shift starts when the screen does.
 */
export function resolveTimelineSpan(
  startMs: number,
  endMs: number,
  window: TimelineWindow,
): TimelineSpan | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= window.startMs || startMs >= window.endMs) return null;

  const span = window.endMs - window.startMs;
  const visibleStart = Math.max(startMs, window.startMs);
  const visibleEnd = Math.min(endMs, window.endMs);

  return {
    startFraction: (visibleStart - window.startMs) / span,
    widthFraction: Math.max((visibleEnd - visibleStart) / span, 0),
    clippedStart: startMs < window.startMs,
    clippedEnd: endMs > window.endMs,
  };
}

// ─── welfare markers ──────────────────────────────────────────────────────────

/**
 * The marker states: the engine's own window states, with "due" split by the clock into Upcoming (not
 * started) and Due (running now) — a reading of the time, never a recalculation of the window — and the
 * Welfare Phase 2 state for a final window the Guard booked off part-way through, which is deliberately
 * neither a miss nor "not required" until the owner sets that policy.
 */
export type WelfareMarkerState =
  | 'upcoming'
  | 'completed'
  | 'due'
  | 'overdue'
  | 'missed'
  | 'ended_at_book_off'
  | 'not_applicable';

/**
 * Glyph and text for each state.
 *
 * Never colour alone. Every marker carries a glyph AND an accessible label, so the strip reads on a
 * monochrome screen, to a screen reader, and to a controller with colour-vision deficiency.
 */
export const WELFARE_MARKER_GLYPH: Record<WelfareMarkerState, string> = {
  upcoming: '○',
  completed: '✓',
  due: '●',
  overdue: '!',
  missed: '✕',
  ended_at_book_off: '◐',
  not_applicable: '—',
};

export const WELFARE_MARKER_WORD: Record<WelfareMarkerState, string> = {
  upcoming: 'Upcoming',
  completed: 'Completed',
  due: 'Due',
  overdue: 'Overdue',
  missed: 'Missed',
  ended_at_book_off: 'Ended at Book Off',
  not_applicable: 'Not required',
};

export type WelfareMarker = {
  index: number;
  state: WelfareMarkerState;
  glyph: string;
  /** The span the marker occupies, clipped to the axis. */
  span: TimelineSpan;
  /** What a screen reader and the tooltip say. Never colour alone. */
  accessibleLabel: string;
};

/**
 * The Welfare markers for one shift, positioned on the axis.
 *
 * `windows` is the engine's published grid. This function chooses positions and wording; it does not
 * decide a single window's state. A window off the visible axis is dropped, not clamped, so a marker
 * never appears at a time its window did not cover.
 */
export function resolveWelfareMarkers(
  windows: readonly GuardOperationalWindow[] | undefined,
  window: TimelineWindow,
  context: { guardName: string; timeZone: string; nowMs?: number; awaitingBookOn?: boolean },
): WelfareMarker[] {
  if (!windows || windows.length === 0) return [];

  const markers: WelfareMarker[] = [];
  for (const w of windows) {
    const startMs = Date.parse(w.start);
    const endMs = Date.parse(w.end);
    const span = resolveTimelineSpan(startMs, endMs, window);
    if (!span) continue;

    const state = (w as { state?: string }).state as WelfareMarkerState | undefined;
    const known: WelfareMarkerState = state && state in WELFARE_MARKER_GLYPH ? state : 'not_applicable';
    // Not started yet: the engine's "due" for a window still ahead reads as Upcoming, and so does a future
    // window of a shift not yet booked on (the engine owes nothing before Book On; it is not "not required").
    const ahead = context.nowMs !== undefined && startMs > context.nowMs;
    const resolved: WelfareMarkerState =
      ahead && (known === 'due' || (known === 'not_applicable' && context.awaitingBookOn)) ? 'upcoming' : known;

    markers.push({
      index: w.index,
      state: resolved,
      glyph: WELFARE_MARKER_GLYPH[resolved],
      span,
      accessibleLabel: welfareMarkerLabel(w, resolved, context),
    });
  }
  return markers;
}

/**
 * "Fahad test, Welfare Check 20:45–21:00, Completed at 20:48" — guard, window, state, and when — and for a
 * missed window, when it was recorded and the alert that carried it, so hovering a marker answers the
 * control room's question without opening the shift.
 */
export function welfareMarkerLabel(
  w: GuardOperationalWindow & { state?: string; completedAt?: string | null; missRecordedAt?: string | null; alert?: WelfareWindowAlertView | null },
  state: WelfareMarkerState,
  context: { guardName: string; timeZone: string },
): string {
  const from = formatInstantTime(w.start, context.timeZone);
  const to = formatInstantTime(w.end, context.timeZone);
  const base = `${context.guardName}, Welfare Check ${from}–${to}, ${WELFARE_MARKER_WORD[state]}`;
  if (state === 'completed' && w.completedAt) return `${base} at ${formatInstantTime(w.completedAt, context.timeZone)}`;
  if (state === 'missed' && w.missRecordedAt) {
    const alert = welfareAlertWord(w.alert) ?? 'no alert raised';
    return `${base}, recorded ${formatInstantTime(w.missRecordedAt, context.timeZone)}, ${alert}`;
  }
  return base;
}

// ─── attendance ───────────────────────────────────────────────────────────────

export type AttendanceLabels = {
  /** "ON 20:33" or "ON —". */
  bookOn: string;
  /** "OFF 05:35" or "OFF —". */
  bookOff: string;
  /** True when the scheduled start has passed with no Book On. */
  late: boolean;
};

/**
 * The attendance labels shown on the bar, so a controller never has to open a shift to see them.
 *
 * No new attendance state machine: this reads the same `checkInAt` / `checkOutAt` the board already has,
 * and `late` is the same question Live Operations already asks — start passed, nothing recorded.
 */
export function resolveAttendanceLabels(
  shift: { start: string; end?: string | null; status?: string | null },
  attendance: { checkInAt?: string | null; checkOutAt?: string | null } | null | undefined,
  nowMs: number,
  timeZone: string,
  closedByControl = false,
): AttendanceLabels {
  const on = attendance?.checkInAt ?? null;
  const off = attendance?.checkOutAt ?? null;
  const startMs = Date.parse(shift.start);
  const status = (shift.status || '').trim().toLowerCase();
  const settled = ['completed', 'cancelled', 'missed', 'rejected'].includes(status);

  return {
    bookOn: on ? `ON ${formatInstantTime(on, timeZone)}` : 'ON —',
    // No Book Off time is ever shown or invented. Instead (Phase 4): a shift Control closed without one
    // says so; one awaiting reconciliation says "missing"; an overdue one shows how long since its
    // scheduled end, as its own figure — the bar itself stops at the scheduled end.
    bookOff: off
      ? `OFF ${formatInstantTime(off, timeZone)}`
      : !on ? 'OFF —'
      : status === 'completed' ? (closedByControl ? 'No Book Off' : 'Book Off missing')
      : shift.end && isAwaitingReconciliation(shift.end, nowMs) ? `OFF missing · ${formatElapsedSinceEnd(shift.end, nowMs)}`
      : shift.end && isBookOffOverdue(shift.end, nowMs) ? `OFF overdue ${formatElapsedSinceEnd(shift.end, nowMs)}`
      : 'OFF —',
    late: !on && !settled && Number.isFinite(startMs) && nowMs > startMs,
  };
}

/**
 * "2h 15m" / "26h" — how long ago a shift's SCHEDULED end was. A figure about the schedule, never a
 * claimed departure time.
 */
export function formatElapsedSinceEnd(end: string, nowMs: number): string {
  const endMs = Date.parse(end);
  if (!Number.isFinite(endMs) || nowMs <= endMs) return '0m';
  const minutes = Math.floor((nowMs - endMs) / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${hours}h`;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes % 60}m`;
}

/** A shift whose outcome is already decided. Its bar is whatever the schedule said it was. */
const SETTLED_STATUSES = ['completed', 'cancelled', 'missed', 'rejected'];

/**
 * When a shift's bar actually ends — which is not always when it was scheduled to.
 *
 * PRODUCTION UAT FIX 01. A guard booked on at 20:33 and never booked off was still standing on site at
 * 10:55 the next morning. The relevance policy kept the shift — `in_progress` is unbounded, deliberately,
 * because "a shift someone is standing on is the control room's first responsibility whatever the clock
 * says". But the timeline drew the bar at its SCHEDULED span, 20:35–21:35 yesterday, which is thirteen
 * hours behind today's axis, so the board said "0 shifts" while the metric beside it said "1 live".
 *
 * The honest answer is that the shift has not ended. A Book On with no Book Off is an open-ended
 * occupancy, so the bar runs to now and keeps running. Nothing is clamped and no window is widened: the
 * span is simply the truth about how long the guard has been there.
 *
 * It applies to that case ONLY. A settled shift, one already booked off, and one never booked on all
 * keep their scheduled end — so a completed, missed, unfilled or ordinary previous-day shift does not
 * reappear on today's board.
 */
export function effectiveShiftEndMs(
  shift: { end: string; status?: string | null },
  attendance: { checkInAt?: string | null; checkOutAt?: string | null } | null | undefined,
  nowMs: number,
): number {
  const scheduledEnd = Date.parse(shift.end);
  if (!Number.isFinite(scheduledEnd)) return scheduledEnd;

  if (SETTLED_STATUSES.includes((shift.status || '').trim().toLowerCase())) return scheduledEnd;
  if (!attendance?.checkInAt) return scheduledEnd;
  if (attendance?.checkOutAt) return scheduledEnd;
  // Phase 4 (owner decision): once the Book Off is OVERDUE — past the scheduled end plus the 15-minute
  // grace — the bar stops at the SCHEDULED end. Running it on to now drew hours of occupancy nobody
  // recorded. The overdue time is shown as its own figure, the badge says No Book Off / Missing Book Off,
  // and no Book Off time is invented. (Phase 3 did this only past 24 hours.)
  if (isBookOffOverdue(shift.end, nowMs)) return scheduledEnd;

  return Math.max(scheduledEnd, nowMs);
}

// ─── row status ───────────────────────────────────────────────────────────────

export type TimelineStatus =
  | 'Upcoming' | 'Late' | 'Live' | 'No Book Off' | 'Missing Book Off' | 'Completed' | 'Closed by Control'
  | 'Coverage Gap';

/**
 * The compact status word for a bar.
 *
 * Derived from the lifecycle and attendance the board already carries — deliberately five words, because
 * a bar is a few millimetres tall and a sentence in it is unreadable.
 */
export function resolveTimelineStatus(
  shift: { start: string; end?: string | null; status?: string | null },
  attendance: { checkInAt?: string | null; checkOutAt?: string | null } | null | undefined,
  nowMs: number,
  closedByControl = false,
): TimelineStatus {
  const status = (shift.status || '').trim().toLowerCase();
  // "Closed by Control" only when the reconciliation audit entry exists. A completed shift with no Book Off
  // and no such entry is just Completed, and its Book Off slot says it is missing.
  if (status === 'completed') {
    return closedByControl && attendance?.checkInAt && !attendance?.checkOutAt ? 'Closed by Control' : 'Completed';
  }
  if (['unfilled', 'rejected', 'missed', 'cancelled'].includes(status)) return 'Coverage Gap';
  if (attendance?.checkOutAt) return 'Completed';
  if (attendance?.checkInAt || status === 'in_progress') {
    // Worked, and the Book Off is overdue: not live any more, whatever the status column says. Asked of
    // the board's own policy, so the bar and the board use one boundary (and the backend alert's).
    // Past 24 hours it is awaiting reconciliation: Missing Book Off (Phase 3).
    if (isAwaitingReconciliation(shift.end, nowMs)) return 'Missing Book Off';
    return isBookOffOverdue(shift.end, nowMs) ? 'No Book Off' : 'Live';
  }

  const startMs = Date.parse(shift.start);
  if (Number.isFinite(startMs) && nowMs > startMs) return 'Late';
  return 'Upcoming';
}

// ─── grouping ─────────────────────────────────────────────────────────────────

export type TimelineShiftInput = {
  shift: {
    id: number;
    start: string;
    end: string;
    status?: string | null;
    siteName?: string | null;
    site?: { id?: number | null; name?: string | null; timezone?: string | null } | null;
    siteId?: number | null;
    guard?: { fullName?: string | null } | null;
  };
  attendance?: { checkInAt?: string | null; checkOutAt?: string | null } | null;
  operations?: ShiftOperationsView | null;
  /** True only when a reconciliation AUDIT ENTRY exists for this shift (Close without Book Off). */
  closedByControl?: boolean;
};

export type TimelineRow = {
  shiftId: number;
  guardName: string;
  /** Scheduled time on the site clock, e.g. "20:35–05:35". */
  scheduled: string;
  status: TimelineStatus;
  attendance: AttendanceLabels;
  span: TimelineSpan;
  welfare: WelfareMarker[];
  /** True when the shift's scheduled end falls on a later SITE day than its start. */
  overnight: boolean;
};

export type TimelineSiteGroup = {
  siteId: number | null;
  siteName: string;
  timeZone: string;
  rows: TimelineRow[];
};

function siteKeyOf(input: TimelineShiftInput): string {
  const id = input.shift.site?.id ?? input.shift.siteId ?? null;
  return id === null ? `name:${input.shift.site?.name || input.shift.siteName || 'unknown'}` : `id:${id}`;
}

/** The site's own zone, which every label and position for its rows is rendered against. */
export function siteZoneOf(input: TimelineShiftInput): string {
  return input.shift.site?.timezone || DEFAULT_SITE_TIME_ZONE;
}

/**
 * The timeline, grouped by site, with one row per shift.
 *
 * Several guards at one site, and overlapping shifts, are both simply several rows under the same
 * heading — there is no merging, because two guards on at once is the normal case for a staffed site and
 * a controller must see both. Rows are ordered by scheduled start so the eye follows the shift pattern
 * down the group; sites are ordered by name so the list is stable between refreshes.
 *
 * A shift that does not overlap the visible axis is dropped, and a site with no remaining rows is
 * dropped with it.
 */
export function buildTimeline(
  inputs: readonly TimelineShiftInput[],
  window: TimelineWindow,
  nowMs: number,
): TimelineSiteGroup[] {
  const groups = new Map<string, TimelineSiteGroup>();

  for (const input of inputs) {
    // The bar is drawn against the shift's EFFECTIVE end, so a guard who booked on and never booked off
    // is still on the board the next morning. Every other row is unaffected.
    const endMs = effectiveShiftEndMs(input.shift, input.attendance, nowMs);
    let span = resolveTimelineSpan(Date.parse(input.shift.start), endMs, window);
    // Phase 4: an overdue Book Off whose bar ended before this view still gets its row, with a marker at
    // the left edge, so the board and the timeline agree about what is outstanding.
    if (!span && isOverdueWithoutBookOff(input.shift, input.attendance, nowMs) && endMs <= window.startMs) {
      span = { startFraction: 0, widthFraction: 0, clippedStart: true, clippedEnd: false, endedBeforeWindow: true };
    }
    if (!span) continue;

    const timeZone = siteZoneOf(input);
    const guardName = input.shift.guard?.fullName || 'Unassigned';
    const key = siteKeyOf(input);

    let group = groups.get(key);
    if (!group) {
      group = {
        siteId: input.shift.site?.id ?? input.shift.siteId ?? null,
        siteName: input.shift.site?.name || input.shift.siteName || 'Unknown site',
        timeZone,
        rows: [],
      };
      groups.set(key, group);
    }

    group.rows.push({
      shiftId: input.shift.id,
      guardName,
      scheduled: `${formatInstantTime(input.shift.start, timeZone)}–${formatInstantTime(input.shift.end, timeZone)}`,
      status: resolveTimelineStatus(input.shift, input.attendance, nowMs, Boolean(input.closedByControl)),
      attendance: resolveAttendanceLabels(input.shift, input.attendance, nowMs, timeZone, Boolean(input.closedByControl)),
      span,
      welfare: resolveWelfareMarkers(input.operations?.welfare?.windows, window, {
        guardName, timeZone, nowMs,
        awaitingBookOn: isAwaitingBookOn(input.attendance?.checkInAt ?? input.operations?.bookOnAt ?? null, input.shift.status),
      }),
      overnight:
        formatSiteDateInput(input.shift.end, timeZone) > formatSiteDateInput(input.shift.start, timeZone),
    });
  }

  const ordered = [...groups.values()].sort((a, b) => a.siteName.localeCompare(b.siteName));
  for (const group of ordered) {
    group.rows.sort((a, b) => a.scheduled.localeCompare(b.scheduled) || a.shiftId - b.shiftId);
  }
  return ordered;
}

/** Booked on, not booked off, not settled, and past the Book Off grace. */
function isOverdueWithoutBookOff(
  shift: { end: string; status?: string | null },
  attendance: { checkInAt?: string | null; checkOutAt?: string | null } | null | undefined,
  nowMs: number,
): boolean {
  if (!attendance?.checkInAt || attendance.checkOutAt) return false;
  if (SETTLED_STATUSES.includes((shift.status || '').trim().toLowerCase())) return false;
  // Past 24 hours it awaits reconciliation and is listed in its own queue, not marked on today's axis.
  return isBookOffOverdue(shift.end, nowMs) && !isAwaitingReconciliation(shift.end, nowMs);
}

/** Total rows on the timeline, so a count beside the header cannot disagree with what is drawn. */
export function timelineRowCount(groups: readonly TimelineSiteGroup[]): number {
  return groups.reduce((total, group) => total + group.rows.length, 0);
}
