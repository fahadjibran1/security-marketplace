// UK calendar dates: the ONE place S4 parses, validates and formats a date-only value for people.
// Pure — no React / React Native imports — so the exact rules the form applies are unit-testable.
//
// Two user-facing spellings, one strict core:
//   DD/MM/YYYY   Company Compliance evidence (UAT-COMP-01) — parseUkDate / ukDateToIso / isoToUkDate
//   DD-MM-YYYY   operational dates: Live Operations, Rota Planner, Log Book (S4 Live Operations Phase 3)
//                — parseUkOperationalDate / ukOperationalDateToIso / isoToUkOperationalDate
// Both go through the same day/month/year rules below, so they cannot disagree about what a real date
// is. services/siteTime.ts uses this module for its date-only validation and its DD-MM-YYYY display;
// there is no second calendar.
// (Moved from components/company/ukDate.ts, which re-exports it unchanged.)
//
// S4 is a UK-facing security platform. A compliance manager enters an expiry as 01/01/2028 and must
// never be asked to know or type 2028-01-01. The API and database contract stays ISO YYYY-MM-DD, so
// this module is the single conversion boundary between the two.
//
// WHY NOT `new Date(...)`
// JavaScript's Date is permissive in exactly the ways that matter here. `new Date(2028, 3, 31)` rolls
// 31 April silently into 1 May, and parsing a date-only string can shift the calendar day by one
// depending on the runtime timezone. Both would corrupt a compliance expiry. Everything below is
// integer and string arithmetic over the three fields the user typed, so a date-only value stays the
// exact calendar date the user meant, in every timezone, and an impossible date is rejected rather
// than rolled over.

export const UK_DATE_PLACEHOLDER = 'DD/MM/YYYY';
/** One user-facing message. Deliberately never mentions the internal ISO format. */
export const UK_DATE_ERROR = 'Enter a valid date in DD/MM/YYYY format.';

/** Plausible-year guard, so an obvious typo like 0028 or 20288 is a validation error, not a stored date. */
const MIN_YEAR = 1900;
const MAX_YEAR = 2999;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Proleptic Gregorian rule: divisible by 4, except centuries, except those divisible by 400. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** `month` is 1-12. */
export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1];
}

export type UkDateParts = { day: number; month: number; year: number };

const pad2 = (value: number) => String(value).padStart(2, '0');

/**
 * Parses DD/MM/YYYY. Single-digit day and month are accepted and normalised (1/1/2028 is the same
 * date as 01/01/2028 and rejecting it would only punish typing), but the year must be four digits so
 * "28" is never guessed at. Returns null for anything that is not a real calendar date.
 */
