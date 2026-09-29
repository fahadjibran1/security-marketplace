// Site-local scheduling times (Phase 1, UAT Round 1 Finding 4).
// Pure — no React / React Native imports — so the conversion can be executed in tests.
//
// THE PROBLEM THIS EXISTS TO FIX
// The Rota Planner used to send a naive wall clock, "2026-09-29T11:30:00", with no offset. The server
// parsed that with `new Date(...)`, which treats an offset-less date-time as LOCAL; on the UTC server it
// became 11:30Z and was stored as 11:30. The Company screen read it back forcing `timeZone: 'UTC'`, so
// the digits round-tripped and looked right — but the Guard app and the whole backend treat shift.start
// as a REAL INSTANT. During BST that made every comparison an hour out: a Guard booking on one minute
// early was told "1 hr 1 min early", and the welfare engine believed a live shift had not started.
//
// THE MODEL
// A Company enters a date and clock time in the SITE's timezone. That is converted here to a true
// instant carrying an explicit offset, e.g. 11:30 on 29 Sep 2026 at a Europe/London site becomes
// "2026-09-29T11:30:00+01:00" (= 10:30Z). Storage, the API, the window engine and Book On all deal in
// that one instant. Display converts back to the site's timezone, so the Company still reads 11:30.
//
// The site's IANA timezone is the authority — never the operator's device. A manager in Dubai
// scheduling a London site must produce London time.
//
// No date library is available in this project, so the conversion is built on Intl, which carries the
// full IANA database. There is no UK-specific arithmetic anywhere below: "subtract an hour" would be
// wrong in GMT, wrong for any other zone, and wrong on transition days.

export const DEFAULT_SITE_TIME_ZONE = 'Europe/London';

/** A wall-clock reading in some zone, as calendar fields. */
export type ZonedParts = {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
};

function partsInZone(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: get('hour'), minute: get('minute'), second: get('second'),
  };
}

/**
 * The zone's UTC offset in milliseconds at a given instant — positive east of UTC. Derived by asking
 * Intl what the wall clock reads there and subtracting the true instant, so DST is handled by the
 * IANA database rather than by any rule of our own.
 */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, '0');
const wallKey = (p: ZonedParts) => `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;

/** Formats a millisecond offset as an ISO suffix: 3600000 -> "+01:00", 0 -> "Z". */
export function offsetSuffix(offsetMs: number): string {
  if (offsetMs === 0) return 'Z';
  const sign = offsetMs > 0 ? '+' : '-';
  const total = Math.abs(Math.round(offsetMs / 60000));
  return `${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** True for a YYYY-MM-DD date input that names a real calendar day. */
export function isSiteDateInput(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) && !Number.isNaN(new Date(value).getTime());
}

/** True for a 24-hour HH:MM time input. */
export function isSiteTimeInput(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? ''));
}

export type SiteLocalResolution =
  | {
      ok: true;
      /** Offset-bearing ISO for the API, e.g. "2026-09-29T11:30:00+01:00". */
      iso: string;
      /** The same moment in epoch milliseconds. */
      instant: number;
      /** The zone's offset at that moment, in ms. */
      offsetMs: number;
      /**
       * True on an autumn fall-back night, when the requested clock time occurs twice. The EARLIER
       * occurrence is chosen — see AMBIGUOUS_POLICY.
       */
      ambiguous: boolean;
    }
  | { ok: false; reason: 'invalid' | 'nonexistent'; message: string };

/**
 * Fall-back policy, deliberate and documented rather than accidental.
 *
 * On the night the clocks go back, a time like 01:30 happens twice. Offering the operator a choice
 * would mean a new form control and a new API field, so for the pilot the EARLIER occurrence (still on
 * summer time) is always chosen. For a security rota that means the shift starts earlier and the site
 * is covered for longer, which is the safer failure direction. It is deterministic, so the same input
 * always produces the same instant, and `ambiguous: true` is returned so a caller can warn if it wants.
 */
export const AMBIGUOUS_POLICY = 'earliest-occurrence';

/**
 * Converts a site-local calendar date and clock time into a true instant.
 *
 * `date` is YYYY-MM-DD and `time` is HH:MM, exactly as the existing form fields hold them.
 *
 * A clock time that does not exist — the hour skipped when the clocks go forward — is REJECTED rather
 * than silently rolled to a neighbouring time, because silently moving a shift is worse than making the
 * operator pick a real time.
 */
