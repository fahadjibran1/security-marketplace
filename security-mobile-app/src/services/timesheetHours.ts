/**
 * Timesheet hours as hours and minutes (owner-approved, 28 Oct 2026). Pure: no I/O, no clock.
 *
 * Live pilot finding: a Guard claimed 9.50 (nine and a half hours) and the company read it as 9 h 50 min. Hours are
 * still STORED as the existing decimal `hoursWorked` / `approvedHours` (and minutes in workedMinutes / approvedMinutes),
 * but are SHOWN as "9h 30m", with the decimal beside it where it helps ("9h 30m (9.50 h)"), and the Guard ENTERS hours
 * and minutes separately. The one formatter for the company web and the Guard app.
 *
 * Minutes from decimal hours are Math.round(hours * 60): the same rule the backend uses for workedMinutes, so the
 * minutes shown always equal the minutes stored. Any whole number of minutes survives the 2-decimal hoursWorked column
 * (the rounding error is at most 0.3 min).
 */

/** Largest claim a Guard can enter: 24 hours. */
export const MAX_CLAIM_MINUTES = 24 * 60;

/** Decimal hours to whole minutes (the backend's workedMinutes rule), or null. */
export function hoursToMinutes(hours: number | string | null | undefined): number | null {
  if (hours === null || hours === undefined || hours === '') return null;
  const n = Number(hours);
  return Number.isFinite(n) ? Math.round(n * 60) : null;
}

/** Whole minutes to the stored decimal hours (2 places, as the hoursWorked / approvedHours columns hold them). */
export function minutesToDecimalHours(minutes: number): number {
  return Number((minutes / 60).toFixed(2));
}

/** "9h 30m", "9h", "45m", "0m"; "—" when unknown. The sign is dropped (callers say "more" / "less" in words). */
export function formatMinutesHM(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) return '—';
  const total = Math.round(Math.abs(Number(minutes)));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "9h 30m (9.50 h)": hours and minutes first, the decimal second. */
export function formatMinutesWithDecimal(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) return '—';
  return `${formatMinutesHM(minutes)} (${(Math.round(Math.abs(Number(minutes))) / 60).toFixed(2)} h)`;
}

/** Decimal hours shown as hours and minutes: "9h 30m", or "9h 30m (9.50 h)" with `withDecimal`. */
export function formatHoursHM(hours: number | string | null | undefined, options: { withDecimal?: boolean } = {}): string {
  const minutes = hoursToMinutes(hours);
  if (minutes === null) return '—';
  return options.withDecimal ? formatMinutesWithDecimal(minutes) : formatMinutesHM(minutes);
}

/** Whole minutes split for the two inputs. */
export function splitMinutes(minutes: number | null | undefined): { hours: string; minutes: string } {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes)) || Number(minutes) <= 0) return { hours: '', minutes: '' };
  const total = Math.round(Number(minutes));
  return { hours: String(Math.floor(total / 60)), minutes: String(total % 60) };
}

export type HoursMinutesParse =
  | { ok: true; minutes: number; label: string }
  | { ok: false; error: string };

const WHOLE = /^\d{1,3}$/;

/**
 * The Hours and Minutes inputs as whole minutes. Hours: a whole number 0–24. Minutes: a whole number 0–59 (empty is
 * 0). The total must be more than 0 and at most 24 hours. A decimal point is refused with a hint, so "9.5" or "9.50"
 * can never be read two ways.
 */
export function parseHoursMinutes(hoursText: string, minutesText: string): HoursMinutesParse {
  const hRaw = (hoursText ?? '').trim();
  const mRaw = (minutesText ?? '').trim();
  if (!hRaw && !mRaw) return { ok: false, error: 'Enter the hours and minutes you worked.' };
  if (/[.,:]/.test(hRaw) || /[.,:]/.test(mRaw)) {
    return { ok: false, error: 'Use whole numbers: put the hours in Hours and the minutes in Minutes (for 9½ hours enter 9 and 30).' };
  }
  if ((hRaw && !WHOLE.test(hRaw)) || (mRaw && !WHOLE.test(mRaw))) return { ok: false, error: 'Hours and minutes must be whole numbers.' };
  const h = hRaw ? Number(hRaw) : 0;
  const m = mRaw ? Number(mRaw) : 0;
  if (m > 59) return { ok: false, error: 'Minutes must be between 0 and 59.' };
  if (h > 24) return { ok: false, error: 'Hours must be 24 or fewer.' };
  const total = h * 60 + m;
  if (total <= 0) return { ok: false, error: 'The time worked must be more than 0.' };
  if (total > MAX_CLAIM_MINUTES) return { ok: false, error: 'The time worked must be 24 hours or less.' };
  return { ok: true, minutes: total, label: formatMinutesWithDecimal(total) };
}
