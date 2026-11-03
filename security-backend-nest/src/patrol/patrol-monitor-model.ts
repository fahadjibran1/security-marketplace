import { OperationalWindowService } from '../operations/operational-window.service';
import { completionDeadline, startDeadline, syncDeadline } from './patrol-state';
import type { PatrolDutyShift, PatrolScheduleLike, PatrolWindow } from './patrol-window.service';
import { runCoverageKey, windowsBetween } from './patrol-window.service';
import { effectiveShiftRequirement, setupActive, shiftAnchoredWindows, shiftScopeKey, type PatrolSiteSetup } from './patrol-shift-windows';

/**
 * Patrol Monitor read model (S4 Patrol Monitor S1, owner-approved 2 Nov 2026). PURE: no database, no clock, no Nest.
 *
 * The Monitor is a VIEW of what the existing engines and the sweep already decide; it never judges anything itself:
 *   windows       the P1-B clock engine (windowsBetween, site-local wall-clock slots, DST-safe) and the 1.3.0 shift-anchored
 *                 engine (shiftAnchoredWindows), with schedule-version bounds, exactly as the sweep and the Guard plan;
 *   duty          OperationalWindowService.isApplicable over the shifts the sweep reads (status in_progress / completed,
 *                 effective Book On → Book Off or the shift end);
 *   coverage      runCoverageKey (schedule, window key, scope, the window's actual start);
 *   verified      ONLY patrol_runs.verificationStatus = 'verified', written by the sweep;
 *   missed        ONLY a patrol_missed exception raised by the sweep (the sweep stays the authority);
 *   judged        the sweep's watermark (patrol_sweep_watermarks.judgedThrough): every window whose start deadline is at or
 *                 before it has been judged, so a passed window with no run and no exception is shown as "awaiting check"
 *                 before the watermark and "not judged" (nothing was owed for it) after.
 *
 * Window states, first match wins (owner-approved table):
 *   covering run R    R in progress, before its completion deadline           in_progress
 *                     R in progress past it, or incomplete / closed_by_system  incomplete
 *                     R completed, verification flagged                       flagged
 *                     R completed, verification unverified                    not_verified
 *                     R completed, verification verified, late start          late_verified   (amber "Late · Verified")
 *                     R completed, verification verified                      verified        (the ONLY green)
 *                     R completed, verification pending                       awaiting_verification
 *   no covering run   a patrol_missed exception for (window key, scope)        missed
 *                     now < start                                             future (when a shift is scheduled for it)
 *                     no Guard on duty for it (as the sweep reads duty)       not_on_duty (when a shift was scheduled)
 *                     start ≤ now < end                                       due
 *                     end ≤ now < end + start grace                           overdue
 *                     start deadline passed, watermark not yet past it        awaiting_check
 *                     start deadline passed and judged, nothing raised        not_judged
 */

export const MONITOR_WINDOW_STATES = [
  'missed', 'incomplete', 'flagged', 'not_verified', 'overdue', 'late_verified', 'awaiting_check', 'awaiting_verification',
  'in_progress', 'due', 'verified', 'not_judged', 'not_on_duty', 'future',
] as const;
/** Ordered most severe first: an hour cell with several windows shows the most severe. */
export type MonitorWindowState = (typeof MONITOR_WINDOW_STATES)[number];
/** Hour-cell states with no window: none (no window this hour), not_required (on duty, no patrol owed), off_duty. */
export type MonitorCellState = MonitorWindowState | 'none' | 'not_required' | 'off_duty';
export type MonitorSiteStatus = 'attention' | 'watch' | 'on_track' | 'not_started' | 'no_patrols';

const SEVERITY = new Map<string, number>(MONITOR_WINDOW_STATES.map((s, i) => [s, i]));
export function worstState(states: readonly MonitorWindowState[]): MonitorWindowState | null {
  let worst: MonitorWindowState | null = null;
  for (const s of states) if (worst === null || SEVERITY.get(s)! < SEVERITY.get(worst)!) worst = s;
  return worst;
}

