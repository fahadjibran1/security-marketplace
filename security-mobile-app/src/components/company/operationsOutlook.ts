// What a controller should be getting ready for. (Phase 4A.3.)
//
// Two questions, one dataset. Next Up answers "what happens in the next few minutes"; Upcoming Handovers
// answers "which sites change hands, and is the next guard actually arranged". Both read the SAME
// operational rows the timeline draws and the export writes — there is no second query, no scheduler and
// no clock of their own, because a rail that disagrees with the board beside it is worse than no rail.
//
// THREE RULES
//
// 1. NOTHING IS INVENTED. A handover names a replacement only when the data establishes exactly one
//    candidate. Two candidates, or none, and the panel says so instead of guessing — a controller who is
//    told cover exists when it does not is worse off than one who is told nothing.
//
// 2. NO WELFARE WINDOW IS COMPUTED HERE. The next Welfare deadline is read from the engine's published
//    grid, exactly as the timeline markers are.
//
// 3. NEAR-TERM ONLY, AND SHORT. Next Up is capped at five items inside the board's own upcoming horizon.
//    A rail that lists everything is a second schedule table, which is the thing the old Next 60 Min
//    panel already failed at.

import { UPCOMING_HORIZON_MINUTES } from './liveOperationsPolicy';
import { siteZoneOf, type TimelineShiftInput } from './operationsTimeline';
import { formatInstantTime } from '../../services/siteTime';

const MINUTE_MS = 60_000;

/** Five. A rail is read at a glance between two other things a controller is already doing. */
export const NEXT_UP_MAX = 5;

/**
 * How close in time a start must be to an end before the two are the same handover.
 *
 * An hour either side. A relief guard who books on half an hour early, and one whose shift starts half an
 * hour after the outgoing guard leaves, are both the same site changing hands; a shift starting three
 * hours later is simply the next shift.
 */
export const HANDOVER_PAIRING_MINUTES = 60;

/**
 * An operational row with the evidence the summaries need.
 *
 * It extends the timeline's own input rather than defining a parallel shape, so the rail cannot be handed
 * a different universe from the board.
 */
export type OutlookShiftInput = TimelineShiftInput & {
  logs?: readonly { logType?: string | null; createdAt?: string | null }[] | null;
  incidents?: readonly { status?: string | null }[] | null;
  alerts?: readonly { type?: string | null; status?: string | null }[] | null;
};

// ─── Next Up ──────────────────────────────────────────────────────────────────

export type NextUpKind = 'book_on_due' | 'shift_start' | 'shift_end' | 'welfare_due';

export type NextUpEvent = {
  id: string;
  /** The instant the event happens, epoch ms. Ordering is done on this, never on the label. */
  atMs: number;
  /** The instant on the SITE's clock, e.g. "21:35". */
  at: string;
  kind: NextUpKind;
  shiftId: number;
  siteName: string;
  guardName: string;
  /** One short line: what a controller has to be ready for. */
  label: string;
  timeZone: string;
};

const guardOf = (input: TimelineShiftInput) => input.shift.guard?.fullName || 'Unassigned';
const siteOf = (input: TimelineShiftInput) =>
  input.shift.site?.name || input.shift.siteName || 'Unknown site';

const SETTLED = ['completed', 'cancelled', 'missed', 'rejected'];
const isSettled = (input: TimelineShiftInput) =>
  SETTLED.includes((input.shift.status || '').trim().toLowerCase());

/**
 * The next Welfare deadline for a shift, or null.
 *
 * The first applicable window that is neither done nor already lost, and whose deadline has not passed.
 * An overdue or missed window is deliberately excluded: it is not something to prepare for, it is
 * something to act on, and Attention Now already holds it.
 */
function nextWelfareDeadline(input: TimelineShiftInput, nowMs: number): number | null {
  const windows = input.operations?.welfare?.windows ?? [];
  for (const w of windows) {
    if (w.applicable === false) continue;
    if (w.state === 'completed' || w.state === 'missed' || w.state === 'overdue') continue;
    const endMs = Date.parse(w.end);
    if (Number.isFinite(endMs) && endMs > nowMs) return endMs;
  }
  return null;
}

