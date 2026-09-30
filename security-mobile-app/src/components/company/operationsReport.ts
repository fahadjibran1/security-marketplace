// The daily operations report — structured evidence, not a screenshot of the grid. (Phase 4A.2.)
//
// WHERE THE DATA COMES FROM
// The existing company-scoped coverage dataset, which the timeline already holds. `listCoverageShifts`
// resolves the company from the caller's own token via `resolveCompanyContext(…SITES_VIEW)`, so the export
// cannot reach another company's operations — there is no new endpoint and no new authorization surface to
// get wrong. With `welfare.windows[]` published in Phase 4A it carries every column below, including one
// row per Welfare window.
//
// SCOPE IS WHAT CONTROL CHOSE
// The report is built from the SAME filtered rows the timeline renders. If a controller has narrowed to
// one site, the file contains that site — never the whole company. The filename says which scope it was.
//
// TERMINOLOGY
// Welfare Check throughout. The backend enums still say `check_call` for historical rows, and those rows
// still count as Welfare evidence, but nothing user-facing here repeats the old vocabulary.

import { formatInstantDate, formatInstantTime, formatSiteDateInput } from '../../services/siteTime';
import type { ShiftOperationsView } from '../../types/models';
import { isWelfareEvidence } from '../shifts/welfareEvidence';

export type ReportShiftInput = {
  shift: {
    id: number;
    start: string;
    end: string;
    status?: string | null;
    siteName?: string | null;
    site?: { name?: string | null; timezone?: string | null; client?: { name?: string | null } | null } | null;
    guard?: { fullName?: string | null } | null;
  };
  attendance?: { checkInAt?: string | null; checkOutAt?: string | null } | null;
  operations?: ShiftOperationsView | null;
  /** Daily logs for this shift, used for the Log Book count. */
  logs?: Array<{ logType: string }>;
  /** Incidents raised on this shift. */
  incidents?: Array<{ id: number }>;
  /** Safety alerts on this shift, used for the Site Request and Emergency counts. */
  alerts?: Array<{ type?: string | null }>;
};

export type ReportScope = {
  /** The operational date the report covers, as YYYY-MM-DD on the site clock. */
  date: string;
  /** The site name when a single site is selected, for the filename. */
  siteName?: string | null;
};

/** The summary sheet: one row per shift. */
export const SUMMARY_COLUMNS = [
  'Date', 'Client', 'Site', 'Guard',
  'Scheduled Start', 'Actual Book On', 'Scheduled End', 'Actual Book Off',
  'Shift Status', 'Welfare Interval',
  'Welfare Windows', 'Welfare Completed', 'Missed Welfare Count',
  'Log Book Entry Count', 'Incident Count', 'Site Request Count', 'Emergency Alert Count',
] as const;

/** The detail sheet, and the CSV: one row per Welfare window. */
export const WELFARE_COLUMNS = [
  'Date', 'Client', 'Site', 'Guard',
  'Scheduled Start', 'Actual Book On', 'Scheduled End', 'Actual Book Off',
  'Shift Status', 'Welfare Interval',
  'Welfare Window Start', 'Welfare Window End', 'Welfare Status', 'Welfare Completed At',
  'Missed Welfare Count',
  'Log Book Entry Count', 'Incident Count', 'Site Request Count', 'Emergency Alert Count',
] as const;

/** How the engine's window state reads in a compliance export. Never the legacy vocabulary. */
const WELFARE_STATUS_LABEL: Record<string, string> = {
  completed: 'Completed',
  due: 'Due',
  overdue: 'Overdue Welfare Check',
  missed: 'Missed Welfare Check',
  not_applicable: 'Not required',
};

export type OperationsReport = {
  scope: ReportScope;
  summary: string[][];
  welfare: string[][];
};

const zoneOf = (input: ReportShiftInput) => input.shift.site?.timezone || 'Europe/London';