/** States that count as "owed so far" in an hour cell's x/y (a window that is not yet due, or was never owed, does not). */
const OWED = new Set<MonitorWindowState>([
  'missed', 'incomplete', 'flagged', 'not_verified', 'overdue', 'late_verified', 'awaiting_check', 'awaiting_verification',
  'in_progress', 'due', 'verified',
]);
export const isOwed = (s: MonitorWindowState) => OWED.has(s);
/** Server-verified, on time or late: the x of an hour cell's x/y. */
export const isVerified = (s: MonitorWindowState) => s === 'verified' || s === 'late_verified';

export type MonitorPolicy = {
  startGraceMinutes: number;
  maxPatrolDurationMinutes: number;
  completionGraceMinutes: number;
  syncGraceMinutes: number;
  requirementScope: 'site' | 'per_guard';
  methods: readonly string[];
  photosPerRun: number;
  photosPerCheckpoint: number;
};

export type MonitorRun = {
  id: number;
  siteId: number;
  routeId: number | null;
  scheduleId: number | null;
  windowKey: string | null;
  scopeKey: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  status: string;
  verificationStatus: string;
  lateStart: boolean;
  startedAtDevice: Date;
  startedAtServer: Date;
  completedAtServer: Date | null;
  guardId: number;
  shiftId: number;
  syncFlags: string[];
};

export type MonitorException = {
  id: number;
  type: string;
  status: string;
  windowKey: string | null;
  scopeKey: string | null;
  runId: number | null;
  safetyAlertId: number | null;
  alertStatus: string | null;
};

export type MonitorShift = {
  id: number;
  guardId: number | null;
  status: string;
  start: Date;
  end: Date;
  patrolRequirement: string | null;
  /** Effective attendance (effectiveAttendance): monitoredFrom, Book On and Book Off. */
  monitoredFrom: Date | null;
  bookOnAt: Date | null;
  bookOffAt: Date | null;
};

/**
 * Shift statuses that put nobody on a site (a lane is never drawn for them). Every other status gets a lane: unfilled /
 * offered / ready (future windows), in_progress / completed (duty, as the sweep reads it), missed (shown as not on duty).
 */
export const MONITOR_EXCLUDED_SHIFT_STATUSES = ['cancelled', 'rejected'];
/** The statuses the sweep reads duty from (patrol-sweep.service.ts judgeWindows). */
const DUTY_STATUSES = new Set(['in_progress', 'completed']);

const operational = new OperationalWindowService();

export function dutyOf(shift: MonitorShift): PatrolDutyShift | null {
  if (!DUTY_STATUSES.has(shift.status)) return null;
  return {
    shiftId: shift.id,
    guardId: shift.guardId,
    applicability: { bookOnAt: shift.monitoredFrom, bookOffAt: shift.bookOffAt, shiftEnd: shift.end, cancelled: false },
  };
}

function onDuty(window: { slotIndex: number; start: Date; end: Date }, duty: PatrolDutyShift | null): boolean {
  if (!duty) return false;
  return operational.isApplicable({ index: window.slotIndex, start: window.start, end: window.end }, duty.applicability);
}

const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();

export type WindowStateInput = {
  now: Date;
  window: { start: Date; end: Date };
  policy: Pick<MonitorPolicy, 'startGraceMinutes' | 'maxPatrolDurationMinutes' | 'completionGraceMinutes'>;
  run: Pick<MonitorRun, 'status' | 'verificationStatus' | 'lateStart' | 'startedAtDevice' | 'windowEnd'> | null;
  missed: boolean;
  /** A shift is scheduled across the window (it may become owed). */
  expected: boolean;
  /** A Guard was on duty for it, as the sweep reads duty. */
  onDuty: boolean;
  judgedThrough: Date | null;
};

/** THE window state (the table above). Null: the window is not shown (nobody was ever scheduled for it). */
export function monitorWindowState(input: WindowStateInput): MonitorWindowState | null {
  const { now, window, policy, run } = input;
  const t = now.getTime();
  if (run) {
    if (run.status === 'in_progress') {
      const deadline = completionDeadline(new Date(run.startedAtDevice), run.windowEnd ? new Date(run.windowEnd) : null, policy);
      return t < deadline.getTime() ? 'in_progress' : 'incomplete';
    }
    if (run.status === 'incomplete' || run.status === 'closed_by_system') return 'incomplete';
    if (run.verificationStatus === 'flagged') return 'flagged';
    if (run.verificationStatus === 'unverified') return 'not_verified';
    if (run.verificationStatus === 'verified') return run.lateStart ? 'late_verified' : 'verified';
    return 'awaiting_verification';
  }
  if (input.missed) return 'missed';
  if (t < window.start.getTime()) return input.expected || input.onDuty ? 'future' : null;
  if (!input.onDuty) return input.expected ? 'not_on_duty' : null;
  if (t < window.end.getTime()) return 'due';
  const deadline = startDeadline(window.end, policy.startGraceMinutes);
  if (t < deadline.getTime()) return 'overdue';
  if (!input.judgedThrough || input.judgedThrough.getTime() < deadline.getTime()) return 'awaiting_check';
  return 'not_judged';
}

