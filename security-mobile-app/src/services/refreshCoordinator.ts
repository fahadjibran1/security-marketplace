/**
 * One refresh cycle at a time per workspace (Performance P2).
 *
 * The Company dashboard reloads ~15 API sources per cycle on a 15-60 second timer. Before P2 every tick
 * started a new cycle whether or not the previous one had finished, so once the backend slowed down the
 * cycles piled up on top of each other and turned one open tab into a stream of concurrent requests that
 * exhausted the backend's database pool (S4 P1 incident, 14 Oct 2026). The rules here:
 *
 *  - idle                          → the cycle starts now;
 *  - busy, timer tick              → skipped. The next tick reloads everything anyway, so nothing is lost
 *                                    and nothing queues up behind a slow backend;
 *  - busy, explicit request        → ONE trailing cycle, run as soon as the current one ends. Later requests
 *    (manual refresh, a section      before it starts join it rather than adding cycles, and it always runs
 *    change, reload after an         the newest loader. The cycle in flight is superseded: it may have read
 *    operator action)                the world before the operator's action, so its results are ignored;
 *  - disposed (screen unmounted)   → every result still in flight is ignored and nothing new starts.
 *
 * A cycle checks `isCurrent()` before it touches state. That is how an obsolete response is dropped
 * without having to cancel the request underneath it.
 */

export type RefreshTrigger = 'timer' | 'request';

export type RefreshCycle = (isCurrent: () => boolean) => Promise<void>;

export interface RefreshCoordinatorStats {
  started: number;
  skippedTicks: number;
  coalesced: number;
  superseded: number;
}

export interface RefreshCoordinator {
  /**
   * Resolves when the cycle that will satisfy this request has finished. A timer request never rejects
   * (nothing awaits it); an explicit request rejects if the cycle it ran in threw.
   */
  request(trigger: RefreshTrigger, cycle: RefreshCycle): Promise<void>;
  /** True while a cycle is running. */
  isBusy(): boolean;
  /** Stop: ignore everything in flight, drop anything pending, start nothing new. */
  dispose(): void;
  isDisposed(): boolean;
  stats(): RefreshCoordinatorStats;
}

interface Pending {
  cycle: RefreshCycle;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export function createRefreshCoordinator(): RefreshCoordinator {
  let generation = 0;
  let running: Promise<void> | null = null;
  let pending: Pending | null = null;
  let disposed = false;
  const counts: RefreshCoordinatorStats = { started: 0, skippedTicks: 0, coalesced: 0, superseded: 0 };

  const start = (cycle: RefreshCycle): Promise<void> => {
    generation += 1;
    const mine = generation;
    counts.started += 1;
    const isCurrent = () => !disposed && generation === mine;
    let result: Promise<void>;
    try {
      result = Promise.resolve(cycle(isCurrent));
    } catch (error) {
      result = Promise.reject(error);
    }
    const settled = result.finally(() => {
      running = null;
      const next = pending;
      pending = null;
      if (!next) return;
      if (disposed) {
        next.resolve();
        return;
      }
      start(next.cycle).then(next.resolve, next.reject);
    });
    running = settled;
    return settled;
  };

  const quiet = (promise: Promise<void>) => promise.catch(() => undefined);

  return {
    request(trigger, cycle) {
      if (disposed) return Promise.resolve();
      if (!running) {
        const promise = start(cycle);
        return trigger === 'timer' ? quiet(promise) : promise;
      }
      if (trigger === 'timer') {
        counts.skippedTicks += 1;
        return quiet(pending ? pending.promise : running);
      }
      if (pending) {
        counts.coalesced += 1;
        pending.cycle = cycle;
        return pending.promise;
      }
      // Supersede the cycle in flight: it can no longer pass isCurrent(), so its results are dropped.
      generation += 1;
      counts.superseded += 1;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      pending = { cycle, promise, resolve, reject };
      return promise;
    },
    isBusy: () => running !== null,
    dispose() {
      disposed = true;
      generation += 1;
      if (pending) {
        pending.resolve();
        pending = null;
      }
    },
    isDisposed: () => disposed,
    stats: () => ({ ...counts }),
  };
}