function shiftFacts(input: ReportShiftInput) {
  const tz = zoneOf(input);
  const logs = input.logs ?? [];
  const alerts = input.alerts ?? [];

  return {
    tz,
    date: formatInstantDate(input.shift.start, tz),
    client: input.shift.site?.client?.name || '',
    site: input.shift.site?.name || input.shift.siteName || '',
    guard: input.shift.guard?.fullName || 'Unassigned',
    schedStart: formatInstantTime(input.shift.start, tz),
    schedEnd: formatInstantTime(input.shift.end, tz),
    bookOn: input.attendance?.checkInAt ? formatInstantTime(input.attendance.checkInAt, tz) : '',
    bookOff: input.attendance?.checkOutAt ? formatInstantTime(input.attendance.checkOutAt, tz) : '',
    status: (input.shift.status || '').trim(),
    interval: input.operations?.welfare?.intervalMinutes != null
      ? String(input.operations.welfare.intervalMinutes)
      : '',
    missed: String(input.operations?.welfare?.missedCount ?? 0),
    // Both Welfare log types count: a shift worked before the Phase 3C rename recorded check_call.
    logBook: String(logs.filter((log) => log.logType === 'log_book').length),
    incidents: String((input.incidents ?? []).length),
    siteRequests: String(alerts.filter((a) => (a.type || '').toLowerCase() === 'site_request').length),
    emergencies: String(alerts.filter((a) => (a.type || '').toLowerCase() === 'panic').length),
    welfareLogs: String(logs.filter(isWelfareEvidence).length),
  };
}

/**
 * Build both sheets from the filtered operational rows.
 *
 * A shift with several Welfare windows produces several detail rows and exactly one summary row. A shift
 * with no Welfare obligation still produces a summary row and one detail row stating that nothing was
 * required — an absent row would read as missing evidence rather than as no obligation.
 */
export function buildOperationsReport(
  inputs: readonly ReportShiftInput[],
  scope: ReportScope,
): OperationsReport {
  const summary: string[][] = [];
  const welfare: string[][] = [];

  for (const input of inputs) {
    const f = shiftFacts(input);
    const windows = input.operations?.welfare?.windows ?? [];

    summary.push([
      f.date, f.client, f.site, f.guard,
      f.schedStart, f.bookOn, f.schedEnd, f.bookOff,
      f.status, f.interval,
      String(windows.length), f.welfareLogs, f.missed,
      f.logBook, f.incidents, f.siteRequests, f.emergencies,
    ]);

    const common = [
      f.date, f.client, f.site, f.guard,
      f.schedStart, f.bookOn, f.schedEnd, f.bookOff,
      f.status, f.interval,
    ];
    const tail = [f.missed, f.logBook, f.incidents, f.siteRequests, f.emergencies];

    if (windows.length === 0) {
      welfare.push([...common, '', '', 'Not required', '', ...tail]);
      continue;
    }

    for (const w of windows) {
      welfare.push([
        ...common,
        formatInstantTime(w.start, f.tz),
        formatInstantTime(w.end, f.tz),
        WELFARE_STATUS_LABEL[String(w.state)] ?? 'Not required',
        w.completedAt ? formatInstantTime(w.completedAt, f.tz) : '',
        ...tail,
      ]);
    }
  }

  return { scope, summary, welfare };
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

/**
 * One cell, escaped for CSV.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a single quote. Excel would otherwise treat the cell as
 * a formula, which is how a spreadsheet export becomes an injection vector — and these cells carry guard
 * and site names supplied by users.
 */
export function csvCell(value: string): string {
  const raw = value ?? '';
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** The CSV: one detailed Welfare-window row per record, with a BOM so Excel reads UTF-8. */
export function toCsv(report: OperationsReport): string {
  const lines = [
    WELFARE_COLUMNS.map(csvCell).join(','),
    ...report.welfare.map((row) => row.map(csvCell).join(',')),
  ];
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ─── filename ─────────────────────────────────────────────────────────────────

/**
 * `S4-Operations-2026-09-30.xlsx`, or `S4-Operations-Test-Site-2026-09-30.xlsx` for a single site.
 *
 * Every component is sanitised: anything outside letters, digits and hyphens becomes a hyphen, runs
 * collapse, and the length is capped. A site name reaches this from user input, and a filename is written
 * to the operator's disk.
 */
export function sanitiseFilenamePart(value: string): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function operationsReportFilename(scope: ReportScope, extension: 'csv' | 'xlsx'): string {
  const site = scope.siteName ? sanitiseFilenamePart(scope.siteName) : '';
  const date = sanitiseFilenamePart(scope.date);
  return ['S4-Operations', site, date].filter(Boolean).join('-') + `.${extension}`;
}

/** The operational date a report covers, on the site's clock rather than the device's. */
export function reportDateFor(anchorIso: string, timeZone: string): string {
  return formatSiteDateInput(anchorIso, timeZone);
}
