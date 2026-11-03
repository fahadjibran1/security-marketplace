/**
 * S4 patrol assignment correctness (owner-approved 3 Nov 2026, after production patrol P-6): a patrol started WITHOUT a
 * schedule (the Guard app had no due window — e.g. its plan was fetched before the site's setup was activated, or it was
 * offline) is linked server-side to the scheduled window it was done in, but ONLY when exactly one window is eligible.
 *
 * The rule, pure (the service gathers the candidates: the shift's own clock windows and shift-anchored windows, each with
 * its scope, whether a run already covers it and whether it was already judged missed):
 *
 *   1. Windows CONTAINING the (drift-adjusted) start come first — as for a patrol started for a schedule
 *      (windowForStart). If any exists, only they are considered:
 *        exactly one is free (not covered, not missed)  → linked, on time
 *        more than one is free                          → ad hoc, "ambiguous"
 *        none is free                                   → ad hoc, "covered" / "missed"
 *   2. Only when no window contains the start: windows that ENDED within the start grace (a late start), the same way.
 *   3. Otherwise: ad hoc, "none".
 *
 * A patrol never satisfies more than one window (one window or none), never takes a window that already has a run for
 * its scope, and never overrides a missed-patrol outcome (a window with a patrol_missed exception is never offered).
 */

export type MatchCandidate<S = unknown> = {
  scheduleId: number;
  scheduleName: string;
  anchor: 'clock' | 'shift';
  scopeKey: string;
  windowKey: string;
  start: Date;
  end: Date;
  /** A run already holds this window for this scope. */
  covered: boolean;
  /** The sweep (or reconciliation) already raised patrol_missed for this window and scope. */
  missed: boolean;
  /** The schedule row the service will start the run for (opaque here). */
  schedule: S;
  /** The window object the service will store (opaque here). */
  window: unknown;
};

export type WindowMatchOutcome = 'auto_assigned' | 'ambiguous' | 'covered' | 'missed' | 'none' | 'route_not_shown';

export type WindowMatch<S = unknown> =
  | { outcome: 'auto_assigned'; candidate: MatchCandidate<S>; lateStart: boolean; message: string }
  | { outcome: Exclude<WindowMatchOutcome, 'auto_assigned'>; candidates: Array<MatchCandidate<S>>; message: string };

const hhmm = (at: Date, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  } catch {
    return at.toISOString().slice(11, 16);
  }
};
const describe = (c: MatchCandidate<unknown>, timeZone: string) => `${c.scheduleName} ${hhmm(c.start, timeZone)}-${hhmm(c.end, timeZone)}`;

export function matchStartWindow<S>(candidates: ReadonlyArray<MatchCandidate<S>>, at: Date, startGraceMinutes: number, timeZone: string): WindowMatch<S> {
  const t = at.getTime();
  const graceMs = Math.max(0, startGraceMinutes) * 60_000;
  const containing = candidates.filter((c) => c.start.getTime() <= t && t < c.end.getTime());
  const late = candidates.filter((c) => c.end.getTime() <= t && t < c.end.getTime() + graceMs);
  const tier = containing.length ? containing : late;
  const lateStart = !containing.length;
  const order = (a: MatchCandidate<S>, b: MatchCandidate<S>) => a.start.getTime() - b.start.getTime() || a.windowKey.localeCompare(b.windowKey);
  const free = tier.filter((c) => !c.covered && !c.missed).sort(order);
  if (free.length === 1) {
    return { outcome: 'auto_assigned', candidate: free[0], lateStart, message: `Linked to the scheduled patrol ${describe(free[0], timeZone)}.` };
  }
  if (free.length > 1) {
    return {
      outcome: 'ambiguous',
      candidates: free,
      message: `Recorded as an ad-hoc patrol: ${free.length} scheduled patrol windows were open (${free.map((c) => describe(c, timeZone)).join('; ')}), so S4 could not tell which one it was for.`,
    };
  }
  const sorted = [...tier].sort(order);
  if (sorted.some((c) => c.missed)) {
    return { outcome: 'missed', candidates: sorted, message: `Recorded as an ad-hoc patrol: the scheduled patrol ${describe(sorted.find((c) => c.missed)!, timeZone)} was already recorded as missed.` };
  }
  if (sorted.length) {
    return { outcome: 'covered', candidates: sorted, message: `Recorded as an ad-hoc patrol: the scheduled patrol ${describe(sorted[0], timeZone)} already has a patrol.` };
  }
  return { outcome: 'none', candidates: [], message: 'Recorded as an ad-hoc patrol: no scheduled patrol window was open.' };
}

/**
 * Compatibility safeguard (owner, 3 Nov 2026). Guard app 1.2.1 keeps the route IT sent when the patrol started: a patrol
 * started with no schedule follows no route there, so the app shows the site's checkpoints as optional and never learns
 * a window's required checkpoints from the start answer. On a QR site (QR or QR + photos) linking such a patrol to a
 * window would make S4 judge it against checkpoints the Guard was never shown. So a QR window is linked only when the
 * phone sent THAT window's route (the same route chain); otherwise the patrol stays ad hoc ("route_not_shown"). Photo-only
 * sites are unaffected: their photo rule is the site's policy, which the app already shows.
 */
export function requireShownRoute<S>(
  match: WindowMatch<S>,
  input: { qr: boolean; sentRouteId: number | null; windowRouteId: (c: MatchCandidate<S>) => number | null; sameRoute: (a: number, b: number) => boolean },
): WindowMatch<S> {
  if (match.outcome !== 'auto_assigned' || !input.qr) return match;
  const routeId = input.windowRouteId(match.candidate);
  if (input.sentRouteId != null && routeId != null && input.sameRoute(input.sentRouteId, routeId)) return match;
  return {
    outcome: 'route_not_shown',
    candidates: [match.candidate],
    message: `Recorded as an ad-hoc patrol: the scheduled patrol ${match.message.replace(/^Linked to the scheduled patrol /, '').replace(/\.$/, '')} needs QR checkpoints the phone was not showing for this patrol, so S4 did not link it.`,
  };
}
