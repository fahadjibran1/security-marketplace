// Shift Attendance and Welfare Monitoring reports: periods, files and names. (S4 Welfare Phase 3.)
//
// The backend builds each report from the database — GET /reports/shift-attendance and
// /reports/welfare-monitoring — and returns a sheet: column headings, string rows and a summary. This module
// only chooses the period the controller asked for and writes that sheet to CSV or XLSX, unchanged: nothing
// here computes a status, a time or a count, so the file says exactly what the API said.
//
// The existing Live Operations export (the board's own rows) is untouched; these are separate reports.
//
// Pure: no request, no clock of its own, no write.

import type { OperationsReportSheet } from '../../types/models';
import { csvCell, sanitiseFilenamePart } from './operationsReport';
import { buildXlsx } from './xlsxWriter';

export type ReportKind = 'shift-attendance' | 'welfare-monitoring';
export type ReportPeriod = 'day' | 'week' | 'month' | 'custom';

/** The longest custom range the backend accepts. */
export const REPORT_MAX_DAYS = 31;

export const REPORT_TITLE: Record<ReportKind, string> = {
  'shift-attendance': 'Shift Attendance',
  'welfare-monitoring': 'Welfare Monitoring',
};

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (value: string) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
const isIsoDate = (value: string | null | undefined): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && iso(dayMs(value)) === value;

export type ReportRange = { from: string; to: string; days: number } | { error: string };

/**
 * The calendar days a report covers, as YYYY-MM-DD (the API's machine format):
 *   day     the chosen day
 *   week    Monday to Sunday of the week containing it
 *   month   the whole calendar month containing it
 *   custom  the chosen day to `customTo`, inclusive, at most 31 days
 */
export function reportRange(period: ReportPeriod, date: string, customTo?: string): ReportRange {
  if (!isIsoDate(date)) return { error: 'Choose a valid date (DD-MM-YYYY).' };
  const start = dayMs(date);
  let from = start;
  let to = start;
  if (period === 'week') {
    const weekday = (new Date(start).getUTCDay() + 6) % 7; // Monday = 0
    from = start - weekday * 86_400_000;
    to = from + 6 * 86_400_000;
  } else if (period === 'month') {
    const d = new Date(start);
    from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
  } else if (period === 'custom') {
    if (!isIsoDate(customTo)) return { error: 'Choose a valid end date (DD-MM-YYYY).' };
    to = dayMs(customTo);
    if (to < from) return { error: 'The end date must not be before the start date.' };
  }
  const days = Math.round((to - from) / 86_400_000) + 1;
  if (days > REPORT_MAX_DAYS) return { error: `A report covers at most ${REPORT_MAX_DAYS} days.` };
  return { from: iso(from), to: iso(to), days };
}

/** "DD-MM-YYYY" for a YYYY-MM-DD day, for anything a person reads. */
export function ukDay(value: string): string {
  return isIsoDate(value) ? `${value.slice(8, 10)}-${value.slice(5, 7)}-${value.slice(0, 4)}` : value;
}

/** The header block both files start with: what the report is, for whom, when, and how to read the times. */
function headerRows(sheet: OperationsReportSheet): string[][] {
  return [
    [sheet.title],
    ['Company', sheet.company],
    ['Period', `${sheet.period.from} to ${sheet.period.to}`],
    ['Site', sheet.site ?? 'All sites'],
    ['Generated (UTC)', sheet.generatedAtUtc],
    ['Times', sheet.timezoneNote],
  ];
}

/**
 * CSV: the detail rows under their headings, BOM-prefixed for Excel, every cell through the same
 * formula-injection guard as the existing export — a value beginning = + - @ is written as text.
 */
export function reportToCsv(sheet: OperationsReportSheet): string {
  const lines = [sheet.columns, ...sheet.rows].map((row) => row.map((cell) => csvCell(cell ?? '')).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * XLSX: a Summary sheet (the header block and the server's summary table) and the detail sheet. Every cell
 * is an inline string — never a formula, never a number Excel might reformat.
 */
export function reportToXlsx(sheet: OperationsReportSheet): Uint8Array {
  const detailName = sheet.report === 'shift-attendance' ? 'Shifts' : 'Welfare windows';
  return buildXlsx([
    { name: 'Summary', rows: [...headerRows(sheet), [], ...sheet.summary.slice(6)] },
    { name: detailName, rows: [sheet.columns, ...sheet.rows] },
  ]);
}

/**
 * "S4-Welfare-Monitoring-12-10-2026-to-18-10-2026-North-Gate.xlsx". Dates and the site only: no company name,
 * no person and no identifier, so a forwarded file name says nothing it should not.
 */
export function reportFilename(kind: ReportKind, from: string, to: string, siteName: string | null, extension: 'csv' | 'xlsx'): string {
  const site = siteName ? `-${sanitiseFilenamePart(siteName)}` : '';
  const span = from === to ? ukDay(from) : `${ukDay(from)}-to-${ukDay(to)}`;
  return `S4-${REPORT_TITLE[kind].replace(/ /g, '-')}-${span}${site}.${extension}`;
}
