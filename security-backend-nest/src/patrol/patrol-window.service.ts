import { Injectable } from '@nestjs/common';
import { siteLocalToInstant } from '../common/site-time';
import { OperationalWindowService } from '../operations/operational-window.service';
import { OperationalApplicability } from '../operations/operational-window.types';

/**
 * Patrol windows (Patrols P1-B). A schedule's windows are SITE-LOCAL wall-clock slots, unlike Welfare and Log Book, whose
 * windows are elapsed-time slots anchored to the shift start (operations/operational-window.service.ts). A patrol "every
 * hour from 22:00 to 06:00" means 22:00, 23:00 … 05:00 on the site's clock, whatever the season.
 *
 *   slot k of local date D     starts at activeFrom + k × frequencyMinutes and lasts windowMinutes, clipped to activeTo;
 *                              while the slot START is before activeTo. An active period whose end is at or before its
 *                              start (22:00–06:00, or 00:00–00:00 for the whole day) runs past midnight and belongs to D,
 *                              the day it starts on (daysOfWeek, startsOn and endsOn are judged on D).
 *   wall → instant             common/site-time.ts siteLocalToInstant, per boundary:
 *                                - the repeated autumn hour uses its EARLIEST occurrence (AMBIGUOUS_POLICY), so no slot
 *                                  is generated twice; the slot that starts in it simply ends at its wall-clock end, so on
 *                                  25 Oct 2026 an hourly 01:00 slot runs 00:00Z–02:00Z (two real hours) and nothing of the
 *                                  night is uncovered or double-counted;
 *                                - a boundary inside the spring-forward gap moves to the FIRST VALID INSTANT after it, so
 *                                  a window starting in the gap starts when the clocks go forward; a slot whose whole span
 *                                  is inside the gap collapses to nothing and does not exist that night (on 29 Mar 2026 an
 *                                  hourly 01:00 slot), so the night has no duplicate or zero-length window.
 *   windowKey                  "s{scheduleId}:{D}:{k}" — stable, readable, never re-numbered by a DST night (a slot that
 *                              collapses keeps its index unused), and distinct per schedule, so overlapping schedules are
 *                              independent: each has its own windows, runs and exceptions.
 *
 * Applicability (who must patrol a window) is the shared operational rule: a Guard is on duty for a window when it overlaps
 * their effective Book On (monitoredFrom, as Welfare uses) to Book Off, or the shift end (OperationalWindowService
 * .isApplicable). A cancelled shift is on duty for nothing, so its windows are dropped.
 *
 * Nothing here touches the database or a clock; windows are computed, never stored (see patrol-sweep.service.ts).
 */

export type PatrolScheduleLike = {
  id: number;
  daysOfWeek: number[];
  activeFrom: string;
  activeTo: string;
  frequencyMinutes: number;
  windowMinutes: number;
  startsOn?: string | null;
  endsOn?: string | null;
};

export type PatrolWindow = {
  scheduleId: number;
  windowKey: string;
  /** The site-local date the active period starts on. */
  localDate: string;
  slotIndex: number;
  start: Date;
  end: Date;
};

const MINUTES_PER_DAY = 1440;
/** The longest a spring-forward gap can be (a few zones skip more than an hour, none more than three). */
const GAP_SCAN_LIMIT_MINUTES = 180;

