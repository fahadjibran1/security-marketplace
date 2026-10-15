import { Logger } from '@nestjs/common';

/**
 * One run at a time for a periodic background job, within this process (Performance P2).
 *
 * Before P2 every background job was a bare setInterval: if a run took longer than its interval, the next
 * tick started a second run beside it, and the two competed for the same ten pooled connections as the
 * HTTP requests and the health check. The 5-minute safety sweep did exactly that once queries slowed down
 * (production log, 15 Oct 2026: "Missed welfare check scan failed: canceling statement due to statement
 * timeout", with instance health-check failures and no confirmed user traffic).
 *
 * The rules:
 *  - idle            → the run starts;
 *  - already running → this tick is skipped and logged. Nothing is queued: every job here recomputes its
 *                      whole state from the database on each run, so the next tick catches up on anything
 *                      a skipped tick would have done (no missed check is lost, only deferred);
 *  - a run that fails is logged and the job is free to run again on the next tick, never immediately,
 *    so a failing database is not hammered by retries;
 *  - a run still going after `overrunAfterMs` is reported at error level on every skipped tick, so a
 *    stuck job is visible rather than silently starving.
 *
 * Errors never escape `tick()`: a background failure cannot become an unhandled rejection that takes the
 * process down. Cross-instance duplication is NOT handled here (see the per-shift advisory locks and unique
 * indexes in the jobs themselves).
 */
export interface SingleFlightOutcome {
  ran: boolean;
  ok?: boolean;
  durationMs?: number;
  skippedBecause?: 'previous_run_active' | 'stopped';
}

export interface SingleFlightStats {
  runs: number;
  succeeded: number;
  failed: number;
  skipped: number;
  overruns: number;
}

export class SingleFlightJob {
  private running: Promise<SingleFlightOutcome> | null = null;
  private startedAt = 0;
  private stopped = false;
  private readonly counts: SingleFlightStats = { runs: 0, succeeded: 0, failed: 0, skipped: 0, overruns: 0 };

  constructor(
    readonly name: string,
    private readonly run: () => Promise<unknown>,
    private readonly options: {
      overrunAfterMs: number;
      logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
      now?: () => number;
    },
  ) {}

  private get logger() {
    return this.options.logger ?? new Logger('BackgroundJob');
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  stats(): SingleFlightStats {
    return { ...this.counts };
  }

  /** No new runs after this; a run in flight finishes on its own. */
  stop() {
    this.stopped = true;
  }

  /** The interval callback. Never rejects. */
  tick(): Promise<SingleFlightOutcome> {
    if (this.stopped) return Promise.resolve({ ran: false, skippedBecause: 'stopped' });
    if (this.running) {
      this.counts.skipped += 1;
      const runningForMs = this.now() - this.startedAt;
      const overrun = runningForMs >= this.options.overrunAfterMs;
      if (overrun) this.counts.overruns += 1;
      const line = JSON.stringify({
        event: overrun ? 'background_job_overrun' : 'background_job_skipped',
        job: this.name,
        reason: 'previous_run_active',
        runningForMs,
      });
      if (overrun) this.logger.error(line);
      else this.logger.warn(line);
      return Promise.resolve({ ran: false, skippedBecause: 'previous_run_active' });
    }

    this.startedAt = this.now();
    this.counts.runs += 1;
    const started = this.startedAt;
    // Deferred by one microtask so that `running` is set before the job can possibly settle, even if it
    // throws synchronously.
    const flight: Promise<SingleFlightOutcome> = Promise.resolve()
      .then(() => this.run())
      .then(
        () => {
          this.counts.succeeded += 1;
          return { ran: true, ok: true, durationMs: this.now() - started };
        },
        () => {
          this.counts.failed += 1;
          // The job's own failure lines carry the detail; this one is the structured, message-free record.
          this.logger.error(
            JSON.stringify({ event: 'background_job_failed', job: this.name, durationMs: this.now() - started }),
          );
          return { ran: true, ok: false, durationMs: this.now() - started };
        },
      )
      .finally(() => {
        this.running = null;
      });
    this.running = flight;
    return flight;
  }
}
