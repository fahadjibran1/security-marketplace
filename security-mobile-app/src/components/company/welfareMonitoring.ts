// Live welfare monitoring: how a shift's Welfare windows read on the board and in the shift drawer.
// (S4 Welfare & Reporting Remediation, Phase 2.)
//
// THE DEFECTS THIS FIXES
// 1. The board read each shift's windows from the coverage list for "today", which only covers shifts that
//    START on today's UK date and are still operational. A live overnight shift lost every marker at
//    midnight, a booked-off or reconciled shift lost them on completion, and a historical day had none.
//    The board now names the shifts it can show (`operationsShiftIds`) and asks for exactly those.
// 2. The drawer listed every missed-check row as "Missed Checkcall (Closed)". Most of those are permanent
//    history records the sweep writes closed — nobody closed anything — so a controller read "Closed" as
//    "someone dealt with it". History and alerts are now told apart, and an alert says who closed it.
//
// Nothing here decides a window's state. The engine publishes the grid and each verdict; this module only
// words them, and splits the engine's "due" into Upcoming (not started yet) and Due (running now), which
// is a reading of the clock, not a recalculation.
//
// Pure: no request, no write, no clock of its own.

import type { OperationalWindowView, SafetyAlert, ShiftOperationsView, WelfareWindowAlertView } from '../../types/models';
import { formatInstantTime, formatUkDate } from '../../services/siteTime';

export type WelfareDisplayState =
  | 'upcoming'
  | 'due'
  | 'overdue'
  | 'completed'
  | 'missed'
  | 'ended_at_book_off'
  | 'not_applicable';

/** Never colour alone: every state has a word, and the timeline adds a glyph. */
export const WELFARE_DISPLAY_WORD: Record<WelfareDisplayState, string> = {
  upcoming: 'Upcoming',
  due: 'Due',
  overdue: 'Overdue',
  completed: 'Completed',
  missed: 'Missed',
  ended_at_book_off: 'Ended at Book Off',
  not_applicable: 'Not required',
};

/**
 * The display state for one published window.
 *
 * The engine calls every window it cannot yet judge "due"; one that has not started is Upcoming. Before
 * Book On the engine owes nothing ("not required"), but a future window of a shift that is still to be
 * worked is simply ahead of us, so it also reads as Upcoming — never as "Not required". An unknown value (a
 * newer backend) reads as Not required rather than as anything alarming or reassuring.
 */
export function welfareDisplayState(
  window: Pick<OperationalWindowView, 'state' | 'start'>,
  nowMs: number,
  context: { awaitingBookOn?: boolean } = {},
): WelfareDisplayState {
  const state = window.state;
  const ahead = Date.parse(window.start) > nowMs;
  if (state === 'due') return ahead ? 'upcoming' : 'due';
  if (state === 'not_applicable' && ahead && context.awaitingBookOn) return 'upcoming';
  if (state === 'completed' || state === 'missed' || state === 'overdue' || state === 'ended_at_book_off') return state;
  return 'not_applicable';
}

/** "Alert #29006 · Open", "· Acknowledged", "· Resolved (Guard confirmed safe)", "· Closed automatically (previous rule)". */
export function welfareAlertWord(alert: WelfareWindowAlertView | null | undefined): string | null {
  if (!alert) return null;
  const head = `Alert #${alert.id}`;
  if (alert.status === 'open') return `${head} · Open`;
  if (alert.status === 'acknowledged') return `${head} · Acknowledged`;
  if (alert.closedBySystem) return `${head} · Closed automatically (previous rule)`;
  return alert.resolutionReason ? `${head} · Resolved (${humanise(alert.resolutionReason)})` : `${head} · Resolved`;
}

export type WelfareWindowRow = {
  key: string;
  /** "21:00–22:00" on the site's clock. */
  window: string;
  /** DD-MM-YYYY of the window's start, on the site's clock: an overnight shift spans two dates. */
  date: string;
  state: WelfareDisplayState;
  stateWord: string;
  /** The recorded Welfare Check time that met the window, on the site's clock, or null. */
  checkedAt: string | null;
  /** When the sweep recorded the miss, or null. */
  missRecordedAt: string | null;
  /** The alert that carried the miss, worded; "No alert raised" for a recorded miss with none. */
  alert: string | null;
};

/**
 * One row per published window, for the shift drawer. Empty when the shift carries no Welfare obligation
 * or the projection was not loaded — never invented.
 */
