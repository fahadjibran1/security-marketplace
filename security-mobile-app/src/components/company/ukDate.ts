// UK calendar dates for the Company Compliance evidence journey (UAT-COMP-01).
// Pure — no React / React Native imports — so the exact rules the form applies are unit-testable.
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

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  return { day, month, year };
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

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  return `${pad2(day)}/${pad2(month)}/${year}`;
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