/**
 * The near-term operational events, in the order they will happen.
 *
 * Chronological, then by shift so two events at the same instant keep a stable order between refreshes —
 * a rail that reshuffles on every tick cannot be read.
 */
export function buildNextUp(
  inputs: readonly OutlookShiftInput[],
  nowMs: number,
  options?: { horizonMinutes?: number; limit?: number },
): NextUpEvent[] {
  const horizon = nowMs + (options?.horizonMinutes ?? UPCOMING_HORIZON_MINUTES) * MINUTE_MS;
  const limit = options?.limit ?? NEXT_UP_MAX;
  const events: NextUpEvent[] = [];

  const push = (
    input: OutlookShiftInput,
    kind: NextUpKind,
    atMs: number,
    label: (guard: string) => string,
  ) => {
    if (!Number.isFinite(atMs) || atMs <= nowMs || atMs > horizon) return;
    const timeZone = siteZoneOf(input);
    const guardName = guardOf(input);
    events.push({
      id: `${kind}-${input.shift.id}`,
      atMs,
      at: formatInstantTime(new Date(atMs).toISOString(), timeZone),
      kind,
      shiftId: input.shift.id,
      siteName: siteOf(input),
      guardName,
      label: label(guardName),
      timeZone,
    });
  };

  for (const input of inputs) {
    if (isSettled(input)) continue;

    const startMs = Date.parse(input.shift.start);
    const endMs = Date.parse(input.shift.end);
    const bookedOn = Boolean(input.attendance?.checkInAt);
    const bookedOff = Boolean(input.attendance?.checkOutAt);
    const assigned = Boolean(input.shift.guard?.fullName);

    if (!bookedOn) {
      // An assigned guard owes a Book On; an unassigned shift owes cover, which is a different problem.
      push(
        input,
        assigned ? 'book_on_due' : 'shift_start',
        startMs,
        (guard) => (assigned ? `${guard} — due to Book On` : 'Starts with no guard assigned'),
      );
    }

    if (!bookedOff) {
      push(input, 'shift_end', endMs, (guard) => `${guard} — shift ending`);
    }

    const welfareMs = nextWelfareDeadline(input, nowMs);
    if (welfareMs !== null) {
      push(input, 'welfare_due', welfareMs, (guard) => `${guard} — Welfare Check due`);
    }
  }

  events.sort((a, b) => a.atMs - b.atMs || a.shiftId - b.shiftId || a.kind.localeCompare(b.kind));
  return events.slice(0, limit);
}

// ─── Upcoming handovers ───────────────────────────────────────────────────────

/**
 * Whether the next guard is arranged.
 *
 * `unresolved` is not a failure of the panel — it is the honest answer when two shifts start near the
 * same end and nothing in the data says which one is the relief.
 */
export type HandoverReplacement = 'assigned' | 'none' | 'unresolved' | 'starting_only';

export type HandoverParty = {
  shiftId: number;
  guardName: string;
  /** The instant on the SITE's clock. */
  at: string;
  atMs: number;
};

export type Handover = {
  id: string;
  /** The instant the site changes hands — the end for a relief, the start for a fresh shift. */
  atMs: number;
  at: string;
  siteName: string;
  timeZone: string;
  ending: HandoverParty | null;
  starting: HandoverParty | null;
  replacement: HandoverReplacement;
  /** False when the starting shift has nobody on it — the panel must not print "Unassigned" as a name. */
  startingAssigned: boolean;
  /** The single line the panel prints under the parties. Never a guess. */
  note: string;
};

const partyOf = (input: OutlookShiftInput, atMs: number): HandoverParty => ({
  shiftId: input.shift.id,
  guardName: guardOf(input),
  at: formatInstantTime(new Date(atMs).toISOString(), siteZoneOf(input)),
  atMs,
});

const siteKeyOf = (input: OutlookShiftInput) => {
  const id = input.shift.site?.id ?? input.shift.siteId ?? null;
  return id === null ? `name:${siteOf(input)}` : `id:${id}`;
};