export function welfareWindowRows(
  operations: ShiftOperationsView | null | undefined,
  context: { nowMs: number; timeZone: string; shiftStatus?: string | null },
): WelfareWindowRow[] {
  const windows = operations?.welfare?.windows ?? [];
  const awaitingBookOn = isAwaitingBookOn(operations?.bookOnAt ?? null, context.shiftStatus);
  return windows.map((w) => {
    const state = welfareDisplayState(w, context.nowMs, { awaitingBookOn });
    const recorded = w.missRecordedAt ?? null;
    return {
      key: String(w.index),
      window: `${formatInstantTime(w.start, context.timeZone)}–${formatInstantTime(w.end, context.timeZone)}`,
      date: formatUkDate(w.start, context.timeZone),
      state,
      stateWord: WELFARE_DISPLAY_WORD[state],
      checkedAt: w.completedAt ? formatInstantTime(w.completedAt, context.timeZone) : null,
      missRecordedAt: recorded ? formatInstantTime(recorded, context.timeZone) : null,
      alert: welfareAlertWord(w.alert) ?? (recorded ? 'No alert raised' : null),
    };
  });
}

/**
 * "Welfare Check every 60 min" from the interval the backend actually applied — the shift's own value,
 * else the site's, else 60 — rather than the shift's column alone, which ignored the site default.
 */
export function welfareIntervalLabel(
  operations: ShiftOperationsView | null | undefined,
  shift: { checkCallIntervalMinutes?: number | null },
): string {
  const minutes = operations?.welfare?.intervalMinutes ?? shift.checkCallIntervalMinutes ?? 60;
  return `Welfare Check every ${minutes} min`;
}

/**
 * How one safety alert reads in the shift drawer.
 *
 * A per-window missed Welfare Check row is permanent history, written closed by the sweep: it is labelled
 * as a record, never as "Closed". The shift's welfare alert, and every other alert, says whether it is
 * open, acknowledged, resolved by a person, or closed by the previous automatic rule.
 */
export function safetyAlertDrawerLabel(alert: Pick<SafetyAlert, 'type' | 'status' | 'message' | 'welfareWindowIndex' | 'closedByUserId' | 'resolutionReason'>): string {
  if (alert.type === 'missed_checkcall' && alert.welfareWindowIndex != null) {
    return `${alert.message || 'Welfare Check missed'} · history record`;
  }
  const name = alert.type === 'missed_checkcall' ? 'Missed Welfare Check alert' : humanise(alert.type);
  if (alert.status === 'open') return `${name} · Open`;
  if (alert.status === 'acknowledged') return `${name} · Acknowledged`;
  if (alert.closedByUserId == null) {
    return alert.type === 'missed_checkcall' ? `${name} · Closed automatically (previous rule)` : `${name} · Closed automatically`;
  }
  return alert.resolutionReason ? `${name} · Resolved (${humanise(alert.resolutionReason)})` : `${name} · Resolved`;
}

/** The most shifts one monitoring request may name; the backend refuses more. */
export const OPERATIONS_MAX_SHIFT_IDS = 200;

/**
 * Which shifts Live Operations needs welfare monitoring for: a cheap superset of what the board can show.
 *
 *   every shift still in progress     live, overnight, or awaiting reconciliation however old
 *   any shift near the selected day   starting from 36 h before that day to the end of it — covers
 *                                     yesterday's overnight shifts, completed, booked-off and reconciled
 *                                     ones; the live view uses today
 *
 * Nearest the selected day first, capped, so a very long shift history never builds an oversized request.
 */
export function operationsShiftIds(
  shifts: ReadonlyArray<{ id: number; start: string; end: string; status?: string | null }>,
  context: { dayStartMs: number; dayEndMs: number },
): number[] {
  const from = context.dayStartMs - 36 * 3_600_000;
  const picked: Array<{ id: number; distance: number }> = [];
  for (const shift of shifts) {
    const startMs = Date.parse(shift.start);
    const endMs = Date.parse(shift.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    const status = (shift.status || '').trim().toLowerCase();
    if (status === 'cancelled') continue;
    const nearDay = startMs < context.dayEndMs && endMs > from;
    if (status !== 'in_progress' && !nearDay) continue;
    picked.push({ id: shift.id, distance: Math.abs(startMs - context.dayStartMs) });
  }
  picked.sort((a, b) => a.distance - b.distance || a.id - b.id);
  return picked.slice(0, OPERATIONS_MAX_SHIFT_IDS).map((entry) => entry.id).sort((a, b) => a - b);
}

/** Not booked on, and still to be worked: not cancelled, completed or marked missed. */
export function isAwaitingBookOn(bookOnAt: string | null | undefined, shiftStatus: string | null | undefined): boolean {
  if (bookOnAt) return false;
  const status = (shiftStatus || '').trim().toLowerCase();
  return !['cancelled', 'completed', 'missed', 'rejected'].includes(status);
}

function humanise(value: string): string {
  const words = value.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}
