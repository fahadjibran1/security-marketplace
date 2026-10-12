import { DEFAULT_SITE_TIME_ZONE } from '../common/site-time';

/**
 * Compliance expiry dates are calendar dates, not instants. A licence or permission that expires on
 * 31 March is valid for the whole of 31 March in the UK, so "today" must be the UK calendar date,
 * never the server's (UTC) date. Between midnight and 01:00 BST the two differ by a day.
 *
 * Companies have no time zone of their own; every S4 company operates in Great Britain, so the
 * company-local calendar is DEFAULT_SITE_TIME_ZONE.
 */
export const COMPLIANCE_TIME_ZONE = DEFAULT_SITE_TIME_ZONE;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today's calendar date in the company's zone, as YYYY-MM-DD. */
export function complianceToday(now: Date = new Date(), timeZone: string = COMPLIANCE_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Normalises a stored or submitted date to YYYY-MM-DD, or null when it is not a real calendar date.
 * A Date (TypeORM can return one for legacy columns) is read in the compliance zone.
 */
export function toCalendarDate(value: string | Date | null | undefined): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : complianceToday(value);
  }
  const text = String(value).trim();
  const match = DATE_ONLY.exec(text.slice(0, 10));
  if (!match) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : complianceToday(parsed);
  }
  const [, y, m, d] = match;
  const utc = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (utc.getUTCFullYear() !== Number(y) || utc.getUTCMonth() !== Number(m) - 1 || utc.getUTCDate() !== Number(d)) {
    return null;
  }
  return `${y}-${m}-${d}`;
}

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD). Negative when `to` is earlier. */
export function calendarDaysBetween(from: string, to: string): number {
  const asUtc = (value: string) => {
    const [y, m, d] = value.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((asUtc(to) - asUtc(from)) / 86400000);
}

/** Days until a calendar expiry date, measured from today in the compliance zone. Null if invalid. */
export function daysUntilCalendarDate(value: string | Date | null | undefined, now: Date = new Date()): number | null {
  const date = toCalendarDate(value);
  if (!date) return null;
  return calendarDaysBetween(complianceToday(now), date);
}

/** Adds whole calendar months, clamping to the last day of the target month (31 Aug + 6 = 28/29 Feb). */
export function addCalendarMonths(value: string, months: number): string {
  const [y, m, d] = value.split('-').map(Number);
  const targetMonthIndex = m - 1 + months;
  const year = y + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
