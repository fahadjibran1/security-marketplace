// The Log Book register: one reading of the company's Log Book, shared by every surface.
//
// THIS MODULE OWNS NO SCHEDULE. Required periods come from the backend's `LogBookWindowService`
// output, published on each shift's operations projection, and are passed through here untouched.
// A second grid computed in the frontend would eventually disagree with the one the Guard app and
// the live board are told, and then nobody could say which was right.
//
// It is pure: no React, no API client. The register on screen, the Daily Site Log, the printed page
// and the export all build from these helpers, so one entry cannot read differently in two places.

import type { DailyLog, OperationalWindowView, Shift, ShiftOperationsView } from '../../types/models';

/** The canonical stored type. Never renamed, never widened. */
export const LOG_BOOK_TYPE = 'log_book';

/**
 * Whether this row is a Log Book entry.
 *
 * STRICTLY `log_book`. An `observation` is a voluntary note that predates the Log Book obligation and
 * a `welfare_check` proves presence rather than narrative — treating either as a Log Book entry would
 * retro-label historical rows as satisfying a duty they were never recorded against. The backend
 * applies exactly this rule when grading windows; this is the same rule on the reading side.
 */
export function isLogBookEntry(log: Pick<DailyLog, 'logType'> | null | undefined): boolean {
  return (log?.logType || '').trim().toLowerCase() === LOG_BOOK_TYPE;
}

/** The display name of a stored log type. Nothing here renames what is stored. */
export function logTypeLabel(logType: string | null | undefined): string {
  switch ((logType || '').trim().toLowerCase()) {
    case 'log_book':
      return 'Log Book';
    case 'welfare_check':
    case 'check_call':
      // Historical `check_call` rows are Welfare Checks under the old name.
      return 'Welfare Check';
    case 'observation':
      return 'Observation';
    case 'patrol':
      return 'Patrol';
    case 'visitor':
      return 'Visitor';
    case 'delivery':
      return 'Delivery';
    case 'maintenance':
      return 'Maintenance';
    default:
      return 'Log entry';
  }
}

export type LogBookRow = {
  /** The stored row's own id. The same entry carries this id on every surface. */
  id: number;
  at: string;
  atMs: number;
  message: string;
  logType: string;
  logTypeLabel: string;
  shiftId: number | null;
  siteId: number | null;
  siteName: string;
  clientName: string;
  guardId: number | null;
  guardName: string;
};