// ─── Hours ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type MonitorHour = {
  index: number;
  start: string;
  end: string;
  /** Site-local hour "HH". */
  label: string;
  /** The site's UTC offset in that hour, e.g. "GMT+1". */
  offset: string;
  /** The second of two hours with the same label (the repeated autumn hour). */
  repeated: boolean;
  /** The hour containing `now`. */
  current: boolean;
};

const hourFormatters = new Map<string, Intl.DateTimeFormat>();
function hourParts(at: Date, timeZone: string): { hour: string; minute: string; offset: string } {
  let f = hourFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });
    hourFormatters.set(timeZone, f);
  }
  const parts = f.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { hour: get('hour'), minute: get('minute'), offset: get('timeZoneName') };
}

const QUARTER = 15 * 60_000;
/** The site-local hour at or before `at` (zones offset by a quarter hour included). */
export function floorToLocalHour(at: Date, timeZone: string): Date {
  let t = Math.floor(at.getTime() / QUARTER) * QUARTER;
  for (let i = 0; i < 8; i += 1, t -= QUARTER) if (hourParts(new Date(t), timeZone).minute === '00') return new Date(t);
  return new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000);
}

/**
 * The site-local hours of [from, to): boundaries are the instants whose local minute is 00, so a spring-forward day has
 * 23 hours and an autumn day 25, the repeated hour labelled twice (with its own offset). `from` should be a local hour.
 */
export function monitorHours(from: Date, to: Date, timeZone: string, now: Date): MonitorHour[] {
  const bounds: number[] = [from.getTime()];
  for (let t = Math.floor(from.getTime() / QUARTER) * QUARTER + QUARTER; t < to.getTime(); t += QUARTER) {
    if (t > bounds[bounds.length - 1] && hourParts(new Date(t), timeZone).minute === '00') bounds.push(t);
  }
  bounds.push(to.getTime());
  const hours: MonitorHour[] = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const start = new Date(bounds[i]);
    const p = hourParts(start, timeZone);
    hours.push({
      index: i,
      start: start.toISOString(),
      end: new Date(bounds[i + 1]).toISOString(),
      label: p.hour,
      offset: p.offset,
      repeated: hours.some((h) => h.label === p.hour),
      current: now.getTime() >= bounds[i] && now.getTime() < bounds[i + 1],
    });
  }
  return hours;
}

// ─── Lanes ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type MonitorWindow = {
  key: string;
  scheduleId: number;
  windowKey: string;
  scopeKey: string;
  anchor: 'clock' | 'shift';
  start: string;
  end: string;
  startDeadline: string;
  state: MonitorWindowState;
  runId: number | null;
  /** Who started the covering run (site-wide windows: the Guard who actually did it). */
  runGuardId: number | null;
  lateStart: boolean;
  /** Completed, still awaiting verification after its sync deadline (a processing delay worth a look). */
  verificationOverdue: boolean;
  /** The patrol_missed exception of the window (none when it was covered or not missed). */
  exceptionId: number | null;
  exceptionStatus: string | null;
  /** Every exception of the window or its run (missed, abandoned, incomplete, checkpoint missed, unverified). */
  exceptionIds: number[];
  alertId: number | null;
  alertStatus: string | null;
  /**
   * S4 patrol assignment correctness: ad-hoc patrols (not linked to any window) of this window's lane started while it was
   * open. Shown so a controller sees why the window is still owed; they never cover or count towards it.
   */
  adHocRunIds: number[];
};

