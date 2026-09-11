/**
 * Computes the ISO Monday weekCommencing for a UTC shift-start date in
 * a given IANA timezone, returned as 'YYYY-MM-DD'.
 *
 * The business week is determined by the local calendar date of shift.start
 * in the site's timezone, not by UTC date. This prevents DST/BST from
 * moving late-night shifts into the wrong business week.
 */
export function computeWeekCommencing(shiftStart: Date, siteTimezone: string): string {
  const tz = siteTimezone || 'Europe/London';

  // Extract local year/month/day using Intl
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(shiftStart);

  const y = parseInt(parts.find((p) => p.type === 'year')!.value, 10);
  const m = parseInt(parts.find((p) => p.type === 'month')!.value, 10) - 1; // 0-indexed
  const d = parseInt(parts.find((p) => p.type === 'day')!.value, 10);

  // Create a plain local date (treat as midnight UTC to do arithmetic)
  const localDate = new Date(Date.UTC(y, m, d));

  // ISO weekday: Monday=1 ... Sunday=7
  const dow = localDate.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
  const isoDay = dow === 0 ? 7 : dow;
  const mondayOffset = isoDay - 1; // days to subtract to reach Monday

  const monday = new Date(localDate.getTime() - mondayOffset * 86_400_000);
  return toDateString(monday);
}

export function computeWeekEnding(weekCommencing: string): string {
  const d = new Date(weekCommencing + 'T00:00:00Z');
  const sunday = new Date(d.getTime() + 6 * 86_400_000);
  return toDateString(sunday);
}

function toDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