export function parseUkDate(value: string | null | undefined): UkDateParts | null {
  const text = String(value ?? '').trim();
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!match) return null;

  return validParts(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** True when the text is a real UK calendar date. */
export function isUkDate(value: string | null | undefined): boolean {
  return parseUkDate(value) !== null;
}

/** 1/1/2028 -> 01/01/2028. Null when the value is not a real date. */
export function normaliseUkDate(value: string | null | undefined): string | null {
  const parts = parseUkDate(value);
  return parts ? `${pad2(parts.day)}/${pad2(parts.month)}/${parts.year}` : null;
}

/**
 * DD/MM/YYYY -> YYYY-MM-DD, the format the API expects. Built from the parsed integers, so no
 * timezone is ever involved and the calendar date cannot move.
 */
export function ukDateToIso(value: string | null | undefined): string | null {
  const parts = parseUkDate(value);
  return parts ? `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` : null;
}

/**
 * YYYY-MM-DD -> DD/MM/YYYY. Accepts a full ISO timestamp too and uses only its date portion, again
 * without constructing a Date, so a late-evening UTC timestamp cannot display as the previous day.
 */
export function isoToUkDate(value: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
  if (!match) return null;

  const parts = validParts(Number(match[3]), Number(match[2]), Number(match[1]));
  return parts ? `${pad2(parts.day)}/${pad2(parts.month)}/${parts.year}` : null;
}

/**
 * Display helper for a compliance expiry. An absent value reads as an em dash; a value this module
 * cannot interpret is shown unchanged rather than silently replaced, so bad stored data stays visible.
 */
export function formatUkDate(value: string | null | undefined): string {
  const text = String(value ?? '').trim();
  if (!text) return '—';
  return isoToUkDate(text) ?? text;
}

// ─── operational dates: DD-MM-YYYY (S4 Live Operations Phase 3) ─────────────

export const UK_OPERATIONAL_DATE_PLACEHOLDER = 'DD-MM-YYYY';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Parses DD-MM-YYYY as a person types it. A slash is accepted in place of the dash (both separators the
 * same), single-digit day and month are normalised, and the year must be four digits. Exactly the same
 * calendar rules as parseUkDate: 31-02-2026 and 29-02-2025 are refused, 29-02-2028 is accepted.
 */
export function parseUkOperationalDate(value: string | null | undefined): UkDateParts | null {
  const text = String(value ?? '').trim();
  const match = /^(\d{1,2})([-/])(\d{1,2})\2(\d{4})$/.exec(text);
  if (!match) return null;
  return validParts(Number(match[1]), Number(match[3]), Number(match[4]));
}

/** DD-MM-YYYY (or DD/MM/YYYY) -> YYYY-MM-DD for the API and every filter key. Null if not a real date. */
export function ukOperationalDateToIso(value: string | null | undefined): string | null {
  const parts = parseUkOperationalDate(value);
  return parts ? `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` : null;
}

/** True only for a YYYY-MM-DD that names a real calendar day: 2026-02-31 is false, 2028-02-29 is true. */
export function isIsoCalendarDate(value: string | null | undefined): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  return Boolean(match && validParts(Number(match[3]), Number(match[2]), Number(match[1])));
}

/** YYYY-MM-DD -> DD-MM-YYYY. Null when it is not a real calendar date. */
export function isoToUkOperationalDate(value: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const parts = validParts(Number(match[3]), Number(match[2]), Number(match[1]));
  return parts ? `${pad2(parts.day)}-${pad2(parts.month)}-${parts.year}` : null;
}

/**
 * Why a typed operational date was refused, in words a controller can act on — or null when it is fine.
 * An empty value is not an error here; whether a date is required is the form's decision.
 */
export function ukOperationalDateError(value: string | null | undefined): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = /^(\d{1,2})([-/])(\d{1,2})\2(\d{4})$/.exec(text);
  if (!match) return 'Enter the date as DD-MM-YYYY, for example 30-09-2026.';
  const day = Number(match[1]);
  const month = Number(match[3]);
  const year = Number(match[4]);
  if (year < MIN_YEAR || year > MAX_YEAR) return `${year} is not a year S4 can schedule.`;
  if (month < 1 || month > 12) return 'The month must be between 01 and 12.';
  const limit = daysInMonth(year, month);
  if (day < 1 || day > limit) {
    return `${pad2(day)}-${pad2(month)}-${year} is not a real date: ${MONTH_NAMES[month - 1]} ${year} has ${limit} days.`;
  }
  return null;
}

const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The weekday of a YYYY-MM-DD calendar date, by integer arithmetic (Sakamoto's method) — so it is the same
 * answer on every device in every timezone. Null when the date is not real.
 */
export function isoWeekday(value: string | null | undefined, style: 'long' | 'short' = 'long'): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const parts = validParts(Number(match[3]), Number(match[2]), Number(match[1]));
  if (!parts) return null;
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const y = parts.month < 3 ? parts.year - 1 : parts.year;
  const index = (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + offsets[parts.month - 1] + parts.day) % 7;
  const name = WEEKDAYS_LONG[index];
  return style === 'long' ? name : name.slice(0, 3);
}

/** "Tuesday 29-09-2026" (or "Tue 29-09-2026") for a YYYY-MM-DD; the input unchanged if it is not real. */
export function formatUkOperationalDay(value: string | null | undefined, style: 'long' | 'short' = 'long'): string {
  const weekday = isoWeekday(value, style);
  const date = isoToUkOperationalDate(value);
  return weekday && date ? `${weekday} ${date}` : String(value ?? '');
}

/** The shared day/month/year rule. */
function validParts(day: number, month: number, year: number): UkDateParts | null {
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { day, month, year };
}
