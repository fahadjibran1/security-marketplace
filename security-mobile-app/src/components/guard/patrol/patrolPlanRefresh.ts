// Keeping the Guard's patrol plan current (S4 1.2.1). PURE: no React, no react-native, no network of its own — the
// timers and the fetch are injected, so scripts/guard-patrols.spec.cjs drives every trigger with a fake clock.
//
// When the plan is (re)fetched:
//   * when the shift becomes live (first sight of an in-progress shift, or Book On while the app is open),
//   * every PATROL_PLAN_REFRESH_MS while the shift is in progress AND the app is in the foreground (paused in background),
//   * when the app comes back to the foreground (AppState → active),
//   * when the Guard asks for it (the card's Refresh control).
// One fetch at a time: a trigger while one is in flight is dropped (the in-flight one answers it).
//
// What a result does to the cached plan (applyPlanResult):
//   * success                        → the new plan, stamped with when it was fetched;
//   * a network failure or a 5xx     → the LAST SUCCESSFUL plan is kept, marked stale (the card says so);
//   * an authoritative answer (404 PATROLS_NOT_ENABLED / not the Guard's shift, 409 no site, 403) → no plan (no card).
// A refresh never reads or writes the outbox: what the phone recorded stays exactly as it is.

import { formatInstantTime } from '../../../services/siteTime';
import type { GuardPatrolPlan } from '../../../types/patrols';

export const PATROL_PLAN_REFRESH_MS = 5 * 60 * 1000;

export type PlanRefreshReason = 'shift_live' | 'interval' | 'foreground' | 'manual';

export type PlanTimers = {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

export class PatrolPlanRefresher {
  private live = false;
  private foreground = true;
  private handle: unknown = null;
  private inFlight = false;
  private disposed = false;

  constructor(
    private readonly fetchPlan: (reason: PlanRefreshReason) => Promise<void>,
    private readonly timers: PlanTimers,
    private readonly intervalMs: number = PATROL_PLAN_REFRESH_MS,
  ) {}

  /** The shift is (no longer) in progress. Becoming live fetches at once (this is the "after Book On" refresh). */
  setShiftLive(live: boolean) {
    if (this.disposed || live === this.live) return;
    this.live = live;
    if (live) {
      void this.trigger('shift_live');
    }
    this.syncTimer();
  }

  /** React Native AppState: 'active' is the foreground; anything else pauses the interval. */
  setAppState(state: string) {
    if (this.disposed) return;
    const foreground = state === 'active';
    if (foreground === this.foreground) return;
    this.foreground = foreground;
    if (foreground && this.live) void this.trigger('foreground');
    this.syncTimer();
  }

  /** The Guard's Refresh control. Only while the shift is live. */
  refreshNow(): Promise<boolean> {
    if (this.disposed || !this.live) return Promise.resolve(false);
    return this.trigger('manual');
  }

  /** Whether the periodic refresh is currently scheduled (for the spec). */
  get scheduled(): boolean {
    return this.handle !== null;
  }

  dispose() {
    this.disposed = true;
    this.live = false;
    this.syncTimer();
  }

  private syncTimer() {
    const want = this.live && this.foreground && !this.disposed;
    if (want && this.handle === null) {
      this.handle = this.timers.setInterval(() => { void this.trigger('interval'); }, this.intervalMs);
    } else if (!want && this.handle !== null) {
      this.timers.clearInterval(this.handle);
      this.handle = null;
    }
  }

  private async trigger(reason: PlanRefreshReason): Promise<boolean> {
    if (this.inFlight || this.disposed) return false;
    this.inFlight = true;
    try {
      await this.fetchPlan(reason);
      return true;
    } catch {
      return false; // the fetch records its own failure in the cache (applyPlanResult)
    } finally {
      this.inFlight = false;
    }
  }
}

export type PlanCache = {
  shiftId: number | null;
  plan: GuardPatrolPlan | null;
  /** When the plan shown was fetched (ISO), or null when none has been. */
  fetchedAt: string | null;
  /** The last refresh failed and the plan shown (if any) is the last good one. */
  failure: 'offline' | 'server' | null;
};

export const EMPTY_PLAN_CACHE: PlanCache = { shiftId: null, plan: null, fetchedAt: null, failure: null };

export type PlanResult =
  | { ok: true; plan: GuardPatrolPlan; at: Date }
  | { ok: false; error: unknown; at: Date };

function statusOf(error: unknown): number | null {
  const e = error as { name?: string; status?: unknown } | null;
  return e && e.name === 'ApiError' && typeof e.status === 'number' ? e.status : null;
}

/** A refusal that says there is no plan for this shift (switch off, not the Guard's shift, no site, not allowed). */
export function isAuthoritativePlanRefusal(error: unknown): boolean {
  const status = statusOf(error);
  return status === 403 || status === 404 || status === 409;
}

/** The cache after one fetch for `shiftId` (a different shift starts from nothing). */
export function applyPlanResult(cache: PlanCache, shiftId: number, result: PlanResult): PlanCache {
  const base = cache.shiftId === shiftId ? cache : { ...EMPTY_PLAN_CACHE, shiftId };
  if (result.ok) return { shiftId, plan: result.plan, fetchedAt: result.at.toISOString(), failure: null };
  if (isAuthoritativePlanRefusal(result.error)) return { shiftId, plan: null, fetchedAt: null, failure: null };
  const status = statusOf(result.error);
  return { ...base, shiftId, failure: status != null && status >= 500 ? 'server' : 'offline' };
}

/**
 * What the card says about the plan's freshness: null when it is current; otherwise when it was last updated (site
 * clock) and why it may be out of date.
 */
export function planFreshnessText(cache: PlanCache, timeZone: string): string | null {
  if (!cache.failure) return null;
  if (!cache.plan || !cache.fetchedAt) {
    return cache.failure === 'offline'
      ? 'Patrols could not be loaded (no connection). Anything already recorded on this phone is kept and sent later.'
      : 'Patrols could not be loaded right now. S4 will try again; anything recorded on this phone is kept.';
  }
  const at = formatInstantTime(cache.fetchedAt, timeZone);
  return cache.failure === 'offline'
    ? `Patrol plan last updated ${at} — offline; will update when connected.`
    : `Patrol plan last updated ${at} — S4 could not be reached; will try again.`;
}