export function siteLocalToInstant(date: string, time: string, timeZone: string): SiteLocalResolution {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim());
  const t = /^(\d{2}):(\d{2})$/.exec(String(time ?? '').trim());
  if (!d || !t) {
    return { ok: false, reason: 'invalid', message: 'Enter a valid date and a 24-hour time.' };
  }

  const year = Number(d[1]); const month = Number(d[2]); const day = Number(d[3]);
  const hour = Number(t[1]); const minute = Number(t[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return { ok: false, reason: 'invalid', message: 'Enter a valid date and a 24-hour time.' };
  }

  const requested: ZonedParts = { year, month, day, hour, minute, second: 0 };
  const wanted = wallKey(requested);
  // The requested wall clock read as though it were UTC. The real instant differs from this by the
  // zone's offset, which is what we are solving for.
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);

  // Probe the offset either side of the naive value so a transition inside the window is found. On a
  // fall-back night two distinct offsets both render the requested clock time; on a spring-forward
  // night none does.
  const candidates = new Set<number>();
  for (const probeHours of [-2, -1, 0, 1, 2]) {
    const offset = zoneOffsetMs(new Date(naive - probeHours * 3600000), timeZone);
    const candidate = naive - offset;
    if (wallKey(partsInZone(new Date(candidate), timeZone)) === wanted) candidates.add(candidate);
  }

  if (candidates.size === 0) {
    return {
      ok: false,
      reason: 'nonexistent',
      message: `${time} does not exist on ${date} at this site — the clocks go forward. Choose a different time.`,
    };
  }

  const sorted = [...candidates].sort((a, b) => a - b);
  const instant = sorted[0]; // AMBIGUOUS_POLICY: earliest occurrence
  const offsetMs = zoneOffsetMs(new Date(instant), timeZone);
  return {
    ok: true,
    instant,
    offsetMs,
    ambiguous: sorted.length > 1,
    iso: `${date}T${time}:00${offsetSuffix(offsetMs)}`,
  };
}

/**
 * End-of-shift instant. An end at or before the start means the shift runs past midnight, so the end
 * belongs to the following site-local day. The day is advanced on the CALENDAR, never by adding 24
 * hours to the instant, because a transition night is 23 or 25 hours long.
 */
export function siteLocalEndToInstant(
  date: string, startTime: string, endTime: string, timeZone: string,
): SiteLocalResolution {
  let endDate = date;
  if (endTime <= startTime) {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim());
    if (!d) return { ok: false, reason: 'invalid', message: 'Enter a valid date and a 24-hour time.' };
    const next = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + 1));
    endDate = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
  }
  return siteLocalToInstant(endDate, endTime, timeZone);
}

// ─── display ─────────────────────────────────────────────────────────────────

/** HH:MM as the site reads it. Replaces the old fake-UTC formatting. */
export function formatSiteTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return String(iso);
  const p = partsInZone(instant, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** YYYY-MM-DD as the site reads it — the value the date input holds. */
export function formatSiteDateInput(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  const p = partsInZone(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Long date as the site reads it, e.g. "Tuesday, 29 September". */
export function formatSiteDateLong(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return String(iso);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'long', day: 'numeric', month: 'long',
  }).format(instant);
}

/**
 * The zone this device is in. Only ever a FALLBACK: when a screen is showing a shift it holds the site
 * record for, pass `site.timezone`. A guard standing at the site and a controller in the same country
 * both resolve to the right clock this way, and an operator abroad at least sees a real instant rather
 * than digits lifted out of a string.
 */
export function deviceTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_SITE_TIME_ZONE;
  } catch {
    return DEFAULT_SITE_TIME_ZONE;
  }
}

/** Zone to display an instant in: the site's if known, otherwise the device's. */
export function resolveDisplayZone(timeZone?: string | null): string {
  return timeZone || deviceTimeZone();
}

/**
 * HH:MM for a true instant.
 *
 * This REPLACES the `getLiteralDateTimeParts` convention that was copied across the app, which read the
 * hour and minute straight out of the ISO string and so showed "10:30" for 10:30Z — an 11:30 BST shift.
 * The digits in an ISO-8601 instant are UTC; they are not a clock anybody reads.
 */
export function formatInstantTime(iso: string | null | undefined, timeZone?: string | null, empty = '—'): string {
  if (!iso) return empty;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return String(iso);
  return formatSiteTime(iso, resolveDisplayZone(timeZone));
}

/** e.g. "Tue, 29 Sep 2026" for a true instant. */
export function formatInstantDate(iso: string | null | undefined, timeZone?: string | null, empty = '—'): string {
  if (!iso) return empty;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return String(iso);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: resolveDisplayZone(timeZone),
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  }).format(instant);
}

/** Date and time together, for audit-style lines. */
export function formatInstantDateTime(
  iso: string | null | undefined, timeZone?: string | null, empty = '—', separator = ' · ',
): string {
  if (!iso) return empty;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return String(iso);
  return `${formatInstantDate(iso, timeZone)}${separator}${formatInstantTime(iso, timeZone)}`;
}

/** The site-local calendar day of an instant, for day bucketing and coverage boundaries. */
export function siteDateParts(instant: Date, timeZone: string) {
  const p = partsInZone(instant, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/** Midnight that begins the given site-local calendar day, as a true instant. */
export function siteMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const resolved = siteLocalToInstant(
    `${year}-${pad(month)}-${pad(day)}`, '00:00', timeZone,
  );
  // Midnight is skipped by no real transition, but if a zone ever did so the next valid minute is the
  // honest answer for a day boundary.
  if (resolved.ok) return new Date(resolved.instant);
  const naive = Date.UTC(year, month - 1, day);
  return new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
}