export type MonitorCell = {
  hour: number;
  state: MonitorCellState;
  /** Windows starting in the hour. */
  total: number;
  /** Of them, owed so far (excludes future, not on duty, not judged). */
  owed: number;
  /** Of them, server-verified (on time or late). */
  verified: number;
  /** Of them, not yet due (state future): the cell reads verified/owed and, apart, how many come later. */
  later: number;
  windowKeys: string[];
  /** Ad-hoc patrols of this lane started in the hour: shown in the cell's detail, never counted. */
  adHoc: number;
};

export type MonitorLane = {
  key: string;
  kind: 'site' | 'shift';
  /** shift lanes */
  shiftId: number | null;
  guardId: number | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  shiftStatus: string | null;
  /** shift lanes: whether this shift owes shift-based patrols and why (the Rota Planner Patrol Requirement view). */
  requirement: { effectiveRequired: boolean; value: string; source: string; summary: string } | null;
  windows: MonitorWindow[];
  cells: MonitorCell[];
};

export type MonitorSiteInput = {
  now: Date;
  from: Date;
  to: Date;
  timeZone: string;
  policy: MonitorPolicy;
  setup: PatrolSiteSetup;
  /** Clock schedules of the site (active, plus versions replaced after `from`), with version bounds. */
  clockSchedules: PatrolScheduleLike[];
  /** Shift-anchored schedule versions of the site (only read when the setup is active), with version bounds. */
  shiftSchedules: PatrolScheduleLike[];
  shifts: MonitorShift[];
  runs: MonitorRun[];
  exceptions: MonitorException[];
  judgedThrough: Date | null;
  /**
   * The wall-clock conversions already made in this request for THIS time zone (windowsBetween's cache, keyed by date and
   * minute only, so never shared between zones). Given: each clock schedule's windows are computed once for the site and
   * shared by its lanes. Omitted: every lane computes its own (the original path, kept as the equivalence reference).
   */
  conversionCache?: Map<string, number>;
};

export type MonitorSiteModel = {
  hours: MonitorHour[];
  lanes: MonitorLane[];
  /**
   * Runs at the site in the range that satisfy no window shown (unscheduled, already covered, or unmatched): listed, never
   * counted as patrols, but their exceptions count like any other.
   */
  /**
   * Runs that satisfy no window shown. S4 patrol assignment correctness: each is placed in a lane (its own shift's lane,
   * else the site lane) and the site-local hour its device start falls in, with why it is not linked (`explanation`).
   */
  otherRuns: Array<{
    runId: number;
    reason: 'unscheduled' | 'window_already_covered' | 'unmatched';
    exceptionIds: number[];
    laneKey: string | null;
    hour: number | null;
    startedAt: string;
    explanation: 'ad_hoc' | 'ambiguous' | 'route_not_shown' | 'already_covered' | 'unmatched';
  }>;
  counts: MonitorCounts;
  status: MonitorSiteStatus;
  nextWindowStart: string | null;
};

export type MonitorCounts = {
  windows: number;
  owed: number;
  verified: number;
  verifiedOnTime: number;
  lateVerified: number;
  inProgress: number;
  awaitingVerification: number;
  missed: number;
  missedOpen: number;
  incomplete: number;
  flagged: number;
  notVerified: number;
  overdue: number;
  due: number;
  awaitingCheck: number;
  future: number;
  /** Completed patrols still awaiting verification after their sync deadline. */
  verificationOverdue: number;
  /** Unresolved exceptions (open or acknowledged) of the windows and runs in the range. */
  openExceptions: number;
  /** Their linked safety alerts that are not closed (each exception has at most one; never counted twice). */
  openAlerts: number;
};

const SITE_SCOPE = 'site';