/**
 * The staffing transitions coming up, per site.
 *
 * A shift ending inside the horizon is matched against shifts starting at the SAME site within an hour
 * either side of that end. Exactly one candidate is a replacement. None means nobody is arranged, and the
 * panel says so — that is the whole reason this exists. More than one is `unresolved`: the relief is shown
 * as separate starting events rather than named wrongly.
 *
 * A start with no ending near it is still a transition worth anticipating, so it appears on its own.
 */
export function buildHandovers(
  inputs: readonly OutlookShiftInput[],
  nowMs: number,
  options?: { horizonMinutes?: number; limit?: number; pairingMinutes?: number },
): Handover[] {
  const horizonMs = nowMs + (options?.horizonMinutes ?? UPCOMING_HORIZON_MINUTES) * MINUTE_MS;
  const pairing = (options?.pairingMinutes ?? HANDOVER_PAIRING_MINUTES) * MINUTE_MS;
  const limit = options?.limit ?? NEXT_UP_MAX;

  const live = inputs.filter((input) => !isSettled(input));
  const inWindow = (ms: number) => Number.isFinite(ms) && ms > nowMs && ms <= horizonMs;

  const endings = live
    .filter((input) => !input.attendance?.checkOutAt && inWindow(Date.parse(input.shift.end)))
    .map((input) => ({ input, atMs: Date.parse(input.shift.end) }));

  const starts = live
    .filter((input) => inWindow(Date.parse(input.shift.start)))
    .map((input) => ({ input, atMs: Date.parse(input.shift.start) }));

  const pairedStartIds = new Set<number>();
  const handovers: Handover[] = [];

  for (const ending of endings) {
    const key = siteKeyOf(ending.input);
    const candidates = starts.filter(
      (start) =>
        siteKeyOf(start.input) === key &&
        start.input.shift.id !== ending.input.shift.id &&
        Math.abs(start.atMs - ending.atMs) <= pairing,
    );

    let replacement: HandoverReplacement;
    let starting: HandoverParty | null = null;
    let note: string;

    if (candidates.length === 1) {
      replacement = 'assigned';
      starting = partyOf(candidates[0].input, candidates[0].atMs);
      pairedStartIds.add(candidates[0].input.shift.id);
      note = `Replacement: ${starting.guardName} ${starting.at}`;
    } else if (candidates.length === 0) {
      replacement = 'none';
      note = 'No replacement assigned';
    } else {
      // Two or more shifts start around this end. Which one is the relief is not in the data, so the
      // panel refuses to choose and each start is listed in its own right below.
      replacement = 'unresolved';
      note = `${candidates.length} shifts start near this end — relief not identified`;
    }

    handovers.push({
      id: `handover-end-${ending.input.shift.id}`,
      atMs: ending.atMs,
      at: formatInstantTime(new Date(ending.atMs).toISOString(), siteZoneOf(ending.input)),
      siteName: siteOf(ending.input),
      timeZone: siteZoneOf(ending.input),
      ending: partyOf(ending.input, ending.atMs),
      starting,
      replacement,
      startingAssigned: Boolean(starting),
      note,
    });
  }

  for (const start of starts) {
    if (pairedStartIds.has(start.input.shift.id)) continue;
    const assigned = Boolean(start.input.shift.guard?.fullName);
    handovers.push({
      id: `handover-start-${start.input.shift.id}`,
      atMs: start.atMs,
      at: formatInstantTime(new Date(start.atMs).toISOString(), siteZoneOf(start.input)),
      siteName: siteOf(start.input),
      timeZone: siteZoneOf(start.input),
      ending: null,
      starting: partyOf(start.input, start.atMs),
      replacement: 'starting_only',
      startingAssigned: assigned,
      // An unassigned shift has no name to print, so the note carries the whole sentence.
      note: assigned ? 'Due to start' : 'No guard assigned',
    });
  }

  handovers.sort((a, b) => a.atMs - b.atMs || a.siteName.localeCompare(b.siteName) || a.id.localeCompare(b.id));
  return handovers.slice(0, limit);
}
