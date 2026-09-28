import type {
  LogBookOperationsView,
  ShiftOperationsView,
  WelfareOperationsView,
  WelfarePresentationStatus,
} from '../../types/models';

/**
 * Presentation for the Live Operations welfare and Log Book cells.
 *
 * Pure formatting over values the backend already decided. Nothing here recalculates a window, a
 * count or a due time: the operational window engine is authoritative and this module only chooses
 * wording, tone and site-local times.
 */

export type OperationsTone = 'neutral' | 'good' | 'warning' | 'danger';

/**
 * Site-local wall-clock time, because a control room reads the board against the clock on the wall at
 * the site. The underlying instants stay UTC; only the display is converted, and a shift that spans a
 * DST change therefore reads correctly on both sides of it.
 */
export function formatSiteTime(iso: string | null | undefined, timezone?: string | null): string {
  if (!iso) return '—';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(value);
  } catch {
    return value.toISOString().slice(11, 16);
  }
}

export function formatSiteWindow(
  window: { start: string; end: string } | null | undefined,
  timezone?: string | null,
): string {
  if (!window) return '—';
  return `${formatSiteTime(window.start, timezone)}–${formatSiteTime(window.end, timezone)}`;
}

const WELFARE_LABELS: Record<WelfarePresentationStatus, string> = {
  not_applicable: 'NOT REQUIRED',
  no_book_on: 'NOT BOOKED ON',
  current: 'CURRENT',
  due: 'DUE',
  overdue: 'OVERDUE',
  missed: 'MISSED',
  shift_complete: 'SHIFT COMPLETE',
};

const WELFARE_TONES: Record<WelfarePresentationStatus, OperationsTone> = {
  not_applicable: 'neutral',
  no_book_on: 'warning',
  current: 'good',
  due: 'neutral',
  overdue: 'warning',
  missed: 'danger',
  shift_complete: 'neutral',
};

export type WelfareCell = {
  label: string;
  tone: OperationsTone;
  /** The one supporting line the board has room for. */
  detail: string | null;
  missedSummary: string | null;
};

/**
 * The welfare cell for the main board: a status word, one supporting line, and the missed count only
 * when there is one. Full timestamps and totals live in the detail panel rather than widening the
 * table until it stops being readable.
 */
export function welfareCell(
  welfare: WelfareOperationsView | null | undefined,
  timezone?: string | null,
): WelfareCell {
  if (!welfare) {
    return { label: '—', tone: 'neutral', detail: null, missedSummary: null };
  }

  const status = welfare.status;
  let detail: string | null = null;
  if (status === 'overdue' && welfare.overdueByMinutes !== null) {
    detail = `Due ${formatSiteTime(welfare.nextDueAt, timezone)} · ${welfare.overdueByMinutes} min over`;
  } else if (welfare.nextDueAt && (status === 'current' || status === 'due' || status === 'missed')) {
    detail = `Next ${formatSiteTime(welfare.nextDueAt, timezone)}`;
  } else if (status === 'no_book_on') {
    detail = 'No Book On recorded';
  }

  // Consecutive misses are the number a control room acts on; the shift total is context.
  let missedSummary: string | null = null;
  if (welfare.consecutiveMissed > 0) {
    missedSummary = `${welfare.consecutiveMissed} consecutive missed`;
  } else if (welfare.missedCount > 0) {
    missedSummary = `${welfare.missedCount} missed`;
  }

  return { label: WELFARE_LABELS[status] ?? '—', tone: WELFARE_TONES[status] ?? 'neutral', detail, missedSummary };
}

export type LogBookCell = {
  label: string;
  tone: OperationsTone;
  detail: string | null;
};

/**
 * The Log Book cell. A missing entry is an operational exception, so it is amber and never red: it is
 * incomplete paperwork, not a possible harm to a person, and colouring it like a welfare breach would
 * train the control room to ignore the colour that matters.
 */