/** The whole model of one site over [from, to). */
export function buildSiteModel(input: MonitorSiteInput): MonitorSiteModel {
  const { now, from, to, timeZone, policy, setup } = input;
  const runsByCoverage = new Map<string, MonitorRun>();
  for (const r of input.runs) {
    if (r.scheduleId == null || r.windowKey == null) continue;
    runsByCoverage.set(runCoverageKey(r.scheduleId, r.windowKey, r.scopeKey ?? SITE_SCOPE, r.windowStart), r);
  }
  const missedByWindow = new Map<string, MonitorException>();
  const exceptionsByWindow = new Map<string, MonitorException[]>();
  const exceptionsByRun = new Map<number, MonitorException[]>();
  for (const e of input.exceptions) {
    const wk = `${e.windowKey}|${e.scopeKey ?? SITE_SCOPE}`;
    if (e.type === 'patrol_missed') missedByWindow.set(wk, e);
    exceptionsByWindow.set(wk, [...(exceptionsByWindow.get(wk) ?? []), e]);
    if (e.runId != null) exceptionsByRun.set(e.runId, [...(exceptionsByRun.get(e.runId) ?? []), e]);
  }
  const lanesShifts = input.shifts
    .filter((s) => !MONITOR_EXCLUDED_SHIFT_STATUSES.includes(s.status) && overlaps(s.start, s.end, from, to))
    .sort((a, b) => a.start.getTime() - b.start.getTime() || a.id - b.id);
  const duties = lanesShifts.map(dutyOf).filter((d): d is PatrolDutyShift => d !== null);
  const usedRuns = new Set<number>();
  const inRange = (w: { start: Date }) => w.start.getTime() >= from.getTime() && w.start.getTime() < to.getTime();

  const toWindow = (w: PatrolWindow, scopeKey: string, anchor: 'clock' | 'shift', expected: boolean, dutyNow: boolean): MonitorWindow | null => {
    const run = runsByCoverage.get(runCoverageKey(w.scheduleId, w.windowKey, scopeKey, w.start)) ?? null;
    const missed = missedByWindow.get(`${w.windowKey}|${scopeKey}`) ?? null;
    const state = monitorWindowState({ now, window: w, policy, run, missed: missed !== null, expected, onDuty: dutyNow, judgedThrough: input.judgedThrough });
    if (state === null) return null;
    if (run) usedRuns.add(run.id);
    const related = [...(exceptionsByWindow.get(`${w.windowKey}|${scopeKey}`) ?? []), ...(run ? exceptionsByRun.get(run.id) ?? [] : [])];
    const exceptionIds = [...new Set(related.map((e) => e.id))].sort((a, b) => a - b);
    const alerted = related.find((e) => e.safetyAlertId != null && e.alertStatus !== 'closed') ?? related.find((e) => e.safetyAlertId != null) ?? null;
    let verificationOverdue = false;
    if (state === 'awaiting_verification' && run) {
      const sync = syncDeadline(completionDeadline(new Date(run.startedAtDevice), run.windowEnd ? new Date(run.windowEnd) : null, policy), policy.syncGraceMinutes);
      verificationOverdue = now.getTime() >= sync.getTime();
    }
    return {
      key: `${w.windowKey}|${scopeKey}`,
      scheduleId: w.scheduleId,
      windowKey: w.windowKey,
      scopeKey,
      anchor,
      start: w.start.toISOString(),
      end: w.end.toISOString(),
      startDeadline: startDeadline(w.end, policy.startGraceMinutes).toISOString(),
      state,
      runId: run?.id ?? null,
      runGuardId: run?.guardId ?? null,
      lateStart: run?.lateStart === true,
      verificationOverdue,
      exceptionId: missed?.id ?? null,
      exceptionStatus: missed?.status ?? null,
      exceptionIds,
      alertId: alerted?.safetyAlertId ?? null,
      alertStatus: alerted?.alertStatus ?? null,
      adHocRunIds: [],
    };
  };

  const lanes: MonitorLane[] = [];
  // A clock schedule's windows in the range: computed once per site and schedule version when the request shares its
  // conversion cache; each lane still applies its own shift overlap, duty and scope, so no lane sees another's runs.
  const clockMemo = new Map<PatrolScheduleLike, PatrolWindow[]>();
  const clockWindows = (schedule: PatrolScheduleLike): PatrolWindow[] => {
    if (!input.conversionCache) return windowsBetween(schedule, timeZone, from, to).filter(inRange);
    let windows = clockMemo.get(schedule);
    if (!windows) {
      windows = windowsBetween(schedule, timeZone, from, to, input.conversionCache).filter(inRange);
      clockMemo.set(schedule, windows);
    }
    return windows;
  };

  // Site-wide obligations: ONE shared "Site patrol" lane (never assigned to a Guard; the run says who did it).
  if (policy.requirementScope === 'site' && input.clockSchedules.length) {
    const windows: MonitorWindow[] = [];
    for (const schedule of input.clockSchedules) {
      for (const w of clockWindows(schedule)) {
        const expected = lanesShifts.some((s) => overlaps(s.start, s.end, w.start, w.end));
        const dutyNow = duties.some((d) => onDuty(w, d));
        const mw = toWindow(w, SITE_SCOPE, 'clock', expected, dutyNow);
        if (mw) windows.push(mw);
      }
    }
    lanes.push(lane({ key: 'site', kind: 'site', shiftId: null, guardId: null, shiftStart: null, shiftEnd: null, shiftStatus: null, requirement: null, windows }));
  }

  // Per-guard obligations: one lane per shift (patrol assignment).
  const shiftBased = setupActive(setup) && input.shiftSchedules.length > 0;
  const perGuardClock = policy.requirementScope === 'per_guard' && input.clockSchedules.length > 0;
  if (shiftBased || perGuardClock) {
    for (const shift of lanesShifts) {
      const duty = dutyOf(shift);
      const scope = shiftScopeKey(shift.id);
      const windows: MonitorWindow[] = [];
      if (perGuardClock) {
        for (const schedule of input.clockSchedules) {
          for (const w of clockWindows(schedule)) {
            if (!overlaps(shift.start, shift.end, w.start, w.end)) continue;
            const mw = toWindow(w, scope, 'clock', true, onDuty(w, duty));
            if (mw) windows.push(mw);
          }
        }
      }
      let requirement: MonitorLane['requirement'] = null;
      if (shiftBased) {
        requirement = effectiveShiftRequirement(shift.patrolRequirement, setup);
        if (requirement.effectiveRequired) {
          for (const schedule of input.shiftSchedules) {
            for (const w of shiftAnchoredWindows(schedule, shift, setup.windowAnchor, shift.bookOnAt, timeZone)) {
              if (!inRange(w)) continue;
              const mw = toWindow(w, scope, 'shift', true, onDuty(w, duty));
              if (mw) windows.push(mw);
            }
          }
        }
      }
      windows.sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
      lanes.push(lane({
        key: `shift:${shift.id}`, kind: 'shift', shiftId: shift.id, guardId: shift.guardId,
        shiftStart: shift.start.toISOString(), shiftEnd: shift.end.toISOString(), shiftStatus: shift.status, requirement, windows,
      }));
    }
  }

  const hours = monitorHours(from, to, timeZone, now);
  for (const l of lanes) {
    l.windows.sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
    l.cells = cellsFor(l, hours, lanesShifts);
  }

  const otherRuns: MonitorSiteModel['otherRuns'] = [];
  for (const r of input.runs) {
    if (usedRuns.has(r.id)) continue;
    const reason = r.syncFlags.includes('window_already_covered') ? 'window_already_covered' : r.windowKey == null ? 'unscheduled' : 'unmatched';
    const started = r.startedAtDevice ?? r.startedAtServer;
    const at = started.getTime();
    const home = lanes.find((l) => l.kind === 'shift' && l.shiftId === r.shiftId) ?? lanes.find((l) => l.kind === 'site') ?? null;
    const hour = hours.find((h) => new Date(h.start).getTime() <= at && at < new Date(h.end).getTime()) ?? null;
    if (home) {
      for (const w of home.windows) {
        if (w.runId == null && new Date(w.start).getTime() <= at && at < new Date(w.end).getTime()) w.adHocRunIds.push(r.id);
      }
      const cell = hour ? home.cells.find((c) => c.hour === hour.index) : null;
      if (cell) cell.adHoc += 1;
    }
    otherRuns.push({
      runId: r.id,
      reason,
      exceptionIds: (exceptionsByRun.get(r.id) ?? []).map((e) => e.id).sort((a, b) => a - b),
      laneKey: home?.key ?? null,
      hour: hour?.index ?? null,
      startedAt: started.toISOString(),
      explanation: reason === 'window_already_covered' ? 'already_covered' : reason === 'unmatched' ? 'unmatched'
        : r.syncFlags.includes('window_match_ambiguous') ? 'ambiguous'
        : r.syncFlags.includes('window_match_needs_route') ? 'route_not_shown' : 'ad_hoc',
    });
  }

  const all = lanes.flatMap((l) => l.windows);
  const counts = countsOf(all, input.exceptions, otherRuns.flatMap((o) => o.exceptionIds));
  return { hours, lanes, otherRuns, counts, status: siteStatus(counts), nextWindowStart: all.filter((w) => w.state === 'future').map((w) => w.start).sort()[0] ?? null };
}

