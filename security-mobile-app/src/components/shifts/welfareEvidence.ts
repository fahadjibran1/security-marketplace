// What counts as a completed Welfare Check. (Phase 3C; relocated and re-pointed in Phase 3D.)
//
// WHY THIS IS ITS OWN MODULE
// Phase 3C made the Guard app write `daily_logs.welfare_check`. Every shift worked before it wrote
// `daily_logs.check_call`, and those rows are still evidence — the backend's WELFARE_COMPLETION_LOG_TYPES
// has recognised both since Migration 59, historical rows are never rewritten, and the enum keeps both
// values. Recognising only the new type would make every Welfare Check recorded before the rename read
// as a lapse.
//
// WHO USES IT NOW
// Phase 3D moved Welfare TIMING to the backend's window engine, so the Guard screen no longer decides
// anything about welfare and no longer needs this. What still does is the COMPANY side, in two places
// that count and label daily-log rows directly: the shift close-out summary, and the operational activity
// feed. Hence the move out of `guard/` and into the folder shared by both roles — the same reasoning that
// put `shiftOfferTime` here in Phase 3B.
//
// THIS IS RECOGNITION, NOT ARITHMETIC. It says which rows are evidence. It does not decide windows, grace
// periods or interval precedence — the backend's operational window engine owns all of that, and from
// Phase 3D it is the only thing that does.

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