export function patrolWindowKey(scheduleId: number, localDate: string, slotIndex: number): string {
  return `s${scheduleId}:${localDate}:${slotIndex}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD plus n calendar days (never by adding 24 h to an instant: transition days are 23 or 25 hours long). */
export function addLocalDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
/** The site-local calendar date of an instant. */
export function localDateOf(instant: Date, timeZone: string): string {
  let format = dateFormatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFormatters.set(timeZone, format);
  }
  return format.format(instant);
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * A site-local wall-clock reading as an instant. `minutes` counts from D's midnight and may pass 1440 (the next day).
 * Ambiguous (autumn) → earliest occurrence; nonexistent (spring gap) → the first valid instant after it.
 */
export function wallMinutesToInstant(localDate: string, minutes: number, timeZone: string, cache?: Map<string, number>): number {
  const date = addLocalDays(localDate, Math.floor(minutes / MINUTES_PER_DAY));
  const m = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const key = `${date}T${m}`;
  const hit = cache?.get(key);
  if (hit !== undefined) return hit;
  let result: number | null = null;
  const direct = siteLocalToInstant(date, `${pad(Math.floor(m / 60))}:${pad(m % 60)}`, timeZone);
  if (direct.ok) {
    result = direct.instant;
  } else {
    // In the gap: the first wall-clock minute after it that exists is the moment the clocks went forward.
    for (let step = 1; step <= GAP_SCAN_LIMIT_MINUTES && result === null; step += 1) {
      const total = m + step;
      const d2 = addLocalDays(date, Math.floor(total / MINUTES_PER_DAY));
      const m2 = total % MINUTES_PER_DAY;
      const probe = siteLocalToInstant(d2, `${pad(Math.floor(m2 / 60))}:${pad(m2 % 60)}`, timeZone);
      if (probe.ok) result = probe.instant;
    }
    if (result === null) throw new Error(`No valid instant near ${date} ${m} min in ${timeZone}`);
  }
  cache?.set(key, result);
  return result;
}

/**
 * The instants bounding one site-local calendar day (#77, #78): [its midnight, the NEXT day's midnight). A DST day is 23
 * or 25 hours long (Europe/London: 30 Mar 2025 runs 00:00Z → 23:00Z, 26 Oct 2025 runs 23:00Z on the 25th → 00:00Z on
 * the 27th), so the end is never "start + 24 h". Both ends go through wallMinutesToInstant, the window engine's own
 * conversion, so a dashboard day and the windows due in it always agree.
 */
export function siteDayBounds(localDate: string, timeZone: string): { start: Date; end: Date } {
  return {
    start: new Date(wallMinutesToInstant(localDate, 0, timeZone)),
    end: new Date(wallMinutesToInstant(localDate, MINUTES_PER_DAY, timeZone)),
  };
}

/** Whether the schedule runs on this local date (days of week, first and last date). */
export function scheduleRunsOn(schedule: PatrolScheduleLike, localDate: string): boolean {
  if (!schedule.daysOfWeek?.map(Number).includes(isoWeekday(localDate))) return false;
  const startsOn = calendarDate(schedule.startsOn);
  const endsOn = calendarDate(schedule.endsOn);
  if (startsOn && localDate < startsOn) return false;
  if (endsOn && localDate > endsOn) return false;
  return true;
}

/** A `date` column as YYYY-MM-DD, whether the driver returned a string or a Date (the process clock is UTC). */
function calendarDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** The windows of one schedule whose active period starts on `localDate` (site-local). */
export function windowsForLocalDate(schedule: PatrolScheduleLike, localDate: string, timeZone: string, cache?: Map<string, number>): PatrolWindow[] {
  if (!scheduleRunsOn(schedule, localDate)) return [];
  const frequency = Number(schedule.frequencyMinutes);
  const length = Number(schedule.windowMinutes);
  if (!(frequency >= 15) || !(length >= 1)) return [];
  const from = minutesOf(schedule.activeFrom);
  let to = minutesOf(schedule.activeTo);
  if (to <= from) to += MINUTES_PER_DAY; // overnight (or the whole day when equal): belongs to the start day
  const windows: PatrolWindow[] = [];
  for (let slot = 0; from + slot * frequency < to; slot += 1) {
    const startMinutes = from + slot * frequency;
    const endMinutes = Math.min(startMinutes + length, to);
    const start = wallMinutesToInstant(localDate, startMinutes, timeZone, cache);
    const end = wallMinutesToInstant(localDate, endMinutes, timeZone, cache);
    if (end <= start) continue; // the whole slot is inside a spring-forward gap
    windows.push({
      scheduleId: Number(schedule.id),
      windowKey: patrolWindowKey(Number(schedule.id), localDate, slot),
      localDate,
      slotIndex: slot,
      start: new Date(start),
      end: new Date(end),
    });
  }
  return windows;
}

/** Every window of the schedule that overlaps [from, to), in time order. */
export function windowsBetween(schedule: PatrolScheduleLike, timeZone: string, from: Date, to: Date, cache = new Map<string, number>()): PatrolWindow[] {
  if (!(to.getTime() > from.getTime())) return [];
  // An active period may start the day before and run past midnight, so start one local day early.
  const first = addLocalDays(localDateOf(from, timeZone), -1);
  const last = localDateOf(to, timeZone);
  const out: PatrolWindow[] = [];
  for (let date = first, guard = 0; date <= last && guard < 400; date = addLocalDays(date, 1), guard += 1) {
    for (const window of windowsForLocalDate(schedule, date, timeZone, cache)) {
      if (window.end.getTime() > from.getTime() && window.start.getTime() < to.getTime()) out.push(window);
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.windowKey.localeCompare(b.windowKey));
}

/**
 * The window a run started at `at` is for: the schedule's window containing `at`; otherwise the latest window that ended
 * at or before `at` while `at` is still inside its start grace (a LATE start). A run satisfies exactly this one window.
 * Null when neither exists (the run is recorded, but satisfies no window).
 */
export function windowForStart(
  schedule: PatrolScheduleLike,
  timeZone: string,
  at: Date,
  startGraceMinutes: number,
): { window: PatrolWindow; lateStart: boolean } | null {
  const t = at.getTime();
  const graceMs = Math.max(0, startGraceMinutes) * 60_000;
  const windows = windowsBetween(schedule, timeZone, new Date(t - (MINUTES_PER_DAY + startGraceMinutes + 1) * 60_000), new Date(t + 60_000));
  const containing = windows.filter((w) => w.start.getTime() <= t && t < w.end.getTime());
  if (containing.length) return { window: containing[0], lateStart: false };
  const late = windows.filter((w) => w.end.getTime() <= t && t < w.end.getTime() + graceMs);
  if (late.length) return { window: late[late.length - 1], lateStart: true };
  return null;
}

/** An on-duty interval: the shift and its effective attendance, as the operational window engine reads them. */
export type PatrolDutyShift = {
  shiftId: number;
  guardId: number | null;
  applicability: OperationalApplicability;
};

@Injectable()
export class PatrolWindowService {
  constructor(private readonly operationalWindows: OperationalWindowService) {}

  windowsBetween(schedule: PatrolScheduleLike, timeZone: string, from: Date, to: Date, cache?: Map<string, number>) {
    return windowsBetween(schedule, timeZone, from, to, cache);
  }

  windowForStart(schedule: PatrolScheduleLike, timeZone: string, at: Date, startGraceMinutes: number) {
    return windowForStart(schedule, timeZone, at, startGraceMinutes);
  }

  /** The shifts on duty at the site for this window (overlap with Book On → Book Off / shift end; never a cancelled shift). */
  onDutyShifts(window: PatrolWindow, shifts: readonly PatrolDutyShift[]): PatrolDutyShift[] {
    return shifts.filter((shift) => this.operationalWindows.isApplicable(
      { index: window.slotIndex, start: window.start, end: window.end },
      shift.applicability,
    ));
  }
}