function lane(l: Omit<MonitorLane, 'cells'>): MonitorLane {
  return { ...l, cells: [] };
}

function cellsFor(l: MonitorLane, hours: MonitorHour[], shifts: MonitorShift[]): MonitorCell[] {
  const shift = l.shiftId == null ? null : shifts.find((s) => s.id === l.shiftId) ?? null;
  return hours.map((h) => {
    const hs = new Date(h.start);
    const he = new Date(h.end);
    const ws = l.windows.filter((w) => w.start >= h.start && w.start < h.end);
    if (ws.length) {
      const states = ws.map((w) => w.state);
      return {
        hour: h.index, state: worstState(states)!, total: ws.length, owed: states.filter(isOwed).length,
        verified: states.filter(isVerified).length, later: states.filter((x) => x === 'future').length, windowKeys: ws.map((w) => w.key), adHoc: 0,
      };
    }
    let state: MonitorCellState = 'none';
    if (shift) {
      if (!overlaps(shift.start, shift.end, hs, he)) state = 'off_duty';
      else if (l.requirement && !l.requirement.effectiveRequired && !l.windows.length) state = 'not_required';
    }
    return { hour: h.index, state, total: 0, owed: 0, verified: 0, later: 0, windowKeys: [], adHoc: 0 };
  });
}