export function logBookCell(
  logBook: LogBookOperationsView | null | undefined,
  timezone?: string | null,
): LogBookCell {
  if (!logBook || !logBook.required) {
    return { label: 'As required', tone: 'neutral', detail: null };
  }
  if (logBook.missingCount > 0) {
    return {
      label: `${logBook.missingCount} missing`,
      tone: 'warning',
      detail: logBook.currentWindowSubmitted ? 'Current submitted' : 'Current entry due',
    };
  }
  return {
    label: logBook.currentWindowSubmitted ? 'Up to date' : 'Entry due',
    tone: logBook.currentWindowSubmitted ? 'good' : 'neutral',
    detail: logBook.currentWindow ? formatSiteWindow(logBook.currentWindow, timezone) : null,
  };
}

export type OperationalException = {
  key: string;
  label: string;
  tone: OperationsTone;
  detail: string;
};

/**
 * The operational exceptions for one shift, in the order a control room should deal with them.
 *
 * At most ONE welfare item, taken from the shift-level summary or the standing run of misses. Twenty
 * four missed windows are twenty four durable records but a single thing to act on, so this never
 * expands into one item per window.
 */
export function operationalExceptions(
  operations: ShiftOperationsView | null | undefined,
): OperationalException[] {
  if (!operations) return [];
  const items: OperationalException[] = [];

  const summary = operations.welfareSummary;
  if (summary) {
    items.push({
      key: 'welfare-summary',
      label: summary.acknowledged ? 'WELFARE OVERDUE · ACKNOWLEDGED' : 'WELFARE OVERDUE',
      tone: 'danger',
      detail: summary.message,
    });
  } else if (operations.welfare.consecutiveMissed > 0) {
    // A standing lapse with no summary row yet: the sweep runs every five minutes, so the board can
    // see the gap before the alert exists. Still one item.
    items.push({
      key: 'welfare-run',
      label: 'WELFARE MISSED',
      tone: 'danger',
      detail: `${operations.welfare.consecutiveMissed} consecutive Welfare Check${
        operations.welfare.consecutiveMissed === 1 ? '' : 's'
      } missed`,
    });
  }

  if (operations.missingBookOff) {
    items.push({
      key: 'missing-book-off',
      label: 'BOOK OFF MISSING',
      tone: 'warning',
      detail: 'Shift ended with no Book Off recorded',
    });
  }

  if (operations.logBook.required && operations.logBook.missingCount > 0) {
    items.push({
      key: 'log-book-missing',
      label: 'LOG BOOK INCOMPLETE',
      tone: 'warning',
      detail: `${operations.logBook.missingCount} period${
        operations.logBook.missingCount === 1 ? '' : 's'
      } with no entry`,
    });
  }

  return items;
}

/** The detail-panel lines, in the operational sequence a shift actually follows. */
export function operationsDetailLines(
  operations: ShiftOperationsView | null | undefined,
): { heading: string; lines: string[] }[] {
  if (!operations) return [];
  const tz = operations.timezone;
  const { welfare, logBook } = operations;

  const welfareLines: string[] = [];
  welfareLines.push(`Last: ${formatSiteTime(welfare.lastWelfareAt, tz)}`);
  if (welfare.currentWindow) {
    welfareLines.push(`Current window: ${formatSiteWindow(welfare.currentWindow, tz)}`);
    welfareLines.push(`Next due: ${formatSiteTime(welfare.nextDueAt, tz)}`);
  }
  welfareLines.push(`Completed: ${welfare.completedCount}`);
  welfareLines.push(`Missed: ${welfare.missedCount}`);
  if (welfare.consecutiveMissed > 0) {
    welfareLines.push(`Consecutive missed: ${welfare.consecutiveMissed}`);
  }

  const logBookLines: string[] = logBook.required
    ? [
        `Required: ${logBook.intervalMinutes === 60 ? 'Hourly' : `Every ${logBook.intervalMinutes} min`}`,
        `Submitted: ${logBook.submittedCount}`,
        `Missing: ${logBook.missingCount}`,
        `Current: ${logBook.currentWindowSubmitted ? 'Submitted' : 'Entry due'}`,
      ]
    : ['Required: As required'];

  return [
    { heading: 'Book On', lines: [formatSiteTime(operations.bookOnAt, tz)] },
    { heading: 'Welfare Check', lines: welfareLines },
    { heading: 'Log Book', lines: logBookLines },
    { heading: 'Book Off', lines: [formatSiteTime(operations.bookOffAt, tz)] },
  ];
}
