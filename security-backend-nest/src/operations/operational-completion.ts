import { DailyLogType } from '../daily-log/entities/daily-log.entity';
import { OperationalCompletion, OperationalCompletionKind } from './operational-window.types';

/**
 * The shape of the only persisted rows that can currently satisfy a periodic obligation. Kept
 * structural rather than importing the entity so the classifier stays pure and testable.
 */
export interface DailyLogCompletionSource {
  readonly logType: DailyLogType;
  readonly createdAt: Date;
}

/**
 * A Guard's scheduled "check call" (what the Guard app records today) and a supervisor "welfare
 * check" both prove the Guard was reachable, so either satisfies a Welfare Check window. The
 * historical `check_call` rows are the reason both are listed: renaming the feature must not
 * invalidate the evidence already in the database.
 */
export const WELFARE_COMPLETION_LOG_TYPES: readonly DailyLogType[] = [
  DailyLogType.CHECK_CALL,
  DailyLogType.WELFARE_CHECK,
];

/**
 * The single place a persisted daily_logs row becomes a classified completion.
 *
 * No branch maps to LOG_BOOK. There is no persisted `log_book` value until Migration 59, and
 * pointing this at `observation` instead would silently let a voluntary note discharge a written
 * Log Book obligation — the exact distinction the feature exists to make. W2 adds one branch here
 * when the enum value exists, and nowhere else.
 */
export function classifyDailyLogType(logType: DailyLogType): OperationalCompletionKind {
  if (WELFARE_COMPLETION_LOG_TYPES.includes(logType)) {
    return OperationalCompletionKind.WELFARE_CHECK;
  }
  return OperationalCompletionKind.UNCLASSIFIED;
}

/**
 * Classify a batch of daily logs once, so the same array can be handed to both the Welfare and
 * the Log Book resolver. Each resolver then filters to its own kind, which is what makes the two
 * obligations structurally unable to satisfy one another.
 */
export function toOperationalCompletions(
  logs: readonly DailyLogCompletionSource[],
): OperationalCompletion[] {
  return logs.map((log) => ({ at: log.createdAt, kind: classifyDailyLogType(log.logType) }));
}
