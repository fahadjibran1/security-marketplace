// How a shift offer's schedule is written down, for the Guard and for the Company. (Phase 3B.)
//
// WHY THIS IS SHARED AND PURE
// GuardShiftOffersWorkspace and CompanyShiftOffersWorkspace each had their own copy of these helpers, and
// each copy had the same defect in a slightly different form: both read the clock digits straight out of
// the stored string. A regex pulled `hour` and `minute` and printed them; a date was taken with
// `slice(0, 10)`; `getDay`/`setDate` worked in the DEVICE's zone and `toISOString` then took the UTC date.
//
// That was correct while the backend stored a local wall clock. Phase 1 corrected those columns to true
// instants, so the digits are now UTC: a 00:30 BST shift stored as 23:30Z was offered as "23:30" on the
// previous day, and its overnight marker and its Rota week were wrong with it. Two copies meant fixing it
// twice and testing it nowhere, so there is now one copy, it takes the zone as an argument, and — because
// it imports nothing from react-native — a test can execute it.
//
// The zone is always the SITE's. It is the site the Guard has to turn up at and the site the Company is
// planning cover for; neither of them cares what time it is on the device.

import {
  DEFAULT_SITE_TIME_ZONE,
  formatInstantDate,
  formatInstantTime,
  formatSiteDateInput,
  siteDateParts,
} from '../../services/siteTime';

/** Just enough of a shift to find its clock. */
export type ZonedShift = { site?: { timezone?: string | null } | null };

/** The site's zone, falling back to the platform default when a site has none set. */
export function shiftZone(shift: ZonedShift | null | undefined): string {
  return shift?.site?.timezone || DEFAULT_SITE_TIME_ZONE;
}

export function formatOfferDate(
  iso: string | null | undefined,
  timeZone: string,
  empty = '—',
): string {
  return formatInstantDate(iso, timeZone, empty);
}

export function formatOfferTime(
  iso: string | null | undefined,
  timeZone: string,
  empty = '—',
): string {
  return formatInstantTime(iso, timeZone, empty);
}

/**
 * Whether the shift ends on a later SITE-local day than it starts.
 *
 * Comparing the stored digits put this boundary at UTC midnight, which is an hour early through British
 * Summer Time and a whole day out for a site in another zone.
 */
export function isOvernightOffer(
  start: string | null | undefined,
  end: string | null | undefined,
  timeZone: string,
): boolean {
  if (!start || !end) return false;
  const from = formatSiteDateInput(start, timeZone);
  const to = formatSiteDateInput(end, timeZone);
  if (!from || !to) return false;
  return to > from;
}

/** The shift's hours as the site reads them, with the overnight marker the control room expects. */
export function formatOfferWindow(
  start: string | null | undefined,
  end: string | null | undefined,
  timeZone: string,
  options: { separator?: string; empty?: string } = {},
): string {
  const separator = options.separator ?? '–';
  const empty = options.empty ?? '—';
  const from = formatOfferTime(start, timeZone, empty);
  const to = formatOfferTime(end, timeZone, empty);
  const suffix = isOvernightOffer(start, end, timeZone) ? ' (+1)' : '';
  return `${from}${separator}${to}${suffix}`;
}

/**
 * The Monday of the week this instant falls in, as the SITE sees it, as a YYYY-MM-DD input value.
 *
 * It chooses the Rota Planner week to open, so it has to agree with the week the planner would put the
 * shift in. The arithmetic is done on a UTC-noon carrier for the site-local calendar date, which keeps
 * any zone from shifting the date itself while the weekday is being resolved.
 */
export function weekCommencingForOffer(
  iso: string | null | undefined,
  timeZone: string,
): string {
  const instant = iso ? new Date(iso) : new Date();
  if (Number.isNaN(instant.getTime())) return '';

  const parts = siteDateParts(instant, timeZone);
  const carrier = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
  const weekday = carrier.getUTCDay();
  carrier.setUTCDate(carrier.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));

  const year = carrier.getUTCFullYear();
  const month = String(carrier.getUTCMonth() + 1).padStart(2, '0');
  const day = String(carrier.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