/** The day a timestamp falls on, on the SITE's clock rather than the reader's. */
export function siteDayKey(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  // en-CA gives YYYY-MM-DD, which sorts and compares as a string.
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export type RegisterFilters = {
  /** A site-local YYYY-MM-DD. Empty shows every day. */
  date?: string;
  clientName?: string;
  siteId?: number | null;
  guardId?: number | null;
  shiftId?: number | null;
  /** Free text matched against the entry, the site and the guard. */
  search?: string;
};

/**
 * Build the register.
 *
 * Oldest first within the selected day, because an occurrence book is read forwards: a controller
 * reconstructing a night starts at the beginning of it, not at the most recent arrival.
 *
 * Only Log Book rows appear. A Welfare Check is evidence of presence and belongs on the Welfare
 * surfaces; mixing them here would make the register answer a different question than its name.
 */
export function buildLogBookRegister(
  logs: DailyLog[] | null | undefined,
  shiftsById: Map<number, Shift> | null | undefined,
  timeZone: string,
  filters: RegisterFilters = {},
): LogBookRow[] {
  const search = (filters.search || '').trim().toLowerCase();

  const rows = (logs ?? [])
    .filter(isLogBookEntry)
    .map<LogBookRow>((log) => {
      const shift = log.shift?.id != null ? (shiftsById?.get(log.shift.id) ?? log.shift) : log.shift;
      const site = shift?.site ?? null;
      return {
        id: log.id,
        at: log.createdAt,
        atMs: Date.parse(log.createdAt),
        message: log.message ?? '',
        logType: log.logType,
        logTypeLabel: logTypeLabel(log.logType),
        shiftId: shift?.id ?? null,
        siteId: site?.id ?? shift?.siteId ?? null,
        siteName: site?.name || shift?.siteName || '',
        clientName: site?.client?.name || site?.clientName || '',
        guardId: log.guard?.id ?? null,
        guardName: log.guard?.fullName || '',
      };
    })
    .filter((row) => Number.isFinite(row.atMs))
    .filter((row) => (filters.date ? siteDayKey(row.at, timeZone) === filters.date : true))
    .filter((row) => (filters.clientName ? row.clientName === filters.clientName : true))
    .filter((row) => (filters.siteId != null ? row.siteId === filters.siteId : true))
    .filter((row) => (filters.guardId != null ? row.guardId === filters.guardId : true))
    .filter((row) => (filters.shiftId != null ? row.shiftId === filters.shiftId : true))
    .filter((row) => (search
      ? `${row.message} ${row.siteName} ${row.guardName}`.toLowerCase().includes(search)
      : true));

  // Oldest first; ties broken by id so the order is stable rather than arbitrary.
  return rows.sort((a, b) => (a.atMs - b.atMs) || (a.id - b.id));
}

// ─── required periods ─────────────────────────────────────────────────────────

export type PeriodStatus = 'completed' | 'due' | 'missing' | 'not_applicable';

export type LogBookPeriod = {
  index: number;
  start: string;
  end: string;
  status: PeriodStatus;
  /** When the satisfying entry was recorded, if one was. */
  completedAt: string | null;
};

/**
 * The required periods for one shift, read from the backend's published windows.
 *
 * NOTHING IS COMPUTED HERE. The engine's `state` is translated into the register's vocabulary and
 * that is all: `overdue` and `missed` are both "missing" to a controller reading a past day, and a
 * window the engine marked not applicable stays not applicable.
 *
 * An "as required" site publishes no windows, so this returns an empty list — which is how a site
 * with no obligation avoids manufacturing periods it could then appear to have failed.
 */
export function logBookPeriods(
  operations: ShiftOperationsView | null | undefined,
): LogBookPeriod[] {
  const logBook = operations?.logBook;
  if (!logBook || !logBook.required) return [];

  return (logBook.windows ?? []).map((window: OperationalWindowView) => ({
    index: window.index,
    start: window.start,
    end: window.end,
    status: periodStatus(window),
    completedAt: window.completedAt ?? null,
  }));
}

function periodStatus(window: OperationalWindowView): PeriodStatus {
  if (window.applicable === false) return 'not_applicable';
  switch (window.state) {
    case 'completed':
      return 'completed';
    case 'due':
      return 'due';
    case 'overdue':
    case 'missed':
      return 'missing';
    default:
      // No published state: fall back to the completion count rather than guessing a verdict.
      return (window.completionCount ?? 0) > 0 ? 'completed' : 'due';
  }
}

export type LogBookCompliance = {
  /** False for an "as required" site: there is no requirement to pass or fail. */
  scheduled: boolean;
  intervalMinutes: number | null;
  required: number;
  completed: number;
  missing: number;
  /** How many Log Book entries were recorded, whether or not a period needed them. */
  entries: number;
};

/**
 * The compliance line for one shift.
 *
 * For an "as required" site this reports `scheduled: false` and counts entries only. A caller must
 * not render "0 missing" for such a site: zero of nothing is not a pass, and showing it beside a
 * scheduled site's zero would imply the two were assessed the same way.
 */
export function logBookCompliance(
  operations: ShiftOperationsView | null | undefined,
  entryCount: number,
): LogBookCompliance {
  const logBook = operations?.logBook;
  if (!logBook || !logBook.required) {
    return {
      scheduled: false,
      intervalMinutes: logBook?.intervalMinutes ?? null,
      required: 0,
      completed: 0,
      missing: 0,
      entries: entryCount,
    };
  }
  return {
    scheduled: true,
    intervalMinutes: logBook.intervalMinutes,
    required: logBook.requiredCount,
    completed: logBook.submittedCount,
    missing: logBook.missingCount,
    entries: entryCount,
  };
}
