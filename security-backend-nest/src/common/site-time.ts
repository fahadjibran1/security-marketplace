/**
 * Site-local scheduling times, server side. (Phase 1, UAT Round 1 Finding 4.)
 *
 * A scheduled shift time is an INSTANT. It is entered as a wall clock at a site, and the site's IANA
 * timezone is what turns that reading into an instant — never the clock of whoever typed it, and never the
 * clock of the process that received it.
 *
 * The client does this conversion too (security-mobile-app/src/services/siteTime.ts), because the operator
 * must see the time rejected or confirmed while the form is open. This copy exists for the paths the server
 * originates itself, such as the starter shift created with a new site, so there is exactly one meaning of
 * "11:30 at this site" across both.
 *
 * Built on Intl, which carries the IANA database. No UK-specific arithmetic: "subtract an hour" is wrong in
 * winter, wrong for every non-UK site, and wrong on the two transition days a year.
 */

export const DEFAULT_SITE_TIME_ZONE = 'Europe/London';

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsInZone(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

const pad = (value: number) => String(value).padStart(2, '0');
const wallKey = (parts: ZonedParts) =>
  `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;

/** The zone's offset from UTC in milliseconds at a given instant, east-positive. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = partsInZone(instant, timeZone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Formats a millisecond offset as an ISO suffix: 3600000 -> "+01:00", 0 -> "Z". */
export function offsetSuffix(offsetMs: number): string {
  if (offsetMs === 0) return 'Z';
  const sign = offsetMs > 0 ? '+' : '-';
  const total = Math.abs(Math.round(offsetMs / 60000));
  return `${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

export type SiteLocalResolution =
  | {
      ok: true;
      /** Offset-bearing ISO, e.g. "2026-09-29T11:30:00+01:00". */
      iso: string;
      instant: number;
      offsetMs: number;
      /** True on a fall-back night, when the requested clock time occurs twice. */
      ambiguous: boolean;
    }
  | { ok: false; reason: 'invalid' | 'nonexistent'; message: string };

/**
 * Fall-back policy, matching the client exactly (AMBIGUOUS_POLICY there).
 *
 * On the night the clocks go back a time like 01:30 happens twice. The EARLIER occurrence is always chosen:
 * deterministic, and for a security rota it means the site is covered for longer, which is the safer
 * direction. Choosing between the two would need an operator control and an API field — TECH-DEBT-TIME-02.
 */
export const AMBIGUOUS_POLICY = 'earliest-occurrence';

/**
 * Converts a site-local calendar date (YYYY-MM-DD) and clock time (HH:MM) into a true instant.
 *
 * A time that does not exist — the hour skipped when the clocks go forward — is REJECTED rather than
 * nudged to a neighbouring time, because silently moving a shift is worse than asking for a real one.
 */
export function siteLocalToInstant(
  date: string,
  time: string,
  timeZone: string,
): SiteLocalResolution {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim());
  const t = /^(\d{2}):(\d{2})$/.exec(String(time ?? '').trim());
  if (!d || !t) {
    return { ok: false, reason: 'invalid', message: 'Enter a valid date and a 24-hour time.' };
  }

  const year = Number(d[1]);
  const month = Number(d[2]);
  const day = Number(d[3]);
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return { ok: false, reason: 'invalid', message: 'Enter a valid date and a 24-hour time.' };
  }

  const wanted = wallKey({ year, month, day, hour, minute, second: 0 });
  // The requested wall clock read as though it were UTC. The real instant differs from this by the zone's
  // offset, which is what we are solving for.
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);

  // Probe either side of the naive value so a transition inside the window is found. On a fall-back night
  // two distinct offsets both render the requested clock time; on a spring-forward night none does.
  const candidates = new Set<number>();
  for (const probeHours of [-2, -1, 0, 1, 2]) {
    const offset = zoneOffsetMs(new Date(naive - probeHours * 3600000), timeZone);
    const candidate = naive - offset;
    if (wallKey(partsInZone(new Date(candidate), timeZone)) === wanted) {
      candidates.add(candidate);
    }
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
 * belongs to the following site-local day. The day is advanced on the CALENDAR, never by adding 24 hours to
 * an instant, because a transition night is 23 or 25 hours long.
 */
export function siteLocalEndToInstant(
  date: string,
  startTime: string,
  endTime: string,
  timeZone: string,
): SiteLocalResolution {
  let endDate = date;
  if (endTime <= startTime) {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim());
    if (!d) {
      return { ok: false, reason: 'invalid', message: 'Enter a valid date and a 24-hour time.' };
    }
    const next = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + 1));
    endDate = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
  }
  return siteLocalToInstant(endDate, endTime, timeZone);
}

/**
 * True when a string is a date-time carrying an explicit UTC offset — a trailing Z, or ±HH:MM / ±HHMM / ±HH.
 *
 * An ISO date-time WITHOUT one is not an instant: it is a wall clock reading whose meaning depends on who
 * reads it. `new Date('2026-09-29T11:30:00')` resolves it against the server's clock, which is exactly the
 * defect this phase removes, so scheduled-time fields reject it at the edge instead.
 *
 * The whole shape is matched rather than just the ending, because a bare calendar date ends in "-29" and a
 * trailing-offset check alone reads that as a two-digit negative offset.
 */
const INSTANT_SHAPE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

export function hasExplicitUtcOffset(value: string): boolean {
  return INSTANT_SHAPE.test(String(value ?? '').trim());
}
