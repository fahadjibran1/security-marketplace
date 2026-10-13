/**
 * Fail-safe presentation of operational figures whose data may not have loaded.
 *
 * The dashboard and Live Operations derive their counts from lists that start empty and keep their
 * last value when a reload fails. Rendered naively, a failed load reads as a genuine zero — a green
 * "0 alerts", "All Clear", "Coverage looks good" — exactly when S4 knows nothing. These rules make the
 * difference explicit:
 *
 *  - source loaded              → the number, as it is (a genuine zero is a genuine zero);
 *  - source failed, number > 0  → the last loaded number, labelled "Not refreshed", severity kept
 *                                 (an SOS stays an SOS);
 *  - source failed, number = 0  → "—" / "Unavailable": a zero from a failed load is never shown,
 *                                 whether or not an earlier load succeeded;
 *  - still loading, number = 0  → "…" / "Loading".
 */

export type SourceState = 'ready' | 'error';

export type SafeCount =
  | { kind: 'value'; value: number; stale: boolean }
  | { kind: 'unavailable' }
  | { kind: 'loading' };

/** 'error' when ANY of the named loaders failed in the latest load; otherwise 'ready'. */
export function sourceState(failedSources: readonly string[], ...labels: string[]): SourceState {
  return labels.some((label) => failedSources.includes(label)) ? 'error' : 'ready';
}

export function safeCount(value: number, state: SourceState | undefined, loading = false): SafeCount {
  if (state === 'error') return value > 0 ? { kind: 'value', value, stale: true } : { kind: 'unavailable' };
  if (loading && value === 0) return { kind: 'loading' };
  return { kind: 'value', value, stale: false };
}

export function countText(count: SafeCount): string {
  if (count.kind === 'unavailable') return '—';
  if (count.kind === 'loading') return '…';
  return String(count.value);
}

/** A short word beside the figure, so its status is never colour alone. Null for a current figure. */
export function countStatusWord(count: SafeCount): string | null {
  if (count.kind === 'unavailable') return 'Unavailable';
  if (count.kind === 'loading') return 'Loading';
  return count.stale ? 'Not refreshed' : null;
}

/** True only for a figure S4 actually knows to be zero right now. */
export function isKnownZero(count: SafeCount): boolean {
  return count.kind === 'value' && !count.stale && count.value === 0;
}

/** True when the figure is a real number greater than zero (current or last loaded). */
export function isPositive(count: SafeCount): boolean {
  return count.kind === 'value' && count.value > 0;
}

/** Human names for loader labels, for "these sources could not be loaded" notices. */
const SOURCE_NAMES: Record<string, string> = {
  shifts: 'shifts',
  attendance: 'attendance',
  'live operations monitoring': 'Welfare and Log Book monitoring',
  'uncovered coverage': 'coverage',
  incidents: 'incidents',
  alerts: 'safety alerts',
  'daily logs': 'Log Book entries',
  sites: 'sites',
  'company guards': 'Guards',
  compliance: 'compliance',
};

export function describeFailedSources(failedSources: readonly string[], relevant: readonly string[]): string[] {
  return relevant.filter((label) => failedSources.includes(label)).map((label) => SOURCE_NAMES[label] ?? label);
}