/** Counts of the windows shown; exceptions of those windows and runs, plus `otherExceptionIds` (the other patrols'). */
export function countsOf(windows: MonitorWindow[], exceptions: MonitorException[], otherExceptionIds: number[] = []): MonitorCounts {
  const n = (s: MonitorWindowState) => windows.filter((w) => w.state === s).length;
  const shownExceptionIds = new Set([...windows.flatMap((w) => w.exceptionIds), ...otherExceptionIds]);
  const open = exceptions.filter((e) => shownExceptionIds.has(e.id) && e.status !== 'resolved');
  return {
    windows: windows.length,
    owed: windows.filter((w) => isOwed(w.state)).length,
    verified: windows.filter((w) => isVerified(w.state)).length,
    verifiedOnTime: n('verified'),
    lateVerified: n('late_verified'),
    inProgress: n('in_progress'),
    awaitingVerification: n('awaiting_verification'),
    missed: n('missed'),
    missedOpen: windows.filter((w) => w.state === 'missed' && w.exceptionStatus !== 'resolved').length,
    incomplete: n('incomplete'),
    flagged: n('flagged'),
    notVerified: n('not_verified'),
    overdue: n('overdue'),
    due: n('due'),
    awaitingCheck: n('awaiting_check'),
    future: n('future'),
    verificationOverdue: windows.filter((w) => w.verificationOverdue).length,
    openExceptions: open.length,
    // An exception and its alert are ONE item: count each linked alert once, only when not closed.
    openAlerts: new Set(open.filter((e) => e.safetyAlertId != null && e.alertStatus !== 'closed').map((e) => e.safetyAlertId)).size,
  };
}

/**
 * The site's status (owner: never "on track" merely because nothing is due yet):
 *   attention    a window overdue now, or an unresolved exception (open or acknowledged) in the range
 *   watch        a late, flagged, not-verified or awaiting-check window, or verification still pending past its sync deadline
 *   on_track     at least one owed window has started and none of the above
 *   not_started  windows are still to come but none is owed yet
 *   no_patrols   no window in the range
 * Resolved exceptions are history: shown in the counts, never the status.
 */
export function siteStatus(c: MonitorCounts): MonitorSiteStatus {
  if (c.overdue > 0 || c.openExceptions > 0) return 'attention';
  if (c.lateVerified + c.flagged + c.notVerified + c.awaitingCheck + c.verificationOverdue > 0) return 'watch';
  if (c.owed > 0) return 'on_track';
  if (c.windows > 0) return 'not_started';
  return 'no_patrols';
}

/** Re-export so callers read the scope of a shift lane the same way. */
export { shiftScopeKey };
