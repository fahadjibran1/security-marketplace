import { Shift } from '../shift/entities/shift.entity';
import { RotaSlot } from './entities/rota-slot.entity';

// ── Phase ────────────────────────────────────────────────────────────────────

export type CoveragePhase = 'future' | 'live' | 'past';

/**
 * Computes the temporal phase of a slot at a given instant.
 * Phase is NEVER stored — it is always derived at query time.
 * A cancelled slot retains its natural phase (the window still occupies real time).
 */
export function toCoveragePhase(slot: RotaSlot, now: Date): CoveragePhase {
  if (slot.endAt < now) return 'past';
  if (slot.startAt <= now) return 'live';
  return 'future';
}

// ── Coverage state ────────────────────────────────────────────────────────────

export type FutureCoverageState =
  | 'fully_planned'
  | 'offered_pending'
  | 'under_planned'
  | 'fully_open'
  | 'has_problems'
  | 'cancelled';

export type LiveCoverageState =
  | 'live_fully_staffed'
  | 'live_partial'
  | 'live_none_on_site'
  | 'live_has_problems'
  | 'cancelled';

export type PastCoverageState =
  | 'outcome_completed'
  | 'outcome_shortfall'
  | 'outcome_failed'
  | 'outcome_cancelled'
  | 'outcome_has_problems';

export type CoverageState =
  | FutureCoverageState
  | LiveCoverageState
  | PastCoverageState;

/**
 * Derives the coverage state of a slot from its child shifts.
 *
 * Phase semantics:
 *   future:  based on confirmed/offered/open/problem future readiness
 *   live:    based on in_progress/missed live staffing
 *   past:    based on completed/missed historical outcome
 *
 * A completed past slot will NEVER appear as open/under-planned because
 * `completed` counts as a successful coverage outcome.
 */
export function toCoverageState(
  slot: RotaSlot,
  shifts: Shift[],
  phase: CoveragePhase,
): CoverageState {
  if (slot.status === 'cancelled') {
    return phase === 'live' ? 'cancelled' : 'cancelled';
  }

  const nonCancelled = shifts.filter((s) => s.status !== 'cancelled');
  const required = slot.requiredGuardCount;

  if (phase === 'future') {
    const ready = nonCancelled.filter((s) => s.status === 'ready').length;
    const offered = nonCancelled.filter((s) => s.status === 'offered').length;
    const unfilled = nonCancelled.filter((s) => s.status === 'unfilled').length;
    const rejected = nonCancelled.filter((s) => s.status === 'rejected').length;

    if (rejected > 0) return 'has_problems';
    if (unfilled === 0 && rejected === 0) {
      return ready === nonCancelled.length ? 'fully_planned' : 'offered_pending';
    }
    if (ready + offered > 0) return 'under_planned';
    if (unfilled >= required) return 'fully_open';
    return 'under_planned';
  }

  if (phase === 'live') {
    const inProgress = nonCancelled.filter((s) => s.status === 'in_progress').length;
    const missed = nonCancelled.filter((s) => s.status === 'missed').length;

    if (missed > 0) return 'live_has_problems';
    if (inProgress >= required) return 'live_fully_staffed';
    if (inProgress > 0) return 'live_partial';
    return 'live_none_on_site';
  }

  // past
  const completed = nonCancelled.filter((s) => s.status === 'completed').length;
  const missed = nonCancelled.filter((s) => s.status === 'missed').length;
  // Positions still in non-terminal states for a past slot = data anomaly
  const stillActive = nonCancelled.filter((s) =>
    ['unfilled', 'offered', 'ready', 'in_progress'].includes(s.status),
  ).length;

  if (slot.status === 'cancelled') return 'outcome_cancelled';
  if (stillActive > 0) return 'outcome_has_problems';
  if (missed === 0 && completed === 0) return 'outcome_failed';
  if (completed >= required && missed === 0) return 'outcome_completed';
  if (completed > 0 && missed > 0) return 'outcome_shortfall';
  if (completed >= required) return 'outcome_completed'; // extra completions offset misses
  if (completed > 0) return 'outcome_shortfall';
  return 'outcome_failed';
}

// ── Position counts ───────────────────────────────────────────────────────────

export interface PositionCounts {
  required: number;
  /** Non-cancelled positions with a guard assigned */
  assigned: number;
  /**
   * Positions representing committed or delivered coverage.
   * Includes: ready, in_progress, completed — safe to report as covered regardless of phase.
   * This ensures past-completed slots never show `open > 0`.
   */
  confirmed: number;
  /** status = 'offered' */
  offered: number;
  /** status = 'unfilled' */
  open: number;
  /** status IN ('rejected', 'missed') */
  problem: number;
  /** status = 'in_progress' */
  onShift: number;
  /** status = 'completed' */
  completed: number;
}

export function computeCounts(slot: RotaSlot, shifts: Shift[]): PositionCounts {
  const active = shifts.filter((s) => s.status !== 'cancelled');

  return {
    required: slot.requiredGuardCount,
    assigned: active.filter((s) => s.guard != null).length,
    confirmed: active.filter((s) =>
      ['ready', 'in_progress', 'completed'].includes(s.status),
    ).length,
    offered: active.filter((s) => s.status === 'offered').length,
    open: active.filter((s) => s.status === 'unfilled').length,
    problem: active.filter((s) => ['rejected', 'missed'].includes(s.status)).length,
    onShift: active.filter((s) => s.status === 'in_progress').length,
    completed: active.filter((s) => s.status === 'completed').length,
  };
}

// ── Night shift heuristic ─────────────────────────────────────────────────────

/**
 * A slot is classified as a night shift if it starts at or after 20:00 UTC
 * or ends before 06:00 UTC, indicating work during unsociable hours.
 */
export function isNightShift(startAt: Date, endAt: Date): boolean {
  const startHour = startAt.getUTCHours();
  const endHour = endAt.getUTCHours();
  const endMin = endAt.getUTCMinutes();
  return startHour >= 20 || startHour < 6 || (endHour < 6 || (endHour === 6 && endMin === 0 && endAt > startAt));
}
