// What counts as a completed Welfare Check on the Guard's own screen. (Phase 3C.)
//
// WHY THIS IS ITS OWN MODULE
// Phase 3C makes the Guard app write `daily_logs.welfare_check`. Every shift worked before it wrote
// `daily_logs.check_call`, and those rows are still evidence — the backend's WELFARE_COMPLETION_LOG_TYPES
// has recognised both since Migration 59, historical rows are never rewritten, and the enum keeps both
// values.
//
// The Guard screen had its own recogniser that matched `check_call` and nothing else. Left alone, the
// canonical write would have been invisible to it: a Guard would record a Welfare Check, the row would
// land, the backend would count it, and this screen would still say "overdue" — permanently, because
// nothing it recognised would ever arrive again. That is the one Welfare behaviour Phase 3C had to touch,
// so it lives here where a test can execute it rather than inside a 4,000-line screen that cannot be.
//
// THIS IS RECOGNITION, NOT ARITHMETIC. It says which rows are evidence. It does not decide windows, grace
// periods or interval precedence — the backend's operational window engine owns all of that, and the
// Guard endpoint does not currently carry its projection (TECH-DEBT-OPS-02).

/** A daily log row, reduced to what evidence recognition needs. */
export type WelfareEvidenceLog = { logType: string; createdAt: string };

/**
 * The log types that count as a completed Welfare Check, mirroring the backend's
 * WELFARE_COMPLETION_LOG_TYPES.
 *
 * `welfare_check` is what the Guard app writes now. `check_call` is what it wrote before, and a shift
 * worked yesterday must not stop reading as complete because the vocabulary changed today.
 */
export const WELFARE_EVIDENCE_LOG_TYPES: readonly string[] = ['welfare_check', 'check_call'];

/** Whether this row is evidence of a completed Welfare Check. */
export function isWelfareEvidence(log: { logType: string } | null | undefined): boolean {
  return !!log && WELFARE_EVIDENCE_LOG_TYPES.includes(log.logType);
}

/**
 * The most recent Welfare Check evidence for a shift, or undefined when there is none.
 *
 * Sorted by `createdAt` rather than trusting the caller's order, because the two log types arrive from
 * the same endpoint interleaved and a mixed-vocabulary shift — one worked across the upgrade — would
 * otherwise depend on which happened to come back first.
 */
export function lastWelfareEvidence<T extends WelfareEvidenceLog>(
  logsForShift: readonly T[],
): T | undefined {
  return [...logsForShift]
    .filter(isWelfareEvidence)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];
}
